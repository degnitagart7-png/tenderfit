import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createTochkaTransport, describeBankError, TochkaApiError } from "@/services/tochka/client";
import {
  TOCHKA_PROD_BASE,
  TOCHKA_SANDBOX_ACCOUNT_ID,
  TOCHKA_SANDBOX_BASE,
  TOCHKA_SANDBOX_CUSTOMER_CODE,
  TOCHKA_SANDBOX_JWT,
  accountNumberOf,
  tochkaConfigProblem,
} from "@/services/tochka/config";
import { createTochkaInvoices } from "@/services/tochka/invoices";
import { createTochkaWebhooks } from "@/services/tochka/webhooks";
import { createWebhookVerifier, parsePublicKeys } from "@/services/tochka/webhookVerify";
import { TEST_CONFIG } from "@/services/payments/paymentTestKit";

/**
 * Клиент Точки: формы запросов по документации банка (без сети: fetch подменён), повторы,
 * сообщения об ошибках без секретов, песочница и проверка подписи вебхука (ключи RSA — свои).
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(responses: Array<Response | Error>) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("неожиданный запрос");
    if (next instanceof Error) throw next;
    return next;
  });
  const transport = createTochkaTransport(TEST_CONFIG, { fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 });
  return { fetchImpl, invoices: createTochkaInvoices(TEST_CONFIG, transport), webhooks: createTochkaWebhooks(TEST_CONFIG, transport), transport };
}

const callOf = (fetchImpl: ReturnType<typeof setup>["fetchImpl"], index = 0) => {
  const [url, init] = fetchImpl.mock.calls[index] as [string, RequestInit];
  return { url, init, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
};

const buyer = { inn: "7707083893", kpp: "770701001", name: "ООО «Ромашка»", email: "buh@romashka.ru" };
const NOW = Date.parse("2026-10-20T12:00:00Z");
const invoiceInput = { number: "ТФ-0001", buyer, planName: "Старт", months: 1, amountRub: 9000, nowMs: NOW, expiresAtMs: NOW + 45 * 86_400_000 };

describe("конфигурация", () => {
  it("боевой режим требует JWT, код клиента и счёт", () => {
    expect(tochkaConfigProblem({}).config).toBeNull();
    expect(tochkaConfigProblem({ TOCHKA_JWT: "j" }).problem).toMatch(/TOCHKA_CUSTOMER_CODE, TOCHKA_ACCOUNT_ID/);
    expect(tochkaConfigProblem({ TOCHKA_JWT: "j", TOCHKA_CUSTOMER_CODE: "1", TOCHKA_ACCOUNT_ID: "123" }).problem).toMatch(/TOCHKA_ACCOUNT_ID/);
  });

  it("боевой режим: адрес по умолчанию и значения из окружения", () => {
    const { config } = tochkaConfigProblem({
      TOCHKA_JWT: "jwt",
      TOCHKA_CLIENT_ID: "cid",
      TOCHKA_CUSTOMER_CODE: "304550680",
      TOCHKA_ACCOUNT_ID: "40802810000000000001/044525104",
    });
    expect(config).toMatchObject({ baseUrl: TOCHKA_PROD_BASE, jwt: "jwt", clientId: "cid", customerCode: "304550680", sandbox: false, ndsKind: "without_nds", closingDocs: true });
    expect(accountNumberOf(config?.accountId ?? "")).toBe("40802810000000000001");
  });

  it("песочница: тестовые адрес, токен, код клиента и счёт; боевой JWT не используется", () => {
    const { config } = tochkaConfigProblem({
      TOCHKA_SANDBOX: "1",
      TOCHKA_JWT: "REAL-JWT",
      TOCHKA_CUSTOMER_CODE: "304550680",
      TOCHKA_ACCOUNT_ID: "40802810000000000001/044525104",
    });
    expect(config).toMatchObject({
      sandbox: true,
      baseUrl: TOCHKA_SANDBOX_BASE,
      jwt: TOCHKA_SANDBOX_JWT,
      customerCode: TOCHKA_SANDBOX_CUSTOMER_CODE,
      accountId: TOCHKA_SANDBOX_ACCOUNT_ID,
    });
    expect(JSON.stringify(config)).not.toContain("REAL-JWT");
  });

  it("TOCHKA_CLOSING_DOCS=0 выключает акты, TOCHKA_NDS_KIND меняет ставку", () => {
    const base = { TOCHKA_JWT: "j", TOCHKA_CUSTOMER_CODE: "1", TOCHKA_ACCOUNT_ID: "40802810000000000001/044525104" };
    expect(tochkaConfigProblem({ ...base, TOCHKA_CLOSING_DOCS: "0", TOCHKA_NDS_KIND: "nds_0" }).config).toMatchObject({ closingDocs: false, ndsKind: "nds_0" });
  });
});

describe("счета", () => {
  it("Create Invoice: путь, заголовки и тело по документации", async () => {
    const { fetchImpl, invoices } = setup([json({ Data: { documentId: "doc-1" } })]);

    await expect(invoices.createInvoice(invoiceInput)).resolves.toEqual({ documentId: "doc-1" });

    const { url, init, body } = callOf(fetchImpl);
    expect(url).toBe("https://bank.test/uapi/invoice/v1.0/bills");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer SECRET-JWT");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(body).toEqual({
      Data: {
        accountId: "40802810000000000001/044525104",
        customerCode: "304550680",
        SecondSide: { taxCode: "7707083893", type: "company", secondSideName: "ООО «Ромашка»", kpp: "770701001" },
        Content: {
          Invoice: {
            Positions: [
              { positionName: "Подписка ТендерФит, тариф «Старт», 1 мес.", unitCode: "услуга.", ndsKind: "without_nds", price: 9000, quantity: 1, totalAmount: 9000 },
            ],
            date: "2026-10-20",
            totalAmount: 9000,
            number: "ТФ-0001",
            basedOn: "Публичная оферта",
            comment: "Подписка на сервис ТендерФит. Без НДС (УСН).",
            paymentExpiryDate: "2026-12-04",
          },
        },
      },
    });
  });

  it("покупатель-ИП: тип ip и без КПП", async () => {
    const { fetchImpl, invoices } = setup([json({ Data: { documentId: "doc-1" } })]);
    await invoices.createInvoice({ ...invoiceInput, buyer: { inn: "500100732259", kpp: null, name: "ИП Иванов И. И.", email: "i@i.ru" } });
    expect(callOf(fetchImpl).body.Data.SecondSide).toEqual({ taxCode: "500100732259", type: "ip", secondSideName: "ИП Иванов И. И." });
  });

  it("Get Invoice Payment Status: путь с customerCode и documentId; неизвестный статус — unknown", async () => {
    const { fetchImpl, invoices } = setup([json({ Data: { paymentStatus: "payment_paid" } }), json({ Data: { paymentStatus: "что-то новое" } })]);
    await expect(invoices.getInvoicePaymentStatus("doc 1")).resolves.toBe("payment_paid");
    expect(callOf(fetchImpl).url).toBe("https://bank.test/uapi/invoice/v1.0/bills/304550680/doc%201/payment-status");
    expect(callOf(fetchImpl).init.method).toBe("GET");
    await expect(invoices.getInvoicePaymentStatus("doc-1")).resolves.toBe("unknown");
  });

  it("Get Invoice: PDF байтами", async () => {
    const { fetchImpl, invoices } = setup([new Response("%PDF-1.4 hello", { status: 200, headers: { "Content-Type": "application/pdf" } })]);
    const file = await invoices.getInvoicePdf("doc-1");
    expect(callOf(fetchImpl).url).toBe("https://bank.test/uapi/invoice/v1.0/bills/304550680/doc-1/file");
    expect(file.bytes.toString()).toBe("%PDF-1.4 hello");
    expect(file.contentType).toBe("application/pdf");
  });

  it("Send Invoice To Email: Data.email, результат должен быть true", async () => {
    const { fetchImpl, invoices } = setup([json({ Data: { result: true } }), json({ Data: { result: false } })]);
    await invoices.sendInvoiceToEmail("doc-1", "buh@romashka.ru");
    expect(callOf(fetchImpl).url).toBe("https://bank.test/uapi/invoice/v1.0/bills/304550680/doc-1/email");
    expect(callOf(fetchImpl).body).toEqual({ Data: { email: "buh@romashka.ru" } });
    await expect(invoices.sendInvoiceToEmail("doc-1", "buh@romashka.ru")).rejects.toThrow(/не отправил/);
  });

  it("Create Closing Document: акт по счёту (documentId родителя)", async () => {
    const { fetchImpl, invoices } = setup([json({ Data: { documentId: "act-1" } })]);
    await expect(invoices.createAct({ ...invoiceInput, invoiceDocumentId: "doc-1" })).resolves.toEqual({ documentId: "act-1" });
    const { url, body } = callOf(fetchImpl);
    expect(url).toBe("https://bank.test/uapi/invoice/v1.0/closing-documents");
    expect(body.Data.documentId).toBe("doc-1");
    expect(body.Data.Content.Act.Positions[0]).toMatchObject({ positionName: "Подписка ТендерФит, тариф «Старт», 1 мес.", ndsKind: "without_nds", totalAmount: 9000 });
    expect(body.Data.Content.Act.number).toBe("ТФ-0001");
  });

  it("Send Closing Documents To Email", async () => {
    const { fetchImpl, invoices } = setup([json({ Data: { result: true } })]);
    await invoices.sendClosingToEmail("act-1", "buh@romashka.ru");
    expect(callOf(fetchImpl).url).toBe("https://bank.test/uapi/invoice/v1.0/closing-documents/304550680/act-1/email");
  });

  it("банк не вернул documentId — понятная ошибка", async () => {
    const { invoices } = setup([json({ Data: {} })]);
    await expect(invoices.createInvoice(invoiceInput)).rejects.toThrow(/не вернул номер документа/);
  });
});

describe("вебхуки", () => {
  it("Get/Create/Edit/Send: пути /webhook/v1.0/{client_id}", async () => {
    const info = { Data: { webhooksList: ["incomingPayment"], url: "https://tender-fit.ru/api/payments/tochka/webhook" } };
    const { fetchImpl, webhooks } = setup([json(info), json(info), json(info), json({ Data: { result: true } })]);

    await expect(webhooks.getWebhooks()).resolves.toEqual({ webhooksList: ["incomingPayment"], url: "https://tender-fit.ru/api/payments/tochka/webhook" });
    expect(callOf(fetchImpl, 0)).toMatchObject({ url: "https://bank.test/uapi/webhook/v1.0/client-1" });
    expect(callOf(fetchImpl, 0).init.method).toBe("GET");

    await webhooks.createWebhook("https://tender-fit.ru/hook");
    expect(callOf(fetchImpl, 1).init.method).toBe("PUT");
    expect(callOf(fetchImpl, 1).body).toEqual({ webhooksList: ["incomingPayment", "incomingSbpPayment", "incomingSbpB2BPayment"], url: "https://tender-fit.ru/hook" });

    await webhooks.editWebhook("https://tender-fit.ru/hook");
    expect(callOf(fetchImpl, 2).init.method).toBe("POST");

    await expect(webhooks.sendTestWebhook("incomingPayment")).resolves.toBe(true);
    expect(callOf(fetchImpl, 3).url).toBe("https://bank.test/uapi/webhook/v1.0/client-1/test_send");
    expect(callOf(fetchImpl, 3).body).toEqual({ webhookType: "incomingPayment" });
  });

  it("404 при чтении — вебхука ещё нет (null), а не ошибка", async () => {
    const { webhooks } = setup([json({ code: "404", message: "Object of Webhooks does not exists" }, 404)]);
    await expect(webhooks.getWebhooks()).resolves.toBeNull();
  });
});

describe("транспорт: повторы и ошибки", () => {
  it("429 повторяется даже для создания счёта", async () => {
    const { fetchImpl, invoices } = setup([json({ message: "slow down" }, 429), json({ Data: { documentId: "doc-1" } })]);
    await expect(invoices.createInvoice(invoiceInput)).resolves.toEqual({ documentId: "doc-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("5xx при создании счёта НЕ повторяется: банк мог создать документ", async () => {
    const { fetchImpl, invoices } = setup([json({ message: "boom" }, 500), json({ Data: { documentId: "dup" } })]);
    await expect(invoices.createInvoice(invoiceInput)).rejects.toMatchObject({ status: 500, transient: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("обрыв сети при создании счёта не повторяется, при чтении статуса — повторяется", async () => {
    const create = setup([new TypeError("fetch failed")]);
    await expect(create.invoices.createInvoice(invoiceInput)).rejects.toThrow(/Не удалось связаться с банком/);
    expect(create.fetchImpl).toHaveBeenCalledTimes(1);

    const read = setup([new TypeError("fetch failed"), json({ message: "x" }, 503), json({ Data: { paymentStatus: "payment_waiting" } })]);
    await expect(read.invoices.getInvoicePaymentStatus("doc-1")).resolves.toBe("payment_waiting");
    expect(read.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("повторы исчерпаны — ошибка по-русски", async () => {
    const { invoices } = setup([json({}, 502), json({}, 502), json({}, 502)]);
    await expect(invoices.getInvoicePaymentStatus("doc-1")).rejects.toThrow(/Банк временно недоступен/);
  });

  it("400: текст банка попадает в сообщение, а JWT — нет", async () => {
    const { invoices } = setup([
      json({ code: "400", id: "err-77", message: "Что-то пошло не так", Errors: [{ errorCode: "Validation Error", message: "taxCode: неверный ИНН" }] }, 400),
    ]);
    const error = await invoices.createInvoice(invoiceInput).catch((e: unknown) => e as TochkaApiError);
    expect(error).toBeInstanceOf(TochkaApiError);
    expect((error as TochkaApiError).message).toMatch(/Банк не принял данные/);
    expect((error as TochkaApiError).message).toMatch(/неверный ИНН/);
    expect((error as TochkaApiError).bankErrorId).toBe("err-77");
    expect((error as TochkaApiError).message).not.toContain("SECRET-JWT");
  });

  it("401 и 403 объясняют, что проверить", async () => {
    const a = setup([json({}, 401)]);
    await expect(a.invoices.getInvoicePaymentStatus("d")).rejects.toThrow(/JWT/);
    const b = setup([json({}, 403)]);
    await expect(b.invoices.getInvoicePaymentStatus("d")).rejects.toThrow(/ManageInvoiceData/);
  });

  it("текст исходной сетевой ошибки (с адресом) наружу не уходит", async () => {
    const { invoices } = setup([new Error("connect ECONNREFUSED https://bank.test/?token=SECRET-JWT")]);
    const error = (await invoices.createInvoice(invoiceInput).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("SECRET-JWT");
  });

  it("describeBankError собирает message и Errors", () => {
    expect(describeBankError({ message: "m", Errors: [{ errorCode: "E", message: "x" }] })).toEqual({ text: "m; E: x", id: null });
    expect(describeBankError(null)).toEqual({ text: "", id: null });
  });
});

/* ------------------------------- Проверка подписи вебхука ------------------------------- */

function makeKeys(): { publicJwk: Record<string, unknown>; privateKey: KeyObject; publicPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicJwk: publicKey.export({ format: "jwk" }) as Record<string, unknown>,
    privateKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const b64u = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

function signJwt(payload: unknown, privateKey: KeyObject, header: Record<string, unknown> = { typ: "JWT", alg: "RS256" }): string {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey);
  return `${input}.${b64u(signature)}`;
}

describe("проверка подписи вебхука (RS256)", () => {
  const payload = { webhookType: "incomingSbpPayment", amount: "9000.00" };

  it("подпись ключом банка сходится; ключ берётся по адресу и кэшируется", async () => {
    const keys = makeKeys();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(keys.publicJwk), { status: 200 }));
    const verifier = createWebhookVerifier({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const first = await verifier.verify(signJwt(payload, keys.privateKey));
    const second = await verifier.verify(signJwt({ ...payload, amount: "1.00" }, keys.privateKey));

    expect(first).toEqual({ ok: true, payload });
    expect(second.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("подпись другим ключом отклоняется", async () => {
    const bank = makeKeys();
    const attacker = makeKeys();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(bank.publicJwk), { status: 200 }));
    const verifier = createWebhookVerifier({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(verifier.verify(signJwt(payload, attacker.privateKey))).resolves.toEqual({ ok: false, reason: "signature" });
  });

  it("подмена тела при верной подписи отклоняется", async () => {
    const keys = makeKeys();
    const verifier = createWebhookVerifier({ fetchImpl: (async () => new Response(JSON.stringify(keys.publicJwk))) as unknown as typeof fetch });
    const [h, , s] = signJwt(payload, keys.privateKey).split(".") as [string, string, string];
    const forged = `${h}.${b64u(JSON.stringify({ ...payload, amount: "999999.00" }))}.${s}`;
    await expect(verifier.verify(forged)).resolves.toMatchObject({ ok: false, reason: "signature" });
  });

  it("alg: none и HS256 отклоняются до проверки подписи", async () => {
    const keys = makeKeys();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(keys.publicJwk)));
    const verifier = createWebhookVerifier({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const none = `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(payload))}.${b64u("x")}`;
    await expect(verifier.verify(none)).resolves.toEqual({ ok: false, reason: "algorithm" });
    const hs = `${b64u(JSON.stringify({ alg: "HS256" }))}.${b64u(JSON.stringify(payload))}.${b64u("x")}`;
    await expect(verifier.verify(hs)).resolves.toEqual({ ok: false, reason: "algorithm" });
  });

  it("мусор вместо JWT", async () => {
    const verifier = createWebhookVerifier({ fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
    await expect(verifier.verify("не jwt")).resolves.toEqual({ ok: false, reason: "malformed" });
    await expect(verifier.verify("a.b.c")).resolves.toEqual({ ok: false, reason: "malformed" });
    await expect(verifier.verify("")).resolves.toEqual({ ok: false, reason: "malformed" });
  });

  it("адрес ключа недоступен — работает запасной ключ из окружения (PEM и JWK)", async () => {
    const keys = makeKeys();
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const pem = createWebhookVerifier({ fetchImpl: down, pinnedKey: keys.publicPem });
    await expect(pem.verify(signJwt(payload, keys.privateKey))).resolves.toMatchObject({ ok: true });
    const jwk = createWebhookVerifier({ fetchImpl: down, pinnedKey: JSON.stringify(keys.publicJwk) });
    await expect(jwk.verify(signJwt(payload, keys.privateKey))).resolves.toMatchObject({ ok: true });
  });

  it("ключей нет совсем — no_key, а не «подпись неверна»", async () => {
    const keys = makeKeys();
    const verifier = createWebhookVerifier({ fetchImpl: (async () => new Response("не ключ", { status: 200 })) as unknown as typeof fetch });
    await expect(verifier.verify(signJwt(payload, keys.privateKey))).resolves.toEqual({ ok: false, reason: "no_key" });
  });

  it("банк сменил ключ: после неудачи ключ перечитывается (не чаще раза в минуту)", async () => {
    const oldKeys = makeKeys();
    const newKeys = makeKeys();
    let current = oldKeys.publicJwk;
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(current)));
    const verifier = createWebhookVerifier({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now });

    await expect(verifier.verify(signJwt(payload, oldKeys.privateKey))).resolves.toMatchObject({ ok: true });
    current = newKeys.publicJwk;
    // Меньше минуты с прошлого чтения: перечитывать рано.
    now += 10_000;
    await expect(verifier.verify(signJwt(payload, newKeys.privateKey))).resolves.toMatchObject({ ok: false });
    now += 61_000;
    await expect(verifier.verify(signJwt(payload, newKeys.privateKey))).resolves.toMatchObject({ ok: true });
  });

  it("parsePublicKeys понимает один JWK, набор keys и мусор", () => {
    const keys = makeKeys();
    expect(parsePublicKeys(JSON.stringify(keys.publicJwk))).toHaveLength(1);
    expect(parsePublicKeys(JSON.stringify({ keys: [keys.publicJwk, keys.publicJwk] }))).toHaveLength(2);
    expect(parsePublicKeys("мусор")).toHaveLength(0);
    expect(parsePublicKeys("-----BEGIN PUBLIC KEY-----\nxx\n-----END PUBLIC KEY-----")).toHaveLength(0);
  });
});
