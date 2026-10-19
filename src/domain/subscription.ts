/**
 * Продление подписки: единое правило и для ручной выдачи (scripts/grant-access.ts),
 * и для автоматической активации после оплаты (services/payments/activationService.ts).
 *
 * Чистый модуль: время приходит параметром. Два места, считающие срок по-разному,
 * дали бы клиенту то лишний, то недостающий день, поэтому формула одна.
 */

const DAY_MS = 24 * 3_600_000;

/** Сколько дней даёт один оплаченный месяц. Тарифы у нас помесячные, календарный месяц не нужен. */
export const SUBSCRIPTION_MONTH_DAYS = 30;

/** Новый срок оплаты: от большего из «сейчас» и текущего срока, чтобы продление не отнимало оплаченное. */
export function extendPaidUntil(currentPaidUntil: number | null, nowMs: number, days: number): number {
  return Math.max(nowMs, currentPaidUntil ?? 0) + Math.round(days * DAY_MS);
}

/** Дни, которые даёт оплата за `months` месяцев. */
export function monthsToDays(months: number): number {
  return months * SUBSCRIPTION_MONTH_DAYS;
}
