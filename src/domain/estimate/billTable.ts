import { serviceCodeFromText } from "@/domain/estimate/autoServices";
import {
  resourceCodeFromJustification,
  type BillRejectionReason,
} from "@/domain/estimate/billExtraction";
import { parseNormCodeHint } from "@/domain/estimate/normCodes";
import type { BillOfWorkItem, VolumeSourceLevel, VolumeVariant } from "@/domain/estimate/types";
import { isMoneyUnit, isWholeWorkUnit, parseUnit, parseUnitPair } from "@/domain/estimate/units";
import { documentHeadings, headingInfoAt, type DocHeading } from "@/domain/estimate/volumeSource";

/**
 * Таблица объёмов работ, прочитанная кодом, без модели.
 *
 * Зачем. Ведомость объёмов (ВОР), дефектная ведомость, таблица в ТЗ — это таблица с колонками
 * «наименование — единица — количество». Модель читала её построчно, а проверка в `billExtraction`
 * требует дословную цитату и число внутри неё: на живых таблицах это отбрасывало почти всё
 * (0134600008526000372: 233 отказа при 24 принятых строках; 0134300025826000377: чистая ВОР из 15 строк
 * дала 6 позиций). Таблицу с понятной шапкой код читает надёжнее и бесплатно: строка документа сама и
 * есть цитата, а объём стоит в колонке, которую назвала шапка.
 *
 * Чему доверяем. Только таблице с уверенной шапкой (колонки наименования, единицы и количества найдены
 * и однозначны) и не меньше чем тремя разобранными строками (`MIN_TRUSTED_ROWS`). Всё остальное — не
 * таблица для кода: возвращаем пусто, и документ читает модель, как раньше.
 *
 * Чего не делаем. Не считаем: колонка «Формула/Расчёт» («225*3») объёмом не является, объём — только
 * из колонки количества. Не угадываем единицу: нераспознанная единица — отказ с причиной, как у модели.
 * Не подбираем расценку: позиция уходит в расчёт без кода нормы, как и строка модели.
 */

/** Меньше стольких разобранных строк таблица не считается ведомостью: две строки — это случайный перечень. */
export const MIN_TRUSTED_ROWS = 3;

/** Минимум доли разобранных строк среди строк с данными: иначе таблица разобрана лишь отчасти и лучше отдать её модели. */
const MIN_PARSED_SHARE = 0.5;

/** Сколько подряд пустых строк обрывает таблицу. */
const BLANK_RUN_END = 3;
/** Сколько подряд строк обычного текста обрывает таблицу. */
const PROSE_RUN_END = 3;
/** Шапка той же раскладки не дальше стольких строк от конца таблицы продолжает её, а не начинает новую. */
const RESUME_DISTANCE_LINES = 40;

type Role = "num" | "name" | "unit" | "qty" | "formula" | "note" | "just" | "other";
type Mode = "tab" | "pipe" | "csv" | "space" | "inline";

/** Раскладка колонок таблицы: индексы ячеек, -1 — колонки нет. */
interface Layout {
  readonly mode: Mode;
  readonly num: number;
  readonly name: number;
  readonly unit: number;
  readonly qty: number;
  readonly formula: number;
  readonly note: number;
  readonly just: number;
  /** Только построчная раскладка (колонки не разделены): после количества стоит ещё текст. */
  readonly tailExtras: boolean;
  /** Текст ячейки наименования шапки — по нему отсеиваются таблицы машин, кадров, СИЗ. */
  readonly nameHeader: string;
  readonly signature: string;
}

export interface BillTableRow {
  readonly name: string;
  /** Объём в основной единице строки (множитель «100 м2» уже учтён). */
  readonly quantity: number;
  readonly unit: string;
  /** Объём во всех единицах парного значения («мп/шт» → оба); у обычной строки нет. */
  readonly variants?: readonly VolumeVariant[];
  /** Заголовок строки-раздела, под которым стоит строка. */
  readonly section: string | null;
  readonly positionNumber: string | null;
  /** Примечание таблицы, вторая величина парной единицы и формула расчёта — всё, что сказано рядом с объёмом. */
  readonly remark: string | null;
  /** Колонка «Обоснование» («ГЭСН09-03-002-01», «ФСБЦ-…»), если она есть. */
  readonly justification: string | null;
  /** Строка документа дословно. */
  readonly quote: string;
  /** Смещение строки в тексте документа. */
  readonly offset: number;
}

export interface SkippedBillRow {
  /** Причина — из тех же, что у строк модели: в отчёте отказы выглядят одинаково. */
  readonly reason: BillRejectionReason;
  readonly name: string;
  readonly quantity: string;
  readonly unit: string;
  readonly quote: string;
  readonly message: string;
  readonly offset: number;
}

export interface BillTable {
  readonly rows: readonly BillTableRow[];
  readonly skipped: readonly SkippedBillRow[];
  /** Шапка таблицы как напечатана (одна или две строки). */
  readonly header: string;
  /** Смещение шапки в тексте. */
  readonly headerOffset: number;
  /** Текст ячейки наименования из шапки. */
  readonly nameHeader: string;
  /** Строк с данными, которые пришлось пропустить и которые не итог и не раздел. */
  readonly dataSkipped: number;
  readonly trusted: boolean;
}

export interface BillTablesResult {
  /** Только доверенные таблицы, в порядке следования. */
  readonly tables: readonly BillTable[];
  /** Сколько таблиц нашлось, но доверия не получило: мало строк или шапка неуверенная. */
  readonly untrusted: number;
}

/* ------------------------------- Числа и текст ------------------------------- */

function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Число из ячейки: «68,7», «1 234,5», «1234.5», «1.234,5», «1,234,567.5».
 *
 * Запятая — десятичная, как и у `parseQuantity` модели: «1,234» — это 1,234, а не 1234. Запятая
 * разделяет тысячи только при нескольких группах («1,234,567») или при точке после неё.
 */
export function parseTableNumber(raw: string): number | null {
  let text = raw.trim().replace(/^[~≈]+/, "").replace(/[*†‡]+$/, "").trim();
  if (text === "") return null;
  if (/\s/.test(text)) {
    if (!/^\d{1,3}(?:[\s  ]\d{3})+(?:[.,]\d+)?$/.test(text)) return null;
    text = text.replace(/[\s  ]+/g, "");
  }
  if (/^\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?$/.test(text) || /^\d{1,3}(?:,\d{3})+\.\d+$/.test(text)) {
    text = text.replace(/,/g, "");
  } else if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(text)) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (/^\d+,\d+$/.test(text)) {
    text = text.replace(",", ".");
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

type QuantityCell =
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "number"; readonly values: readonly number[] };

/** Что стоит в ячейке количества: пусто или прочерк, слова («по проекту»), число или пара чисел. */
function readQuantityCell(raw: string, mode?: Mode): QuantityCell {
  /*
    Текст из xlsx хранится строками через запятую, а число ячейки — в формате Excel с запятой тысяч и точкой дроби:
    «"293,474.98"», «"1,234"» (так в выгрузках ЛСР и ведомостей на проде). Русская дробь «68,7» в CSV приходит из
    текстовой ячейки и с тремя знаками после запятой не встречается в объёмах таблиц, поэтому «1,234» в CSV — тысяча
    двести тридцать четыре, а не 1,234. В тексте docx/odt/pdf запятая по-прежнему дробная.
  */
  const text = mode === "csv" && /^\d{1,3}(?:,\d{3})+$/.test(clean(raw)) ? clean(raw).replace(/,/g, "") : clean(raw);
  if (text === "" || /^[-–—.]+$/.test(text)) return { kind: "none" };
  const withoutNote = text.replace(/\s*\([^)]*\)\s*$/, "");
  if (withoutNote.includes("/")) {
    const parts = withoutNote.split("/").map((part) => parseTableNumber(part));
    if (parts.length >= 2 && parts.every((part) => part !== null)) {
      return { kind: "number", values: parts as number[] };
    }
    return { kind: "text", text };
  }
  const single = parseTableNumber(withoutNote);
  if (single !== null) return { kind: "number", values: [single] };
  return { kind: "text", text };
}

/* ------------------------------- Строки и ячейки ------------------------------- */

interface Line {
  readonly text: string;
  readonly offset: number;
}

/** Нечётное число кавычек в строке: ячейка csv с переносом продолжается на следующей. */
function hasOpenQuote(text: string): boolean {
  let count = 0;
  for (const char of text) if (char === '"') count += 1;
  return count % 2 === 1;
}

const MAX_RECORD_LINES = 8;

/**
 * Строки документа. Запись csv с переносом внутри ячейки («Демонтаж\nпокрытия» в кавычках) собирается в
 * одну строку: лист xlsx выгружается как csv, а ячейки с переносом строки в сметах обычны.
 */
function splitLines(text: string): Line[] {
  const raw: Line[] = [];
  let position = 0;
  while (position <= text.length) {
    const newline = text.indexOf("\n", position);
    const end = newline < 0 ? text.length : newline;
    raw.push({ text: text.slice(position, end).replace(/\r$/, ""), offset: position });
    if (newline < 0) break;
    position = newline + 1;
  }

  const lines: Line[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index] as Line;
    const joinable = !line.text.includes("\t") && (line.text.match(/,/g)?.length ?? 0) >= 1;
    if (joinable && hasOpenQuote(line.text)) {
      let joined = line.text;
      let last = index;
      while (hasOpenQuote(joined) && last + 1 < raw.length && last - index < MAX_RECORD_LINES) {
        last += 1;
        joined += `\n${(raw[last] as Line).text}`;
      }
      if (!hasOpenQuote(joined)) {
        lines.push({ text: joined, offset: line.offset });
        index = last;
        continue;
      }
    }
    lines.push(line);
  }
  return lines;
}

function modeOf(text: string): Exclude<Mode, "inline"> {
  if (text.includes("\t")) return "tab";
  if ((text.match(/\|/g)?.length ?? 0) >= 2) return "pipe";
  if ((text.match(/,/g)?.length ?? 0) >= 3) return "csv";
  return "space";
}

function splitCsv(text: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

function splitCells(text: string, mode: Mode): string[] {
  switch (mode) {
    case "tab":
      return text.split("\t").map(clean);
    case "pipe": {
      const trimmed = text.trim();
      const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
      const cells = (body.endsWith("|") ? body.slice(0, -1) : body).split("|").map(clean);
      return cells;
    }
    case "csv":
      return splitCsv(text).map(clean);
    case "space":
    case "inline":
      return text.trim().split(/\s{2,}/).map(clean);
  }
}

function isBlank(text: string): boolean {
  return text.replace(/[\s,;|\t]+/g, "") === "";
}

/* ------------------------------- Шапка ------------------------------- */

const NUM_HEADER =
  /^(?:(?:№|n)\s*)?(?:п\s*\/\s*п|п\.\s*п|пп)\.?$|^(?:№|n|no\.?|номер|поз\.?|позиция|пункт|№\s*поз\.?|№\s*п\.?)$/;
const UNIT_HEADER = /^(?:ед\.?\s*изм|единиц|ед\.?$|изм\.?$)/;
const FORMULA_HEADER = /формул|подсч[её]т|расч[её]т/;
const NAME_HEADER =
  /^(?:наименован|название|вид[ыа]?\s+работ|перечень|состав\s+работ|содержание\s+работ|описание\s+работ|работы?$)/;
const QTY_HEADER = /кол[\s.\-]*во|колич|^объ[её]м|объ[её]м\s+работ|объ[её]м$|^кол\./;
const NOTE_HEADER = /примечан|^прим\.|комментар|замечан/;
const JUST_HEADER = /обоснован|шифр|код\s+расценк|^основание/;
const OTHER_HEADER = /цена|стоимост|сумм|коэффициент/;
/** Слова колонки «всего»: при двух колонках количества («на единицу» и «всего») объёмом работы служит вторая. */
const TOTAL_HEADER = /всего|общ(?:ее|ий|ая)|итого/;

/** Таблица, которая не перечень работ: машины, кадры, средства защиты, инструмент, график. */
const NON_WORK_NAME_HEADER =
  /машин|механизм|инструмент|приспособлен|кадр|персонал|должност|профессия|специальност|сиз\b|средств\p{L}*\s+защит|график|оборудован/u;

function roleOfHeaderCell(raw: string): Role | null {
  const text = fold(raw).replace(/[*:]+$/, "").trim();
  if (text === "" || text.length > 70) return null;
  if (NUM_HEADER.test(text)) return "num";
  if (UNIT_HEADER.test(text)) return "unit";
  // «Примечание/Формула» — одна колонка: это примечание, формула лежит внутри него.
  if (FORMULA_HEADER.test(text) && !NOTE_HEADER.test(text)) return "formula";
  if (NAME_HEADER.test(text)) return "name";
  if (QTY_HEADER.test(text)) return "qty";
  if (NOTE_HEADER.test(text)) return "note";
  if (JUST_HEADER.test(text)) return "just";
  if (OTHER_HEADER.test(text)) return "other";
  return null;
}

function layoutOfCells(cells: readonly string[], mode: Mode): Layout | null {
  if (cells.length < 3) return null;
  const roles = cells.map(roleOfHeaderCell);
  const first = (role: Role): number => roles.indexOf(role);
  const name = first("name");
  const unit = first("unit");
  if (name < 0 || unit < 0) return null;

  const qtyColumns = roles.flatMap((role, index) => (role === "qty" ? [index] : []));
  if (qtyColumns.length === 0) return null;
  let qty: number;
  if (qtyColumns.length === 1) qty = qtyColumns[0] as number;
  else {
    // Две колонки количества: берём ту, что названа «всего»; иначе шапка неоднозначна и таблица кодом не читается.
    const totals = qtyColumns.filter((index) => TOTAL_HEADER.test(fold(cells[index] as string)));
    if (totals.length !== 1) return null;
    qty = totals[0] as number;
  }
  if (new Set([name, unit, qty]).size !== 3) return null;

  const optional = (role: Role): number => {
    const index = first(role);
    return index === name || index === unit || index === qty ? -1 : index;
  };
  const layout = {
    mode,
    num: optional("num"),
    name,
    unit,
    qty,
    formula: optional("formula"),
    note: optional("note"),
    just: optional("just"),
    tailExtras: false,
    nameHeader: clean(cells[name] as string),
  };
  return {
    ...layout,
    signature: `${mode}:${[layout.num, name, unit, qty, layout.formula, layout.note, layout.just].join(",")}`,
  };
}

/**
 * Шапка без разделителей колонок (текст PDF с одиночными пробелами): порядок колонок берётся из порядка
 * слов. Читается только раскладка «наименование — единица — количество», остальное — хвост строки.
 */
function layoutOfInline(text: string): Layout | null {
  const folded = fold(text);
  if (folded.length > 220) return null;
  const nameAt = folded.search(/наименован|вид[ыа]?\s+работ|перечень\s+работ/);
  const unitAt = folded.search(/ед\.?\s*изм|единица\s+изм|(?:^|\s)ед\.?(?=\s)/);
  const qtyAt = folded.search(/кол[\s.\-]*во|количеств|объ[её]м/);
  if (nameAt < 0 || unitAt < 0 || qtyAt < 0) return null;
  if (!(nameAt < unitAt && unitAt < qtyAt)) return null;
  const formulaAt = folded.search(FORMULA_HEADER);
  if (formulaAt >= 0 && formulaAt < qtyAt) return null;
  const tailExtras = /примечан|формул|расч[её]т|обоснован/.test(folded.slice(qtyAt + 4));
  const layout = { mode: "inline" as const, num: 0, name: 1, unit: 2, qty: 3, formula: -1, note: -1, just: -1 };
  return {
    ...layout,
    tailExtras,
    nameHeader: "наименование",
    signature: `inline:${tailExtras ? "tail" : "end"}`,
  };
}

interface HeaderMatch {
  readonly layout: Layout;
  readonly lines: number;
  readonly text: string;
}

function mergeCells(a: string, b: string, mode: Mode): string {
  if (mode === "tab" || mode === "pipe" || mode === "csv" || (mode === "space" && modeOf(b) === "space")) {
    const left = splitCells(a, mode);
    const right = splitCells(b, mode);
    const size = Math.max(left.length, right.length);
    const merged: string[] = [];
    for (let index = 0; index < size; index += 1) {
      merged.push(clean(`${left[index] ?? ""} ${right[index] ?? ""}`));
    }
    return merged.join(mode === "tab" ? "\t" : mode === "pipe" ? " | " : mode === "csv" ? "," : "  ");
  }
  return `${a} ${b}`;
}

function detectLayout(text: string): Layout | null {
  if (text.trim().length > 600) return null;
  const mode = modeOf(text);
  const byCells = layoutOfCells(splitCells(text, mode), mode);
  if (byCells !== null) return byCells;
  return mode === "space" ? layoutOfInline(text) : null;
}

/** Хотя бы две из трёх обязательных колонок названы в строке: шапка, возможно, продолжается на следующей. */
function looksLikeHeaderStart(text: string): boolean {
  if (text.trim().length > 600) return false;
  const mode = modeOf(text);
  const roles = new Set(splitCells(text, mode).map(roleOfHeaderCell));
  let found = 0;
  for (const role of ["name", "unit", "qty"] as const) if (roles.has(role)) found += 1;
  if (found >= 2) return true;
  const folded = fold(text);
  found = 0;
  if (/наименован|вид[ыа]?\s+работ/.test(folded)) found += 1;
  if (/ед\.?\s*изм|единица/.test(folded)) found += 1;
  if (/кол[\s.\-]*во|количеств|объ[её]м/.test(folded)) found += 1;
  return found >= 2;
}

function headerAt(lines: readonly Line[], index: number): HeaderMatch | null {
  const line = lines[index] as Line;
  if (isBlank(line.text)) return null;
  const single = detectLayout(line.text);
  if (single !== null) return { layout: single, lines: 1, text: line.text };

  const next = lines[index + 1];
  if (next === undefined || isBlank(next.text) || !looksLikeHeaderStart(line.text)) return null;
  const merged = mergeCells(line.text, next.text, modeOf(line.text));
  const layout = detectLayout(merged);
  return layout === null ? null : { layout, lines: 2, text: `${line.text}\n${next.text}` };
}

/* ------------------------------- Строки таблицы ------------------------------- */

const SHEET_MARK = /^=== .+ ===[ \t]*$/;
const SIGNATURE = /^(?:заказчик|подр[яа]дчик|исполнитель|от\s+заказчика|от\s+подр[яа]дчика|согласовано|утверждаю|составил|проверил)(?![\p{L}])/iu;
const GRAND_TOTAL = /^(?:итого|всего)(?![\p{L}])/iu;
const PART_TOTAL = /^(?:итого|всего)\s+(?:по|за)\s+/iu;
const POSITION = /^\d{1,3}(?:\.\d{1,3}){0,3}[.)]?$/;
const WASTE_NAME = /мусор|отход|вывоз|утилизац|полигон|захоронен|(?<![\p{L}])т[бк]о(?![\p{L}])/iu;

const SECTION_MAX_CHARS = 150;

/** Строка раздела, а не абзац текста: коротко и без повествовательных признаков. */
function looksLikeSection(text: string): boolean {
  const title = clean(text);
  if (title.length < 3 || title.length > SECTION_MAX_CHARS) return false;
  if (!/\p{L}/u.test(title)) return false;
  if (/^\(.{0,20}\)$/.test(title)) return false;
  const words = title.split(" ").length;
  if (words > 12) return false;
  return !(/[.;:]$/.test(title) && words > 6);
}

function isNumberingRow(cells: readonly string[]): boolean {
  const filled = cells.filter((cell) => cell !== "");
  return filled.length >= 3 && filled.every((cell) => /^\d{1,2}$/.test(cell));
}

interface Volume {
  readonly quantity: number;
  readonly unit: string;
  readonly variants?: VolumeVariant[];
  readonly extra: string | null;
}

type VolumeResult =
  | { readonly ok: true; readonly volume: Volume }
  | { readonly ok: false; readonly reason: BillRejectionReason; readonly message: string };

/**
 * Единица и объём строки. Парное значение («мп/шт» + «68,7/46», «м3/т» + «11,3/1,13») — одна работа в
 * двух единицах: объёмом берётся первая, вторая остаётся рядом; у строк про мусор и отходы — тонны, потому
 * что перевозка и размещение считаются по массе.
 */
function resolveVolume(name: string, unitRaw: string, quantity: QuantityCell & { kind: "number" }): VolumeResult {
  const unit = clean(unitRaw);
  const pairUnits = parseUnitPair(unit);

  if (pairUnits !== null) {
    if (quantity.values.length !== pairUnits.length) {
      return {
        ok: false,
        reason: "BAD_QUANTITY",
        message: `«${name}»: единица «${unit}» парная, а объём «${quantity.values.join("/")}» не из ${String(pairUnits.length)} чисел`,
      };
    }
    const variants: VolumeVariant[] = pairUnits.map((parsed, index) => ({
      quantity: (quantity.values[index] as number) * parsed.multiplier,
      unit: parsed.unit,
    }));
    if (variants.some((variant) => !(variant.quantity > 0))) {
      return { ok: false, reason: "BAD_QUANTITY", message: `«${name}»: объём «${quantity.values.join("/")}» не положительное число` };
    }
    let primary = 0;
    if (WASTE_NAME.test(name)) {
      const tonnes = variants.findIndex((variant) => variant.unit === "т");
      if (tonnes > 0) primary = tonnes;
    }
    const ordered = [variants[primary] as VolumeVariant, ...variants.filter((_, index) => index !== primary)];
    const rest = ordered.slice(1).map((variant) => `${formatNumber(variant.quantity)} ${variant.unit}`);
    return {
      ok: true,
      volume: {
        quantity: (ordered[0] as VolumeVariant).quantity,
        unit: (ordered[0] as VolumeVariant).unit,
        variants: ordered,
        extra: rest.length === 0 ? null : `в той же строке: ${rest.join("; ")}`,
      },
    };
  }

  if (quantity.values.length !== 1) {
    return {
      ok: false,
      reason: "UNKNOWN_UNIT",
      message: `«${name}»: объём «${quantity.values.join("/")}» парный, а единица «${unit}» не парная`,
    };
  }
  const value = quantity.values[0] as number;
  if (!(value > 0)) {
    return { ok: false, reason: "BAD_QUANTITY", message: `«${name}»: объём «${String(value)}» не положительное число` };
  }
  if (isMoneyUnit(unit)) {
    return { ok: false, reason: "MONEY_NOT_WORK", message: `«${name}»: «${unit}» — это сумма, а не объём работ` };
  }
  if (isWholeWorkUnit(unit) && value === 1) {
    return {
      ok: false,
      reason: "WHOLE_WORK",
      message: `«${name}»: объём задан всей работой (1 усл. ед.) — нужна разбивка по позициям`,
    };
  }
  const parsed = parseUnit(unit);
  if (parsed === null) {
    return { ok: false, reason: "UNKNOWN_UNIT", message: `«${name}»: единица «${unit}» не распознана` };
  }
  return { ok: true, volume: { quantity: value * parsed.multiplier, unit: parsed.unit, extra: null } };
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1e6) / 1e6).replace(".", ",");
}

/** Ячейки одной строки по раскладке; null — строку нельзя разложить по колонкам (построчная раскладка без совпадения). */
interface RawRow {
  readonly num: string;
  readonly name: string;
  readonly unit: string;
  readonly qty: string;
  readonly formula: string;
  readonly note: string;
  readonly just: string;
  /** Первая непустая ячейка: название раздела, когда строка — раздел. */
  readonly firstText: string;
  readonly filled: number;
}

function cellOf(cells: readonly string[], index: number): string {
  return index < 0 ? "" : (cells[index] ?? "");
}

function rawRowByCells(text: string, layout: Layout): RawRow {
  const cells = splitCells(text, layout.mode);
  const filled = cells.filter((cell) => cell !== "");
  return {
    num: cellOf(cells, layout.num),
    name: cellOf(cells, layout.name),
    unit: cellOf(cells, layout.unit),
    qty: cellOf(cells, layout.qty),
    formula: cellOf(cells, layout.formula),
    note: cellOf(cells, layout.note),
    just: cellOf(cells, layout.just),
    firstText: filled[0] ?? "",
    filled: filled.length,
  };
}

/** Единица и число рядом в конце текста: «… мп 118,6». Возвращает токены до них и сами значения. */
function rawRowInline(text: string, layout: Layout): RawRow {
  const line = clean(text);
  const tokens = line.split(" ");
  const empty: RawRow = { num: "", name: line, unit: "", qty: "", formula: "", note: "", just: "", firstText: line, filled: 1 };

  let start = 0;
  let num = "";
  if (tokens.length >= 4 && POSITION.test(tokens[0] as string)) {
    num = tokens[0] as string;
    start = 1;
  }

  const isQuantity = (token: string): boolean =>
    readQuantityCell(token).kind === "number";
  const unitAt = (from: number, size: number): boolean => {
    const unit = tokens.slice(from, from + size).join(" ");
    return parseUnit(unit) !== null || parseUnitPair(unit) !== null;
  };

  const found: { unitFrom: number; size: number } | null = ((): { unitFrom: number; size: number } | null => {
    if (!layout.tailExtras) {
      const last = tokens.length - 1;
      if (last - start < 2 || !isQuantity(tokens[last] as string)) return null;
      for (let size = 3; size >= 1; size -= 1) {
        const from = last - size;
        if (from > start && unitAt(from, size)) return { unitFrom: from, size };
      }
      return null;
    }
    for (let from = start + 1; from < tokens.length - 1; from += 1) {
      for (let size = Math.min(3, tokens.length - 1 - from); size >= 1; size -= 1) {
        if (unitAt(from, size) && isQuantity(tokens[from + size] as string)) return { unitFrom: from, size };
      }
    }
    return null;
  })();

  if (found === null) return { ...empty, num };
  return {
    num,
    name: tokens.slice(start, found.unitFrom).join(" "),
    unit: tokens.slice(found.unitFrom, found.unitFrom + found.size).join(" "),
    qty: tokens[found.unitFrom + found.size] as string,
    formula: "",
    note: tokens.slice(found.unitFrom + found.size + 1).join(" "),
    just: "",
    firstText: line,
    filled: 4,
  };
}

/* ------------------------------- Разбор документа ------------------------------- */

interface Builder {
  layout: Layout;
  header: string;
  headerOffset: number;
  rows: BillTableRow[];
  skipped: SkippedBillRow[];
  dataSkipped: number;
  section: string | null;
  /** Номер строки (индекс в `lines`), на которой таблица кончилась; null — таблица открыта. */
  closedAt: number | null;
}

function finish(builder: Builder): BillTable {
  const dataRows = builder.rows.length + builder.dataSkipped;
  const trusted =
    builder.rows.length >= MIN_TRUSTED_ROWS &&
    builder.rows.length / dataRows >= MIN_PARSED_SHARE &&
    !NON_WORK_NAME_HEADER.test(fold(builder.layout.nameHeader));
  return {
    rows: builder.rows,
    skipped: builder.skipped,
    header: builder.header,
    headerOffset: builder.headerOffset,
    nameHeader: builder.layout.nameHeader,
    dataSkipped: builder.dataSkipped,
    trusted,
  };
}

/**
 * Находит в тексте документа таблицы объёмов и читает их строки.
 *
 * Возвращает только таблицы, которым можно доверять: уверенная шапка и не меньше `MIN_TRUSTED_ROWS`
 * разобранных строк с наименованием, единицей и количеством. Нет таких — таблиц пусто, и документ идёт
 * в модель, как раньше.
 */
export function parseBillTables(text: string): BillTablesResult {
  const lines = splitLines(text);
  const builders: Builder[] = [];
  let current: Builder | null = null;
  let lastClosed: Builder | null = null;
  let blankRun = 0;
  let proseRun = 0;

  const close = (at: number): void => {
    if (current === null) return;
    current.closedAt = at;
    lastClosed = current;
    current = null;
    blankRun = 0;
    proseRun = 0;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as Line;

    if (SHEET_MARK.test(line.text.trim())) {
      close(index);
      lastClosed = null;
      index += 1;
      continue;
    }

    const header = headerAt(lines, index);
    if (header !== null) {
      if (current !== null && (current as Builder).layout.signature === header.layout.signature) {
        // Шапка, повторённая на новой странице: таблица продолжается.
        blankRun = 0;
        proseRun = 0;
        index += header.lines;
        continue;
      }
      close(index);
      const resume = lastClosed as Builder | null;
      if (
        resume !== null &&
        resume.layout.signature === header.layout.signature &&
        resume.closedAt !== null &&
        index - resume.closedAt <= RESUME_DISTANCE_LINES
      ) {
        resume.closedAt = null;
        current = resume;
      } else {
        current = {
          layout: header.layout,
          header: header.text,
          headerOffset: line.offset,
          rows: [],
          skipped: [],
          dataSkipped: 0,
          section: null,
          closedAt: null,
        };
        builders.push(current);
      }
      index += header.lines;
      continue;
    }

    if (current === null) {
      index += 1;
      continue;
    }
    const table: Builder = current;

    if (isBlank(line.text)) {
      blankRun += 1;
      index += 1;
      if (blankRun >= BLANK_RUN_END) close(index);
      continue;
    }
    blankRun = 0;

    const raw =
      table.layout.mode === "inline" ? rawRowInline(line.text, table.layout) : rawRowByCells(line.text, table.layout);

    // Подписи сторон и итог по всей таблице — конец.
    const lead = raw.firstText;
    if (SIGNATURE.test(lead)) {
      close(index);
      index += 1;
      continue;
    }
    if (GRAND_TOTAL.test(lead) && !PART_TOTAL.test(lead)) {
      close(index);
      index += 1;
      continue;
    }
    if (PART_TOTAL.test(lead)) {
      index += 1;
      continue;
    }

    const cells = table.layout.mode === "inline" ? [] : splitCells(line.text, table.layout.mode);
    if (isNumberingRow(cells)) {
      index += 1;
      continue;
    }

    const name = clean(raw.name);
    const hasUnit = clean(raw.unit) !== "";
    const quantity = readQuantityCell(raw.qty, table.layout.mode);
    const hasQuantity = quantity.kind !== "none";

    // Ни единицы, ни количества: раздел таблицы или абзац текста.
    if (!hasUnit && !hasQuantity) {
      const title = clean(name !== "" ? name : raw.firstText);
      if (title !== "" && looksLikeSection(title) && raw.filled <= 3) {
        table.section = title;
        proseRun = 0;
      } else if (title !== "") {
        proseRun += 1;
        if (proseRun >= PROSE_RUN_END) close(index);
      }
      index += 1;
      continue;
    }
    proseRun = 0;

    const skip = (reason: BillRejectionReason, message: string): void => {
      table.skipped.push({
        reason,
        name,
        quantity: clean(raw.qty),
        unit: clean(raw.unit),
        quote: line.text.trim(),
        message,
        offset: line.offset,
      });
      table.dataSkipped += 1;
    };

    if (name === "") {
      skip("EMPTY_NAME", "Строка таблицы без наименования работы");
    } else if (!hasUnit) {
      skip("UNKNOWN_UNIT", `«${name}»: в строке таблицы нет единицы измерения`);
    } else if (quantity.kind === "none") {
      skip("BAD_QUANTITY", `«${name}»: в строке таблицы нет объёма`);
    } else if (quantity.kind === "text") {
      skip("BAD_QUANTITY", `«${name}»: объём «${quantity.text}» не число — такая строка в расчёт не берётся`);
    } else {
      const resolved = resolveVolume(name, raw.unit, quantity);
      if (!resolved.ok) skip(resolved.reason, resolved.message);
      else {
        const remarkParts = [
          resolved.volume.extra,
          clean(raw.note) === "" ? null : clean(raw.note),
          clean(raw.formula) === "" ? null : `расчёт: ${clean(raw.formula)}`,
        ].filter((part): part is string => part !== null);
        const position = clean(raw.num);
        table.rows.push({
          name,
          quantity: resolved.volume.quantity,
          unit: resolved.volume.unit,
          ...(resolved.volume.variants === undefined ? {} : { variants: resolved.volume.variants }),
          section: table.section,
          positionNumber: POSITION.test(position) ? position.replace(/[.)]$/, "") : null,
          remark: remarkParts.length === 0 ? null : remarkParts.join("; "),
          justification: clean(raw.just) === "" ? null : clean(raw.just),
          quote: line.text.trim(),
          offset: line.offset,
        });
      }
    }
    index += 1;
  }
  close(index);

  const tables = builders.map(finish);
  return {
    tables: tables.filter((table) => table.trusted),
    untrusted: tables.filter((table) => !table.trusted).length,
  };
}

/* ------------------------------- Позиции ведомости ------------------------------- */

export interface BillTableReading {
  /** Позиции доверенных таблиц документа. */
  readonly items: BillOfWorkItem[];
  /** Пропущенные строки этих таблиц — с причиной. */
  readonly skipped: SkippedBillRow[];
  /** Сколько таблиц прочитано. */
  readonly tables: number;
}

/**
 * Читает таблицы документа в позиции ведомости. null — доверенной таблицы нет (или таблицы — смета,
 * которую читают другие пути): документ остаётся модели.
 *
 * Уровень позиции задан так же, как у строк модели: заголовок «Ведомость объёмов работ» перед таблицей
 * или ведомость в имени и шапке документа — BILL; таблица в ТЗ — SPEC. Таблицы-не-работы («Ведомость
 * потребности машин») и таблицы смет (ЛСР, смета контракта) кодом не читаются.
 */
export function readBillTables(input: {
  readonly documentName: string;
  readonly text: string;
  readonly documentLevel: VolumeSourceLevel;
  /** Префикс идентификаторов позиций: номер документа. */
  readonly idPrefix: string;
  /** Заголовки документа, если они уже найдены. */
  readonly headings?: readonly DocHeading[];
}): BillTableReading | null {
  const parsed = parseBillTables(input.text);
  if (parsed.tables.length === 0) return null;

  const headings = input.headings ?? documentHeadings(input.text);
  const items: BillOfWorkItem[] = [];
  const skipped: SkippedBillRow[] = [];
  let tables = 0;

  for (const [tableIndex, table] of parsed.tables.entries()) {
    const info = headingInfoAt(headings, table.headerOffset);
    if (info.nonWork !== null) continue;
    const level = info.level ?? input.documentLevel;
    if (level === "CUSTOMER_ESTIMATE" || level === "CONTRACT_ESTIMATE") continue;
    tables += 1;
    skipped.push(...table.skipped);

    for (const row of table.rows) {
      const justification = row.justification ?? undefined;
      const serviceCode = serviceCodeFromText(justification, null);
      items.push({
        id: `${input.idPrefix}t${String(tableIndex + 1)}-${String(items.length + 1)}`,
        workName: row.name,
        quantity: row.quantity,
        quantityUnit: row.unit,
        unitDivisor: 1,
        normCode: null,
        normBaseType: null,
        resourceCode: resourceCodeFromJustification(justification),
        sourceQuote: row.quote,
        sourceDocument: input.documentName,
        billSection: row.section,
        sourceLevel: level,
        positionNumber: row.positionNumber,
        normCodeHint: parseNormCodeHint(justification),
        ...(serviceCode === null ? {} : { serviceCode }),
        ...(row.variants === undefined ? {} : { volumeVariants: [...row.variants] }),
        ...(row.remark === null ? {} : { remark: row.remark }),
      });
    }
  }

  return items.length === 0 ? null : { items, skipped, tables };
}

/** Ключ строки для сравнения копий одной ведомости в разных файлах (pdf и xlsx): наименование, единица, объём. */
export function billItemKey(item: Pick<BillOfWorkItem, "workName" | "quantityUnit" | "quantity">): string {
  const name = fold(item.workName).replace(/[^\p{L}\p{N}]+/gu, "");
  return `${name}|${item.quantityUnit}|${String(Math.round(item.quantity * 1e6) / 1e6)}`;
}
