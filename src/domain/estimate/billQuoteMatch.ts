import { foldLookalikes, parseUnit, type ParsedUnit } from "@/domain/estimate/units";

/**
 * Сопоставление цитат модели с текстом документа и проверка объёма по строке.
 *
 * Зачем отдельный модуль. Проверка строк ведомости («цитата есть в документе,
 * объём виден в цитате») на живых документах отбрасывала почти все настоящие
 * строки: на закупке 0134600008526000372 выбыло 233 из 257. Причины были не в
 * выдумках модели, а в том, что сравнение было слишком буквальным:
 *
 *  — цитата и текст расходились в пробелах, тире, кавычках, запятых CSV и записи
 *    числа («1 234,5» против «1234.5»);
 *  — модель переводила единицу («2,2 кг» → 0,0022 т), а в цитате стоит 2,2;
 *  — в таблице ячейка с объёмом — это «2» или «12,5», и короче восьми знаков
 *    такой фрагмент быть не может, хотя строка таблицы очевидна;
 *  — вместо единицы модель возвращала подпись колонки «ед. изм.».
 *
 * Защита от выдуманных объёмов остаётся: число по-прежнему должно стоять в
 * документе, в той же строке, что и наименование. Ослаблено только то, что
 * отличает запись одного и того же числа, и то, что даёт точная арифметика
 * единиц и самой строки.
 */

/* ───────────── Нормализация текста для сравнения ───────────── */

const INVISIBLE = /[­​-‍⁠﻿]/;

/** Кавычки всех видов: «Болты "М12"», «Болты М12» и «Болты М12» после удаления — одно и то же. */
const QUOTE_MARKS: ReadonlySet<string> = new Set([
  "«", "»", "“", "”", "„", "‟", '"', "‘", "’", "‚", "‛", "'", "`", "ʼ", "′", "″",
]);

/** Тире всех видов сводятся к дефису. */
const DASH_MARKS: ReadonlySet<string> = new Set(["‐", "‑", "‒", "–", "—", "―", "−", "﹘", "﹣", "－", "-"]);

/**
 * Число в свёрнутом тексте: целое с пробелами в разрядах или без, дробная часть
 * через точку или запятую. Перед числом не стоит буква («М12», «м3» — не числа),
 * цифра или разделитель: «12.05.2024» разбирается как «12.05» и остаётся датой.
 */
const FOLDED_NUMBER = /(?<![\p{L}\d.,])(?:\d{1,3}(?: \d{3})+|\d+)(?:[.,]\d+)?(?!\d)/gu;

export interface FoldedText {
  readonly folded: string;
  /** Для каждого знака свёрнутого текста — смещение в исходнике. */
  readonly map: number[];
}

/** Запятая между двумя цифрами — десятичная; любая другая — разделитель ячеек CSV. */
function isCellComma(text: string, index: number): boolean {
  if (text[index] !== ",") return false;
  const before = text[index - 1];
  const after = text[index + 1];
  return !(before !== undefined && /\d/.test(before) && after !== undefined && /\d/.test(after));
}

/** «1 234,50» → «1234.5»: канонический вид числа, одинаковый для любой записи. */
export function canonicalNumber(raw: string): string {
  const compact = raw.replace(/[\s  ]/g, "");
  const separator = compact.search(/[.,]/);
  if (separator < 0) return compact;
  const whole = compact.slice(0, separator);
  const fraction = compact.slice(separator + 1).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * Текст в том виде, в каком его сравнивает поиск цитаты, и для каждого знака — его
 * смещение в исходнике. Нужен, чтобы найденную цитату вернуть на её место в
 * настоящем тексте: после схлопывания пробелов смещения расходятся.
 *
 * Что сворачивается: пробелы любого вида (в том числе неразрывные, табуляция и
 * переводы строк), регистр, «ё», латинские двойники кириллицы и «з» на месте
 * тройки в «мз»; тире всех видов (и пробелы вокруг тире); кавычки удаляются;
 * «|», «;» и запятые-разделители CSV (серии запятых — тоже) становятся пробелом;
 * числа приводятся к каноническому виду.
 */
export function foldWithMap(text: string, wantMap = true): FoldedText {
  const out: string[] = [];
  const map: number[] = [];
  let previousSpace = true;

  const push = (char: string, index: number): void => {
    out.push(char);
    if (wantMap) map.push(index);
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (INVISIBLE.test(char) || QUOTE_MARKS.has(char)) continue;

    if (/\s/.test(char) || char === "|" || char === ";" || isCellComma(text, index)) {
      if (!previousSpace) {
        push(" ", index);
        previousSpace = true;
      }
      continue;
    }

    if (DASH_MARKS.has(char)) {
      if (out[out.length - 1] === " ") {
        out.pop();
        if (wantMap) map.pop();
      }
      push("-", index);
      previousSpace = true;
      continue;
    }

    const lower = char === "ё" || char === "Ё" ? "е" : char.toLowerCase();
    let emitted = lower.length === 1 ? foldLookalikes(lower) : char;
    if (emitted === "з" && isOcrThree(out, text, index)) emitted = "3";
    push(emitted, index);
    previousSpace = false;
  }
  if (out[out.length - 1] === " ") {
    out.pop();
    if (wantMap) map.pop();
  }

  const joined = out.join("");
  const folded: string[] = [];
  const foldedMap: number[] = [];
  let last = 0;
  for (const match of joined.matchAll(FOLDED_NUMBER)) {
    const at = match.index ?? 0;
    const raw = match[0];
    const canonical = canonicalNumber(raw);
    folded.push(joined.slice(last, at));
    if (wantMap) for (let k = last; k < at; k += 1) foldedMap.push(map[k] as number);
    folded.push(canonical);
    if (wantMap) {
      for (let k = 0; k < canonical.length; k += 1) {
        foldedMap.push(map[at + Math.min(k, raw.length - 1)] as number);
      }
    }
    last = at + raw.length;
  }
  folded.push(joined.slice(last));
  if (wantMap) for (let k = last; k < joined.length; k += 1) foldedMap.push(map[k] as number);

  return { folded: folded.join(""), map: foldedMap };
}

/** «з» — это тройка, если она вторая буква слова «мз»: слева «м» без буквы перед ней, справа не буква. */
function isOcrThree(folded: readonly string[], text: string, index: number): boolean {
  if (folded[folded.length - 1] !== "м") return false;
  const before = folded[folded.length - 2];
  if (before !== undefined && /\p{L}/u.test(before)) return false;
  const after = text[index + 1];
  return after === undefined || !/\p{L}/u.test(after);
}

/** Свёртка для поиска цитаты в тексте: см. `foldWithMap`. */
export function forFind(text: string): string {
  return foldWithMap(text, false).folded;
}

/* ───────────── Числа ───────────── */

/**
 * Число в сыром тексте. Разряды отделены пробелом; «м2»/«м3» — единицы, цифра в
 * них числом не считается (иначе «м3 347,7» читалось бы как «3 347,7»).
 */
const RAW_NUMBER = /(?<![\d.,])(?:\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,]\d+)?(?!\d)/gu;

export interface NumberToken {
  /** Прочтения числа: первое — «склеенное» («3 120» → 3120), остальные — его части («3» и «120»). */
  readonly values: readonly number[];
  readonly start: number;
  readonly end: number;
}

function parseNumberText(raw: string): number {
  return Number.parseFloat(raw.replace(/[\s  ]/g, "").replace(",", "."));
}

/** Цифра единицы «м2», «м3»: перед ней «м» без буквы слева, после — не цифра. */
function isUnitDigitAt(text: string, index: number): boolean {
  const digit = text[index];
  if (digit !== "2" && digit !== "3") return false;
  const unitLetter = text[index - 1];
  if (unitLetter === undefined || !/[мМmM]/.test(unitLetter)) return false;
  const beforeLetter = text[index - 2];
  if (beforeLetter !== undefined && /\p{L}/u.test(beforeLetter)) return false;
  const after = text[index + 1];
  return after === undefined || !/\d/.test(after);
}

export function numberTokensIn(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  const pattern = new RegExp(RAW_NUMBER.source, "gu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    if (isUnitDigitAt(text, start)) {
      pattern.lastIndex = start + 1;
      continue;
    }
    const raw = match[0];
    const values: number[] = [parseNumberText(raw)];
    const groups = raw.split(/[   ]/);
    if (groups.length > 1) {
      // «3 120» — это и 3120, и «3» рядом со «120» (номер позиции и объём).
      for (const group of groups) values.push(parseNumberText(group));
      for (let from = 1; from < groups.length - 1; from += 1) {
        values.push(parseNumberText(groups.slice(from).join("")));
      }
    }
    tokens.push({ values: values.filter((value) => Number.isFinite(value)), start, end: start + raw.length });
  }
  return tokens;
}

/** Числа равны с точностью до записи (запас на дробный хвост пересчёта единиц). */
export function sameNumber(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= 1e-7 * Math.max(Math.abs(a), Math.abs(b));
}

/** Видно ли число в цитате: в любой записи («1 234,5», «1234.5», «1234,50»). */
export function numberVisibleIn(value: number, quote: string): boolean {
  return numberTokensIn(quote).some((token) => token.values.some((candidate) => sameNumber(candidate, value)));
}

/* ───────────── Единицы в тексте ───────────── */

/** Токены, которые parseUnit знает, но единицами в строке таблицы они быть не могут. */
const NOT_A_UNIT_MENTION: ReadonlySet<string> = new Set(["ед", "ед.", "место"]);

function cleanToken(token: string): string {
  return token.replace(/^[([{]+/, "").replace(/[)\]}:,]+$/, "");
}

function isPowerOfTen(token: string): boolean {
  return /^(?:10|100|1000|10000)$/.test(token);
}

export interface UnitMention {
  readonly unit: ParsedUnit;
  /** Диапазон токенов: [from, to). */
  readonly from: number;
  readonly to: number;
}

/** Единицы измерения в списке токенов свёрнутого текста: «кг», «м2», «100 м2», «куб. м». */
export function scanUnits(tokens: readonly string[]): UnitMention[] {
  const found: UnitMention[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = cleanToken(tokens[index] as string);
    if (token === "" || NOT_A_UNIT_MENTION.has(token)) continue;
    const next = index + 1 < tokens.length ? cleanToken(tokens[index + 1] as string) : "";

    if (next !== "" && !NOT_A_UNIT_MENTION.has(next)) {
      if (isPowerOfTen(token)) {
        // «100 м2»: единица с множителем — но «100 шт» может быть и просто объёмом, поэтому берётся и «шт».
        const scaled = parseUnit(`${token} ${next}`);
        if (scaled !== null && scaled.multiplier === Number(token)) {
          found.push({ unit: scaled, from: index, to: index + 2 });
        }
        continue;
      }
      if (/^(?:куб|кв|пог|п)\.?$/.test(token)) {
        const pair = parseUnit(`${token} ${next}`);
        if (pair !== null) {
          found.push({ unit: pair, from: index, to: index + 2 });
          index += 1;
          continue;
        }
      }
    }

    const single = parseUnit(token);
    if (single === null) continue;
    if (single.multiplier !== 1 && !isPowerOfTen(String(single.multiplier))) continue;
    found.push({ unit: single, from: index, to: index + 1 });
  }
  return found;
}

/** Единицы, названные в тексте (цитата или строка документа), без повторов. */
export function unitsIn(text: string): ParsedUnit[] {
  const tokens = forFind(text).split(" ");
  const seen = new Set<string>();
  const units: ParsedUnit[] = [];
  for (const mention of scanUnits(tokens)) {
    const key = `${String(mention.unit.multiplier)}|${mention.unit.unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    units.push(mention.unit);
  }
  return units;
}

/* ───────────── Подпись колонки вместо единицы ───────────── */

/** Подписи колонок единицы измерения: «ед. изм.», «единица измерения», «Ед.изм.», «ед.». */
const HEADER_UNIT_KEYS: ReadonlySet<string> = new Set([
  "едизм",
  "едизмер",
  "единица",
  "единицы",
  "единицаизм",
  "единицаизмерения",
  "единицыизмерения",
  "единицаизмеренияобъема",
  "едизмерения",
  "изм",
  "ед",
  "unit",
  "units",
]);

/** Модель вернула название колонки, а не единицу. «ед.» — тоже подпись, хотя `parseUnit` читает её как «шт». */
export function isHeaderUnitLabel(raw: string): boolean {
  const key = raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s.\-_,:;()/\\]/g, "");
  return HEADER_UNIT_KEYS.has(key);
}

export interface RecoveredUnit {
  readonly unit: ParsedUnit;
  /** Написание единицы так, как оно стоит в строке. */
  readonly text: string;
}

/**
 * Настоящая единица из строки документа вместо подписи колонки.
 *
 * Берётся единица, стоящая вплотную к объёму: перед числом («м2 | 12,5») или
 * после («12,5 | м2»); слева предпочтительнее — так устроена колонка «Ед. изм.»
 * в ведомостях. Не нашлось рядом с числом — берётся единственная единица строки;
 * если их несколько, не угадываем.
 */
export function recoverUnitFromRows(rows: readonly string[], quantities: readonly number[]): RecoveredUnit | null {
  const quantity = quantities[0];
  for (const row of rows) {
    const tokens = forFind(row).split(" ");
    const mentions = scanUnits(tokens);
    if (mentions.length === 0) continue;

    if (quantity !== undefined) {
      for (const [index, token] of tokens.entries()) {
        if (!/^\d+(?:\.\d+)?$/.test(token) || !sameNumber(Number.parseFloat(token), quantity)) continue;
        const before = mentions.find((mention) => mention.to === index);
        const after = mentions.find((mention) => mention.from === index + 1);
        const chosen = before ?? after;
        if (chosen !== undefined) {
          return { unit: chosen.unit, text: tokens.slice(chosen.from, chosen.to).join(" ") };
        }
      }
    }

    const distinct = new Map(mentions.map((mention) => [`${String(mention.unit.multiplier)}|${mention.unit.unit}`, mention]));
    if (distinct.size === 1) {
      const only = [...distinct.values()][0] as UnitMention;
      return { unit: only.unit, text: tokens.slice(only.from, only.to).join(" ") };
    }
  }
  return null;
}

/**
 * Множитель единицы, который модель потеряла при переписывании строки.
 *
 * В ведомостях, составленных по ФСНБ, единица напечатана с множителем: «100 м2 | 0,899» — это 89,9 м2, а не 0,899 м2. Модель
 * нередко возвращает unit = «м2» и quantity = 0,899: цитата проходит проверку (число стоит в строке), а объём оказывается меньше
 * настоящего в сто раз, и после перевода под норму «100 м2» выходит 0,00899 (закупка 0302100011026000027: обои, окраска, потолки,
 * основания полов из фанеры).
 *
 * Множитель восстанавливается только по строке документа и только когда он не вызывает сомнений: единица той же величины с
 * множителем (10, 100, 1000, 10000 — `scanUnits`) стоит вплотную к объёму, перед числом («100 м2 0,899») или после него
 * («0,899 100 м2»). Множитель, который стоит где-то в строке не рядом с объёмом («на 100 м2 поверхности … м2 25»), не берётся; не берётся
 * и тогда, когда вплотную к числу стоит сама основная единица («м2 | 25»): единица объёма названа прямо. Единица другой величины
 * («100 шт» при «м2») тоже не подходит. Объём при этом остаётся напечатанным — меняется единица, а пересчёт «число × множитель»
 * делает вызывающий код, как для любой единицы с множителем.
 *
 * @param rows строки документа, в которых объём виден (цитата, строка наименования, строка фрагмента объёма)
 * @param quantity объём, как его вернула модель
 * @param unit единица, как её вернула модель; с множителем — восстанавливать нечего
 */
export function recoverUnitMultiplier(
  rows: readonly (string | null)[],
  quantity: number,
  unit: ParsedUnit,
): ParsedUnit | null {
  if (unit.multiplier !== 1) return null;
  for (const row of rows) {
    if (row === null) continue;
    const tokens = forFind(row).split(" ");
    const mentions = scanUnits(tokens);
    if (mentions.length === 0) continue;
    for (const [index, token] of tokens.entries()) {
      if (!/^\d+(?:\.\d+)?$/.test(token) || !sameNumber(Number.parseFloat(token), quantity)) continue;
      // Самое длинное упоминание у числа: «100 м2» перекрывает вложенное «м2».
      const before = mentions.filter((mention) => mention.to === index).sort((a, b) => a.from - b.from)[0];
      const after = mentions.filter((mention) => mention.from === index + 1).sort((a, b) => b.to - a.to)[0];
      const adjacent = before ?? after;
      if (adjacent === undefined) continue;
      if (adjacent.unit.multiplier > 1 && adjacent.unit.unit === unit.unit) return adjacent.unit;
    }
  }
  return null;
}

/* ───────────── Строка документа ───────────── */

/** Номер позиции в начале строки: «4 Болты», «4.1 Гайки». */
const ROW_START = /^\s*\d{1,4}(?:\.\d{1,3})*[.)]?[\s;|]+(?=\p{L}{2,})/u;

/**
 * Строка — продолжение предыдущей: перенос в разобранном PDF. Это строка без
 * слова из четырёх букв («кг 2,2», «12,5», «шт.») или начатая со строчной буквы,
 * когда номера позиции у неё нет.
 */
function isContinuationLine(line: string): boolean {
  const text = line.trim();
  if (text === "") return false;
  const lead = ROW_START.exec(text);
  if (lead !== null) {
    const firstWord = text.slice(lead[0].length).split(/\s+/)[0] ?? "";
    if (parseUnit(firstWord.replace(/[.,;:]+$/, "")) === null) return false;
  }
  if (!/\p{L}{4,}/u.test(text)) return true;
  return /^\p{Ll}/u.test(text);
}

/** Сколько строк-продолжений присоединяется к строке таблицы. */
const MAX_CONTINUATION_LINES = 2;

/** Строка длиннее этого — не строка таблицы, а склеенный абзац: берётся окно вокруг места. */
const MAX_ROW_CHARS = 1200;
const ROW_WINDOW = 400;

export interface RowOptions {
  /** Присоединять строки выше, если место стоит в строке-продолжении. */
  readonly back?: boolean;
  /** Присоединять строки-продолжения ниже. */
  readonly forward?: boolean;
}

function lineStartOf(source: string, position: number): number {
  return position <= 0 ? 0 : source.lastIndexOf("\n", position - 1) + 1;
}

function lineEndOf(source: string, position: number): number {
  const found = source.indexOf("\n", position);
  return found < 0 ? source.length : found;
}

/**
 * Строка таблицы вокруг места [from, to) исходного текста: сама строка и, для
 * разобранного PDF, её продолжения. Это «контекст строки»: единицы, числа и
 * наименование ищутся в нём.
 */
export function rowContextAt(source: string, from: number, to: number, options: RowOptions = {}): string {
  const clampedFrom = Math.max(0, Math.min(from, source.length));
  const clampedTo = Math.max(clampedFrom, Math.min(to, source.length));
  let start = lineStartOf(source, clampedFrom);
  let end = lineEndOf(source, clampedTo > clampedFrom ? clampedTo - 1 : clampedTo);

  if (options.back !== false) {
    for (let added = 0; added < MAX_CONTINUATION_LINES && start > 0; added += 1) {
      if (!isContinuationLine(source.slice(start, lineEndOf(source, start)))) break;
      const previousEnd = start - 1;
      const previousStart = lineStartOf(source, previousEnd);
      if (source.slice(previousStart, previousEnd).trim() === "") break;
      start = previousStart;
    }
  }
  if (options.forward === true) {
    for (let added = 0; added < MAX_CONTINUATION_LINES && end < source.length; added += 1) {
      const nextStart = end + 1;
      const nextEnd = lineEndOf(source, nextStart);
      if (!isContinuationLine(source.slice(nextStart, nextEnd))) break;
      end = nextEnd;
    }
  }

  if (end - start > MAX_ROW_CHARS) {
    return source.slice(Math.max(start, clampedFrom - ROW_WINDOW), Math.min(end, clampedTo + ROW_WINDOW));
  }
  return source.slice(start, end);
}

/** Где в тексте стоят вхождения цитаты: смещения начала и конца в исходнике. */
export interface QuoteSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * Вхождения фрагмента в свёрнутом тексте. У фрагмента, который начинается или
 * кончается цифрой, граница — не цифра: «12,5» не найдётся внутри «112,5» и
 * «2» не найдётся внутри «М12».
 */
export function fragmentSpans(fragment: string, text: FoldedText, limit = 50): QuoteSpan[] {
  const needle = forFind(fragment);
  if (needle === "") return [];
  const spans: QuoteSpan[] = [];
  let at = text.folded.indexOf(needle);
  while (at >= 0 && spans.length < limit) {
    const before = text.folded[at - 1];
    const after = text.folded[at + needle.length];
    const afterNext = text.folded[at + needle.length + 1];
    const startsClean = !/\d/.test(needle[0] as string) || before === undefined || !/[\d.]/.test(before);
    const endsClean =
      !/\d/.test(needle[needle.length - 1] as string) ||
      after === undefined ||
      !(/\d/.test(after) || (after === "." && afterNext !== undefined && /\d/.test(afterNext)));
    if (startsClean && endsClean) {
      const from = text.map[at] ?? 0;
      const lastChar = text.map[at + needle.length - 1] ?? from;
      spans.push({ from, to: lastChar + 1 });
    }
    at = text.folded.indexOf(needle, at + 1);
  }
  return spans;
}

/** Слова наименования, из которых строится опознание строки: не короче двух знаков. */
function nameWords(name: string): string[] {
  return forFind(name)
    .split(/[^\p{L}\p{N}.\-]+/u)
    .map((word) => word.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((word) => word.length >= 2);
}

/**
 * Наименование стоит в строке. Либо цитата наименования целиком, либо различимая
 * часть названия работы — два слова подряд («Болты М12»): строка PDF переносится
 * по-своему, и цитата, верная по словам, может не уместиться в одной строке.
 */
export function nameOnRow(row: string, nameQuote: string, workName: string): boolean {
  const text = ` ${forFind(row).replace(/[^\p{L}\p{N}.\-]+/gu, " ")} `;
  const quote = forFind(nameQuote).replace(/[^\p{L}\p{N}.\-]+/gu, " ").trim();
  if (quote.length >= 6 && text.includes(` ${quote} `)) return true;
  if (quote.length >= 6 && text.includes(quote)) return true;
  for (const source of [workName, nameQuote]) {
    const words = nameWords(source);
    for (let index = 0; index + 1 < words.length; index += 1) {
      const pair = `${words[index] as string} ${words[index + 1] as string}`;
      if (pair.length >= 7 && text.includes(` ${pair} `)) return true;
    }
  }
  return false;
}

/* ───────────── Объём и цитата ───────────── */

/** Кратные единицы одной величины: во сколько единиц семейства входит единица. Только точные соотношения. */
const FAMILY: Readonly<Record<string, { readonly family: string; readonly scale: number }>> = {
  кг: { family: "масса", scale: 1 },
  т: { family: "масса", scale: 1000 },
  м: { family: "длина", scale: 1 },
  км: { family: "длина", scale: 1000 },
};

function dimensionOf(unit: ParsedUnit): { family: string; amountOf: (value: number) => number } {
  const known = FAMILY[unit.unit];
  const scale = known?.scale ?? 1;
  return { family: known?.family ?? unit.unit, amountOf: (value) => value * unit.multiplier * scale };
}

/** Единица цитаты, когда ни в цитате, ни в строке единицы нет: только точный масштаб внутри величины. */
function familyNeighbours(unit: ParsedUnit): ParsedUnit[] {
  const known = FAMILY[unit.unit];
  if (known === undefined) return [];
  return Object.entries(FAMILY)
    .filter(([name, entry]) => entry.family === known.family && name !== unit.unit)
    .map(([name]) => ({ unit: name, multiplier: 1 }));
}

export type QuantityProof = "EXACT" | "UNIT_FACTOR" | "ARITHMETIC";

export interface QuantityEvidence {
  /** Число, как оно напечатано в документе. */
  readonly printed: number;
  readonly proof: QuantityProof;
  /** Что именно совпало: попадает в сообщения и в тесты. */
  readonly detail: string;
}

export interface QuantityCheck {
  /** Объём, как его вернула модель (до множителя единицы). */
  readonly quantity: number;
  readonly unit: ParsedUnit;
  /** Фрагмент, в котором модель показывает объём. */
  readonly quote: string;
  /** Строка документа вокруг фрагмента: единицы и числа для пересчёта берутся и из неё. */
  readonly row: string | null;
}

const FORMULA = /(\d+(?:[.,]\d+)?)((?:\s*[*×·xх+]\s*\d+(?:[.,]\d+)?){1,2})/giu;

/** Значение формулы «225*3», «100+25», «2 х 3,5 х 4»: произведения и суммы до трёх чисел. */
function evaluateFormula(first: string, rest: string): number | null {
  const operands = [first, ...rest.split(/[*×·xх+]/iu).slice(1)].map((part) => parseNumberText(part.trim()));
  const operators = [...rest.matchAll(/[*×·xх+]/giu)].map((op) => (op[0] === "+" ? "+" : "*"));
  if (operands.length !== operators.length + 1 || operands.some((value) => !Number.isFinite(value))) return null;
  let sum = 0;
  let product = operands[0] as number;
  for (const [index, operator] of operators.entries()) {
    const value = operands[index + 1] as number;
    if (operator === "*") product *= value;
    else {
      sum += product;
      product = value;
    }
  }
  return sum + product;
}

/** Формулы вида «225*3» в тексте и их значения. */
function explicitFormulaValues(text: string): { expression: string; value: number }[] {
  const result: { expression: string; value: number }[] = [];
  for (const match of text.matchAll(FORMULA)) {
    const value = evaluateFormula(match[1] as string, match[2] as string);
    if (value !== null && value > 0) result.push({ expression: match[0].replace(/\s+/g, ""), value });
  }
  return result;
}

/** Числа строки подряд: сумма и произведение двух-трёх соседних чисел. */
function adjacentArithmetic(text: string): { expression: string; value: number }[] {
  const tokens = numberTokensIn(text).slice(0, 40);
  const lead = /^\s*(\d{1,4})(?=[\s;|]+\p{L})/u.exec(text);
  // Номер позиции в начале строки в арифметике не участвует.
  const numbers = (lead === null ? tokens : tokens.filter((token) => token.start > (lead.index ?? 0) + lead[0].length - 1))
    .map((token) => token.values[0] as number)
    .filter((value) => Number.isFinite(value) && value > 0 && value !== 1);
  const result: { expression: string; value: number }[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 1) {
    for (const size of [2, 3]) {
      const window = numbers.slice(index, index + size);
      if (window.length < size) continue;
      result.push({ expression: window.join("*"), value: window.reduce((a, b) => a * b, 1) });
      result.push({ expression: window.join("+"), value: window.reduce((a, b) => a + b, 0) });
    }
  }
  return result;
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1e9) / 1e9).replace(".", ",");
}

/**
 * Подтверждён ли объём цитатой. Подходит запись в любой из форм:
 *  — то же число в любой записи («1 234,5» = «1234.5» = «1234,50»);
 *  — число цитаты, пересчитанное между единицами цитаты и позиции: кг↔т, м↔км,
 *    «100 м2»↔м2, «100 шт»↔шт; единицы берутся из цитаты, а нет — из строки;
 *  — сумма или произведение до трёх чисел той же строки («225*3» = 675).
 * Любой другой объём, как бы он ни был правдоподобен, подтверждением не считается.
 */
export function confirmQuantity(check: QuantityCheck): QuantityEvidence | null {
  const { quantity, unit, quote, row } = check;

  const numbers = numberTokensIn(quote);
  for (const token of numbers) {
    for (const value of token.values) {
      if (sameNumber(value, quantity)) {
        return { printed: quantity, proof: "EXACT", detail: `число ${formatNumber(quantity)} стоит в цитате` };
      }
    }
  }

  // Единицы: сначала из цитаты, затем из строки; нет нигде — только точный масштаб внутри величины.
  const quoteUnits = unitsIn(quote);
  const rowUnits = quoteUnits.length > 0 || row === null ? [] : unitsIn(row);
  const named = quoteUnits.length > 0 ? quoteUnits : rowUnits;
  const candidates = named.length > 0 ? named : familyNeighbours(unit);

  const target = dimensionOf(unit);
  const wanted = target.amountOf(quantity);
  for (const token of numbers) {
    for (const value of token.values) {
      for (const candidate of candidates) {
        const source = dimensionOf(candidate);
        if (source.family !== target.family) continue;
        if (sameNumber(source.amountOf(value), wanted)) {
          const label = `${candidate.multiplier === 1 ? "" : `${String(candidate.multiplier)} `}${candidate.unit}`;
          return {
            printed: value,
            proof: "UNIT_FACTOR",
            detail: `${formatNumber(value)} ${label} = ${formatNumber(quantity)} ${unit.multiplier === 1 ? "" : `${String(unit.multiplier)} `}${unit.unit}`,
          };
        }
      }
    }
  }

  const sources = [quote, ...(row !== null && row !== quote ? [row] : [])];
  for (const text of sources) {
    for (const formula of explicitFormulaValues(text)) {
      if (sameNumber(formula.value, quantity)) {
        return { printed: quantity, proof: "ARITHMETIC", detail: `${formula.expression} = ${formatNumber(quantity)}` };
      }
    }
  }
  for (const text of sources) {
    for (const formula of adjacentArithmetic(text)) {
      if (sameNumber(formula.value, quantity)) {
        return { printed: quantity, proof: "ARITHMETIC", detail: `${formula.expression} = ${formatNumber(quantity)}` };
      }
    }
  }
  return null;
}

/** Что проверялось и чего не нашлось: хвост сообщения об отказе «объём не встречается в цитате». */
export function describeQuantityChecks(check: QuantityCheck): string {
  const quoteUnits = unitsIn(check.quote);
  const rowUnits = quoteUnits.length > 0 || check.row === null ? [] : unitsIn(check.row);
  const named = quoteUnits.length > 0 ? quoteUnits : rowUnits;
  const unitLabel = (value: ParsedUnit): string => `${value.multiplier === 1 ? "" : `${String(value.multiplier)} `}${value.unit}`;
  const numbers = numberTokensIn(check.quote)
    .map((token) => formatNumber(token.values[0] as number))
    .slice(0, 8);
  return (
    "проверено: то же число в любой записи (1 234,5 = 1234.5); " +
    `число с пересчётом единиц (единицы ${quoteUnits.length > 0 ? "цитаты" : "строки"}: ${named.length > 0 ? named.map(unitLabel).join(", ") : "не найдены"}; ` +
    `единица позиции: ${unitLabel(check.unit)}); ` +
    `сумма или произведение до трёх чисел строки (числа цитаты: ${numbers.length > 0 ? numbers.join("; ") : "нет"}) — совпадений нет`
  );
}
