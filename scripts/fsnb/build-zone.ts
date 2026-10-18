import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import * as XLSX from "xlsx";

import {
  classifySplitRow,
  parseSplitFormStream,
  toCurrentPrice,
  type BaseMachineFacts,
  type SplitFormCoverage,
} from "../../src/domain/estimate/splitForm";
import {
  loadPriceLine,
  parseLoadAutoRows,
  parseTransportAutoRows,
  transportSeriesLine,
} from "../../src/domain/estimate/autoServices";
import { quarterIn } from "../../src/domain/estimate/priceLevel";
import { buildWageAnchors, findFscsrSheets, machinistWageFactor, parseFscsr } from "../../src/domain/estimate/zoneBuild";
import { streamSheetRows } from "../../src/lib/fsnb/xlsxStream";

/**
 * Сборка цен одной ценовой зоны из сырья, скачанного `fetch-zone.ts`.
 *
 * Результат — каталог `data/fsnb/index/zones/<priceZoneId>/`: текущие цены ФСЦСР,
 * цены сплит-формы, тарифная шкала, реквизиты сплит-формы и паспорт зоны
 * (`zone.json`). Общие для всех зон файлы (нормы, базисные цены, нормативы НР и
 * СП, список зон) в зону не копируются: они лежат в корне индекса и грузятся один
 * раз.
 *
 * Логика сборки — та же, что у корневых файлов Амура: разбор ФСЦСР и ставок общий
 * (`zoneBuild.ts`, им пользуется и `build-index.ts`), сплит-форма режется по
 * кодам, встречающимся в нормах (`build-split-form.ts`). Совпадение зоны 282 с
 * корневыми файлами проверяет `compare-zone.ts`.
 *
 * Память. Сплит-форма — 281 тысяча строк, и сервер на 4 ГБ делит память с
 * приложением и воркером. Строки листа не материализуются массивом (`sheetRows`),
 * разбираются лениво и фильтруются по кодам норм; в конце печатается пиковый RSS.
 *
 * Перевозка и погрузка. Если в сырье есть `transport-auto.xlsx` и `load-auto.xlsx`
 * (сметные цены услуг автотранспорта, ФГИС ЦС), пишутся `transport-auto.jsonl` (серии цен
 * по километрам: код без километров, тип ТС, грузоподъёмность, класс груза, тип дорог, цена
 * на каждый километр) и `load-auto.jsonl` (код, группа груза, погрузка или разгрузка, цена).
 * Файлы потоковые, размер — в `zone.json`. Нет сырья — зона собирается без них, и расчёт
 * считает такие позиции по цене заказчика, как раньше.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/build-zone.ts --zone 236 [--period 427] [--all]
 *   --raw <каталог>   взять fscsr.xlsx, wages.json, split.xlsx оттуда, а не из data/fsnb/raw/zones/…
 *   --out <каталог>   куда писать (по умолчанию data/fsnb/index/zones/<id>)
 *   --index <каталог> откуда брать нормы и базисные цены (по умолчанию data/fsnb/index)
 */

const ROOT = resolve(__dirname, "../..");

/** Версия формата зоны: 2 — со сметными ценами услуг автотранспорта (`transport-auto.jsonl`, `load-auto.jsonl`). */
export const ZONE_BUILD_VERSION = 2;

export interface BuildZoneOptions {
  readonly zone: number;
  readonly period: number | null;
  readonly raw: string | null;
  readonly out: string | null;
  readonly index: string;
  readonly keepAll: boolean;
}

function parseArgs(argv: readonly string[]): BuildZoneOptions {
  let zone: number | null = null;
  let period: number | null = null;
  let raw: string | null = null;
  let out: string | null = null;
  let index = resolve(ROOT, "data/fsnb/index");
  let keepAll = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--zone" && value !== undefined) {
      zone = Number.parseInt(value, 10);
      i += 1;
    } else if (arg === "--period" && value !== undefined) {
      period = Number.parseInt(value, 10);
      i += 1;
    } else if (arg === "--raw" && value !== undefined) {
      raw = resolve(value);
      i += 1;
    } else if (arg === "--out" && value !== undefined) {
      out = resolve(value);
      i += 1;
    } else if (arg === "--index" && value !== undefined) {
      index = resolve(value);
      i += 1;
    } else if (arg === "--all") {
      keepAll = true;
    }
  }
  if (zone === null || !Number.isInteger(zone) || zone <= 0) {
    throw new Error("Укажите зону: npx tsx scripts/fsnb/build-zone.ts --zone <priceZoneId> [--period <id>]");
  }
  return { zone, period, raw, out, index, keepAll };
}

interface RawFiles {
  readonly dir: string;
  readonly periodId: number | null;
  readonly fscsr: string;
  readonly wages: string;
  readonly split: string;
  /** Необязательные файлы цен услуг автотранспорта; null — не скачаны. */
  readonly transport: string | null;
  readonly load: string | null;
  readonly meta: RawMeta | null;
}

interface RawMeta {
  readonly zoneName?: string;
  readonly periodName?: string;
  readonly periodId?: number;
  readonly urls?: Record<string, string>;
}

function locateRaw(options: BuildZoneOptions): RawFiles {
  let dir = options.raw;
  let periodId: number | null = options.period;
  if (dir === null) {
    const zoneDir = resolve(ROOT, "data/fsnb/raw/zones", String(options.zone));
    if (!existsSync(zoneDir)) {
      throw new Error(
        `Нет сырья зоны ${String(options.zone)}: ${zoneDir}. Сначала скачайте его: npx tsx scripts/fsnb/fetch-zone.ts --zone ${String(options.zone)}`,
      );
    }
    if (periodId === null) {
      const periods = readdirSync(zoneDir)
        .map((name) => Number.parseInt(name, 10))
        .filter((value) => Number.isInteger(value))
        .sort((a, b) => b - a);
      periodId = periods[0] ?? null;
    }
    if (periodId === null) throw new Error(`В ${zoneDir} нет ни одного периода.`);
    dir = resolve(zoneDir, String(periodId));
  }

  const need = (name: string): string => {
    const path = resolve(dir as string, name);
    if (!existsSync(path)) throw new Error(`Не найден ${path}. Скачайте сырьё: fetch-zone.ts --zone ${String(options.zone)}`);
    return path;
  };
  const metaPath = resolve(dir, "meta.json");
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as RawMeta) : null;
  return {
    dir,
    periodId: periodId ?? meta?.periodId ?? null,
    fscsr: need("fscsr.xlsx"),
    wages: need("wages.json"),
    split: need("split.xlsx"),
    transport: existsSync(resolve(dir, "transport-auto.xlsx")) ? resolve(dir, "transport-auto.xlsx") : null,
    load: existsSync(resolve(dir, "load-auto.xlsx")) ? resolve(dir, "load-auto.xlsx") : null,
    meta,
  };
}

async function readLines(path: string, onLine: (line: string) => void): Promise<void> {
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of reader) if (line.trim() !== "") onLine(line);
}

/** Коды ресурсов, которые встречаются в нормах: остальное сплит-формы расчёту не нужно. */
async function codesUsedByNorms(path: string): Promise<Set<string>> {
  const used = new Set<string>();
  await readLines(path, (line) => {
    let record: { resources?: { code?: string }[] };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      return;
    }
    for (const resource of record.resources ?? []) {
      if (typeof resource.code === "string") used.add(resource.code);
    }
  });
  return used;
}

/** Оплата труда звена по коду машины: сплит-форма её не публикует. */
async function machineFacts(path: string): Promise<Map<string, BaseMachineFacts>> {
  const map = new Map<string, BaseMachineFacts>();
  await readLines(path, (line) => {
    let record: { code?: string; machinistSalary?: number | null; machinistHours?: number | null };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      return;
    }
    const { code, machinistSalary, machinistHours } = record;
    if (code === undefined || typeof machinistSalary !== "number") return;
    map.set(code, {
      machinistSalary,
      machinistHours: typeof machinistHours === "number" ? machinistHours : 1,
    });
  });
  return map;
}

let peakRss = 0;
function sampleRss(): number {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
  return rss;
}
const mb = (bytes: number): string => `${Math.round(bytes / 1_048_576)} МБ`;

function defaultLog(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeJsonl(path: string, records: readonly unknown[]): void {
  writeFileSync(path, records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

/**
 * Потоковая запись файла «все цены сплит-формы» (`prices-split-all.jsonl`).
 *
 * Основной `prices-split.jsonl` режется по кодам из норм: расчёту сметы нужны они, и это
 * пара процентов строк. Аудиту сметы заказчика нужны и позиции-поставки (кабель отдельной
 * позицией), которых в нормах нет, — для них пишется второй файл без фильтра. Он потоковый:
 * строки уходят в файл пачками и в памяти не накапливаются, пик сборки не растёт. Пишется
 * во временный файл и переименовывается в конце, чтобы оборванная сборка не оставила
 * недописанный файл, который прочитался бы как полный.
 */
class SplitAllWriter {
  private readonly tmp: string;
  private readonly fd: number;
  private batch: string[] = [];
  count = 0;

  constructor(private readonly path: string) {
    this.tmp = `${path}.tmp`;
    this.fd = openSync(this.tmp, "w");
  }

  add(record: { c: string; p: number; u: string; i: boolean }): void {
    this.batch.push(JSON.stringify(record));
    this.count += 1;
    if (this.batch.length >= 5_000) this.flush();
  }

  private flush(): void {
    if (this.batch.length === 0) return;
    writeSync(this.fd, `${this.batch.join("\n")}\n`);
    this.batch = [];
  }

  finish(): number {
    this.flush();
    closeSync(this.fd);
    renameSync(this.tmp, this.path);
    return statSync(this.path).size;
  }

  abort(): void {
    try {
      closeSync(this.fd);
    } catch {
      // уже закрыт
    }
  }
}

/** Потоковая запись JSONL во временный файл с переименованием в конце. Возвращает размер. */
function writeJsonlStream(path: string, lines: Iterable<string>): { count: number; bytes: number } {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  let count = 0;
  let batch: string[] = [];
  try {
    for (const line of lines) {
      batch.push(line);
      count += 1;
      if (batch.length >= 2_000) {
        writeSync(fd, `${batch.join("\n")}\n`);
        batch = [];
      }
    }
    if (batch.length > 0) writeSync(fd, `${batch.join("\n")}\n`);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, path);
  return { count, bytes: statSync(path).size };
}

interface AutoServicesBuild {
  readonly counts: Record<string, number>;
  readonly sources: { title: string; url: string }[];
  /** Хоть одна таблица записана. */
  readonly written: boolean;
}

/**
 * Цены перевозки и погрузки зоны из сырья. Каждая таблица проверяется на принадлежность
 * зоне и кварталу сборки: цены чужой зоны в расчёт попасть не должны, поэтому при
 * расхождении таблица не пишется, а причина идёт в `notes`.
 */
function buildAutoServices(
  raw: RawFiles,
  out: string,
  zone: { name: string; period: string },
  notes: string[],
  log: (message: string) => void,
): AutoServicesBuild {
  const counts: Record<string, number> = {};
  const sources: { title: string; url: string }[] = [];
  let written = false;
  const urls = raw.meta?.urls ?? {};
  const expectedQuarter = quarterIn(zone.period);
  // Файлы прежней сборки в том же каталоге относятся к другому периоду: не оставляем их под новым паспортом.
  rmSync(resolve(out, "transport-auto.jsonl"), { force: true });
  rmSync(resolve(out, "load-auto.jsonl"), { force: true });

  // Названия зон сравниваются без различий в регистре, пробелах и «ё»: одно и то же имя на двух листах портала.
  const flat = (value: string): string => value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const consistent = (what: string, label: string | null, period: string | null): boolean => {
    if (label !== null && !flat(label).startsWith(flat(zone.name))) {
      notes.push(`${what}: таблица относится к зоне «${label}», а не «${zone.name}» — не записана.`);
      return false;
    }
    const quarter = period === null ? null : quarterIn(period);
    if (
      expectedQuarter !== null &&
      quarter !== null &&
      (quarter.quarter !== expectedQuarter.quarter || quarter.year !== expectedQuarter.year)
    ) {
      notes.push(`${what}: таблица за «${period ?? ""}», а зона собрана за «${zone.period}» — не записана.`);
      return false;
    }
    return true;
  };

  if (raw.transport !== null) {
    const parsed = parseTransportAutoRows(streamSheetRows(raw.transport, 13));
    if (parsed.series.length === 0) {
      notes.push("Цены перевозки: в таблице не найдено ни одной цены — transport-auto.jsonl не записан.");
    } else if (consistent("Цены перевозки", parsed.zone, parsed.period)) {
      const result = writeJsonlStream(resolve(out, "transport-auto.jsonl"), parsed.series.map(transportSeriesLine));
      counts.transportAutoSeries = result.count;
      counts.transportAutoPrices = parsed.prices;
      counts.transportAutoBytes = result.bytes;
      written = true;
      log(`  перевозка: ${String(result.count)} серий, ${String(parsed.prices)} цен, ${(result.bytes / 1_048_576).toFixed(2)} МБ`);
      if (parsed.skipped > 0) notes.push(`Цены перевозки: пропущено ячеек с нечитаемой ценой или повтором: ${String(parsed.skipped)}.`);
      sources.push({
        title: `Сметные цены услуг на перевозку грузов для строительства автомобильным транспортом, ${zone.name}, ${zone.period}`,
        url: urls.transport ?? "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/Services/Export/TransportationByAutoPortal",
      });
    }
  }

  if (raw.load !== null) {
    const parsed = parseLoadAutoRows(streamSheetRows(raw.load, 6));
    if (parsed.prices.length === 0) {
      notes.push("Цены погрузочно-разгрузочных работ: в таблице не найдено ни одной цены — load-auto.jsonl не записан.");
    } else if (consistent("Цены погрузочно-разгрузочных работ", parsed.zone, parsed.period)) {
      const result = writeJsonlStream(resolve(out, "load-auto.jsonl"), parsed.prices.map(loadPriceLine));
      counts.loadAutoPrices = result.count;
      counts.loadAutoBytes = result.bytes;
      written = true;
      log(`  погрузка и разгрузка: ${String(result.count)} цен, ${(result.bytes / 1024).toFixed(1)} КБ`);
      sources.push({
        title: `Сметные цены услуг на погрузочно-разгрузочные работы при перевозке грузов автомобильным транспортом, ${zone.name}, ${zone.period}`,
        url: urls.load ?? "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/Services/Export/LoadWorksByAutoPortal",
      });
    }
  }
  return { counts, sources, written };
}

export interface BuildZoneResult {
  readonly zoneDocument: Record<string, unknown>;
  readonly outDir: string;
  readonly peakRssBytes: number;
}

/** Собирает зону в `out`; `log` — куда печатать ход сборки (в тестах — никуда). */
export async function buildZone(
  options: BuildZoneOptions,
  log: (message: string) => void = defaultLog,
): Promise<BuildZoneResult> {
  const started = Date.now();
  const raw = locateRaw(options);
  const out = options.out ?? resolve(options.index, "zones", String(options.zone));
  const normsPath = resolve(options.index, "norms.jsonl");
  const basePath = resolve(options.index, "prices-base.jsonl");
  for (const required of [normsPath, basePath]) {
    if (!existsSync(required)) throw new Error(`Не найден ${required}: сначала нужен общий индекс (build-index.ts).`);
  }
  mkdirSync(out, { recursive: true });
  const notes: string[] = [];

  // --- ФСЦСР и ставки: маленькие файлы, читаются целиком.
  log("— ФСЦСР");
  const fscsrBook = XLSX.readFile(raw.fscsr);
  const names = findFscsrSheets(fscsrBook.SheetNames);
  const machineSheet = names === null ? undefined : fscsrBook.Sheets[names.machines];
  const materialSheet = names === null ? undefined : fscsrBook.Sheets[names.materials];
  if (machineSheet === undefined || materialSheet === undefined) {
    throw new Error(`В ${raw.fscsr} ожидаются листы «Машины…» и «Материалы…», найдены: ${fscsrBook.SheetNames.join(", ")}`);
  }
  const fscsr = parseFscsr(
    XLSX.utils.sheet_to_json<unknown[]>(machineSheet, { header: 1, defval: "" }),
    XLSX.utils.sheet_to_json<unknown[]>(materialSheet, { header: 1, defval: "" }),
  );
  log(`  ${fscsr.meta.zone}, ${fscsr.meta.period}: машин ${String(fscsr.machines.length)}, материалов ${String(fscsr.materials.length)}`);

  log("— ставки");
  const wages = buildWageAnchors(JSON.parse(readFileSync(raw.wages, "utf8")) as unknown, fscsr.anchors);
  log(`  опорных точек рабочих ${String(wages.anchors.length)}, машинистов ${String(wages.machinists.length)}, специалистов ${String(wages.specialists.length)}`);
  sampleRss();

  // --- Сплит-форма: большой лист, строки не материализуются.
  log("— сплит-форма");
  const used = options.keepAll ? null : await codesUsedByNorms(normsPath);
  const machines = await machineFacts(basePath);
  // Рост зарплаты машинистов в зоне — по машинам, у которых она измерена ФСЦСР.
  const wageFactor = machinistWageFactor(fscsr.machines, machines);
  if (wageFactor === null) {
    notes.push("Рост оплаты труда машинистов по ФСЦСР определить не удалось: для машин сплит-формы взят прежний вывод по росту цены маш.-ч.");
  } else {
    log(`  рост оплаты труда машинистов ×${wageFactor.factor.toFixed(4)} (подтверждён ${String(wageFactor.fitting)} из ${String(wageFactor.compared)} машин)`);
  }
  sampleRss();
  const form = parseSplitFormStream(streamSheetRows(raw.split, 9));
  const coverage = { total: 0, withCurrentPrice: 0, withIndex: 0, withNothing: 0 };
  const prices: unknown[] = [];
  let indexed = 0;
  let skipped = 0;
  const allWriter = new SplitAllWriter(resolve(out, "prices-split-all.jsonl"));
  for (const row of form.rows) {
    coverage.total += 1;
    const kind = classifySplitRow(row);
    if (kind === "CURRENT") coverage.withCurrentPrice += 1;
    else if (kind === "INDEX") coverage.withIndex += 1;
    else coverage.withNothing += 1;

    // Все строки с ценой — без фильтра по нормам (для аудита): код, цена, единица, «по индексу».
    if (kind === "CURRENT" && row.currentPrice !== null) {
      allWriter.add({ c: row.code, p: row.currentPrice, u: row.unit, i: false });
    } else if (kind === "INDEX" && row.index !== null && row.basePrice !== null) {
      allWriter.add({ c: row.code, p: Math.round(row.basePrice * row.index * 100) / 100, u: row.unit, i: true });
    }

    if (used !== null && !used.has(row.code)) {
      skipped += 1;
      continue;
    }
    const price = toCurrentPrice(row, form.meta, machines.get(row.code) ?? null, wageFactor?.factor ?? null);
    if (price === null) continue;
    if (price.source === "BASE_2022_INDEXED") indexed += 1;
    prices.push(price);
    if (coverage.total % 50_000 === 0) sampleRss();
  }
  const splitCoverage: SplitFormCoverage = coverage;
  log(`  ${form.meta.zone}, ${form.meta.period}: строк ${String(coverage.total)}, с ценой ${String(coverage.withCurrentPrice)}, по индексу ${String(coverage.withIndex)}, без цены ${String(coverage.withNothing)}`);
  if (prices.length === 0) {
    allWriter.abort();
    throw new Error("Из сплит-формы не получилось ни одной цены: проверьте файл и список норм.");
  }
  const allBytes = allWriter.finish();

  // --- Согласованность источников: одна ли это зона.
  const expectedZone = raw.meta?.zoneName ?? null;
  for (const [label, zoneName] of [
    ["ФСЦСР", fscsr.meta.zone],
    ["сплит-форма", form.meta.zone],
  ] as const) {
    if (expectedZone !== null && zoneName !== expectedZone) {
      notes.push(`Зона в ${label} «${zoneName}» не совпала с названием по справочнику ФГИС ЦС «${expectedZone}».`);
    }
  }
  if (fscsr.meta.zone !== form.meta.zone) {
    notes.push(`ФСЦСР относится к зоне «${fscsr.meta.zone}», сплит-форма — к «${form.meta.zone}»: проверьте сырьё.`);
  }

  // --- Запись.
  writeJsonl(resolve(out, "prices-current.jsonl"), [...fscsr.machines, ...fscsr.materials]);
  writeJsonl(resolve(out, "prices-split.jsonl"), prices);
  writeJsonl(resolve(out, "wages.jsonl"), [
    ...wages.anchors,
    ...wages.machinists.map((item) => ({ kind: "MACHINIST", ...item })),
    ...wages.specialists.map((item) => ({ kind: "SPECIALIST", ...item })),
  ]);
  const builtAt = new Date().toISOString();
  writeFileSync(
    resolve(out, "split-form.json"),
    `${JSON.stringify({ builtAt, source: raw.split, ...form.meta, coverage: splitCoverage, written: prices.length, indexed, skippedUnusedByNorms: skipped }, null, 1)}\n`,
    "utf8",
  );

  const auto = buildAutoServices(raw, out, { name: fscsr.meta.zone, period: fscsr.meta.period }, notes, log);
  // Повтор нужен, только если перевозка не скачалась (сырья нет): таблица чужой зоны или квартала от повтора не изменится.
  const transportMissing = raw.meta?.urls?.transport !== undefined && raw.transport === null;

  const periodId = raw.periodId ?? null;
  const urls = raw.meta?.urls ?? {};
  const sources = [
    { title: `Текущие сметные цены ФСЦСР, ${fscsr.meta.zone}, ${fscsr.meta.period}`, url: urls.fscsr ?? "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/BuildingResources/Export" },
    { title: `Реестр ставок оплаты труда рабочих, ${fscsr.meta.zone}, ${fscsr.meta.period}`, url: urls.wages ?? "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/RimWorkerSalaryRegistry" },
    { title: `Сплит-форма индексов и сметных цен, ${form.meta.zone}, ${form.meta.period}`, url: urls.split ?? "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/BuildingResources/ExportSplitForm" },
    ...auto.sources,
  ];
  const zoneDocument = {
    priceZoneId: options.zone,
    zoneName: expectedZone ?? fscsr.meta.zone,
    subject: fscsr.meta.region,
    periodId,
    period: fscsr.meta.period,
    builtAt,
    indexLetter: form.meta.indexLetter,
    wageAct: form.meta.wageAct,
    // Версия формата паспорта: 2 — со сметными ценами перевозки и погрузки. Ночное обновление
    // пересобирает зоны старее этой версии, даже если период тот же.
    buildVersion: ZONE_BUILD_VERSION,
    // false — перевозка должна была быть, но не скачалась: ночное обновление повторит попытку.
    ...(transportMissing ? { transportAuto: false } : {}),
    counts: {
      currentPrices: fscsr.machines.length + fscsr.materials.length,
      splitPrices: prices.length,
      splitIndexed: indexed,
      wages: wages.anchors.length + wages.machinists.length + wages.specialists.length,
      workerRanks: wages.anchors.length,
      machinistRanks: wages.machinists.length,
      specialists: wages.specialists.length,
      splitRows: splitCoverage.total,
      splitAllPrices: allWriter.count,
      splitAllBytes: allBytes,
      ...auto.counts,
      ...(wageFactor === null ? {} : { machinistWageFactor: Math.round(wageFactor.factor * 10000) / 10000 }),
    },
    sources,
    notes,
  };
  writeFileSync(resolve(out, "zone.json"), `${JSON.stringify(zoneDocument, null, 2)}\n`, "utf8");

  const maxRss = process.resourceUsage().maxRSS * 1024;
  sampleRss();
  log(`Готово за ${((Date.now() - started) / 1000).toFixed(1)} с → ${out}`);
  log(`Все цены сплит-формы для аудита: ${String(allWriter.count)} строк, ${(allBytes / 1_048_576).toFixed(1)} МБ`);
  log(`Цен ФСЦСР ${String(zoneDocument.counts.currentPrices)}, сплит-формы ${String(prices.length)} (по индексу ${String(indexed)}), ставок ${String(zoneDocument.counts.wages)}`);
  for (const note of notes) log(`ВНИМАНИЕ: ${note}`);
  log(`Пиковый RSS: ${mb(Math.max(peakRss, maxRss))} (замеры по ходу ${mb(peakRss)}, maxRSS процесса ${mb(maxRss)})`);
  return { zoneDocument, outDir: out, peakRssBytes: Math.max(peakRss, maxRss) };
}

// Запуск из командной строки; при импорте (тесты) сборка не стартует.
if (typeof require !== "undefined" && require.main === module) {
  buildZone(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
