import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { BimIndicesData, BimLetterInfo } from "../../src/domain/estimate/bimIndicesTypes";
import {
  fileContentUrl,
  isByObjectsNode,
  normLegalDocUrl,
  parseDocNodes,
  quarterOfNodeName,
  yearOfNodeName,
  type DocNode,
} from "../../src/lib/fsnb/fgisBimApi";
import { bimIndicesFileName, buildBimIndices, stringifyBimIndices, type LetterInput } from "./build-bim-indices";
import { createDownloader, type Downloader } from "./fetch-zone";
import { pacedDownloader } from "./zone-update";

/**
 * Квартальное обновление индексов БИМ: письма Минстроя «О рекомендуемой величине индексов изменения сметной
 * стоимости…» из дерева ФГИС ЦС → текст (pdftotext) → разбор → `data/fsnb/index/bim-indices/bim-indices-<год>q<кв>.json`.
 *
 * Запускается на сервере в России (ФГИС ЦС отвечает только российским адресам) и подключён к ночному
 * обновлению зон (`deploy/tenderfit-zones.service`, ExecStartPre): ночью он дешёвый — обходит дерево, сверяет
 * список писем квартала с уже собранным файлом и скачивает файлы, только если появилось новое письмо.
 *
 * Дерево (`GET /api/NormLegalDocPublished?normLegalDocPublishedType=10&state=20&normLegalDocBaseKind=40&parentGuid=…`):
 * годы → кварталы → «по объектам строительства» → письма с `filePath`; файл письма —
 * `GET /api/values/GetFileContent/<filePath>`. Форма ответа сервера на момент написания кода не проверялась
 * (сеть до ФГИС ЦС с машины разработчика не доходит), поэтому обход терпим к именам полей, а `--dump-tree` печатает
 * то, что вернул сервер, чтобы на месте поправить фильтры.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/fetch-bim-indices.ts                      — последний квартал с письмами
 *   npx tsx scripts/fsnb/fetch-bim-indices.ts --year 2026 --quarter 3 [--force]
 *   npx tsx scripts/fsnb/fetch-bim-indices.ts --dump-tree [--depth 3]   — только показать дерево
 *   флаги: --guid <корень> (начать с узла), --index <каталог индекса>, --pause <мс>, --dry-run
 *
 * Нужен `pdftotext` (poppler-utils). Нет его или письмо не разобралось — файл квартала НЕ перезаписывается:
 * лучше вчерашние индексы, чем половина сегодняшних.
 */

const ROOT = resolve(__dirname, "../..");
const DEFAULT_INDEX =
  process.env.FSNB_INDEX_DIR !== undefined && process.env.FSNB_INDEX_DIR.trim() !== ""
    ? resolve(process.env.FSNB_INDEX_DIR)
    : resolve(ROOT, "data/fsnb/index");

export const BIM_INDICES_DIR = "bim-indices";
/** Новый файл должен содержать не меньше этой доли записей прежнего: резкое падение — признак сломанного разбора. */
const MIN_KEEP_SHARE = 0.7;
const MAX_DEPTH = 6;

const execFileAsync = promisify(execFile);

export interface TreeLetter {
  readonly node: DocNode;
  /** Имена папок от корня: «2026» → «III квартал» → «по объектам строительства». */
  readonly path: readonly string[];
  readonly year: number | null;
  readonly quarter: number | null;
}

export interface WalkOptions {
  readonly download: Downloader;
  readonly log: (message: string) => void;
  readonly startGuid: string | null;
  /** Нужный квартал; null — взять последний, в котором есть письма. */
  readonly year: number | null;
  readonly quarter: number | null;
  /** Только напечатать дерево до этой глубины. */
  readonly dumpDepth: number | null;
}

async function children(options: WalkOptions, guid: string | null): Promise<DocNode[]> {
  const bytes = await options.download(normLegalDocUrl(guid), "json", `Дерево документов ФГИС ЦС${guid === null ? "" : ` (${guid})`}`);
  return parseDocNodes(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
}

/**
 * Письма квартала. Обход в глубину с отсечением: годы и кварталы по имени узла, внутри квартала — папки «по объектам
 * строительства» (нет такой папки — обходится весь квартал, и это пишется в журнал).
 */
export async function collectLetters(options: WalkOptions): Promise<TreeLetter[]> {
  const found: TreeLetter[] = [];
  const dump = options.dumpDepth !== null;

  const visit = async (guid: string | null, path: readonly string[], year: number | null, quarter: number | null, depth: number): Promise<void> => {
    const nodes = await children(options, guid);
    if (dump) {
      for (const node of nodes) options.log(`${"  ".repeat(depth)}${node.filePath === null ? "[папка]" : "[файл]"} ${node.name} [${node.guid}]${node.filePath === null ? "" : ` → ${node.filePath}`}`);
    }
    const folders = nodes.filter((node) => node.filePath === null);
    for (const node of nodes) {
      if (node.filePath !== null) found.push({ node, path, year, quarter });
    }
    if (depth >= MAX_DEPTH || (dump && depth + 1 >= (options.dumpDepth ?? 0))) return;

    let next = folders;
    // Фильтры по году и кварталу применяются, только когда папка называет год или квартал.
    next = next.filter((folder) => {
      const folderYear = yearOfNodeName(folder.name);
      const folderQuarter = quarterOfNodeName(folder.name);
      if (options.year !== null && folderYear !== null && folderYear !== options.year) return false;
      if (options.quarter !== null && folderQuarter !== null && folderQuarter !== options.quarter) return false;
      return true;
    });
    // Внутри квартала — только «по объектам строительства», если такая папка есть.
    if (quarter !== null) {
      const byObjects = next.filter((folder) => isByObjectsNode(folder.name));
      if (byObjects.length > 0) next = byObjects;
      else if (next.length > 0 && !dump) options.log(`  папки «по объектам строительства» не нашлось в «${path.join(" / ")}»: обхожу все папки квартала`);
    }
    for (const folder of next) {
      const folderYear = yearOfNodeName(folder.name) ?? year;
      const folderQuarter = quarterOfNodeName(folder.name) ?? quarter;
      await visit(folder.guid, [...path, folder.name], folderYear, folderQuarter, depth + 1);
    }
  };

  await visit(options.startGuid, [], null, null, 0);
  return found;
}

/** Последний квартал среди писем: по (год, квартал) пути; письма без квартала в пути не выбираются. */
export function latestQuarter(letters: readonly TreeLetter[]): { year: number; quarter: number } | null {
  let best: { year: number; quarter: number } | null = null;
  for (const letter of letters) {
    if (letter.year === null || letter.quarter === null) continue;
    if (best === null || letter.year > best.year || (letter.year === best.year && letter.quarter > best.quarter)) {
      best = { year: letter.year, quarter: letter.quarter };
    }
  }
  return best;
}

/** Реквизиты письма из имени узла: «… от 23.07.2026 № 45358-ИФ/09». */
export function requisitesOfName(name: string): { date: string | null; number: string | null } {
  const date = /(\d{2})\.(\d{2})\.(\d{4})/.exec(name);
  const number = /№\s*([0-9]+(?:-[А-ЯA-Zа-яa-z]+)?\/\d{2})/u.exec(name);
  return {
    date: date?.[1] !== undefined && date[2] !== undefined && date[3] !== undefined ? `${date[3]}-${date[2]}-${date[1]}` : null,
    number: number?.[1] ?? null,
  };
}

/** Короткий идентификатор письма: первые 8 знаков имени файла или узла. */
export function letterIdOf(letter: TreeLetter): string {
  const source = (letter.node.filePath ?? letter.node.guid).replace(/[^0-9a-zA-Z]/g, "");
  return source.slice(0, 8).toLowerCase();
}

export interface TextExtractor {
  (pdf: Uint8Array): Promise<string>;
}

/** `pdftotext -layout`: раскладка колонок — единственное, что держит таблицы писем. */
export function pdftotextExtractor(binary = "pdftotext"): TextExtractor {
  return async (pdf) => {
    const dir = mkdtempSync(join(tmpdir(), "bim-letter-"));
    try {
      const path = join(dir, "letter.pdf");
      writeFileSync(path, pdf);
      try {
        const { stdout } = await execFileAsync(binary, ["-layout", "-enc", "UTF-8", path, "-"], { maxBuffer: 256 * 1024 * 1024, timeout: 180_000 });
        return stdout;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "ENOENT") throw new Error("Нет pdftotext (пакет poppler-utils): `sudo apt install poppler-utils`.");
        throw error;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export interface FetchOptions {
  readonly indexDir: string;
  readonly startGuid: string | null;
  readonly year: number | null;
  readonly quarter: number | null;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly dumpDepth: number | null;
  readonly pauseMs: number;
}

export interface FetchDeps {
  readonly download: Downloader;
  readonly extract: TextExtractor;
  readonly log: (message: string) => void;
  readonly now?: () => Date;
}

export type FetchOutcome =
  | { readonly status: "dumped" }
  | { readonly status: "no-letters"; readonly reason: string }
  | { readonly status: "up-to-date"; readonly file: string; readonly letters: number }
  | { readonly status: "planned"; readonly quarter: { year: number; quarter: number }; readonly letters: readonly string[] }
  | { readonly status: "built"; readonly file: string; readonly data: BimIndicesData }
  | { readonly status: "rejected"; readonly reason: string };

function existingLetterIds(path: string): ReadonlySet<string> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { letters?: ReadonlyArray<{ id?: unknown }> };
    return new Set((parsed.letters ?? []).map((letter) => String(letter.id)));
  } catch {
    return null;
  }
}

function elementCount(path: string): number {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { elements?: unknown[] }).elements?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Обход дерева, скачивание новых писем, сборка и атомарная запись файла квартала. */
export async function runFetch(options: FetchOptions, deps: FetchDeps): Promise<FetchOutcome> {
  const { log } = deps;
  const letters = await collectLetters({
    download: deps.download,
    log,
    startGuid: options.startGuid,
    year: options.year,
    quarter: options.quarter,
    dumpDepth: options.dumpDepth,
  });
  if (options.dumpDepth !== null) return { status: "dumped" };

  const target = options.year !== null && options.quarter !== null ? { year: options.year, quarter: options.quarter } : latestQuarter(letters);
  if (target === null) {
    return {
      status: "no-letters",
      reason: `В дереве ФГИС ЦС не найдено писем с кварталом в пути (найдено писем: ${String(letters.length)}). Запустите с --dump-tree и проверьте имена папок.`,
    };
  }
  const chosen = letters.filter((letter) => letter.year === target.year && letter.quarter === target.quarter);
  if (chosen.length === 0) return { status: "no-letters", reason: `Писем ${String(target.quarter)} квартала ${String(target.year)} в дереве нет.` };
  log(`— ${String(target.quarter)} квартал ${String(target.year)}: писем в дереве ${String(chosen.length)}`);

  const dir = resolve(options.indexDir, BIM_INDICES_DIR);
  const name = bimIndicesFileName({ year: target.year, quarter: target.quarter as 1 | 2 | 3 | 4 });
  const path = resolve(dir, name);
  const ids = chosen.map(letterIdOf);
  const known = existingLetterIds(path);
  if (!options.force && known !== null && ids.every((id) => known.has(id))) {
    log(`  файл ${name} уже собран из всех ${String(ids.length)} писем: пропуск (--force пересоберёт)`);
    return { status: "up-to-date", file: path, letters: ids.length };
  }
  if (options.dryRun) return { status: "planned", quarter: target, letters: ids };

  const inputs: LetterInput[] = [];
  for (const letter of chosen) {
    const id = letterIdOf(letter);
    const filePath = letter.node.filePath as string;
    log(`  скачиваю ${letter.node.name}`);
    const pdf = await deps.download(fileContentUrl(filePath), "pdf", `Письмо «${letter.node.name}»`);
    const text = await deps.extract(pdf);
    if (text.trim().length < 200) throw new Error(`Письмо «${letter.node.name}»: pdftotext вернул почти пустой текст (${String(text.length)} знаков).`);
    const fromName = requisitesOfName(letter.node.name);
    const info: Omit<BimLetterInfo, "pages"> = {
      id,
      number: letter.node.number ?? fromName.number ?? id,
      date: (letter.node.date ?? "").slice(0, 10).match(/^\d{4}-\d{2}-\d{2}$/) !== null ? (letter.node.date as string).slice(0, 10) : (fromName.date ?? `${String(target.year)}-01-01`),
      title: letter.node.name,
      file: `bim-indices-${String(target.year)}q${String(target.quarter)}-${id}.txt`,
    };
    inputs.push({ info, text });
  }

  const { data, parsed } = buildBimIndices(inputs);
  for (const [id, result] of parsed) log(`  ${id}: ${JSON.stringify(result.stats)}${result.warnings.length > 0 ? `, предупреждений ${String(result.warnings.length)}` : ""}`);
  if (data.quarter.year !== target.year || data.quarter.quarter !== target.quarter) {
    return { status: "rejected", reason: `Письма названы ${String(target.quarter)} кварталом ${String(target.year)}, а в тексте — ${String(data.quarter.quarter)} кварталом ${String(data.quarter.year)}.` };
  }
  if (data.elements.length === 0) return { status: "rejected", reason: "Ни одной записи по элементам прямых затрат не разобрано: формат писем изменился?" };
  const previous = elementCount(path);
  if (previous > 0 && data.elements.length < previous * MIN_KEEP_SHARE) {
    return {
      status: "rejected",
      reason: `Новый файл содержит ${String(data.elements.length)} записей по элементам против ${String(previous)} в прежнем: разбор, вероятно, сломался; прежний файл оставлен.`,
    };
  }

  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, stringifyBimIndices(data), "utf8");
  renameSync(tmp, path);
  const sourcesDir = resolve(dir, "sources");
  mkdirSync(sourcesDir, { recursive: true });
  for (const input of inputs) writeFileSync(resolve(sourcesDir, input.info.file ?? `${input.info.id}.txt`), input.text, "utf8");
  log(`  записан ${path}: ${String(data.elements.length)} записей по элементам, ${String(data.smr.length)} СМР, ${String(data.transport.length)} перевозка`);
  for (const note of data.notes.slice(0, 20)) log(`  ПРИМЕЧАНИЕ: ${note}`);
  return { status: "built", file: path, data };
}

/** Файлы квартальных справочников в каталоге индекса: `bim-indices-<год>q<кв>.json`. */
export function listBimIndexFiles(indexDir: string): string[] {
  const dir = resolve(indexDir, BIM_INDICES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /^bim-indices-\d{4}q[1-4]\.json$/.test(file))
    .sort()
    .map((file) => resolve(dir, file));
}

export function parseFetchArgs(argv: readonly string[]): FetchOptions {
  let indexDir = DEFAULT_INDEX;
  let startGuid: string | null = null;
  let year: number | null = null;
  let quarter: number | null = null;
  let force = false;
  let dryRun = false;
  let dumpDepth: number | null = null;
  let pauseMs = 2_000;
  const intArg = (flag: string, value: string | undefined, min: number, max: number): number => {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${flag} ожидает целое число от ${String(min)} до ${String(max)}.`);
    return parsed;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--index" && value !== undefined) {
      indexDir = resolve(value);
      i += 1;
    } else if (arg === "--guid" && value !== undefined) {
      startGuid = value;
      i += 1;
    } else if (arg === "--year") {
      year = intArg("--year", value, 2000, 2099);
      i += 1;
    } else if (arg === "--quarter") {
      quarter = intArg("--quarter", value, 1, 4);
      i += 1;
    } else if (arg === "--pause") {
      pauseMs = intArg("--pause", value, 0, 600_000);
      i += 1;
    } else if (arg === "--depth") {
      dumpDepth = intArg("--depth", value, 1, MAX_DEPTH);
      i += 1;
    } else if (arg === "--dump-tree") {
      dumpDepth = dumpDepth ?? 3;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg !== undefined && arg.startsWith("--")) {
      throw new Error(`Неизвестный флаг ${arg}.`);
    }
  }
  if ((year === null) !== (quarter === null)) throw new Error("--year и --quarter задаются вместе.");
  return { indexDir, startGuid, year, quarter, force, dryRun, dumpDepth, pauseMs };
}

async function main(): Promise<void> {
  const options = parseFetchArgs(process.argv.slice(2));
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  const download = pacedDownloader(createDownloader(log), options.pauseMs);
  const outcome = await runFetch(options, { download, extract: pdftotextExtractor(), log });
  if (outcome.status === "no-letters" || outcome.status === "rejected") {
    process.stderr.write(`${outcome.reason}\n`);
    process.exitCode = 1;
  } else if (outcome.status === "planned") {
    log(`будет собрано: ${String(outcome.quarter.quarter)} квартал ${String(outcome.quarter.year)}, писем ${String(outcome.letters.length)}`);
  }
}

if (typeof require !== "undefined" && require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
