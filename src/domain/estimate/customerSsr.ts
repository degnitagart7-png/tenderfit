import { parseLine, parseNumberCell, type DocumentText } from "@/domain/estimate/customerEstimate";
import type { SsrGroupId } from "@/domain/estimate/ssrTypes";

/**
 * Сводный сметный расчёт заказчика (ССР, ССРСС), прочитанный из документации.
 *
 * Форма — приложение 6 к 421/пр: строки «Глава N …», позиции с суммами по графам 4-8 («всего» — последнее
 * число строки), «Итого по главе N», «Итого по главам 1-7 / 1-8 / 1-9 / 1-12», затем «Непредвиденные
 * затраты N %», индекс прогнозной инфляции, «НДС N %» и «ВСЕГО по сводному сметному расчёту».
 *
 * Принцип тот же, что у разбора локальной сметы: ничего не домысливается. Число берётся из строки с
 * меткой («Итого по главе 2», «Непредвиденные затраты»), каждое снабжено цитатой строки. Чего не нашли —
 * `null`, и аудит об этом молчит, а не угадывает. Единицы: «тыс. руб.» в тексте листа — множитель 1000.
 *
 * Модуль чистый и линейный: разбираются только строки с маркерами ССР.
 */

export interface CustomerSsrLine {
  readonly name: string;
  /** Сумма строки («всего», последнее число), ₽. */
  readonly amount: number;
  readonly quote: string;
}

export interface CustomerSsrChapter {
  readonly number: number;
  readonly title: string;
  readonly lines: readonly CustomerSsrLine[];
  /** Сумма строк главы, ₽. */
  readonly linesTotal: number;
  /** «Итого по главе N», ₽; null — строки итога нет. */
  readonly stated: number | null;
  readonly quote: string | null;
}

export interface CustomerSsrGroup {
  readonly id: SsrGroupId;
  readonly from: number;
  readonly to: number;
  readonly stated: number;
  readonly quote: string;
}

export interface CustomerSsrPeriod {
  /** «2026-10». */
  readonly start: string;
  readonly end: string;
}

export interface CustomerSsr {
  readonly documentName: string;
  readonly estimateName: string | null;
  /** Множитель единиц: 1000 для «тыс. руб.». */
  readonly unitMultiplier: 1 | 1000;
  readonly chapters: readonly CustomerSsrChapter[];
  readonly groups: readonly CustomerSsrGroup[];
  readonly reserve: { readonly percent: number | null; readonly amount: number | null; readonly quote: string } | null;
  /** Итог с резервом, до НДС, ₽ («Итого с непредвиденными»). */
  readonly afterReserve: { readonly amount: number; readonly quote: string } | null;
  readonly inflation: {
    readonly index: number | null;
    readonly amount: number | null;
    /** Период работ из строки индекса: «октябрь-ноябрь 2026 г». */
    readonly periodText: string | null;
    readonly period: CustomerSsrPeriod | null;
    readonly quote: string;
  } | null;
  readonly vat: { readonly percent: number | null; readonly amount: number | null; readonly quote: string } | null;
  /** «ВСЕГО по сводному сметному расчёту»; `withVat` — с НДС, без НДС или не сказано (null). */
  readonly total: { readonly amount: number; readonly withVat: boolean | null; readonly quote: string } | null;
}

/* ------------------------------ Разбор строк ------------------------------ */

const MAX_QUOTE = 200;
const SSR_MARKER = /сводн[а-яё]*\s+сметн[а-яё]*\s+расч[её]т|ссрсс|(?<![а-яa-z])сср(?![а-яa-z])/iu;
const RELEVANT = /глав|итого|всего|непредвиден|инфляц|ндс|===/iu;
const CHAPTER_RE = /^(?:№\s*)?глава\s+(\d{1,2})(?![\d])\s*[.:–—-]?\s*(.*)$/iu;
const GROUP_RE = /итого\s+по\s+главам?\s+(\d{1,2})\s*[-–—−]\s*(\d{1,2})/iu;
const CHAPTER_TOTAL_RE = /итого\s+по\s+глав[еа]\s+(\d{1,2})(?![\d-])/iu;
const RESERVE_RE = /непредвиден/iu;
const AFTER_RESERVE_RE = /итого[^\n]{0,40}(?:непредвиден|резерв)|с\s+учетом\s+(?:резерва|непредвиден)/iu;
const INFLATION_RE = /индекс[^\n]{0,80}инфляц|инфляц[^\n]{0,80}индекс|прогнозн[а-яё]*\s+инфляц/iu;
const VAT_ROW_RE = /^(?:[\d.\s]*)\s*(?:в\s+том\s+числе\s+)?ндс(?![а-яё])/iu;
const GRAND_TOTAL_RE = /(?:итого|всего)\s+по\s+(?:сводн[а-яё]*\s+сметн[а-яё]*\s+расч[её]т[а-яё]*|ссрсс?)|(?:итого|всего)\s+с\s+ндс|(?:итого|всего)\s+по\s+сср/iu;

/** Число из плоского текста: с группами разрядов или с десятичной частью. */
const FLAT_NUMBER = /-?(?:\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+[.,]\d+|\d+)/gu;

function cut(text: string): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  return clean.length > MAX_QUOTE ? `${clean.slice(0, MAX_QUOTE)}…` : clean;
}

function parseFlat(token: string): number | null {
  const s = token.replace(/[\s  ]/gu, "");
  const comma = s.includes(",");
  const dot = s.includes(".");
  let normalized = s;
  if (comma && dot) normalized = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./gu, "").replace(",", ".") : s.replace(/,/gu, "");
  else if (comma) normalized = s.replace(",", ".");
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

interface RowParts {
  /** Текст метки (без чисел). */
  readonly label: string;
  /** Числа строки после метки, в порядке следования; проценты и годы вырезаны. */
  readonly numbers: readonly number[];
  /** Процент из строки («2 %», «22%»); null — нет. */
  readonly percent: number | null;
  /** Строка целиком для цитаты. */
  readonly raw: string;
}

const PERCENT_RE = /(\d+(?:[.,]\d+)?)\s*%/u;
/** «октябрь 2026 г», «2026 года», «III квартал 2026»: годы не числа строки. */
const YEAR_RE = /(?:\b20\d{2}\s*(?:года|г\.?(?![а-яё])))|(?:квартал[а-яё]*\s+20\d{2})|(?:[а-яё]+\s+20\d{2})/giu;

function rowParts(line: string): RowParts {
  // Лист xlsx выгружается как «;»-CSV: строка с четырьмя и более «;» — таблица, даже если пустых ячеек в ней нет.
  const parsed = (line.match(/;/gu) ?? []).length >= 4 ? parseLine(line, true) : parseLine(line);
  if (parsed.csv) {
    const cells = parsed.cells.map((cell) => cell.trim());
    // Метка — самая длинная текстовая ячейка до первой суммы (в строке есть «Обоснование» и «Наименование»); суммы идут после неё.
    let seenText = false;
    let stop = cells.length;
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i] as string;
      if (/\p{L}/u.test(cell)) seenText = true;
      else if (seenText && parseNumberCell(cell, parsed.delimiter) !== null) {
        stop = i;
        break;
      }
    }
    const textCells = cells.slice(0, stop).filter((cell) => /[\p{L}]{3,}/u.test(cell));
    const label = textCells.reduce((best, cell) => (cell.length > best.length ? cell : best), "");
    const rest = cells.slice(stop);
    const percentCell = [label, ...rest].map((cell) => PERCENT_RE.exec(cell)).find((match) => match !== null) ?? null;
    const numbers: number[] = [];
    for (const cell of rest) {
      const value = parseNumberCell(cell, parsed.delimiter);
      if (value !== null) numbers.push(value);
    }
    return {
      label,
      numbers,
      percent: percentCell === null ? null : parseFlat(percentCell[1] as string),
      raw: cells.filter((cell) => cell !== "").join("; "),
    };
  }

  const text = line.replace(/\s+/gu, " ").trim();
  const percent = PERCENT_RE.exec(text);
  // Метка кончается там, где начинаются числа; всё, что до первой буквы (номер строки), к метке не относится.
  const withoutPercent = text.replace(new RegExp(PERCENT_RE.source, "gu"), " ").replace(YEAR_RE, " ");
  const firstLetter = withoutPercent.search(/\p{L}/u);
  const tail = firstLetter < 0 ? "" : withoutPercent.slice(firstLetter);
  const tokens = [...tail.matchAll(FLAT_NUMBER)];
  // Первое «настоящее» число (с десятичной частью или группами разрядов) отделяет метку от сумм;
  // сумма в целых рублях без разрядов («1625720») — последнее число из четырёх и более цифр.
  const firstMoney =
    tokens.find((token) => /[,.]\d|[  ]\d{3}/u.test(token[0])) ??
    [...tokens].reverse().find((token) => /^\d{4,}$/u.test(token[0]));
  const labelEnd = firstMoney === undefined ? tail.length : (firstMoney.index ?? tail.length);
  const label = tail.slice(0, labelEnd).trim();
  const numbers: number[] = [];
  for (const token of tokens) {
    if ((token.index ?? 0) < labelEnd) continue;
    const value = parseFlat(token[0]);
    if (value !== null) numbers.push(value);
  }
  return { label, numbers, percent: percent === null ? null : parseFlat(percent[1] as string), raw: text };
}

/* ------------------------------ Срок из строки индекса ------------------------------ */

const MONTHS: readonly (readonly [string, number])[] = [
  ["январ", 1], ["феврал", 2], ["март", 3], ["апрел", 4], ["ма", 5], ["июн", 6], ["июл", 7], ["август", 8], ["сентябр", 9], ["октябр", 10], ["ноябр", 11], ["декабр", 12],
];

function monthOf(word: string): number | null {
  const lower = word.toLowerCase().replace(/ё/gu, "е");
  for (const [stem, number] of MONTHS) {
    if (stem === "ма" ? /^ма[йя]/u.test(lower) : lower.startsWith(stem)) return number;
  }
  return null;
}

const iso = (year: number, month: number): string => `${String(year)}-${String(month).padStart(2, "0")}`;

/**
 * Период работ из строки индекса: «(октябрь-ноябрь 2026 г)», «с октября 2026 по ноябрь 2027», «на ноябрь 2026».
 * null — период в строке не назван месяцами.
 */
export function periodFromText(text: string): { text: string; period: CustomerSsrPeriod } | null {
  const flat = text.replace(/\s+/gu, " ");
  const range = /([а-яё]+)\s*(?:20(\d{2}))?\s*(?:[-–—]|по)\s*([а-яё]+)\s*(20\d{2})/iu.exec(flat);
  if (range !== null) {
    const from = monthOf(range[1] as string);
    const to = monthOf(range[3] as string);
    const endYear = Number.parseInt(range[4] as string, 10);
    const startYear = range[2] === undefined ? endYear : 2000 + Number.parseInt(range[2], 10);
    if (from !== null && to !== null) return { text: range[0] as string, period: { start: iso(startYear, from), end: iso(endYear, to) } };
  }
  const single = /([а-яё]+)\s+(20\d{2})/iu.exec(flat);
  if (single !== null) {
    const month = monthOf(single[1] as string);
    if (month !== null) {
      const year = Number.parseInt(single[2] as string, 10);
      return { text: single[0] as string, period: { start: iso(year, month), end: iso(year, month) } };
    }
  }
  return null;
}

function indexOf(text: string, numbers: readonly number[]): { index: number | null; rest: number[] } {
  // «И=1,0045», «К = 1,0045», «1,0045» в строке; сумма — остальные числа.
  const explicit = /(?:^|[^\p{L}\d])[ИИКK]\s*=\s*(\d[.,]\d+)/iu.exec(text);
  if (explicit !== null) {
    const value = parseFlat(explicit[1] as string);
    if (value !== null) {
      const rest = numbers.filter((n) => Math.abs(n - value) > 1e-9);
      return { index: value, rest };
    }
  }
  const candidate = numbers.find((n) => n >= 0.9 && n <= 1.6 && Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6 && n !== 1 && String(n).includes("."));
  if (candidate !== undefined) return { index: candidate, rest: numbers.filter((n) => n !== candidate) };
  return { index: null, rest: [...numbers] };
}

/* ------------------------------ Разбор листа ------------------------------ */

interface Segment {
  readonly name: string | null;
  readonly text: string;
}

function segmentsOf(document: DocumentText): Segment[] {
  const segments: Segment[] = [];
  let name: string | null = null;
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) segments.push({ name, text: current.join("\n") });
    current = [];
  };
  for (const line of document.text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length >= 6 && trimmed.startsWith("===") && trimmed.endsWith("===")) {
      flush();
      name = trimmed.slice(3, -3).trim();
      continue;
    }
    current.push(line);
  }
  flush();
  return segments;
}

function parseSegment(documentName: string, segment: Segment): CustomerSsr | null {
  const lines = segment.text.split("\n");
  const unitMultiplier: 1 | 1000 = /тыс\.?\s*руб/iu.test(segment.text) ? 1000 : 1;
  const money = (value: number): number => Math.round(value * unitMultiplier * 100) / 100;

  const chapters: { number: number; title: string; lines: CustomerSsrLine[]; stated: number | null; quote: string | null }[] = [];
  const groups: CustomerSsrGroup[] = [];
  let reserve: CustomerSsr["reserve"] = null;
  let afterReserve: CustomerSsr["afterReserve"] = null;
  let inflation: CustomerSsr["inflation"] = null;
  let vat: CustomerSsr["vat"] = null;
  let total: CustomerSsr["total"] = null;
  let open: (typeof chapters)[number] | null = null;
  let seenSsrWord = false;

  for (const rawLine of lines) {
    if (rawLine.trim() === "") continue;
    if (SSR_MARKER.test(rawLine)) seenSsrWord = true;
    if (!RELEVANT.test(rawLine)) {
      // Позиции главы без маркеров в строке: «ЛС 02-01-01 Фасад … 1 625,72».
      if (open !== null) addItem(rawLine, open);
      continue;
    }
    const parts = rowParts(rawLine);
    const label = parts.label;
    const quote = cut(parts.raw);

    // «Итого по главам N-M» раньше «Итого по главе N»: у первой есть дефис.
    const group = GROUP_RE.exec(label === "" ? rawLine : label) ?? GROUP_RE.exec(rawLine);
    if (group !== null && parts.numbers.length > 0) {
      const from = Number.parseInt(group[1] as string, 10);
      const to = Number.parseInt(group[2] as string, 10);
      const id = `${String(from)}-${String(to)}`;
      if (from === 1 && (to === 7 || to === 8 || to === 9 || to === 12)) {
        groups.push({ id: id as SsrGroupId, from, to, stated: money(parts.numbers[parts.numbers.length - 1] as number), quote });
      }
      continue;
    }
    const chapterTotal = CHAPTER_TOTAL_RE.exec(rawLine);
    if (chapterTotal !== null && parts.numbers.length > 0) {
      const number = Number.parseInt(chapterTotal[1] as string, 10);
      const found = chapters.find((chapter) => chapter.number === number);
      if (found !== undefined) {
        found.stated = money(parts.numbers[parts.numbers.length - 1] as number);
        found.quote = quote;
      }
      open = null;
      continue;
    }
    const heading = CHAPTER_RE.exec(label === "" ? rawLine.trim() : label.trim()) ?? CHAPTER_RE.exec(rawLine.trim().replace(/^[\d.\s]+/u, ""));
    if (heading !== null && !/итого|всего/iu.test(rawLine)) {
      const number = Number.parseInt(heading[1] as string, 10);
      if (number >= 1 && number <= 12) {
        const title = (heading[2] ?? "").replace(/[,;]{2,}.*$/u, "").replace(/\s+/gu, " ").trim().replace(/[.;:,…\s]+$/u, "");
        const entry = { number, title, lines: [] as CustomerSsrLine[], stated: null as number | null, quote: null as string | null };
        chapters.push(entry);
        open = entry;
        continue;
      }
    }
    if (AFTER_RESERVE_RE.test(rawLine) && parts.numbers.length > 0 && !RESERVE_RE.test(label.replace(AFTER_RESERVE_RE, ""))) {
      afterReserve = { amount: money(parts.numbers[parts.numbers.length - 1] as number), quote };
      open = null;
      continue;
    }
    if (RESERVE_RE.test(rawLine) && !/итого/iu.test(rawLine.replace(/непредвид[а-яё]*/giu, ""))) {
      const amount = parts.numbers.length === 0 ? null : money(parts.numbers[parts.numbers.length - 1] as number);
      if (parts.percent !== null || amount !== null) {
        reserve = { percent: parts.percent, amount, quote };
        open = null;
        continue;
      }
    }
    if (INFLATION_RE.test(rawLine)) {
      const found = periodFromText(rawLine);
      const { index, rest } = indexOf(rawLine, parts.numbers);
      inflation = {
        index,
        amount: rest.length === 0 ? null : money(rest[rest.length - 1] as number),
        periodText: found === null ? null : found.text,
        period: found === null ? null : found.period,
        quote,
      };
      open = null;
      continue;
    }
    if (VAT_ROW_RE.test(rawLine.trim().replace(/^[|;,\s]+/u, "")) && !/итого|всего/iu.test(rawLine)) {
      vat = {
        percent: parts.percent,
        amount: parts.numbers.length === 0 ? null : money(parts.numbers[parts.numbers.length - 1] as number),
        quote,
      };
      open = null;
      continue;
    }
    if (GRAND_TOTAL_RE.test(rawLine) && parts.numbers.length > 0) {
      const amount = money(parts.numbers[parts.numbers.length - 1] as number);
      const withVat = /без\s+(?:учета\s+)?ндс/iu.test(rawLine) ? false : /ндс/iu.test(rawLine) ? true : null;
      // Последняя такая строка — итог всего расчёта (выше могут стоять «итого без НДС»).
      total = { amount, withVat, quote };
      open = null;
      continue;
    }
    if (open !== null) addItem(rawLine, open);
  }

  function addItem(rawLine: string, chapter: (typeof chapters)[number]): void {
    const parts = rowParts(rawLine);
    // «В том числе», «справочно», «из них» — расшифровка строки выше, а не отдельная позиция: в сумму строк не идёт.
    if (parts.numbers.length === 0 || parts.label === "" || /итого|всего|в\s+том\s+числе|справочно|из\s+них/iu.test(parts.label)) return;
    // Заголовок колонок «1 2 3 4 5 6 7 8» букв не содержит и сюда не попадает.
    chapter.lines.push({ name: parts.label.replace(/\s+/gu, " ").trim(), amount: money(parts.numbers[parts.numbers.length - 1] as number), quote: cut(parts.raw) });
  }

  // Лист без глав — не ССР; одно слово «глава» в тексте не делает документ расчётом.
  const withData = chapters.filter((chapter) => chapter.stated !== null || chapter.lines.length > 0);
  if (withData.length === 0 && groups.length === 0) return null;
  if (!seenSsrWord && groups.length === 0 && chapters.length < 2) return null;

  return {
    documentName,
    estimateName: segment.name,
    unitMultiplier,
    chapters: chapters.map((chapter) => ({
      number: chapter.number,
      title: chapter.title,
      lines: chapter.lines,
      linesTotal: Math.round(chapter.lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100,
      stated: chapter.stated,
      quote: chapter.quote,
    })),
    groups,
    reserve,
    afterReserve,
    inflation,
    vat,
    total,
  };
}

/**
 * Сводные сметные расчёты заказчика из текстов документов. Документ или лист считается ССР, если в нём
 * есть главы 421/пр с суммами и итоги по главам (или упомянут «сводный сметный расчёт»). Один расчёт в
 * двух документах (PDF и xlsx) берётся один раз — по совпадению итога и числа глав.
 */
export function parseCustomerSsr(documents: readonly DocumentText[]): CustomerSsr[] {
  const result: CustomerSsr[] = [];
  for (const document of documents) {
    if (document.text === "") continue;
    // Быстрый отсев: документ без слова «глава» и без «сводн… сметн…» ССР не содержит.
    if (!/глав[аеы]\s+\d|итого\s+по\s+глав/iu.test(document.text)) continue;
    if (!SSR_MARKER.test(document.text) && !SSR_MARKER.test(document.name) && !/итого\s+по\s+главам/iu.test(document.text)) continue;
    for (const segment of segmentsOf(document)) {
      const parsed = parseSegment(document.name, segment);
      if (parsed === null) continue;
      const key = (item: CustomerSsr): string => `${String(item.chapters.length)}|${String(item.total?.amount ?? item.groups[item.groups.length - 1]?.stated ?? 0)}`;
      if (result.some((existing) => existing.documentName !== parsed.documentName && key(existing) === key(parsed))) continue;
      result.push(parsed);
    }
  }
  return result;
}

/** Главы подрядчика в расчёте заказчика: суммы по главам 2-9. */
export function chapterAmount(ssr: CustomerSsr, number: number): number | null {
  const chapter = ssr.chapters.find((item) => item.number === number);
  if (chapter === undefined) return null;
  return chapter.stated ?? (chapter.lines.length > 0 ? chapter.linesTotal : null);
}
