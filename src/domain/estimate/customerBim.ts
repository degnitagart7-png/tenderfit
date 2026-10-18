import {
  parseLine,
  parseNumberCell,
  splitCustomerEstimates,
  type DocumentText,
} from "@/domain/estimate/customerEstimate";
import { logicalRows, type NotRecognizedEstimate } from "@/domain/estimate/customerLsr";
import { quarterIn, type QuarterMark } from "@/domain/estimate/priceLevel";

/**
 * Построчный разбор локальной сметы заказчика, составленной базисно-индексным методом (БИМ):
 * единичные расценки ФЕР-2001/ТЕР-2001 в ценах 01.01.2000, индексы пересчёта в текущий квартал.
 *
 * Зачем. Около половины смет заказчиков в базе (223-ФЗ, госкорпорации) составлены не ресурсно-индексным методом
 * (форма 421/пр, ФСНБ-2022), а так: расценка ФЕР × индекс. Раньше такие сметы называлось «не распознано»; здесь они читаются
 * построчно — для аудита (`customerBimAudit.ts`) и для сравнения с нашим расчётом.
 *
 * Два вида смет в образцах, и разбор у них разный:
 *
 * 1. Таблица (xlsx → CSV, «ПК Excel», «Полный локальный сметный расчёт» Гранд-Сметы): шапка «Обоснование /
 *    Стоимость единицы: всего, осн. з/п, эк. маш., з/п мех. / Общая стоимость …», расценки в базисных ценах. Позиция — одна
 *    или две строки (шифр отдельно от наименования), числа привязываются к колонкам не по номеру ячейки, а от ячейки единицы
 *    измерения: она сдвигается на одну ячейку у двухстрочной формы. НР и СП — строки «Накладные расходы 90 % ФОТ (от 112)».
 *    Индексов в такой смете нет: она в базисных ценах 2001 года, пересчёт идёт отдельно (ССР).
 *
 * 2. Поток текста (PDF Гранд-Сметы, форма приложения 2 к 421/пр, «Составлен базисно-индексным методом»): колонки таблицы
 *    разложены по странице в произвольном порядке, строки позиции не лежат рядом. Устойчиво только то, что числа каждой
 *    позиции идут за её заголовком «№ шифр единица объём коэффициент объём» подряд и в одном порядке: четыре группы
 *    «ОТ, ЭМ, в т. ч. ОТм, М» по пять чисел («цена расценки за единицу, коэффициент, итого в базисных ценах, индекс, итого в
 *    текущих»), затем ФОТ, НР и СП с указателями «Пр/812-…», «Пр/774-…» и «Всего по позиции». Так читаются и расценки, и
 *    перевозка (ФССЦпг), и поставка (ФССЦ, ТЦ).
 *
 * Модуль только читает написанное: сверка с ФЕР-2020 и письмом Минстроя — в `customerBimAudit.ts`. Что не разобрано, попадает
 * в `notRecognized` с причиной. Чистый, без сети и диска; тексты бывают до мегабайта, поэтому разбор линейный.
 */

/* ------------------------------ Типы ------------------------------ */

export type BimFamily = "FER" | "TER" | "TSN" | "MATERIAL" | "TRANSPORT" | "CUSTOMER_PRICE" | "OTHER";

export type FerBookName = "ФЕР" | "ФЕРм" | "ФЕРр" | "ФЕРп" | "ФЕРмр";

/** Деньги позиции по элементам, ₽. null — в смете не напечатано. */
export interface BimAmounts {
  readonly total: number | null;
  /** ОЗП: оплата труда рабочих. */
  readonly wage: number | null;
  /** ЭМ: эксплуатация машин, включая оплату машинистов. */
  readonly machines: number | null;
  /** ЗПМ: оплата труда машинистов (входит в ЭМ). */
  readonly machinistWage: number | null;
  /** М: материалы. */
  readonly materials: number | null;
}

/** Поправочные коэффициенты позиции («ОЗП=0,6; ЭМ=0,6 к расх.; ЗПМ=0,6; МАТ=0 к расх.»). */
export interface BimCoefficients {
  readonly wage: number;
  readonly machines: number;
  readonly machinistWage: number;
  readonly materials: number;
  /** Строки примечаний к позиции как напечатаны. */
  readonly notes: readonly string[];
  /** Среди строк есть поправка без чисел вида «К = 1 + 0,04»: пересчитать цену по ней нельзя. */
  readonly hasUnparsed: boolean;
}

export interface BimCharge {
  /** Указатель приказа: «Пр/812-049.3-1»; null — в смете не указан (таблица). */
  readonly ref: string | null;
  /** Процент, применённый заказчиком. */
  readonly percent: number | null;
  /** Норматив по приказу, если напечатан отдельно от применённого. */
  readonly basePercent: number | null;
  /** База (ФОТ), к которой процент применён, ₽ (в тех же ценах, что и сумма); null — не напечатана. */
  readonly base: number | null;
  readonly amount: number | null;
}

/** Индексы, которые заказчик применил к позиции (у позиций потока текста). */
export interface BimAppliedIndices {
  readonly labour: number | null;
  readonly machines: number | null;
  readonly machinistLabour: number | null;
  readonly materials: number | null;
}

export interface BimPosition {
  /** Номер позиции в смете: «5», «5.1». */
  readonly number: string;
  /** Шифр без пробелов и приказа: «ФЕРм12-12-001-13», «ФССЦ-18.1.02.01-0085». */
  readonly code: string;
  /** Обоснование как напечатано. */
  readonly rawCode: string;
  readonly family: BimFamily;
  /** Книга ФЕР для расценок ФЕР; иначе null. */
  readonly book: FerBookName | null;
  /** Код расценки без книги: «12-12-001-13»; у ФССЦ — код ресурса «18.1.02.01-0085». */
  readonly rateCode: string | null;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number | null;
  /** Цена за единицу по элементам, как напечатана заказчиком (с поправочными коэффициентами, если программа их туда вносит). */
  readonly unitPrice: BimAmounts;
  /** Стоимость позиции по элементам в базисных ценах. */
  readonly baseTotal: BimAmounts;
  readonly coefficients: BimCoefficients;
  /** Коэффициент позиции у потока текста (графа «коэффициенты»): стоимость = цена × объём × коэффициент. */
  readonly positionCoefficient: number | null;
  readonly overhead: BimCharge | null;
  readonly profit: BimCharge | null;
  /** Индексы позиции; null — позиция в базисных ценах. */
  readonly indices: BimAppliedIndices | null;
  /** Стоимость в текущих ценах по элементам, если напечатана (поток текста). */
  readonly currentTotal: BimAmounts | null;
  /** «Всего по позиции» в базисных ценах (с НР и СП); у таблицы не печатается — считается. */
  readonly positionBaseTotal: number | null;
  /** «Всего по позиции» в текущих ценах; null — позиция в базисных ценах. */
  readonly positionCurrentTotal: number | null;
  /** Формула пересчёта цены из строки сметы («113,00 = 146,06 - 3,48 x 9,50»): расценка скорректирована вручную. */
  readonly priceFormula: string | null;
  readonly section: string | null;
  /** Позиция разобрана не полностью: чего не хватает. */
  readonly gaps: readonly string[];
}

export interface BimIndexStatement {
  /** «LETTER» — ссылка на письмо; «ELEMENT» — индекс к элементу затрат; «TOTAL» — индекс на итог/статью; «QUARTER» — квартал цен. */
  readonly kind: "LETTER" | "ELEMENT" | "TOTAL" | "QUARTER";
  readonly text: string;
  readonly value?: number;
  readonly element?: "LABOUR" | "MACHINES" | "MATERIALS";
  readonly letterNumber?: string;
  readonly letterDate?: string;
  readonly quarter?: { readonly quarter: number; readonly year: number };
}

export type BimPriceLevel = "BASE" | "CURRENT";

export interface CustomerBim {
  readonly documentName: string;
  readonly estimateName: string | null;
  readonly format: "GRID" | "STREAM";
  /** Номер или шифр локальной сметы («ЛС-044-26-17ЭР-С», «01-01-01»). */
  readonly number: string | null;
  /** Уровень цен позиций: базисный 2001 или текущий (с индексами). */
  readonly priceLevel: BimPriceLevel;
  /** Квартал текущих цен («3 квартал 2025»), если смета в текущих ценах или его называет текст. */
  readonly quarter: QuarterMark | null;
  /** Откуда квартал: из самой сметы или из пояснительной записки соседнего документа (берётся самый поздний названный). */
  readonly quarterSource: "ESTIMATE" | "TEXT" | null;
  /** Субъект РФ, как назван в смете («72. Тюменская область» → «Тюменская область»). */
  readonly subjectText: string | null;
  readonly zone: number | null;
  /** Наименование стройки и работ: по ним определяется объект строительства. */
  readonly constructionName: string | null;
  readonly workName: string | null;
  /** Метод назван в смете «базисно-индексным». */
  readonly declaredBaseIndex: boolean;
  /** Накладные расходы и прибыль начислены по 812/пр и 774/пр или по МДС 81-33.2004 и 81-25.2001 (устаревшим). */
  readonly overheadNorms: "812_774" | "MDS" | null;
  readonly indexStatements: readonly BimIndexStatement[];
  readonly positions: readonly BimPosition[];
  /** Итого прямые затраты в базисных ценах (до коэффициентов к итогам), ₽. */
  readonly directBase: BimAmounts | null;
  /** С учётом коэффициентов к итогам. */
  readonly directWithTotalCoefficients: BimAmounts | null;
  readonly overheadTotal: number | null;
  readonly profitTotal: number | null;
  /** «ВСЕГО по смете» (или сметная стоимость из шапки), ₽ — в уровне цен, который назван в смете. */
  readonly total: number | null;
  /** Стоимость в базисных ценах, если смета её печатает в шапке (поток: «Сметная стоимость 7 107,66 (187,87)»). */
  readonly totalBase: number | null;
  /** Строительные и монтажные работы из шапки (без оборудования и прочих затрат), в текущих и базисных ценах, ₽; у потока текста. */
  readonly smrTotal: number | null;
  readonly smrTotalBase: number | null;
  /** Оборудование из шапки, ₽ в текущих ценах: в позиции-расценки оно не входит. */
  readonly equipmentTotal: number | null;
  readonly vatPercent: number | null;
  /** Сумма «Всего по позиции» (в текущих ценах, если они есть; иначе в базисных). */
  readonly positionsTotal: number;
}

export interface CustomerBimParse {
  readonly estimates: readonly CustomerBim[];
  readonly notRecognized: readonly NotRecognizedEstimate[];
}

/* ------------------------------ Шифры ------------------------------ */

const FER_CODE_RE = /^ФЕР(мр|м|р|п)?\s*(\d{2}-\d{2}-\d{3}-\d{2})$/iu;
const TER_CODE_RE = /^ТЕР(мр|м|р|п)?\s*(\d{2}-\d{2}-\d{3}-\d{2})$/iu;
const FER_BOOKS: Readonly<Record<string, FerBookName>> = { "": "ФЕР", м: "ФЕРм", р: "ФЕРр", п: "ФЕРп", мр: "ФЕРмр" };

/**
 * Шифр из обоснования: до « / Приказ…», перевода строки и слипшегося «Приказ» («ФЕРм12-12-001-13Приказ Минстроя России…» — так
 * сохраняет шифр и приказ экспорт в xlsx), без пробелов внутри.
 */
export function codeOfJustification(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  const structured = /^(ФЕР|ТЕР|ТСН|КОЕР|ФССЦпг|ФССЦ|ФСЭМ|КССЦ)([а-яё]{0,2})\s*(-?\s*[\d][\d.\-]*\d)/iu.exec(flat);
  if (structured !== null) return `${structured[1] as string}${structured[2] ?? ""}${(structured[3] as string).replace(/\s+/g, "")}`;
  const first = (raw.split(/\r?\n|\s\/\s/)[0] ?? "").replace(/\s+/g, " ").trim();
  return first.replace(/(?<=[\d)])(?=Приказ|Письмо).*$/iu, "").trim();
}

export function familyOfCode(code: string): { family: BimFamily; book: FerBookName | null; rateCode: string | null } {
  const fer = FER_CODE_RE.exec(code);
  if (fer !== null) return { family: "FER", book: FER_BOOKS[(fer[1] ?? "").toLowerCase()] ?? "ФЕР", rateCode: fer[2] as string };
  const ter = TER_CODE_RE.exec(code);
  if (ter !== null) return { family: "TER", book: null, rateCode: ter[2] as string };
  if (/^ТСН/iu.test(code)) return { family: "TSN", book: null, rateCode: null };
  if (/^ФССЦпг/iu.test(code)) return { family: "TRANSPORT", book: null, rateCode: code.replace(/^ФССЦпг-?/iu, "") };
  if (/^ФССЦ-/iu.test(code)) return { family: "MATERIAL", book: null, rateCode: code.replace(/^ФССЦ-/iu, "") };
  if (/^ТЦ_/iu.test(code) || /^КА(?![а-яё])/iu.test(code) || /прайс/iu.test(code) || /^КП(?![а-яё])/iu.test(code) || /^по\s+запросу/iu.test(code)) {
    return { family: "CUSTOMER_PRICE", book: null, rateCode: null };
  }
  return { family: "OTHER", book: null, rateCode: null };
}

/* ------------------------------ Числа и коэффициенты ------------------------------ */

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Число в тексте с пробелами-тысячами и запятой: «8 109,08», «0,945». */
export function parseRuNumber(raw: string): number | null {
  const cleaned = raw.replace(/[\s ]/g, "").replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

const COEFFICIENT_RE = /(ОЗП|ЭМ|ЗПМ|МАТ|ПЗ)\s*=\s*(\d+(?:[.,]\d+)?)/giu;

/** Коэффициенты позиции из строк примечаний; перемножаются, «ПЗ» (прямые затраты) — ко всем элементам, если элементы не названы. */
export function parseCoefficients(notes: readonly string[]): BimCoefficients {
  let wage = 1;
  let machines = 1;
  let machinistWage = 1;
  let materials = 1;
  let hasUnparsed = false;
  for (const note of notes) {
    const found: Record<string, number> = {};
    for (const match of note.matchAll(COEFFICIENT_RE)) {
      found[(match[1] as string).toUpperCase()] = Number.parseFloat((match[2] as string).replace(",", "."));
    }
    const named = found.ОЗП !== undefined || found.ЭМ !== undefined || found.ЗПМ !== undefined || found.МАТ !== undefined;
    if (Object.keys(found).length === 0) {
      // Формулы «113,00 = 146,06 - 3,48 x 9,50» и справочные пояснения коэффициентом не являются.
      if (/коэффициент|(?<![\p{L}\d])К\s*=/iu.test(note) && !/^\s*[\d\s.,]+=/.test(note)) hasUnparsed = true;
      continue;
    }
    const all = found.ПЗ;
    wage *= found.ОЗП ?? (named ? 1 : (all ?? 1));
    machines *= found.ЭМ ?? (named ? 1 : (all ?? 1));
    machinistWage *= found.ЗПМ ?? (found.ЭМ !== undefined ? found.ЭМ : named ? 1 : (all ?? 1));
    materials *= found.МАТ ?? (named ? 1 : (all ?? 1));
  }
  return { wage, machines, machinistWage, materials, notes, hasUnparsed };
}

/* ------------------------------ Общие заготовки ------------------------------ */

const EMPTY_AMOUNTS: BimAmounts = { total: null, wage: null, machines: null, machinistWage: null, materials: null };

const NOTE_ROW_RE = /^(?:ТЧ|ОП|Прил|Табл|МДС|Приказ|Письмо|КСР|ГЭСН)/iu;

/** Разбор квартала в тексте, где год разорван пробелом PDF: «3 квартал 202 5 года». */
export function normalizeSplitYear(text: string): string {
  return (
    text
      // «29.0 8 .202 5» → «29.08.2025»: PDF разрывает пробелами и день, и месяц, и год.
      .replace(/(?<![\d.])(\d{1,2})\s*\.\s*(\d)\s?(\d)\s*\.\s*(20\d)\s?(\d)(?![\d])/g, "$1.$2$3.$4$5")
      .replace(/(?<![\d])(20\d)\s(\d)(?![\d])/g, "$1$2")
  );
}

function metaOf(text: string): {
  subjectText: string | null;
  zone: number | null;
  declaredBaseIndex: boolean;
  declaredResourceIndex: boolean;
  overheadNorms: "812_774" | "MDS" | null;
  quarter: QuarterMark | null;
} {
  const flat = normalizeSplitYear(text.replace(/[\s ]+/g, " "));
  const subject = /Наименование субъекта Российской Федерации\s+(?:(\d{1,2})\.\s*)?([А-ЯЁA-Z][^()\n]{2,80}?)(?=\s+Наименование зоны|\s*$)/u.exec(flat);
  const zone = /\((\d)\s*зона\)/u.exec(flat);
  const mds = /МДС\s*81-33\.2004|МДС\s*81-25\.2001/iu.test(flat);
  const orders = /812\/пр|774\/пр/iu.test(flat);
  return {
    subjectText: subject?.[2]?.trim() ?? null,
    zone: zone?.[1] === undefined ? null : Number.parseInt(zone[1], 10),
    declaredBaseIndex: /базисно\s*-?\s*индексн/iu.test(flat),
    declaredResourceIndex: /ресурсно\s*-?\s*индексн/iu.test(flat),
    overheadNorms: mds && !orders ? "MDS" : orders ? "812_774" : null,
    quarter: quarterIn(flat),
  };
}

const INDEX_WORDS: ReadonlyArray<{ re: RegExp; element: "LABOUR" | "MACHINES" | "MATERIALS" }> = [
  { re: /(?<![А-ЯЁа-яё])(?:ОЗП|ОТ|оплат[аы]\s+труда)(?![А-ЯЁа-яём])/u, element: "LABOUR" },
  { re: /(?<![А-ЯЁа-яё])(?:ЭММ|ЭМ|эксплуатаци[яи]\s+машин)(?![А-ЯЁа-яё])/u, element: "MACHINES" },
  { re: /(?<![А-ЯЁа-яё])(?:МАТ|материал[аы]?)(?![А-ЯЁа-яё])/u, element: "MATERIALS" },
];

const LETTER_RE = /Письм[а-я]*\s+Минстроя\s+(?:России\s+)?от\s+(\d{1,2})\.\s*(\d{1,2})\.\s*(20\d\s?\d)\s*(?:года|г\.)?\s*№\s*([0-9]+(?:\s\d{3})*(?:\s*-\s*[А-ЯA-Zа-яa-z]+)?\s*\/\s*\d{2})/giu;

/** Что заказчик сказал об индексах: письма, кварталы, значения по элементам и на итог. */
export function extractIndexStatements(text: string): BimIndexStatement[] {
  const flat = normalizeSplitYear(text.replace(/[\s ]+/g, " "));
  const statements: BimIndexStatement[] = [];
  const seen = new Set<string>();
  const add = (statement: BimIndexStatement): void => {
    const key = `${statement.kind}|${statement.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    statements.push(statement);
  };

  for (const match of flat.matchAll(LETTER_RE)) {
    const year = (match[3] as string).replace(/\s/g, "");
    add({
      kind: "LETTER",
      text: match[0].trim(),
      letterNumber: (match[4] as string).replace(/\s+/g, ""),
      letterDate: `${year}-${(match[2] as string).padStart(2, "0")}-${(match[1] as string).padStart(2, "0")}`,
    });
  }
  for (const match of flat.matchAll(/на\s+(\d)\s*кв(?:артал[а-я]*)?\.?\s+(20\d{2})/giu)) {
    add({ kind: "QUARTER", text: match[0].trim(), quarter: { quarter: Number.parseInt(match[1] as string, 10), year: Number.parseInt(match[2] as string, 10) } });
  }
    // Индекс к элементу в пояснительной записке пишется через тире («МАТ – 20,69»); «ОЗП=1,2» — поправочный коэффициент строки сметы.
  for (const match of flat.matchAll(/(?<![А-ЯЁа-яё])(ОЗП|ОТ|ЭММ|ЭМ|МАТ)\s*[–—-]\s*(\d{1,3}(?:,\d+)?)(?![\d,]*\s*%)/gu)) {
    const value = parseRuNumber(match[2] as string);
    if (value === null || value < 1) continue;
    const word = INDEX_WORDS.find((entry) => entry.re.test(match[1] as string));
    add({ kind: "ELEMENT", text: match[0].trim(), value, ...(word === undefined ? {} : { element: word.element }) });
  }
  for (const match of flat.matchAll(/(?<![А-ЯЁа-яё])(?:К|Ki|Кпер|И\s*проч)\s*=\s*(\d{1,3}(?:,\d+)?)(?![\d,]*\s*%)/gu)) {
    const value = parseRuNumber(match[1] as string);
    if (value !== null && value >= 1) add({ kind: "TOTAL", text: match[0].trim(), value });
  }
  return statements;
}

/* ------------------------------ Признаки БИМ ------------------------------ */

/** Шифры ресурсно-индексной формы 421/пр (ФСНБ-2022): ГЭСН-нормы и ФСБЦ/ФСЭМ-ресурсы. */
const RIM_CODE_RE = /^(?:ГЭСН|ФСБЦ|ФСЭМ)/iu;

/**
 * Эта смета — действительно БИМ, а не ресурсно-индексная форма 421/пр. Таблица Гранд-Сметы и у ресурсной сметы бывает с графами
 * «Осн.З/п», «Эк.Маш», и одной формы для вывода мало: нужны признаки метода. Порядок: явное слово в шапке («Составлен
 * базисно-индексным методом» / «ресурсно-индексным методом») важнее шифров; названы оба или ни одного — решают шифры: ФЕР/ТЕР/ТСН/ФССЦ
 * — БИМ, ГЭСН/ФСБЦ/ФСЭМ — нет; шифров нет вовсе — БИМ, только если цены базисные (2001 год). Возвращает причину отказа или null.
 */
function notBaseIndexReason(
  positions: readonly BimPosition[],
  meta: { readonly declaredBaseIndex: boolean; readonly declaredResourceIndex: boolean },
  baseLevel: boolean,
): string | null {
  if (meta.declaredBaseIndex && !meta.declaredResourceIndex) return null;
  if (meta.declaredResourceIndex && !meta.declaredBaseIndex) return "в шапке назван ресурсно-индексный метод";
  let baseCodes = 0;
  let rimCodes = 0;
  for (const position of positions) {
    if (position.family === "FER" || position.family === "TER" || position.family === "TSN" || position.family === "MATERIAL" || position.family === "TRANSPORT") baseCodes += 1;
    else if (RIM_CODE_RE.test(position.code)) rimCodes += 1;
  }
  if (rimCodes > baseCodes) return "шифры ГЭСН/ФСБЦ/ФСЭМ: ресурсно-индексная форма 421/пр";
  if (baseCodes > 0) return null;
  if (baseLevel && rimCodes === 0) return null;
  return "нет признаков БИМ: ни расценок ФЕР/ТЕР, ни слов «базисно-индексный метод», ни базисных цен";
}

/* ------------------------------ Таблица (Гранд-Смета, Excel) ------------------------------ */

interface GridDraft {
  number: string;
  rawCode: string;
  code: string;
  name: string;
  unit: string;
  quantity: number | null;
  unitPrice: BimAmounts;
  baseTotal: BimAmounts;
  notes: string[];
  priceFormula: string | null;
  overhead: BimCharge | null;
  profit: BimCharge | null;
  section: string | null;
  /** Ждём вторую строку позиции (имя и числа). */
  awaitingData: boolean;
  gaps: string[];
}

const HEADER_BASE_FORM = /осн\.?\s*з\/?п/iu;
const CHARGE_RE = /^(Накладные\s+расходы|Сметная\s+прибыль)\s+(\d+(?:[.,]\d+)?)\s*%\s*ФОТ(?:\s*\(\s*от\s*([\d\s.,]+?)\s*\))?/iu;
const FORMULA_RE = /^\s*[\d\s]+[,.]\d+\s*=\s*[\d\s]+[,.]\d+/u;

function numberCell(cells: readonly string[], index: number, delimiter: string): number | null {
  const text = (cells[index] ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? null : parseNumberCell(text, delimiter);
}

/** Ячейка единицы измерения: первая непустая нечисловая после наименования, за которой идёт число (объём). */
function unitAnchor(cells: readonly string[], delimiter: string, from: number): number {
  for (let index = from; index < cells.length - 1; index += 1) {
    const text = (cells[index] ?? "").trim();
    if (text === "" || parseNumberCell(text, delimiter) !== null) continue;
    if (numberCell(cells, index + 1, delimiter) !== null) return index;
  }
  return -1;
}

function amountsAt(cells: readonly string[], delimiter: string, unitIndex: number, offset: number, supply: boolean): BimAmounts {
  const at = (shift: number): number | null => numberCell(cells, unitIndex + shift, delimiter);
  const total = at(offset);
  if (supply) return { total, wage: null, machines: null, machinistWage: null, materials: total };
  const wage = at(offset + 1);
  const machines = at(offset + 2);
  const machinistWage = at(offset + 3);
  const known = (wage ?? 0) + (machines ?? 0);
  const materials = total === null ? null : round2(Math.max(0, total - known));
  return { total, wage, machines, machinistWage, materials };
}

function finishGrid(draft: GridDraft): BimPosition {
  const { family, book, rateCode } = familyOfCode(draft.code);
  const supply = family === "MATERIAL" || family === "TRANSPORT" || family === "CUSTOMER_PRICE";
  const gaps = [...draft.gaps];
  if (draft.quantity === null) gaps.push("не прочитан объём");
  if (draft.unitPrice.total === null) gaps.push("не прочитана цена за единицу");
  return {
    number: draft.number,
    code: draft.code,
    rawCode: draft.rawCode,
    family,
    book,
    rateCode,
    name: draft.name,
    unit: draft.unit,
    quantity: draft.quantity,
    unitPrice: supply && draft.unitPrice.total !== null ? { ...draft.unitPrice, materials: draft.unitPrice.total } : draft.unitPrice,
    baseTotal: draft.baseTotal,
    coefficients: parseCoefficients(draft.notes),
    positionCoefficient: null,
    overhead: draft.overhead,
    profit: draft.profit,
    indices: null,
    currentTotal: null,
    positionBaseTotal:
      draft.baseTotal.total === null ? null : round2(draft.baseTotal.total + (draft.overhead?.amount ?? 0) + (draft.profit?.amount ?? 0)),
    positionCurrentTotal: null,
    priceFormula: draft.priceFormula,
    section: draft.section,
    gaps,
  };
}

type GridResult =
  | { readonly kind: "ok"; readonly estimate: CustomerBim }
  | { readonly kind: "no"; readonly reason: string };

function parseGridSegment(documentName: string, estimateName: string | null, text: string): GridResult {
  const positions: BimPosition[] = [];
  const headRows: string[] = [];
  let baseForm = false;
  let tableStarted = false;
  let draft: GridDraft | null = null;
  let section: string | null = null;
  let directBase: BimAmounts | null = null;
  let directWithCoefficients: BimAmounts | null = null;
  let overheadTotal: number | null = null;
  let profitTotal: number | null = null;
  let total: number | null = null;
  let vatPercent: number | null = null;
  let afterTotals = false;
  const tailRows: string[] = [];

  const flush = (): void => {
    if (draft !== null) positions.push(finishGrid(draft));
    draft = null;
  };

  for (const row of logicalRows(text)) {
    if (row.text.trim() === "") continue;
    const parsed = parseLine(row.text, true);
    if (!parsed.csv) {
      if (!tableStarted) headRows.push(row.text);
      else tailRows.push(row.text);
      continue;
    }
    const cells = parsed.cells;
    const delimiter = parsed.delimiter;
    const first = cells.findIndex((cell) => cell.trim() !== "");
    if (first < 0) continue;
    const firstText = (cells[first] as string).replace(/\s+/g, " ").trim();

    if (!tableStarted) {
      // Программа дублирует название в скрытой ячейке справа: одинаковые подряд идущие ячейки склеиваются.
      headRows.push(cells.map((cell) => cell.replace(/\s+/g, " ").trim()).filter((cell, at, all) => cell !== "" && all.indexOf(cell) === at).join(" "));
      if (HEADER_BASE_FORM.test(row.text)) baseForm = true;
      // Нумерация граф «1, 2, 3, …» завершает шапку таблицы.
      if ((cells[0] ?? "").trim() === "1" && (cells[1] ?? "").trim() === "2" && (cells[2] ?? "").trim() === "3") tableStarted = true;
      continue;
    }

    if (afterTotals) {
      tailRows.push(cells.filter((cell) => cell.trim() !== "").join(" "));
    }

    // Итоги сметы: после последней позиции.
    if (/^Итого\s+прямые\s+затраты\s+по\s+смете\s+в\s+базисных/iu.test(firstText)) {
      flush();
      afterTotals = true;
      directBase = { total: numberCell(cells, 11, delimiter), wage: numberCell(cells, 12, delimiter), machines: numberCell(cells, 13, delimiter), machinistWage: numberCell(cells, 14, delimiter), materials: null };
      continue;
    }
    if (/^Итого\s+прямые\s+затраты\s+по\s+смете\s+с\s+учетом\s+коэффициентов/iu.test(firstText)) {
      directWithCoefficients = { total: numberCell(cells, 11, delimiter), wage: numberCell(cells, 12, delimiter), machines: numberCell(cells, 13, delimiter), machinistWage: numberCell(cells, 14, delimiter), materials: null };
      continue;
    }
    if (afterTotals) {
      const amount = numberCell(cells, 11, delimiter);
      if (/^Накладные\s+расходы\s*$/iu.test(firstText) && amount !== null) overheadTotal = amount;
      else if (/^Сметная\s+прибыль\s*$/iu.test(firstText) && amount !== null) profitTotal = amount;
      else if (/^ВСЕГО\s+по\s+смете/iu.test(firstText) && amount !== null) total = amount;
      else if (/^НДС/iu.test(firstText)) {
        const percent = /(\d+(?:[.,]\d+)?)\s*%/.exec(firstText)?.[1];
        if (percent !== undefined) vatPercent = parseRuNumber(percent);
      }
      continue;
    }

    // Разделы и подразделы.
    if (/^Раздел\s+\d+/iu.test(firstText) && first === 0) {
      flush();
      section = firstText.replace(/^Раздел\s+\d+\s*[.:)-]?\s*/iu, "").trim() || firstText;
      continue;
    }

    // Начисления НР и СП после позиции.
    const chargeCell = cells.find((cell) => CHARGE_RE.test(cell.trim()));
    if (chargeCell !== undefined && draft !== null) {
      const match = CHARGE_RE.exec(chargeCell.trim()) as RegExpExecArray;
      const amount = numberCell(cells, 11, delimiter) ?? [...cells].reverse().map((cell) => parseNumberCell(cell.trim(), delimiter)).find((value) => value !== null) ?? null;
      const charge: BimCharge = {
        ref: null,
        percent: parseRuNumber(match[2] as string),
        basePercent: null,
        base: match[3] === undefined ? null : parseRuNumber(match[3]),
        amount,
      };
      if (/^накладные/iu.test(match[1] as string)) draft.overhead = charge;
      else draft.profit = charge;
      continue;
    }

    // Начало позиции: номер и шифр.
    const number = (cells[0] ?? "").trim();
    const justification = (cells[1] ?? "").trim();
    if (/^\d+(?:\.\d+)?$/.test(number) && justification !== "" && /[A-Za-zА-Яа-яЁё]/.test(justification) && !NOTE_ROW_RE.test(justification)) {
      flush();
      const code = codeOfJustification(justification);
      draft = {
        number,
        rawCode: justification.replace(/\s+/g, " "),
        code,
        name: "",
        unit: "",
        quantity: null,
        unitPrice: EMPTY_AMOUNTS,
        baseTotal: EMPTY_AMOUNTS,
        notes: [],
        priceFormula: null,
        overhead: null,
        profit: null,
        section,
        awaitingData: false,
        gaps: [],
      };
      const nameInRow = (cells[2] ?? "").trim();
      const unitIndex = unitAnchor(cells, delimiter, 2);
      if (nameInRow !== "" || unitIndex >= 0) {
        draft.name = nameInRow.replace(/\s+/g, " ");
        readGridNumbers(draft, cells, delimiter, unitIndex);
      } else {
        draft.awaitingData = true;
      }
      continue;
    }

    if (draft === null) continue;
    const current: GridDraft = draft;

    // Вторая строка двухстрочной формы: «Приказ …» в первой ячейке, наименование во второй, числа со сдвигом на ячейку.
    if (current.awaitingData) {
      const unitIndex = unitAnchor(cells, delimiter, 2);
      if (unitIndex >= 0) {
        current.name = (cells[1] ?? "").replace(/\s+/g, " ").trim();
        current.awaitingData = false;
        readGridNumbers(current, cells, delimiter, unitIndex);
        continue;
      }
    }

    // Примечания и поправки: «ТЧ п.7», «ОП п.1.40.2», «Прил.26.2» и формулы пересчёта цены.
    const noteText = (cells[2] ?? "").trim() || (cells[1] ?? "").trim();
    const marker = (cells[1] ?? "").trim();
    if (noteText !== "" && number === "") {
      if (FORMULA_RE.test(noteText)) current.priceFormula = noteText.replace(/\s+/g, " ");
      else if (NOTE_ROW_RE.test(marker) || /ОЗП\s*=|ЭМ\s*=|ПЗ\s*=|МАТ\s*=|коэффициент/iu.test(noteText)) {
        current.notes.push(noteText.replace(/\s+/g, " "));
      }
    }
  }
  flush();

  if (!tableStarted) return { kind: "no", reason: "нет строки нумерации граф 1–17: это не таблица сметы" };
  if (!baseForm) return { kind: "no", reason: "в шапке нет граф «Осн.З/п», «Эк.Маш»: это не базисная форма таблицы" };
  if (positions.length === 0) return { kind: "no", reason: "таблица базисной сметы распознана, но позиций в ней не нашлось" };

  const headText = headRows.join("\n");
  const meta = metaOf(`${headText}\n${tailRows.join("\n")}`);
  const levelYear = /ценах\s+по\s+состоянию\s+на\s*(\d{4})/iu.exec(headText)?.[1];
  const notBim = notBaseIndexReason(positions, meta, levelYear !== undefined && Number.parseInt(levelYear, 10) <= 2005);
  if (notBim !== null) return { kind: "no", reason: notBim };
  const workName = /^\s*на\s+(.+?)\s*$/imu.exec(headText.split("\n").find((line) => /^\s*на\s+/iu.test(line)) ?? "")?.[1] ?? null;
  const constructionName = headRows[0]?.replace(/\s+/g, " ").trim() ?? null;
  const number = /ЛОКАЛЬНАЯ\s+СМЕТА\s+№\s*(\S+)/iu.exec(headText)?.[1] ?? null;
  const headTotal = /Сметная\s+стоимость\s+([\d\s.,]+?)\s+руб/iu.exec(headText.replace(/\s+/g, " "))?.[1];

  const estimate: CustomerBim = {
    documentName,
    estimateName,
    format: "GRID",
    number,
    priceLevel: levelYear !== undefined && Number.parseInt(levelYear, 10) <= 2005 ? "BASE" : "CURRENT",
    quarter: meta.quarter,
    quarterSource: meta.quarter === null ? null : "ESTIMATE",
    subjectText: meta.subjectText,
    zone: meta.zone,
    constructionName: constructionName === "" ? null : constructionName,
    workName: workName === null ? null : workName.replace(/\s+/g, " ").trim(),
    declaredBaseIndex: meta.declaredBaseIndex,
    overheadNorms: meta.overheadNorms,
    indexStatements: extractIndexStatements(`${headText}\n${tailRows.join("\n")}`),
    positions,
    directBase,
    directWithTotalCoefficients: directWithCoefficients,
    overheadTotal,
    profitTotal,
    total: total ?? (headTotal === undefined ? null : parseRuNumber(headTotal.replace(/,(?=\d{3}\b)/g, ""))),
    totalBase: null,
    smrTotal: null,
    smrTotalBase: null,
    equipmentTotal: null,
    vatPercent,
    positionsTotal: round2(positions.reduce((sum, position) => sum + (position.positionBaseTotal ?? 0), 0)),
  };
  return { kind: "ok", estimate };
}

function readGridNumbers(draft: GridDraft, cells: readonly string[], delimiter: string, unitIndex: number): void {
  if (unitIndex < 0) {
    draft.gaps.push("не найдена единица измерения");
    return;
  }
  draft.unit = (cells[unitIndex] ?? "").replace(/\s+/g, " ").trim();
  draft.quantity = numberCell(cells, unitIndex + 1, delimiter);
  const family = familyOfCode(draft.code).family;
  const supply = family === "MATERIAL" || family === "TRANSPORT" || family === "CUSTOMER_PRICE";
  draft.unitPrice = amountsAt(cells, delimiter, unitIndex, 2, supply);
  draft.baseTotal = amountsAt(cells, delimiter, unitIndex, 6, supply);
}

/* ------------------------------ Поток текста (PDF Гранд-Сметы) ------------------------------ */

const NUM = String.raw`\d{1,3}(?: \d{3})*,\d+|\d+,\d+|\d+`;
const CODE = String.raw`(?:ФЕР[а-яА-Я]{0,2}\d{2}-\d{2}-\d{3}-\d{2}|ТЕР[а-яА-Я]{0,2}\d{2}-\d{2}-\d{3}-\d{2}|ТСН[^\s]*|ФССЦ(?:пг)?-[\d.\-]+|ТЦ_\S+)`;
/** Заголовок позиции: номер и шифр; единица, объём, коэффициент и объём с коэффициентом читаются из хвоста (`headerTail`). */
const HEADER_RE = new RegExp(String.raw`(?<![\d.,])(\d{1,3}(?:\.\d{1,2})?) (${CODE})(?= )`, "gu");
const GROUP_RE = new RegExp(String.raw`(?<=^|\n|[\d] )([1-4]) (${NUM}) (\d(?:,\d+)?) (${NUM}) (\d+,\d{2})(?: (${NUM}))?(?= |\n|$)`, "gu");
/** Группа без графы коэффициента (материалы с коэффициентом 1 его не печатают): «4 2 212,73 4 425,46 9,39 41 555,07». */
const GROUP_NO_COEFFICIENT_RE = new RegExp(String.raw`(?<=^|\n|[\d] )([1-4]) (${NUM}) (${NUM}) (\d+,\d{2})(?: (${NUM}))?(?= |\n|$)`, "gu");
const CHARGE_STREAM_RE = new RegExp(String.raw`Пр/(812|774)-([\d.]+(?:-\d+)?) % (\d+(?:,\d+)?) (\d+(?:,\d+)?) (${NUM}) (${NUM})`, "gu");
const LSR_START_RE = /Приложение\s*№\s*2\s+Утверждено\s+приказом\s+Минстроя\s+РФ\s*№\s*421/giu;

const TAIL_NUMBER = /^\d+(?:,\d+)?$/;

interface HeaderTail {
  readonly unit: string;
  readonly quantity: number;
  readonly coefficient: number;
  readonly quantityTotal: number;
  /** Длина разобранного хвоста, знаков от конца шифра. */
  readonly length: number;
}

/**
 * Хвост заголовка: «шт 2 1 2», «100 м3 0,3 1 0,3», «1 т груза 0,19 1 0,19» — единица, объём, коэффициент, объём с коэффициентом.
 * Единица может кончаться цифрой («м3») и содержать число («100 м»), поэтому границу ищет не регулярное выражение, а сама
 * арифметика: объём × коэффициент = объём с коэффициентом.
 */
export function headerTail(tail: string): HeaderTail | null {
  const line = tail.slice(0, 120).split("\n")[0] ?? "";
  const tokens = line.split(" ").filter((token) => token !== "");
  // Единица занимает до четырёх слов; число перед ней («100 м») тоже слово.
  for (let at = 0; at <= Math.min(4, tokens.length - 3); at += 1) {
    const [q, c, t] = [tokens[at], tokens[at + 1], tokens[at + 2]];
    if (q === undefined || c === undefined || t === undefined) continue;
    if (!TAIL_NUMBER.test(q) || !TAIL_NUMBER.test(c) || !TAIL_NUMBER.test(t)) continue;
    // Слово единицы перед объёмом обязательно: пустая единица допустима только у «шт»-подобных строк без слова — их нет.
    if (at === 0) continue;
    const quantity = parseRuNumber(q);
    const coefficient = parseRuNumber(c);
    const total = parseRuNumber(t);
    if (quantity === null || coefficient === null || total === null) continue;
    if (Math.abs(quantity * coefficient - total) > Math.max(0.0005, Math.abs(total) * 0.001)) continue;
    const unit = tokens.slice(0, at).join(" ");
    if (!/[А-Яа-яA-Za-z]/.test(unit)) continue;
    const consumed = tokens.slice(0, at + 3).join(" ");
    return { unit, quantity, coefficient, quantityTotal: total, length: line.indexOf(consumed) + consumed.length };
  }
  return null;
}

function numOrNull(value: string | undefined): number | null {
  return value === undefined ? null : parseRuNumber(value);
}

/** Группы строк «1 ОТ / 2 ЭМ / 3 в т. ч. ОТм / 4 М»: цена расценки, коэффициент, итого в базисных, индекс, итого в текущих. */
interface StreamGroup {
  readonly unit: number | null;
  readonly coefficient: number | null;
  readonly base: number | null;
  readonly index: number | null;
  readonly current: number | null;
}

interface GroupCandidate {
  readonly number: number;
  readonly start: number;
  readonly end: number;
  readonly group: StreamGroup;
}

/** Окно поиска чисел позиции за её заголовком: числа лежат на следующей странице, иногда за заголовками соседних позиций. */
const CHAIN_WINDOW = 30_000;
/** Хвост позиции за группами: часы, итого по расценке, ФОТ, НР, СП, «Всего по позиции». */
const CHARGES_WINDOW = 700;

/**
 * Группы строк позиции, найденные в `text` начиная с `from`: «1 ОТ / 2 ЭМ / 3 ОТм / 4 М» подряд по возрастанию. Принимается только
 * цепочка, где сходится арифметика строки: цена × коэффициент × объём = итого в базисных, итого × индекс = в текущих. Без этого
 * «1 533,62 1 183,48» читалось бы как группа 1 с ценой 533,62 (а это число 1 533,62 и следующая группа с ценой 183,48), а числа
 * соседних позиций с другим объёмом принимались бы за свои. Допуск на объём тесный (0,005 %): позиции 1,219 и 1,218 различимы.
 * Уже занятые другой позицией цепочки (`claimed`) пропускаются: числа идут в порядке заголовков.
 */
function findChain(text: string, from: number, quantity: number, claimed: ReadonlySet<number>): { groups: Map<number, StreamGroup>; start: number; end: number } | null {
  const window = text.slice(from, from + CHAIN_WINDOW);
  const candidates: GroupCandidate[] = [];
  const consider = (start: number, length: number, number: number, group: StreamGroup): boolean => {
    const { unit, coefficient, base, index, current } = group;
    // Цена группы больше нуля: «2 0 0 0,00 6,22» из строки ресурса арифметике «нуль × нуль = нуль» удовлетворяет, но группой не является.
    const consistent =
      unit !== null &&
      unit > 0 &&
      coefficient !== null &&
      base !== null &&
      index !== null &&
      Math.abs(unit * coefficient * quantity - base) <= Math.max(0.011, Math.abs(base) * 0.00005) &&
      (current === null || Math.abs(base * index - current) <= Math.max(0.05, Math.abs(current) * 0.0005));
    if (consistent) candidates.push({ number, start, end: start + length, group });
    return consistent;
  };
  const withCoefficient = new RegExp(GROUP_RE.source, "gu");
  for (let match = withCoefficient.exec(window); match !== null; match = withCoefficient.exec(window)) {
    const accepted = consider(match.index, match[0].length, Number.parseInt(match[1] as string, 10), {
      unit: numOrNull(match[2]),
      coefficient: numOrNull(match[3]),
      base: numOrNull(match[4]),
      index: numOrNull(match[5]),
      current: numOrNull(match[6]),
    });
    if (!accepted) withCoefficient.lastIndex = match.index + 1;
  }
  const withoutCoefficient = new RegExp(GROUP_NO_COEFFICIENT_RE.source, "gu");
  for (let match = withoutCoefficient.exec(window); match !== null; match = withoutCoefficient.exec(window)) {
    const start = match.index;
    if (candidates.some((candidate) => candidate.start === start)) continue;
    const accepted = consider(start, match[0].length, Number.parseInt(match[1] as string, 10), {
      unit: numOrNull(match[2]),
      coefficient: 1,
      base: numOrNull(match[3]),
      index: numOrNull(match[4]),
      current: numOrNull(match[5]),
    });
    if (!accepted) withoutCoefficient.lastIndex = start + 1;
  }
  candidates.sort((a, b) => a.start - b.start);
  let chain: GroupCandidate[] = [];
  const flush = (): { groups: Map<number, StreamGroup>; start: number; end: number } | null => {
    const first = chain[0];
    const last = chain[chain.length - 1];
    if (first === undefined || last === undefined || claimed.has(from + first.start)) return null;
    return { groups: new Map(chain.map((item) => [item.number, item.group] as const)), start: from + first.start, end: from + last.end };
  };
  for (const candidate of candidates) {
    const last = chain[chain.length - 1];
    if (last !== undefined && !(candidate.number > last.number && candidate.start - last.end <= 1)) {
      const found = flush();
      if (found !== null) return found;
      chain = [];
    }
    chain.push(candidate);
  }
  return flush();
}

function streamCharge(body: string, kind: "812" | "774"): BimCharge | null {
  for (const match of body.matchAll(CHARGE_STREAM_RE)) {
    if (match[1] !== kind) continue;
    return {
      ref: `Пр/${kind}-${match[2] as string}`,
      percent: numOrNull(match[4]),
      basePercent: numOrNull(match[3]),
      // ФОТ в базисных ценах = база начисления; сумма — в базисных ценах (текущая — в следующем числе).
      base: null,
      amount: numOrNull(match[5]),
    };
  }
  return null;
}

/** Числа сразу за заголовком позиции-поставки: «цена, итого в базисных, индекс, итого в текущих, затем те же итоги». */
function supplyNumbers(afterHeader: string): number[] {
  const numbers: number[] = [];
  const re = new RegExp(String.raw`^ ?(${NUM})(?= |\n|$)`, "u");
  let rest = afterHeader;
  while (numbers.length < 8) {
    const match = re.exec(rest);
    if (match === null) break;
    const value = parseRuNumber(match[1] as string);
    if (value === null) break;
    numbers.push(value);
    rest = rest.slice(match[0].length);
  }
  return numbers;
}

interface StreamChunk {
  readonly text: string;
}

/**
 * Локальные сметы потока: по преамбуле «Приложение № 2 … 421», каждая — отдельный кусок текста. Всё, что стоит до первой сметы
 * (ССР, пояснительная записка того же файла), — `narrative`: там названы индексы и квартал.
 */
function streamChunks(text: string): { narrative: string; chunks: StreamChunk[] } {
  const starts = [...text.matchAll(LSR_START_RE)].map((match) => match.index ?? 0);
  if (starts.length === 0) return { narrative: "", chunks: [{ text }] };
  return {
    narrative: text.slice(0, starts[0]),
    chunks: starts.map((start, index) => ({ text: text.slice(start, starts[index + 1] ?? text.length) })),
  };
}

/**
 * Куски текста-потока, которые читаются как БИМ-смета: `text.slice(start, end)`; пусто, если текст не поток формы 421/пр с шифрами
 * ФЕР/ТЕР. Те же куски, что у `parseCustomerBim`; нужны бенчмарку «вслепую» (`estimateRemoval.ts`), чтобы вырезать их из входа расчёта.
 */
export function bimStreamSpans(documentName: string, text: string): { readonly start: number; readonly end: number }[] {
  if (!looksLikeStream(text)) return [];
  const starts = [...text.matchAll(LSR_START_RE)].map((match) => match.index ?? 0);
  const spans: { start: number; end: number }[] = [];
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? text.length;
    if (parseStreamChunk(documentName, text.slice(start, end), index) !== null) spans.push({ start, end });
  });
  return spans;
}

function parseStreamChunk(documentName: string, chunkText: string, index: number): CustomerBim | null {
  const text = normalizeSplitYear(chunkText.replace(/[ \t ]+/g, " "));
  const headers = [...text.matchAll(HEADER_RE)] as RegExpExecArray[];
  if (headers.length === 0) return null;

  // Заголовки читаются вместе с хвостом (единица, объём, коэффициент): без хвоста совпадение — упоминание шифра в тексте.
  const parsedHeaders: Array<{ header: RegExpExecArray; tail: HeaderTail; end: number }> = [];
  for (const header of headers) {
    const from = (header.index ?? 0) + header[0].length;
    const tail = headerTail(text.slice(from + 1, from + 130));
    if (tail !== null) parsedHeaders.push({ header, tail, end: from + 1 + tail.length });
  }
  if (parsedHeaders.length === 0) return null;

  const head = text.slice(0, parsedHeaders[0]?.header.index ?? 0);
  const meta = metaOf(head);
  const number = /ЛОКАЛЬНЫЙ\s+СМЕТНЫЙ\s+РАСЧ[ЕЁ]Т\s*\(СМЕТА\)\s*№\s*(\S+)/iu.exec(head)?.[1] ?? null;
  const construction = nameBefore(head, "(наименование стройки)", ["(проектная и (или) иная техническая документация)", "(01.01.2001)"]);
  const workName = nameBefore(head, "(наименование работ и затрат)", ["тыс.руб.", "чел.час."]);
  const headTotals = /Сметная стоимость\s+([\d ]+,\d+)\s+\(([\d ]+,\d+)\)\s+тыс/u.exec(head);
  const headPart = (label: string): { current: number; base: number } | null => {
    const found = new RegExp(String.raw`${label}\s+(${NUM})\s+\((${NUM})\)\s+тыс`, "u").exec(head);
    const current = numOrNull(found?.[1]);
    const base = numOrNull(found?.[2]);
    return current === null || base === null ? null : { current: round2(current * 1000), base: round2(base * 1000) };
  };
  const building = headPart("строительных работ");
  const installation = headPart("монтажных работ");
  const equipment = headPart("оборудования");

  const positions: BimPosition[] = [];
  // Цепочки групп, уже отданные позициям: числа идут в порядке заголовков, но не обязательно вплотную к ним.
  const claimed = new Set<number>();
  parsedHeaders.forEach(({ header, tail, end }, position) => {
    const afterHeader = text.slice(end);
    const bodyEnd = parsedHeaders[position + 1]?.header.index ?? text.length;
    const body = text.slice(end, bodyEnd);
    const code = header[2] as string;
    const { family, book, rateCode } = familyOfCode(code);
    const quantity = tail.quantity;
    const coefficient = tail.coefficient;
    const unit = tail.unit;
    const gaps: string[] = [];
    const supply = family === "MATERIAL" || family === "TRANSPORT" || family === "CUSTOMER_PRICE";

    let unitPrice: BimAmounts = EMPTY_AMOUNTS;
    let baseTotal: BimAmounts = EMPTY_AMOUNTS;
    let currentTotal: BimAmounts | null = null;
    let indices: BimAppliedIndices | null = null;
    let overhead: BimCharge | null = null;
    let profit: BimCharge | null = null;
    let positionBase: number | null = null;
    let positionCurrent: number | null = null;
    let chainGroups: ReadonlyMap<number, StreamGroup> = new Map();

    if (supply) {
      // Поставка: цена, итого в базисных, индекс, итого в текущих — числа сразу за заголовком.
      const nums = supplyNumbers(afterHeader);
      // Числа за заголовком поставки принимаются, только если сходится арифметика: цена × объём = итог, итог × индекс = в текущих.
      const consistent =
        nums.length >= 4 &&
        Math.abs((nums[0] as number) * quantity * coefficient - (nums[1] as number)) <= Math.max(0.05, (nums[1] as number) * 0.01) &&
        Math.abs((nums[1] as number) * (nums[2] as number) - (nums[3] as number)) <= Math.max(0.05, (nums[3] as number) * 0.005);
      if (consistent) {
        unitPrice = { total: nums[0] as number, wage: null, machines: null, machinistWage: null, materials: nums[0] as number };
        baseTotal = { total: nums[1] as number, wage: null, machines: null, machinistWage: null, materials: nums[1] as number };
        currentTotal = { total: nums[3] as number, wage: null, machines: null, machinistWage: null, materials: nums[3] as number };
        indices = { labour: null, machines: nums[2] as number, machinistLabour: null, materials: nums[2] as number };
        positionBase = nums[1] as number;
        positionCurrent = nums[3] as number;
        // Для перевозки индекс — один на статью (ЭММ/МАТ у перевозки совпадают в смете), ставим его на материалы и машины.
      } else {
        gaps.push("не прочитаны цена, итоги и индекс поставки");
      }
    } else {
      const chain = findChain(text, end, quantity, claimed);
      const groups = chain?.groups ?? new Map<number, StreamGroup>();
      if (chain !== null) claimed.add(chain.start);
      chainGroups = groups;
      const g = (n: number): StreamGroup | undefined => groups.get(n);
      const wage = g(1);
      const machines = g(2);
      const machinist = g(3);
      const materials = g(4);
      if (chain === null) gaps.push("не прочитаны группы затрат (ОТ, ЭМ, М)");
      unitPrice = {
        total: null,
        wage: wage?.unit ?? null,
        machines: machines?.unit ?? null,
        machinistWage: machinist?.unit ?? null,
        materials: materials?.unit ?? null,
      };
      baseTotal = {
        total: null,
        wage: wage?.base ?? null,
        machines: machines?.base ?? null,
        machinistWage: machinist?.base ?? null,
        materials: materials?.base ?? null,
      };
      currentTotal = {
        total: null,
        wage: wage?.current ?? null,
        machines: machines?.current ?? null,
        machinistWage: machinist?.current ?? null,
        materials: materials?.current ?? null,
      };
      indices = {
        labour: wage?.index ?? null,
        machines: machines?.index ?? null,
        machinistLabour: machinist?.index ?? null,
        materials: materials?.index ?? null,
      };
      if (chain !== null) {
        // За группами — часы, итого по расценке, ФОТ, НР и СП, «Всего по позиции»: всё это укладывается в несколько сотен знаков.
        const afterChain = text.slice(chain.end, chain.end + CHARGES_WINDOW);
        overhead = streamCharge(afterChain, "812");
        profit = streamCharge(afterChain, "774");
        // «Всего по позиции»: два числа после СП — в базисных и текущих ценах.
        const lastProfit = [...afterChain.matchAll(CHARGE_STREAM_RE)].filter((match) => match[1] === "774")[0];
        if (lastProfit !== undefined) {
          const totals = supplyNumbers(afterChain.slice((lastProfit.index ?? 0) + lastProfit[0].length));
          if (totals.length >= 2) {
            positionBase = totals[0] as number;
            positionCurrent = totals[1] as number;
          }
        }
        // «Всего по позиции» иногда уходит на следующую страницу за колонтитул: тогда итог собирается из напечатанных частей.
        if (positionCurrent === null) {
          const indexLabour = wage?.index ?? machinist?.index ?? 1;
          const charges = (overhead?.amount ?? 0) + (profit?.amount ?? 0);
          const parts = (wage?.current ?? 0) + (machines?.current ?? 0) + (materials?.current ?? 0);
          if (parts > 0) {
            positionBase = round2((wage?.base ?? 0) + (machines?.base ?? 0) + (materials?.base ?? 0) + charges);
            positionCurrent = round2(parts + charges * indexLabour);
          }
        }
      }
    }

    positions.push({
      number: header[1] as string,
      code,
      rawCode: code,
      family,
      book,
      rateCode,
      name: "",
      unit,
      quantity,
      unitPrice,
      baseTotal,
      coefficients: supply ? parseCoefficients([]) : streamCoefficients(body, chainGroups),
      positionCoefficient: coefficient,
      overhead,
      profit,
      indices,
      currentTotal,
      positionBaseTotal: positionBase,
      positionCurrentTotal: positionCurrent,
      priceFormula: null,
      section: null,
      gaps,
    });
  });

  if (notBaseIndexReason(positions, meta, false) !== null) return null;

  const currentThousands = headTotals?.[1] === undefined ? null : parseRuNumber(headTotals[1]);
  const baseThousands = headTotals?.[2] === undefined ? null : parseRuNumber(headTotals[2]);
  const positionsTotal = round2(positions.reduce((sum, position) => sum + (position.positionCurrentTotal ?? position.positionBaseTotal ?? 0), 0));
  return {
    documentName,
    estimateName: number === null ? `смета ${String(index + 1)}` : `ЛСР № ${number}`,
    format: "STREAM",
    number,
    priceLevel: "CURRENT",
    quarter: quarterIn(normalizeSplitYear(text)),
    quarterSource: quarterIn(normalizeSplitYear(text)) === null ? null : "ESTIMATE",
    subjectText: meta.subjectText,
    zone: meta.zone,
    constructionName: construction,
    workName,
    declaredBaseIndex: meta.declaredBaseIndex,
    overheadNorms: meta.overheadNorms,
    indexStatements: extractIndexStatements(chunkText),
    positions,
    directBase: null,
    directWithTotalCoefficients: null,
    overheadTotal: null,
    profitTotal: null,
    total: currentThousands === null ? null : round2(currentThousands * 1000),
    totalBase: baseThousands === null ? null : round2(baseThousands * 1000),
    smrTotal: building === null && installation === null ? null : round2((building?.current ?? 0) + (installation?.current ?? 0)),
    smrTotalBase: building === null && installation === null ? null : round2((building?.base ?? 0) + (installation?.base ?? 0)),
    equipmentTotal: equipment?.current ?? null,
    vatPercent: null,
    positionsTotal,
  };
}

/**
 * Коэффициенты позиции потока: те, что напечатаны в графе «коэффициенты» каждой группы (ОТ, ЭМ, ОТм, М). Положительные условия
 * (1,2 и 1,15) программа складывает (1,35), а понижающие (0,7 для демонтажа) умножает — пересчитывать их из названий
 * строк незачем, а перемножение «1,2 × 1,15» дало бы 1,38 вместо напечатанного 1,35.
 */
function streamCoefficients(body: string, groups: ReadonlyMap<number, StreamGroup>): BimCoefficients {
  const notes = coefficientNotes(body);
  const parsed = parseCoefficients(notes);
  const printed = (n: number, fallback: number): number => groups.get(n)?.coefficient ?? fallback;
  return {
    wage: printed(1, parsed.wage),
    machines: printed(2, parsed.machines),
    machinistWage: printed(3, parsed.machinistWage),
    materials: printed(4, parsed.materials),
    notes,
    hasUnparsed: false,
  };
}

/** Название, стоящее перед подписью «(наименование …)»: от ближайшего якоря шапки до подписи; скобки внутри названия сохраняются. */
function nameBefore(head: string, marker: string, anchors: readonly string[]): string | null {
  const at = head.lastIndexOf(marker);
  if (at < 0) return null;
  let start = 0;
  for (const anchor of anchors) {
    const found = head.lastIndexOf(anchor, at);
    if (found >= 0) start = Math.max(start, found + anchor.length);
  }
  const name = head.slice(start, at).replace(/\s+/g, " ").replace(/^[\d\s,.]+/, "").trim();
  return name === "" ? null : name.slice(-300);
}

/** Строки с коэффициентами позиции в куске потока: между заголовком и следующей позицией. */
function coefficientNotes(body: string): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/([^\n]*?(?:ОЗП|ЭМ|ПЗ)\s*=\s*\d+(?:,\d+)?[^\n]*?)(?=\n|$)/gu)) {
    const note = (match[1] as string).replace(/\s+/g, " ").trim();
    // Коэффициенты в потоке сняты с названий нормативных строк («ОЗП=1,2; ЭМ=1,2 к расх.; ЗПМ=1,2; ТЗ=1,2; ТЗМ=1,2»).
    for (const part of note.split(/(?=ОЗП\s*=)/u)) {
      const cleaned = part.trim();
      if (cleaned !== "" && !seen.has(cleaned)) {
        seen.add(cleaned);
        notes.push(cleaned);
      }
    }
  }
  return notes;
}

/* ------------------------------ Точка входа ------------------------------ */

/** Это текст потока Гранд-Сметы по форме 421/пр с шифрами ФЕР/ТЕР/ФССЦ: заголовки позиций находятся. */
function looksLikeStream(text: string): boolean {
  HEADER_RE.lastIndex = 0;
  const found = HEADER_RE.test(text.replace(/[ \t ]+/g, " "));
  HEADER_RE.lastIndex = 0;
  return found && /(?:ФЕР|ТЕР|ФССЦ)/u.test(text);
}

/**
 * Сметы заказчика на БИМ из текстов документов. Таблица — отрезки как у `parseCustomerEstimates` (лист или файл до «ВСЕГО по
 * смете»); поток текста — по одной смете на преамбулу формы приложения 2 к 421/пр. Что не БИМ (форма 421/пр, ресурсный
 * метод, нет шифров ФЕР/ТЕР) — молча пропускается: это не «не распознано», а чужой метод.
 */
export function parseCustomerBim(documents: readonly DocumentText[]): CustomerBimParse {
  const found: CustomerBim[] = [];
  const narratives: string[] = [];
  const notRecognized: NotRecognizedEstimate[] = [];

  for (const document of documents) {
    let gridFound = false;
    for (const segment of splitCustomerEstimates(document)) {
      if (segment.noise) continue;
      const result = parseGridSegment(document.name, segment.estimate.estimateName, segment.text);
      if (result.kind === "ok") {
        gridFound = true;
        found.push(result.estimate);
      }
    }
    if (gridFound) continue;
    if (!looksLikeStream(document.text)) continue;

    const before = found.length;
    const split = streamChunks(document.text);
    narratives.push(split.narrative.slice(0, MAX_NARRATIVE));
    split.chunks.forEach((chunk, index) => {
      const estimate = parseStreamChunk(document.name, chunk.text, index);
      if (estimate !== null) found.push(estimate);
    });
    if (found.length === before) {
      notRecognized.push({ documentName: document.name, estimateName: null, reason: "поток текста БИМ-сметы: позиции с шифрами найдены, но числа не разобрались" });
    }
  }
  if (found.length === 0) return { estimates: found, notRecognized };

  // Индексы и квартал называет пояснительная записка — обычно другой файл закупки, чем сами локальные сметы.
  const estimateDocuments = new Set(found.map((estimate) => estimate.documentName));
  const shared: BimIndexStatement[] = narratives.flatMap((text) => extractIndexStatements(text));
  for (const document of documents) {
    if (estimateDocuments.has(document.name)) continue;
    shared.push(...extractIndexStatements(document.text.slice(0, MAX_NARRATIVE)));
  }
  const sharedQuarter = latestQuarter(shared);
  const estimates = found.map((estimate) => {
    const own = estimate.indexStatements;
    const ownQuarter = estimate.quarter;
    const quarter = ownQuarter ?? sharedQuarter;
    return {
      ...estimate,
      quarter,
      quarterSource: ownQuarter !== null ? ("ESTIMATE" as const) : quarter !== null ? ("TEXT" as const) : null,
      indexStatements: [...own, ...shared.filter((statement) => !own.some((item) => item.kind === statement.kind && item.text === statement.text))],
    };
  });
  return { estimates, notRecognized };
}

/** Пояснительная записка читается не дальше этого числа знаков: нужные фразы стоят в начале, а тексты бывают в мегабайт. */
const MAX_NARRATIVE = 400_000;

function latestQuarter(statements: readonly BimIndexStatement[]): QuarterMark | null {
  let best: QuarterMark | null = null;
  for (const statement of statements) {
    const quarter = statement.quarter;
    if (quarter === undefined) continue;
    if (best === null || quarter.year > best.year || (quarter.year === best.year && quarter.quarter > best.quarter)) best = quarter;
  }
  return best;
}
