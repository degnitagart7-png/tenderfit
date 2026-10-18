/**
 * Мелкие текстовые помощники отчёта «Глубокий анализ»: деньги, числа, обрезка
 * цитат. Здесь нет знаний о структуре отчёта — только то, что нужно двум и более
 * его частям (требования, риски, деньги, сроки).
 */

export type ReportTone = "good" | "warn" | "bad" | "neutral";

const NBSP = " ";

const RUB_EXACT = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** «406 430,66 ₽»: копейки всегда, пробел перед знаком — неразрывный. */
export function formatRubExact(value: number): string {
  return `${RUB_EXACT.format(round2(value))}${NBSP}₽`;
}

/** Процент от суммы, до копейки. */
export function percentOf(base: number, percent: number): number {
  return round2((base * percent) / 100);
}

/** «20 %», «2,5 %»: пробел перед знаком — неразрывный. */
export function formatPercent(value: number): string {
  return `${String(value).replace(".", ",")}${NBSP}%`;
}

/** Строка без переносов и двойных пробелов. */
export function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Для сравнения: нижний регистр, «ё» как «е», один пробел. */
export function norm(text: string): string {
  return flat(text).toLowerCase().replace(/ё/g, "е");
}

export function lowerFirst(text: string): string {
  return text.length > 0 ? `${text[0]!.toLowerCase()}${text.slice(1)}` : text;
}

/** Предложение с точкой в конце (если там ещё нет знака). */
export function withStop(text: string): string {
  const trimmed = flat(text);
  if (trimmed === "") return "";
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Обрезка по границе слова с «…»: цитата не должна кончаться на середине слова.
 * Если пробела в разумных пределах нет (длинный номер, ссылка) — режем по длине.
 */
export function shortenAtWord(text: string, max: number): string {
  const value = flat(text);
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const head = space > max * 0.5 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s,;:—–-]+$/u, "")}…`;
}

/** Первое предложение; если оно всё равно длиннее `max` — обрезка по слову. */
export function firstSentence(text: string, max = 220): string {
  const value = flat(text);
  // Точка после «г.», «ул.», «ст.» и т. п. предложения не заканчивает.
  const match =
    /^.*?(?<!(?:^|[\s(])(?:г|гг|ул|д|п|пп|ст|ч|руб|коп|тыс|млн|им|т|см|ред))[.!?](?=\s|$)/iu.exec(
      value,
    );
  const sentence = match ? match[0] : value;
  return shortenAtWord(sentence, max);
}

/**
 * Коротко и по-человечески: если пояснение укладывается — целиком, иначе первое
 * предложение. Модель просили писать 1–2 предложения, но старые разборы длиннее.
 */
export function shortDetail(text: string, max = 240): string {
  const value = flat(text);
  if (value.length <= max) return value;
  return firstSentence(value, max);
}

/** Цитата для ячейки «Основание»: до `max` знаков, в кавычках. */
export function quoteText(quote: string, max = 180): string {
  const value = flat(quote);
  return value === "" ? "" : `«${shortenAtWord(value, max)}»`;
}

/** Строка раздела или файла под цитатой: «— раздел; другой раздел». */
export function sourceNote(sources: readonly string[]): string | undefined {
  const unique = [...new Set(sources.map(flat).filter((s) => s !== ""))];
  return unique.length > 0 ? `— ${unique.join("; ")}` : undefined;
}

/**
 * Числа из текста в каноническом виде («203 215,33» и «203215.33» — одно число).
 * Нужны, чтобы понять: два требования говорят об одном и том же.
 */
export function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  const pattern =
    /\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/gu;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[0].replace(/[   ]/g, "").replace(",", "."));
    if (Number.isFinite(value)) found.add(String(value));
  }
  return found;
}

export function sameNumbers(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function shareNumber(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

/** Основы слов (5 букв) длиной от 4 — для грубого сравнения названий. */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of norm(text).match(/[а-яa-z]{4,}/gu) ?? []) {
    out.add(word.slice(0, 5));
  }
  return out;
}

export function stemOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const value of a) if (b.has(value)) n += 1;
  return n;
}

/** Сумма в рублях из текста: «20321.53 RUB», «203 215,33 руб.», «5 000 ₽». */
export function parseRubAmount(text: string): number | null {
  const match =
    /(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(?:₽|руб|RUB|российск)/iu.exec(
      text,
    );
  if (!match) return null;
  const whole = match[1]!.replace(/[   ]/g, "");
  const value = Number(`${whole}.${match[2] ?? "0"}`);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Первый процент в тексте: «30%», «2,5 процента». */
export function parsePercent(text: string): number | null {
  const match = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|процент)/iu.exec(text);
  if (!match) return null;
  const value = Number(match[1]!.replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

/**
 * Последняя дата в тексте: «по 30 ноября 2026 г.», «до 23.12.2026».
 * Последняя, потому что в «с 1 октября по 30 ноября» срок кончается второй датой.
 * Время — конец дня по Москве: «по 30 ноября» включает 30-е целиком.
 */
export function parseLastDate(text: string): Date | null {
  const dates: { index: number; date: Date }[] = [];
  const words = new RegExp(
    `(\\d{1,2})\\s+(${MONTHS_GENITIVE.join("|")})\\s+(\\d{4})`,
    "giu",
  );
  for (const m of text.matchAll(words)) {
    const month = MONTHS_GENITIVE.indexOf(m[2]!.toLowerCase());
    dates.push({
      index: m.index ?? 0,
      date: endOfDayMsk(Number(m[3]), month, Number(m[1])),
    });
  }
  for (const m of text.matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{4})/g)) {
    dates.push({
      index: m.index ?? 0,
      date: endOfDayMsk(Number(m[3]), Number(m[2]) - 1, Number(m[1])),
    });
  }
  const valid = dates.filter(({ date }) => !Number.isNaN(date.getTime()));
  if (valid.length === 0) return null;
  valid.sort((a, b) => a.index - b.index);
  return valid[valid.length - 1]!.date;
}

function endOfDayMsk(year: number, month: number, day: number): Date {
  // 23:59 МСК (UTC+3) = 20:59 UTC.
  return new Date(Date.UTC(year, month, day, 20, 59));
}

/** «30 ноября 2026 г.» — по московскому календарю. */
export function formatDateRu(date: Date): string {
  const msk = new Date(date.getTime() + 3 * 3_600_000);
  return `${String(msk.getUTCDate())} ${MONTHS_GENITIVE[msk.getUTCMonth()]!} ${String(msk.getUTCFullYear())} г.`;
}

/** Сколько полных суток от `from` до `to`; отрицательное — уже прошло. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
