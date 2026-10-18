import { extractWorkPeriod } from "@/domain/estimate/workPeriod";

/**
 * Срок работ из текста документации — подсказка для индекса прогнозной инфляции.
 *
 * Дополняет `extractWorkPeriod` (даты вида 01.09.2026) тем, что чаще пишут в проектах контрактов на
 * ремонт: «с момента заключения Контракта по 30 ноября 2026 г.» (одна граница, месяц словом) и «в течение
 * 60 календарных дней с даты заключения контракта». Подсказка ничего не ставит сама: человек подтверждает
 * её кнопкой «Применить», как остальные подсказки блока «Условия работ».
 */

export interface SsrTermHint {
  /** ISO-даты; null — граница не названа. */
  readonly start: string | null;
  readonly end: string | null;
  /** «В течение N месяцев»: календарные дни переведены в месяцы (30 дней = месяц, вверх). */
  readonly months: number | null;
  readonly quote: string;
}

const MONTH_STEMS: readonly (readonly [string, number])[] = [
  ["январ", 1], ["феврал", 2], ["март", 3], ["апрел", 4], ["ма", 5], ["июн", 6], ["июл", 7], ["август", 8], ["сентябр", 9], ["октябр", 10], ["ноябр", 11], ["декабр", 12],
];

function monthNumber(word: string): number | null {
  const lower = word.toLowerCase().replace(/ё/gu, "е");
  for (const [stem, number] of MONTH_STEMS) {
    if (stem === "ма" ? /^ма[йя]/u.test(lower) : lower.startsWith(stem)) return number;
  }
  return null;
}

const ANCHOR = /(?:срок[а-я]*\s+(?:выполнения|исполнения|окончания)\s+работ|работ[ыа]?\s+(?:должн[а-я]+\s+быть\s+)?(?:выполнен[а-я]*|завершен[а-я]*)|период\s+выполнения\s+работ|срок[а-я]*\s+выполнения)/iu;
const WORD_DATE = /(\d{1,2})\s+(январ[а-я]*|феврал[а-я]*|март[а-я]*|апрел[а-я]*|ма[йя]|июн[а-я]*|июл[а-я]*|август[а-я]*|сентябр[а-я]*|октябр[а-я]*|ноябр[а-я]*|декабр[а-я]*)\s+(20\d{2})/iu;
const DURATION = /в\s+течение\s+(\d{1,3})\s*(?:\([^)]*\)\s*)?(календарн[а-я]*\s+дн[а-я]*|рабоч[а-я]*\s+дн[а-я]*|дн[а-я]*|месяц[а-я]*)/iu;

function isoDate(day: string, month: number, year: string): string | null {
  const d = Number.parseInt(day, 10);
  const y = Number.parseInt(year, 10);
  if (d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, month - 1, d));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function extractSsrTerm(text: string): SsrTermHint | null {
  // Две даты цифрами — как в блоке зимнего удорожания.
  const numeric = extractWorkPeriod(text);
  if (numeric !== null && numeric.start !== null && numeric.end !== null) {
    return { start: numeric.start, end: numeric.end, months: null, quote: numeric.quote };
  }

  const flat = text.replace(/\s+/gu, " ");
  const anchor = new RegExp(ANCHOR.source, "giu");
  for (let a = anchor.exec(flat); a !== null; a = anchor.exec(flat)) {
    const window = flat.slice(a.index, Math.min(flat.length, a.index + a[0].length + 260));
    const word = WORD_DATE.exec(window);
    if (word !== null) {
      const month = monthNumber(word[2] as string);
      const iso = month === null ? null : isoDate(word[1] as string, month, word[3] as string);
      if (iso !== null) {
        const before = window.slice(0, word.index).toLowerCase();
        const isEnd = /(?:по|до|окончани[а-я]*|завершени[а-я]*|не\s+позднее)\s*(?:[—:-]\s*)?$/u.test(before);
        const quote = window.slice(0, word.index + word[0].length + 4).trim();
        return isEnd || /с\s+(?:момента|даты)\s+(?:заключения|подписания)/u.test(before)
          ? { start: null, end: iso, months: null, quote }
          : { start: iso, end: null, months: null, quote };
      }
    }
    const duration = DURATION.exec(window);
    if (duration !== null) return durationHint(duration);
  }
  const loose = DURATION.exec(flat);
  return loose === null ? null : durationHint(loose);
}

function durationHint(match: RegExpExecArray): SsrTermHint {
  const count = Number.parseInt(match[1] as string, 10);
  const unit = (match[2] as string).toLowerCase();
  const months = unit.startsWith("месяц") ? count : Math.max(1, Math.ceil(count / 30));
  return { start: null, end: null, months, quote: match[0] };
}
