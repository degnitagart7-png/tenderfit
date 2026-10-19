import type { PaymentInvoiceView, PaymentStatus } from "@/domain/payments";
import { planById } from "@/domain/plans";

/** Общие подписи страницы оплаты: сумма, дата, статус. */

export function formatRub(value: number): string {
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: 2 }).replace(/\s/g, "\u00a0")} ₽`;
}

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

export function planLabel(id: string): string {
  return planById(id)?.name ?? id;
}

/** Статус для клиента: у заявки по QR «ждёт» значит «ждём подтверждения». */
export function statusText(invoice: Pick<PaymentInvoiceView, "status" | "method">): string {
  if (invoice.status === "issued") return invoice.method === "sbp_claim" ? "ждёт подтверждения" : "ждёт оплаты";
  const labels: Record<Exclude<PaymentStatus, "issued">, string> = { paid: "оплачен", cancelled: "отменён", expired: "просрочен" };
  return labels[invoice.status];
}

export function statusTone(status: PaymentStatus): "olive" | "mustard" | "neutral" {
  return status === "paid" ? "olive" : status === "issued" ? "mustard" : "neutral";
}

export const AUTO_ACTIVATION_NOTE =
  "Подписка включится автоматически, как только банк подтвердит оплату — обычно в течение нескольких минут после поступления.";
