/**
 * Срок работ и упоминание зимы в тексте документации — подсказки для расчёта зимнего удорожания.
 *
 * Расчёт не ставит ничего сам: найденные даты предлагаются человеку («В ТЗ сказано: «…» — применить?»),
 * а в расчёт идёт то, что он оставил. Регулярные выражения — по живым формулировкам извещений и
 * проектов контрактов: «Срок выполнения работ: с 01.09.2026 по 30.11.2026», «Начало выполнения работ
 * — 01.09.2026», «окончание — до 30.11.2026». Сроки «в течение 60 календарных дней с даты заключения
 * контракта» дат не дают, и период остаётся неизвестным.
 */

export interface WorkPeriodHint {
  /** ISO-даты; null — в тексте названа только одна граница. */
  readonly start: string | null;
  readonly end: string | null;
  /** Что сказано в документации. */
  readonly quote: string;
}

const DATE = /(\d{1,2})[./](\d{1,2})[./](\d{4})/gu;
const ANCHOR = /(?:сро[кч][а-я]*|период[а-я]*|начал[а-я]*|окончани[а-я]*|завершени[а-я]*)[^.:;]{0,40}?(?:работ|выполнени)[а-я]*/giu;

function iso(day: string, month: string, year: string): string | null {
  const d = Number.parseInt(day, 10);
  const m = Number.parseInt(month, 10);
  const y = Number.parseInt(year, 10);
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return `${String(y)}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function datesIn(text: string, from: number): { iso: string; index: number; length: number }[] {
  const found: { iso: string; index: number; length: number }[] = [];
  const re = new RegExp(DATE.source, "gu");
  re.lastIndex = from;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const value = iso(m[1] as string, m[2] as string, m[3] as string);
    if (value !== null) found.push({ iso: value, index: m.index, length: m[0].length });
  }
  return found;
}

/** Срок выполнения работ: две даты — период; одна — граница по слову рядом («до», «по», «с»). */
export function extractWorkPeriod(text: string): WorkPeriodHint | null {
  const flat = text.replace(/\s+/gu, " ");
  const anchor = new RegExp(ANCHOR.source, "giu");
  for (let a = anchor.exec(flat); a !== null; a = anchor.exec(flat)) {
    const windowEnd = Math.min(flat.length, a.index + a[0].length + 220);
    const window = flat.slice(a.index, windowEnd);
    const dates = datesIn(window, 0);
    if (dates.length === 0) continue;
    const quote = window.slice(0, Math.min(window.length, (dates[Math.min(dates.length, 2) - 1] as { index: number; length: number }).index + 14)).trim();
    if (dates.length >= 2) {
      const sorted = [dates[0] as { iso: string }, dates[1] as { iso: string }].map((item) => item.iso).sort();
      return { start: sorted[0] as string, end: sorted[1] as string, quote };
    }
    const only = dates[0] as { iso: string; index: number };
    const before = window.slice(Math.max(0, only.index - 20), only.index).toLowerCase();
    const isEnd = /(?:до|по|окончани[а-я]*|завершени[а-я]*|не\s+позднее)\s*[—:-]?\s*$/u.test(before);
    return { start: isEnd ? null : only.iso, end: isEnd ? only.iso : null, quote };
  }
  return null;
}

export interface WinterMention {
  readonly quote: string;
}

/** В тексте названы работы в зимний период: «в зимний период», «в зимнее время», «при отрицательных температурах». */
export function detectWinterMention(text: string): WinterMention | null {
  const m = /(?:в\s+)?зимн[а-я]+\s+(?:период|врем[яе]ни?)|при\s+отрицательн[а-я]+\s+температур[а-я]*/iu.exec(text);
  if (m === null) return null;
  const start = Math.max(0, m.index - 50);
  return { quote: `…${text.slice(start, m.index + m[0].length + 50).replace(/\s+/gu, " ").trim()}…` };
}
