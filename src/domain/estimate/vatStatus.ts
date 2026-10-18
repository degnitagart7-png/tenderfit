import type { TenderLaw } from "@/domain/enums";

/**
 * Включена ли НДС в цену закупки: факт из документации или допущение.
 *
 * Зачем. От этого флага сдвигаются все границы цены: у плательщика НДС при цене
 * «с НДС» выручка на 1/6 меньше. Раньше расчёт молча принимал «с НДС», и человек
 * не знал, что это догадка. Здесь ответ ищется в тексте документов, а когда его там
 * нет — честно называется допущением, с указанием, на чём оно стоит.
 *
 * Принцип «лучше не найдено, чем ложный факт»:
 * - смотрим только фрагменты, где рядом сказано про цену (иначе «без НДС» из
 *   проекта договора о штрафах сойдёт за цену закупки);
 * - если в документах встретились оба варианта, ничего не утверждаем и просим
 *   проверить вручную;
 * - цитата дословная, чтобы человек мог найти её в файле.
 *
 * Модуль чистый и работает за линейное время: тексты документов бывают в сотни
 * тысяч знаков, поэтому никаких вложенных квантификаторов — только литеральные
 * фразы, а «фрагмент вокруг совпадения» ограничен несколькими сотнями знаков.
 */

export type VatBasis = "DOCUMENT" | "LAW_44" | "ASSUMPTION";

export interface VatStatus {
  /** Что подставить в расчёт. */
  readonly includesVat: boolean;
  readonly basis: VatBasis;
  /** Дословный фрагмент (до ~200 знаков) — только для DOCUMENT. */
  readonly quote: string | null;
  readonly documentName: string | null;
  /** В документах найдены оба варианта. */
  readonly conflict: boolean;
}

export interface VatDocument {
  readonly name: string;
  readonly text: string;
}

/** Сколько знаков цитаты показываем. */
const MAX_QUOTE = 200;
/** Как далеко от фразы про НДС ищем границу фрагмента и слово про цену. */
const MAX_BACK = 300;
const MAX_FORWARD = 200;

/*
  Все шаблоны написаны для «свёрнутого» текста: нижний регистр, «ё» → «е».
  Пробелы между словами — `\s+`, чтобы переносы строк и неразрывные пробелы из PDF
  не мешали. Границы слов проверяются вручную: `\b` не работает с кириллицей.
*/

/** «Без НДС»: цена не включает налог. */
const WITHOUT_RE =
  /без\s+учета\s+ндс|без\s+ндс|ндс\s+не\s+облагается|не\s+облагается\s+ндс|ндс\s+не\s+предусмотрен|(?:кроме|сверх)\s+того,?\s+ндс|плюс\s+ндс|дополнительно\s+ндс/gu;

/**
 * «С НДС»: цена включает налог. «С учетом НДС» не пересекается с «без учета НДС»:
 * у них разные окончания («учетом» и «учета»), а «с» проверяется как целое слово.
 */
const WITH_RE =
  /с\s+учетом\s+ндс|включая\s+ндс|в\s+том\s+числе\s+ндс|в\s+т\.\s*ч\.\s*ндс|ндс\s*\(?\s*(?:10|20|22)\s*%/gu;

/** Слово про цену в начале слова: «цена», «НМЦК», «стоимость», но не «оценка» и не «процент». */
const PRICE_WORD_RE = /(?:^|[^\p{L}\p{N}])(?:цен|нмц|стоимост)/u;

/** После «НДС» идёт отрицание: «в том числе НДС не облагается» — это «без НДС». */
const NEGATION_AFTER_RE = /^\s*\(?\s*не(?![\p{L}\p{N}])/u;
/**
 * Перед фразой отрицание или «сверху»: «без учета НДС 20 %», «не включая НДС»,
 * «кроме того НДС 20 %», «плюс НДС» — налог начисляется сверх цены, это не «с НДС».
 */
const NEGATION_BEFORE_RE =
  /(?:^|[^\p{L}\p{N}])(?:без|не|кроме\s+того|сверх\s+того|плюс|дополнительно)(?:\s+учета)?[\s,]*$/u;

/**
 * Условная оговорка про участника, а не статус НМЦК: «в случае, если подрядчик
 * применяет УСН, цена не облагается НДС» есть почти в каждом проекте контракта.
 * То же «в связи с применением УСН»: режим поставщика до торгов неизвестен, так что
 * это не факт о цене НМЦК. Такой фрагмент не доказывает «без НДС» для цены закупки.
 * «УСН» и «УСНО» ищутся как отдельные слова, не внутри других.
 */
const CONDITIONAL_RE =
  /(?:^|[^\p{L}\p{N}])(?:в\s+случае|если|при\s+условии|при\s+применении|в\s+связи\s+с\s+применением|усно?)(?![\p{L}\p{N}])|упрощ|освобожд|не\s+является\s+плательщик/u;

/**
 * Правило сравнения заявок («оценка по цене без учета НДС»), а не цена закупки:
 * такой фрагмент не считается ни «с НДС», ни «без НДС».
 */
const EVALUATION_RE = /(?:^|[^\p{L}\p{N}])(?:оценк|сравнен|сопоставл|рассмотрен)/u;

const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

/** Сокращения, после которых точка не заканчивает предложение. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "т", "ч", "п", "пп", "ст", "г", "гг", "руб", "коп", "тыс", "млн", "млрд", "р",
  "ед", "шт", "кв", "ул", "д", "им", "ориг", "прим", "см", "стр", "рис", "табл", "ф", "вкл",
]);

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && LETTER_OR_DIGIT_RE.test(char);
}

/**
 * Нижний регистр и «ё» → «е» с сохранением длины: по смещениям в свёрнутом тексте
 * берётся цитата из оригинала. У редких символов (например, «İ») нижний регистр
 * длиннее исходного — их оставляем как есть, чтобы смещения не поехали.
 */
function fold(text: string): string {
  const quick = text.replace(/[ёЁ]/g, "е").toLowerCase();
  if (quick.length === text.length) return quick;
  const parts: string[] = [];
  for (const char of text) {
    const lower = (char === "ё" || char === "Ё" ? "е" : char).toLowerCase();
    parts.push(lower.length === char.length ? lower : char);
  }
  return parts.join("");
}

/** Заканчивается ли на этом знаке фрагмент: перевод строки, «;», конец предложения. */
function isBoundary(text: string, index: number): boolean {
  const char = text[index];
  if (char === "\n" || char === "\r" || char === ";" || char === "!" || char === "?") return true;
  if (char !== ".") return false;
  // Точка внутри «т.ч.», «5.1», «1 000,00» — не конец предложения.
  const next = text[index + 1];
  if (next !== undefined && !/\s/.test(next)) return false;
  let start = index;
  while (start > 0 && index - start < 8 && isWordChar(text[start - 1])) start -= 1;
  const word = text.slice(start, index);
  if (word === "") return true;
  if (/^\d+$/.test(word)) return false;
  return word.length > 1 && !ABBREVIATIONS.has(word);
}

interface Hit {
  readonly documentName: string;
  readonly quote: string;
}

/** Фрагмент вокруг совпадения: от ближайшей границы до ближайшей, но не дальше лимита. */
function fragmentBounds(text: string, from: number, to: number): [number, number] {
  let start = from;
  const minStart = Math.max(0, from - MAX_BACK);
  while (start > minStart && !isBoundary(text, start - 1)) start -= 1;
  let end = to;
  const maxEnd = Math.min(text.length, to + MAX_FORWARD);
  while (end < maxEnd && !isBoundary(text, end)) end += 1;
  return [start, end];
}

function makeQuote(
  original: string,
  fragmentStart: number,
  fragmentEnd: number,
  matchStart: number,
  matchEnd: number,
): string {
  let from = fragmentStart;
  let to = fragmentEnd;
  if (to - from > MAX_QUOTE) {
    // Длинный фрагмент режем вокруг самой фразы про НДС.
    const middle = Math.floor((matchStart + matchEnd) / 2);
    from = Math.max(fragmentStart, middle - MAX_QUOTE / 2);
    to = Math.min(fragmentEnd, from + MAX_QUOTE);
    from = Math.max(fragmentStart, to - MAX_QUOTE);
  }
  let quote = original.slice(from, to).replace(/\s+/g, " ").trim();
  if (from > fragmentStart) quote = `…${quote}`;
  if (to < fragmentEnd) quote = `${quote}…`;
  return quote;
}

/**
 * Первое подходящее совпадение шаблона в документе.
 * `positive` — это признак «с НДС»: к нему применяются проверки на отрицание
 * («в том числе НДС не облагается», «без учета НДС 20 %»).
 */
function scanDocument(
  document: VatDocument,
  pattern: RegExp,
  positive: boolean,
): Hit | null {
  const original = document.text;
  if (original === "") return null;
  const folded = fold(original);
  pattern.lastIndex = 0;
  for (let match = pattern.exec(folded); match !== null; match = pattern.exec(folded)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isWordChar(folded[start - 1])) continue;
    // Фраза, кончающаяся на «%», границы справа не требует; остальные — целое слово «НДС».
    if (!match[0].endsWith("%") && isWordChar(folded[end])) continue;
    if (positive) {
      if (NEGATION_AFTER_RE.test(folded.slice(end, end + 24))) continue;
      if (NEGATION_BEFORE_RE.test(folded.slice(Math.max(0, start - 32), start))) continue;
    }
    const [fragmentStart, fragmentEnd] = fragmentBounds(folded, start, end);
    const fragment = folded.slice(fragmentStart, fragmentEnd);
    if (!PRICE_WORD_RE.test(fragment)) continue;
    if (EVALUATION_RE.test(fragment)) continue;
    if (!positive && CONDITIONAL_RE.test(fragment)) continue;
    return {
      documentName: document.name,
      quote: makeQuote(original, fragmentStart, fragmentEnd, start, end),
    };
  }
  return null;
}

function firstHit(documents: readonly VatDocument[], pattern: RegExp, positive: boolean): Hit | null {
  for (const document of documents) {
    const hit = scanDocument(document, pattern, positive);
    if (hit !== null) return hit;
  }
  return null;
}

/** Статус НДС в цене закупки: из документов, из закона или допущением. */
export function detectVatStatus(input: {
  law: TenderLaw | null | undefined;
  documents: readonly VatDocument[];
}): VatStatus {
  const fallback: VatBasis = input.law === "FZ_44" ? "LAW_44" : "ASSUMPTION";
  const withVat = firstHit(input.documents, WITH_RE, true);
  const withoutVat = firstHit(input.documents, WITHOUT_RE, false);

  if (withVat !== null && withoutVat !== null) {
    // Оба варианта: ни один не объявляем фактом.
    return { includesVat: true, basis: fallback, quote: null, documentName: null, conflict: true };
  }
  if (withVat !== null) {
    return { includesVat: true, basis: "DOCUMENT", quote: withVat.quote, documentName: withVat.documentName, conflict: false };
  }
  if (withoutVat !== null) {
    return { includesVat: false, basis: "DOCUMENT", quote: withoutVat.quote, documentName: withoutVat.documentName, conflict: false };
  }
  // Цена контракта по 44-ФЗ включает налоги, но это закон, а не документ.
  return { includesVat: true, basis: fallback, quote: null, documentName: null, conflict: false };
}
