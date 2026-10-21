import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/services/authRuntime", () => ({
  SESSION_COOKIE: "tf_session",
  getAuthService: () => auth,
  codeLoginEnabled: () => true,
}));

const extract = vi.hoisted(() => vi.fn());
vi.mock("@/services/companyFactsService", async () => {
  const actual = await vi.importActual<typeof import("@/services/companyFactsService")>("@/services/companyFactsService");
  return { ...actual, extractCompanyFacts: extract };
});

const compute = vi.hoisted(() => vi.fn());
vi.mock("@/services/companyFitService", () => ({ computeCompanyFit: compute, defaultFitDeps: () => ({}) }));
vi.mock("@/services/searchAssistService", () => ({ llmChat: vi.fn() }));

import { POST as factsPost } from "@/app/api/company/facts/route";
import { POST as fitPost } from "@/app/api/company/fit/route";
import { FactsExtractionError } from "@/services/companyFactsService";

/**
 * Ручки «Компания»: вход и срок доступа, форма тела, чьи данные.
 * Сессия подменена (как в остальных ручковых тестах), сервисы — тоже: проверяется то, что ручка передаёт им и что отдаёт.
 */

const NOW = Date.now();
const H = 3_600_000;
let counter = 0;

function post(path: string, body: unknown, cookie = true): NextRequest {
  counter += 1;
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": `10.9.0.${String(counter)}`, ...(cookie ? { cookie: "tf_session=tok" } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const session = (id: string, access: { trialEndsAt: number | null; paidUntil: number | null; plan: string | null }) => ({
  id,
  email: `${id}@firma.ru`,
  access,
});
const trial = { trialEndsAt: NOW + H, paidUntil: null, plan: null };
const expired = { trialEndsAt: NOW - H, paidUntil: null, plan: null };

const documents = [{ id: "d1", name: "Реестр.pdf", category: "experience", text: "Реестр исполненных контрактов: капитальный ремонт кровли школы, 12 450 000 руб." }];

beforeEach(() => {
  vi.clearAllMocks();
  auth.getUser.mockResolvedValue(session("user-1", trial));
});

describe("POST /api/company/facts", () => {
  it("без входа — 401, модель не зовётся", async () => {
    auth.getUser.mockResolvedValue(null);
    const response = await factsPost(post("/api/company/facts", { documents }, false));
    expect(response.status).toBe(401);
    expect(extract).not.toHaveBeenCalled();
  });

  it("доступ закончился — 402", async () => {
    auth.getUser.mockResolvedValue(session("user-1", expired));
    const response = await factsPost(post("/api/company/facts", { documents }));
    expect(response.status).toBe(402);
    expect(extract).not.toHaveBeenCalled();
  });

  it("плохое тело — 400", async () => {
    expect((await factsPost(post("/api/company/facts", "не json"))).status).toBe(400);
    expect((await factsPost(post("/api/company/facts", { documents: [] }))).status).toBe(400);
    expect((await factsPost(post("/api/company/facts", { documents: [{ id: "x" }] }))).status).toBe(400);
    expect(extract).not.toHaveBeenCalled();
  });

  it("передаёт сервису тексты, ИНН и идентификатор вошедшего; неизвестная категория становится «прочее»", async () => {
    extract.mockResolvedValue({ facts: { contracts: [] }, skipped: [], truncated: false, sentChars: 10, calls: 1, droppedForPii: 0, failedCalls: 0 });
    const response = await factsPost(
      post("/api/company/facts", {
        documents: [{ ...documents[0], category: "что-то-новое" }],
        companyInn: "5503123456",
        companyName: "ООО «СтройОмск»",
        userId: "чужой-пользователь",
      }),
    );
    expect(response.status).toBe(200);
    const input = extract.mock.calls[0]?.[0] as { userId: string; documents: { category: string }[]; companyInn: string };
    expect(input.userId).toBe("user-1");
    expect(input.documents[0]?.category).toBe("other");
    expect(input.companyInn).toBe("5503123456");
  });

  it("нет текста — 422 с понятной причиной; сбой шлюза — 502 без внутренностей", async () => {
    extract.mockRejectedValueOnce(new FactsExtractionError("В документах нет текста."));
    const a = await factsPost(post("/api/company/facts", { documents }));
    expect(a.status).toBe(422);
    expect(((await a.json()) as { error: string }).error).toContain("нет текста");

    extract.mockRejectedValueOnce(new Error("secret internals: key sk-123"));
    const b = await factsPost(post("/api/company/facts", { documents }));
    expect(b.status).toBe(502);
    expect(JSON.stringify(await b.json())).not.toContain("sk-123");
  });

  it("лимит частоты: седьмой запрос подряд — 429", async () => {
    extract.mockResolvedValue({ facts: {}, skipped: [], truncated: false, sentChars: 1, calls: 1, droppedForPii: 0, failedCalls: 0 });
    auth.getUser.mockResolvedValue(session("user-rate", trial));
    const codes: number[] = [];
    for (let i = 0; i < 7; i += 1) codes.push((await factsPost(post("/api/company/facts", { documents }))).status);
    expect(codes.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(codes[6]).toBe(429);
  });
});

describe("POST /api/company/fit", () => {
  it("без входа — 401, доступ закончился — 402", async () => {
    auth.getUser.mockResolvedValue(null);
    expect((await fitPost(post("/api/company/fit", { tenderId: "T1" }, false))).status).toBe(401);
    auth.getUser.mockResolvedValue(session("user-1", expired));
    expect((await fitPost(post("/api/company/fit", { tenderId: "T1" }))).status).toBe(402);
    expect(compute).not.toHaveBeenCalled();
  });

  it("чьи данные: идентификатор берётся из сессии, а не из тела", async () => {
    compute.mockResolvedValue({ status: "ok", result: { overall: "fit" }, cached: true, degraded: false });
    auth.getUser.mockResolvedValue(session("user-7", trial));
    const response = await fitPost(post("/api/company/fit", { tenderId: "T1", userId: "user-1", facts: { contracts: [] }, force: true }));
    expect(response.status).toBe(200);
    expect(compute.mock.calls[0]?.[0]).toEqual({ userId: "user-7", tenderId: "T1", force: true });
    expect(await response.json()).toMatchObject({ cached: true, result: { overall: "fit" } });
  });

  it("плохое тело — 400", async () => {
    expect((await fitPost(post("/api/company/fit", {}))).status).toBe(400);
    expect((await fitPost(post("/api/company/fit", "x"))).status).toBe(400);
  });

  it("статусы сервиса → коды ответа", async () => {
    const cases: [object, number][] = [
      [{ status: "no_tender" }, 404],
      [{ status: "no_analysis" }, 409],
      [{ status: "limit", limit: 60 }, 429],
      [{ status: "no_data", result: { hasCompanyData: false } }, 200],
    ];
    for (const [outcome, code] of cases) {
      compute.mockResolvedValueOnce(outcome);
      auth.getUser.mockResolvedValue(session(`user-${String(code)}-${String(Math.random())}`, trial));
      expect((await fitPost(post("/api/company/fit", { tenderId: "T1" }))).status).toBe(code);
    }
  });

  it("сбой сервиса — 502 без внутренностей", async () => {
    compute.mockRejectedValueOnce(new Error("db password=hunter2"));
    auth.getUser.mockResolvedValue(session("user-err", trial));
    const response = await fitPost(post("/api/company/fit", { tenderId: "T1" }));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("hunter2");
  });

  it("отметка о неполном результате передаётся клиенту", async () => {
    compute.mockResolvedValueOnce({ status: "ok", result: { overall: "partial" }, cached: false, degraded: true });
    auth.getUser.mockResolvedValue(session("user-deg", trial));
    expect(await (await fitPost(post("/api/company/fit", { tenderId: "T1" }))).json()).toMatchObject({ degraded: true });
  });
});
