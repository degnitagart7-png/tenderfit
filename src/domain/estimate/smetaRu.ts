import type { CustomerNormBase } from "@/domain/estimate/customerEstimate";

/**
 * Выгрузка локальной сметы из программы «Smeta.RU»: признаки программы, метод и база из шапки, строки поправок.
 *
 * Зачем. Smeta.RU печатает ту же форму 421/пр (12 граф), что и Гранд-Смета, но по-своему: итоговая строка позиции
 * «Всего по позиции» несёт первым числом стоимость на единицу измерения, а стоимость позиции — вторым; поправки к норме
 * идут строкой без ссылки на приказ («ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7»); подраздел закрывается строкой «Итого по разделу»;
 * в конце файла лежат служебные листы программы (`Source`, `EtalonRes`…) с дампом её базы. Построчный разбор
 * (`customerLsr.ts`) и разбор итогов (`customerEstimate.ts`) учитывают это, только когда выгрузка названа здесь.
 *
 * Модуль чистый и ни от чего не зависит, кроме типа базы: им пользуются оба разбора и разбор коэффициентов.
 *
 * Метод шапки. «Составлен | Ресурсно-индексным | методом» — ресурсно-индексная смета (ФСНБ-2022), «Базисно-индексным» — смета
 * в базисных ценах 2000 года с индексами. Приказ 421/пр в перечне редакций нормативов называют обе, поэтому по одному
 * «421/пр» метод не определяется: смета по ТСН или ФЕР, ссылающаяся на 421/пр, считалась бы ресурсной.
 */

/** Программа, в которой составлена смета. */
export type SmetaProgram = "SMETA_RU";

/** Метод составления сметы по её шапке. */
export type SmetaMethod = "RESOURCE_INDEX" | "BASE_INDEX";

export interface SmetaRuInfo {
  readonly program: SmetaProgram;
  /** «версия 12» из строки программы; null — версия не названа. */
  readonly version: number | null;
  /** Метод по фразе шапки «Составлен … методом»; null — фразы нет (смета ТСН-2001 её не печатает). */
  readonly method: SmetaMethod | null;
  /** База норм, если она не ФСНБ-2022 (ТСН-2001 Москвы). */
  readonly base: CustomerNormBase | null;
}

/** Строка программы в шапке: «Smeta.RU  (495) 974-1589» или «Программа для ЭВМ «Программа: «Smeta.RU» версия 12»». */
const PROGRAM_LINE_RE = /Smeta\.RU\s*\(\d{3}\)\s*\d{3}-\d{2}-?\d{2}/iu;
const PROGRAM_NAME_RE = /Программа:\s*[«"„“]*\s*Smeta\.RU/iu;
const VERSION_RE = /Smeta\.RU\s*[»"”]*\s*версия\s*(\d+)/iu;

/** Сколько знаков в начале текста сметы читается как шапка. */
const HEAD_LENGTH = 8_000;

/**
 * Это выгрузка из Smeta.RU: в шапке названа программа. Слова «программа Smeta.ru в формате смет АРПС» в проекте
 * контракта — упоминание, а не выгрузка: нужна именно строка программы с телефоном или «Программа: «Smeta.RU»».
 */
export function isSmetaRuText(text: string): boolean {
  const head = text.length > HEAD_LENGTH ? text.slice(0, HEAD_LENGTH) : text;
  return PROGRAM_LINE_RE.test(head) || PROGRAM_NAME_RE.test(head);
}

/**
 * Служебные листы Smeta.RU: дамп базы программы рядом со сметой. Строки в них — не смета, а «0,Smeta.RU (495) …,_PS_,…» и
 * числа через запятую; итоги и разделы из них не читаются.
 */
const SERVICE_SHEETS = new Set(["source", "sourceobsm", "smtres", "etalonres", "srcpoprs", "srcka", "srccoef", "srcobsm"]);

export function isSmetaRuServiceSheet(sheetName: string | null): boolean {
  return sheetName !== null && SERVICE_SHEETS.has(sheetName.trim().toLowerCase());
}

/** Фраза шапки ЛСР: «Составлен базисно-индексным методом»; в CSV слова разнесены по ячейкам: «Составлен ,ресурсно-индексным,методом». */
const HEADER_BASE_INDEX_RE = /Составлен[а-яё()]*[\s,;:"|]*базисно[\s-]*индексн[а-яё]*[\s,;:"|]*метод/iu;
const HEADER_RESOURCE_INDEX_RE = /Составлен[а-яё()]*[\s,;:"|]*ресурсно[\s-]*индексн[а-яё]*[\s,;:"|]*метод/iu;

/** Метод, прямо названный в шапке сметы. Названы оба (склеенные сметы) — решает тот, что встретился первым. */
export function methodOfHeader(text: string): SmetaMethod | null {
  const head = text.length > HEAD_LENGTH * 4 ? text.slice(0, HEAD_LENGTH * 4) : text;
  const base = HEADER_BASE_INDEX_RE.exec(head);
  const resource = HEADER_RESOURCE_INDEX_RE.exec(head);
  if (base === null && resource === null) return null;
  if (base !== null && resource !== null) return base.index < resource.index ? "BASE_INDEX" : "RESOURCE_INDEX";
  return base !== null ? "BASE_INDEX" : "RESOURCE_INDEX";
}

const TSN_2001_RE = /(?<![\p{L}\d])тсн[\s-]*2001(?!\d)/iu;
/** ТСН-2001 других субъектов (Московской области, Санкт-Петербурга и т. д.) — не Москва: территориальные базы у них свои. */
const OTHER_TSN_RE = /санкт[\s-]*петербург|ленинградск|московск\p{L}*\s+област|татарстан|ТСН-2001\s*МО(?![\p{L}])/iu;

/**
 * База норм: ТСН-2001 Москвы по названию в шапке («Смета по ТСН-2001(с доп.43», «Составлен(а) по ТСН-2001 с учетом Дополнения № 81»).
 * Территориальная база другого субъекта не считается Москвой: null, а метод остаётся «базисным» по прочим признакам.
 */
export function normBaseOf(text: string): CustomerNormBase | null {
  if (!TSN_2001_RE.test(text)) return null;
  return OTHER_TSN_RE.test(text) ? null : "TSN_2001_MOSCOW";
}

/** Смета по форме с 11 графами (Форма № 4б ТСН-2001): над нумерацией «1…11» стоят «Шифр расценки и коды ресурсов» и «ВСЕГО затрат в текущем уровне цен». */
export function isTsnFormHead(head: string): boolean {
  return TSN_2001_RE.test(head) && /Шифр\s+расценки/iu.test(head);
}

/** Выгрузка Smeta.RU целиком: программа, версия, метод и база. null — это не Smeta.RU. */
export function detectSmetaRu(text: string): SmetaRuInfo | null {
  if (!isSmetaRuText(text)) return null;
  const version = VERSION_RE.exec(text.slice(0, HEAD_LENGTH));
  return {
    program: "SMETA_RU",
    version: version === null ? null : Number.parseInt(version[1] as string, 10),
    method: methodOfHeader(text),
    base: normBaseOf(text.slice(0, HEAD_LENGTH * 4)),
  };
}

/* ------------------------------ Поправки к норме ------------------------------ */

/**
 * Поправки Smeta.RU: «ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7; НР *0,9; СП *0,85». Множитель стоит после «*», а не после «=»,
 * как в Гранд-Смете («ОЗП=1,2»): ЗТ — затраты труда рабочих, ЭМ — эксплуатация машин, ЗТм — затраты труда машинистов,
 * М — материалы, НР и СП — нормативы накладных расходов и сметной прибыли.
 */
const STAR_FACTOR_RE = /(?<![\p{L}])(ОЗП|ЗПМ|ТЗМ|ЗТм|ЗТ|ТЗ|ЭМ|МАТ|М|НР|СП)\s*\*\s*(\d+(?:[.,]\d+)?)/giu;

/** В тексте есть хотя бы одна поправка вида «ЗТ *0,7». */
export function hasStarFactors(text: string): boolean {
  return new RegExp(STAR_FACTOR_RE.source, STAR_FACTOR_RE.flags).test(text);
}

export interface StarFactors {
  /** ЗТ (ОЗП, ТЗ): к труду рабочих. */
  readonly labour: readonly number[];
  /** ЭМ: к эксплуатации машин. */
  readonly machines: readonly number[];
  /** ЗТм (ЗПМ, ТЗМ): к труду машинистов. */
  readonly machinist: readonly number[];
  /** М (МАТ): к материалам. */
  readonly materials: readonly number[];
  /** НР и СП: множители к нормативам начислений — в поправку на разборку не входят. */
  readonly accruals: readonly number[];
}

/** Разбор поправок вида «ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7». */
export function starFactors(text: string): StarFactors {
  const labour: number[] = [];
  const machines: number[] = [];
  const machinist: number[] = [];
  const materials: number[] = [];
  const accruals: number[] = [];
  const pattern = new RegExp(STAR_FACTOR_RE.source, STAR_FACTOR_RE.flags);
  for (const match of text.matchAll(pattern)) {
    const key = (match[1] as string).toUpperCase();
    const value = Number((match[2] as string).replace(",", "."));
    if (!Number.isFinite(value)) continue;
    if (key === "ЗТ" || key === "ТЗ" || key === "ОЗП") labour.push(value);
    else if (key === "ЭМ") machines.push(value);
    else if (key === "ЗТМ" || key === "ЗПМ" || key === "ТЗМ") machinist.push(value);
    else if (key === "М" || key === "МАТ") materials.push(value);
    else accruals.push(value);
  }
  return { labour, machines, machinist, materials, accruals };
}
