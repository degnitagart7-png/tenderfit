import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import type { EstimatePriceBook } from "@/domain/estimate/calculate";
import {
  createNormSearchIndex,
  type NormSearchIndex,
} from "@/domain/estimate/matchNorms";
import {
  buildOverheadRateMap,
  type NorthZone,
  type OverheadNormative,
} from "@/domain/estimate/overheadNormatives";
import type {
  EstimateSource,
  NormRecord,
  OverheadRate,
  ResourcePrice,
  WageAnchor,
  WageScale,
} from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";

/**
 * Репозиторий локальной базы сметных данных ФСНБ-2022.
 *
 * База — это JSONL, собранный `scripts/fsnb/build-index.ts` из открытых данных
 * ФГИС ЦС в каталог `data/fsnb/index`. Каталог исключён и из `.gitignore`, и из
 * `.vercelignore`: 204 МБ справочных данных не едут в поставку и не хранятся в
 * Supabase. Модуль серверный — он читает файловую систему, и в клиентский
 * бандл попадать не должен.
 *
 * Почему файл, а не база данных. Данные только для чтения, обновляются раз в
 * квартал вместе с выгрузкой ФГИС ЦС и нужны целиком: подбор нормы идёт по
 * инвертированному индексу сразу по всем 56 242 записям пяти книг. Держать их
 * в Postgres значило бы 56 тысяч строк и сетевой обмен на каждый подбор, при
 * том что запросов на изменение не существует вовсе.
 *
 * Цена загрузки, измеренная на собранном индексе: 56 242 нормы читаются и
 * индексируются за 2,0 с, процесс занимает 822 МБ. Поэтому база грузится один
 * раз на процесс и кэшируется; `clearEstimateBaseCache` сбрасывает кэш в тестах.
 *
 * Чтение построчное, через `readline` поверх потока. `readFileSync` держал бы в
 * памяти ещё и строку на 185 МБ рядом с разобранными записями: замер даёт пик
 * 635 МБ против 519 МБ при потоковом чтении.
 *
 * Чего в базе нет, и это видно в каждом расчёте. Индексы пересчёта к текущим
 * ценам, нормативы накладных расходов (приказ 812/пр) и сметной прибыли (приказ
 * 774/пр) Минстрой публикует только письмами в PDF. В индекс они не входят,
 * расчёт принимает их параметрами, а каждая позиция без них получает пробел.
 * Текущие цены ФСЦСР есть только по одной ценовой зоне — Амурская область,
 * 1 зона, 3 квартал 2026: 228 машин из 1 729 и 1 062 материала из 45 847.
 */

/** Каталог индекса по умолчанию. Переопределяется `FSNB_INDEX_DIR`. */
export const DEFAULT_INDEX_DIR = "data/fsnb/index";

/** Команда, которая собирает индекс. Печатается в сообщении об отсутствии базы. */
export const BUILD_COMMAND = "npx tsx scripts/fsnb/build-index.ts";

const BUILD_INFO_FILE = "build-info.json";
const NORMS_FILE = "norms.jsonl";
const BASE_PRICES_FILE = "prices-base.jsonl";
const CURRENT_PRICES_FILE = "prices-current.jsonl";
const WAGES_FILE = "wages.jsonl";
const ZONES_FILE = "zones.jsonl";
const OVERHEAD_RATES_FILE = "overhead-rates.json";
const SPLIT_PRICES_FILE = "prices-split.jsonl";
const SPLIT_META_FILE = "split-form.json";

/** Реквизиты собранной сплит-формы: столько, сколько нужно шапке сметы. */
export interface SplitFormIndexMeta {
  readonly zone: string;
  readonly period: string;
  /** «Письмо Минстроя России от 24.08.2026 № 52419-ИФ/09». */
  readonly indexLetter: string;
  /** Акт субъекта об утверждении оплаты труда. */
  readonly wageAct: string;
  /** Сколько цен приехало и сколько из них получено индексом к группе. */
  readonly prices: number;
  readonly indexed: number;
}

/**
 * Читает реквизиты сплит-формы. Отсутствие файла — рабочее состояние.
 *
 * Поля читаются по одному и с проверкой типа: файл собирается скриптом, но
 * лежит на диске, и молча подставить `undefined` в шапку сметы нельзя — там он
 * напечатается словом.
 */
async function readSplitFormMeta(
  indexDir: string,
): Promise<SplitFormIndexMeta | null> {
  let raw: string;
  try {
    raw = await readFile(resolve(indexDir, SPLIT_META_FILE), "utf8");
  } catch {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  const str = (key: string): string =>
    typeof value[key] === "string" ? value[key] : "";
  const num = (key: string): number =>
    typeof value[key] === "number" ? value[key] : 0;

  return {
    zone: str("zone"),
    period: str("period"),
    indexLetter: str("indexLetter"),
    wageAct: str("wageAct"),
    prices: num("written"),
    indexed: num("indexed"),
  };
}

/** Ценовая зона ФСНБ из `price-zones.csv`. */
export interface PriceZoneRecord {
  readonly subjectCode: string;
  readonly subjectName: string;
  readonly zoneName: string;
  readonly center: string;
  readonly municipalities: string;
}

/** Паспорт собранной базы: что, откуда и какого издания. */
export interface EstimateBaseInfo {
  /** Каталог, из которого прочитан индекс. */
  readonly indexDir: string;
  /** Момент сборки индекса, ISO. */
  readonly builtAt: string;
  /** Уровень цен базы ФСБЦ, «01.01.2022». */
  readonly baseEdition: string;
  readonly region: string;
  readonly priceZone: string;
  /** Период текущих цен ФСЦСР, «3 квартал 2026 г.». */
  readonly period: string;
  /** Реквизиты приказа, утвердившего издание ФСНБ. */
  readonly decree: string;
  readonly counts: {
    readonly norms: number;
    readonly basePrices: number;
    readonly currentPrices: number;
    /**
     * Строк тарифной шкалы в индексе, а не точек в собранной шкале: разряды,
     * пришедшие из двух источников, `buildWageScale` схлопывает. Настоящее число
     * точек — `priceBook.wageScale.anchors.length`.
     */
    readonly wages: number;
    readonly zones: number;
  };
  /**
   * Реквизиты сплит-формы ФГИС ЦС, если она собрана.
   *
   * Держится рядом с информацией о базе, потому что это не деталь расчёта, а
   * реквизиты документа: форма локальной сметы по Приложению 3 требует напечатать
   * в шапке и письмо об индексах, и акт об оплате труда. `null` означает, что
   * сплит-форма не собрана и текущие цены взяты только из выгрузки ФСЦСР.
   */
  readonly splitForm: SplitFormIndexMeta | null;
  /** Замечания сборки: что потеряно, что сохранено как есть и почему. */
  readonly notes: readonly string[];
}

/** Всё, что нужно для расчёта сметы по локальной базе. */
export interface EstimateBase {
  readonly info: EstimateBaseInfo;
  readonly priceBook: EstimatePriceBook;
  readonly searchIndex: NormSearchIndex;
  readonly zones: readonly PriceZoneRecord[];
  /** Откуда взяты числа: наборы открытых данных с адресами и изданием. */
  readonly sources: readonly EstimateSource[];
  /** Сколько миллисекунд заняла загрузка. */
  readonly loadMs: number;
}

/**
 * Индекс не собран, собран не полностью или повреждён.
 *
 * Отдельный тип нужен, чтобы вызывающий код отличал «базы нет, скажи человеку
 * как её собрать» от настоящей ошибки программы и показывал первое как пустое
 * состояние с инструкцией, а не как сбой.
 */
export class EstimateBaseUnavailableError extends Error {
  constructor(
    message: string,
    readonly indexDir: string,
    readonly reason:
      | "MISSING_FILE"
      | "EMPTY_FILE"
      | "BAD_RECORD"
      | "BAD_BUILD_INFO",
  ) {
    super(message);
    this.name = "EstimateBaseUnavailableError";
  }
}

interface LoadOptions {
  /** Каталог индекса. По умолчанию `FSNB_INDEX_DIR` или `data/fsnb/index`. */
  readonly indexDir?: string;
}

/** Каталог индекса: явный параметр важнее переменной окружения. */
export function resolveIndexDir(explicit?: string): string {
  const fromEnv = process.env.FSNB_INDEX_DIR?.trim() ?? "";
  const chosen = explicit?.trim() ?? "";
  const dir =
    chosen.length > 0
      ? chosen
      : fromEnv.length > 0
        ? fromEnv
        : DEFAULT_INDEX_DIR;
  return resolve(dir);
}

/** Читает JSONL построчно и разбирает каждую запись с проверкой формы. */
/**
 * Чтение необязательного файла индекса.
 *
 * Отсутствие файла — рабочее состояние, а не сбой: сплит-форма собирается
 * отдельной командой, и база без неё считает по прежним источникам, честно
 * помечая позиции. Ошибкой было бы прочитать половину файла и промолчать,
 * поэтому битую строку `readJsonl` по-прежнему превращает в отказ.
 */
async function readOptionalJsonl<T>(
  indexDir: string,
  file: string,
  parse: (value: unknown, line: number) => T,
): Promise<T[]> {
  try {
    await access(resolve(indexDir, file));
  } catch {
    return [];
  }
  return readJsonl(indexDir, file, parse);
}

async function readJsonl<T>(
  indexDir: string,
  file: string,
  parse: (value: unknown, line: number) => T,
): Promise<T[]> {
  const path = resolve(indexDir, file);
  // Проверка отдельным вызовом: `createReadStream` не бросает на отсутствующем
  // файле, а выдаёт асинхронное событие, и без этого сообщение свелось бы к
  // «ENOENT» вместо инструкции, как собрать базу.
  try {
    await access(path);
  } catch {
    throw missingFile(path, indexDir);
  }

  const result: T[] = [];
  let lineNumber = 0;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        throw new EstimateBaseUnavailableError(
          `${file}: строка ${lineNumber} не разбирается как JSON: ${describe(error)}. ` +
            `Индекс повреждён — пересоберите его командой ${BUILD_COMMAND}.`,
          indexDir,
          "BAD_RECORD",
        );
      }
      result.push(parse(value, lineNumber));
    }
  } catch (error) {
    if (error instanceof EstimateBaseUnavailableError) throw error;
    throw new EstimateBaseUnavailableError(
      `${file} в ${indexDir} не дочитан: ${describe(error)}. Соберите индекс заново командой ${BUILD_COMMAND}.`,
      indexDir,
      "MISSING_FILE",
    );
  }

  if (result.length === 0) {
    throw new EstimateBaseUnavailableError(
      `${file} пуст: в индексе нет ни одной записи. Пересоберите его командой ${BUILD_COMMAND}.`,
      indexDir,
      "EMPTY_FILE",
    );
  }
  return result;
}

function missingFile(
  path: string,
  indexDir: string,
): EstimateBaseUnavailableError {
  return new EstimateBaseUnavailableError(
    `Файл базы сметных данных не найден: ${path}. Локальная база ФСНБ-2022 собирается ` +
      `из открытых данных ФГИС ЦС командой ${BUILD_COMMAND} и в поставку не входит.`,
    indexDir,
    "MISSING_FILE",
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function badRecord(
  file: string,
  line: number,
  why: string,
  indexDir: string,
): EstimateBaseUnavailableError {
  return new EstimateBaseUnavailableError(
    `${file}: строка ${line} — ${why}. Индекс не соответствует домену, пересоберите его командой ${BUILD_COMMAND}.`,
    indexDir,
    "BAD_RECORD",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Число, null или undefined, когда в записи что-то другое.
 *
 * `undefined` здесь — признак испорченной записи, а не «нет значения»: null в
 * цене ресурса законен (у материала нет машинистов), а вот строка или NaN на его
 * месте означают, что индекс собран не тем скриптом.
 */
function optionalNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

const PRICE_SOURCES = [
  "CURRENT_ZONE",
  "BASE_2022",
  "BASE_2022_INDEXED",
  "WAGE_SCALE",
] as const satisfies readonly ResourcePrice["source"][];

function isPriceSource(value: string): value is ResourcePrice["source"] {
  return (PRICE_SOURCES as readonly string[]).includes(value);
}

function toResourcePrice(
  value: unknown,
  file: string,
  line: number,
  indexDir: string,
): ResourcePrice {
  if (!isRecord(value))
    throw badRecord(file, line, "запись не объект", indexDir);
  const code = text(value.code);
  if (code.length === 0)
    throw badRecord(file, line, "нет кода ресурса", indexDir);

  const price = value.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
    throw badRecord(
      file,
      line,
      `цена ресурса ${code} не неотрицательное число`,
      indexDir,
    );
  }
  const source = text(value.source);
  if (!isPriceSource(source)) {
    throw badRecord(
      file,
      line,
      `неизвестный источник цены «${source}» у ${code}`,
      indexDir,
    );
  }

  const machinistSalary = optionalNumber(value.machinistSalary);
  if (machinistSalary === undefined) {
    throw badRecord(
      file,
      line,
      `оплата труда машинистов у ${code} не число и не null`,
      indexDir,
    );
  }
  const machinistHours = optionalNumber(value.machinistHours);
  if (machinistHours === undefined) {
    throw badRecord(
      file,
      line,
      `трудозатраты машинистов у ${code} не число и не null`,
      indexDir,
    );
  }

  const period = value.period === null ? "" : text(value.period);
  const zone = value.zone === null ? "" : text(value.zone);
  return {
    code,
    name: text(value.name),
    unit: text(value.unit),
    price,
    machinistSalary,
    machinistHours,
    source,
    period: period.length === 0 ? null : period,
    zone: zone.length === 0 ? null : zone,
  };
}

/**
 * Норма из индекса.
 *
 * Проверены только те поля, без которых запись нельзя ни найти, ни рассчитать:
 * код, книга и список ресурсов. Полная валидация 56 242 записей и 547 052 строк
 * ресурсов стоила бы секунд на каждой загрузке, а форму задаёт один и тот же
 * скрипт сборки, чьи счётчики записаны в `build-info.json`. Всё прочее читается
 * как есть: домен сам помечает пробелом то, чего не понял.
 */
function toNormRecord(
  value: unknown,
  file: string,
  line: number,
  indexDir: string,
): NormRecord {
  if (!isRecord(value))
    throw badRecord(file, line, "запись не объект", indexDir);
  const code = text(value.code);
  if (code.length === 0)
    throw badRecord(file, line, "нет кода нормы", indexDir);
  const baseType = text(value.baseType);
  if (baseType.length === 0) {
    throw badRecord(
      file,
      line,
      `у нормы ${code} нет книги: код однозначен только вместе с книгой`,
      indexDir,
    );
  }
  if (!Array.isArray(value.resources)) {
    throw badRecord(
      file,
      line,
      `у нормы ${baseType} ${code} нет списка ресурсов`,
      indexDir,
    );
  }
  if (typeof value.fullName !== "string") {
    throw badRecord(
      file,
      line,
      `у нормы ${baseType} ${code} наименование не строка`,
      indexDir,
    );
  }
  return value as unknown as NormRecord;
}

function toWageAnchor(
  value: unknown,
  file: string,
  line: number,
  indexDir: string,
): WageAnchor {
  if (!isRecord(value))
    throw badRecord(file, line, "запись не объект", indexDir);
  const rank = value.rank;
  const salary = value.salary;
  if (typeof rank !== "number" || !Number.isFinite(rank) || rank <= 0) {
    throw badRecord(file, line, "разряд не положительное число", indexDir);
  }
  if (typeof salary !== "number" || !Number.isFinite(salary) || salary <= 0) {
    throw badRecord(
      file,
      line,
      `ставка разряда ${rank} не положительное число`,
      indexDir,
    );
  }
  return { rank, salary, source: text(value.source) };
}

function toZoneRecord(
  value: unknown,
  file: string,
  line: number,
  indexDir: string,
): PriceZoneRecord {
  if (!isRecord(value))
    throw badRecord(file, line, "запись не объект", indexDir);
  const zoneName = text(value.zoneName);
  if (zoneName.length === 0)
    throw badRecord(file, line, "нет названия ценовой зоны", indexDir);
  return {
    subjectCode: text(value.subjectCode),
    subjectName: text(value.subjectName),
    zoneName,
    center: text(value.center),
    municipalities: text(value.municipalities),
  };
}

/** Цены ресурса по коду. Повтор кода — ошибка сборки, а не повод выбрать один. */
function toPriceMap(
  records: readonly ResourcePrice[],
  file: string,
  indexDir: string,
): ReadonlyMap<string, ResourcePrice> {
  const map = new Map<string, ResourcePrice>();
  records.forEach((record, position) => {
    if (map.has(record.code)) {
      throw badRecord(
        file,
        position + 1,
        `код ${record.code} встречается второй раз: цена обязана быть одна, иначе расчёт выберет её произвольно`,
        indexDir,
      );
    }
    map.set(record.code, record);
  });
  return map;
}

/**
 * Справочник нормативов НР и СП, собранный из приказов 812/пр и 774/пр.
 *
 * Файла может не быть: приказы публикуются в PDF, справочник собирается
 * отдельной командой, и база без него остаётся рабочей — расчёт тогда берёт
 * резерв документа и помечает позиции. Поэтому отсутствие файла не ошибка, а
 * пустая карта; ошибкой было бы прочитать его наполовину и промолчать.
 *
 * Зона районирования Крайнего Севера берётся из паспорта сборки, если она там
 * указана, и иначе считается обычной территорией. Для северной стройки её нужно
 * задать: разница между колонками приказа доходит до пяти процентных пунктов к
 * фонду оплаты труда, и молчаливый выбор первой колонки занизил бы смету.
 */
async function readOverheadRates(
  indexDir: string,
  zone: NorthZone,
): Promise<ReadonlyMap<string, OverheadRate>> {
  const path = resolve(indexDir, OVERHEAD_RATES_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return new Map();
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new EstimateBaseUnavailableError(
      `${OVERHEAD_RATES_FILE} в ${indexDir} не читается как JSON: ${describe(error)}`,
      indexDir,
      "BAD_RECORD",
    );
  }

  if (typeof value !== "object" || value === null) {
    throw new EstimateBaseUnavailableError(
      `${OVERHEAD_RATES_FILE} в ${indexDir} должен быть объектом с полями overhead и profit.`,
      indexDir,
      "BAD_RECORD",
    );
  }

  const file = value as {
    overhead?: readonly OverheadNormative[];
    profit?: readonly OverheadNormative[];
  };

  /*
    Указатели НР и СП не пересекаются — «Пр/812-…» против «Пр/774-…», — поэтому
    оба приказа живут в одной карте, как и обещает тип ценовой книги.
  */
  return new Map([
    ...buildOverheadRateMap(file.overhead ?? [], "OVERHEAD", zone),
    ...buildOverheadRateMap(file.profit ?? [], "PROFIT", zone),
  ]);
}

/** Паспорт сборки. Без него нельзя сказать, какого издания база и за какой период цены. */
async function readBuildInfo(indexDir: string): Promise<BuildInfoFile> {
  const path = resolve(indexDir, BUILD_INFO_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new EstimateBaseUnavailableError(
      `${BUILD_INFO_FILE} не найден в ${indexDir}: без паспорта сборки неизвестны издание базы, ` +
        `ценовая зона и период цен. Соберите индекс командой ${BUILD_COMMAND}. ` +
        `Причина: ${describe(error)}`,
      indexDir,
      "MISSING_FILE",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new EstimateBaseUnavailableError(
      `${BUILD_INFO_FILE} не разбирается как JSON: ${describe(error)}`,
      indexDir,
      "BAD_BUILD_INFO",
    );
  }
  if (!isRecord(value)) {
    throw new EstimateBaseUnavailableError(
      `${BUILD_INFO_FILE}: ожидался объект`,
      indexDir,
      "BAD_BUILD_INFO",
    );
  }

  const zone = text(value.zone);
  const period = text(value.period);
  if (zone.length === 0 || period.length === 0) {
    throw new EstimateBaseUnavailableError(
      `${BUILD_INFO_FILE}: не заполнены ценовая зона или период. Без них неизвестно, ` +
        `к каким именно ценам относится расчёт. Пересоберите индекс командой ${BUILD_COMMAND}.`,
      indexDir,
      "BAD_BUILD_INFO",
    );
  }

  const outputs = isRecord(value.outputs) ? value.outputs : {};
  return {
    builtAt: text(value.builtAt),
    baseEdition: text(value.baseEdition),
    region: text(value.region),
    zone,
    period,
    decree: text(value.decree),
    notes: Array.isArray(value.notes)
      ? value.notes.map((note) => text(note)).filter((n) => n.length > 0)
      : [],
    outputs,
  };
}

interface BuildInfoFile {
  readonly builtAt: string;
  readonly baseEdition: string;
  readonly region: string;
  readonly zone: string;
  readonly period: string;
  readonly decree: string;
  readonly notes: readonly string[];
  readonly outputs: Record<string, unknown>;
  /**
   * Зона районирования Крайнего Севера для нормативов НР.
   *
   * Необязательное поле: у обычной территории его просто нет. Это не то же
   * самое, что ценовая зона `zone` — ту задаёт субъект для цен ресурсов, а эта
   * выбирает колонку в приложении к приказу 812/пр.
   */
  readonly northZone?: string;
}

/** Зона из паспорта сборки; неизвестное значение считается обычной территорией. */
function northZone(info: BuildInfoFile): NorthZone {
  const raw = (info.northZone ?? "").trim().toUpperCase();
  if (raw === "RKS" || raw === "MPRKS") return raw;
  return "TERRITORY";
}

function linesOf(outputs: Record<string, unknown>, file: string): number {
  const entry = outputs[file];
  if (!isRecord(entry)) return 0;
  const lines = entry.lines;
  return typeof lines === "number" && Number.isFinite(lines) ? lines : 0;
}

/**
 * Откуда взяты числа. Адреса — те, что реально отдали файлы: набор открытых
 * данных ФГИС ЦС и реестр ставок оплаты труда рабочих.
 */
export function buildEstimateSources(
  info: EstimateBaseInfo,
): readonly EstimateSource[] {
  const decree = info.decree.length > 0 ? info.decree : "ФСНБ-2022";
  return [
    {
      title:
        "ФСНБ-2022: нормы ГЭСН и сметные цены ФСБЦ, открытые данные ФГИС ЦС",
      url: "https://fgiscs.minstroyrf.ru/opendata",
      edition: `${decree}, уровень цен ${info.baseEdition}`,
    },
    {
      title: `Текущие сметные цены ФСЦСР, ${info.priceZone}, ${info.period}`,
      url: "https://fgiscs.minstroyrf.ru/prices",
      edition: info.period,
    },
    {
      title: `Реестр ставок оплаты труда рабочих, ${info.priceZone}, ${info.period}`,
      url: "https://fgiscs.minstroyrf.ru/api/EstimatedPrice/RimWorkerSalaryRegistry",
      edition: info.period,
    },
    {
      title:
        "Владелец наборов открытых данных — ФАУ «Главгосэкспертиза России»",
      url: "https://fgiscs.minstroyrf.ru/api/OpenData/7707082071-fsnb",
      edition:
        "Условия использования набора разрешают коммерческое применение со ссылкой на первоисточник",
    },
  ];
}

/**
 * Тарифная шкала зоны. Пустая шкала — ошибка, а не нулевая оплата труда.
 *
 * Возвращает и число прочитанных строк, и число точек в шкале: они разные.
 * `buildWageScale` схлопывает разряды, пришедшие из двух источников, поэтому в
 * индексе 35 строк, а в шкале 33 точки — разряды 2,0 и 3,0 есть и в реестре
 * ставок рабочих, и в колонке оплаты труда машинистов, и значения совпадают до
 * копейки. Считать эти числа одним значило бы потерять доказательство согласия
 * источников.
 */
async function loadWageScale(
  indexDir: string,
  meta: {
    readonly region: string;
    readonly zone: string;
    readonly period: string;
  },
): Promise<{ readonly scale: WageScale; readonly rows: number }> {
  const rows = await readJsonl(indexDir, WAGES_FILE, (value, line) =>
    toWageAnchor(value, WAGES_FILE, line, indexDir),
  );
  const scale = buildWageScale(rows, meta);
  if (scale.anchors.length === 0) {
    throw new EstimateBaseUnavailableError(
      `${WAGES_FILE}: ни одной пригодной опорной точки. Без тарифной шкалы оплата труда ` +
        `обнулилась бы молча, а это десятки процентов стоимости работ.`,
      indexDir,
      "EMPTY_FILE",
    );
  }
  return { scale, rows: rows.length };
}

const cache = new Map<string, Promise<EstimateBase>>();

/**
 * Загружает базу целиком: паспорт, цены, тарифную шкалу, индекс норм и зоны.
 *
 * Один вызов на процесс — результат кэшируется по каталогу, потому что
 * загрузка стоит 2 с и 822 МБ.
 */
export async function loadEstimateBase(
  options: LoadOptions = {},
): Promise<EstimateBase> {
  const indexDir = resolveIndexDir(options.indexDir);
  const cached = cache.get(indexDir);
  if (cached !== undefined) return cached;

  const loading = readEstimateBase(indexDir);
  cache.set(indexDir, loading);
  try {
    return await loading;
  } catch (error) {
    // Отказ не кэшируется: иначе одна неудачная попытка навсегда оставит
    // процесс без базы, даже если индекс собрали сразу после.
    cache.delete(indexDir);
    throw error;
  }
}

/** Сбрасывает кэш загруженных баз. Нужен тестам и повторной сборке индекса. */
export function clearEstimateBaseCache(): void {
  cache.clear();
}

async function readEstimateBase(indexDir: string): Promise<EstimateBase> {
  const started = Date.now();
  const buildInfo = await readBuildInfo(indexDir);

  const meta = {
    region: buildInfo.region,
    zone: buildInfo.zone,
    period: buildInfo.period,
  };

  const [basePrices, currentPrices, wages, norms, zones] = await Promise.all([
    readJsonl(indexDir, BASE_PRICES_FILE, (value, line) =>
      toResourcePrice(value, BASE_PRICES_FILE, line, indexDir),
    ),
    readJsonl(indexDir, CURRENT_PRICES_FILE, (value, line) =>
      toResourcePrice(value, CURRENT_PRICES_FILE, line, indexDir),
    ),
    loadWageScale(indexDir, meta),
    readJsonl(indexDir, NORMS_FILE, (value, line) =>
      toNormRecord(value, NORMS_FILE, line, indexDir),
    ),
    readJsonl(indexDir, ZONES_FILE, (value, line) =>
      toZoneRecord(value, ZONES_FILE, line, indexDir),
    ),
  ]);

  const overheadRates = await readOverheadRates(indexDir, northZone(buildInfo));

  /*
    Текущие цены из сплит-формы ФГИС ЦС, если она собрана.

    Порядок наложения важен: сплит-форма кладётся первой, выгрузка ФСЦСР —
    поверх. Сплит-форма шире на два порядка (281 441 цена против 2 800), но у
    машин она не публикует оплату труда звена, и наш разбор выводит её
    пропорцией. Там, где ФСЦСР даёт эту составляющую измеренной, она и должна
    остаться: производная величина не вытесняет опубликованную.
  */
  const splitForm = await readSplitFormMeta(indexDir);
  const splitPrices = await readOptionalJsonl(
    indexDir,
    SPLIT_PRICES_FILE,
    (value, line) => toResourcePrice(value, SPLIT_PRICES_FILE, line, indexDir),
  );
  const current = new Map(toPriceMap(splitPrices, SPLIT_PRICES_FILE, indexDir));
  for (const [code, price] of toPriceMap(
    currentPrices,
    CURRENT_PRICES_FILE,
    indexDir,
  )) {
    current.set(code, price);
  }

  const priceBook: EstimatePriceBook = {
    region: meta.region,
    priceZone: meta.zone,
    period: meta.period,
    baseEdition: buildInfo.baseEdition,
    current,
    base: toPriceMap(basePrices, BASE_PRICES_FILE, indexDir),
    wageScale: wages.scale,
    /*
      Нормативы НР и СП по видам работ из приказов 812/пр и 774/пр. Карта может
      остаться пустой, если справочник ещё не собран: тогда расчёт возьмёт
      резерв документа и пометит каждую позицию NO_OVERHEAD_RATE — смета,
      посчитанная без привязки к виду работ, видна сразу и не притворяется
      посчитанной по приказам.
    */
    overheadRates,
  };

  const counts = {
    norms: norms.length,
    basePrices: basePrices.length,
    currentPrices: currentPrices.length,
    wages: wages.rows,
    zones: zones.length,
  };
  checkAgainstBuildInfo(indexDir, buildInfo, counts);

  const info: EstimateBaseInfo = {
    indexDir,
    builtAt: buildInfo.builtAt,
    baseEdition: buildInfo.baseEdition,
    region: meta.region,
    priceZone: meta.zone,
    period: meta.period,
    decree: buildInfo.decree,
    counts,
    splitForm,
    notes: buildInfo.notes,
  };

  return {
    info,
    priceBook,
    searchIndex: createNormSearchIndex(norms),
    zones,
    sources: buildEstimateSources(info),
    loadMs: Date.now() - started,
  };
}

/**
 * Сверяет прочитанное с паспортом сборки.
 *
 * Сборщик умеет пересобирать часть файлов (`--only norms`), и тогда в каталоге
 * лежат нормы одного издания и цены другого. Смета по такой базе посчитается и
 * не покажет ошибки, поэтому расхождение считается отказом, а не особенностью.
 */
function checkAgainstBuildInfo(
  indexDir: string,
  buildInfo: BuildInfoFile,
  counts: EstimateBaseInfo["counts"],
): void {
  const expected: ReadonlyArray<readonly [string, number, number]> = [
    [NORMS_FILE, linesOf(buildInfo.outputs, NORMS_FILE), counts.norms],
    [
      BASE_PRICES_FILE,
      linesOf(buildInfo.outputs, BASE_PRICES_FILE),
      counts.basePrices,
    ],
    [
      CURRENT_PRICES_FILE,
      linesOf(buildInfo.outputs, CURRENT_PRICES_FILE),
      counts.currentPrices,
    ],
    [WAGES_FILE, linesOf(buildInfo.outputs, WAGES_FILE), counts.wages],
    [ZONES_FILE, linesOf(buildInfo.outputs, ZONES_FILE), counts.zones],
  ];

  const mismatched = expected
    .filter(([, passport, actual]) => passport > 0 && passport !== actual)
    .map(
      ([file, passport, actual]) =>
        `${file}: в паспорте ${passport}, прочитано ${actual}`,
    );

  if (mismatched.length > 0) {
    throw new EstimateBaseUnavailableError(
      `Индекс в ${indexDir} собран не целиком — ${mismatched.join("; ")}. ` +
        `Пересоберите его одним прогоном: ${BUILD_COMMAND}.`,
      indexDir,
      "BAD_BUILD_INFO",
    );
  }
}

/**
 * Проверяет, что каталоги сборки на месте, не читая их.
 *
 * Нужно экрану, который показывает состояние базы: «собрана тогда-то, столько-то
 * записей» против «не собрана, вот команда». Читать для этого 185 МБ нельзя.
 */
export async function describeEstimateBase(options: LoadOptions = {}): Promise<
  | { readonly state: "READY"; readonly info: EstimateBaseInfo }
  | {
      readonly state: "UNAVAILABLE";
      readonly reason: string;
      readonly indexDir: string;
      readonly command: string;
    }
> {
  const indexDir = resolveIndexDir(options.indexDir);
  try {
    const buildInfo = await readBuildInfo(indexDir);
    const splitForm = await readSplitFormMeta(indexDir);
    return {
      state: "READY",
      info: {
        splitForm,
        indexDir,
        builtAt: buildInfo.builtAt,
        baseEdition: buildInfo.baseEdition,
        region: buildInfo.region,
        priceZone: buildInfo.zone,
        period: buildInfo.period,
        decree: buildInfo.decree,
        counts: {
          norms: linesOf(buildInfo.outputs, NORMS_FILE),
          basePrices: linesOf(buildInfo.outputs, BASE_PRICES_FILE),
          currentPrices: linesOf(buildInfo.outputs, CURRENT_PRICES_FILE),
          wages: linesOf(buildInfo.outputs, WAGES_FILE),
          zones: linesOf(buildInfo.outputs, ZONES_FILE),
        },
        notes: buildInfo.notes,
      },
    };
  } catch (error) {
    return {
      state: "UNAVAILABLE",
      reason: describe(error),
      indexDir,
      command: BUILD_COMMAND,
    };
  }
}

/**
 * Текущие цены есть только для одной ценовой зоны, и это надо говорить прямо.
 *
 * Возвращает причину одной фразой: по правилам продукта отфильтрованное или
 * неполное не должно исчезать молча.
 */
export function currentPriceCoverageNote(info: EstimateBaseInfo): string {
  const { currentPrices, basePrices } = info.counts;
  const split = info.splitForm;

  if (split === null) {
    return (
      `Текущие цены ФСЦСР за ${info.period} есть только по зоне «${info.priceZone}»: ` +
      `${currentPrices} позиций. Остальные ${basePrices} считаются по базе ФСБЦ на ${info.baseEdition} ` +
      `и пересчитываются индексом Минстроя, которого в открытых данных нет — каждая такая позиция помечается.`
    );
  }

  /*
    Со сплит-формой картина другая, и говорить надо её, а не прежнюю. Цена в ней
    либо измерена по зоне, либо получена индексом к группе однородных ресурсов —
    второе тоже текущий уровень, но другой природы, и число таких цен названо.
  */
  const measured = split.prices - split.indexed;
  return (
    `Текущие цены по зоне «${split.zone}» за ${split.period}: ${measured} сметных цен ` +
    `и ${split.indexed} пересчитанных индексом к группе однородных ресурсов, ` +
    `сплит-форма ФГИС ЦС (${split.indexLetter}). Выгрузка ФСЦСР добавляет ${currentPrices} ` +
    `позиций с оплатой труда машинистов. Ресурс, которого нет ни там, ни там, считается ` +
    `по базе ФСБЦ на ${info.baseEdition} и помечается.`
  );
}
