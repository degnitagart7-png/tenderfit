import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseFerResourcesXml,
  parseFerTransportXml,
  parseFerXml,
  type FerBook,
  type FerRate,
} from "../../src/lib/fsnb/ferXml";
import { fer2020ZipUrl } from "../../src/lib/fsnb/fgisBimApi";
import { findZipEntry, readZipDirectory, readZipEntry, type ZipEntry } from "../../src/lib/fsnb/zipArchive";
import { XmlTokenizer, type XmlToken } from "../../src/lib/fsnb/xmlTokenizer";
import { createDownloader } from "./fetch-zone";

/**
 * Сборка ФЕР-2020 (ФЕР-2001 в уровне цен 01.01.2000) для метода БИМ из открытого набора ФГИС ЦС
 * «ФСНБ-2020 включая дополнение №9, действует с 01.02.2022» → `data/fsnb/index/fer2020/*.jsonl`.
 *
 * Данные собираются на сервере тем же скриптом, что и локально: каталог `data/` на сервер не
 * выкладывается (как и зоны ФГИС ЦС), исходный архив скрипт скачивает сам. Только с российского IP:
 * с машины за границей будет таймаут — тогда `--from-file` с локальным архивом.
 *
 * Что внутри архива и что берётся (структура проверена на реальной выгрузке, см. `ferXml.ts`):
 * - ФЕР, ФЕРм, ФЕРмр, ФЕРп, ФЕРр — 52 тысячи расценок с базисной стоимостью, ОЗП, ЭМ, ЗПМ, материалами,
 *   затратами труда и указателями НР/СП → `rates.jsonl`;
 * - ФССЦ — цены материалов 2001 года → `materials.jsonl`; ФСЭМ — машины → `machines.jsonl`;
 * - ФССЦпг — перевозка и погрузка → `transport.jsonl`;
 * - ГЭСН*.xml (нормы без цен) не нужны: расценки несут и нормы, и цены.
 *
 * Память. Сервер — 4 ГБ, на нём живут приложение и воркер. Архив читается в память целиком (13 МБ),
 * записи распаковываются по одной (наибольшая — ФЕР.xml, 77 МБ), XML разбирается окнами по 1 МиБ, а
 * расценки пишутся в файл строка за строкой: пик — одна распакованная запись плюс окно, около
 * 200 МБ RSS (измерено, см. отчёт сборки `peakRssMb`). Каталог собирается рядом и подменяет
 * `fer2020/` переименованием: читатель никогда не видит полусобранное.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/build-fer2020.ts                      — скачать архив и собрать
 *   npx tsx scripts/fsnb/build-fer2020.ts --from-file fsnb2020.zip
 *   npx tsx scripts/fsnb/build-fer2020.ts --if-missing         — не собирать, если уже собрано (ночной запуск)
 *   флаги: --index <каталог индекса> (по умолчанию FSNB_INDEX_DIR или data/fsnb/index), --keep-zip <путь>
 */

const ROOT = resolve(__dirname, "../..");
const DEFAULT_INDEX =
  process.env.FSNB_INDEX_DIR !== undefined && process.env.FSNB_INDEX_DIR.trim() !== ""
    ? resolve(process.env.FSNB_INDEX_DIR)
    : resolve(ROOT, "data/fsnb/index");

/** Версия формата каталога `fer2020/`: меняется вместе с полями записей — старый каталог тогда пересобирается. */
export const FER2020_FORMAT = 1;
export const FER2020_DIR = "fer2020";
const BOOKS: readonly FerBook[] = ["ФЕР", "ФЕРм", "ФЕРмр", "ФЕРп", "ФЕРр"];
const WINDOW_BYTES = 1 << 20;
const WRITE_BUFFER_LINES = 2000;

export interface Fer2020Report {
  readonly format: number;
  readonly builtAt: string;
  readonly source: string;
  readonly zipBytes: number;
  readonly zipSha256: string;
  readonly priceLevel: "01.01.2000";
  /** Расценок по книгам. */
  readonly books: Readonly<Record<string, number>>;
  readonly files: Readonly<Record<string, { readonly lines: number; readonly bytes: number }>>;
  /** Расценок, у которых «Всего» ≠ ОЗП + ЭМ + материалы (допуск 2 коп.). Должно быть 0. */
  readonly costMismatches: number;
  /** Повторы пары «книга + код»: последний побеждает при чтении. */
  readonly duplicateCodes: number;
  readonly notes: readonly string[];
  readonly seconds: number;
  readonly peakRssMb: number;
}

class JsonlWriter {
  private readonly fd: number;
  private buffer: string[] = [];
  private written = 0;

  constructor(private readonly path: string) {
    this.fd = openSync(path, "w");
  }

  append(record: unknown): void {
    this.buffer.push(JSON.stringify(record));
    if (this.buffer.length >= WRITE_BUFFER_LINES) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    writeSync(this.fd, `${this.buffer.join("\n")}\n`);
    this.written += this.buffer.length;
    this.buffer = [];
  }

  close(): { lines: number; bytes: number } {
    this.flush();
    closeSync(this.fd);
    return { lines: this.written, bytes: statSync(this.path).size };
  }
}

/** Кодировка XML из его декларации; ФСНБ-2020 смешивает utf-8 (книги, ФССЦ, ФСЭМ) и windows-1251 (ФССЦпг). */
export function xmlEncodingOf(head: Buffer): string {
  const declared = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head.subarray(0, 200).toString("latin1"))?.[1];
  const label = (declared ?? "utf-8").toLowerCase();
  return label === "utf8" ? "utf-8" : label;
}

/** Токены XML из распакованной записи: окнами по 1 МиБ, декодер помнит хвост многобайтового символа. */
export function* xmlTokensOf(content: Buffer): Generator<XmlToken> {
  const decoder = new TextDecoder(xmlEncodingOf(content));
  const tokenizer = new XmlTokenizer();
  for (let at = 0; at < content.length; at += WINDOW_BYTES) {
    let text = decoder.decode(content.subarray(at, Math.min(content.length, at + WINDOW_BYTES)), { stream: true });
    if (at === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    yield* tokenizer.push(text);
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield* tokenizer.push(tail);
  yield* tokenizer.flush();
}

/** Запись расценки в файл: пустые поля не пишутся, чтобы каталог не раздувался (общий вид — `FerRate`). */
export function compactRate(rate: FerRate): Record<string, unknown> {
  const record: Record<string, unknown> = {
    code: rate.code,
    book: rate.book,
    table: rate.table,
    name: rate.name,
    unit: rate.unit,
    cost: rate.cost,
    wage: rate.wage,
    machines: rate.machines,
    machinistWage: rate.machinistWage,
    materials: rate.materials,
  };
  if (rate.endName !== "") record.endName = rate.endName;
  if (rate.collectionCode !== "") record.collectionCode = rate.collectionCode;
  if (rate.collectionName !== "") record.collectionName = rate.collectionName;
  if (rate.labourHours !== null) record.labourHours = rate.labourHours;
  if (rate.machinistHours !== null) record.machinistHours = rate.machinistHours;
  if (rate.overheadRef !== null) record.overheadRef = rate.overheadRef;
  if (rate.profitRef !== null) record.profitRef = rate.profitRef;
  if (rate.unaccounted.length > 0) record.unaccounted = rate.unaccounted;
  if (rate.correction !== null) record.correction = rate.correction;
  return record;
}

export interface BuildFer2020Options {
  readonly zip: Buffer;
  /** Каталог индекса: результат ляжет в `<indexDir>/fer2020`. */
  readonly indexDir: string;
  /** Откуда архив — для паспорта: URL или путь. */
  readonly source: string;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
}

const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} МБ`;

/** Собирает каталог `fer2020/` из архива. Бросает, если в архиве нет ни одной книги ФЕР. */
export function buildFer2020(options: BuildFer2020Options): Fer2020Report {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const started = Date.now();
  let peak = process.memoryUsage().rss;
  const sample = (): void => {
    peak = Math.max(peak, process.memoryUsage().rss);
  };

  const entries = readZipDirectory(options.zip);
  const found = BOOKS.map((book) => ({ book, entry: findZipEntry(entries, `${book}.xml`) })).filter(
    (item): item is { book: FerBook; entry: ZipEntry } => item.entry !== null,
  );
  if (found.length === 0) {
    throw new Error(
      `В архиве нет ни одной книги ФЕР (ФЕР.xml, ФЕРм.xml, …). Записи: ${entries.map((entry) => entry.baseName).slice(0, 12).join(", ")}.`,
    );
  }
  const notes: string[] = [];
  for (const book of BOOKS) {
    if (!found.some((item) => item.book === book)) notes.push(`В архиве нет книги ${book}.xml: расценки этой книги в каталог не попали.`);
  }

  const finalDir = resolve(options.indexDir, FER2020_DIR);
  const tempDir = resolve(options.indexDir, `.${FER2020_DIR}-build-${String(process.pid)}`);
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  const files: Record<string, { lines: number; bytes: number }> = {};
  const books: Record<string, number> = {};
  let costMismatches = 0;
  let duplicateCodes = 0;
  try {
    const rates = new JsonlWriter(resolve(tempDir, "rates.jsonl"));
    const seen = new Set<string>();
    for (const { book, entry } of found) {
      const begun = Date.now();
      const content = readZipEntry(options.zip, entry);
      sample();
      let count = 0;
      for (const rate of parseFerXml(xmlTokensOf(content), book)) {
        const key = `${rate.book}|${rate.code}`;
        if (seen.has(key)) duplicateCodes += 1;
        else seen.add(key);
        if (Math.abs(rate.cost - (rate.wage + rate.machines + rate.materials)) > 0.02) costMismatches += 1;
        rates.append(compactRate(rate));
        count += 1;
        if (count % 5000 === 0) sample();
      }
      books[book] = count;
      sample();
      log(`  ${book}: ${String(count)} расценок за ${((Date.now() - begun) / 1000).toFixed(1)} с (${mb(content.length)} XML)`);
    }
    files["rates.jsonl"] = rates.close();

    const catalogs: ReadonlyArray<{ file: string; entry: string; kind: "resources" | "transport" }> = [
      { file: "materials.jsonl", entry: "ФССЦ.xml", kind: "resources" },
      { file: "machines.jsonl", entry: "ФСЭМ.xml", kind: "resources" },
      { file: "transport.jsonl", entry: "ФССЦпг.xml", kind: "transport" },
    ];
    for (const catalog of catalogs) {
      const entry = findZipEntry(entries, catalog.entry);
      if (entry === null) {
        notes.push(`В архиве нет ${catalog.entry}: ${catalog.file} не собран.`);
        continue;
      }
      const writer = new JsonlWriter(resolve(tempDir, catalog.file));
      const content = readZipEntry(options.zip, entry);
      sample();
      const records = catalog.kind === "resources" ? parseFerResourcesXml(xmlTokensOf(content)) : parseFerTransportXml(xmlTokensOf(content));
      for (const record of records) writer.append(record);
      files[catalog.file] = writer.close();
      sample();
      log(`  ${catalog.entry}: ${String(files[catalog.file]?.lines ?? 0)} записей`);
    }

    if (costMismatches > 0) {
      notes.push(`У ${String(costMismatches)} расценок «Всего» не равно ОЗП + ЭМ + материалы (допуск 2 коп.): проверьте выгрузку.`);
    }
    if (duplicateCodes > 0) notes.push(`Повторов пары «книга + код»: ${String(duplicateCodes)}; при чтении побеждает последний.`);

    sample();
    const report: Fer2020Report = {
      format: FER2020_FORMAT,
      builtAt: (options.now ?? (() => new Date()))().toISOString(),
      source: options.source,
      zipBytes: options.zip.length,
      zipSha256: createHash("sha256").update(options.zip).digest("hex"),
      priceLevel: "01.01.2000",
      books,
      files,
      costMismatches,
      duplicateCodes,
      notes,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      peakRssMb: Math.round(peak / 1_048_576),
    };
    writeFileSync(resolve(tempDir, "build-info.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

    // Подмена каталога: старый уходит в сторону и удаляется только после того, как новый встал на место.
    const oldDir = `${finalDir}.old-${String(process.pid)}`;
    rmSync(oldDir, { recursive: true, force: true });
    if (existsSync(finalDir)) renameSync(finalDir, oldDir);
    renameSync(tempDir, finalDir);
    rmSync(oldDir, { recursive: true, force: true });
    return report;
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/** Каталог уже собран в нынешнем формате. */
export function isFer2020Built(indexDir: string): boolean {
  const info = resolve(indexDir, FER2020_DIR, "build-info.json");
  if (!existsSync(info)) return false;
  try {
    const parsed = JSON.parse(readFileSync(info, "utf8")) as { format?: unknown };
    return parsed.format === FER2020_FORMAT && existsSync(resolve(indexDir, FER2020_DIR, "rates.jsonl"));
  } catch {
    return false;
  }
}

export interface BuildFerArgs {
  readonly fromFile: string | null;
  readonly indexDir: string;
  readonly ifMissing: boolean;
  readonly keepZip: string | null;
}

export function parseBuildFerArgs(argv: readonly string[]): BuildFerArgs {
  let fromFile: string | null = null;
  let indexDir = DEFAULT_INDEX;
  let ifMissing = false;
  let keepZip: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--from-file" && value !== undefined) {
      fromFile = resolve(value);
      i += 1;
    } else if (arg === "--index" && value !== undefined) {
      indexDir = resolve(value);
      i += 1;
    } else if (arg === "--keep-zip" && value !== undefined) {
      keepZip = resolve(value);
      i += 1;
    } else if (arg === "--if-missing") {
      ifMissing = true;
    } else if (arg !== undefined && arg.startsWith("--")) {
      throw new Error(`Неизвестный флаг ${arg}.`);
    }
  }
  return { fromFile, indexDir, ifMissing, keepZip };
}

async function main(): Promise<void> {
  const args = parseBuildFerArgs(process.argv.slice(2));
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  if (args.ifMissing && isFer2020Built(args.indexDir)) {
    log(`ФЕР-2020 уже собраны (${resolve(args.indexDir, FER2020_DIR)}): пропуск. Для пересборки уберите --if-missing.`);
    return;
  }

  let zip: Buffer;
  let source: string;
  if (args.fromFile !== null) {
    log(`— читаю архив ${args.fromFile}`);
    zip = readFileSync(args.fromFile);
    source = args.fromFile;
  } else {
    const url = fer2020ZipUrl();
    log(`— скачиваю ${url}`);
    zip = Buffer.from(await createDownloader(log)(url, "zip", "Набор ФСНБ-2020 (ФЕР)"));
    source = url;
  }
  log(`  архив ${mb(zip.length)}`);
  if (args.keepZip !== null) {
    mkdirSync(resolve(args.keepZip, ".."), { recursive: true });
    writeFileSync(args.keepZip, zip);
  }

  mkdirSync(args.indexDir, { recursive: true });
  const report = buildFer2020({ zip, indexDir: args.indexDir, source, log });
  log("— итог");
  for (const [file, stat] of Object.entries(report.files)) log(`  ${file}: ${String(stat.lines)} строк, ${mb(stat.bytes)}`);
  for (const note of report.notes) log(`  ПРИМЕЧАНИЕ: ${note}`);
  log(`  работа заняла ${String(report.seconds)} с, пик памяти ${String(report.peakRssMb)} МБ RSS`);
}

if (typeof require !== "undefined" && require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
