import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestKit, T0, type TestKit } from "@/services/payments/paymentTestKit";
import { createWebhookVerifier } from "@/services/tochka/webhookVerify";

const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
const state = vi.hoisted(() => ({ kit: null as TestKit | null, verifier: null as unknown }));

vi.mock("@/services/authRuntime", () => ({ SESSION_COOKIE: "tf_session", getAuthService: () => auth }));
vi.mock("@/services/payments/deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/payments/deps")>()),
  defaultPaymentDeps: () => (state.kit as TestKit).deps,
}));
vi.mock("@/services/payments/webhookRuntime", () => ({ getWebhookVerifier: () => state.verifier }));

import { GET as listInvoices, POST as createInvoiceRoute } from "@/app/api/payments/invoices/route";
import { GET as getPdf } from "@/app/api/payments/invoices/[id]/pdf/route";
import { POST as resendRoute } from "@/app/api/payments/invoices/[id]/send/route";
import { POST as claimRoute } from "@/app/api/payments/sbp-claim/route";
import { GET as confirmRoute } from "@/app/api/payments/confirm/route";
import { POST as webhookRoute } from "@/app/api/payments/tochka/webhook/route";
import { signConfirmToken } from "@/services/payments/confirmToken";

/**
 * Ручки оплаты: сессия, владелец счёта, доступ человека с закончившимся пробным периодом,
 * вебхук с настоящей проверкой подписи (ключи RSA — свои), подтверждение по ссылке владельцем.
 */

const DAY = 24 * 3_600_000;
// Лимиты ручек живут в памяти модуля и общие для всех тестов файла: у каждого теста свой клиент.
let EMAIL = "client0@firma.ru";
let counter = 0;
const OWNER = "owner@tender-fit.ru";
const buyerBody = { planId: "start", inn: "7707083893", kpp: "770701001", name: "ООО «Ромашка»", email: "buh@romashka.ru" };

const expiredAccess = { trialEndsAt: Date.now() - DAY, paidUntil: null, plan: null };
const signedIn = (email: string, access: unknown = expiredAccess) => auth.getUser.mockResolvedValue({ id: "u1", email, access });

let ip = 0;
function req(path: string, init: { method?: string; body?: unknown; text?: string; headers?: Record<string, string> } = {}): NextRequest {
  ip += 1;
  return new NextRequest(`https://tender-fit.ru${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: "tf_session=tok", "x-real-ip": `10.9.0.${String(ip)}`, ...(init.headers ?? {}) },
    ...(init.text !== undefined ? { body: init.text } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const ctx = (id: string) => ({ params: { id } });

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", OWNER);
  counter += 1;
  EMAIL = `client${String(counter)}@firma.ru`;
  state.kit = createTestKit({
    users: [
      { id: "u1", email: EMAIL, paidUntil: null, trialEndsAt: null, plan: null },
      { id: "u2", email: "other@firma.ru", paidUntil: null, trialEndsAt: null, plan: null },
    ],
  });
  auth.getUser.mockReset();
  auth.getUser.mockResolvedValue(null);
});

describe("доступ к ручкам счетов", () => {
  it("без сессии — 401 везде", async () => {
    expect((await listInvoices(req("/api/payments/invoices"))).status).toBe(401);
    expect((await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: buyerBody }))).status).toBe(401);
    expect((await getPdf(req("/api/payments/invoices/x/pdf"), ctx("x"))).status).toBe(401);
    expect((await resendRoute(req("/api/payments/invoices/x/send", { method: "POST" }), ctx("x"))).status).toBe(401);
    expect((await claimRoute(req("/api/payments/sbp-claim", { method: "POST", body: { planId: "start" } }))).status).toBe(401);
  });

  it("человек с закончившимся пробным периодом выставляет счёт и видит свои счета (не 402)", async () => {
    signedIn(EMAIL);

    const created = await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: buyerBody }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body).toMatchObject({ emailSent: true, invoice: { invoiceNumber: "ТФ-0001", amountRub: 9000, status: "issued", hasPdf: true } });
    expect(JSON.stringify(body)).not.toContain("tochka");

    const list = await (await listInvoices(req("/api/payments/invoices"))).json();
    expect(list.billingReady).toBe(true);
    expect(list.invoices).toHaveLength(1);
  });

  it("ошибка в реквизитах — 400 с названием поля и русским текстом", async () => {
    signedIn(EMAIL);
    const response = await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: { ...buyerBody, inn: "7707083894" } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_buyer", field: "inn", error: expect.stringContaining("ИНН") });
    expect((await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: { planId: "start" } }))).status).toBe(400);
  });

  it("«Премиум» онлайн не выставляется", async () => {
    signedIn(EMAIL);
    const response = await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: { ...buyerBody, planId: "premium" } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_plan" });
  });

  it("не больше пяти счетов в час на человека", async () => {
    signedIn("spammer@firma.ru");
    state.kit?.store.state.users.push({ id: "u9", email: "spammer@firma.ru", paidUntil: null, trialEndsAt: null, plan: null });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: buyerBody }))).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("банк недоступен — 502 с понятным текстом, а в списке счёта нет", async () => {
    signedIn(EMAIL);
    const { TochkaApiError } = await import("@/services/tochka");
    (state.kit as TestKit).bank.failNext.createInvoice = new TochkaApiError("Банк временно недоступен", 503, { transient: true });
    const response = await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: buyerBody }));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/банк сейчас не отвечает/);
    const list = await (await listInvoices(req("/api/payments/invoices"))).json();
    expect(list.invoices).toHaveLength(0);
  });

  it("банк не настроен: список отдаёт billingReady=false (на экране остаётся письмо), выставление — 503", async () => {
    state.kit = createTestKit({ bank: null });
    signedIn(EMAIL);
    expect((await (await listInvoices(req("/api/payments/invoices"))).json()).billingReady).toBe(false);
    expect((await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: buyerBody }))).status).toBe(503);
  });

  it("список: чужие счета не видны, ?scope=all — только администратору", async () => {
    signedIn(EMAIL);
    await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: buyerBody }));

    signedIn("other@firma.ru");
    expect((await (await listInvoices(req("/api/payments/invoices"))).json()).invoices).toHaveLength(0);
    expect((await listInvoices(req("/api/payments/invoices?scope=all"))).status).toBe(403);

    signedIn(OWNER);
    const all = await (await listInvoices(req("/api/payments/invoices?scope=all"))).json();
    expect(all.invoices).toHaveLength(1);
    expect(all.invoices[0].userEmail).toBe(EMAIL);
  });
});

describe("PDF и повторная отправка", () => {
  async function ownInvoice(): Promise<string> {
    signedIn(EMAIL);
    const created = await (await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: buyerBody }))).json();
    return created.invoice.id as string;
  }

  it("владелец скачивает PDF; заголовки файла и запрет кэша", async () => {
    const id = await ownInvoice();
    const response = await getPdf(req(`/api/payments/invoices/${id}/pdf`), ctx(id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(decodeURIComponent(response.headers.get("content-disposition") ?? "")).toContain("Счёт-ТФ-0001.pdf");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toContain("%PDF");
  });

  it("чужой PDF и чужая повторная отправка — 404, банк не вызывается", async () => {
    const id = await ownInvoice();
    const callsBefore = (state.kit as TestKit).bank.calls.length;

    signedIn("other@firma.ru");
    expect((await getPdf(req(`/api/payments/invoices/${id}/pdf`), ctx(id))).status).toBe(404);
    expect((await resendRoute(req(`/api/payments/invoices/${id}/send`, { method: "POST" }), ctx(id))).status).toBe(404);
    expect((state.kit as TestKit).bank.calls).toHaveLength(callsBefore);

    // Администратору чужой счёт открыт.
    signedIn(OWNER);
    expect((await getPdf(req(`/api/payments/invoices/${id}/pdf`), ctx(id))).status).toBe(200);
  });

  it("повторная отправка своего счёта на указанную почту", async () => {
    const id = await ownInvoice();
    const response = await resendRoute(req(`/api/payments/invoices/${id}/send`, { method: "POST", body: { email: "boss@firma.ru" } }), ctx(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true, sentTo: "boss@firma.ru" });
    expect((state.kit as TestKit).bank.calls.at(-1)).toMatchObject({ method: "sendInvoiceToEmail", args: [expect.any(String), "boss@firma.ru"] });
  });
});

describe("POST /api/payments/sbp-claim", () => {
  it("заявка создаётся (в том числе без действующего доступа), подписка не включается", async () => {
    signedIn(EMAIL);
    const response = await claimRoute(req("/api/payments/sbp-claim", { method: "POST", body: { planId: "calc" } }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ confirmed: false, claim: { method: "sbp_claim", amountRub: 39000, status: "issued" } });
    expect((state.kit as TestKit).store.state.users[0]?.paidUntil).toBeNull();
  });

  it("без тарифа — 400, «Премиум» — 400", async () => {
    signedIn(EMAIL);
    expect((await claimRoute(req("/api/payments/sbp-claim", { method: "POST", body: {} }))).status).toBe(400);
    expect((await claimRoute(req("/api/payments/sbp-claim", { method: "POST", body: { planId: "premium" } }))).status).toBe(400);
  });
});

/* ------------------------------------- Вебхук ------------------------------------- */

const b64u = (value: string | Buffer): string => Buffer.from(value).toString("base64url");
function sign(payload: unknown, key: KeyObject): string {
  const input = `${b64u(JSON.stringify({ typ: "JWT", alg: "RS256" }))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${b64u(createSign("RSA-SHA256").update(input).sign(key))}`;
}

describe("POST /api/payments/tochka/webhook", () => {
  const bank = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const payment = {
    webhookType: "incomingPayment",
    customerCode: "304550680",
    paymentId: "pay-77",
    purpose: "Оплата по счету ТФ-0001",
    SidePayer: { inn: "7707083893", name: "ООО «Ромашка»", amount: "9000.0", currency: "RUB" },
    SideRecipient: { account: "40802810000000000001", amount: "9000.0", currency: "RUB" },
  };

  const post = (text: string) => webhookRoute(req("/api/payments/tochka/webhook", { method: "POST", text, headers: { "content-type": "text/plain" } }));

  beforeEach(() => {
    state.verifier = createWebhookVerifier({
      fetchImpl: (async () => new Response(JSON.stringify(bank.publicKey.export({ format: "jwk" })))) as unknown as typeof fetch,
    });
  });

  async function withInvoice(): Promise<void> {
    signedIn(EMAIL);
    await createInvoiceRoute(req("/api/payments/invoices", { method: "POST", body: buyerBody }));
  }

  it("подписанное банком событие включает подписку; ответ 200", async () => {
    await withInvoice();
    const response = await post(sign(payment, bank.privateKey));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "processed" });
    expect((state.kit as TestKit).store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
  });

  it("подделка (чужой ключ) — 401 и никаких записей", async () => {
    await withInvoice();
    const response = await post(sign(payment, attacker.privateKey));
    expect(response.status).toBe(401);
    expect((state.kit as TestKit).store.state.events).toHaveLength(0);
    expect((state.kit as TestKit).store.state.users[0]?.paidUntil).toBeNull();
  });

  it("пустое тело и мусор — 400/401", async () => {
    expect((await post("")).status).toBe(400);
    expect((await post("мусор")).status).toBe(401);
  });

  it("повтор доставки — 200, подписка не удваивается", async () => {
    await withInvoice();
    const token = sign(payment, bank.privateKey);
    await post(token);
    const again = await post(token);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, status: "duplicate" });
    expect((state.kit as TestKit).store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
  });

  it("чужие виды событий — 200 (банк не должен повторять), ничего не делаем", async () => {
    const response = await post(sign({ webhookType: "outgoingPayment", amount: "1.00" }, bank.privateKey));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "ignored" });
  });

  it("база недоступна при записи события — 500: банк повторит доставку", async () => {
    (state.kit as TestKit).store.recordEvent = async () => {
      throw new Error("база недоступна");
    };
    const response = await post(sign(payment, bank.privateKey));
    expect(response.status).toBe(500);
  });
});

/* ------------------------------------- Подтверждение по ссылке ------------------------------------- */

describe("GET /api/payments/confirm", () => {
  async function claimToken(): Promise<string> {
    signedIn(EMAIL);
    const claim = await (await claimRoute(req("/api/payments/sbp-claim", { method: "POST", body: { planId: "start" } }))).json();
    return signConfirmToken(claim.claim.id as string, T0, "test-secret-0123456789").token;
  }
  const open = (token: string) => confirmRoute(req(`/api/payments/confirm?token=${encodeURIComponent(token)}`));

  it("не вошёл — редирект на вход с возвратом на эту же ссылку; подписка не включается", async () => {
    const token = await claimToken();
    auth.getUser.mockResolvedValue(null);
    const response = await open(token);
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("/login?next=")).toBe(true);
    expect(decodeURIComponent(location.slice("/login?next=".length))).toBe(`/api/payments/confirm?token=${encodeURIComponent(token)}`);
    expect((state.kit as TestKit).store.state.users[0]?.paidUntil).toBeNull();
  });

  it("вошёл обычный пользователь — 403, подписка не включается", async () => {
    const token = await claimToken();
    signedIn("other@firma.ru");
    const response = await open(token);
    expect(response.status).toBe(403);
    expect((state.kit as TestKit).store.state.users[0]?.paidUntil).toBeNull();
  });

  it("администратор: подписка включена, повторное открытие — «уже подтверждено»", async () => {
    const token = await claimToken();
    signedIn(OWNER);
    const first = await open(token);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Оплата подтверждена");
    expect((state.kit as TestKit).store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);

    const second = await open(token);
    expect(await second.text()).toContain("Уже подтверждено");
    expect((state.kit as TestKit).store.state.users[0]?.paidUntil).toBe(T0 + 30 * DAY);
  });

  it("подделанная, просроченная и пустая ссылки — до входа, без редиректа на логин", async () => {
    expect((await open("")).status).toBe(400);
    expect((await open("a.b.c")).status).toBe(400);
    const token = await claimToken();
    (state.kit as TestKit).setNow(T0 + 15 * DAY);
    const expired = await open(token);
    expect(expired.status).toBe(410);
  });

  it("секрет подтверждения не задан — 503", async () => {
    state.kit = createTestKit({ env: { PAYMENT_CONFIRM_SECRET: "" } });
    expect((await open("x")).status).toBe(503);
  });
});
