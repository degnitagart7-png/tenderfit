import { describe, expect, it } from "vitest";

import { looksLikeSubscription, matchIncoming, RECENT_PAID_MS, type IncomingPayment } from "@/domain/paymentMatching";
import type { PaymentInvoice } from "@/domain/payments";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 24 * 3_600_000;

function invoice(over: Partial<PaymentInvoice>): PaymentInvoice {
  return {
    id: "i-" + Math.random().toString(16).slice(2),
    userEmail: "client@firma.ru",
    plan: "start",
    amountRub: 9000,
    months: 1,
    status: "issued",
    method: "invoice",
    buyerInn: "7707083893",
    buyerKpp: null,
    buyerName: "ООО Ромашка",
    buyerEmail: "buh@romashka.ru",
    invoiceNumber: "ТФ-0001",
    tochkaDocumentId: "1cf95c4f-e794-4407-bac4-0829f19bd2be",
    tochkaPaymentRef: null,
    paidAt: null,
    activatedUntil: null,
    closingDocumentId: null,
    closingSentAt: null,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ...over,
  };
}

const payment = (over: Partial<IncomingPayment> = {}): IncomingPayment => ({
  kind: "payment",
  ref: "payment:1",
  amountKop: 900000,
  purpose: "",
  payerInn: "7707083893",
  ...over,
});

describe("платёж по реквизитам", () => {
  it("номер счёта в назначении важнее ИНН: платит бухгалтерия другого юрлица", () => {
    const a = invoice({ id: "a", invoiceNumber: "ТФ-0001" });
    const result = matchIncoming(payment({ purpose: "Оплата по счету № ТФ-0001", payerInn: "500100732259" }), [a], NOW);
    expect(result).toMatchObject({ kind: "matched", by: "invoice_number", invoice: { id: "a" } });
  });

  it("documentId банка в назначении", () => {
    const a = invoice({ id: "a" });
    const result = matchIncoming(payment({ purpose: "1cf95c4f-e794-4407-bac4-0829f19bd2be", payerInn: null }), [a], NOW);
    expect(result).toMatchObject({ kind: "matched", by: "document_id" });
  });

  it("номер найден, а сумма другая — не включаем, это работа владельца", () => {
    const a = invoice({ id: "a" });
    const result = matchIncoming(payment({ purpose: "ТФ-0001", amountKop: 800000 }), [a], NOW);
    expect(result).toMatchObject({ kind: "amount_mismatch", invoice: { id: "a" } });
  });

  it("без номера — по ИНН плательщика и точной сумме", () => {
    const a = invoice({ id: "a" });
    expect(matchIncoming(payment(), [a], NOW)).toMatchObject({ kind: "matched", by: "inn_amount" });
    expect(matchIncoming(payment({ amountKop: 900001 }), [a], NOW)).toEqual({ kind: "unmatched" });
    expect(matchIncoming(payment({ payerInn: "7728168971" }), [a], NOW)).toEqual({ kind: "unmatched" });
    expect(matchIncoming(payment({ payerInn: null }), [a], NOW)).toEqual({ kind: "unmatched" });
  });

  it("два одинаковых счёта одного плательщика — закрывается самый старый", () => {
    const old = invoice({ id: "old", invoiceNumber: "ТФ-0001", createdAt: NOW - 5 * DAY });
    const fresh = invoice({ id: "fresh", invoiceNumber: "ТФ-0002", createdAt: NOW - DAY, tochkaDocumentId: "doc-2" });
    expect(matchIncoming(payment(), [fresh, old], NOW)).toMatchObject({ kind: "matched", invoice: { id: "old" } });
  });

  it("счёт старше 45 дней и чужие статусы не участвуют", () => {
    expect(matchIncoming(payment(), [invoice({ createdAt: NOW - 46 * DAY })], NOW)).toEqual({ kind: "unmatched" });
    expect(matchIncoming(payment(), [invoice({ status: "cancelled" })], NOW)).toEqual({ kind: "unmatched" });
    expect(matchIncoming(payment(), [invoice({ status: "expired" })], NOW)).toEqual({ kind: "unmatched" });
  });

  it("счёт, который уже закрыл опрос банка, — «уже оплачен», а не тревога", () => {
    const paid = invoice({ status: "paid", paidAt: NOW - 3_600_000, activatedUntil: NOW + 30 * DAY });
    expect(matchIncoming(payment(), [paid], NOW)).toMatchObject({ kind: "already_paid" });
    expect(matchIncoming(payment({ purpose: "ТФ-0001" }), [paid], NOW)).toMatchObject({ kind: "already_paid" });
    // …но только пока оплата свежая.
    const stale = invoice({ status: "paid", paidAt: NOW - RECENT_PAID_MS - 1 });
    expect(matchIncoming(payment(), [stale], NOW)).toEqual({ kind: "unmatched" });
  });

  it("заявки по QR платежом по реквизитам не закрываются", () => {
    const claim = invoice({ method: "sbp_claim", buyerInn: "7707083893", invoiceNumber: null, tochkaDocumentId: null });
    expect(matchIncoming(payment(), [claim], NOW)).toEqual({ kind: "unmatched" });
  });
});

describe("платёж по QR", () => {
  const claim = (over: Partial<PaymentInvoice> = {}) =>
    invoice({ method: "sbp_claim", buyerInn: null, invoiceNumber: null, tochkaDocumentId: null, ...over });
  const sbp = (over: Partial<IncomingPayment> = {}): IncomingPayment => ({ kind: "sbp", ref: "sbp:1", amountKop: 900000, purpose: "", payerInn: null, ...over });

  it("одна заявка на такую сумму — подтверждается", () => {
    const c = claim({ id: "c1" });
    expect(matchIncoming(sbp(), [c], NOW)).toMatchObject({ kind: "matched", by: "sbp_claim", invoice: { id: "c1" } });
  });

  it("две заявки на одну сумму — неоднозначно", () => {
    const result = matchIncoming(sbp(), [claim({ id: "c1" }), claim({ id: "c2", userEmail: "other@x.ru" })], NOW);
    expect(result).toMatchObject({ kind: "ambiguous" });
    expect(result.kind === "ambiguous" && result.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("другая сумма или заявка старше 14 дней — без пары", () => {
    expect(matchIncoming(sbp({ amountKop: 3900000 }), [claim()], NOW)).toEqual({ kind: "unmatched" });
    expect(matchIncoming(sbp(), [claim({ createdAt: NOW - 15 * DAY })], NOW)).toEqual({ kind: "unmatched" });
  });

  it("B2B QR с номером нашего счёта в назначении закрывает счёт", () => {
    const a = invoice({ id: "a" });
    expect(matchIncoming(sbp({ kind: "sbp_b2b", purpose: "Оплата по счету № ТФ-0001. Без НДС" }), [a], NOW)).toMatchObject({
      kind: "matched",
      by: "invoice_number",
    });
  });
});

describe("похоже ли на подписку", () => {
  it("цена тарифа, наш номер или название сервиса", () => {
    expect(looksLikeSubscription({ amountKop: 900000, purpose: "" })).toBe(true);
    expect(looksLikeSubscription({ amountKop: 3900000, purpose: "" })).toBe(true);
    expect(looksLikeSubscription({ amountKop: 123400, purpose: "по счету ТФ-0004" })).toBe(true);
    expect(looksLikeSubscription({ amountKop: 123400, purpose: "Подписка ТендерФит" })).toBe(true);
    expect(looksLikeSubscription({ amountKop: 123400, purpose: "Оплата за работы по договору 5" })).toBe(false);
  });
});
