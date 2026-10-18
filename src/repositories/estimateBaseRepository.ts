import { createReadStream } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  parseLoadPriceRecord,
  parseTransportSeriesRecord,
  servicesFromRecords,
  type LoadPrice,
  type TransportSeries,
  type ZoneAutoServices,
} from "@/domain/estimate/autoServices";
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
  SpecialistWage,
  WageAnchor,
  WageScale,
} from "@/domain/estimate/types";
import type { PriceZoneRecord } from "@/domain/estimate/priceZoneResolve";
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
 *
 * Раскладка по ценовым зонам. Общее для всех зон (нормы, базисные цены,
 * нормативы НР и СП, список зон) лежит в корне индекса и грузится один раз.
 * Зональное — текущие цены ФСЦСР, цены сплит-формы, тарифная шкала, реквизиты
 * сплит-формы и паспорт `zone.json` — в `zones/<priceZoneId>/`; собирает его
 * `scripts/fsnb/build-zone.ts`. Если папки `zones/` нет вовсе (старый локальный
 * индекс, тесты), работает прежний режим: зональные файлы читаются из корня как
 * одна зона. Обратная совместимость обязательна: `loadEstimateBase()` без
 * аргументов продолжает работать.
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

/** Ценовая зона ФСНБ из `price-zones.csv` (тип живёт в домене: выбор зоны работает и в браузере). */
export type { PriceZoneRecord };

/** Паспорт собранной базы: что, откуда и какого издания. */
export interface EstimateBaseInfo {
  /** Каталог, из которого прочитан индекс. */
  readonly indexDir: string;
  /**
   * Идентификатор ценовой зоны ФГИС ЦС, чьи цены загружены. Нужен, чтобы дочитать ценовые
   * файлы той же зоны (все цены сплит-формы, перевозка и погрузка). Нет у паспорта, собранного
   * до появления `zones/`, и у баз, сделанных вручную в тестах.
   */
  readonly priceZoneId?: number;
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
  /** Ценовая зона ФГИС ЦС. Нет — зона по умолчанию (282, если собрана) или корень индекса. */
  readonly priceZoneId?: number;
  /** Зона районирования Севера для нормативов НР. Нет — из паспорта сборки или обычная территория. */
  readonly northZone?: NorthZone;
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

/** Запись `wages.jsonl`: рабочий (без поля kind), машинист или специалист. */
type WageRecord =
  | { readonly kind: "WORKER"; readonly anchor: WageAnchor }
  | { readonly kind: "MACHINIST"; readonly anchor: WageAnchor }
  | { readonly kind: "SPECIALIST"; readonly specialist: SpecialistWage };

function toWageRecord(
  value: unknown,
  file: string,
  line: number,
  indexDir: string,
): WageRecord {
  if (!isRecord(value))
    throw badRecord(file, line, "запись не объект", indexDir);
  const salary = value.salary;
  const kind = value.kind === undefined ? "WORKER" : text(value.kind);

  if (kind === "SPECIALIST") {
    const code = text(value.code);
    if (code.length === 0)
      throw badRecord(file, line, "у ставки специалиста нет кода", indexDir);
    if (typeof salary !== "number" || !Number.isFinite(salary) || salary <= 0) {
      throw badRecord(file, line, `ставка специалиста ${code} не положительное число`, indexDir);
    }
    return {
      kind,
      specialist: { code, name: text(value.name), salary, source: text(value.source) },
    };
  }
  if (kind !== "WORKER" && kind !== "MACHINIST") {
    throw badRecord(file, line, `неизвестный вид ставки «${kind}»`, indexDir);
  }

  const rank = value.rank;
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
  return { kind, anchor: { rank, salary, source: text(value.source) } };
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
  zoneSources?: readonly { readonly title: string; readonly url: string }[],
): readonly EstimateSource[] {
  const decree = info.decree.length > 0 ? info.decree : "ФСНБ-2022";
  const fgis: EstimateSource = {
    title: "ФСНБ-2022: нормы ГЭСН и сметные цены ФСБЦ, открытые данные ФГИС ЦС",
    url: "https://fgiscs.minstroyrf.ru/opendata",
    edition: `${decree}, уровень цен ${info.baseEdition}`,
  };
  const owner: EstimateSource = {
    title: "Владелец наборов открытых данных — ФАУ «Главгосэкспертиза России»",
    url: "https://fgiscs.minstroyrf.ru/api/OpenData/7707082071-fsnb",
    edition:
      "Условия использования набора разрешают коммерческое применение со ссылкой на первоисточник",
  };
  // Зона собрана build-zone.ts: источники названы её паспортом, с адресами выгрузок.
  if (zoneSources !== undefined && zoneSources.length > 0) {
    return [
      fgis,
      ...zoneSources.map((source) => ({ title: source.title, url: source.url, edition: info.period })),
      owner,
    ];
  }
  return [
    fgis,
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
    owner,
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
    toWageRecord(value, WAGES_FILE, line, indexDir),
  );
  const scale = buildWageScale(
    rows.flatMap((row) => (row.kind === "WORKER" ? [row.anchor] : [])),
    meta,
    {
      machinists: rows.flatMap((row) => (row.kind === "MACHINIST" ? [row.anchor] : [])),
      specialists: rows.flatMap((row) => (row.kind === "SPECIALIST" ? [row.specialist] : [])),
    },
  );
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

/** Паспорт собранной зоны (`zones/<id>/zone.json`). */
export interface ZoneInfo {
  readonly priceZoneId: number;
  readonly zoneName: string;
  readonly subject: string;
  readonly periodId: number | null;
  readonly period: string;
  readonly builtAt: string;
  /** Письмо Минстроя об индексах, из шапки сплит-формы. */
  readonly indexLetter: string;
  /** Акт субъекта об оплате труда. */
  readonly wageAct: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly sources: readonly { readonly title: string; readonly url: string }[];
}

const ZONES_DIR = "zones";
const ZONE_FILE = "zone.json";
/** Зона, которую берёт `loadEstimateBase()` без аргументов, если она собрана. */
export const DEFAULT_PRICE_ZONE_ID = 282;

/**
 * Идентификаторы зон ФГИС ЦС для индекса, собранного до появления `zones/`: в его
 * паспорте есть только название. Соответствие «Амурская область (1 зона)» → 282
 * установлено по ответу RimWorkerSalaryRegistry и подписи выгрузки ФСЦСР.
 */
const LEGACY_ZONE_IDS: ReadonlyMap<string, number> = new Map([["Амурская область (1 зона)", 282]]);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function toZoneInfo(value: unknown): ZoneInfo | null {
  if (!isRecord(value)) return null;
  const id = value.priceZoneId;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  const zoneName = text(value.zoneName);
  if (zoneName.length === 0) return null;
  const counts: Record<string, number> = {};
  if (isRecord(value.counts)) {
    for (const [key, count] of Object.entries(value.counts)) {
      if (typeof count === "number" && Number.isFinite(count)) counts[key] = count;
    }
  }
  const sources = Array.isArray(value.sources)
    ? value.sources.flatMap((item) =>
        isRecord(item) && text(item.title).length > 0 && text(item.url).length > 0
          ? [{ title: text(item.title), url: text(item.url) }]
          : [],
      )
    : [];
  return {
    priceZoneId: id,
    zoneName,
    subject: text(value.subject),
    periodId: typeof value.periodId === "number" ? value.periodId : null,
    period: text(value.period),
    builtAt: text(value.builtAt),
    indexLetter: text(value.indexLetter),
    wageAct: text(value.wageAct),
    counts,
    sources,
  };
}

async function readBuiltZoneDirs(indexDir: string): Promise<ZoneInfo[]> {
  let names: string[];
  try {
    names = await readdir(resolve(indexDir, ZONES_DIR));
  } catch {
    return [];
  }
  const zones: ZoneInfo[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let raw: string;
    try {
      raw = await readFile(resolve(indexDir, ZONES_DIR, name, ZONE_FILE), "utf8");
    } catch {
      continue; // папка без паспорта — зона не собрана
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const info = toZoneInfo(value);
    // Паспорт обязан называть ту зону, в чьей папке лежит: иначе цены чужой зоны
    // можно принять за эту.
    if (info !== null && info.priceZoneId === Number.parseInt(name, 10)) zones.push(info);
  }
  return zones.sort((a, b) => a.priceZoneId - b.priceZoneId);
}

/** Паспорт зоны прежнего режима: из корневого build-info и реквизитов сплит-формы. */
async function legacyZoneInfo(indexDir: string): Promise<ZoneInfo | null> {
  let buildInfo: BuildInfoFile;
  try {
    buildInfo = await readBuildInfo(indexDir);
  } catch {
    return null;
  }
  const id = LEGACY_ZONE_IDS.get(buildInfo.zone);
  if (id === undefined) return null;
  const split = await readSplitFormMeta(indexDir);
  return {
    priceZoneId: id,
    zoneName: buildInfo.zone,
    subject: buildInfo.region,
    periodId: null,
    period: buildInfo.period,
    builtAt: buildInfo.builtAt,
    indexLetter: split?.indexLetter ?? "",
    wageAct: split?.wageAct ?? "",
    counts: {
      currentPrices: linesOf(buildInfo.outputs, CURRENT_PRICES_FILE),
      splitPrices: split?.prices ?? 0,
      splitIndexed: split?.indexed ?? 0,
      wages: linesOf(buildInfo.outputs, WAGES_FILE),
    },
    sources: [],
  };
}

/**
 * Собранные зоны. Нет папки `zones/` — прежний режим: одна зона из корня индекса
 * (если по её названию известен идентификатор); нет и паспорта — пустой список.
 * Не бросает: список нужен экрану и воркеру, чтобы сказать «собраны такие-то».
 */
export async function listBuiltZones(options: LoadOptions = {}): Promise<ZoneInfo[]> {
  const indexDir = resolveIndexDir(options.indexDir);
  if (await exists(resolve(indexDir, ZONES_DIR))) return readBuiltZoneDirs(indexDir);
  const legacy = await legacyZoneInfo(indexDir);
  return legacy === null ? [] : [legacy];
}

/** Ценовые зоны ФСНБ (`zones.jsonl`) без загрузки норм: нужны выбору зоны и экрану. */
export async function readPriceZoneRecords(options: LoadOptions = {}): Promise<PriceZoneRecord[]> {
  const indexDir = resolveIndexDir(options.indexDir);
  if (!(await exists(resolve(indexDir, ZONES_FILE)))) return [];
  return readJsonl(indexDir, ZONES_FILE, (value, line) =>
    toZoneRecord(value, ZONES_FILE, line, indexDir),
  );
}

/** Какую зону грузить и где лежат её файлы. */
interface ZoneSelection {
  readonly info: ZoneInfo;
  /** Каталог зональных файлов: `zones/<id>` или корень индекса в прежнем режиме. */
  readonly dir: string;
  readonly legacy: boolean;
}

function zoneUnavailable(indexDir: string, id: number, built: readonly ZoneInfo[]): EstimateBaseUnavailableError {
  const have = built.length === 0 ? "ни одной" : built.map((zone) => `${zone.zoneName} (${String(zone.priceZoneId)})`).join(", ");
  return new EstimateBaseUnavailableError(
    `Цен по ценовой зоне ${String(id)} ещё нет. Собраны: ${have}. ` +
      `Соберите зону: npx tsx scripts/fsnb/fetch-zone.ts --zone ${String(id)} && npx tsx scripts/fsnb/build-zone.ts --zone ${String(id)}.`,
    indexDir,
    "MISSING_FILE",
  );
}

async function selectZone(indexDir: string, requested: number | undefined): Promise<ZoneSelection> {
  const hasZonesDir = await exists(resolve(indexDir, ZONES_DIR));
  if (hasZonesDir) {
    const built = await readBuiltZoneDirs(indexDir);
    const wanted =
      requested ?? (built.some((zone) => zone.priceZoneId === DEFAULT_PRICE_ZONE_ID) ? DEFAULT_PRICE_ZONE_ID : undefined);
    if (wanted !== undefined) {
      const info = built.find((zone) => zone.priceZoneId === wanted);
      if (info === undefined) throw zoneUnavailable(indexDir, wanted, built);
      return { info, dir: resolve(indexDir, ZONES_DIR, String(wanted)), legacy: false };
    }
    // Зона по умолчанию не собрана: корневые файлы прежнего режима, если они есть.
    const legacy = await legacyZoneInfo(indexDir);
    if (legacy !== null && (await exists(resolve(indexDir, CURRENT_PRICES_FILE)))) {
      return { info: legacy, dir: indexDir, legacy: true };
    }
    const first = built[0];
    if (first === undefined) throw zoneUnavailable(indexDir, DEFAULT_PRICE_ZONE_ID, built);
    return { info: first, dir: resolve(indexDir, ZONES_DIR, String(first.priceZoneId)), legacy: false };
  }

  // Прежний режим: зональные файлы в корне — одна зона. Без идентификатора её
  // название всё равно нужно паспорту, поэтому информация строится из build-info.
  const buildInfo = await readBuildInfo(indexDir);
  const legacy = await legacyZoneInfo(indexDir);
  if (requested !== undefined && (legacy === null || legacy.priceZoneId !== requested)) {
    throw zoneUnavailable(indexDir, requested, legacy === null ? [] : [legacy]);
  }
  const info: ZoneInfo = legacy ?? {
    priceZoneId: 0,
    zoneName: buildInfo.zone,
    subject: buildInfo.region,
    periodId: null,
    period: buildInfo.period,
    builtAt: buildInfo.builtAt,
    indexLetter: "",
    wageAct: "",
    counts: {},
    sources: [],
  };
  return { info, dir: indexDir, legacy: true };
}

/** Общая часть цен: базисные цены, зоны. Грузится один раз на каталог и не требует норм. */
interface CommonBase {
  readonly buildInfo: BuildInfoFile;
  readonly basePrices: ReadonlyMap<string, ResourcePrice>;
  readonly basePricesCount: number;
  readonly zones: readonly PriceZoneRecord[];
}

/** Нормы и поисковый индекс по ним: 185 МБ, нужны подбору расценок, но не проверке цен. */
interface NormsData {
  readonly normsCount: number;
  readonly searchIndex: NormSearchIndex;
}

const normsCache = new Map<string, Promise<NormsData>>();
const priceBookCache = new Map<string, Promise<EstimatePriceBook>>();

/** Зональная часть: цены зоны и её тарифная шкала. Грузится один раз на зону. */
interface ZoneData {
  readonly selection: ZoneSelection;
  readonly current: ReadonlyMap<string, ResourcePrice>;
  readonly currentPricesCount: number;
  readonly wages: { readonly scale: WageScale; readonly rows: number };
  readonly splitForm: SplitFormIndexMeta | null;
}

const commonCache = new Map<string, Promise<CommonBase>>();
const zoneCache = new Map<string, Promise<ZoneData>>();
const cache = new Map<string, Promise<EstimateBase>>();

/**
 * Отметка сборки зоны — `builtAt` из `zone.json`. Ночное обновление пересобирает зону, пока
 * воркер живёт неделями: ключ кэша с отметкой заставляет прочитать новую сборку, а не отдавать
 * прежнюю до перезапуска. Нет паспорта — пустая отметка, и кэш работает как раньше.
 */
async function zoneStamp(indexDir: string, priceZoneId: number | undefined): Promise<string> {
  const id = priceZoneId ?? DEFAULT_PRICE_ZONE_ID;
  try {
    const value = JSON.parse(await readFile(resolve(indexDir, ZONES_DIR, String(id), ZONE_FILE), "utf8")) as unknown;
    return isRecord(value) && typeof value.builtAt === "string" ? value.builtAt : "";
  } catch {
    return "";
  }
}

function remember<T>(
  store: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  /** Ключи с этим началом — прежние сборки той же зоны: вытесняются новой. */
  supersedes?: string,
): Promise<T> {
  const cached = store.get(key);
  if (cached !== undefined) return cached;
  if (supersedes !== undefined) {
    for (const existing of [...store.keys()]) if (existing.startsWith(supersedes) && existing !== key) store.delete(existing);
  }
  const loading = load();
  store.set(key, loading);
  // Отказ не кэшируется: иначе одна неудачная попытка навсегда оставит
  // процесс без базы, даже если индекс собрали сразу после.
  loading.catch(() => {
    if (store.get(key) === loading) store.delete(key);
  });
  return loading;
}

/**
 * Загружает базу целиком: паспорт, цены, тарифную шкалу, индекс норм и зоны.
 *
 * Результат кэшируется: общая часть — по каталогу, зональная — по зоне, итог — по
 * (каталог, зона, зона Севера). Загрузка общей части стоит 2 с и 822 МБ, зоны —
 * доли секунды и пара мегабайт. Без аргументов — прежнее поведение: зона 282,
 * если она собрана, иначе зональные файлы корня.
 */
export async function loadEstimateBase(
  options: LoadOptions = {},
): Promise<EstimateBase> {
  const indexDir = resolveIndexDir(options.indexDir);
  const zonePart = `${indexDir}|${options.priceZoneId === undefined ? "default" : String(options.priceZoneId)}|${options.northZone ?? "-"}|`;
  const key = `${zonePart}${await zoneStamp(indexDir, options.priceZoneId)}`;
  return remember(cache, key, () => readEstimateBase(indexDir, options), zonePart);
}

/**
 * Поисковый индекс норм без цен и зон — для поиска нормы по шифру и словам.
 *
 * Те же 185 МБ норм, что и у `loadEstimateBase`, и тот же кэш (`normsCache`): процесс держит одну
 * копию, а не по копии на каждый путь. Цены, тарифная шкала и справочник зон поиску не нужны, и
 * читаются они только расчётом. Каталога нет или он собран не целиком — `EstimateBaseUnavailableError`.
 */
export async function loadNormSearchIndex(options: { readonly indexDir?: string } = {}): Promise<NormSearchIndex> {
  const indexDir = resolveIndexDir(options.indexDir);
  const norms = await remember(normsCache, indexDir, () => readNorms(indexDir));
  return norms.searchIndex;
}

/**
 * Ценовая книга зоны. Кэш по (зона, зона Севера): нормативы НР зависят от колонки
 * приказа, а цены ресурсов — нет, поэтому зональные файлы читаются один раз.
 */
export async function loadZonePriceBook(
  priceZoneId: number,
  options: { readonly northZone?: NorthZone; readonly indexDir?: string } = {},
): Promise<EstimatePriceBook> {
  const indexDir = resolveIndexDir(options.indexDir);
  const zonePart = `${indexDir}|${String(priceZoneId)}|${options.northZone ?? "-"}|`;
  const key = `${zonePart}${await zoneStamp(indexDir, priceZoneId)}`;
  // Без норм: проверка цен сметы заказчика не подбирает расценок, и 185 МБ норм ей ни к чему.
  return remember(
    priceBookCache,
    key,
    async () => (await assemblePriceBook(indexDir, { priceZoneId, northZone: options.northZone })).priceBook,
    zonePart,
  );
}

/**
 * Шкала ставок оплаты труда собранной зоны: только `wages.jsonl` (десятки строк), без цен ресурсов и норм. Нужна, чтобы узнать зону
 * по ставкам в смете заказчика (`identifyZoneByWages`). Зоны нет на диске или шкала пуста — `null`, а не ошибка: отпечаток необязателен.
 */
export async function loadZoneWageScale(
  priceZoneId: number,
  options: { readonly indexDir?: string } = {},
): Promise<WageScale | null> {
  const indexDir = resolveIndexDir(options.indexDir);
  try {
    const { dir, info } = await selectZone(indexDir, priceZoneId);
    return (await loadWageScale(dir, { region: info.subject, zone: info.zoneName, period: info.period })).scale;
  } catch {
    return null;
  }
}

/** Цена ресурса из «всех цен сплит-формы»: без наименования, только то, что нужно для сверки. */
export interface AuditPrice {
  /** Текущая цена за единицу, ₽ без НДС. */
  readonly price: number;
  readonly unit: string;
  /** Цена получена индексом к группе однородных ресурсов, а не измерена по зоне. */
  readonly indexed: boolean;
}

const SPLIT_ALL_FILE = "prices-split-all.jsonl";

/** Сколько зон держит кэш цен для аудита: вытесняется давно не запрашивавшаяся. */
export const AUDIT_PRICES_CACHE_ZONES = 3;

const auditPricesCache = new Map<string, Promise<ReadonlyMap<string, AuditPrice> | null>>();

async function readAuditPrices(indexDir: string, priceZoneId: number): Promise<ReadonlyMap<string, AuditPrice> | null> {
  const path = resolve(indexDir, ZONES_DIR, String(priceZoneId), SPLIT_ALL_FILE);
  if (!(await exists(path))) return null;

  const prices = new Map<string, AuditPrice>();
  // Единиц в выгрузке десятки, а строк — сотни тысяч: общие экземпляры строк экономят память.
  const units = new Map<string, string>();
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue; // файл нужен только для сверки: битая строка — это «цены нет», а не отказ аудита
    }
    if (!isRecord(value)) continue;
    const { c, p, u, i } = value;
    if (typeof c !== "string" || typeof p !== "number" || !Number.isFinite(p) || p < 0) continue;
    const unitText = typeof u === "string" ? u : "";
    let unit = units.get(unitText);
    if (unit === undefined) {
      unit = unitText;
      units.set(unitText, unit);
    }
    prices.set(c, { price: p, unit, indexed: i === true });
  }
  return prices;
}

/**
 * Все цены сплит-формы зоны — для аудита сметы заказчика.
 *
 * Основная книга цен зоны (`loadZonePriceBook`) отфильтрована по кодам из норм: расчёту
 * сметы нужны они, а кабель, поставляемый отдельной позицией, в нормах не участвует. Аудит
 * ищет цену сначала в книге, затем здесь. Читается лениво — только когда аудит запущен, —
 * и кэшируется на `AUDIT_PRICES_CACHE_ZONES` зон: зона занимает десятки мегабайт, держать
 * все собранные незачем. Нет файла (зона собрана до появления `prices-split-all.jsonl`) —
 * `null`, и аудит работает как раньше, без этих цен; отказ или отсутствие не кэшируются,
 * чтобы пересобранная зона подхватилась без перезапуска.
 */
export async function loadZoneAuditPrices(
  priceZoneId: number,
  options: { readonly indexDir?: string } = {},
): Promise<ReadonlyMap<string, AuditPrice> | null> {
  const indexDir = resolveIndexDir(options.indexDir);
  const key = `${indexDir}|${String(priceZoneId)}|${await zoneStamp(indexDir, priceZoneId)}`;

  const cached = auditPricesCache.get(key);
  if (cached !== undefined) {
    // Обращение освежает зону: порядок вставки Map и есть очередь вытеснения.
    auditPricesCache.delete(key);
    auditPricesCache.set(key, cached);
    return cached;
  }

  const loading = readAuditPrices(indexDir, priceZoneId);
  auditPricesCache.set(key, loading);
  while (auditPricesCache.size > AUDIT_PRICES_CACHE_ZONES) {
    const oldest = auditPricesCache.keys().next().value;
    if (oldest === undefined) break;
    auditPricesCache.delete(oldest);
  }
  const forget = (): void => {
    if (auditPricesCache.get(key) === loading) auditPricesCache.delete(key);
  };
  loading.then((result) => {
    if (result === null) forget();
  }, forget);
  return loading;
}

const TRANSPORT_AUTO_FILE = "transport-auto.jsonl";
const LOAD_AUTO_FILE = "load-auto.jsonl";

/** Сколько зон держит кэш цен перевозки и погрузки. Файлы небольшие (около 1,2 МБ), но зон до 157. */
export const AUTO_SERVICES_CACHE_ZONES = 3;

const autoServicesCache = new Map<string, Promise<ZoneAutoServices | null>>();

async function readJsonlLines(path: string, onValue: (value: unknown) => void): Promise<void> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.length === 0) continue;
    try {
      onValue(JSON.parse(line) as unknown);
    } catch {
      // Битая строка — «цены нет»: расчёт и аудит без этой цены считают как прежде.
    }
  }
}

async function readAutoServices(indexDir: string, priceZoneId: number): Promise<ZoneAutoServices | null> {
  const dir = resolve(indexDir, ZONES_DIR, String(priceZoneId));
  const transportPath = resolve(dir, TRANSPORT_AUTO_FILE);
  const loadPath = resolve(dir, LOAD_AUTO_FILE);
  const [hasTransport, hasLoad] = await Promise.all([exists(transportPath), exists(loadPath)]);
  if (!hasTransport && !hasLoad) return null;

  const transport: TransportSeries[] = [];
  const load: LoadPrice[] = [];
  if (hasTransport) {
    await readJsonlLines(transportPath, (value) => {
      const series = parseTransportSeriesRecord(value);
      if (series !== null) transport.push(series);
    });
  }
  if (hasLoad) {
    await readJsonlLines(loadPath, (value) => {
      const price = parseLoadPriceRecord(value);
      if (price !== null) load.push(price);
    });
  }
  if (transport.length === 0 && load.length === 0) return null;
  return servicesFromRecords(transport, load);
}

/**
 * Сметные цены перевозки и погрузки зоны (ФГИС ЦС) — `transport-auto.jsonl` и `load-auto.jsonl`.
 *
 * Читается лениво и кэшируется на `AUTO_SERVICES_CACHE_ZONES` зон (вытесняется давно не
 * запрашивавшаяся). Нет файлов (зона собрана до появления таблиц) — `null`: расчёт и аудит работают
 * как раньше, а позиции перевозки и погрузки идут по цене заказчика. Отсутствие не кэшируется, чтобы
 * пересобранная зона подхватывалась без перезапуска; новая сборка зоны (`builtAt`) читается заново.
 */
export async function loadZoneAutoServices(
  priceZoneId: number,
  options: { readonly indexDir?: string } = {},
): Promise<ZoneAutoServices | null> {
  const indexDir = resolveIndexDir(options.indexDir);
  const key = `${indexDir}|${String(priceZoneId)}|${await zoneStamp(indexDir, priceZoneId)}`;

  const cached = autoServicesCache.get(key);
  if (cached !== undefined) {
    autoServicesCache.delete(key);
    autoServicesCache.set(key, cached);
    return cached;
  }
  const loading = readAutoServices(indexDir, priceZoneId);
  autoServicesCache.set(key, loading);
  while (autoServicesCache.size > AUTO_SERVICES_CACHE_ZONES) {
    const oldest = autoServicesCache.keys().next().value;
    if (oldest === undefined) break;
    autoServicesCache.delete(oldest);
  }
  const forget = (): void => {
    if (autoServicesCache.get(key) === loading) autoServicesCache.delete(key);
  };
  loading.then((result) => {
    if (result === null) forget();
  }, forget);
  return loading;
}

/** Сбрасывает кэш загруженных баз. Нужен тестам и повторной сборке индекса. */
export function clearEstimateBaseCache(): void {
  cache.clear();
  commonCache.clear();
  zoneCache.clear();
  normsCache.clear();
  priceBookCache.clear();
  auditPricesCache.clear();
  autoServicesCache.clear();
}

async function readCommonBase(indexDir: string): Promise<CommonBase> {
  const buildInfo = await readBuildInfo(indexDir);
  const [basePrices, zones] = await Promise.all([
    readJsonl(indexDir, BASE_PRICES_FILE, (value, line) =>
      toResourcePrice(value, BASE_PRICES_FILE, line, indexDir),
    ),
    readJsonl(indexDir, ZONES_FILE, (value, line) =>
      toZoneRecord(value, ZONES_FILE, line, indexDir),
    ),
  ]);
  return {
    buildInfo,
    basePrices: toPriceMap(basePrices, BASE_PRICES_FILE, indexDir),
    basePricesCount: basePrices.length,
    zones,
  };
}

async function readNorms(indexDir: string): Promise<NormsData> {
  const norms = await readJsonl(indexDir, NORMS_FILE, (value, line) =>
    toNormRecord(value, NORMS_FILE, line, indexDir),
  );
  return { normsCount: norms.length, searchIndex: createNormSearchIndex(norms) };
}

async function readZoneData(indexDir: string, selection: ZoneSelection): Promise<ZoneData> {
  const { dir, info } = selection;
  const [currentPrices, wages] = await Promise.all([
    readJsonl(dir, CURRENT_PRICES_FILE, (value, line) =>
      toResourcePrice(value, CURRENT_PRICES_FILE, line, indexDir),
    ),
    loadWageScale(dir, { region: info.subject, zone: info.zoneName, period: info.period }),
  ]);

  /*
    Текущие цены из сплит-формы ФГИС ЦС, если она собрана.

    Порядок наложения важен: сплит-форма кладётся первой, выгрузка ФСЦСР —
    поверх. Сплит-форма шире на два порядка (281 441 цена против 2 800), но у
    машин она не публикует оплату труда звена, и наш разбор выводит её
    пропорцией. Там, где ФСЦСР даёт эту составляющую измеренной, она и должна
    остаться: производная величина не вытесняет опубликованную.
  */
  const splitForm = await readSplitFormMeta(dir);
  const splitPrices = await readOptionalJsonl(dir, SPLIT_PRICES_FILE, (value, line) =>
    toResourcePrice(value, SPLIT_PRICES_FILE, line, indexDir),
  );
  const current = new Map(toPriceMap(splitPrices, SPLIT_PRICES_FILE, indexDir));
  for (const [code, price] of toPriceMap(currentPrices, CURRENT_PRICES_FILE, indexDir)) {
    current.set(code, price);
  }
  return { selection, current, currentPricesCount: currentPrices.length, wages, splitForm };
}

/** Общая часть, зона и ценовая книга: всё, что нужно ценам, без норм. */
async function assemblePriceBook(
  indexDir: string,
  options: LoadOptions,
): Promise<{ common: CommonBase; zone: ZoneData; priceBook: EstimatePriceBook }> {
  const common = await remember(commonCache, indexDir, () => readCommonBase(indexDir));
  const selection = await selectZone(indexDir, options.priceZoneId);
  const zonePart = `${indexDir}|${selection.legacy ? "legacy" : String(selection.info.priceZoneId)}|`;
  const zone = await remember(zoneCache, `${zonePart}${selection.info.builtAt}`, () => readZoneData(indexDir, selection), zonePart);
  const { buildInfo } = common;

  const overheadRates = await readOverheadRates(indexDir, options.northZone ?? northZone(buildInfo));

  const priceBook: EstimatePriceBook = {
    region: zone.selection.info.subject,
    priceZone: zone.selection.info.zoneName,
    period: zone.selection.info.period,
    baseEdition: buildInfo.baseEdition,
    current: zone.current,
    base: common.basePrices,
    wageScale: zone.wages.scale,
    /*
      Нормативы НР и СП по видам работ из приказов 812/пр и 774/пр. Карта может
      остаться пустой, если справочник ещё не собран: тогда расчёт возьмёт
      резерв документа и пометит каждую позицию NO_OVERHEAD_RATE — смета,
      посчитанная без привязки к виду работ, видна сразу и не притворяется
      посчитанной по приказам.
    */
    overheadRates,
  };
  return { common, zone, priceBook };
}

async function readEstimateBase(indexDir: string, options: LoadOptions): Promise<EstimateBase> {
  const started = Date.now();
  const { common, zone, priceBook } = await assemblePriceBook(indexDir, options);
  const norms = await remember(normsCache, indexDir, () => readNorms(indexDir));
  const { buildInfo } = common;

  const counts = {
    norms: norms.normsCount,
    basePrices: common.basePricesCount,
    currentPrices: zone.currentPricesCount,
    wages: zone.wages.rows,
    zones: common.zones.length,
  };
  // Паспорт сборки описывает корневые файлы: зональные в зоне проверяются её паспортом.
  checkAgainstBuildInfo(indexDir, buildInfo, counts, zone.selection.legacy);

  const info: EstimateBaseInfo = {
    indexDir,
    ...(zone.selection.legacy || zone.selection.info.priceZoneId <= 0 ? {} : { priceZoneId: zone.selection.info.priceZoneId }),
    builtAt: buildInfo.builtAt,
    baseEdition: buildInfo.baseEdition,
    region: priceBook.region,
    priceZone: priceBook.priceZone,
    period: priceBook.period,
    decree: buildInfo.decree,
    counts,
    splitForm: zone.splitForm,
    notes: buildInfo.notes,
  };

  return {
    info,
    priceBook,
    searchIndex: norms.searchIndex,
    zones: common.zones,
    sources: buildEstimateSources(info, zone.selection.legacy ? undefined : zone.selection.info.sources),
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
  includeZoneFiles: boolean,
): void {
  const expected: ReadonlyArray<readonly [string, number, number]> = [
    [NORMS_FILE, linesOf(buildInfo.outputs, NORMS_FILE), counts.norms],
    [
      BASE_PRICES_FILE,
      linesOf(buildInfo.outputs, BASE_PRICES_FILE),
      counts.basePrices,
    ],
    ...(includeZoneFiles
      ? ([
          [
            CURRENT_PRICES_FILE,
            linesOf(buildInfo.outputs, CURRENT_PRICES_FILE),
            counts.currentPrices,
          ],
          [WAGES_FILE, linesOf(buildInfo.outputs, WAGES_FILE), counts.wages],
        ] as const)
      : []),
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

/**
 * Нормативы НР и СП из приказов 812/пр и 774/пр для зоны Севера — без чтения норм и цен.
 *
 * Нужны методу БИМ (аудит и расчёт по ФЕР-2020): ему не нужна ни книга цен зоны, ни 185 МБ норм ГЭСН, а указатели
 * `Пр/812-…` у расценок ФЕР те же, что у норм ГЭСН. Нет файла — пустая карта, как у основной книги.
 */
export async function loadOverheadRateMap(
  options: { readonly indexDir?: string; readonly northZone?: NorthZone } = {},
): Promise<ReadonlyMap<string, OverheadRate>> {
  return readOverheadRates(resolveIndexDir(options.indexDir), options.northZone ?? "TERRITORY");
}
