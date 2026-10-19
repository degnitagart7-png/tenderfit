import { describe, expect, it } from "vitest";

import {
  buildClaimAdminEmail,
  buildPaidAdminEmail,
  buildPaidUserEmail,
  buildUnmatchedAdminEmail,
  confirmPageHtml,
} from "@/domain/paymentEmails";
import type { PaymentInvoice } from "@/domain/payments";

const invoice: PaymentInvoice = {
  id: "i1",
  userEmail: "client@firma.ru",
  plan: "calc",
  amountRub: 39000,
  months: 1,
  status: "paid",
  method: "invoice",
  buyerInn: "7707083893",
  buyerKpp: null,
  buyerName: "ООО <b>«Ромашка»</b>",
  buyerEmail: "buh@romashka.ru",
  invoiceNumber: "ТФ-0001",
  tochkaDocumentId: "d",
  tochkaPaymentRef: "r",
  paidAt: 0,
  activatedUntil: null,
  closingDocumentId: null,
  closingSentAt: null,
  createdAt: 0,
  updatedAt: 0,
};
const UNTIL = Date.parse("2026-11-19T09:00:00Z");

describe("письма об оплате", () => {
  it("клиенту: тема с тарифом и датой, текст и HTML", () => {
    const mail = buildPaidUserEmail({ invoice, activatedUntilMs: UNTIL, baseUrl: "https://tender-fit.ru" });
    expect(mail.subject).toBe("Оплата получена — подписка «Расчёт» активна до 19 ноября 2026");
    expect(mail.text).toContain("Счёт № ТФ-0001 на 39 000 ₽ оплачен");
    expect(mail.text).toContain("https://tender-fit.ru/billing");
    expect(mail.html).toContain("Подписка «Расчёт» активна до");
  });

  it("владельцу: компания, ИНН, тариф, сумма, номер счёта; название из чужих данных экранируется", () => {
    const mail = buildPaidAdminEmail({ invoice, activatedUntilMs: UNTIL, source: "банк: платёж" });
    expect(mail.subject).toBe("Оплачено: ООО <b>«Ромашка»</b> — 39 000 ₽, счёт ТФ-0001");
    expect(mail.text).toMatch(/ИНН: 7707083893/);
    expect(mail.html).not.toContain("<b>«Ромашка»</b>");
    expect(mail.html).toContain("&lt;b&gt;");
  });

  it("не сопоставлен: причина, сумма, назначение и подсказка про grant-access", () => {
    const mail = buildUnmatchedAdminEmail({
      reason: "ambiguous",
      amountRub: 9000,
      purpose: "<script>x</script>",
      payerInn: null,
      payerName: "Иван И.",
      kindLabel: "СБП по QR-коду",
      ref: "sbp:op-1",
      invoices: [{ ...invoice, status: "issued" }],
    });
    expect(mail.subject).toBe("Платёж 9 000 ₽ не сопоставлен — подписка не включена");
    expect(mail.text).toMatch(/несколько заявок/);
    expect(mail.text).toMatch(/grant-access/);
    expect(mail.html).not.toContain("<script>");
  });

  it("заявка по QR: ссылка в тексте и на кнопке", () => {
    const mail = buildClaimAdminEmail({
      claim: { ...invoice, method: "sbp_claim", status: "issued" },
      confirmUrl: "https://tender-fit.ru/api/payments/confirm?token=abc",
      expiresAtMs: UNTIL,
    });
    expect(mail.text).toContain("Подтвердить оплату: https://tender-fit.ru/api/payments/confirm?token=abc");
    expect(mail.html).toContain('href="https://tender-fit.ru/api/payments/confirm?token=abc"');
  });

  it("страница подтверждения экранирует текст", () => {
    expect(confirmPageHtml({ title: "<i>t</i>", message: "m" })).not.toContain("<i>t</i>");
  });
});
