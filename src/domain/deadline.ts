/**
 * Срок подачи без времени.
 *
 * Выдача ЕИС печатает окончание подачи только датой («22.10.2026»), и такой срок
 * хранится как полночь UTC (`parseRuDate`). Буквально это 03:00 по Москве в последний
 * день: закупка считалась закрытой с ночи, а накануне вечером лента писала «ещё 2 часа».
 * Настоящее время (обычно утро по часам заказчика) есть только в карточке ЕИС, а
 * читать карточку каждой закупки — сотни запросов к источнику, который блокирует.
 * Поэтому срок без времени — это весь последний день: закупка видна до его конца по
 * Москве, а подписи говорят днями («сегодня последний день»), не выдуманными часами.
 * Замер 16.10.2026: у всех 873 открытых закупок ЕИС время — 00:00 UTC.
 */

const MOSCOW_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

/** Срок — полночь UTC без секунд: дата из выдачи, время неизвестно. */
export function isDateOnlyDeadline(iso: string): boolean {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  return ms % DAY_MS === 0;
}

/** Момент, после которого подача точно закрыта: у срока без времени — конец того дня по Москве. */
export function effectiveDeadlineMs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return Number.NaN;
  return isDateOnlyDeadline(iso) ? ms + DAY_MS - MOSCOW_OFFSET_MS - 1000 : ms;
}

/** Сколько календарных дней до даты срока по Москве: 0 — сегодня, 1 — завтра, меньше нуля — прошла. */
export function calendarDaysLeft(iso: string, now: Date): number {
  const deadlineDay = Math.floor(Date.parse(iso) / DAY_MS);
  const today = Math.floor((now.getTime() + MOSCOW_OFFSET_MS) / DAY_MS);
  return deadlineDay - today;
}
