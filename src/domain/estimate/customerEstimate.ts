import { headOfEstimate } from "@/domain/estimate/customerPriceLevel";
import {
  declaredPriceLevel,
  type DeclaredPriceLevel,
} from "@/domain/estimate/priceLevel";
import { isSmetaRuServiceSheet, isSmetaRuText, isTsnFormHead, methodOfHeader, normBaseOf } from "@/domain/estimate/smetaRu";

/**
 * Смета заказчика, прочитанная из документации, и разделы в тексте.
 *
 * Зачем. Расчёт по ведомости отвечает «сколько это стоит у нас», а у заказчика
 * в документации обычно лежит своя локальная смета: с разделами и итогами. Чтобы
 * сравнить две сметы по разделам и показать, ГДЕ заказчик заложил меньше, чем
 * выходит по текущим ценам, нужно две вещи: прочитать разделы и суммы сметы
 * заказчика и понять, к какому разделу относится каждая наша позиция.
 *
 * Граница между моделью и кодом. Здесь нет ни модели, ни догадок: заголовки
 * разделов и строки итогов находятся по тексту, раздел позиции — по месту её
 * цитаты в документе. Поле «раздел», которое возвращает модель, ненадёжно:
 * документ режется на фрагменты, и заголовок раздела остаётся в предыдущем.
 *
 * Что считается достоверным. Сумма из строки «Итого по разделу» принимается,
 * только если разделы сходятся с итогом сметы (или с итогом с НДС). В таблице
 * несколько чисел подряд — сумма, затем трудозатраты, затем часы машинистов, — и
 * без сверки с итогом легко взять не ту колонку. Не сошлось — `checked: false`,
 * и интерфейс говорит об этом прямо, а не выдаёт число за проверенное.
 *
 * Модуль чистый, работает за линейное время: тексты бывают до мегабайта, поэтому
 * разбираются только строки, где есть «раздел», «итого», «всего» или «=== ».
 */

/* ------------------------------ Типы ------------------------------ */

export interface SectionHeading {
  /** Смещение начала строки заголовка в тексте. */
  readonly offset: number;
  /** Номер раздела: «1», «II». null — номера нет. */
  readonly number: string | null;
  /** Название без «Раздел N.»; нет названия — «Раздел N». */
  readonly title: string;
  /** Ближайший предыдущий заголовок «=== … ===» — лист или файл архива. */
  readonly estimateName: string | null;
  /**
   * Где действие заголовка заканчивается: смещение первой строки итога сметы или
   * начала следующего листа после него. null — до конца текста.
   * Нужно `sectionAt`: позиция после итога сметы уже вне сметы.
   */
  readonly endsAt: number | null;
}

export interface CustomerSection {
  readonly number: string | null;
  readonly title: string;
  /** Сумма раздела, ₽, из выбранной колонки. */
  readonly amount: number;
  /** Строка документа, из которой взята сумма. */
  readonly quote: string;
}

export type CustomerEstimateMethod = "RESOURCE_2022" | "BASE_2001" | "UNKNOWN";

/**
 * База норм сметы заказчика, когда она не наша (ФСНБ-2022): у такой сметы нормы и их состав нам неизвестны, и построчно
 * сверять расценки с нашими нельзя. Нет поля — база не названа (ФСНБ-2022, ФЕР/ТЕР и прочее читаются по `method`).
 * `TSN_2001_MOSCOW` — территориальные сметные нормы Москвы ТСН-2001 (шифры «4.8-61-4», «ТСН-2001.16», индексы МГЭ): норм ТСН у нас нет.
 */
export type CustomerNormBase = "TSN_2001_MOSCOW";

/** Название базы так, как его пишет отчёт. */
export const CUSTOMER_NORM_BASE_LABEL: Readonly<Record<CustomerNormBase, string>> = {
  TSN_2001_MOSCOW: "ТСН-2001 (Москва)",
};

export interface CustomerEstimate {
  readonly documentName: string;
  /** Лист или файл внутри архива («=== … ==="); null — документ не разбит на листы. */
  readonly estimateName: string | null;
  readonly sections: readonly CustomerSection[];
  /** Сумма разделов. */
  readonly sectionsTotal: number;
  /** Итог сметы, с которым сошлись разделы; иначе первый найденный. */
  readonly statedTotal: number | null;
  /** Итог указан с НДС (сошёлся с суммой разделов ×1,22 или ×1,20). null — не сверено. */
  readonly totalIncludesVat: boolean | null;
  /** Сумма разделов сошлась с итогом сметы. */
  readonly checked: boolean;
  readonly priceLevel: DeclaredPriceLevel;
  readonly method: CustomerEstimateMethod;
  /** База норм, если это ТСН-2001 Москвы (`CustomerNormBase`); нет поля — база не названа. */
  readonly base?: CustomerNormBase;
}

export interface DocumentText {
  readonly name: string;
  readonly text: string;
}

/* ------------------------- Нормализация названий ------------------------- */

const ROMAN = "(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})";

/**
 * Название раздела для сопоставления двух смет: без регистра, «ё», префикса
 * «Раздел N.», нумерации, кавычек и пунктуации.
 */
export function normalizeSectionTitle(title: string): string {
  const folded = title.toLowerCase().replace(/ё/g, "е").replace(/[  ]/g, " ");
  const withoutPrefix = folded
    .replace(new RegExp(`^\\s*раздел\\s+(?:\\d+|${ROMAN})(?![\\p{L}\\d])\\s*[.:)\\u2013\\u2014-]?`, "u"), "")
    .replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, "");
  const cleaned = withoutPrefix.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (cleaned !== "") return cleaned;
  // «Раздел I» без названия: сравнивать нечем, кроме самого обозначения.
  return folded.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/* ------------------------------ Разбор строк ------------------------------ */

/** Строка стоит разбора, только если в ней есть один из этих маркеров. */
const RELEVANT_LINE = /раздел|итого|всего|^\s*===/i;

const HEADING_RE = new RegExp(
  `^раздел\\s+(\\d+|${ROMAN})(?![\\p{L}\\d])\\s*(?:[.:)\\u2013\\u2014-]\\s*(.*))?$`,
  "iu",
);
/**
 * Итог раздела: «Итого по разделу …» или, в выгрузке РИМ, «Всего по разделу …».
 * «Итого по подразделу», «Итого прямые затраты по разделу» и «Итого по ТСН-2001.16»
 * сюда не попадают: после «итого»/«всего» обязано стоять ровно «по разделу».
 */
const SECTION_TOTAL_RE = /(?<![\p{L}\d])(итого|всего)\s+по\s+разделу(?![\p{L}])\s*(.*)$/isu;
/** Заголовок без номера (Гранд-Смета, ТСН): «Раздел: Опора PSKT90». «Подраздел:» сюда не попадает. */
const HEADING_NAMED_RE = /^раздел\s*:\s*(.*)$/iu;
/** Строки индексов, а не разделы: «в базовых ценах», «в базисных ценах», «в текущих ценах». */
const INDEX_TITLE_RE = /^\s*в\s+(?:базов|базис|текущ)[а-яё]*\s+цен/iu;
/**
 * Мусор плоского текста (PDF): склеенные справочные строки итогов попадают в
 * «название раздела» — «Справочно затраты труда рабочих затраты труда машинистов…».
 * Настоящее название раздела таких слов не содержит.
 */
const GARBAGE_TITLE_RE =
  /(?<![\p{L}\d])(?:справочно|затраты\s+труда|накладные\s+расходы|сметная\s+прибыль|итого|всего)(?![\p{L}])/iu;
const SECTION_REST_RE = new RegExp(
  `^(?:раздел\\s+)?(\\d+|${ROMAN})(?![\\p{L}\\d])\\s*[.:)\\u2013\\u2014-]?\\s*(.*)$`,
  "iu",
);
/** Итог сметы. «Итого по разделу» сюда не попадает: после «по» стоит другое слово. */
const ESTIMATE_TOTAL_RE =
  /(?<![\p{L}\d])(?:итого|всего)\s+по\s+(?:локальной\s+смете|локальному\s+сметному\s+расчет[уе]|смете)(?![\p{L}])/iu;
/**
 * Строка итога, в которой назван НДС: кандидат «итог с НДС», а не итог сметы.
 * Расстояние до «НДС» ограничено: безграничное `[^\n]*` на длинной строке с тысячами «итого» даёт квадрат.
 */
const VAT_TOTAL_RE = /(?<![\p{L}\d])(?:итого|всего)(?![\p{L}])[^\n]{0,120}ндс/iu;
const LABEL_WORD_RE = /итого|всего/i;

const MONEY_RE =
  /(?<![\d.,])(?:\d{1,3}(?:[   ]\d{3})+[.,]\d{2}|\d{1,3}(?:,\d{3})+\.\d{2}|\d+[.,]\d{2})(?!\d)/g;

/** Сколько чисел после метки храним: сумма, затем трудозатраты и часы машинистов. */
const MAX_COLUMNS = 3;
const MAX_QUOTE = 200;

function romanNumber(raw: string): string {
  return /^\d+$/.test(raw) ? raw : raw.toUpperCase();
}

function parseFlatMoney(raw: string): number | null {
  let s = raw.replace(/[\s  ]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const value = Number.parseFloat(s);
  return Number.isFinite(value) ? value : null;
}

/** Деньги плоского текста (PDF): только числа с двумя знаками после запятой. */
function flatMoney(text: string): number[] {
  const result: number[] = [];
  for (const match of text.matchAll(MONEY_RE)) {
    const value = parseFlatMoney(match[0]);
    if (value !== null) result.push(value);
    if (result.length >= MAX_COLUMNS) break;
  }
  return result;
}

/**
 * Число из ячейки CSV: «204,011.54», «1 234 567,89», «677387,10», 248.00.
 * В «;»-файле запятая — десятичная, в «,»-файле — разделитель тысяч.
 */
export function parseNumberCell(cell: string, delimiter: string): number | null {
  const s = cell.replace(/[\s  ]/g, "");
  if (!/^-?\d[\d.,]*$/.test(s)) return null;
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const commas = (body.match(/,/g) ?? []).length;
  const dots = (body.match(/\./g) ?? []).length;
  let normalized: string;
  if (commas > 0 && dots > 0) {
    const decimal = body.lastIndexOf(",") > body.lastIndexOf(".") ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    normalized = body.split(thousands).join("").replace(decimal, ".");
  } else if (commas > 1) {
    if (!/^\d{1,3}(,\d{3})+$/.test(body)) return null;
    normalized = body.replace(/,/g, "");
  } else if (commas === 1) {
    normalized =
      delimiter !== ";" && /^\d{1,3},\d{3}$/.test(body) ? body.replace(",", "") : body.replace(",", ".");
  } else if (dots > 1) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(body)) return null;
    normalized = body.replace(/\./g, "");
  } else {
    normalized = body;
  }
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

export interface ParsedLine {
  readonly cells: readonly string[];
  /** Строка разобрана как CSV: числа берутся из ячеек, а не из плоского текста. */
  readonly csv: boolean;
  readonly delimiter: string;
}

/** Делит строку на ячейки с учётом кавычек. Разделитель — тот, которого больше вне кавычек. */
export function parseLine(line: string, forceTable = false): ParsedLine {
  let semicolons = 0;
  let commas = 0;
  let inQuotes = false;
  let hasQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      hasQuote = true;
    } else if (!inQuotes) {
      if (char === ";") semicolons += 1;
      else if (char === ",") commas += 1;
    }
  }
  const delimiter = semicolons >= commas ? ";" : ",";
  if (Math.max(semicolons, commas) < 4) return { cells: [line], csv: false, delimiter };

  const cells: string[] = [];
  let current = "";
  inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else inQuotes = false;
      } else current += char;
    } else if (char === '"') inQuotes = true;
    else if (char === delimiter) {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);

  // Много запятых в обычной фразе — ещё не таблица: у таблицы есть пустые ячейки или кавычки.
  const tabular = forceTable || hasQuote || cells.some((cell) => cell.trim() === "");
  return tabular ? { cells, csv: true, delimiter } : { cells: [line], csv: false, delimiter };
}

/**
 * Название из строки: обрезается там, где начинается хвост пустых ячеек
 * («Монтаж,,,,»), без хвостовой пунктуации и многоточий.
 */
function cleanTitle(raw: string): string {
  return (raw.split(/[,;]{2,}/)[0] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:,…\s]+$/, "");
}

function cut(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_QUOTE ? `${clean.slice(0, MAX_QUOTE)}…` : clean;
}

type ScanEvent =
  | { kind: "sheet"; offset: number; end: number; name: string }
  | { kind: "heading"; offset: number; end: number; number: string | null; title: string }
  | {
      kind: "sectionTotal";
      /** «Итого по разделу» или «Всего по разделу»: при одном номере «Всего» главнее. */
      label: "ITOGO" | "VSEGO";
      offset: number;
      end: number;
      number: string | null;
      title: string;
      nums: number[];
      quote: string;
    }
  | { kind: "estimateTotal"; offset: number; end: number; nums: number[] }
  | { kind: "vatTotal"; offset: number; end: number; nums: number[] };

/** Числа CSV-строки после ячейки-метки; повтор метки в хвосте строки обрывает чтение. */
function numbersAfter(parsed: ParsedLine, labelIndex: number): number[] {
  const nums: number[] = [];
  for (let i = labelIndex + 1; i < parsed.cells.length && nums.length < MAX_COLUMNS; i += 1) {
    const cell = parsed.cells[i] as string;
    if (LABEL_WORD_RE.test(cell)) break;
    const value = parseNumberCell(cell, parsed.delimiter);
    if (value !== null) nums.push(value);
  }
  return nums;
}

function eventOfLine(line: string, offset: number, end: number): ScanEvent | null {
  const trimmed = line.trim();
  if (trimmed.length >= 6 && trimmed.startsWith("===") && trimmed.endsWith("===")) {
    return { kind: "sheet", offset, end, name: trimmed.slice(3, -3).trim() };
  }

  const parsed = parseLine(line);
  const firstCell = parsed.cells.find((cell) => cell.trim() !== "");
  if (firstCell === undefined) return null;

  const heading = HEADING_RE.exec(firstCell.trim());
  if (heading !== null) {
    const number = romanNumber(heading[1] as string);
    const title = cleanTitle(heading[2] ?? "");
    return { kind: "heading", offset, end, number, title: title === "" ? `Раздел ${number}` : title };
  }
  const named = HEADING_NAMED_RE.exec(firstCell.trim());
  if (named !== null) {
    const title = cleanTitle(named[1] ?? "");
    if (title !== "") return { kind: "heading", offset, end, number: null, title };
  }

  for (const [index, cell] of parsed.cells.entries()) {
    const sectionTotal = SECTION_TOTAL_RE.exec(cell);
    if (sectionTotal !== null) {
      let rest = (sectionTotal[2] ?? "").trim();
      let nums: number[];
      if (parsed.csv) nums = numbersAfter(parsed, index);
      else {
        // В плоском тексте название кончается там, где начинаются деньги.
        const firstMoney = new RegExp(MONEY_RE.source).exec(rest);
        nums = flatMoney(rest);
        if (firstMoney !== null) rest = rest.slice(0, firstMoney.index).trim();
      }
      if (nums.length === 0) return null;
      // «Итого по разделу: Опора» — двоеточие и тире перед названием не его часть.
      rest = rest.replace(/^[\s:.\-\u2013\u2014]+/, "");
      const parts = SECTION_REST_RE.exec(rest);
      const number = parts === null ? null : romanNumber(parts[1] as string);
      const title = cleanTitle(parts === null ? rest : (parts[2] ?? ""));
      return {
        kind: "sectionTotal",
        label: (sectionTotal[1] as string).toLowerCase() === "всего" ? "VSEGO" : "ITOGO",
        offset,
        end,
        number,
        title,
        nums,
        quote: cut(quoteOf(parsed, index)),
      };
    }

    const label = ESTIMATE_TOTAL_RE.exec(cell);
    if (label !== null) {
      const hasVat = /ндс/i.test(cell);
      const nums = parsed.csv
        ? numbersAfter(parsed, index)
        : flatMoney(cell.slice(label.index + label[0].length));
      if (hasVat) return nums.length === 0 ? null : { kind: "vatTotal", offset, end, nums };
      // Метка без чисел всё равно завершает действие заголовка раздела, но сметы не закрывает.
      return { kind: "estimateTotal", offset, end, nums };
    }

    if (VAT_TOTAL_RE.test(cell)) {
      const nums = parsed.csv ? numbersAfter(parsed, index) : flatMoney(cell);
      return nums.length === 0 ? null : { kind: "vatTotal", offset, end, nums };
    }
  }
  return null;
}

/** Строка для цитаты: непустые ячейки до повтора метки в хвосте. */
function quoteOf(parsed: ParsedLine, labelIndex: number): string {
  if (!parsed.csv) return parsed.cells[0] ?? "";
  const parts: string[] = [];
  for (const [i, cell] of parsed.cells.entries()) {
    if (!/[\p{L}\d]/u.test(cell)) continue;
    if (i > labelIndex && LABEL_WORD_RE.test(cell)) break;
    parts.push(cell.trim());
  }
  return parts.join("; ");
}

/**
 * Итог подраздела в выгрузке Smeta.RU: блок «Итого прямые затраты по подразделу … Всего ФОТ, накладные расходы …» закрывается
 * строкой «Итого по разделу» (программа называет её так и у подраздела). Это итог подраздела, а не раздела: следом идёт блок
 * «Итого прямые затраты по разделу» и настоящий итог раздела. Подраздел разделом не считается — иначе суммы разделов вдвое
 * больше итога сметы, и сверка с «ВСЕГО по смете» не сходится.
 */
const SUBSECTION_BLOCK_RE = /итого\s+прямые\s+затраты\s+по\s+подразделу/iu;

/** Разбирает текст в события по строкам; строки без маркеров пропускаются. */
function scan(text: string): ScanEvent[] {
  const events: ScanEvent[] = [];
  let position = 0;
  /** Блок итогов подраздела открыт: ближайшая строка «Итого по разделу» — итог подраздела и событием не становится. */
  let subsectionOpen = false;
  while (position <= text.length) {
    const newline = text.indexOf("\n", position);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(position, lineEnd).replace(/\r$/, "");
    if (line !== "" && RELEVANT_LINE.test(line)) {
      if (SUBSECTION_BLOCK_RE.test(line)) subsectionOpen = true;
      const event = eventOfLine(line, position, lineEnd);
      if (event !== null) {
        if (event.kind === "sectionTotal" && subsectionOpen) subsectionOpen = false;
        else {
          if (event.kind === "sheet" || event.kind === "heading") subsectionOpen = false;
          events.push(event);
        }
      }
    }
    if (newline < 0) break;
    position = newline + 1;
  }
  return events;
}

/* ------------------------- Заголовки разделов ------------------------- */

/** Заголовки «Раздел N. Название» в порядке следования. «Итого по разделу …» — не заголовок. */
export function sectionHeadings(text: string): SectionHeading[] {
  const headings: SectionHeading[] = [];
  let estimateName: string | null = null;
  let open: number[] = [];
  for (const event of scan(text)) {
    if (event.kind === "sheet") {
      estimateName = event.name;
      for (const index of open) headings[index] = withEnd(headings[index] as SectionHeading, event.offset);
      open = [];
    } else if (event.kind === "heading") {
      headings.push({
        offset: event.offset,
        number: event.number,
        title: event.title,
        estimateName,
        endsAt: null,
      });
      open.push(headings.length - 1);
    } else if (event.kind === "estimateTotal") {
      for (const index of open) headings[index] = withEnd(headings[index] as SectionHeading, event.offset);
      open = [];
    }
  }
  return headings;
}

function withEnd(heading: SectionHeading, endsAt: number): SectionHeading {
  return { ...heading, endsAt };
}

/**
 * Заголовок, действующий в позиции `offset`: последний с `offset` не больше данного.
 * null — заголовков ещё не было либо между ним и позицией стоит строка итога сметы
 * (или начался новый лист): позиция уже вне сметы.
 */
export function sectionAt(
  headings: readonly SectionHeading[],
  offset: number,
): SectionHeading | null {
  let low = 0;
  let high = headings.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((headings[middle] as SectionHeading).offset <= offset) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (found < 0) return null;
  const heading = headings[found] as SectionHeading;
  if (heading.endsAt !== null && heading.endsAt <= offset) return null;
  return heading;
}

/* ----------------------------- Сметы заказчика ----------------------------- */

interface RawSection {
  label: "ITOGO" | "VSEGO";
  number: string | null;
  title: string;
  nums: number[];
  quote: string;
}

interface HeadingEntry {
  readonly number: string | null;
  readonly title: string;
  /** Заголовок уже закрыт итогом раздела (позиционная пара для итога без названия). */
  used: boolean;
}

/** Очередь с указателем: закрытые заголовки пропускаются лениво, без перебора всего списка. */
interface HeadingQueue {
  readonly items: HeadingEntry[];
  head: number;
}

/**
 * Заголовки сегмента. Итог раздела должен найти свой заголовок быстро, а в смете
 * бывают тысячи разделов: перебор всех заголовков на каждый итог давал квадрат.
 * Поэтому закрытые пропускаются лениво (указатель в очереди, вершина стека).
 */
interface HeadingBook {
  /** Первый заголовок с таким номером — запасной вариант, когда все уже закрыты. */
  readonly firstByNumber: Map<string, HeadingEntry>;
  readonly queueByNumber: Map<string, HeadingQueue>;
  readonly queueByTitle: Map<string, HeadingQueue>;
  /** Незакрытые заголовки в порядке следования: вершина — ближайший выше. */
  readonly stack: HeadingEntry[];
}

function newBook(): HeadingBook {
  return { firstByNumber: new Map(), queueByNumber: new Map(), queueByTitle: new Map(), stack: [] };
}

function enqueue(map: Map<string, HeadingQueue>, key: string, entry: HeadingEntry): void {
  const queue = map.get(key) ?? { items: [], head: 0 };
  queue.items.push(entry);
  map.set(key, queue);
}

function firstUnused(queue: HeadingQueue | undefined): HeadingEntry | undefined {
  if (queue === undefined) return undefined;
  while (queue.head < queue.items.length && (queue.items[queue.head] as HeadingEntry).used) queue.head += 1;
  return queue.items[queue.head];
}

function addHeading(book: HeadingBook, number: string | null, title: string): void {
  const entry: HeadingEntry = { number, title, used: false };
  book.stack.push(entry);
  enqueue(book.queueByTitle, normalizeSectionTitle(title), entry);
  if (number !== null) {
    enqueue(book.queueByNumber, number, entry);
    if (!book.firstByNumber.has(number)) book.firstByNumber.set(number, entry);
  }
}

/**
 * Заголовок, который закрывает итог раздела: по номеру, затем по названию, а итог
 * без названия — ближайший выше заголовок, ещё не закрытый другим итогом.
 */
function closeHeading(
  book: HeadingBook,
  number: string | null,
  title: string,
): HeadingEntry | undefined {
  let heading: HeadingEntry | undefined;
  if (number !== null) {
    heading = firstUnused(book.queueByNumber.get(number)) ?? book.firstByNumber.get(number);
  } else if (title !== "") {
    heading = firstUnused(book.queueByTitle.get(normalizeSectionTitle(title)));
  }
  if (heading === undefined && title === "") {
    while (book.stack.length > 0 && (book.stack[book.stack.length - 1] as HeadingEntry).used) book.stack.pop();
    heading = book.stack[book.stack.length - 1];
  }
  if (heading !== undefined) heading.used = true;
  return heading;
}

interface Segment {
  startOffset: number;
  hasContent: boolean;
  /** Заголовки сегмента и индексы для закрытия итогами без перебора. */
  headings: HeadingBook;
  sections: RawSection[];
  candidates: number[][];
}

interface DraftEstimate {
  readonly documentName: string;
  readonly estimateName: string | null;
  readonly sections: readonly RawSection[];
  readonly candidates: number[][];
  readonly text: string;
  /** Смещение начала отрезка в тексте документа (сразу за меткой листа или за итогом предыдущей сметы). */
  readonly startOffset: number;
  /** Смещение конца отрезка в тексте документа: за ним может идти хвост с НДС. */
  readonly endOffset: number;
}

function freshSegment(startOffset: number): Segment {
  return { startOffset, hasContent: false, headings: newBook(), sections: [], candidates: [] };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Допуск сверки: рубль или 0,1 % итога. */
function tolerance(total: number): number {
  return Math.max(1, Math.abs(total) * 0.001);
}

const VAT_FACTORS: readonly number[] = [1.22, 1.2];

/** Сошёлся ли итог с суммой разделов: прямо или с НДС. null — не сошёлся. */
function matchTotal(sum: number, total: number): { includesVat: boolean } | null {
  if (Math.abs(sum - total) <= tolerance(total)) return { includesVat: false };
  for (const factor of VAT_FACTORS) {
    if (Math.abs(total - sum * factor) <= tolerance(total)) return { includesVat: true };
  }
  return null;
}

/**
 * Метод сметы по тексту её отрезка. Явные слова шапки («Составлен базисно-индексным методом») важнее перечня приказов: Smeta.RU
 * печатает 421/пр, 812/пр и 774/пр в редакциях нормативов и у базисно-индексной сметы, и по одному «421/пр» она читалась
 * ресурсной (закупка 0373100037626000119: расценки на уровне цен 01.01.2000 приняты за ФСНБ-2022).
 */
export function methodOf(text: string): CustomerEstimateMethod {
  // Территориальные базы Москвы (ТСН-2001, ТСН-2011): в них тоже бывает «в текущем
  // уровне цен», но базой остаются старые нормы — с ФСНБ-2022 по разделам не сравнить.
  if (/(?<![\p{L}\d])тсн[\s\-]*(?:2001|2011)(?!\d)/iu.test(text)) return "BASE_2001";
  const named = methodOfHeader(text);
  if (named === "BASE_INDEX") return "BASE_2001";
  if (named === "RESOURCE_INDEX") return "RESOURCE_2022";
  for (const match of text.matchAll(/(?<!\d)2001(?!\d)/g)) {
    const at = match.index ?? 0;
    if (/базисн|ценах/i.test(text.slice(Math.max(0, at - 60), at + 64))) return "BASE_2001";
  }
  if (/(?<![\p{L}\d])(?:тер|фер)[рмпн]{0,2}\s*-?\s*\d{2}-\d{2}/iu.test(text)) return "BASE_2001";
  if (/фснб-?\s*2022|01\.01\.2022|методик[а-я]*\s*2020|421\/пр|в\s+текущем\s+уровне\s+цен/i.test(text)) {
    return "RESOURCE_2022";
  }
  return "UNKNOWN";
}

function finalize(draft: DraftEstimate): CustomerEstimate {
  // Строки индексов («в базовых ценах») — не разделы: сверка по ним проходила случайно.
  const real = draft.sections.filter(
    (section) => !INDEX_TITLE_RE.test(section.title) && !GARBAGE_TITLE_RE.test(section.title),
  );
  // Один номер раздела и «Итого по разделу», и «Всего по разделу» — берётся «Всего».
  const keyOf = (section: RawSection): string =>
    section.number !== null ? `n:${section.number}` : `t:${normalizeSectionTitle(section.title)}`;
  const withTotal = new Set(real.filter((section) => section.label === "VSEGO").map(keyOf));
  const sections = real.filter((section) => section.label === "VSEGO" || !withTotal.has(keyOf(section)));
  const seen = new Set<string>();
  const unique: RawSection[] = [];
  for (const section of sections) {
    const key = `${section.number ?? ""}|${normalizeSectionTitle(section.title)}|${section.nums.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(section);
  }

  let columns = 0;
  let stated: number | null = draft.candidates[0]?.[0] ?? null;
  let includesVat: boolean | null = null;
  let checked = false;

  /*
    Форма № 4б ТСН-2001 печатает суммы парами: «в базисном уровне цен», затем «в текущем». Сметой заказчика считается текущий
    уровень — вторая колонка, а первая (базисная 2001 года) сошлась бы с итогом так же легко и дала бы итог в 7–8 раз меньше.
  */
  const columnOrder = isTsnFormHead(draft.text.slice(0, 8_000)) ? [1, 0, 2] : [0, 1, 2];
  search: for (const k of columnOrder) {
    if (unique.length === 0) break;
    if (unique.some((section) => section.nums[k] === undefined)) continue;
    const sum = unique.reduce((total, section) => total + (section.nums[k] as number), 0);
    for (const candidate of draft.candidates) {
      const total = candidate[k];
      if (total === undefined) continue;
      const matched = matchTotal(sum, total);
      if (matched !== null) {
        columns = k;
        stated = total;
        includesVat = matched.includesVat;
        checked = true;
        break search;
      }
    }
  }

  const parts: CustomerSection[] = unique.map((section) => ({
    number: section.number,
    title: section.title,
    amount: section.nums[columns] ?? 0,
    quote: section.quote,
  }));

  const base = normBaseOf(headOfEstimate(draft.text));
  return {
    documentName: draft.documentName,
    estimateName: draft.estimateName,
    sections: parts,
    sectionsTotal: round2(parts.reduce((total, section) => total + section.amount, 0)),
    statedTotal: stated,
    totalIncludesVat: includesVat,
    checked,
    priceLevel: declaredPriceLevel(headOfEstimate(draft.text)),
    method: methodOf(draft.text),
    ...(base === null ? {} : { base }),
  };
}

function estimatesOfDocument(document: DocumentText): DraftEstimate[] {
  const drafts: DraftEstimate[] = [];
  let segment = freshSegment(0);
  let sheetName: string | null = null;
  let lastInSheet = -1;

  const attachToLast = (nums: number[]): void => {
    const last = drafts[lastInSheet] as DraftEstimate;
    last.candidates.push(nums);
  };

  /*
    Сегмент с итогами разделов, но без строки «ВСЕГО по смете»: текст кончился или
    начался новый лист. Чаще всего это файл, обрезанный бюджетом разбора раньше
    итога. Суммы взяты из явных строк «Итого по разделу», поэтому смета
    возвращается — но без итога и без сверки (`checked: false`), и интерфейс
    предупреждает об этом.
  */
  const flushOpen = (endOffset: number): void => {
    if (segment.sections.length === 0) return;
    drafts.push({
      documentName: document.name,
      estimateName: sheetName,
      sections: segment.sections,
      candidates: [],
      text: document.text.slice(segment.startOffset, endOffset),
      startOffset: segment.startOffset,
      endOffset,
    });
  };

  for (const event of scan(document.text)) {
    switch (event.kind) {
      case "sheet":
        flushOpen(event.offset);
        segment = freshSegment(event.end);
        sheetName = event.name;
        lastInSheet = -1;
        break;
      case "heading":
        segment.hasContent = true;
        addHeading(segment.headings, event.number, event.title);
        break;
      case "sectionTotal": {
        segment.hasContent = true;
        const heading = closeHeading(segment.headings, event.number, event.title);
        const title =
          event.title !== ""
            ? event.title
            : (heading?.title ?? (event.number === null ? "Без названия" : `Раздел ${event.number}`));
        segment.sections.push({
          label: event.label,
          number: event.number,
          title,
          nums: event.nums,
          quote: event.quote,
        });
        break;
      }
      case "vatTotal":
        if (!segment.hasContent && lastInSheet >= 0) attachToLast(event.nums);
        else segment.candidates.push(event.nums);
        break;
      case "estimateTotal": {
        if (event.nums.length === 0) break;
        if (!segment.hasContent && lastInSheet >= 0) {
          attachToLast(event.nums);
          break;
        }
        drafts.push({
          documentName: document.name,
          estimateName: sheetName,
          sections: segment.sections,
          candidates: [...segment.candidates, event.nums],
          text: document.text.slice(segment.startOffset, event.end),
          startOffset: segment.startOffset,
          endOffset: event.end,
        });
        lastInSheet = drafts.length - 1;
        segment = freshSegment(event.end);
        break;
      }
    }
  }
  flushOpen(document.text.length);
  return drafts;
}

/**
 * Сметы заказчика из текстов документов.
 *
 * Одна смета — отрезок текста, закрытый строкой итога. Разделы — строки
 * «Итого по разделу …»; раздел без собственной строки итога в смету не попадает.
 * Смета без единого раздела, но с итогом, возвращается с `sections: []`.
 * Одна смета в двух документах (PDF и xlsx) считается один раз.
 */
/** Смета документа вместе с текстом своего отрезка: по нему строчный разбор читает позиции. */
export interface CustomerEstimateSegment {
  readonly estimate: CustomerEstimate;
  /** Текст отрезка: от конца предыдущего итога (или начала листа) до строки итога сметы. */
  readonly text: string;
  /** Пустая смета — шум (нет разделов и итога): в списки не попадает. */
  readonly noise: boolean;
  /** Где отрезок лежит в тексте документа: `text === document.text.slice(start, end)`; хвост `tail` идёт сразу за `end`. */
  readonly start: number;
  readonly end: number;
  /**
   * Текст сразу за строкой итога (до начала следующего листа, не более 2 500 знаков):
   * часть программ печатает «НДС 20 %» и «Всего с НДС» после «ВСЕГО по смете».
   */
  readonly tail: string;
}

const MAX_TAIL = 2_500;
/**
 * У Smeta.RU за «ВСЕГО по смете» идёт справочный блок (прямые затраты по группам, ФОТ, НР, СП, «Справочно») на три десятка строк по
 * сотне запятых, и «НДС 22 %» с «Всего с НДС» стоят после него: в 2 500 знаков они не попадали.
 */
const MAX_TAIL_SMETA_RU = 12_000;

/**
 * Сметы документа с их текстом. Те же отрезки, что у `parseCustomerEstimates`, но
 * без отбрасывания шума и дублей — для разбора построчной формы сметы.
 */
export function splitCustomerEstimates(document: DocumentText): CustomerEstimateSegment[] {
  if (document.text === "") return [];
  return estimatesOfDocument(document).map((draft) => {
    const estimate = finalize(draft);
    const noStated = estimate.statedTotal === null || estimate.statedTotal === 0;
    // Хвост режется в окне, а не по всему тексту: поиск до конца документа на каждой смете был бы квадратом.
    const limit = isSmetaRuText(draft.text) ? MAX_TAIL_SMETA_RU : MAX_TAIL;
    const window = document.text.slice(draft.endOffset, draft.endOffset + limit);
    const sheet = window.indexOf("\n===");
    return {
      estimate,
      text: draft.text,
      start: draft.startOffset,
      end: draft.endOffset,
      // Служебные листы Smeta.RU (`Source`, `EtalonRes`…) — дамп базы программы, а не смета: числа в них итогами не считаются.
      noise: isSmetaRuServiceSheet(draft.estimateName) || (noStated && (estimate.sections.length === 0 || estimate.sectionsTotal === 0)),
      tail: sheet < 0 ? window : window.slice(0, sheet),
    };
  });
}

export function parseCustomerEstimates(documents: readonly DocumentText[]): CustomerEstimate[] {
  const result: CustomerEstimate[] = [];
  for (const document of documents) {
    for (const { estimate, noise } of splitCustomerEstimates(document)) {
      // Пустые сметы — шум: нет ни разделов, ни итога. Смета без разделов, но с
      // ненулевым итогом остаётся (NO_SECTIONS).
      if (noise) continue;
      const duplicate =
        estimate.sections.length > 0 &&
        result.some(
          (existing) =>
            existing.documentName !== estimate.documentName &&
            existing.sections.length === estimate.sections.length &&
            Math.abs(existing.sectionsTotal - estimate.sectionsTotal) <= 1,
        );
      if (!duplicate) result.push(estimate);
    }
  }
  return result;
}
