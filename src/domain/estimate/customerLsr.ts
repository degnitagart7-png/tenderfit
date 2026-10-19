import {
  parseLine,
  parseNumberCell,
  sectionAt,
  sectionHeadings,
  splitCustomerEstimates,
  type CustomerNormBase,
  type DocumentText,
  type ParsedLine,
} from "@/domain/estimate/customerEstimate";
import { declaredPriceLevel, monthQuarterIn, quarterIn, type DeclaredPriceLevel } from "@/domain/estimate/priceLevel";
import { classifyResourceCode } from "@/domain/estimate/resourceKinds";
import {
  detectSmetaRu,
  hasStarFactors,
  isSmetaRuServiceSheet,
  isSmetaRuText,
  isTsnFormHead,
  normBaseOf,
  type SmetaMethod,
  type SmetaProgram,
} from "@/domain/estimate/smetaRu";

/**
 * Построчный разбор локальной сметы заказчика (форма — Приложение 2 к Методике
 * 421/пр, 12 граф): позиции, их ресурсы, начисления и итоги.
 *
 * Зачем. По 44-ФЗ локальная смета обычно приложена к документации, и в ней есть
 * всё, чтобы проверить заказчика без догадок: код расценки, объём, ресурсы с ценами,
 * НР и СП с процентами. Этот модуль только читает написанное; сверка с нашими
 * ценами — `customerAudit.ts`. Ни модели, ни сети: тексты бывают до мегабайта,
 * поэтому всё линейно.
 *
 * Главный якорь — строка нумерации граф «1, 2, 3, …, 4, 5, …, 12». Колонки у разных
 * программ сдвинуты по-разному (Гранд-Смета ставит графу 4 в седьмую ячейку, «Строительный
 * эксперт» — в семнадцатую), и единственное, что неизменно, — порядок цифр в этой
 * строке. По ней строится соответствие «физическая ячейка → номер графы», и дальше
 * каждое поле берётся по графе, а не по номеру ячейки.
 *
 * Что считается формой 421/пр. Строка нумерации 1…12 и, над ней, шапка с графами
 * «индекс» и «в текущем уровне цен»: нумерация сама по себе встречается и в других
 * формах (сметы на изыскания в базовых ценах тоже нумеруют колонки), а у них
 * другой смысл граф. Сегмент без такого признака пропускается и называется в
 * `notRecognized` с причиной — построчно проверять его нечем.
 *
 * Отрезок сметы — тот же, что у `parseCustomerEstimates`: от «=== листа ===» до
 * строки «ВСЕГО по смете». Многострочные ячейки в кавычках (обоснование расценки с
 * фигурными скобками переносится по строкам) склеиваются в одну строку таблицы.
 *
 * Smeta.RU (`smetaRu.ts`) печатает ту же форму, но своим порядком, и разбор знает об этом, когда в шапке названа программа:
 * - итог позиции — второе число «Всего по позиции» (первое — стоимость на единицу измерения, последнее число строки — ЭМ или другая группа);
 *   проверено на 161 позиции закупки 32616439079: итог = прямые затраты + подстроки «1.1 …» + НР + СП, сумма позиций = «ВСЕГО по смете»;
 * - подстроки «1.1 999-9900 Строительный мусор», «8.1 2 %», «4.1 ФСБЦ/ТЦ …» печатаются ДО «Всего по позиции» и входят в него, а в «Итого прямые
 *   затраты» — нет: это дополнения позиции (`CustomerResource.extra`), как у выгрузок Гранд-Сметы с подстроками внутри позиции;
 * - поправки к норме — строка без ссылки на приказ («ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7») под позицией и «Поправки к:» в её наименовании;
 * - ресурс без цены («01.7.04.07 Скобяные изделия») — неучтённый, как «Н» у Гранд-Сметы;
 * - листы `Source`, `EtalonRes` и прочие — дамп базы программы, не смета.
 * Смета по ТСН-2001 Москвы (Форма № 4б, 11 граф, `parseTsnSegment`) читается тем же типом: позиции, объёмы, группы ЗП/ЭМ/ЗПМ/МР, НР и СП, итоги в
 * текущем уровне цен; база названа в `CustomerLsr.base`.
 */

/** Книга обоснования позиции: по префиксу кода. */
export type CustomerBook =
  | "GESN"
  | "GESNM"
  | "GESNR"
  | "GESNP"
  | "GESNMR"
  /** Поставка материала по ФСБЦ: «ФСБЦ-01.7.15.03-0042» или просто код материала. */
  | "MATERIAL_SUPPLY"
  /** Цена заказчика: «ТЦ_…», «КА», прайс-лист. */
  | "CUSTOMER_PRICE"
  /** Другая база: ФЕР, ТЕР, ТСН, СБЦ — не наш случай. */
  | "OTHER_BASE"
  | "UNKNOWN";

/** Ресурс позиции (строка без номера в графе 1 или с «Н»). */
export interface CustomerResource {
  /** Код в нашем виде: «ФСБЦ-» и «ТЦ_…_510» сняты, там, где внутри узнаётся код ФСБЦ. */
  readonly code: string;
  /** Код как в смете. */
  readonly rawCode: string;
  /** Цена задана заказчиком (КП, конъюнктурный анализ), даже если внутри узнаётся код ФСБЦ. */
  readonly customerPrice: boolean;
  readonly name: string;
  readonly unit: string;
  /** Графа 5: на единицу измерения позиции. */
  readonly qtyPerUnit: number | null;
  /** Графа 7: всего с учётом коэффициентов. */
  readonly qtyTotal: number | null;
  /** Графа 8: цена за единицу в базисном уровне. */
  readonly baseUnitPrice: number | null;
  /** Графа 9: индекс. */
  readonly index: number | null;
  /** Графа 10: цена за единицу в текущем уровне. */
  readonly currentUnitPrice: number | null;
  /** Графа 11: коэффициент к цене. */
  readonly priceCoefficient: number | null;
  /** Графа 12: стоимость в текущем уровне. */
  readonly currentTotal: number | null;
  /** «Н» в графе 1: неучтённый ресурс, цены у него нет. */
  readonly unaccounted: boolean;
  /**
   * Строка с номером вида «22.1»: дополнение к позиции за итогом «Итого прямые затраты» —
   * материал по ФСБЦ, который программа вынесла под позицию, или процентная добавка
   * («Вспомогательные ненормируемые материальные ресурсы», 2 %). В «Всего по позиции»
   * она входит, в «Итого прямые затраты» — нет.
   */
  readonly extra: boolean;
}

/** Начисление НР или СП. */
export interface CustomerRate {
  /** Указатель приказа без хвоста: «Пр/812-090.0-1» (с суффиксом, как в смете); null — указателя нет. */
  readonly ref: string | null;
  /** Графа 2 как есть. */
  readonly rawRef: string;
  /** Норматив по приказу, % (графа 5). */
  readonly basePercent: number | null;
  /** Применённый процент с коэффициентом (графа 7, иначе графа 5). */
  readonly percent: number | null;
  /**
   * Коэффициент к нормативу (графа 6): 0,9 к НР и 0,85 к СП при ремонте по ГЭСН (812/пр п. 25, 774/пр п. 16). null — графа пуста.
   * Нет поля — смета разобрана до чтения этой графы.
   */
  readonly coefficient?: number | null;
  /** Сумма, ₽ (графа 12). */
  readonly amount: number | null;
}

export interface GroupTotals {
  /** «ОТ(ЗТ)»: оплата труда рабочих. */
  readonly labour: number | null;
  /** «ЭМ»: эксплуатация машин. */
  readonly machines: number | null;
  /** «ОТм(ЗТм)»: оплата труда машинистов. */
  readonly machinistLabour: number | null;
  /** «М»: материалы. */
  readonly materials: number | null;
}

export interface CustomerPosition {
  /** Номер позиции (графа 1). У подпозиции — номер позиции, под которой она стоит. */
  readonly number: number;
  /**
   * Номер, как он напечатан в графе 1: «3» у позиции, «3.1» у подпозиции. Нет поля — смета
   * разобрана до подпозиций: номер тогда один, `number`.
   */
  readonly label?: string;
  /**
   * Подпозиция — «3.1», «3.2 О», «22.1»: строка, которую программа выносит под позицию после её
   * «Всего по позиции» — поставка материала по ФСБЦ, оборудование по ТЦ или КП, а бывает и
   * самостоятельная расценка (монтаж насоса под демонтажем). Нет поля или `false` — позиция верхнего уровня.
   */
  readonly sub?: boolean;
  /** Пометка «О» после номера («1.1 О»): оборудование. */
  readonly equipment?: boolean;
  /**
   * Пояснения под строкой позиции без единицы и чисел: условия применения норматива и поправочные
   * коэффициенты («421/пр_2020_прил.10_т.3_п.1.1_гр.3» — «Производство работ осуществляется в
   * помещениях эксплуатируемого объекта», «Коэффициент к заработной плате ОЗП=1,2»). Расчёт их не применяет:
   * это подсказка человеку, почему цена заказчика выше нормы.
   */
  readonly notes?: readonly CustomerPositionNote[];
  /** Код расценки без фигурных скобок и пробелов: «ГЭСНр56-01-009-01». */
  readonly code: string;
  /** Обоснование как напечатано. */
  readonly rawJustification: string;
  readonly book: CustomerBook;
  /** Сырой текст в фигурных скобках обоснования и наименования; null — коэффициентов нет. */
  readonly coefficients: string | null;
  readonly hasCoefficients: boolean;
  readonly name: string;
  readonly unit: string;
  /** Объём позиции (графа 7, иначе графа 5); null — в строке позиции его нет. */
  readonly quantity: number | null;
  /** Раздел документа: ближайший заголовок «Раздел …». */
  readonly section: string | null;
  /** Цена и стоимость, напечатанные прямо в строке позиции (цена заказчика без ресурсов). */
  readonly ownUnitPrice: number | null;
  readonly ownTotal: number | null;
  /** Базисная цена и индекс из строки позиции (графы 8 и 9) — у позиций-поставок без ресурсов. */
  readonly ownBasePrice: number | null;
  readonly ownIndex: number | null;
  /** Коэффициент к цене из строки позиции (графа 11): например 1,02 — заготовительно-складские расходы. */
  readonly ownPriceCoefficient: number | null;
  readonly resources: readonly CustomerResource[];
  readonly groupTotals: GroupTotals;
  /**
   * Итоги групп (`groupTotals`) не напечатаны в смете, а просуммированы из строк ресурсов по классу кода
   * (`deriveGroupTotals`). Вариант выгрузки Гранд-Сметы без строк «ОТ(ЗТ)», «ЭМ», «М»: под позицией идут только
   * ресурсы. Нет поля — группы прочитаны из сметы (или их нет вовсе).
   */
  readonly groupTotalsDerived?: boolean;
  /** «Итого прямые затраты». */
  readonly directTotal: number | null;
  /** «ФОТ». */
  readonly wageFund: number | null;
  readonly overhead: CustomerRate | null;
  readonly profit: CustomerRate | null;
  /** «Всего по позиции»: на единицу измерения. */
  readonly perUnit: number | null;
  /** «Всего по позиции»: всего. */
  readonly total: number | null;
  /** Строка «Всего по позиции» не встретилась: позиция оборвана. */
  readonly truncated: boolean;
}

/** Пояснение или поправочный коэффициент под позицией: обоснование (графа 2) и текст (графа 3). */
export interface CustomerPositionNote {
  readonly ref: string;
  readonly text: string;
}

export interface CustomerLsr {
  readonly documentName: string;
  readonly estimateName: string | null;
  /**
   * Номер сметы из шапки («ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-02-08»), иначе из имени листа или
   * файла. null — номер найти не удалось. Нет поля — смета разобрана до появления номера.
   */
  readonly estimateNumber?: string | null;
  /** Наименование работ из шапки сметы («Ремонтные работы в вентиляционной камере»). */
  readonly title?: string | null;
  /** Программа, в которой составлена смета, если выгрузка её называет (`smetaRu.ts`). Нет поля — Гранд-Смета и прочие: читаются общим разбором. */
  readonly program?: SmetaProgram;
  /** Метод по фразе шапки «Составлен ресурсно-индексным / базисно-индексным методом». Нет поля — шапка о методе молчит. */
  readonly method?: SmetaMethod;
  /**
   * База норм, если она не ФСНБ-2022: «ТСН-2001 (Москва)». Расценки такой сметы — не ГЭСН, шифр читать как ГЭСН нельзя, а норм ТСН у нас нет:
   * ведомость идёт через подбор по наименованию с пометкой «проверьте» и ценой заказчика (`customerLsrBill.ts`). Нет поля — база ФСНБ-2022 или не названа.
   */
  readonly base?: CustomerNormBase;
  /** «Сметная стоимость» из шапки, тыс. руб. (как напечатана; у ТСН — в текущем уровне цен). Нет поля — шапка её не печатает. */
  readonly headerTotalThousands?: number;
  /** «Составлен(а) в текущем уровне цен 01.04.2026» — дата как в смете (ДД.ММ.ГГГГ). */
  readonly priceDate: string | null;
  /** Квартал уровня цен: по дате (01.04.2026 → 2 кв. 2026) или по подписи «II кв. 2026 г.». */
  readonly priceQuarter: { readonly quarter: number; readonly year: number } | null;
  readonly priceLevel: DeclaredPriceLevel;
  /** Ставка НДС из итогов: «НДС 22%»; или выведенная по итогу (тогда `vatInferred`). */
  readonly vatPercent: number | null;
  readonly vatInferred: boolean;
  /** Сумма НДС, если строка с ней есть. */
  readonly vatAmount: number | null;
  /** Сумма итогов разделов. */
  readonly sectionsTotal: number;
  /** «ВСЕГО по смете»; null — итога в тексте нет. */
  readonly total: number | null;
  /** Сумма «Всего по позиции» по всем позициям. */
  readonly positionsTotal: number;
  readonly positions: readonly CustomerPosition[];
  /**
   * Подпозиции — поставки материалов и оборудования и самостоятельные расценки под позицией («1.1 О», «3.2»).
   * В `positions` и `positionsTotal` они не входят: аудит читает позиции верхнего уровня, как и раньше.
   * Нет поля — подпозиций в смете не нашлось.
   */
  readonly subPositions?: readonly CustomerPosition[];
  /**
   * Зимнее удорожание и временные здания, начисленные заказчиком процентом: строки итогов сметы.
   * Нет поля — таких строк в тексте не нашлось.
   */
  readonly limitedCosts?: {
    readonly winter: CustomerLimitedLine | null;
    readonly temporary: CustomerLimitedLine | null;
  };
}

/** Строка заказчика с процентом: «Зимнее удорожание 2,5 %». */
export interface CustomerLimitedLine {
  readonly percent: number;
  readonly quote: string;
}

export interface NotRecognizedEstimate {
  readonly documentName: string;
  readonly estimateName: string | null;
  readonly reason: string;
}

export interface CustomerLsrParse {
  readonly estimates: readonly CustomerLsr[];
  readonly notRecognized: readonly NotRecognizedEstimate[];
}

/* ------------------------------ Коды и книги ------------------------------ */

const GESN_RE = /^ГЭСН(мр|м|р|п)?\s*\d/i;
const MATERIAL_CODE_RE = /^\d{2}\.\d\.\d{2}\.\d{2}-\d{4}$/;
const MACHINE_CODE_RE = /^\d{2}\.\d{2}\.\d{2}-\d{3}$/;
/** Коды ФСНБ: труд («1-100-23», «4-100-030», «3-200-03»), материал, машина, служебный «999-9900». */
const KNOWN_RESOURCE_CODE_RE = /^(?:\d-\d{3}-\d{2,3}|\d{2}\.\d\.\d{2}\.\d{2}-\d{4}|\d{2}\.\d{2}\.\d{2}-\d{3}|999-\d{4})$/;
/** Код ФСБЦ внутри «ТЦ_01.6.03.03-1082_510»: материал или машина. */
const EMBEDDED_CODE_RE = /(\d{2}\.\d\.\d{2}\.\d{2}-\d{4}|\d{2}\.\d{2}\.\d{2}-\d{3})/;

const GESN_BOOKS: Record<string, CustomerBook> = {
  "": "GESN",
  м: "GESNM",
  р: "GESNR",
  п: "GESNP",
  мр: "GESNMR",
};

/** Книга по обоснованию позиции. */
export function bookOf(code: string): CustomerBook {
  const trimmed = code.trim();
  const gesn = GESN_RE.exec(trimmed);
  if (gesn !== null) return GESN_BOOKS[(gesn[1] ?? "").toLowerCase()] ?? "GESN";
  if (/^ФСБЦ-/i.test(trimmed) || MATERIAL_CODE_RE.test(trimmed)) return "MATERIAL_SUPPLY";
  if (/^ТЦ_/i.test(trimmed) || /^КА(?![а-яё])/i.test(trimmed) || /прайс/i.test(trimmed) || /^КП(?![а-яё])/i.test(trimmed)) {
    return "CUSTOMER_PRICE";
  }
  if (/^(ФЕР|ТЕР|ТСН|СБЦ|УБЦ|ОСН)/i.test(trimmed)) return "OTHER_BASE";
  return "UNKNOWN";
}

/**
 * Код ресурса в нашем виде. «ФСБЦ-01.7.15.03-0042» → «01.7.15.03-0042»;
 * «ТЦ_01.6.03.03-1082_510» → «01.6.03.03-1082» с пометкой `customerPrice`: цена —
 * по предложению заказчика, а код внутри лишь подсказывает, чем это было. «КА» и
 * прайс-лист кода не несут.
 */
export function resourceCodeOf(raw: string): { code: string; customerPrice: boolean } {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  const stripped = trimmed.replace(/^ФСБЦ-/i, "");
  if (/^ТЦ_/i.test(stripped) || /прайс/i.test(stripped) || /^КА(?![а-яё])/i.test(stripped)) {
    const inner = EMBEDDED_CODE_RE.exec(stripped)?.[1];
    return { code: inner ?? stripped, customerPrice: true };
  }
  // Всё, что не похоже на код ФСНБ («Цена поставщика», «п.17 отчёта о проверке цен»), —
  // цена заказчика: нашего кода у неё нет, сравнить не с чем.
  if (!KNOWN_RESOURCE_CODE_RE.test(stripped)) return { code: stripped, customerPrice: true };
  return { code: stripped, customerPrice: false };
}

/* ------------------------------ Строки таблицы ------------------------------ */

export interface LogicalRow {
  readonly offset: number;
  readonly text: string;
}

function oddQuotes(text: string): boolean {
  let count = 0;
  for (let i = text.indexOf('"'); i >= 0; i = text.indexOf('"', i + 1)) count += 1;
  return count % 2 === 1;
}

/** Строки текста; ячейка в кавычках, перенесённая по строкам, склеивается с продолжением. */
export function* logicalRows(text: string): Generator<LogicalRow> {
  const MAX_JOIN = 40;
  let position = 0;
  while (position <= text.length) {
    let end = text.indexOf("\n", position);
    if (end < 0) end = text.length;
    let row = text.slice(position, end);
    let consumedTo = end;

    if (oddQuotes(row)) {
      let joined = row;
      let cursor = end;
      for (let joins = 0; joins < MAX_JOIN && oddQuotes(joined) && cursor < text.length; joins += 1) {
        let next = text.indexOf("\n", cursor + 1);
        if (next < 0) next = text.length;
        joined += `\n${text.slice(cursor + 1, next)}`;
        cursor = next;
      }
      // Кавычки так и не закрылись: стоит одинокая кавычка, а не перенос — берём строку как есть.
      if (!oddQuotes(joined)) {
        row = joined;
        consumedTo = cursor;
      }
    }

    yield { offset: position, text: row.replace(/\r$/, "") };
    if (consumedTo >= text.length) break;
    position = consumedTo + 1;
  }
}

/** Строка нумерации граф: цифры 1…12 по порядку в разных ячейках → ячейка каждой графы. */
function numberingColumns(cells: readonly string[], last = 12): number[] | null {
  const columns: number[] = [];
  let next = 1;
  for (let index = 0; index < cells.length; index += 1) {
    if ((cells[index] as string).trim() === String(next)) {
      columns[next] = index;
      next += 1;
      if (next > last) return columns;
    }
  }
  return null;
}

/** Нумерация граф — это форма 421/пр, только если над ней шапка с графами «индекс» и «текущем уровне цен». */
function looksLike421(previousRows: readonly string[]): boolean {
  const head = previousRows.join(" ").toLowerCase();
  return head.includes("индекс") && head.includes("текущем уровне цен");
}

const LABEL_GROUP_RE = /^(?:ОТ\s*\(\s*ЗТ\s*\)|ЭМ|ОТм\s*\(\s*ЗТм\s*\)|М|в\s+т(?:ом|\.)\s*ч(?:исле|\.)?\s+ОТм)$/i;
const TOTAL_POSITION_RE = /^всего\s+по\s+позиции/i;
const DIRECT_RE = /^итого\s+прямые\s+затраты\s*$/i;
const WAGE_FUND_RE = /^ФОТ\s*$/i;
const RATE_LABEL_RE = /^(НР|СП)(?![а-яёА-ЯЁ])/;
const RATE_REF_RE = /(Пр\/(812|774)-[\d.]+(?:-\d+)?)/;
const BRACES_RE = /\{([\s\S]*?)\}/g;
/** Номер подпозиции в графе 1: «3.1», «22.1», «1.1 О» (оборудование). */
const SUB_LABEL_RE = /^(\d+)\.(\d+)(?:\s*([A-Za-zА-Яа-яЁё]))?$/;

interface Grid {
  readonly cells: readonly string[];
  readonly columns: readonly number[];
  readonly delimiter: string;
}

function cellAt(grid: Grid, graph: number): string {
  return (grid.cells[grid.columns[graph] as number] ?? "").replace(/\s+/g, " ").trim();
}

function numberAt(grid: Grid, graph: number): number | null {
  const text = cellAt(grid, graph);
  return text === "" ? null : parseNumberCell(text, grid.delimiter);
}

/**
 * Объём из графы «Кол-во» формы № 4б ТСН-2001: под числом программа печатает формулу подсчёта —
 * «32⏎1*16*2», «145,8⏎2*9*8,1». `cellAt` склеивает строки ячейки в «32 1*16*2», и такое число не
 * читалось: закупка 32616405004 (КДЦ «Арктика», 20.10.2026) — 120 позиций из 515 на 12,65 млн ₽ (52 %
 * сметы) ушли в BAD_QUANTITY и выпали из пересчёта. Берётся первая строка ячейки; если строки уже
 * склеены — число перед хвостом-формулой из цифр, знаков «*+-/,.()» и пробелов.
 */
function quantityAt(grid: Grid, graph: number): number | null {
  const raw = grid.cells[grid.columns[graph] as number] ?? "";
  const lines = raw.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line !== "");
  const firstLine = lines[0] ?? "";
  const formula = lines.length > 1 ? evaluateQuantityFormula(lines.slice(1).join(" ")) : null;
  if (firstLine !== "") {
    const parsed = parseNumberCell(firstLine, grid.delimiter);
    const decimal = decimalCommaNumber(firstLine);
    // Запятая неоднозначна: в той же смете цены пишутся «2,448.57» (тысячи), а объёмы «0,049» (дробь).
    // Закупка 32616405004: «0,049⏎(2*1,96+1*0,98) / 100» читалось как 49 — в 1000 раз больше, +3,98 млн ₽.
    // Формула под числом решает спор; без неё «0,…» — всегда дробь (тысячи с нулём впереди не пишут).
    if (formula !== null && decimal !== null && parsed !== decimal) {
      const close = (value: number) => Math.abs(value - formula) <= Math.max(1e-9, Math.abs(formula) * 0.01);
      if (close(decimal)) return decimal;
      if (parsed !== null && close(parsed)) return parsed;
    }
    if (decimal !== null && /^-?0,\d+$/.test(firstLine)) return decimal;
    if (parsed !== null) return parsed;
  }
  const flat = cellAt(grid, graph);
  const withFormula = /^(\d[\d\u00a0 ]*(?:[.,]\d+)?)\s+[\d*+\-\/.,() ]*[*\/][\d*+\-\/.,() ]*$/u.exec(flat);
  if (withFormula) return parseNumberCell((withFormula[1] as string).trim(), grid.delimiter);
  return numberAt(grid, graph);
}

/** «0,049» и «145,8» как десятичные с запятой; null — не такое число. */
function decimalCommaNumber(text: string): number | null {
  const match = /^-?\d+(?:,\d+)?$/.exec(text.replace(/[\u00a0 ]/g, ""));
  if (!match) return null;
  const value = Number.parseFloat(match[0].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * Значение формулы подсчёта объёма из ячейки: «(4*0,49+2*0,98) / 100», «1*16*2». Только числа (запятая —
 * десятичная), «+ - * /» и скобки, разбором без eval; что-то другое — null (формулой не считается).
 */
function evaluateQuantityFormula(text: string): number | null {
  const source = text.replace(/\s+/g, "");
  if (source === "" || !/^[\d.,+\-*/()]+$/.test(source) || !/[*/+]/.test(source)) return null;
  let index = 0;
  const peek = () => source[index];
  function number(): number | null {
    const match = /^\d+(?:[.,]\d+)?/.exec(source.slice(index));
    if (!match) return null;
    index += match[0].length;
    return Number.parseFloat(match[0].replace(",", "."));
  }
  function factor(): number | null {
    if (peek() === "(") {
      index += 1;
      const value = expression();
      if (peek() !== ")") return null;
      index += 1;
      return value;
    }
    if (peek() === "-") {
      index += 1;
      const value = factor();
      return value === null ? null : -value;
    }
    return number();
  }
  function term(): number | null {
    let value = factor();
    while (value !== null && (peek() === "*" || peek() === "/")) {
      const op = peek();
      index += 1;
      const right = factor();
      if (right === null) return null;
      value = op === "*" ? value * right : right === 0 ? null : value / right;
    }
    return value;
  }
  function expression(): number | null {
    let value = term();
    while (value !== null && (peek() === "+" || peek() === "-")) {
      const op = peek();
      index += 1;
      const right = term();
      if (right === null) return null;
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }
  const value = expression();
  return value !== null && index === source.length && Number.isFinite(value) ? value : null;
}

/** Числа подряд после ячейки с подписью; чтение обрывает первая ячейка с текстом (повтор подписи в хвосте). */
function numericRun(cells: readonly string[], labelIndex: number, delimiter: string): number[] {
  const run: number[] = [];
  for (let index = labelIndex + 1; index < cells.length; index += 1) {
    const text = (cells[index] as string).trim();
    if (text === "") continue;
    const value = parseNumberCell(text, delimiter);
    if (value === null) break;
    run.push(value);
  }
  return run;
}

/** Значение итоговой строки: графа 12, иначе последнее число после подписи. */
function amountOf(grid: Grid, labelIndex: number): number | null {
  const direct = numberAt(grid, 12);
  if (direct !== null) return direct;
  const run = numericRun(grid.cells, labelIndex, grid.delimiter);
  return run.length === 0 ? null : (run[run.length - 1] as number);
}

function firstNonEmptyIndex(cells: readonly string[]): number {
  return cells.findIndex((cell) => cell.trim() !== "");
}

/* ------------------------------ Позиция в сборке ------------------------------ */

interface PositionDraft {
  number: number;
  /** Номер из графы 1 как есть: «3», «3.1», «1.1 О». */
  label: string;
  sub: boolean;
  equipment: boolean;
  notes: CustomerPositionNote[];
  rawJustification: string;
  name: string;
  unit: string;
  quantity: number | null;
  offset: number;
  ownUnitPrice: number | null;
  ownTotal: number | null;
  ownBasePrice: number | null;
  ownIndex: number | null;
  ownPriceCoefficient: number | null;
  resources: CustomerResource[];
  groups: { labour: number | null; machines: number | null; machinistLabour: number | null; materials: number | null };
  directTotal: number | null;
  wageFund: number | null;
  overhead: CustomerRate | null;
  profit: CustomerRate | null;
  perUnit: number | null;
  total: number | null;
}

function rateOf(grid: Grid, rawRef: string): CustomerRate {
  const ref = RATE_REF_RE.exec(rawRef)?.[1] ?? null;
  const base = numberAt(grid, 5);
  return {
    ref,
    rawRef,
    basePercent: base,
    // Графа 6 есть не у каждой строки; поле появляется только вместе со значением.
    ...(numberAt(grid, 6) === null ? {} : { coefficient: numberAt(grid, 6) }),
    percent: numberAt(grid, 7) ?? base,
    amount: numberAt(grid, 12),
  };
}

/**
 * Поправки Smeta.RU в наименовании: «Установка противопожарных дверей … \nПоправки к: \nЭМ *1,25; \nЗТ *1,15; \nНР *0,9;». Они стоят в той же
 * ячейке, что и наименование, после слов «Поправки к:» — наименованию не принадлежат и уходят в коэффициенты позиции.
 */
const SMETA_RU_CORRECTIONS_RE = /\s*Поправки\s+к\s*:\s*([\s\S]*)$/iu;

function splitJustification(raw: string, name: string, smetaRu = false): { code: string; coefficients: string | null; name: string } {
  const compact = raw.replace(/\s+/g, " ").trim();
  const brace = compact.indexOf("{");
  const code = (brace >= 0 ? compact.slice(0, brace) : compact).replace(/\s+/g, "").trim();
  const parts: string[] = [];
  const corrections = smetaRu ? SMETA_RU_CORRECTIONS_RE.exec(name) : null;
  const printedName = corrections === null ? name : name.slice(0, corrections.index);
  if (corrections !== null) {
    const body = (corrections[1] ?? "").replace(/\s+/g, " ").trim();
    if (body !== "") parts.push(body);
  }
  for (const source of [compact, printedName]) {
    BRACES_RE.lastIndex = 0;
    for (let match = BRACES_RE.exec(source); match !== null; match = BRACES_RE.exec(source)) {
      const body = (match[1] ?? "").trim();
      if (body !== "") parts.push(body);
    }
  }
  const cleanName = printedName.replace(BRACES_RE, " ").replace(/\s+/g, " ").trim();
  return { code, coefficients: parts.length === 0 ? null : parts.join(" | "), name: cleanName };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Стоимость строки ресурса в текущем уровне: графа 12, иначе «всего» × цена за единицу; null — посчитать нечем. */
function resourceTotal(resource: CustomerResource): number | null {
  if (resource.currentTotal !== null) return resource.currentTotal;
  if (resource.qtyTotal !== null && resource.currentUnitPrice !== null) return round2(resource.qtyTotal * resource.currentUnitPrice);
  return null;
}

/**
 * Итоги групп по строкам ресурсов, когда в смете строк групп нет.
 *
 * Зачем. Один из вариантов выгрузки Гранд-Сметы (закупка 0134300025826000377, Иркутск) печатает под позицией только
 * ресурсы: без «ОТ(ЗТ)», «ЭМ», «ОТм(ЗТм)», «М». Без итогов групп не работают ни сверка материалов с нормой
 * (`customerMaterials` в расчёте), ни разложение разницы в бенчмарке, ни сумма коэффициентов заказчика. Итоги такой позиции
 * складываются из ресурсов по классу кода (`classifyResourceCode`): труд рабочих — «1-100-*», «2-100-*», «3-*»; труд
 * машинистов — «4-100-*»; машины — «91.*»; материалы и оборудование — всё остальное, включая цены заказчика («ТЦ_…», КП).
 * Группа без строк остаётся null (как в смете: пустая группа там не печатается).
 *
 * Берутся строки до «Итого прямые затраты» (без дополнений `extra`: они в «Итого прямые затраты» не входят) и только с ценой
 * («Н»-строки без цены пропускаются). Строка с единицей, но без стоимости делает сумму неполной — тогда итогов нет совсем:
 * частичная сумма выглядела бы как настоящая.
 */
export function deriveGroupTotals(resources: readonly CustomerResource[]): GroupTotals | null {
  let labour: number | null = null;
  let machines: number | null = null;
  let machinistLabour: number | null = null;
  let materials: number | null = null;
  for (const resource of resources) {
    if (resource.unaccounted || resource.extra) continue;
    const total = resourceTotal(resource);
    if (total === null) return null;
    switch (classifyResourceCode(resource.code)) {
      case "LABOUR":
        labour = (labour ?? 0) + total;
        break;
      case "MACHINIST_HOURS":
        machinistLabour = (machinistLabour ?? 0) + total;
        break;
      case "MACHINE":
        machines = (machines ?? 0) + total;
        break;
      case "WORKER_HOURS_TOTAL":
        // Служебные «итого чел.-ч» («1») денег не несут.
        break;
      default:
        materials = (materials ?? 0) + total;
    }
  }
  const result = {
    labour: labour === null ? null : round2(labour),
    machines: machines === null ? null : round2(machines),
    machinistLabour: machinistLabour === null ? null : round2(machinistLabour),
    materials: materials === null ? null : round2(materials),
  };
  return Object.values(result).every((value) => value === null) ? null : result;
}

function finishPosition(draft: PositionDraft, closed: boolean, headings: ReturnType<typeof sectionHeadings>, smetaRu = false): CustomerPosition {
  const { code, coefficients, name } = splitJustification(draft.rawJustification, draft.name, smetaRu);
  // Строк групп в смете нет ни одной — итоги из ресурсов (см. `deriveGroupTotals`); напечатанные заказчиком не трогаются.
  const printed = Object.values(draft.groups).some((value) => value !== null);
  const derived = printed ? null : deriveGroupTotals(draft.resources);
  return {
    number: draft.number,
    label: draft.label,
    ...(draft.sub ? { sub: true } : {}),
    ...(draft.equipment ? { equipment: true } : {}),
    ...(draft.notes.length === 0 ? {} : { notes: draft.notes }),
    code,
    rawJustification: draft.rawJustification,
    book: bookOf(code),
    coefficients,
    hasCoefficients: coefficients !== null,
    name,
    unit: draft.unit,
    quantity: draft.quantity,
    section: sectionAt(headings, draft.offset)?.title ?? null,
    ownUnitPrice: draft.ownUnitPrice,
    ownTotal: draft.ownTotal,
    ownBasePrice: draft.ownBasePrice,
    ownIndex: draft.ownIndex,
    ownPriceCoefficient: draft.ownPriceCoefficient,
    resources: draft.resources,
    groupTotals: derived ?? draft.groups,
    ...(derived === null ? {} : { groupTotalsDerived: true }),
    directTotal: draft.directTotal,
    wageFund: draft.wageFund,
    overhead: draft.overhead,
    profit: draft.profit,
    perUnit: draft.perUnit,
    total: draft.total,
    truncated: !closed,
  };
}

/* ------------------------------ НДС и уровень цен ------------------------------ */

const PRICE_DATE_RE = /составлен\(?а?\)?\s+в\s+(?:текущем\s+)?уровне\s+цен\D{0,40}?(\d{2})\.(\d{2})\.(\d{4})/i;
const VAT_RE = /(?:ндс|налог\s+на\s+добавленную\s+стоимость)\s*\(?\s*(\d{1,2}(?:[.,]\d+)?)\s*%/i;

function quarterOfMonth(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

function readHeader(header: string): Pick<CustomerLsr, "priceDate" | "priceQuarter" | "priceLevel"> {
  const date = PRICE_DATE_RE.exec(header);
  const level = declaredPriceLevel(header);
  if (date !== null) {
    const month = Number.parseInt(date[2] as string, 10);
    const year = Number.parseInt(date[3] as string, 10);
    const valid = month >= 1 && month <= 12 && year >= 2000 && year <= 2099;
    return {
      priceDate: `${date[1] as string}.${date[2] as string}.${date[3] as string}`,
      priceQuarter: valid ? { quarter: quarterOfMonth(month), year } : null,
      priceLevel: level,
    };
  }
  // Подпись «II кв. 2026 г.» или «на сентябрь 2026 года» (Smeta.RU) после слов «в текущем уровне цен».
  const at = header.search(/в\s+текущем\s+уровне\s+цен/i);
  const window = at >= 0 ? header.slice(at, at + 200) : "";
  const near = at >= 0 ? (quarterIn(window) ?? monthQuarterIn(window)) : null;
  return { priceDate: null, priceQuarter: near, priceLevel: level };
}

/** Номер сметы в имени листа или файла: «02-02-08», «02-02-05-13», «02-01-02-КМ1». */
const NUMBER_IN_NAME_RE = /(?<![\p{L}\d])(\d{1,3}(?:-\d{1,3}){1,4}(?:-[\p{L}]{1,3}\d*)?)(?![\p{L}\d-])/u;
const ESTIMATE_TITLE_RE = /локальн\p{L}*\s+сметн\p{L}*\s+расч[её]т/iu;
/** Заголовок Smeta.RU и ТСН бывает и короче: «ЛОКАЛЬНАЯ СМЕТА № 02-01-01». */
const ESTIMATE_TITLE_SHORT_RE = /локальн\p{L}*\s+смет\p{L}*(?:\s+расч[её]т)?/iu;
const ESTIMATE_NUMBER_RE = /(?:№|N)\s*([^\s,;"()]+)/u;
/** Номер-заглушка Smeta.RU: «№ Новая локальная смета», «№ ЛСР-Новая локальная смета» — номера у сметы нет. */
const PLACEHOLDER_NUMBER_RE = /^(?:ЛСР[-–]?)?нов(?:ая|ый)$/iu;

/**
 * Номер и наименование сметы: из шапки («ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-02-08», под ней — наименование
 * работ), а если шапка номера не называет — из имени листа и файла. Нужны, чтобы одну и ту же смету из двух
 * документов узнать и чтобы назвать раздел нашей сметы так же, как смету заказчика.
 *
 * Smeta.RU: у сметы без наименования работ (поле пустое) наименованием служит объект («Ремонт цоколя, основания забора …» над подписью
 * «(наименование объекта капитального строительства)»), а при его отсутствии — стройка.
 */
function readIdentity(
  header: string,
  sheetName: string | null,
  documentName: string,
  smetaRu = false,
): Pick<CustomerLsr, "estimateNumber" | "title"> {
  let number: string | null = null;
  let title: string | null = null;
  const lines: string[] = [];
  for (const row of logicalRows(header)) {
    const parsed = parseLine(row.text, true);
    const first = (parsed.cells.find((cell) => cell.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
    lines.push(first);
  }
  const titleRe = smetaRu ? ESTIMATE_TITLE_SHORT_RE : ESTIMATE_TITLE_RE;
  for (const [index, line] of lines.entries()) {
    if (!titleRe.test(line)) continue;
    const printed = ESTIMATE_NUMBER_RE.exec(line)?.[1] ?? null;
    number = printed !== null && PLACEHOLDER_NUMBER_RE.test(printed) ? null : printed;
    for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
      const candidate = lines[next] as string;
      if (candidate === "") continue;
      if (/^\(?наименование/i.test(candidate) || /^основание/i.test(candidate)) break;
      title = candidate;
      break;
    }
    break;
  }
  if (smetaRu && title === null) {
    for (const label of [/^\(?наименование\s+объекта/iu, /^\(?наименование\s+стройки/iu]) {
      const at = lines.findIndex((line) => label.test(line));
      if (at <= 0) continue;
      for (let before = at - 1; before >= 0 && before >= at - 3; before -= 1) {
        const candidate = lines[before] as string;
        if (candidate !== "") {
          title = candidate;
          break;
        }
      }
      if (title !== null) break;
    }
  }
  if (number === null) {
    const fromSheet = sheetName === null ? null : (NUMBER_IN_NAME_RE.exec(sheetName)?.[1] ?? null);
    const base = documentName.split(/[\\/]/).pop() ?? documentName;
    number = fromSheet ?? NUMBER_IN_NAME_RE.exec(base)?.[1] ?? null;
  }
  return { estimateNumber: number, title };
}

const WINTER_RE = /(зимн[а-я]+\s+удорожани[а-я]*)[^\d\n]{0,40}?(\d{1,2}(?:[.,]\d+)?)\s*%/iu;
const TEMPORARY_RE = /(временн[а-я]+\s+здани[а-я]+\s+и\s+сооружени[а-я]*)[^\d\n]{0,40}?(\d{1,2}(?:[.,]\d+)?)\s*%/iu;

function limitedLine(text: string, pattern: RegExp): CustomerLimitedLine | null {
  const match = pattern.exec(text);
  if (match === null) return null;
  const percent = Number.parseFloat((match[2] as string).replace(",", "."));
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return { percent, quote: match[0].replace(/\s+/gu, " ").trim() };
}

/** Зимнее удорожание и временные здания, начисленные процентом, — по тексту сметы и её хвоста. */
function readLimitedCosts(text: string): CustomerLsr["limitedCosts"] | null {
  const winter = limitedLine(text, WINTER_RE);
  const temporary = limitedLine(text, TEMPORARY_RE);
  return winter === null && temporary === null ? null : { winter, temporary };
}

/** Ставка НДС по строкам итогов: первая названная; сумма — последнее число строки. */
function readVat(rows: readonly ParsedLine[]): { percent: number; amount: number | null } | null {
  for (const parsed of rows) {
    for (const [index, cell] of parsed.cells.entries()) {
      const match = VAT_RE.exec(cell);
      if (match === null) continue;
      const percent = Number.parseFloat((match[1] as string).replace(",", "."));
      if (!Number.isFinite(percent) || percent <= 0) continue;
      const run = numericRun(parsed.cells, index, parsed.delimiter);
      return { percent, amount: run.length === 0 ? null : (run[run.length - 1] as number) };
    }
  }
  return null;
}

const VAT_FACTORS: readonly number[] = [22, 20];

/** Ставка, выведенная по итогу: ВСЕГО ≈ Σ разделов × 1,22 или × 1,20. */
function inferVat(sectionsTotal: number, total: number | null): number | null {
  if (total === null || sectionsTotal <= 0) return null;
  for (const percent of VAT_FACTORS) {
    const expected = sectionsTotal * (1 + percent / 100);
    if (Math.abs(total - expected) <= Math.max(1, Math.abs(total) * 0.001)) return percent;
  }
  return null;
}

/* ------------------------------ Разбор отрезка ------------------------------ */

type SegmentResult =
  | {
      readonly kind: "ok";
      readonly positions: CustomerPosition[];
      readonly subPositions: CustomerPosition[];
      readonly header: string;
      readonly rows: ParsedLine[];
    }
  | { readonly kind: "no"; readonly reason: string };

function parseSegment(text: string): SegmentResult {
  const headings = sectionHeadings(text);
  // Smeta.RU: итог позиции стоит иначе, поправки без ссылки, а наименование несёт «Поправки к:» (`smetaRu.ts`).
  const smetaRu = isSmetaRuText(text);
  const recent: string[] = [];
  let columns: number[] | null = null;
  let numberingEnd = 0;
  let sawNumbering = false;

  const positions: CustomerPosition[] = [];
  const subPositions: CustomerPosition[] = [];
  const vatRows: ParsedLine[] = [];
  let draft: PositionDraft | null = null;
  const close = (closed: boolean): void => {
    if (draft !== null) (draft.sub ? subPositions : positions).push(finishPosition(draft, closed, headings, smetaRu));
    draft = null;
  };

  for (const row of logicalRows(text)) {
    if (columns === null) {
      if (row.text.trim() === "") continue;
      // Дешёвый отбор: строка нумерации начинается с «1» и содержит «12».
      if (/^\s*"?1"?\s*[;,]/.test(row.text) && row.text.includes("12")) {
        // Строка «1,2,3,…,12» без пустых ячеек и кавычек по общему правилу не таблица: принимаем её принудительно.
        const parsed = parseLine(row.text, true);
        const found = parsed.csv ? numberingColumns(parsed.cells) : null;
        if (found !== null) {
          sawNumbering = true;
          if (!looksLike421(recent)) {
            return {
              kind: "no",
              reason: "нумерация граф есть, но это не форма 421/пр: над ней нет граф «индекс» и «в текущем уровне цен»",
            };
          }
          columns = found;
          numberingEnd = row.offset + row.text.length;
          continue;
        }
      }
      recent.push(row.text);
      if (recent.length > 6) recent.shift();
      continue;
    }

    if (row.text.trim() === "") continue;
    const parsed = parseLine(row.text);
    if (!parsed.csv) continue;
    const grid: Grid = { cells: parsed.cells, columns, delimiter: parsed.delimiter };

    const first = firstNonEmptyIndex(parsed.cells);
    if (first < 0) continue;
    const firstText = (parsed.cells[first] as string).trim();
    if (VAT_RE.test(row.text)) vatRows.push(parsed);

    const graph1 = cellAt(grid, 1);
    const graph2 = cellAt(grid, 2);
    const graph3 = cellAt(grid, 3);

    // Заголовки и итоги разделов позиций не закрывают и в них не входят.
    if (/^(?:раздел|подраздел|итого\s+по\s+разделу|итоги\s+по\s+разделу|всего\s+по\s+разделу)/i.test(firstText)) {
      continue;
    }

    // Позиция: графа 1 — целое число, графа 2 — обоснование. У позиции по цене заказчика
    // (кабель по коммерческому предложению) обоснования нет, остаётся наименование.
    /*
      Подпозиция «3.1», «1.1 О»: Гранд-Смета выносит поставку материала, оборудование и
      сопутствующую расценку под позицию уже после её «Всего по позиции». Пока предыдущая
      позиция не закрыта, строка «22.1» остаётся её дополнением (ресурс `extra`, ниже).
    */
    const subLabel: RegExpExecArray | null = draft === null ? SUB_LABEL_RE.exec(graph1) : null;
    if ((/^\d+$/.test(graph1) || subLabel !== null) && (graph2 !== "" || graph3 !== "")) {
      close(false);
      const rawJustification = (parsed.cells[columns[2] as number] ?? "").trim();
      draft = {
        number: Number.parseInt(subLabel === null ? graph1 : (subLabel[1] as string), 10),
        label: subLabel === null ? graph1 : `${subLabel[1] as string}.${subLabel[2] as string}`,
        sub: subLabel !== null,
        equipment: subLabel?.[3] !== undefined,
        notes: [],
        rawJustification,
        name: graph3,
        unit: cellAt(grid, 4),
        quantity: numberAt(grid, 7) ?? numberAt(grid, 5),
        offset: row.offset,
        ownUnitPrice: numberAt(grid, 10),
        ownTotal: numberAt(grid, 12),
        ownBasePrice: numberAt(grid, 8),
        ownIndex: numberAt(grid, 9),
        ownPriceCoefficient: numberAt(grid, 11),
        resources: [],
        groups: { labour: null, machinistLabour: null, machines: null, materials: null },
        directTotal: null,
        wageFund: null,
        overhead: null,
        profit: null,
        perUnit: null,
        total: null,
      };
      continue;
    }
    if (draft === null) continue;
    const current: PositionDraft = draft;

    // Подпись строки — графа 3; у итогов без номера и обоснования подпись может сдвинуться в первую непустую ячейку.
    const label = graph3 !== "" ? graph3 : graph1 === "" && graph2 === "" ? firstText : "";
    const labelIndex = graph3 !== "" ? (columns[3] as number) : first;

    if (TOTAL_POSITION_RE.test(label)) {
      const run = numericRun(parsed.cells, labelIndex, parsed.delimiter);
      if (smetaRu) {
        /*
          Smeta.RU печатает «Всего по позиции» длинной строкой: стоимость на единицу измерения, стоимость позиции, затем на единицу
          НР и СП, стоимость без дополнений, ЭМ и т. д. Последнее число подряд — не итог позиции (у позиции 1 закупки 32616439079 это
          0,04 — ЭМ, и сумма позиций вышла 3 464 ₽ вместо 1,34 млн ₽). Итог — второе число: «12 930,64 | 447,40» = 447,40 / 0,0346 ед.;
          сходится с прямыми затратами + дополнения + НР + СП. Единственное число — итог без цены за единицу.
        */
        current.perUnit = run.length >= 2 ? (run[0] as number) : null;
        current.total = run.length === 0 ? null : (run[run.length >= 2 ? 1 : 0] as number);
      } else {
        current.perUnit = run.length >= 2 ? (run[0] as number) : null;
        current.total = run.length === 0 ? null : (run[run.length - 1] as number);
      }
      close(true);
      continue;
    }
    if (DIRECT_RE.test(label)) {
      current.directTotal = amountOf(grid, labelIndex);
      continue;
    }
    if (WAGE_FUND_RE.test(label)) {
      current.wageFund = amountOf(grid, labelIndex);
      continue;
    }

    const isRate = RATE_LABEL_RE.exec(label);
    const refKind = /^Пр\/(812|774)/.exec(graph2)?.[1] ?? /^(812|774)\/пр/.exec(graph2)?.[1] ?? null;
    if ((isRate !== null && cellAt(grid, 4) === "%") || (refKind !== null && cellAt(grid, 4) === "%")) {
      const kind = refKind !== null ? (refKind === "812" ? "overhead" : "profit") : isRate?.[1] === "НР" ? "overhead" : "profit";
      const rate = rateOf(grid, graph2);
      if (kind === "overhead") current.overhead = rate;
      else current.profit = rate;
      continue;
    }

    // Строки-группы «1 ОТ(ЗТ)», «2 ЭМ», «ОТм(ЗТм)», «4 М» — итоги, а не ресурсы.
    if (LABEL_GROUP_RE.test(label) && (graph2 === "" || /^\d$/.test(graph2))) {
      const value = amountOf(grid, labelIndex);
      if (/^ОТ\s*\(/i.test(label)) current.groups.labour = value;
      else if (/^ЭМ$/i.test(label)) current.groups.machines = value;
      else if (/отм/i.test(label)) current.groups.machinistLabour = value;
      else current.groups.materials = value;
      continue;
    }

    // Smeta.RU: строка поправок под позицией без ссылки на приказ — «ЭМ *0,7; М *0; ЗТ *0,7; ЗТм *0,7».
    if (smetaRu && graph1 === "" && graph2 === "" && hasStarFactors(graph3) && cellAt(grid, 4) === "" && ![5, 7, 8, 9, 10, 12].some((g) => numberAt(grid, g) !== null)) {
      current.notes.push({ ref: "", text: graph3 });
      continue;
    }

    // Поправочный коэффициент и условие применения без обоснования: «Коэффициент к заработной плате ОЗП=1,2».
    if (
      graph1 === "" &&
      graph2 === "" &&
      /^(?:коэффициент|поправочн|производство\s+работ)/i.test(graph3) &&
      cellAt(grid, 4) === "" &&
      ![5, 7, 8, 9, 10, 12].some((g) => numberAt(grid, g) !== null)
    ) {
      current.notes.push({ ref: "", text: graph3 });
      continue;
    }

    // Ресурс: графа 1 пуста, «Н» или «22.1» (дополнение к позиции), в графе 2 — код.
    const extra = /^\d+\.\d+$/.test(graph1);
    if ((graph1 === "" || /^[НH]$/.test(graph1) || extra) && graph2 !== "" && !/^Пр\//.test(graph2)) {
      const unit = cellAt(grid, 4);
      const numbers = [5, 7, 8, 9, 10, 12].some((g) => numberAt(grid, g) !== null);
      // Строка-пояснение («Приказ от … табл.3 п.2») без единицы и чисел — не ресурс.
      if (unit === "" && !numbers) {
        if (graph3 !== "" || graph2 !== "") current.notes.push({ ref: graph2, text: graph3 });
        continue;
      }
      const { code, customerPrice } = resourceCodeOf(graph2);
      const priced = [8, 10, 12].some((g) => numberAt(grid, g) !== null);
      current.resources.push({
        code,
        rawCode: graph2,
        customerPrice,
        name: graph3,
        unit,
        qtyPerUnit: numberAt(grid, 5),
        qtyTotal: numberAt(grid, 7),
        baseUnitPrice: numberAt(grid, 8),
        index: numberAt(grid, 9),
        currentUnitPrice: numberAt(grid, 10),
        priceCoefficient: numberAt(grid, 11),
        currentTotal: numberAt(grid, 12),
        // Smeta.RU помечает неучтённый ресурс не «Н», а отсутствием цены: «01.7.04.07 Скобяные изделия, КОМПЛ, 0» — материал по проекту без стоимости.
        unaccounted: /^[НH]$/.test(graph1) || (smetaRu && !extra && !priced),
        extra,
      });
    }
  }
  close(false);

  if (!sawNumbering || columns === null) {
    return { kind: "no", reason: "нет строки нумерации граф 1–12: это не форма 421/пр" };
  }
  return { kind: "ok", positions, subPositions, header: text.slice(0, Math.min(numberingEnd, 40_000)), rows: vatRows };
}

/* ------------------------------ ТСН-2001 Москвы (Форма № 4б, 11 граф) ------------------------------ */

/** Строки, которые в смете ТСН позицией не начинаются и не продолжают: заголовки и итоги разделов и сметы. */
const TSN_SKIP_RE = /^(?:раздел|подраздел|локальная\s+смета|итого)/iu;
const TSN_LABOUR_RE = /^ЗП$/iu;
const TSN_MACHINES_RE = /^ЭМ$/iu;
const TSN_MACHINIST_RE = /^в\s+т\.?\s*ч\.?\s+ЗПМ$/iu;
const TSN_MATERIALS_RE = /^МР$/iu;
const TSN_RATE_RE = /^(НР|СП)\s+от\s+ФОТ/iu;

/** Единица ТСН: «1  ШТ.» → «ШТ.» (множитель 1 опускается), «100 М2» остаётся: объём считается в сотнях. */
function tsnUnit(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.replace(/^1\s+(?=\D)/u, "");
}

/**
 * Смета ТСН-2001 Москвы, выгруженная из Smeta.RU (Форма № 4б): 11 граф — «№ п/п, Шифр расценки, Наименование, Ед. изм., Кол-во, Цена на
 * ед. изм., Поправочные коэффициенты, Коэффициенты зимних удорожаний, Всего в базисном уровне цен, Коэффициенты (индексы) пересчёта, ВСЕГО в
 * текущем уровне цен».
 *
 * Читается то, что нужно сравнению и ведомости: шифр, наименование, единица, объём, группы ЗП / ЭМ / в т. ч. ЗПМ / МР (в текущем уровне цен), НР и СП
 * с процентами и суммами и итог позиции — «Всего по позиции:» печатает пару «в базисном уровне, в текущем», стоимость позиции — вторая. Состава
 * ресурсов у ТСН нет (в строках только группы), прямых затрат отдельной строкой нет: `directTotal` не заполняется, и невидимый остаток позиции
 * не считается.
 */
function parseTsnSegment(text: string): SegmentResult {
  const headings = sectionHeadings(text);
  let columns: number[] | null = null;
  let numberingEnd = 0;
  const positions: CustomerPosition[] = [];
  const vatRows: ParsedLine[] = [];
  let draft: PositionDraft | null = null;
  const close = (closed: boolean): void => {
    if (draft !== null) {
      const position = finishPosition(draft, closed, headings, true);
      // Шифр ТСН («4.8-61-4») bookOf не знает: это чужая база, а не «неизвестная» книга.
      positions.push(position.book === "UNKNOWN" ? { ...position, book: "OTHER_BASE" } : position);
    }
    draft = null;
  };

  for (const row of logicalRows(text)) {
    if (columns === null) {
      if (row.text.trim() === "") continue;
      if (/^\s*"?1"?\s*[;,]/.test(row.text) && row.text.includes("11")) {
        const parsed = parseLine(row.text, true);
        const found = parsed.csv ? numberingColumns(parsed.cells, 11) : null;
        if (found !== null) {
          columns = found;
          numberingEnd = row.offset + row.text.length;
        }
      }
      continue;
    }

    if (row.text.trim() === "") continue;
    const parsed = parseLine(row.text);
    if (!parsed.csv) continue;
    const grid: Grid = { cells: parsed.cells, columns, delimiter: parsed.delimiter };
    const first = firstNonEmptyIndex(parsed.cells);
    if (first < 0) continue;
    const firstText = (parsed.cells[first] as string).replace(/\s+/g, " ").trim();
    if (VAT_RE.test(row.text)) vatRows.push(parsed);
    if (TSN_SKIP_RE.test(firstText)) {
      close(false);
      continue;
    }

    const graph1 = cellAt(grid, 1);
    const graph2 = cellAt(grid, 2);
    const graph3 = cellAt(grid, 3);
    if (/^\d+$/.test(graph1) && (graph2 !== "" || graph3 !== "")) {
      close(false);
      draft = {
        number: Number.parseInt(graph1, 10),
        label: graph1,
        sub: false,
        equipment: false,
        notes: [],
        rawJustification: (parsed.cells[columns[2] as number] ?? "").trim(),
        name: graph3,
        unit: tsnUnit(cellAt(grid, 4)),
        quantity: quantityAt(grid, 5),
        offset: row.offset,
        ownUnitPrice: null,
        ownTotal: numberAt(grid, 11),
        ownBasePrice: numberAt(grid, 6),
        ownIndex: numberAt(grid, 10),
        ownPriceCoefficient: null,
        resources: [],
        groups: { labour: null, machinistLabour: null, machines: null, materials: null },
        directTotal: null,
        wageFund: null,
        overhead: null,
        profit: null,
        perUnit: null,
        total: null,
      };
      continue;
    }
    if (draft === null) continue;
    const current: PositionDraft = draft;

    const label = graph3 !== "" ? graph3 : graph1 === "" && graph2 === "" ? firstText : "";
    const labelIndex = graph3 !== "" ? (columns[3] as number) : first;
    if (TOTAL_POSITION_RE.test(label)) {
      const run = numericRun(parsed.cells, labelIndex, parsed.delimiter);
      current.total = run.length === 0 ? null : (run[run.length >= 2 ? 1 : 0] as number);
      close(true);
      continue;
    }
    const amount = numberAt(grid, 11);
    if (TSN_LABOUR_RE.test(label)) current.groups.labour = amount;
    else if (TSN_MACHINES_RE.test(label)) current.groups.machines = amount;
    else if (TSN_MACHINIST_RE.test(label)) current.groups.machinistLabour = amount;
    else if (TSN_MATERIALS_RE.test(label)) current.groups.materials = amount;
    else {
      const rate = TSN_RATE_RE.exec(label);
      if (rate !== null && cellAt(grid, 4) === "%") {
        const base = numberAt(grid, 5);
        const value: CustomerRate = { ref: null, rawRef: label, basePercent: base, percent: numberAt(grid, 10) ?? base, amount };
        if (rate[1]?.toUpperCase() === "НР") current.overhead = value;
        else current.profit = value;
      }
    }
  }
  close(false);

  if (columns === null) return { kind: "no", reason: "нет строки нумерации граф 1–11: это не форма № 4б ТСН-2001" };
  return { kind: "ok", positions, subPositions: [], header: text.slice(0, Math.min(numberingEnd, 40_000)), rows: vatRows };
}

/** «Сметная стоимость» из шапки, тыс. руб.: у Smeta.RU «Сметная стоимость | 1,336.21 | тыс. руб.», у ТСН — пара «базис, текущий» (берётся текущий). */
function readHeaderCost(header: string): number | null {
  for (const row of logicalRows(header)) {
    const parsed = parseLine(row.text, true);
    if (!parsed.csv) continue;
    const at = parsed.cells.findIndex((cell) => /^сметная\s+стоимость$/iu.test(cell.replace(/\s+/g, " ").trim()));
    if (at < 0) continue;
    const run = numericRun(parsed.cells, at, parsed.delimiter);
    if (run.length > 0) return run[run.length - 1] as number;
  }
  return null;
}

/**
 * Локальные сметы формы 421/пр из текстов документов.
 *
 * Отрезки сметы — как у `parseCustomerEstimates`. Отрезок не по форме 421/пр попадает
 * в `notRecognized` с причиной; пустые отрезки (шум) молчат.
 */
export function parseCustomerLsr(documents: readonly DocumentText[]): CustomerLsrParse {
  const estimates: CustomerLsr[] = [];
  const notRecognized: NotRecognizedEstimate[] = [];

  for (const document of documents) {
    for (const segment of splitCustomerEstimates(document)) {
      if (segment.noise) continue;
      const { estimate } = segment;
      // Служебные листы Smeta.RU (`Source`, `EtalonRes`…) — дамп базы программы: не смета и не «не распознанная» смета.
      if (isSmetaRuServiceSheet(estimate.estimateName)) continue;
      const smeta = detectSmetaRu(segment.text);
      // Форма № 4б ТСН-2001 узнаётся по самой шапке (ТСН-2001 и «Шифр расценки»), а не по программе: ту же
      // 11-графную форму выгружают не только из Smeta.RU. Закупка 32616405004 (КДЦ «Арктика», 20.10.2026): четыре
      // ЛСР по ТСН-2001 без признаков Smeta.RU не читались совсем — «нет строки нумерации граф 1–12».
      const tsn = isTsnFormHead(segment.text.slice(0, 8_000));
      const parsed = tsn ? parseTsnSegment(segment.text) : parseSegment(segment.text);
      if (parsed.kind === "no") {
        notRecognized.push({ documentName: estimate.documentName, estimateName: estimate.estimateName, reason: parsed.reason });
        continue;
      }
      if (parsed.positions.length === 0) {
        notRecognized.push({
          documentName: estimate.documentName,
          estimateName: estimate.estimateName,
          reason: tsn ? "форма № 4б ТСН-2001 распознана, но позиций в ней не нашлось" : "форма 421/пр распознана, но позиций в ней не нашлось",
        });
        continue;
      }

      // НДС: из итогов (строки до итога сметы и сразу за ним), иначе выводится по итогу.
      const vat = readVat([...parsed.rows, ...vatRowsFromTail(segment.tail)]);
      const inferred = vat === null ? inferVat(estimate.sectionsTotal, estimate.statedTotal) : null;
      const header = readHeader(parsed.header);
      const limited = readLimitedCosts(`${segment.text}\n${segment.tail}`);
      const identity = readIdentity(parsed.header, estimate.estimateName, estimate.documentName, smeta !== null);
      const headerCost = smeta === null ? null : readHeaderCost(parsed.header);
      const base = tsn ? normBaseOf(parsed.header) : null;

      estimates.push({
        documentName: estimate.documentName,
        estimateName: estimate.estimateName,
        ...header,
        vatPercent: vat?.percent ?? inferred,
        vatInferred: vat === null && inferred !== null,
        vatAmount: vat?.amount ?? null,
        sectionsTotal: estimate.sectionsTotal,
        total: estimate.statedTotal,
        positionsTotal: parsed.positions.reduce((sum, position) => sum + (position.total ?? 0), 0),
        positions: parsed.positions,
        ...(parsed.subPositions.length === 0 ? {} : { subPositions: parsed.subPositions }),
        ...identity,
        ...(smeta === null ? {} : { program: smeta.program }),
        ...(smeta?.method == null ? {} : { method: smeta.method }),
        ...(base === null ? {} : { base }),
        ...(headerCost === null ? {} : { headerTotalThousands: headerCost }),
        ...(limited === null ? {} : { limitedCosts: limited }),
      });
    }
  }
  return { estimates, notRecognized };
}

/** Строки НДС в хвосте за итогом сметы («Итого до НДС / НДС 20 % / Всего с НДС» у некоторых программ). */
function vatRowsFromTail(tail: string): ParsedLine[] {
  const rows: ParsedLine[] = [];
  for (const row of logicalRows(tail)) {
    if (!VAT_RE.test(row.text)) continue;
    const parsed = parseLine(row.text);
    if (parsed.csv) rows.push(parsed);
  }
  return rows;
}
