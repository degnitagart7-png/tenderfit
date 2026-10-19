import {
  CLAIM_TTL_MS,
  INVOICE_TTL_MS,
  documentIdsInPurpose,
  invoiceNumbersInPurpose,
  normalizeInvoiceNumber,
  sameAmount,
  toKopecks,
  type PaymentInvoice,
} from "@/domain/payments";
import { PLANS } from "@/domain/plans";

/**
 * Какому счёту принадлежит входящий платёж банка.
 *
 * Чистые правила, без базы: список счетов приходит параметром, поэтому порядок
 * предпочтений проверяется тестом. Принцип — лучше не включить подписку и написать
 * владельцу, чем включить чужую: деньги и доступ связывает только однозначное совпадение.
 *
 * Платёж по реквизитам (`payment`):
 *   1. номер нашего счёта («ТФ-0001») или documentId банка в назначении — самый надёжный признак;
 *      сумма обязана совпасть, иначе это недоплата или переплата — разбирает владелец;
 *   2. иначе ИНН плательщика + точная сумма среди ждущих счетов (при нескольких — самый старый).
 * Платёж по QR (`sbp`, `sbp_b2b`): номер счёта в назначении, иначе точная сумма среди заявок
 * «Я оплатил»; две заявки на одну сумму — неоднозначно, подтверждает владелец ссылкой из письма.
 */

export type IncomingKind = "payment" | "sbp" | "sbp_b2b";

export interface IncomingPayment {
  kind: IncomingKind;
  /** Уникальный ключ события (paymentId, operationId, «b2b:…»). */
  ref: string;
  amountKop: number;
  purpose: string;
  payerInn: string | null;
}

export type MatchBy = "document_id" | "invoice_number" | "inn_amount" | "sbp_claim";

export type MatchResult =
  | { kind: "matched"; invoice: PaymentInvoice; by: MatchBy }
  /** Счёт уже оплачен (его закрыл опрос банка, а вебхук пришёл следом): ничего делать не нужно. */
  | { kind: "already_paid"; invoice: PaymentInvoice }
  /** Счёт найден по номеру, но сумма другая. */
  | { kind: "amount_mismatch"; invoice: PaymentInvoice }
  | { kind: "ambiguous"; candidates: PaymentInvoice[] }
  | { kind: "unmatched" };

/** Оплаченный счёт считается «уже закрытым» трое суток: так вебхук после опроса не станет тревогой. */
export const RECENT_PAID_MS = 3 * 24 * 3_600_000;

function byOldest(a: PaymentInvoice, b: PaymentInvoice): number {
  return a.createdAt - b.createdAt;
}

/** Подходит ли счёт под сопоставление: ждёт оплату и не старше срока либо недавно оплачен. */
function relevant(invoice: PaymentInvoice, nowMs: number): boolean {
  if (invoice.status === "issued") {
    const ttl = invoice.method === "invoice" ? INVOICE_TTL_MS : CLAIM_TTL_MS;
    return nowMs - invoice.createdAt <= ttl;
  }
  if (invoice.status === "paid") return invoice.paidAt !== null && nowMs - invoice.paidAt <= RECENT_PAID_MS;
  return false;
}

export function matchIncoming(payment: IncomingPayment, invoices: readonly PaymentInvoice[], nowMs: number): MatchResult {
  const pool = invoices.filter((invoice) => relevant(invoice, nowMs));
  const real = pool.filter((invoice) => invoice.method === "invoice");

  /* 1. Номер счёта или documentId в назначении. */
  const numbers = new Set(invoiceNumbersInPurpose(payment.purpose));
  const docIds = new Set(documentIdsInPurpose(payment.purpose));
  const named = real.filter(
    (invoice) =>
      (invoice.tochkaDocumentId !== null && docIds.has(invoice.tochkaDocumentId.toLowerCase())) ||
      (normalizeInvoiceNumber(invoice.invoiceNumber) !== null && numbers.has(normalizeInvoiceNumber(invoice.invoiceNumber) as string)),
  );
  if (named.length > 0) {
    const exact = named.filter((invoice) => sameAmount(invoice.amountRub, payment.amountKop / 100));
    if (exact.length === 0) return { kind: "amount_mismatch", invoice: [...named].sort(byOldest)[0] as PaymentInvoice };
    const open = exact.filter((invoice) => invoice.status === "issued");
    const chosen = [...(open.length > 0 ? open : exact)].sort(byOldest)[0] as PaymentInvoice;
    const by: MatchBy =
      chosen.tochkaDocumentId !== null && docIds.has(chosen.tochkaDocumentId.toLowerCase()) ? "document_id" : "invoice_number";
    return chosen.status === "paid" ? { kind: "already_paid", invoice: chosen } : { kind: "matched", invoice: chosen, by };
  }

  /* 2. Платёж по реквизитам: ИНН + сумма. */
  if (payment.kind === "payment") {
    if (payment.payerInn === null || payment.payerInn === "") return { kind: "unmatched" };
    const sameInn = real.filter(
      (invoice) => invoice.buyerInn === payment.payerInn && sameAmount(invoice.amountRub, payment.amountKop / 100),
    );
    const open = sameInn.filter((invoice) => invoice.status === "issued").sort(byOldest);
    if (open.length > 0) return { kind: "matched", invoice: open[0] as PaymentInvoice, by: "inn_amount" };
    const paid = sameInn.filter((invoice) => invoice.status === "paid");
    if (paid.length > 0) return { kind: "already_paid", invoice: paid[0] as PaymentInvoice };
    return { kind: "unmatched" };
  }

  /* 3. QR: заявка «Я оплатил» на ту же сумму. */
  const claims = pool.filter(
    (invoice) => invoice.method === "sbp_claim" && invoice.status === "issued" && sameAmount(invoice.amountRub, payment.amountKop / 100),
  );
  if (claims.length === 1) return { kind: "matched", invoice: claims[0] as PaymentInvoice, by: "sbp_claim" };
  if (claims.length > 1) return { kind: "ambiguous", candidates: claims.sort(byOldest) };
  return { kind: "unmatched" };
}

/**
 * Похож ли платёж без пары на оплату подписки.
 *
 * На счёт владельца приходят и другие деньги; письмо о каждом входящем превратило бы почту в
 * шум. Тревога — если в назначении наш номер, упомянут ТендерФит или сумма равна цене тарифа.
 */
export function looksLikeSubscription(payment: Pick<IncomingPayment, "amountKop" | "purpose">): boolean {
  if (invoiceNumbersInPurpose(payment.purpose).length > 0) return true;
  if (/тендер\s*-?\s*фит|tender-?fit/i.test(payment.purpose)) return true;
  return PLANS.some((plan) => plan.priceRub !== null && toKopecks(plan.priceRub) === payment.amountKop);
}
