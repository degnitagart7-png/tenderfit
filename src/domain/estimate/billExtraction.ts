import { serviceCodeFromText } from "@/domain/estimate/autoServices";
import { referencesLsr } from "@/domain/estimate/contractEstimate";
import { parseNormCodeHint, type NormCodeHint } from "@/domain/estimate/normCodes";
import type {
  BillOfWorkItem,
  CustomerPrice,
  VolumeSourceLevel,
  VolumeVariant,
} from "@/domain/estimate/types";
import {
  confirmQuantity,
  describeQuantityChecks,
  foldWithMap,
  forFind,
  fragmentSpans,
  isHeaderUnitLabel,
  nameOnRow,
  numberVisibleIn,
  recoverUnitFromRows,
  recoverUnitMultiplier,
  rowContextAt,
  type QuantityEvidence,
  type QuoteSpan,
} from "@/domain/estimate/billQuoteMatch";
import {
  deriveUnitDivisor,
  isMoneyUnit,
  isWholeWorkUnit,
  parseUnit,
  parseUnitPair,
  type ParsedUnit,
} from "@/domain/estimate/units";
import {
  numbersOf,
  positionTotalAfter,
  priceFromLine,
} from "@/domain/estimate/customerPrice";
import {
  classifyHeading,
  isNonWorkHeading,
  type HeadingInfo,
} from "@/domain/estimate/volumeSource";

// Единицы живут в `units.ts`; здесь они остаются доступными под прежними именами.
export { deriveUnitDivisor, isMoneyUnit, parseUnit, type ParsedUnit };

/**
 * Превращение строк, найденных моделью в документации, в ведомость объёмов.
 *
 * Зачем домен, а не только промпт. Ведомость — единственное место расчёта, где
 * данные приходят от языковой модели, и от неё зависит каждая цифра сметы:
 * объём умножается на расценку. Модель, которая ошиблась в объёме на порядок,
 * даёт правдоподобную смету с неверным числом, и заметить это в готовом
 * документе нельзя. Поэтому здесь не разбор ответа, а проверка: строка входит в
 * ведомость, только если её удалось подтвердить исходным текстом.
 *
 * Две проверки делают основную работу.
 *
 * Первая: цитата должна дословно найтись в документе. Модель обязана вернуть
 * фрагмент строки ведомости, и если этого фрагмента в тексте нет, значит строки
 * не было — она придумана или собрана из двух разных мест.
 *
 * Вторая: объём должен стоять внутри собственной цитаты модели. Цитату модель
 * способна взять настоящую, а число рядом написать своё — например, повторить
 * объём предыдущей строки. Требование «число видно в цитате» ловит ровно это и
 * стоит одно сравнение.
 *
 * Что здесь НЕ делается: подбор расценки, перевод единиц под норму, счёт денег.
 * Модуль отвечает на один вопрос — что и в каком количестве написано в
 * документации, — и оставляет позицию без кода нормы: её подберёт поиск.
 */

/** Строка, как её вернула модель. Числа приходят и текстом, и числом. */
export interface BillExtractionRow {
  readonly workName: string;
  readonly quantity: string | number;
  readonly unit: string;
  readonly evidenceQuote: string;
  /**
   * Фрагмент, в котором виден объём.
   *
   * Отдельно от цитаты наименования, потому что в разобранном PDF таблица
   * расплющена в строку и колонка объёма отстоит от колонки наименования на
   * сотни знаков: единой цитаты, где видно и то и другое, в тексте просто нет.
   * Требовать её — значит заставлять модель склеивать два куска в один, то
   * есть врать. Пусто — берётся цитата наименования.
   */
  readonly quantityQuote?: string;
  /** Раздел ведомости, если модель его увидела. */
  readonly section?: string;
  /**
   * Обоснование строки, как оно напечатано в документе: «ГЭСН09-03-002-01»,
   * «ФСБЦ-07.2.07.12-0068», «Прайс-лист поставщика».
   *
   * Нужно ради вида позиции: это единственное место, где документ говорит,
   * работа перед нами или поставляемый материал (`resourceCodeFromJustification`).
   * И ради шифра расценки ГЭСН: он читается в `normCodeHint`, сверяется с базой и,
   * если такая норма есть, берётся вместо поиска по наименованию. Шифр в скане
   * искажён («F9CH46-06-909-03») — см. `normCodes.ts`.
   */
  readonly justification?: string;
}

/**
 * Код ресурса ФСНБ, если обоснование строки называет ресурс, а не расценку.
 *
 * Зачем это различие. Ведомость заказчика перечисляет вперемешку работы и
 * поставляемые материалы, и колонка обоснования — единственное место, где
 * документ говорит, что именно перед нами. Материал, принятый за работу,
 * уходит в подбор расценки и приносит оттуда чужие труд и машины: на смете
 * 02-01-02-КМ1 пять таких строк дали 1 000,72 чел.-ч вместо 601,21, а сами
 * материалы выпали из сметы почти целиком — 98 139,39 ₽ вместо 7 232 736,85 ₽.
 *
 * Почему по форме кода, а не по префиксу. Префикс пишут по-разному — «ФСБЦ-»,
 * «ФССЦ-», иногда его нет вовсе, — а форма кода в ФСНБ-2022 устойчива и
 * непересекаема: ресурс записан точками и заканчивается группой из трёх или
 * четырёх цифр («07.2.07.12-0068» — материал, «91.05.01-017» — машина),
 * расценка записана одними дефисами («09-03-002-01»). Опознание по форме
 * переживает смену префикса и не требует списка книг.
 *
 * Код с хвостом «_02-15» («ФСБЦ-02.2.04.03-0013_02-15») — не поставка материала, а
 * перевозка этого материала (класс груза): строка идёт в подбор расценки, а не по
 * цене материала за тонну.
 */
const RESOURCE_CODE_PATTERN =
  /(?<![\d.])(\d{2}\.\d\.\d{2}\.\d{2}-\d{4}|\d{2}\.\d{2}\.\d{2}-\d{3})(?![\d_-])/;

export function resourceCodeFromJustification(
  justification: string | undefined,
): string | null {
  if (justification === undefined) return null;
  const match = RESOURCE_CODE_PATTERN.exec(justification);
  return match?.[1] ?? null;
}

/** Почему строка не вошла в ведомость. Перечень закрытый. */
export type BillRejectionReason =
  /** Пустое наименование работы. */
  | "EMPTY_NAME"
  /** Объём не число, не конечен или не положителен. */
  | "BAD_QUANTITY"
  /** Единица не распознана: считать по ней нельзя. */
  | "UNKNOWN_UNIT"
  /** Единица денежная: это сумма — штраф, цена, лимит, — а не объём работ. */
  | "MONEY_NOT_WORK"
  /** Цитаты наименования нет в тексте документа: строка не подтверждается. */
  | "QUOTE_NOT_FOUND"
  /** Цитата наименования короче порога: доказательством не является. */
  | "QUOTE_TOO_SHORT"
  /** Фрагмента с объёмом нет в тексте документа. */
  | "QUANTITY_QUOTE_NOT_FOUND"
  /** Фрагмент с объёмом короче порога: по нему не отличить строку от соседней. */
  | "QUANTITY_QUOTE_TOO_SHORT"
  /** Наименование и объём стоят в разных местах документа: это разные строки. */
  | "ANCHORS_TOO_FAR"
  /** Объём не встречается в цитате, которую привела сама модель. */
  | "QUANTITY_NOT_IN_QUOTE"
  /** Та же работа с тем же объёмом уже есть. */
  | "DUPLICATE"
  /**
   * Строка из таблицы, которая не перечень работ: потребность в машинах,
   * кадрах, СИЗ, инструменте, график. Берётся по заголовку таблицы.
   */
  | "NOT_WORK"
  /** Объём задан всей работой целиком («1 усл. ед.»): позиции для расценки нет. */
  | "WHOLE_WORK"
  /** OCR продублировал строку позиции: тот же номер и тот же шифр. */
  | "DUPLICATE_POSITION"
  /** Объём есть в источнике выше по приоритету, поэтому из этого не берётся. */
  | "LOWER_SOURCE";

export interface RejectedBillRow {
  readonly reason: BillRejectionReason;
  readonly row: BillExtractionRow;
  /** Человеческое объяснение — печатается в отчёте о разборе. */
  readonly message: string;
  /**
   * Документ, из которого взята строка. Нужен, чтобы возвращённая вручную строка осталась
   * привязана к файлу; нет у расчётов, посчитанных до правки ведомости.
   */
  readonly documentName?: string;
}

export interface BillExtractionResult {
  readonly items: readonly BillOfWorkItem[];
  readonly rejected: readonly RejectedBillRow[];
}

/**
 * Сколько принятых строк прошло по послаблению проверки, а не по буквальному совпадению.
 * Вызывающий передаёт пустой счётчик (`emptyExtractionStats`) в `BillExtractionInput.stats`,
 * `extractBillItems` его пополняет. Нужен, чтобы по отчёту разбора было видно, чем держится
 * принятая ведомость, и чтобы ослабленная проверка не стала незаметной.
 */
export interface BillExtractionStats {
  /** Единица взята из строки документа: модель вернула подпись колонки («ед. изм.»). */
  unitRecovered: number;
  /** Короткий фрагмент объёма подтверждён строкой: наименование и число стоят в одной строке таблицы. */
  rowAnchored: number;
  /** Объём совпал с числом цитаты после пересчёта единиц (кг↔т, «100 м2»↔м2). */
  unitFactor: number;
  /** Объём совпал с суммой или произведением чисел строки («225*3» = 675). */
  arithmetic: number;
  /**
   * Модель потеряла множитель единицы, а в строке он стоит вплотную к объёму («100 м2 | 0,899»): единица позиции заменена на «100 м2»,
   * объём не менялся (`recoverUnitMultiplier`).
   */
  unitMultiplierRecovered: number;
}

export function emptyExtractionStats(): BillExtractionStats {
  return { unitRecovered: 0, rowAnchored: 0, unitFactor: 0, arithmetic: 0, unitMultiplierRecovered: 0 };
}

/** Сколько строк отказано по каждой причине (причины без отказов не перечисляются). */
export function countRejections(
  rejected: readonly { readonly reason: BillRejectionReason }[],
): Partial<Record<BillRejectionReason, number>> {
  const counts: Partial<Record<BillRejectionReason, number>> = {};
  for (const entry of rejected) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  return counts;
}

export interface BillExtractionInput {
  readonly rows: readonly BillExtractionRow[];
  /** Счётчик ослабленных проверок: пополняется по ходу разбора. Не передан — не ведётся. */
  readonly stats?: BillExtractionStats;
  /** Текст документа, из которого модель извлекала строки. */
  readonly sourceText: string;
  /** Имя документа: попадает в позицию и в выгрузку. */
  readonly documentName: string;
  /** Префикс идентификаторов позиций, чтобы они не сталкивались между файлами. */
  readonly idPrefix: string;
  /**
   * Раздел документа по смещению в `sourceText`. Позиция получает раздел по месту
   * своей цитаты в тексте — детерминированно, а не со слов модели: документ режется
   * на фрагменты, и заголовок раздела остаётся в предыдущем. Нет функции или она
   * ничего не нашла — берётся поле «раздел» модели как запасное.
   */
  readonly sectionOf?: (offset: number) => string | null;
  /**
   * Уровень документа (ведомость, смета, ТЗ): по умолчанию — ТЗ. Позиция наследует
   * его, если заголовок рядом с её цитатой не говорит иного.
   */
  readonly documentLevel?: VolumeSourceLevel;
  /**
   * Заголовки, действующие в позиции `offset` (смещение в `sourceText`): по ним
   * строки таблиц-не-работ отсеиваются, а уровень внутри документа уточняется.
   * Нет функции — решает только поле «раздел» из ответа модели.
   */
  readonly headingInfoOf?: (offset: number) => HeadingInfo;
  /**
   * Документ — смета в текущем уровне цен: из строк позиций читаются цена и сумма
   * заказчика (`customerPrice`). Базисный или неизвестный уровень — не читаются.
   */
  readonly pricesCurrent?: boolean;
}

/**
 * Свёрнутая цитата для поиска. Цитата короче порога (по записи модели) не ищется вовсе, а после
 * свёртки — тире, кавычки и разделители схлопываются — должна остаться осмысленной: от «1;;;;;;;;»
 * остаётся одна цифра, и такую «цитату» нашли бы в любом месте документа.
 */
function foldedNeedle(quote: string): string | null {
  if (forMatch(quote).length < MIN_QUOTE_CHARS) return null;
  const needle = forFind(quote);
  return needle.length < MIN_FOLDED_CHARS ? null : needle;
}

/** Вхождения цитаты в свёрнутый текст: до `limit` штук, смещения — в исходном тексте. */
function quoteOffsets(
  quote: string,
  folded: string,
  map: readonly number[],
  limit = 50,
): number[] {
  const needle = foldedNeedle(quote);
  if (needle === null) return [];
  const offsets: number[] = [];
  let at = folded.indexOf(needle);
  while (at >= 0 && offsets.length < limit) {
    offsets.push(map[at] ?? at);
    at = folded.indexOf(needle, at + 1);
  }
  return offsets;
}

/**
 * Где в исходном тексте стоит позиция: место цитаты наименования. Наименование в
 * спецификации повторяется, поэтому из его вхождений берётся ближайшее к цитате
 * объёма — как и при проверке `anchorsNear`.
 */
function locateItem(
  quote: string,
  quantityQuote: string,
  folded: string,
  map: readonly number[],
): number | null {
  const names = quoteOffsets(quote, folded, map);
  if (quantityQuote === quote) return names[0] ?? null;
  const quantities = quoteOffsets(quantityQuote, folded, map);
  if (names.length === 0) return quantities[0] ?? null;
  if (quantities.length === 0) return names[0] ?? null;
  let best = names[0] as number;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of names) {
    for (const quantity of quantities) {
      const distance = Math.abs(name - quantity);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = name;
      }
    }
  }
  return best;
}

/** Разбор числа из ведомости: «1 234,56», «1234.56», «1&nbsp;234». */
export function parseQuantity(raw: string | number): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }

  const cleaned = raw.replace(/ /g, "").replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;

  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Парный объём: «103,65/82,92», «123,88 / 99,1», «308,5 / 16,66 / 556». Таблицы
 * «объём и вес мусора» дают в одной ячейке два и три числа сразу, каждое в своей
 * единице («м3/т»). Хоть одно число не прочиталось — парным значение не считается.
 */
export function parseQuantityPair(raw: string | number): number[] | null {
  if (typeof raw !== "string" || !raw.includes("/")) return null;
  const parts = raw.split("/");
  if (parts.length < 2) return null;
  const values: number[] = [];
  for (const part of parts) {
    const value = parseQuantity(part.trim());
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

/*
  Длина цитаты в том виде, как её записала модель: пробелы схлопнуты, регистр снят.
  Сам поиск идёт по более глубокой свёртке (`foldWithMap` в `billQuoteMatch.ts`: тире,
  кавычки, разделители CSV, запись чисел), но порог длины считается по написанию
  модели: свёртка не должна делать из короткого обрывка «цитату» и наоборот.
*/
function forMatch(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/ё/gi, "е")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Где цитата стоит в тексте документа. `-1` — её там нет.
 *
 * Возвращает место, а не «да/нет», потому что проверять надо ещё и близость
 * двух привязок: наименование из одной строки таблицы и объём из другой дают
 * правдоподобную позицию, которой в ведомости не было.
 */
export function quoteIndexIn(quote: string, sourceText: string): number {
  const needle = foldedNeedle(quote);
  if (needle === null) return -1;
  return forFind(sourceText).indexOf(needle);
}

/**
 * Короче этого фрагмент доказательством строки не считается.
 *
 * «т;12,5» встречается в таблице столько раз, сколько в ней строк с таким
 * объёмом: по нему нельзя сказать, какую именно строку привела модель.
 * Порог отсекает такие обрывки — но отсекает, а не объявляет отсутствующими,
 * и это разные утверждения (см. `quoteTooShort`).
 */
export const MIN_QUOTE_CHARS = 8;

/** Короче этого цитата после свёртки (без тире, кавычек, разделителей) доказательством не считается. */
const MIN_FOLDED_CHARS = 6;

/**
 * Фрагмент слишком короток, чтобы быть доказательством.
 *
 * Отдельно от «цитаты нет в тексте», потому что чинят их по-разному: первое —
 * промпт, второе — доверие к модели. Пока обе причины назывались одинаково, на
 * живом прогоне две строки из трёх выбыли с сообщением «фрагмента с объёмом
 * нет в тексте документа», хотя фрагмент в документе был, и искать поломку
 * пошли бы в разбор файла.
 */
export function quoteTooShort(quote: string): boolean {
  return forMatch(quote).length < MIN_QUOTE_CHARS;
}

/** Есть ли цитата в тексте документа. */
export function quoteFoundIn(quote: string, sourceText: string): boolean {
  return quoteIndexIn(quote, sourceText) >= 0;
}

/**
 * Насколько далеко друг от друга могут стоять наименование и объём.
 *
 * Строка расплющенной таблицы вместе с её описанием занимает несколько сотен
 * знаков; тысяча — это уже соседние позиции ведомости, и брать из одной
 * наименование, а из другой объём нельзя.
 */
export const MAX_ANCHOR_DISTANCE = 1000;

/**
 * Стоят ли наименование и объём рядом хоть где-нибудь в документе.
 *
 * Сравнивать первые вхождения нельзя: в спецификации одно и то же наименование
 * повторяется десятки раз, и объём пятой строки всегда оказывается «далеко» от
 * первого упоминания названия. Поэтому перебираются вхождения фрагмента с
 * объёмом — он обычно уникален, — и для каждого проверяется окно вокруг.
 */
export function anchorsNear(
  nameQuote: string,
  quantityQuote: string,
  sourceText: string,
  maxDistance: number = MAX_ANCHOR_DISTANCE,
): boolean {
  const text = forFind(sourceText);
  const name = forFind(nameQuote);
  const quantity = forFind(quantityQuote);
  if (name === "" || quantity === "") return false;

  let at = text.indexOf(quantity);
  // Предел перебора: документ, где фрагмент встречается тысячи раз, не должен
  // превращать проверку в перебор всего текста на каждую строку ведомости.
  for (let guard = 0; at >= 0 && guard < 500; guard += 1) {
    const from = Math.max(0, at - maxDistance);
    const to = at + quantity.length + maxDistance;
    if (text.slice(from, to).includes(name)) return true;
    at = text.indexOf(quantity, at + 1);
  }
  return false;
}

/**
 * Видно ли число в цитате.
 *
 * Число ищется в любой записи: «1 234,5», «1234.5» и «1234,50» — одно число, и
 * модель, вернув 1234.5, не обязана повторять пробел разряда и запятую документа.
 * Целое число сверяется и без дробной части: «12» в цитате подтверждает объём 12.
 * Граница по цифрам соблюдается: «12» не подтверждается числом «7124» или «12,5».
 * Цифра единицы («м3», «м2») числом не считается.
 *
 * Здесь только «то же число». Объём с пересчётом единицы и по арифметике строки
 * проверяет `confirmQuantity` из `billQuoteMatch.ts`.
 */
export function quantityVisibleIn(quantity: number, quote: string): boolean {
  return numberVisibleIn(quantity, quote);
}

/**
 * Дальше этого от заголовка таблицы-не-работы строка ещё считается её строкой,
 * если модель назвала другой раздел. Строки таблицы идут сразу за подписью;
 * тысячи знаков между ними — уже другой пункт документа.
 */
const NON_WORK_NEAR = 4000;

/** Заголовок не-работы, под которым стоит строка: из ответа модели или из текста. */
function nonWorkTableOf(
  row: BillExtractionRow,
  info: HeadingInfo | null,
): string | null {
  const modelSection = row.section?.replace(/\s+/g, " ").trim() ?? "";
  if (modelSection !== "" && isNonWorkHeading(modelSection)) return modelSection;
  if (info?.nonWork != null) {
    // Модель назвала другой раздел, а заголовок не-работы далеко — верим модели.
    if (modelSection === "" || (info.nonWorkDistance ?? Number.POSITIVE_INFINITY) <= NON_WORK_NEAR) {
      return info.nonWork;
    }
  }
  return null;
}

/** Служебные ресурсы ФСНБ: 999-9900 «Строительный мусор», 999-9901 «Материалы (см. приложение)». */
const SERVICE_RESOURCE_CODE = /(?<![\d.-])999-99\d\d(?![\d-])/;

/** Номер позиции в начале строки таблицы: «4», «4.1» — перед шифром или наименованием. */
const POSITION_LINE = /^\s*(\d{1,3}(?:\.\d{1,2})?)\s+(?=\S*\d\S*[-.]\S*\d)/;

/** Номер позиции из цитаты: ищется в строках цитаты, раздел и заголовок перед ним пропускаются. */
function positionNumberOf(quote: string): string | null {
  for (const line of quote.split("\n")) {
    const match = POSITION_LINE.exec(line);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

/**
 * Сходится ли объём с суммой строки: найдётся ли среди чисел строки пара «цена,
 * итог», для которой объём × цена даёт итог. Так отличается настоящий объём
 * 34,7 от «347», в который OCR склеил десятичную запятую: 34,7 × 1 740,33 =
 * 60 389,45 — число, которое напечатано в строке, а 347 × 1 740,33 — нет.
 */
function agreesWithSum(quantity: number, pool: readonly number[]): boolean {
  for (const price of pool) {
    if (price <= 1 || Math.abs(price - quantity) < 1e-9) continue;
    const expected = quantity * price;
    for (const total of pool) {
      if (total <= 1 || Math.abs(total - quantity) < 1e-9 || Math.abs(total - price) < 1e-9) continue;
      if (Math.abs(expected - total) <= Math.max(0.02, total * 0.005)) return true;
    }
  }
  return false;
}

/** Начало длинного фрагмента для сообщений: полный текст строки в отчёте не нужен. */
function shorten(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** Номер позиции в начале строки: «4 Болты М12» — число «4» номером, а не объёмом. */
const LEADING_POSITION = /^\s*\d{1,4}(?:\.\d{1,3})*[.)]?(?=[\s;|]+\p{L})/u;

/** Фрагмент — это номер позиции в начале строки таблицы: объёмом он быть не может. */
function isPositionNumber(source: string, span: QuoteSpan): boolean {
  const lineStart = span.from <= 0 ? 0 : source.lastIndexOf("\n", span.from - 1) + 1;
  const lead = LEADING_POSITION.exec(source.slice(lineStart, span.to + 40));
  return lead !== null && span.from >= lineStart && span.to <= lineStart + lead[0].length;
}

/** Позиции одной строки сметы на расстоянии не дальше этого считаются соседними. */
const POSITION_NEIGHBOUR = 1500;

interface Accepted {
  item: BillOfWorkItem;
  row: BillExtractionRow;
  offset: number | null;
  position: string | null;
  codeKey: string | null;
  /** Числа строки: для сверки объёма с суммой. */
  pool: number[];
  rank: number;
  /** Объём, как он напечатан (до множителя единицы). */
  printed: number;
  /** Конец строки позиции в тексте — отсюда ищется «Всего по позиции». */
  lineEnd: number | null;
}

function codeKeyOf(item: BillOfWorkItem): string | null {
  if (item.resourceCode !== null) return item.resourceCode;
  return item.normCodeHint == null ? null : item.normCodeHint.code;
}

/**
 * Схлопывает дубли одной позиции сметы.
 *
 * OCR иногда читает строку дважды: «4 ФСБЦ-02.2.04.03-0013 … м3 34,7» и
 * «4 ®CBU-02.2.04.03-0013 … мз 347», где десятичная запятая склеилась. Признак —
 * одинаковые номер позиции и шифр рядом в тексте. Остаётся строка, объём которой
 * сходится с суммой; не удалось понять, какая верна, — первая, и об этом
 * сказано в причине отказа второй.
 */
function collapsePositions(
  accepted: Accepted[],
  reject: (row: BillExtractionRow, reason: BillRejectionReason, message: string) => void,
  pricesCurrent: boolean,
  documentName: string,
): Accepted[] {
  const groups: Accepted[][] = [];
  for (const entry of accepted) {
    const group =
      entry.position === null || entry.codeKey === null
        ? undefined
        : groups.find((candidate) => {
            const head = candidate[0] as Accepted;
            if (head.position !== entry.position || head.codeKey !== entry.codeKey) return false;
            if (head.offset === null || entry.offset === null) return entry.rank - head.rank <= 2;
            return Math.abs(entry.offset - head.offset) <= POSITION_NEIGHBOUR;
          });
    if (group === undefined) groups.push([entry]);
    else group.push(entry);
  }

  const dropped = new Set<Accepted>();
  for (const group of groups) {
    if (group.length < 2) continue;
    const first = group[0] as Accepted;
    const pool = group.flatMap((entry) => entry.pool);
    const quantities = [...new Set(group.map((entry) => entry.item.quantity))];
    const agreeing = quantities.filter((quantity) => agreesWithSum(quantity, pool));

    let kept = first;
    let why: string;
    if (quantities.length === 1) {
      why = `строка повторяет первую с тем же объёмом ${formatQuantity(first.item.quantity)}`;
    } else if (agreeing.length === 1) {
      kept = group.find((entry) => entry.item.quantity === agreeing[0]) as Accepted;
      why =
        `OCR прочитал строку дважды с разным объёмом (${quantities.map(formatQuantity).join(" и ")}); ` +
        `оставлена строка с объёмом ${formatQuantity(kept.item.quantity)} — он сходится с суммой в строке`;
    } else {
      why =
        `OCR прочитал строку дважды с разным объёмом (${quantities.map(formatQuantity).join(" и ")}), ` +
        `какой верен — по сумме в строке не определить; оставлена первая, объём ${formatQuantity(first.item.quantity)} требует проверки`;
    }

    // Цена строки-дубля могла стоять в соседней строке: у оставленной берём её из общих чисел группы.
    if (pricesCurrent && kept.item.customerPrice == null && kept.item.volumeVariants === undefined) {
      const pair = priceFromLine(kept.printed, pool);
      if (pair !== null) {
        kept.item = {
          ...kept.item,
          customerPrice: {
            total: pair.total,
            unitPrice: pair.total / kept.item.quantity,
            unit: kept.item.quantityUnit,
            origin: "LINE",
            document: documentName,
          },
        };
      }
    }

    for (const entry of group) {
      if (entry === kept) continue;
      dropped.add(entry);
      reject(
        entry.row,
        "DUPLICATE_POSITION",
        `«${entry.item.workName}»: дубль позиции ${entry.position ?? ""} (${entry.codeKey ?? ""}) — ${why}`,
      );
    }
  }
  return accepted.filter((entry) => !dropped.has(entry));
}

function formatQuantity(value: number): string {
  return String(Math.round(value * 1e6) / 1e6).replace(".", ",");
}

/**
 * Собирает ведомость из строк модели, отбрасывая всё неподтверждённое.
 *
 * Порядок проверок — от дешёвых к дорогим и от общих к частным, чтобы причина
 * отказа была самой точной из применимых: сначала наименование, затем «не
 * работа» (таблица машин и СИЗ), число, единица, потом подтверждение текстом.
 */
export function extractBillItems(
  input: BillExtractionInput,
): BillExtractionResult {
  const accepted: Accepted[] = [];
  const rejected: RejectedBillRow[] = [];
  const seen = new Set<string>();
  const documentLabel = input.documentName;
  // Карта смещений строится один раз на фрагмент: по месту строки ищутся раздел, заголовок и числа её суммы.
  const folded = foldWithMap(input.sourceText);

  const reject = (
    row: BillExtractionRow,
    reason: BillRejectionReason,
    message: string,
  ): void => {
    rejected.push({ reason, row, message });
  };

  for (const row of input.rows) {
    const workName = row.workName.replace(/\s+/g, " ").trim();
    if (workName === "") {
      reject(row, "EMPTY_NAME", "Строка без наименования работы");
      continue;
    }

    const quote = row.evidenceQuote.replace(/\s+/g, " ").trim();
    const suppliedQuantityQuote = (row.quantityQuote ?? quote)
      .replace(/\s+/g, " ")
      .trim();

    /*
      Место строки в документе нужно рано: по нему определяется заголовок
      таблицы, а строка из «Ведомости потребности машин» должна выбыть как «не
      работа» раньше, чем её объём «1-2» назовут не числом, а «комп.» — незнакомой
      единицей.
    */
    const offset = locateItem(quote, suppliedQuantityQuote, folded.folded, folded.map);
    const info = offset === null ? null : (input.headingInfoOf?.(offset) ?? null);

    /*
      Строка документа — «контекст строки»: из неё берутся единица, вместо подписи колонки,
      числа для арифметики строки и подтверждение, что короткий фрагмент объёма стоит рядом
      с наименованием. Считается лениво: большинству строк он не нужен.
    */
    let cachedNameRow: string | null | undefined;
    const nameRowText = (): string | null => {
      if (cachedNameRow === undefined) {
        cachedNameRow =
          offset === null ? null : rowContextAt(input.sourceText, offset, offset + quote.length, { forward: true });
      }
      return cachedNameRow;
    };
    // Строки вокруг ближайших к наименованию вхождений фрагмента с объёмом.
    const quantityRowTexts = (): string[] => {
      if (suppliedQuantityQuote === quote || offset === null) return [];
      return fragmentSpans(suppliedQuantityQuote, folded, 50)
        .sort((a, b) => Math.abs(a.from - offset) - Math.abs(b.from - offset))
        .slice(0, 2)
        .map((span) => rowContextAt(input.sourceText, span.from, span.to));
    };

    const nonWorkTable = nonWorkTableOf(row, info);
    if (nonWorkTable !== null) {
      reject(
        row,
        "NOT_WORK",
        `«${workName}»: строка из таблицы «${nonWorkTable}» — это не работа (машины, кадры, средства защиты, график), в расчёт не берётся`,
      );
      continue;
    }

    // Служебный ресурс 999-99xx («Строительный мусор» — масса отходов): справка сметы, не работа.
    const serviceCode = SERVICE_RESOURCE_CODE.exec(row.justification ?? "") ?? SERVICE_RESOURCE_CODE.exec(row.evidenceQuote);
    if (serviceCode !== null) {
      reject(
        row,
        "NOT_WORK",
        `«${workName}»: справочная строка сметы (служебный ресурс ${serviceCode[0]}: масса отходов, материалы по приложению), а не работа — норма ей не подбирается`,
      );
      continue;
    }

    /*
      Парный объём: «103,65/82,92» при единице «м3/т». Каждое число — в своей
      единице той же пары. Какое из них объём работы, решает единица нормы,
      когда она подобрана; до этого берётся первое.
    */
    const pairUnits = parseUnitPair(row.unit);
    const pairQuantities = parseQuantityPair(row.quantity);
    let quantity: number;
    let variants: VolumeVariant[];
    let visibleQuantities: number[];
    // Единица каждого из объёмов: по ней пересчитывается число цитаты (кг↔т, «100 м2»↔м2).
    let quantityUnits: ParsedUnit[];
    let unitRecovered = false;

    if (
      pairUnits !== null &&
      pairQuantities !== null &&
      pairUnits.length === pairQuantities.length
    ) {
      visibleQuantities = pairQuantities;
      quantityUnits = pairUnits;
      variants = pairUnits.map((unit, index) => ({
        quantity: (pairQuantities[index] as number) * unit.multiplier,
        unit: unit.unit,
      }));
      quantity = pairQuantities[0] as number;
    } else {
      const single = parseQuantity(row.quantity);
      if (single === null) {
        reject(
          row,
          "BAD_QUANTITY",
          `«${workName}»: объём «${String(row.quantity)}» не положительное число`,
        );
        continue;
      }

      if (isMoneyUnit(row.unit)) {
        reject(
          row,
          "MONEY_NOT_WORK",
          `«${workName}»: «${row.unit}» — это сумма, а не объём работ`,
        );
        continue;
      }

      if (isWholeWorkUnit(row.unit) && single === 1) {
        reject(
          row,
          "WHOLE_WORK",
          `«${workName}»: объём задан всей работой (1 усл. ед.) — нужна разбивка по позициям`,
        );
        continue;
      }

      /*
        Модель нередко возвращает вместо единицы подпись колонки («ед. изм.»). Настоящая
        единица стоит в самой строке документа рядом с объёмом: берётся оттуда, а не
        угадывается. «ед.» разбирается как «шт», но и это — чаще подпись колонки, поэтому
        строка проверяется первой, и «шт» остаётся запасным чтением.
      */
      let unit = parseUnit(row.unit);
      const headerLabel = isHeaderUnitLabel(row.unit);
      if (headerLabel) {
        const rows = [...(nameRowText() === null ? [] : [nameRowText() as string]), ...quantityRowTexts()];
        const recovered = recoverUnitFromRows(rows, [single]);
        if (recovered !== null) {
          unit = recovered.unit;
          unitRecovered = true;
        } else if (unit === null) {
          const checked = rows[0] === undefined ? "строка документа не найдена" : `проверена строка: «${shorten(rows[0])}»`;
          reject(
            row,
            "UNKNOWN_UNIT",
            `«${workName}»: единица «${row.unit}» — подпись колонки, а не единица измерения; рядом с объёмом ${formatQuantity(single)} в строке документа единицы не нашлось (${checked})`,
          );
          continue;
        }
      }
      if (unit === null) {
        reject(
          row,
          "UNKNOWN_UNIT",
          `«${workName}»: единица «${row.unit}» не распознана: такого написания нет в списке единиц (м3, м2, м, т, кг, шт, компл. и их записи после OCR); подставлять похожую нельзя`,
        );
        continue;
      }
      quantity = single;
      visibleQuantities = [single];
      quantityUnits = [unit];
      variants = [{ quantity: single * unit.multiplier, unit: unit.unit }];
    }

    if (quoteTooShort(quote)) {
      reject(
        row,
        "QUOTE_TOO_SHORT",
        `«${workName}»: цитата короче ${String(MIN_QUOTE_CHARS)} знаков — по ней нельзя отличить строку от соседней`,
      );
      continue;
    }
    if (!quoteFoundIn(quote, input.sourceText)) {
      reject(
        row,
        "QUOTE_NOT_FOUND",
        `«${workName}»: цитаты нет в тексте документа «${documentLabel}»; сравнение шло без учёта регистра, пробелов, переносов строк, вида тире и кавычек, запятых-разделителей CSV и формата чисел («1 234,5» = «1234.5»): «${shorten(quote)}»`,
      );
      continue;
    }

    const proofsFor = (
      text: string,
      rowText: string | null,
    ): { evidence: QuantityEvidence[]; missing: number | null } => {
      const evidence: QuantityEvidence[] = [];
      for (const [index, value] of visibleQuantities.entries()) {
        const proof = confirmQuantity({
          quantity: value,
          unit: quantityUnits[index] as ParsedUnit,
          quote: text,
          row: rowText,
        });
        if (proof === null) return { evidence, missing: index };
        evidence.push(proof);
      }
      return { evidence, missing: null };
    };

    /*
      Короткий фрагмент объёма («2», «12,5», «т;12,5») прощается в двух случаях.

      Первый: число видно в самой цитате наименования. Смысл отдельного quantity_quote —
      доказать, что число принадлежит этой строке, а не соседней; когда цитата длинна,
      найдена в документе и число стоит внутри неё, это уже доказано. Так устроены выгрузки
      ГРАНД-Сметы: наименование и объём стоят в одной строке через «;», и минимальный
      фрагмент с числом физически короток.

      Второй: число стоит в документе в той же строке таблицы, что и наименование. В таблице
      ячейка объёма — это «2» или «12,5», и длиннее она не бывает; доказательством служит не
      длина фрагмента, а строка: рядом с числом должно стоять наименование (цитата или два
      слова названия подряд). Число, которое в строке с наименованием не найдено, не
      подтверждается — как и раньше.

      Подменяется только слишком короткий фрагмент. Длинный, но не найденный в тексте,
      остаётся отказом: это уже не теснота формата, а выдумка.
    */
    let quantityQuote = suppliedQuantityQuote;
    let quantityRow: string | null = null;
    let rowAnchored = false;
    let proved: { evidence: QuantityEvidence[]; missing: number | null } | null = null;

    if (quoteTooShort(suppliedQuantityQuote)) {
      const inName = proofsFor(quote, nameRowText());
      if (inName.missing === null) {
        quantityQuote = quote;
        quantityRow = nameRowText();
        proved = inName;
      } else {
        const spans = fragmentSpans(suppliedQuantityQuote, folded, 200);
        let onNameRow = 0;
        for (const span of spans) {
          if (isPositionNumber(input.sourceText, span)) continue;
          const rowText = rowContextAt(input.sourceText, span.from, span.to);
          if (!nameOnRow(rowText, quote, workName)) continue;
          onNameRow += 1;
          const candidate = proofsFor(suppliedQuantityQuote, rowText);
          if (candidate.missing !== null) continue;
          proved = candidate;
          quantityRow = rowText;
          rowAnchored = true;
          break;
        }
        if (proved === null) {
          reject(
            row,
            "QUANTITY_QUOTE_TOO_SHORT",
            `«${workName}»: фрагмент с объёмом «${suppliedQuantityQuote}» короче ${String(MIN_QUOTE_CHARS)} знаков, по нему нельзя отличить строку от соседней; ` +
              `проверено, стоит ли число рядом с наименованием: вхождений фрагмента в документе ${String(spans.length)}, ` +
              `из них в одной строке с наименованием — ${String(onNameRow)}, и подтверждённого объёма ${formatQuantity(visibleQuantities[0] as number)} среди них нет; ` +
              `число не привязать к строке, а в самой цитате наименования его тоже нет`,
          );
          continue;
        }
      }
    } else {
      if (!quoteFoundIn(quantityQuote, input.sourceText)) {
        reject(
          row,
          "QUANTITY_QUOTE_NOT_FOUND",
          `«${workName}»: фрагмента с объёмом нет в тексте документа «${documentLabel}»; сравнение шло без учёта регистра, пробелов, переносов строк, вида тире и кавычек, запятых-разделителей CSV и формата чисел: «${shorten(quantityQuote)}»`,
        );
        continue;
      }
      if (quantityQuote === quote) {
        quantityRow = nameRowText();
      } else {
        const nearest = fragmentSpans(quantityQuote, folded, 50).sort(
          (a, b) => Math.abs(a.from - (offset ?? 0)) - Math.abs(b.from - (offset ?? 0)),
        )[0];
        quantityRow = nearest === undefined ? null : rowContextAt(input.sourceText, nearest.from, nearest.to);
      }
    }

    if (proved === null) {
      const checked = proofsFor(quantityQuote, quantityRow);
      if (checked.missing !== null) {
        const missing = visibleQuantities[checked.missing] as number;
        reject(
          row,
          "QUANTITY_NOT_IN_QUOTE",
          `«${workName}»: объём ${String(missing)} не встречается в цитате «${shorten(quantityQuote)}»: ` +
            describeQuantityChecks({
              quantity: missing,
              unit: quantityUnits[checked.missing] as ParsedUnit,
              quote: quantityQuote,
              row: quantityRow,
            }),
        );
        continue;
      }
      proved = checked;
    }

    if (!rowAnchored && !anchorsNear(quote, quantityQuote, input.sourceText)) {
      reject(
        row,
        "ANCHORS_TOO_FAR",
        `«${workName}»: наименование и объём стоят в разных местах документа: ближайшие вхождения дальше ${String(MAX_ANCHOR_DISTANCE)} знаков друг от друга`,
      );
      continue;
    }

    // Объём, как он напечатан: после пересчёта единиц это число цитаты, а не число модели.
    const printedQuantities = proved.evidence.map((entry) => entry.printed);

    /*
      Множитель единицы, потерянный моделью: в строке «… 100 м2 | 0,899», модель вернула «м2» и 0,899. Объём остаётся напечатанным,
      а единица становится «100 м2»: 0,899 × 100 = 89,9 м2, и перевод под норму «100 м2» даст 0,899, а не 0,00899. Только для
      одиночного объёма и только когда множитель стоит вплотную к числу (`recoverUnitMultiplier`).
    */
    let unitMultiplierRecovered = false;
    if (variants.length === 1) {
      const scaled = recoverUnitMultiplier(
        [quote, quantityQuote, nameRowText(), quantityRow],
        visibleQuantities[0] as number,
        quantityUnits[0] as ParsedUnit,
      );
      if (scaled !== null) {
        variants = [{ quantity: (visibleQuantities[0] as number) * scaled.multiplier, unit: scaled.unit }];
        unitMultiplierRecovered = true;
      }
    }

    const primary = variants[0] as VolumeVariant;
    const key = `${workName.toLowerCase()}|${primary.unit}|${String(quantity)}`;
    if (seen.has(key)) {
      reject(row, "DUPLICATE", `«${workName}»: та же работа с тем же объёмом`);
      continue;
    }
    seen.add(key);
    if (input.stats !== undefined) {
      if (unitRecovered) input.stats.unitRecovered += 1;
      if (unitMultiplierRecovered) input.stats.unitMultiplierRecovered += 1;
      if (rowAnchored) input.stats.rowAnchored += 1;
      if (proved.evidence.some((entry) => entry.proof === "UNIT_FACTOR")) input.stats.unitFactor += 1;
      if (proved.evidence.some((entry) => entry.proof === "ARITHMETIC")) input.stats.arithmetic += 1;
    }

    const located =
      offset === null ? null : (input.sectionOf?.(offset) ?? null);
    const modelSection = row.section?.replace(/\s+/g, " ").trim() ?? "";

    const normCodeHint: NormCodeHint | null =
      parseNormCodeHint(row.justification) ??
      ((): NormCodeHint | null => {
        const fromQuote = parseNormCodeHint(quote);
        // В цитате код принимается только с узнанным префиксом: голая группа цифр там бывает чем угодно.
        return fromQuote !== null && fromQuote.baseType !== null ? fromQuote : null;
      })();

    // Шифр перевозки («02-15-1-01-0047») или погрузки («49-1»): цена такой строки — в таблицах зоны.
    const autoServiceCode = serviceCodeFromText(row.justification, quote);

    /*
      Числа строки — всё от места цитаты до конца строки текста: цена и итог
      позиции стоят правее объёма, и по ним позже проверяется объём.
    */
    let pool: number[] = [];
    let lineEnd: number | null = null;
    if (offset !== null) {
      const found = input.sourceText.indexOf("\n", offset + quote.length);
      lineEnd = found < 0 ? input.sourceText.length : found;
      const to = Math.min(lineEnd, offset + quote.length + 400);
      pool = numbersOf(input.sourceText.slice(offset, to));
    }

    /*
      Строка, которая ссылается на позиции локальной сметы («ЛС 02-02-07 Поз.: 3-3.2»), — производная:
      её составили из ЛСР, и надёжнее сама ЛСР. Таблица так называется как угодно, в том числе
      «Ведомость объёмов работ», но строка с такой ссылкой ведомостью не считается: её уровень —
      смета контракта. Решает текст самой строки таблицы, а не заголовок и не слова модели.
    */
    const lineStart = offset === null ? 0 : input.sourceText.lastIndexOf("\n", offset) + 1;
    const derivedFromLsr =
      offset !== null && lineEnd !== null && referencesLsr(input.sourceText.slice(lineStart, lineEnd));

    // Уровень: заголовок ведомости или сметы рядом со строкой, иначе поле «раздел», иначе документ.
    const modelClass = modelSection === "" ? null : classifyHeading(modelSection);
    const level: VolumeSourceLevel = derivedFromLsr
      ? "CONTRACT_ESTIMATE"
      : (info?.level ??
        (modelClass === "BILL" || modelClass === "CUSTOMER_ESTIMATE" || modelClass === "CONTRACT_ESTIMATE" ? modelClass : null) ??
        input.documentLevel ??
        "SPEC");

    let customerPrice: CustomerPrice | undefined;
    if (input.pricesCurrent === true && offset !== null && lineEnd !== null && variants.length === 1) {
      const line = priceFromLine(printedQuantities[0] as number, pool);
      const total = line?.total ?? positionTotalAfter(input.sourceText, lineEnd);
      if (total !== null && total > 0) {
        customerPrice = {
          total,
          unitPrice: total / primary.quantity,
          unit: primary.unit,
          origin: line === null ? "POSITION_TOTAL" : "LINE",
          document: input.documentName,
        };
      }
    }

    const item: BillOfWorkItem = {
      id: `${input.idPrefix}-${String(accepted.length + 1)}`,
      workName,
      quantity: primary.quantity,
      quantityUnit: primary.unit,
      /*
        Делитель равен единице: множитель уже учтён в объёме, а перевод под
        единицу нормы считается позже, когда норма подобрана и её единица
        известна. Ставить сюда догадку значило бы спрятать расхождение единиц,
        которое расчёт обязан показать.
      */
      unitDivisor: 1,
      normCode: null,
      normBaseType: null,
      resourceCode: resourceCodeFromJustification(row.justification),
      sourceQuote:
        quantityQuote === quote ? quote : `${quote} … ${quantityQuote}`,
      sourceDocument: input.documentName,
      billSection: located ?? (modelSection === "" ? null : modelSection),
      sourceLevel: level,
      positionNumber: positionNumberOf(row.evidenceQuote),
      normCodeHint,
      ...(autoServiceCode === null ? {} : { serviceCode: autoServiceCode }),
      ...(variants.length > 1 ? { volumeVariants: variants } : {}),
      ...(customerPrice === undefined ? {} : { customerPrice }),
    };

    accepted.push({
      item,
      row,
      offset,
      position: item.positionNumber ?? null,
      codeKey: codeKeyOf(item),
      pool,
      rank: accepted.length,
      printed: printedQuantities[0] as number,
      lineEnd,
    });
  }

  const collapsed = collapsePositions(accepted, reject, input.pricesCurrent === true, input.documentName);
  return { items: collapsed.map((entry) => entry.item), rejected };
}
