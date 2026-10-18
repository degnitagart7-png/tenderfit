import path from "node:path";

import type {
  Attribution,
  BenchmarkRow,
  CrossAggregate,
  DeltaBucket,
  LsrComparison,
  MachinistBasis,
  TenderComparison,
  TenderRow,
} from "../src/domain/estimate/benchmark";
import { aggregateTenders, DELTA_BUCKETS } from "../src/domain/estimate/benchmark";
import type { CustomerLsr } from "../src/domain/estimate/customerLsr";
import type { BuiltZoneRef, ZoneChoiceInput } from "../src/services/estimateZone";
import type { EstimateGapKind, EstimateMethod } from "../src/domain/estimate/types";
import type { PriceZoneRecord } from "../src/domain/estimate/priceZoneResolve";

/**
 * Чистые помощники `scripts/estimate-benchmark.ts`: разбор аргументов, отбор документов и зоны как у воркера,
 * шапка ЛСР заказчика, статус закупки и сводный отчёт `summary.md`. Без диска, сети и базы: всё, что можно
 * проверить без них, проверяется тестами (`estimate-benchmark.lib.test.ts`); скрипт только читает базу и пишет файлы.
 */

/* ------------------------------ Аргументы ------------------------------ */

export const DEFAULT_OUT_DIR = "/var/tmp/estimate-benchmark";
/** Куда пишет режим `--blind`: отдельный каталог, чтобы не смешать с обычным прогоном. */
export const BLIND_OUT_DIR = "/var/tmp/estimate-benchmark-blind";
/** Куда пишет режим `--estimate-only` (закупки без сметы заказчика): свой каталог, чтобы не смешать с остальными прогонами. */
export const E2E_OUT_DIR = "/var/tmp/estimate-benchmark-e2e";

export interface CliArgs {
  /** Закупки, заданные явно (`--tender` можно повторять). Пусто — кандидатов ищет сам скрипт. */
  readonly tenders: readonly string[];
  /** Сколько закупок обработать самое большее; null — все найденные. */
  readonly limit: number | null;
  readonly out: string;
  /** Локальная выгрузка документов одной закупки `[{filename, parsed_text}]` вместо базы. */
  readonly fromJson: string | null;
  /** Ценовая зона ФГИС ЦС; нужна с `--from-json`, иначе её определяет закупка. */
  readonly zone: number | null;
  /** `auto` — как у воркера (метод по документам заказчика), `resource` — только ресурсно-индексный. */
  readonly method: "auto" | "resource";
  /** Режим «вслепую»: смета заказчика вырезана из входа, объёмы читает настоящая модель, эталон — вырезанная смета. */
  readonly blind: boolean;
  /** Только с `--blind`: вырезать сметы и показать, что осталось, но модель не звать и не считать. */
  readonly dryRun: boolean;
  /** Режим «только расчёт» для закупок без сметы заказчика: тот же конвейер, что у воркера, без вырезания смет и без эталона. */
  readonly estimateOnly: boolean;
  readonly help: boolean;
}

export const HELP_TEXT = [
  "Бенчмарк точности сметы: наш расчёт против локальных смет заказчиков (ЛСР формы 421/пр). Только чтение.",
  "",
  "  npx tsx scripts/estimate-benchmark.ts [--tender <id>]... [--limit N] [--out <dir>] [--from-json <file> --zone <id>]",
  "  npx tsx scripts/estimate-benchmark.ts --blind --tender <id> [--tender <id>]... [--out <dir>] [--dry-run]",
  "  npx tsx scripts/estimate-benchmark.ts --estimate-only --tender <id> [--tender <id>]... [--out <dir>]",
  "",
  "  --tender <id>      закупка (uuid или реестровый номер); можно повторять; без неё закупки ищутся по базе",
  "  --limit N          обработать не больше N закупок",
  `  --out <dir>        куда писать <закупка>.json и summary.md (по умолчанию ${DEFAULT_OUT_DIR})`,
  "  --from-json <file> документы одной закупки из файла [{filename, parsed_text}] вместо базы; нужен --zone",
  "  --zone <id>        ценовая зона ФГИС ЦС (с --from-json обязательна; без неё зону выбирает закупка)",
  "  --method auto|resource  auto — как у воркера (по умолчанию); resource — только ресурсно-индексный метод",
  "  --blind            расчёт «вслепую»: смета заказчика вырезана из входа, объёмы читает НАСТОЯЩАЯ модель (через прод, токены тратятся),",
  "                     эталон — вырезанная смета. Нужны явные --tender; поиска закупок нет. Скрипт ничего не пишет в базу, но прод по",
  "                     /api/estimate/bill-rows записывает расход модели в llm_usage_log (job_id «bench-blind:<номер>»). По умолчанию --out " + BLIND_OUT_DIR,
  "  --dry-run          с --blind: вырезать сметы и показать остаток, не зовя модель и не считая",
  "  --estimate-only    закупки БЕЗ сметы заказчика (эталона нет): тот же конвейер, что у воркера (настоящий извлекатель ведомости через прод, подбор норм, работы",
  "                     по технологии, мусор; зона — как выбрал бы воркер, включая регион из документов), без вырезания смет. Отчёт: источник объёмов, токены, строки",
  "                     по источнику цены, пробелы, итог с НДС, НМЦК и отношение к ней, главные строки по рублям, добавленные расчётом строки. Нужны явные --tender;",
  "                     токены тратятся (расход пишется в llm_usage_log с job_id «bench-e2e:<номер>»). По умолчанию --out " + E2E_OUT_DIR,
  "  -h, --help         эта справка",
].join("\n");

function positiveInteger(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw) || Number.parseInt(raw, 10) <= 0) {
    throw new Error(`${flag} требует целое число больше нуля`);
  }
  return Number.parseInt(raw, 10);
}

/** Разбор командной строки; ошибка — исключение с понятным текстом, скрипт печатает его и завершается. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const tenders: string[] = [];
  let limit: number | null = null;
  let out: string | null = null;
  let fromJson: string | null = null;
  let zone: number | null = null;
  let method: CliArgs["method"] = "auto";
  let blind = false;
  let dryRun = false;
  let estimateOnly = false;
  let help = false;

  const value = (flag: string, index: number): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} требует значение`);
    return next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--tender": {
        const id = value(arg, i).trim();
        if (id === "") throw new Error("--tender требует непустой идентификатор");
        if (!tenders.includes(id)) tenders.push(id);
        i += 1;
        break;
      }
      case "--limit":
        limit = positiveInteger(arg, argv[i + 1]);
        i += 1;
        break;
      case "--out":
        out = value(arg, i);
        i += 1;
        break;
      case "--from-json":
        fromJson = value(arg, i);
        i += 1;
        break;
      case "--zone":
        zone = positiveInteger(arg, argv[i + 1]);
        i += 1;
        break;
      case "--method": {
        const raw = value(arg, i);
        if (raw !== "auto" && raw !== "resource") throw new Error("--method принимает auto или resource");
        method = raw;
        i += 1;
        break;
      }
      case "--blind":
        blind = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--estimate-only":
        estimateOnly = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }

  if (fromJson !== null && zone === null && !help) throw new Error("--from-json требует --zone: у выгрузки нет закупки, по которой зону можно определить");
  if (fromJson !== null && tenders.length > 1) throw new Error("--from-json читает документы одной закупки: --tender можно указать не больше одного раза");
  if (!help) {
    if (dryRun && !blind) throw new Error("--dry-run работает только с --blind");
    if (blind && tenders.length === 0) throw new Error("--blind требует явные закупки: --tender <id> (поиска закупок в этом режиме нет, модель стоит денег)");
    if (blind && fromJson !== null) throw new Error("--blind читает документы из базы: с --from-json не сочетается");
    if (blind && limit !== null) throw new Error("--limit в режиме --blind не нужен: закупки заданы явно");
    if (estimateOnly && blind) throw new Error("--estimate-only и --blind не сочетаются: --blind вырезает смету заказчика и сверяется с ней, --estimate-only считает закупки без неё");
    if (estimateOnly && tenders.length === 0) throw new Error("--estimate-only требует явные закупки: --tender <id> (поиска закупок в этом режиме нет, модель стоит денег)");
    if (estimateOnly && fromJson !== null) throw new Error("--estimate-only читает документы из базы: с --from-json не сочетается");
    if (estimateOnly && limit !== null) throw new Error("--limit в режиме --estimate-only не нужен: закупки заданы явно");
  }
  return { tenders, limit, out: out ?? (blind ? BLIND_OUT_DIR : estimateOnly ? E2E_OUT_DIR : DEFAULT_OUT_DIR), fromJson, zone, method, blind, dryRun, estimateOnly, help };
}

/* ------------------------------ Отбор закупок и документов ------------------------------ */

/** Признак ЛСР в тексте документа. */
export const LSR_MARKER = "локальный сметный расч";
/** Второй признак: форма 421/пр или расценки ФСНБ. */
export const LSR_SECOND_MARKERS: readonly string[] = ["421/пр", "ФСБЦ", "ГЭСН"];

/** Шаблон ilike первого признака (регистр не важен). */
export const LSR_ILIKE = `%${LSR_MARKER}%`;

/** Условие PostgREST `.or(...)` для второго признака: любой из маркеров, регистр не важен. */
export function candidateOrFilter(): string {
  return LSR_SECOND_MARKERS.map((marker) => `parsed_text.ilike.*${marker}*`).join(",");
}

/** То же условие в коде: для проверки текста, уже загруженного из файла или базы. */
export function looksLikeLsrText(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes(LSR_MARKER) && LSR_SECOND_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

export interface DocumentRowLike {
  readonly filename: string;
  readonly parsed_text: string | null;
  readonly raw_json?: unknown;
}

/**
 * Документы закупки для расчёта — как в `runEstimateJob` воркера: строки с непустым текстом, имя — заголовок из
 * `raw_json.title`, иначе имя файла.
 */
export function documentsOfRows(rows: readonly DocumentRowLike[]): { name: string; text: string }[] {
  return rows
    .filter((row) => (row.parsed_text ?? "").length > 0)
    .map((row) => ({
      name: (row.raw_json as { title?: string } | null | undefined)?.title ?? row.filename,
      text: row.parsed_text ?? "",
    }));
}

export interface TenderRowLike {
  readonly region: string | null;
  readonly delivery_address: string | null;
  readonly customer_name: string | null;
  readonly reg_number?: string | null;
}

/** Место объекта для расчёта — как `place` в `runEstimateJob`. */
export function placeOfTender(tender: TenderRowLike | null): { region: string | null; address: string | null; customerName: string | null } | undefined {
  return tender === null ? undefined : { region: tender.region, address: tender.delivery_address, customerName: tender.customer_name };
}

/** Вход выбора зоны — как `zoneInput` в `runEstimateJob`: без справочника ФГИС ЦС, зона не на диске — отказ. */
export function buildZoneInput(input: {
  readonly userPriceZoneId: number | null;
  readonly tender: TenderRowLike | null;
  readonly zones: readonly PriceZoneRecord[];
  readonly built: readonly BuiltZoneRef[];
  /** Зона из шапок смет заказчика (`extractDeclaredPriceLevel`) — как `declared` в `runEstimateJob`. */
  readonly declared?: ZoneChoiceInput["declared"];
  /** Зона по ставкам труда в смете заказчика (`fingerprintZoneByCustomerPrices`) — как `fingerprint` в `runEstimateJob`. */
  readonly fingerprint?: ZoneChoiceInput["fingerprint"];
}): ZoneChoiceInput {
  return {
    userPriceZoneId: input.userPriceZoneId,
    declared: input.declared ?? null,
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
    tender: input.tender === null ? null : { region: input.tender.region, address: input.tender.delivery_address, customerName: input.tender.customer_name },
    zones: input.zones,
    built: input.built.map(({ priceZoneId, zoneName, subject }) => ({ priceZoneId, zoneName, subject })),
  };
}

/** Имя файла результата: только безопасные знаки (идентификатор закупки приходит из базы или аргументов). */
export function safeFileName(id: string): string {
  const clean = id.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/, "");
  return clean === "" ? "tender" : clean.slice(0, 100);
}

/* ------------------------------ Шапка ЛСР заказчика ------------------------------ */

/** Что заказчик написал о себе в шапке сметы. Нет строки — null. */
export interface LsrHeader {
  /** «Наименование субъекта Российской Федерации»: «Республика Бурятия» (номер перед названием снят). */
  readonly subject: string | null;
  /** «Наименование зоны субъекта …»: «Республика Бурятия (5 зона)». */
  readonly zone: string | null;
  /** «Составлен ресурсно-индексным методом»: «ресурсно-индексным». */
  readonly method: string | null;
  /** Базы расценок, упомянутые в строках о сметных нормативах: «ТСН-2001», «ГЭСН». */
  readonly base: string | null;
  /** «Наименование редакции сметных нормативов» (первые 160 знаков). */
  readonly edition: string | null;
  /** «Наименование программного продукта»: «ГРАНД-Смета, версия 2026.2». */
  readonly program: string | null;
}

const EMPTY_HEADER: LsrHeader = { subject: null, zone: null, method: null, base: null, edition: null, program: null };

/**
 * Сколько знаков листа после его метки читается как шапка. Строки выгрузки xlsx кончаются сотней пустых ячеек, и до
 * «Наименования субъекта» на живой смете лежит около десяти тысяч знаков (закупка 0302300048726001118).
 */
const HEADER_SPAN = 60_000;
const EDITION_LIMIT = 160;

/** Ячейки строки: CSV с кавычками или таблица Word с табуляцией. */
export function splitCells(line: string): string[] {
  const delimiter = line.includes("\t") ? "\t" : ",";
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.replace(/\s+/g, " ").trim());
}

/** Значение после подписи: остаток той же ячейки или первая непустая ячейка правее. */
function valueAfter(cells: readonly string[], label: RegExp): string | null {
  const index = cells.findIndex((cell) => label.test(cell));
  if (index < 0) return null;
  const inline = (cells[index] as string).replace(label, "").replace(/^[\s:–—-]+/, "").trim();
  if (inline !== "") return inline;
  for (let j = index + 1; j < cells.length; j += 1) if ((cells[j] as string) !== "") return cells[j] as string;
  return null;
}

/** Базы расценок как отдельные слова: «ТЕР» внутри «МИНИСТЕРСТВА» базой не считается. */
const BASE_MARKS = /(?<![А-ЯЁа-яёA-Za-z])(ТСН-?\s?\d{4}|ТСН|ТЕРр?-?\s?\d{0,4}|ФЕРр?-?\s?\d{4}|ФЕР|ГЭСН[а-я]*|ФСНБ-?\s?\d{4}|ФССЦ)(?![А-ЯЁа-яёA-Za-z])/g;

/** Лист ЛСР внутри текста документа: от метки «=== лист ===» до следующей метки, не длиннее `HEADER_SPAN`. */
function sheetSegment(text: string, sheet: string | null): string {
  let start = 0;
  if (sheet !== null && sheet !== "") {
    const found = text.indexOf(`=== ${sheet} ===`);
    if (found >= 0) start = found;
  }
  const next = text.indexOf("\n=== ", start + 5);
  const end = next < 0 ? text.length : next;
  return text.slice(start, Math.min(end, start + HEADER_SPAN));
}

/**
 * Шапка ЛСР заказчика: субъект, зона, метод, база расценок, редакция нормативов и программа. Читает текст листа
 * регулярными выражениями по подписям; чего в тексте нет — null. `sheet` — имя листа (`CustomerLsr.estimateName`):
 * в документе с несколькими сметами по нему берётся нужный лист; не найден — начало документа.
 */
export function extractLsrHeader(text: string, sheet: string | null = null): LsrHeader {
  const segment = sheetSegment(text, sheet);
  let subject: string | null = null;
  let zone: string | null = null;
  let method: string | null = null;
  let edition: string | null = null;
  let program: string | null = null;
  const bases: string[] = [];

  for (const line of segment.split("\n")) {
    if (line.trim() === "") continue;
    const cells = splitCells(line);
    if (subject === null) {
      const found = valueAfter(cells, /Наименование\s+субъекта\s+Российской\s+Федерации/i);
      if (found !== null) subject = found.replace(/^\d{1,2}\.\s*/, "");
    }
    if (zone === null) zone = valueAfter(cells, /Наименование\s+зоны(?:\s+субъекта\s+Российской\s+Федерации)?/i);
    if (program === null) program = valueAfter(cells, /Наименование\s+программного\s+продукта/i);
    if (edition === null) {
      const found = valueAfter(cells, /Наименование\s+редакции\s+сметных\s+нормативов/i);
      if (found !== null) edition = found.length > EDITION_LIMIT ? `${found.slice(0, EDITION_LIMIT - 1)}…` : found;
    }
    const joined = cells.filter((cell) => cell !== "").join(" ");
    if (method === null) {
      const found = /Составлен[а]?\s+(.+?)\s+методом/i.exec(joined);
      if (found?.[1] !== undefined) method = found[1].trim();
    }
    if (/норматив/i.test(joined)) {
      for (const mark of joined.matchAll(BASE_MARKS)) {
        const clean = (mark[1] as string).replace(/\s+/g, "");
        if (!bases.includes(clean)) bases.push(clean);
      }
    }
  }

  return { ...EMPTY_HEADER, subject, zone, method, base: bases.length === 0 ? null : bases.join(", "), edition, program };
}

/** Уровень цен, объявленный сметой: «II кв. 2026 (01.04.2026)», «01.04.2026» или null. */
export function formatPriceLevel(estimate: Pick<CustomerLsr, "priceDate" | "priceQuarter">): string | null {
  const quarter = estimate.priceQuarter;
  const roman = quarter === null ? null : (["", "I", "II", "III", "IV"][quarter.quarter] ?? String(quarter.quarter));
  if (quarter !== null && estimate.priceDate !== null) return `${roman as string} кв. ${String(quarter.year)} (${estimate.priceDate})`;
  if (quarter !== null) return `${roman as string} кв. ${String(quarter.year)}`;
  return estimate.priceDate;
}

/* ------------------------------ Статус закупки ------------------------------ */

export type TenderStatus = "OK" | "PRICE_LEVEL" | "NO_ZONE" | "MODEL_NEEDED" | "NO_LSR" | "ERROR";

/**
 * Статус по итогам расчёта. `MODEL_NEEDED` — модель в боевом прогоне была бы нужна: заглушка вызывалась (в документах
 * есть текст, который читает модель) или объёмы расчёта взяты не из ЛСР (ведомость модели перебила бы смету).
 */
export function statusOfRun(input: { readonly modelCalls: number; readonly volumeLevel: string | null }): "OK" | "MODEL_NEEDED" {
  return input.modelCalls > 0 || input.volumeLevel !== "CUSTOMER_ESTIMATE" ? "MODEL_NEEDED" : "OK";
}

/**
 * Сравнение закупки осмысленно, когда объёмы расчёта взяты из ЛСР: тогда наши строки — это строки сметы заказчика.
 * Если ведомость модели перебила бы смету, наши строки были бы чужими, и сравнивать их позиция в позицию нельзя.
 */
export function isComparable(report: Pick<TenderReport, "status" | "volumeLevel" | "comparison">): boolean {
  return (report.status === "OK" || report.status === "MODEL_NEEDED") && report.volumeLevel === "CUSTOMER_ESTIMATE" && report.comparison !== null;
}

/* ------------------------------ Результат по закупке ------------------------------ */

export interface LsrDeclared {
  readonly index: number;
  readonly number: string | null;
  readonly title: string | null;
  readonly documentName: string;
  readonly header: LsrHeader;
  /** Уровень цен, объявленный сметой (дата и квартал). */
  readonly priceLevel: string | null;
  /** Зона и квартал уровня цен, разобранные из текста сметы. */
  readonly declaredZone: number | null;
  readonly declaredQuarter: string | null;
}

export interface TenderReport {
  readonly tenderId: string;
  readonly regNumber: string | null;
  readonly status: TenderStatus;
  readonly message: string | null;
  /** Зона, в которой считали. */
  readonly zone: { readonly priceZoneId: number; readonly zoneName: string; readonly basis: string; readonly matched: string | null } | null;
  /** Метод, которым посчитан документ, и откуда выбран. */
  readonly method: EstimateMethod | null;
  readonly period: string | null;
  readonly documents: number;
  /** Сколько раз заглушка модели была вызвана и по каким документам. */
  readonly modelCalls: number;
  readonly modelDocuments: readonly string[];
  readonly volumeLevel: string | null;
  readonly declared: readonly LsrDeclared[];
  /**
   * Пометки расчёта «смета заказчика составлена в другой зоне или квартале» (`PRICE_LEVEL_DIFFERS`): цены заказчика
   * и наши несопоставимы, и Δ% нельзя читать как ошибку расчёта целиком.
   */
  readonly priceLevelNotes: readonly string[];
  /** Пояснения выбора зоны (зона из сметы заказчика не использована и почему). */
  readonly zoneNotes: readonly string[];
  /** Пробелы документа по видам: сколько позиций с каждым. */
  readonly gapCounts: Readonly<Partial<Record<EstimateGapKind, number>>>;
  readonly comparison: TenderComparison | null;
  readonly durationMs: number;
}

/* ------------------------------ Сводный отчёт ------------------------------ */

const NUMBER = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INTEGER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

export const fmtRub = (value: number | null | undefined): string => (value === null || value === undefined ? "—" : NUMBER.format(value));
export const fmtInt = (value: number): string => INTEGER.format(value);
export const fmtPercent = (value: number | null | undefined): string => (value === null || value === undefined ? "—" : `${NUMBER.format(value)} %`);

/** Ячейка markdown-таблицы: без вертикальных черт и переносов. */
export function cell(text: string | number | null | undefined): string {
  if (text === null || text === undefined || text === "") return "—";
  return String(text).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

export function table(header: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string[] {
  if (rows.length === 0) return ["_нет данных_", ""];
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`), ""];
}

const unique = (values: readonly (string | null)[]): string => [...new Set(values.filter((value): value is string => value !== null && value !== ""))].join("; ");

const BUCKET_LABELS: Readonly<Record<DeltaBucket, string>> = {
  LT_1: "|Δ| < 1 %",
  FROM_1_TO_5: "1–5 %",
  FROM_5_TO_20: "5–20 %",
  GE_20: "≥ 20 %",
  ONLY_CUSTOMER: "только у заказчика (у нас нет строки)",
  ONLY_OURS: "только у нас (у заказчика нет позиции)",
  NO_TOTAL: "у заказчика нет итога позиции",
};

const STATUS_LABELS: Readonly<Record<TenderStatus, string>> = {
  OK: "расчёт без модели",
  PRICE_LEVEL: "уровень цен документа не совпал с нашим",
  NO_ZONE: "зона не определена или не собрана",
  MODEL_NEEDED: "в боевом прогоне зовётся модель",
  NO_LSR: "ЛСР не распознана",
  ERROR: "ошибка",
};

/** Строки перекрёстной таблицы: что следует из арифметики сметы заказчика. */
const DECLARED_LABELS: Readonly<Record<MachinistBasis | "NOT_APPLICABLE" | "UNDETERMINED", string>> = {
  INCLUDES_OTM: "ЭМ включает ОТм",
  EXCLUDES_OTM: "ЭМ без ОТм (ОТм прибавлена сверх)",
  NOT_APPLICABLE: "ОТм у заказчика нет: различать нечего",
  UNDETERMINED: "арифметика сметы не определила",
};

/** Столбцы перекрёстной таблицы: с какой нашей цифрой сошлась графа «ЭМ» заказчика. */
const MATCHED_LABELS: Readonly<Record<MachinistBasis | "BOTH" | "NONE" | "NOT_APPLICABLE", string>> = {
  INCLUDES_OTM: "= наш machineCost (с ОТм)",
  EXCLUDES_OTM: "= machineCost − машинисты (без ОТм)",
  BOTH: "обе цифры",
  NONE: "ни одна",
  NOT_APPLICABLE: "ОТм нет ни у кого",
};

function attributionRows(attribution: Attribution, customerTotal: number | null): (string | null)[][] {
  const share = (value: number): string => (customerTotal === null || customerTotal === 0 ? "—" : fmtPercent((value / customerTotal) * 100));
  const entries: [string, number][] = [
    ["Оплата труда рабочих (ОТ)", attribution.labour],
    ["Эксплуатация машин без ОТм (ЭМ)", attribution.machines],
    ["Оплата труда машинистов (ОТм)", attribution.machinist],
    ["Материалы (М)", attribution.materials],
    ["Накладные расходы (НР)", attribution.overhead],
    ["Сметная прибыль (СП)", attribution.profit],
    ["Остальное по позициям с обеих сторон (невидимый остаток, цены без разбивки, округление)", attribution.other],
    ["Позиции только с одной стороны", attribution.unmatched],
  ];
  return [...entries.map(([name, value]) => [name, fmtRub(value), share(value)]), ["**Итого Σ(наши − заказчика)**", `**${fmtRub(attribution.total)}**`, share(attribution.total)]];
}

function componentsOf(row: BenchmarkRow): { customer: (number | null)[]; ours: (number | null)[] } {
  const c = row.customer;
  const o = row.ours;
  return {
    customer: c === null ? [] : [c.labour, c.machines, c.machinistLabour, c.materials, c.direct, c.overheadAmount, c.profitAmount, c.total],
    ours: o === null ? [] : [o.labour, o.machinesInclMachinist, o.machinistPay, o.materials, o.direct, o.overheadAmount, o.profitAmount, o.total],
  };
}

function flagsOf(row: BenchmarkRow): string {
  const flags: string[] = [];
  const ours = row.ours;
  if (row.bucket === "ONLY_CUSTOMER") flags.push(row.skipped === null ? "нет строки у нас" : `не в ведомости: ${row.skipped.reason}`);
  if (row.bucket === "ONLY_OURS") flags.push("нет позиции у заказчика");
  if (ours !== null) {
    if (ours.flags.priceSource !== null) flags.push(`цена: ${ours.flags.priceSource}`);
    if (ours.flags.residualHidden) flags.push(`невидимый остаток ${fmtRub(ours.residual)}`);
    if (ours.flags.deduction) flags.push("исключение");
    if (ours.flags.gapKinds.length > 0) flags.push(`пробелы: ${ours.flags.gapKinds.join(", ")}`);
    if (ours.flags.coefficients !== null) flags.push(`коэф.: ${ours.flags.coefficients}`);
  }
  if (row.machines !== null && row.machines.matched !== "NOT_APPLICABLE") flags.push(`ЭМ: ${row.machines.matched}`);
  if (row.overheadRate?.mismatch === true) flags.push(`НР ${fmtRub(row.overheadRate.customerPercent)}→${fmtRub(row.overheadRate.ourPercent)} %`);
  if (row.profitRate?.mismatch === true) flags.push(`СП ${fmtRub(row.profitRate.customerPercent)}→${fmtRub(row.profitRate.ourPercent)} %`);
  return flags.join("; ");
}

function topTable(top: readonly TenderRow[]): string[] {
  const header = ["Закупка", "ЛСР", "Поз.", "Шифр", "Наименование", "Ед.", "Объём", "Кто", "ОТ", "ЭМ", "ОТм", "М", "Прямые", "НР", "СП", "Всего", "Δ, ₽", "Δ, %", "Пометки"];
  const rows: (string | number | null)[][] = [];
  for (const row of top) {
    const { customer, ours } = componentsOf(row);
    rows.push([
      row.tenderId,
      row.lsrNumber ?? row.lsrIndex,
      row.label,
      row.code,
      row.name,
      row.unit,
      row.quantity === null ? null : fmtRub(row.quantity),
      "заказчик",
      ...(customer.length === 0 ? Array.from({ length: 8 }, () => "—") : customer.map((value) => fmtRub(value))),
      fmtRub(row.delta?.total),
      fmtPercent(row.delta?.totalPercent),
      flagsOf(row),
    ]);
    rows.push(["", "", "", "", "", "", "", "мы", ...(ours.length === 0 ? Array.from({ length: 8 }, () => "—") : ours.map((value) => fmtRub(value))), "", "", ""]);
  }
  return table(header, rows);
}

export interface SummaryMeta {
  readonly generatedAt: string;
  readonly source: string;
  readonly topN: number;
}

/** `summary.md`: таблица закупок, сводка по составляющим, корзины, расхождения НР и СП, главные позиции. */
export function formatSummary(reports: readonly TenderReport[], meta: SummaryMeta): { readonly text: string; readonly aggregate: CrossAggregate } {
  const comparable = reports.filter(isComparable);
  const aggregate = aggregateTenders(
    comparable.map((report) => ({ tenderId: report.tenderId, comparison: report.comparison as TenderComparison })),
    { topN: meta.topN },
  );

  const statusCounts = new Map<TenderStatus, number>();
  for (const report of reports) statusCounts.set(report.status, (statusCounts.get(report.status) ?? 0) + 1);

  const out: string[] = ["# Бенчмарк точности сметы: наш расчёт против ЛСР заказчиков", ""];
  out.push(`Сформирован ${meta.generatedAt}. Источник документов: ${meta.source}. Только чтение: база и файлы закупок не изменялись.`, "");
  out.push(
    "Что сравнивается. Объёмы и шифры берутся из самой ЛСР заказчика (кодом, модель не нужна), поэтому разница итога — ошибка расчёта: цены, нормы, начисления, коэффициенты. " +
      "Сравнение «заказчик — мы» идёт по позициям; итоги — без НДС. Модель в бенчмарке заменена пустой заглушкой: закупки, где она в боевом прогоне была бы нужна, помечены `MODEL_NEEDED`.",
    "",
  );

  out.push("## Закупки по статусам", "");
  out.push(
    ...table(
      ["Статус", "Закупок", "Что значит"],
      (Object.keys(STATUS_LABELS) as TenderStatus[]).filter((status) => statusCounts.has(status)).map((status) => [status, statusCounts.get(status), STATUS_LABELS[status]]),
    ),
  );
  out.push(
    `В сводку входят закупки, где объёмы расчёта взяты из ЛСР (статус \`OK\` или \`MODEL_NEEDED\` из-за чтения других документов): **${fmtInt(comparable.length)}** из ${fmtInt(reports.length)}.`,
    "",
  );

  out.push("## Закупки", "");
  out.push(
    ...table(
      ["Закупка", "Статус", "Наша зона", "Метод", "Заказчик: субъект / зона", "Заказчик: уровень цен", "Заказчик: метод", "Заказчик: база", "ЛСР", "Итог заказчика без НДС, ₽", "Наш итог до НДС, ₽", "Δ, %", "Уровень цен", "Вызовов модели"],
      reports.map((report) => {
        const aggregateOfTender = report.comparison?.aggregate ?? null;
        return [
          report.regNumber !== null && report.regNumber !== report.tenderId ? `${report.tenderId} (${report.regNumber})` : report.tenderId,
          report.message === null ? report.status : `${report.status}: ${report.message}`,
          report.zone === null ? null : `${report.zone.zoneName} (${String(report.zone.priceZoneId)})`,
          report.method === null ? null : report.method === "BASE_INDEX" ? "БИМ" : "РИМ",
          unique(report.declared.map((item) => [item.header.subject, item.header.zone].filter((part) => part !== null).join(" / "))),
          unique(report.declared.map((item) => item.priceLevel)),
          unique(report.declared.map((item) => item.header.method)),
          unique(report.declared.map((item) => item.header.base ?? item.header.program)),
          report.declared.length,
          fmtRub(aggregateOfTender?.customerTotalExVat),
          aggregateOfTender === null ? null : fmtRub(aggregateOfTender.document.beforeVat),
          fmtPercent(aggregateOfTender?.deltaPercent),
          report.priceLevelNotes.length === 0 ? null : `расходится: ${report.priceLevelNotes[0]}${report.priceLevelNotes.length > 1 ? ` (+${String(report.priceLevelNotes.length - 1)})` : ""}`,
          report.modelCalls,
        ];
      }),
    ),
  );

  const lsrRows: (string | number | null)[][] = [];
  for (const report of comparable) {
    for (const lsr of (report.comparison as TenderComparison).lsrs) lsrRows.push(lsrRow(report.tenderId, lsr));
  }
  out.push("## Сметы (ЛСР)", "");
  out.push(...table(["Закупка", "ЛСР", "Название", "Итог заказчика без НДС, ₽", "Сумма позиций заказчика, ₽", "Наш итог, ₽", "Δ к итогу, %", "Δ к позициям, %", "Позиций", "Нашлись у нас", "Только у заказчика", "Только у нас"], lsrRows));

  out.push("## Итого по всем закупкам из сводки", "");
  out.push(
    `Закупок: ${fmtInt(aggregate.tenders)}, смет: ${fmtInt(aggregate.lsrs)}, позиций заказчика: ${fmtInt(aggregate.counts.customer)} ` +
      `(нашлись у нас ${fmtInt(aggregate.counts.matched)}, только у заказчика ${fmtInt(aggregate.counts.onlyCustomer)}, из них вне ведомости ${fmtInt(aggregate.counts.skipped)}; ` +
      `только у нас ${fmtInt(aggregate.counts.onlyOurs)}; посчитано по цене, а не по норме ${fmtInt(aggregate.counts.priced)}).`,
    "",
  );
  out.push(
    `Итог заказчика без НДС: ${fmtRub(aggregate.customerTotalExVat)} ₽${aggregate.customerTotalIncomplete ? " (у части смет итога нет, сумма неполная)" : ""}; наш итог до НДС: ${fmtRub(aggregate.documentBeforeVat)} ₽; ` +
      `**Δ ${fmtPercent(aggregate.deltaPercent)}**. По строкам: заказчик ${fmtRub(aggregate.customerPositionsTotal)} ₽, мы ${fmtRub(aggregate.oursRowsTotal)} ₽, Δ ${fmtPercent(aggregate.rowsDeltaPercent)}.`,
    "",
  );

  // Цены в разных уровнях (зона, квартал) несопоставимы: Δ% закупок с пометкой и без неё читается по-разному.
  const levelGroups: [string, TenderReport[]][] = [
    ["уровень цен сметы заказчика совпадает с нашим или в смете не назван", comparable.filter((report) => report.priceLevelNotes.length === 0)],
    ["смета заказчика составлена в другой зоне или квартале (`PRICE_LEVEL_DIFFERS`)", comparable.filter((report) => report.priceLevelNotes.length > 0)],
  ];
  out.push("### Δ по уровню цен сметы заказчика", "");
  out.push(
    ...table(
      ["Группа", "Закупок", "Итог заказчика без НДС, ₽", "Наш итог до НДС, ₽", "Δ, %"],
      levelGroups
        .filter(([, group]) => group.length > 0)
        .map(([name, group]) => {
          const sub = aggregateTenders(group.map((report) => ({ tenderId: report.tenderId, comparison: report.comparison as TenderComparison })), { topN: 0 });
          return [name, group.length, fmtRub(sub.customerTotalExVat), fmtRub(sub.documentBeforeVat), fmtPercent(sub.deltaPercent)];
        }),
    ),
  );

  out.push("### Из чего складывается разница Σ(наши − заказчика), ₽", "");
  out.push(...table(["Составляющая", "₽", "% от итога заказчика"], attributionRows(aggregate.attribution, aggregate.customerPositionsTotal === 0 ? null : aggregate.customerPositionsTotal)));
  out.push("Доли — от суммы позиций заказчика. НР и СП считаются от ФОТ, поэтому часть их разницы — следствие разницы оплаты труда.", "");

  out.push("### Корзины позиций по |Δ%| итога", "");
  const totalPositions = Object.values(aggregate.buckets).reduce((sum, bucket) => sum + bucket.count, 0);
  out.push(
    ...table(
      ["Корзина", "Позиций", "Доля", "Σ |Δ|, ₽"],
      DELTA_BUCKETS.map((bucket) => {
        const stat = aggregate.buckets[bucket];
        return [BUCKET_LABELS[bucket], fmtInt(stat.count), totalPositions === 0 ? "—" : fmtPercent((stat.count / totalPositions) * 100), fmtRub(stat.absDelta)];
      }),
    ),
  );

  out.push("### ЭМ и ОТм: как заказчик печатает «ЭМ»", "");
  out.push(
    "Считаются обе трактовки. Строки — что следует из арифметики сметы заказчика («прямые затраты = ОТ + ЭМ + М» — ЭМ включает ОТм; «= ОТ + ЭМ + ОТм + М» — не включает); " +
      "столбцы — с каким нашим ЭМ сошлась графа «ЭМ» заказчика: с `machineCost` (включает ОТм) или с `machineCost − машинисты` (без ОТм).",
    "",
  );
  const machinist = aggregate.machinist;
  const matchedKeys = ["INCLUDES_OTM", "EXCLUDES_OTM", "BOTH", "NONE", "NOT_APPLICABLE"] as const;
  const declaredKeys = ["INCLUDES_OTM", "EXCLUDES_OTM", "NOT_APPLICABLE", "UNDETERMINED"] as const;
  out.push(
    ...table(
      ["Арифметика сметы заказчика ↓ / ЭМ заказчика сошёлся с →", ...matchedKeys.map((key) => MATCHED_LABELS[key]), "Всего"],
      declaredKeys.map((declaredKey) => [DECLARED_LABELS[declaredKey], ...matchedKeys.map((matchedKey) => machinist.crossTab[declaredKey][matchedKey]), machinist.declared[declaredKey]]),
    ),
  );
  out.push(
    `Трактовка для разложения рублей взята: по арифметике ${fmtInt(machinist.usedBy.ARITHMETIC)}, по совпадению с нашими цифрами ${fmtInt(machinist.usedBy.MATCH)}, по умолчанию (как в Гранд-Смете, ЭМ с ОТм) ${fmtInt(machinist.usedBy.DEFAULT)} позиций.`,
    "",
  );
  if (machinist.oursWithoutPay.positions > 0) {
    out.push(
      `**Позиций, где ЭМ заказчика без ОТм совпал с нашим \`machineCost\` целиком: ${fmtInt(machinist.oursWithoutPay.positions)}** (ячейка «ЭМ без ОТм» × «= наш machineCost»). ` +
        `У них заказчик прибавляет ОТм к прямым затратам сверх ЭМ, а в наших прямых затратах оплаты машинистов нет: не хватает ${fmtRub(machinist.oursWithoutPay.customerMachinist)} ₽ ОТм. ` +
        "В разложении рублей эта разница записана в ОТм, а не в ЭМ.",
      "",
    );
  }

  out.push("### Расхождения процентов НР и СП", "");
  const rates = aggregate.rateMismatches;
  out.push(`Позиций с расходящимся НР: ${fmtInt(rates.overheadPositions)}, СП: ${fmtInt(rates.profitPositions)}, хотя бы одно из двух: ${fmtInt(rates.eitherPositions)}.`, "");
  out.push(
    ...table(
      ["Шифр", "Начисление", "% заказчика", "% наш", "Позиций", "Σ Δ суммы, ₽"],
      rates.groups.slice(0, 100).map((group) => [group.code, group.kind === "overhead" ? "НР" : "СП", group.customerPercent === null ? "нет" : fmtRub(group.customerPercent), fmtRub(group.ourPercent), group.positions, fmtRub(group.amountDelta)]),
    ),
  );
  if (rates.groups.length > 100) out.push(`Показаны первые 100 из ${fmtInt(rates.groups.length)} пар; полный список — в JSON закупок (поля \`overheadRate\` и \`profitRate\` позиций).`, "");

  out.push(`## Топ-${String(meta.topN)} позиций по |Δ| в рублях`, "");
  out.push(...topTable(aggregate.top));

  const problems = reports.filter((report) => !(report.status === "OK" || report.status === "MODEL_NEEDED"));
  out.push("## Закупки без сравнения", "");
  out.push(...table(["Закупка", "Статус", "Причина"], problems.map((report) => [report.tenderId, report.status, report.message])));
  const notComparable = reports.filter((report) => (report.status === "OK" || report.status === "MODEL_NEEDED") && !isComparable(report));
  if (notComparable.length > 0) {
    out.push("Расчёт выполнен, но объёмы взяты не из ЛСР (ведомость модели перебила бы смету), поэтому в сводку они не вошли:", "");
    out.push(...table(["Закупка", "Уровень источника объёмов"], notComparable.map((report) => [report.tenderId, report.volumeLevel])));
  }

  return { text: `${out.join("\n")}\n`, aggregate };
}

function lsrRow(tenderId: string, lsr: LsrComparison): (string | number | null)[] {
  return [
    tenderId,
    lsr.number ?? lsr.key,
    lsr.title,
    fmtRub(lsr.customerTotalExVat),
    fmtRub(lsr.customerPositionsTotal),
    fmtRub(lsr.oursTotal),
    fmtPercent(lsr.deltaPercentVsTotal),
    fmtPercent(lsr.deltaPercentVsPositions),
    lsr.positions,
    lsr.matched,
    lsr.onlyCustomer,
    lsr.onlyOurs,
  ];
}

/** Путь файла результата закупки. */
export function reportPath(outDir: string, tenderId: string): string {
  return path.join(outDir, `${safeFileName(tenderId)}.json`);
}
