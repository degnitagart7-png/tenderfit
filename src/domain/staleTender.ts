/** Через сколько дней после срока подачи закупка считается давно закрытой в плановом сборе. */
export const STALE_PLANNED_DAYS = 7;

/**
 * Закупка закрыта давно: плановому сбору она не нужна.
 *
 * ЕИС держит давние извещения (2014, 2019) со статусом «Подача заявок»: их никто
 * не закрыл. Они занимают лимит и выглядят как свежие находки. Недавно
 * закрытые остаются: человеку полезно видеть, что закрылось только что.
 * Неизвестный или нечитаемый срок давней закрытостью не считается.
 */
export function isClosedLongAgo(
  submissionEnd: string,
  nowMs: number,
  days: number = STALE_PLANNED_DAYS,
): boolean {
  const end = Date.parse(submissionEnd);
  if (Number.isNaN(end)) return false;
  return end < nowMs - days * 86_400_000;
}
