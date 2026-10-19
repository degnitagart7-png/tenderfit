import { describe, expect, it } from "vitest";

import { extendPaidUntil } from "@/domain/subscription";
import { INVOICE_TTL_MS } from "@/domain/payments";
import { activateInvoice, issueClosingDocument } from "@/services/payments/activationService";
import { confirmSecret, signConfirmToken, verifyConfirmToken } from "@/services/payments/confirmToken";
import {
  createInvoice,
  downloadInvoicePdf,
  getOwnInvoice,
  listMyInvoices,
  resendInvoice,
} from "@/services/payments/invoiceService";
import { createFakeBank, createTestKit, T0, type TestKit } from "@/services/payments/paymentTestKit";
import { runPaymentPoll } from "@/services/payments/pollerService";
import { confirmClaimByToken, createSbpClaim } from "@/services/payments/sbpClaimService";
import { handleWebhookPayload, normalizeWebhook } from "@/services/payments/webhookService";
import { TochkaApiError } from "@/services/tochka";

const DAY = 24 * 3_600_000;
const EMAIL = "client@firma.ru";
const buyer = { inn: "7707083893", kpp: "770701001", name: "ООО «Ромашка»", email: "buh@romashka.ru" };

const admins = (kit: TestKit) => kit.mails.filter((m) => m.to === "owner@tender-fit.ru");
const toUser = (kit: TestKit) => kit.mails.filter((m) => m.to === EMAIL);

async function issue(kit: TestKit, planId = "start") {
  const result = await createInvoice(kit.deps, { email: EMAIL, planId, buyer });
  if (!result.ok) throw new Error(result.message);
  return result.invoice;
}

const incomingPayment = (over: Record<string, unknown> = {}, payer: Record<string, unknown> = {}, recipient: Record<string, unknown> = {}) => ({
  webhookType: "incomingPayment",
  customerCode: "304550680",
  paymentId: "pay-1",
  purpose: "Оплата по счету",
  date: "2026-10-20",
  SidePayer: { inn: "7707083893", name: "ООО «Ромашка»", amount: "9000.0", currency: "RUB", ...payer },
  SideRecipient: { account: "40802810000000000001", amount: "9000.0", currency: "RUB", ...recipient },
  ...over,
});

const sbpPayment = (over: Record<string, unknown> = {}) => ({
  webhookType: "incomingSbpPayment",
  customerCode: "304550680",
  operationId: "op-1",
  paymentType: "sbpPayment",
  amount: "9000.00",
  payerName: "Иван Иванович И.",
  payerMobileNumber: "+79990001122",
  purpose: "",
  ...over,
});

/* ------------------------------------- Активация ------------------------------------- */

describe("продление подписки", () => {
  it("считается от большего из «сейчас» и текущего paid_until", () => {
    expect(extendPaidUntil(null, T0, 30)).toBe(T0 + 30 * DAY);
    expect(extendPaidUntil(T0 - DAY, T0, 30)).toBe(T0 + 30 * DAY);
    expect(extendPaidUntil(T0 + 10 * DAY, T0, 30)).toBe(T0 + 40 * DAY);
  });
});

describe("активация по счёту", () => {
  it("включает подписку: срок, тариф, статус, письма клиенту и владельцу", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit, "calc");

    const result = await activateInvoice(kit.deps, invoice.id, "pay-1", "тест");

    expect(result).toMatchObject({ kind: "activated", activatedUntil: T0 + 30 * DAY });
    expect(kit.store.state.users[0]).toMatchObject({ paidUntil: T0 + 30 * DAY, plan: "calc" });
    expect(kit.store.state.invoices[0]).toMatchObject({ status: "paid", tochkaPaymentRef: "pay-1", activatedUntil: T0 + 30 * DAY, paidAt: T0 });
    expect(toUser(kit)).toHaveLength(1);
    expect(toUser(kit)[0]?.message.subject).toMatch(/Оплата получена — подписка «Расчёт» активна до 19 ноября 2026/);
    expect(admins(kit)).toHaveLength(1);
    expect(admins(kit)[0]?.message.subject).toMatch(/Оплачено: ООО «Ромашка» — 39 000 ₽, счёт ТФ-0001/);
  });

  it("продлевает от действующего paid_until: оплата вперёд не сгорает", async () => {
    const kit = createTestKit({ users: [{ id: "u1", email: EMAIL, paidUntil: T0 + 10 * DAY, trialEndsAt: null, plan: "start" }] });
    const invoice = await issue(kit);

    await activateInvoice(kit.deps, invoice.id, "pay-1", "тест");

    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 40 * DAY);
  });

  it("идемпотентность: тот же счёт второй раз ничего не продлевает и не шлёт писем", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);

    await activateInvoice(kit.deps, invoice.id, "pay-1", "тест");
    const mails = kit.mails.length;
    const again = await activateInvoice(kit.deps, invoice.id, "pay-2", "тест");

    expect(again).toEqual({ kind: "already" });
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
    expect(kit.mails).toHaveLength(mails);
  });

  it("один и тот же платёж не включает два счёта", async () => {
    const kit = createTestKit();
    const a = await issue(kit);
    const b = await issue(kit);

    await activateInvoice(kit.deps, a.id, "pay-1", "тест");
    const second = await activateInvoice(kit.deps, b.id, "pay-1", "тест");

    expect(second).toEqual({ kind: "already" });
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
    expect(kit.store.state.invoices[1]?.status).toBe("issued");
  });

  it("срок пользователя изменился между чтением и записью — пересчёт без потери и без двойной выдачи", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);
    // Параллельная ручная выдача успевает между чтением пользователя и записью.
    const original = kit.store.applyActivation.bind(kit.store);
    let raced = false;
    kit.store.applyActivation = async (args) => {
      if (!raced) {
        raced = true;
        const user = kit.store.state.users[0];
        if (user) user.paidUntil = T0 + 5 * DAY;
      }
      return original(args);
    };

    const result = await activateInvoice(kit.deps, invoice.id, "pay-1", "тест");

    expect(result).toMatchObject({ kind: "activated", activatedUntil: T0 + 35 * DAY });
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 35 * DAY);
  });

  it("закрытые и чужие состояния: отменённый счёт, нет пользователя, нет счёта", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);
    kit.store.state.invoices[0]!.status = "cancelled";
    expect(await activateInvoice(kit.deps, invoice.id, "p", "t")).toEqual({ kind: "not_payable", status: "cancelled" });

    const noUser = createTestKit({ users: [] });
    const i2 = await createInvoice(noUser.deps, { email: EMAIL, planId: "start", buyer });
    expect(i2.ok && (await activateInvoice(noUser.deps, i2.invoice.id, "p", "t"))).toEqual({ kind: "no_user" });

    expect(await activateInvoice(kit.deps, "00000000-0000-4000-8000-0000000000ff", "p", "t")).toEqual({ kind: "not_found" });
  });

  it("просроченный счёт, оплаченный поздно, всё же включается: деньги настоящие", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);
    kit.store.state.invoices[0]!.status = "expired";
    expect((await activateInvoice(kit.deps, invoice.id, "late", "t")).kind).toBe("activated");
  });
});

describe("закрывающий акт", () => {
  it("после оплаты создаётся и уходит на почту плательщика", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);

    await activateInvoice(kit.deps, invoice.id, "pay-1", "тест");

    expect(kit.bank.calls.map((c) => c.method)).toEqual(expect.arrayContaining(["createAct", "sendClosingToEmail"]));
    expect(kit.bank.calls.find((c) => c.method === "sendClosingToEmail")?.args).toEqual(["act-0001", "buh@romashka.ru"]);
    expect(kit.store.state.invoices[0]).toMatchObject({ closingDocumentId: "act-0001", closingSentAt: T0 });
  });

  it("сбой акта подписку не откатывает: журнал и письмо владельцу", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);
    kit.bank.failNext.createAct = new TochkaApiError("Банк не принял данные (схема акта)", 400);

    const result = await activateInvoice(kit.deps, invoice.id, "pay-1", "тест");

    expect(result.kind).toBe("activated");
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
    expect(kit.store.state.invoices[0]?.status).toBe("paid");
    expect(kit.logs.join("\n")).toMatch(/не удалось создать акт/);
    expect(admins(kit).some((m) => /создать акт не удалось/.test(m.message.subject))).toBe(true);
  });

  it("акт создан, письмо не ушло: идентификатор сохранён, повтор не создаёт второй акт", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);
    kit.bank.failNext.sendClosingToEmail = new TochkaApiError("Банк временно недоступен", 503);
    await activateInvoice(kit.deps, invoice.id, "pay-1", "тест");
    expect(kit.store.state.invoices[0]).toMatchObject({ closingDocumentId: "act-0001", closingSentAt: null });

    await issueClosingDocument(kit.deps, { ...kit.store.state.invoices[0]! });

    expect(kit.bank.calls.filter((c) => c.method === "createAct")).toHaveLength(1);
    expect(kit.bank.calls.filter((c) => c.method === "sendClosingToEmail")).toHaveLength(2);
    expect(kit.store.state.invoices[0]?.closingSentAt).toBe(T0);
  });

  it("TOCHKA_CLOSING_DOCS=0 и заявки по QR актов не создают", async () => {
    const bank = createFakeBank({ ...createFakeBank().config, closingDocs: false });
    const kit = createTestKit({ bank });
    const invoice = await issue(kit);
    await activateInvoice(kit.deps, invoice.id, "pay-1", "тест");
    expect(bank.calls.some((c) => c.method === "createAct")).toBe(false);

    const kit2 = createTestKit();
    const claim = await createSbpClaim(kit2.deps, { email: EMAIL, planId: "start" });
    expect(claim.ok && (await activateInvoice(kit2.deps, claim.claim.id, "manual:x", "t")).kind).toBe("activated");
    expect(kit2.bank.calls.some((c) => c.method === "createAct")).toBe(false);
  });
});

/* ------------------------------------- Счета ------------------------------------- */

describe("выставление счёта", () => {
  it("номер из последовательности, документ в банке, письмо покупателю", async () => {
    const kit = createTestKit();

    const result = await createInvoice(kit.deps, { email: EMAIL, planId: "calc", buyer });

    expect(result).toMatchObject({ ok: true, emailSent: true, invoice: { invoiceNumber: "ТФ-0001", amountRub: 39000, plan: "calc", status: "issued", buyerInn: "7707083893" } });
    const bankCall = kit.bank.calls.find((c) => c.method === "createInvoice")?.args[0] as { number: string; amountRub: number; expiresAtMs: number };
    expect(bankCall).toMatchObject({ number: "ТФ-0001", amountRub: 39000, expiresAtMs: T0 + INVOICE_TTL_MS });
    expect(kit.bank.calls.find((c) => c.method === "sendInvoiceToEmail")?.args).toEqual([expect.any(String), "buh@romashka.ru"]);
    expect(kit.store.state.invoices[0]?.tochkaDocumentId).toBe(result.ok ? result.invoice.tochkaDocumentId : null);

    const second = await createInvoice(kit.deps, { email: EMAIL, planId: "start", buyer });
    expect(second.ok && second.invoice.invoiceNumber).toBe("ТФ-0002");
  });

  it("проверяет тариф и покупателя до обращения к банку", async () => {
    const kit = createTestKit();
    expect(await createInvoice(kit.deps, { email: EMAIL, planId: "premium", buyer })).toMatchObject({ ok: false, code: "invalid_plan" });
    expect(await createInvoice(kit.deps, { email: EMAIL, planId: "start", months: 99, buyer })).toMatchObject({ ok: false, code: "invalid_plan" });
    expect(await createInvoice(kit.deps, { email: EMAIL, planId: "start", buyer: { ...buyer, inn: "7707083894" } })).toMatchObject({
      ok: false,
      code: "invalid_buyer",
      field: "inn",
    });
    expect(kit.bank.calls).toHaveLength(0);
    expect(kit.store.state.invoices).toHaveLength(0);
  });

  it("банк не настроен — понятный отказ без строки в базе", async () => {
    const kit = createTestKit({ bank: null });
    expect(await createInvoice(kit.deps, { email: EMAIL, planId: "start", buyer })).toMatchObject({ ok: false, code: "not_configured" });
    expect(kit.store.state.invoices).toHaveLength(0);
  });

  it("банк отказал: строка отменяется, клиенту — причина; чужой текст ошибки не раскрывается", async () => {
    const kit = createTestKit();
    kit.bank.failNext.createInvoice = new TochkaApiError("Банк не принял данные (taxCode)", 400);
    const rejected = await createInvoice(kit.deps, { email: EMAIL, planId: "start", buyer });
    expect(rejected).toMatchObject({ ok: false, code: "bank_error" });
    expect(rejected.ok === false && rejected.message).toMatch(/Проверьте ИНН, КПП и название/);
    expect(kit.store.state.invoices[0]?.status).toBe("cancelled");
    expect(await listMyInvoices(kit.deps, EMAIL)).toHaveLength(0);

    kit.bank.failNext.createInvoice = new TochkaApiError("Банк временно недоступен (код 503)", 503, { transient: true });
    const down = await createInvoice(kit.deps, { email: EMAIL, planId: "start", buyer });
    expect(down.ok === false && down.message).toMatch(/банк сейчас не отвечает/);
  });

  it("письмо не ушло — счёт всё равно выставлен", async () => {
    const kit = createTestKit();
    kit.bank.failNext.sendInvoiceToEmail = new TochkaApiError("Банк не отправил документ на почту", 200);
    const result = await createInvoice(kit.deps, { email: EMAIL, planId: "start", buyer });
    expect(result).toMatchObject({ ok: true, emailSent: false });
  });

  it("не больше десяти неоплаченных счетов на человека", async () => {
    const kit = createTestKit();
    for (let i = 0; i < 10; i += 1) await issue(kit);
    expect(await createInvoice(kit.deps, { email: EMAIL, planId: "start", buyer })).toMatchObject({ ok: false, code: "too_many_open" });
  });
});

describe("чужие счета, PDF и повторная отправка", () => {
  it("чужой счёт неотличим от несуществующего; администратор видит любой", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);

    expect(await getOwnInvoice(kit.deps, invoice.id, "intruder@x.ru", false)).toEqual({ ok: false, status: 404, message: "Счёт не найден" });
    expect(await getOwnInvoice(kit.deps, "00000000-0000-4000-8000-0000000000ff", EMAIL, false)).toMatchObject({ ok: false, status: 404 });
    expect(await getOwnInvoice(kit.deps, "../etc/passwd", EMAIL, false)).toMatchObject({ ok: false, status: 404 });
    expect(await getOwnInvoice(kit.deps, invoice.id, "OWNER@x.ru", true)).toMatchObject({ ok: true });
    expect(await getOwnInvoice(kit.deps, invoice.id, EMAIL.toUpperCase(), false)).toMatchObject({ ok: true });
  });

  it("заявка по QR как счёт не открывается", async () => {
    const kit = createTestKit();
    const claim = await createSbpClaim(kit.deps, { email: EMAIL, planId: "start" });
    expect(claim.ok && (await getOwnInvoice(kit.deps, claim.claim.id, EMAIL, false))).toMatchObject({ ok: false, status: 404 });
  });

  it("PDF берётся из банка по documentId счёта; имя файла безопасное", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);
    const file = await downloadInvoicePdf(kit.deps, invoice);
    expect(file).toMatchObject({ ok: true, contentType: "application/pdf", filename: "Счёт-ТФ-0001.pdf" });
    kit.bank.getInvoicePdf = async () => {
      throw new TochkaApiError("Банк временно недоступен", 503);
    };
    expect(await downloadInvoicePdf(kit.deps, invoice)).toMatchObject({ ok: false, status: 502 });
  });

  it("повторная отправка: на почту счёта или на указанную; закрытый счёт не отправляется", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);
    expect(await resendInvoice(kit.deps, invoice, null)).toEqual({ ok: true, sentTo: "buh@romashka.ru" });
    expect(await resendInvoice(kit.deps, invoice, " Other@Firma.ru ")).toEqual({ ok: true, sentTo: "other@firma.ru" });
    expect(await resendInvoice(kit.deps, invoice, "не почта")).toMatchObject({ ok: false, status: 400 });
    expect(await resendInvoice(kit.deps, { ...invoice, status: "paid" }, null)).toMatchObject({ ok: false, status: 409 });
  });
});

/* ------------------------------------- Вебхуки ------------------------------------- */

describe("разбор вебхука", () => {
  it("incomingPayment: сумма из SideRecipient, плательщик — ИНН и название; ref по paymentId", () => {
    const result = normalizeWebhook(incomingPayment(), "tok", {});
    expect(result).toMatchObject({
      kind: "incoming",
      event: { ref: "payment:pay-1", kind: "payment", amountRub: 9000, payerInn: "7707083893", payerName: "ООО «Ромашка»" },
    });
  });

  it("incomingSbpPayment: телефон плательщика в журнал не попадает", () => {
    const result = normalizeWebhook(sbpPayment(), "tok", {});
    expect(result).toMatchObject({ kind: "incoming", event: { ref: "sbp:op-1", kind: "sbp", amountRub: 9000 } });
    expect(JSON.stringify(result)).not.toContain("+7999");
  });

  it("incomingSbpB2BPayment: ключ — хэш токена, одинаковый при повторной доставке", () => {
    const body = { webhookType: "incomingSbpB2BPayment", qrcId: "AS1", amount: "39000.00", purpose: "Оплата по счету" };
    const a = normalizeWebhook(body, "same-token", {});
    const b = normalizeWebhook(body, "same-token", {});
    const c = normalizeWebhook(body, "other-token", {});
    expect(a.kind === "incoming" && a.event.ref).toMatch(/^b2b:[0-9a-f]{64}$/);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("платёж на другой счёт, не в рублях, без суммы и чужие события игнорируются", () => {
    const env = { TOCHKA_JWT: "j", TOCHKA_CUSTOMER_CODE: "1", TOCHKA_ACCOUNT_ID: "40802810000000000001/044525104" };
    expect(normalizeWebhook(incomingPayment({}, {}, { account: "40802810999999999999" }), "t", env)).toMatchObject({ kind: "ignore", reason: "платёж на другой счёт" });
    expect(normalizeWebhook(incomingPayment({}, {}, { account: "40802810000000000001" }), "t", env).kind).toBe("incoming");
    expect(normalizeWebhook(incomingPayment({}, { currency: "USD" }, { currency: "USD" }), "t", {}).kind).toBe("ignore");
    expect(normalizeWebhook(sbpPayment({ amount: "" }), "t", {}).kind).toBe("ignore");
    expect(normalizeWebhook({ webhookType: "outgoingPayment" }, "t", {}).kind).toBe("ignore");
    expect(normalizeWebhook({}, "t", {}).kind).toBe("ignore");
  });
});

describe("вебхук → подписка", () => {
  it("платёж по реквизитам: ИНН + сумма включают счёт, событие закрывается", async () => {
    const kit = createTestKit();
    await issue(kit);

    const result = await handleWebhookPayload(kit.deps, incomingPayment(), "tok");

    expect(result).toEqual({ status: "processed", outcome: "activated" });
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
    expect(kit.store.state.invoices[0]).toMatchObject({ status: "paid", tochkaPaymentRef: "payment:pay-1" });
    expect(kit.store.state.events[0]).toMatchObject({ outcome: "activated", matchedInvoiceId: kit.store.state.invoices[0]?.id });
  });

  it("повторная доставка того же платежа не включает подписку второй раз", async () => {
    const kit = createTestKit();
    await issue(kit);
    await handleWebhookPayload(kit.deps, incomingPayment(), "tok");
    const mails = kit.mails.length;

    const again = await handleWebhookPayload(kit.deps, incomingPayment(), "tok");

    expect(again).toEqual({ status: "duplicate" });
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
    expect(kit.mails).toHaveLength(mails);
  });

  it("новый платёж на уже оплаченный счёт (после опроса банка) — «уже оплачен», без тревоги владельцу", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);
    kit.bank.statuses.set(invoice.tochkaDocumentId ?? "", "payment_paid");
    await runPaymentPoll(kit.deps);
    const mails = kit.mails.length;

    const result = await handleWebhookPayload(kit.deps, incomingPayment({ paymentId: "late-webhook" }), "tok");

    expect(result).toEqual({ status: "processed", outcome: "already_paid" });
    expect(kit.mails).toHaveLength(mails);
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
  });

  it("сумма не совпала с найденным по номеру счётом — владельцу письмо, подписка не включена", async () => {
    const kit = createTestKit();
    await issue(kit);

    const result = await handleWebhookPayload(
      kit.deps,
      incomingPayment({ purpose: "Оплата по счету ТФ-0001" }, { amount: "8000.0" }, { amount: "8000.0" }),
      "tok",
    );

    expect(result).toEqual({ status: "processed", outcome: "amount_mismatch" });
    expect(kit.store.state.users[0]?.paidUntil).toBeNull();
    expect(admins(kit)[0]?.message.subject).toMatch(/не сопоставлен/);
    expect(admins(kit)[0]?.message.text).toMatch(/недоплата или переплата/);
  });

  it("платёж без пары, похожий на подписку, — письмо владельцу; посторонние деньги — молча", async () => {
    const kit = createTestKit();

    const like = await handleWebhookPayload(kit.deps, incomingPayment({ paymentId: "p-a", purpose: "Оплата по счету ТФ-0042" }, { inn: "7728168971" }), "t1");
    expect(like).toEqual({ status: "processed", outcome: "unmatched" });
    expect(admins(kit)).toHaveLength(1);

    const noise = await handleWebhookPayload(
      kit.deps,
      incomingPayment({ paymentId: "p-b", purpose: "Оплата за работы" }, { amount: "1234.0" }, { amount: "1234.0" }),
      "t2",
    );
    expect(noise).toEqual({ status: "processed", outcome: "ignored" });
    expect(admins(kit)).toHaveLength(1);
  });

  it("СБП по QR с заявкой на ту же сумму включает подписку автоматически", async () => {
    const kit = createTestKit();
    const claim = await createSbpClaim(kit.deps, { email: EMAIL, planId: "start" });
    expect(claim.ok && claim.confirmed).toBe(false);

    const result = await handleWebhookPayload(kit.deps, sbpPayment(), "tok");

    expect(result).toEqual({ status: "processed", outcome: "activated" });
    expect(kit.store.state.users[0]).toMatchObject({ paidUntil: T0 + 30 * DAY, plan: "start" });
    expect(kit.store.state.invoices[0]).toMatchObject({ method: "sbp_claim", status: "paid", tochkaPaymentRef: "sbp:op-1" });
  });

  it("две заявки на одну сумму — автоматически не выбираем, владелец получает письмо", async () => {
    const kit = createTestKit({
      users: [
        { id: "u1", email: EMAIL, paidUntil: null, trialEndsAt: null, plan: null },
        { id: "u2", email: "other@firma.ru", paidUntil: null, trialEndsAt: null, plan: null },
      ],
    });
    await createSbpClaim(kit.deps, { email: EMAIL, planId: "start" });
    await createSbpClaim(kit.deps, { email: "other@firma.ru", planId: "start" });

    const result = await handleWebhookPayload(kit.deps, sbpPayment(), "tok");

    expect(result).toEqual({ status: "processed", outcome: "ambiguous" });
    expect(kit.store.state.users.every((u) => u.paidUntil === null)).toBe(true);
    expect(admins(kit).some((m) => /не сопоставлен/.test(m.message.subject))).toBe(true);
  });

  it("платёж по QR пришёл РАНЬШЕ заявки: заявка подхватывает его и включает подписку сразу", async () => {
    const kit = createTestKit();
    expect(await handleWebhookPayload(kit.deps, sbpPayment(), "tok")).toEqual({ status: "processed", outcome: "unmatched" });
    kit.setNow(T0 + 10 * 60_000);

    const claim = await createSbpClaim(kit.deps, { email: EMAIL, planId: "start" });

    expect(claim).toMatchObject({ ok: true, confirmed: true });
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 10 * 60_000 + 30 * DAY);
    expect(kit.store.state.events[0]).toMatchObject({ outcome: "activated" });
    // Ссылки подтверждения владельцу не рассылалось: деньги уже опознаны.
    expect(admins(kit).some((m) => /Заявка на оплату по QR/.test(m.message.subject))).toBe(false);
  });

  it("ранний платёж старше суток или двое таких платежей заявку не закрывают", async () => {
    const old = createTestKit();
    await handleWebhookPayload(old.deps, sbpPayment(), "tok");
    old.setNow(T0 + 25 * 3_600_000);
    expect(await createSbpClaim(old.deps, { email: EMAIL, planId: "start" })).toMatchObject({ ok: true, confirmed: false });

    const two = createTestKit();
    await handleWebhookPayload(two.deps, sbpPayment(), "t1");
    await handleWebhookPayload(two.deps, sbpPayment({ operationId: "op-2" }), "t2");
    expect(await createSbpClaim(two.deps, { email: EMAIL, planId: "start" })).toMatchObject({ ok: true, confirmed: false });
    expect(two.store.state.users[0]?.paidUntil).toBeNull();
  });

  it("запись события не удалась (база недоступна) — исключение: ручка ответит не-200, банк повторит", async () => {
    const kit = createTestKit();
    kit.store.recordEvent = async () => {
      throw new Error("база недоступна");
    };
    await expect(handleWebhookPayload(kit.deps, sbpPayment(), "tok")).rejects.toThrow(/база недоступна/);
  });

  it("сбой разбора после записи: событие остаётся необработанным, воркер разберёт его заново", async () => {
    const kit = createTestKit();
    await issue(kit);
    const original = kit.store.listForMatching.bind(kit.store);
    kit.store.listForMatching = async () => {
      throw new Error("таймаут базы");
    };

    const first = await handleWebhookPayload(kit.deps, incomingPayment(), "tok");
    expect(first).toMatchObject({ status: "deferred" });
    expect(kit.store.state.events[0]?.processedAt).toBeNull();
    expect(kit.store.state.users[0]?.paidUntil).toBeNull();

    kit.store.listForMatching = original;
    kit.setNow(T0 + 120_000);
    const poll = await runPaymentPoll(kit.deps);

    expect(poll.reprocessed).toBe(1);
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 120_000 + 30 * DAY);
    expect(kit.store.state.events[0]).toMatchObject({ outcome: "activated" });
  });
});

/* ------------------------------------- Опрос ------------------------------------- */

describe("опрос банка воркером", () => {
  it("payment_paid включает подписку тем же путём, повторный прогон ничего не меняет", async () => {
    const kit = createTestKit();
    const invoice = await issue(kit);
    await runPaymentPoll(kit.deps);
    expect(kit.store.state.users[0]?.paidUntil).toBeNull();

    kit.bank.statuses.set(invoice.tochkaDocumentId ?? "", "payment_paid");
    const result = await runPaymentPoll(kit.deps);

    expect(result).toMatchObject({ checked: 1, activated: 1, errors: 0 });
    expect(kit.store.state.invoices[0]).toMatchObject({ status: "paid", tochkaPaymentRef: `status:${invoice.tochkaDocumentId}` });
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);

    const again = await runPaymentPoll(kit.deps);
    expect(again.checked).toBe(0);
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
  });

  it("счёт старше 45 дней не опрашивается, а помечается просроченным; заявка по QR — через 14", async () => {
    const kit = createTestKit();
    await issue(kit);
    await createSbpClaim(kit.deps, { email: EMAIL, planId: "calc" });
    kit.setNow(T0 + 15 * DAY);
    const mid = await runPaymentPoll(kit.deps);
    expect(mid.expired).toBe(1);
    expect(kit.store.state.invoices.map((i) => i.status)).toEqual(["issued", "expired"]);

    kit.setNow(T0 + 46 * DAY);
    const late = await runPaymentPoll(kit.deps);
    expect(late.expired).toBe(1);
    expect(late.checked).toBe(0);
    expect(kit.store.state.invoices.map((i) => i.status)).toEqual(["expired", "expired"]);
  });

  it("payment_expired в банке помечает счёт просроченным; 404 — отменённым; сбой по одному счёту остальные не останавливает", async () => {
    const kit = createTestKit();
    const a = await issue(kit);
    const b = await issue(kit);
    const c = await issue(kit);
    kit.bank.statuses.set(a.tochkaDocumentId ?? "", "payment_expired");
    const original = kit.bank.getInvoicePaymentStatus.bind(kit.bank);
    kit.bank.getInvoicePaymentStatus = async (id) => {
      if (id === b.tochkaDocumentId) throw new TochkaApiError("Банк не нашёл объект", 404);
      if (id === c.tochkaDocumentId) throw new TochkaApiError("Банк временно недоступен", 503);
      return original(id);
    };

    const result = await runPaymentPoll(kit.deps);

    expect(result).toMatchObject({ checked: 3, expired: 1, cancelled: 1, errors: 1 });
    expect(kit.store.state.invoices.map((i) => i.status)).toEqual(["expired", "cancelled", "issued"]);
  });

  it("банк не настроен: только отметка просроченных", async () => {
    const kit = createTestKit({ bank: null });
    const result = await runPaymentPoll(kit.deps);
    expect(result).toMatchObject({ skipped: true, checked: 0 });
  });
});

/* ------------------------------------- Заявка по QR ------------------------------------- */

describe("заявка «Я оплатил»", () => {
  it("создаётся без доступа, владельцу уходит письмо с подписанной ссылкой", async () => {
    const kit = createTestKit();

    const result = await createSbpClaim(kit.deps, { email: EMAIL, planId: "calc" });

    expect(result).toMatchObject({ ok: true, confirmed: false, claim: { method: "sbp_claim", amountRub: 39000, status: "issued" } });
    expect(kit.store.state.users[0]?.paidUntil).toBeNull();
    const mail = admins(kit)[0]?.message;
    expect(mail?.subject).toMatch(/Заявка на оплату по QR: client@firma.ru — 39 000 ₽/);
    const url = /https:\/\/tender-fit\.ru\/api\/payments\/confirm\?token=([^\s"<]+)/.exec(mail?.text ?? "");
    expect(url).not.toBeNull();
    const secret = confirmSecret(kit.deps.env) ?? "";
    expect(verifyConfirmToken(decodeURIComponent(url?.[1] ?? ""), T0, secret)).toMatchObject({ ok: true, claimId: result.ok ? result.claim.id : "" });
  });

  it("повторное нажатие возвращает ту же заявку и не пишет владельцу снова", async () => {
    const kit = createTestKit();
    const a = await createSbpClaim(kit.deps, { email: EMAIL, planId: "start" });
    const b = await createSbpClaim(kit.deps, { email: EMAIL, planId: "start" });
    expect(a.ok && b.ok && a.claim.id === b.claim.id).toBe(true);
    expect(kit.store.state.invoices).toHaveLength(1);
    expect(admins(kit)).toHaveLength(1);
  });

  it("«Премиум» и отсутствие секрета подтверждения — отказ", async () => {
    const kit = createTestKit();
    expect(await createSbpClaim(kit.deps, { email: EMAIL, planId: "premium" })).toMatchObject({ ok: false, code: "invalid_plan" });
    const noSecret = createTestKit({ env: { PAYMENT_CONFIRM_SECRET: "short" } });
    expect(await createSbpClaim(noSecret.deps, { email: EMAIL, planId: "start" })).toMatchObject({ ok: false, code: "not_configured" });
    expect(noSecret.store.state.invoices).toHaveLength(0);
  });

  it("подтверждение по ссылке: включает подписку, второй раз — «уже подтверждено»", async () => {
    const kit = createTestKit();
    const claim = await createSbpClaim(kit.deps, { email: EMAIL, planId: "start" });
    const secret = confirmSecret(kit.deps.env) ?? "";
    const { token } = signConfirmToken(claim.ok ? claim.claim.id : "", T0, secret);

    const first = await confirmClaimByToken(kit.deps, token, "owner@tender-fit.ru");
    const second = await confirmClaimByToken(kit.deps, token, "owner@tender-fit.ru");

    expect(first).toMatchObject({ kind: "confirmed", activatedUntil: T0 + 30 * DAY });
    expect(second).toEqual({ kind: "already" });
    expect(kit.store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
    expect(admins(kit).some((m) => /подтверждено владельцем \(owner@tender-fit.ru\)/.test(m.message.text))).toBe(true);
  });

  it("плохая и просроченная ссылка, чужая подпись, не заявка", async () => {
    const kit = createTestKit();
    const claim = await createSbpClaim(kit.deps, { email: EMAIL, planId: "start" });
    const id = claim.ok ? claim.claim.id : "";
    const secret = confirmSecret(kit.deps.env) ?? "";

    expect(await confirmClaimByToken(kit.deps, "мусор", "o")).toEqual({ kind: "invalid" });
    expect(await confirmClaimByToken(kit.deps, signConfirmToken(id, T0, "another-secret-0123456789").token, "o")).toEqual({ kind: "invalid" });
    kit.setNow(T0 + 15 * DAY);
    expect(await confirmClaimByToken(kit.deps, signConfirmToken(id, T0, secret).token, "o")).toEqual({ kind: "expired" });
    kit.setNow(T0);

    const invoice = await issue(kit);
    expect(await confirmClaimByToken(kit.deps, signConfirmToken(invoice.id, T0, secret).token, "o")).toEqual({ kind: "not_found" });
    expect(kit.store.state.users[0]?.paidUntil).toBeNull();
  });
});

describe("токен подтверждения", () => {
  const secret = "test-secret-0123456789";
  const id = "00000000-0000-4000-8000-000000000001";

  it("подпись и срок: 14 дней, любая правка ломает подпись", () => {
    const { token, expiresAtMs } = signConfirmToken(id, T0, secret);
    expect(expiresAtMs).toBe(T0 + 14 * DAY);
    expect(verifyConfirmToken(token, T0 + 14 * DAY, secret)).toMatchObject({ ok: true, claimId: id });
    expect(verifyConfirmToken(token, T0 + 14 * DAY + 1, secret)).toEqual({ ok: false, reason: "expired" });

    const [claim, , sig] = token.split(".") as [string, string, string];
    expect(verifyConfirmToken(`${claim}.${String(expiresAtMs + DAY)}.${sig}`, T0, secret)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyConfirmToken(`00000000-0000-4000-8000-000000000002.${String(expiresAtMs)}.${sig}`, T0, secret)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyConfirmToken(token, T0, "wrong-secret-0123456789")).toEqual({ ok: false, reason: "invalid" });
  });

  it("секрет короче 16 знаков считается незаданным", () => {
    expect(confirmSecret({ PAYMENT_CONFIRM_SECRET: "short" })).toBeNull();
    expect(confirmSecret({})).toBeNull();
    expect(confirmSecret({ PAYMENT_CONFIRM_SECRET: " 0123456789abcdef " })).toBe("0123456789abcdef");
  });
});
