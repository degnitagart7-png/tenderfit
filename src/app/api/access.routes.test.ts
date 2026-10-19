import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = { getUser: vi.fn() };

vi.mock("@/services/authRuntime", () => ({
  SESSION_COOKIE: "tf_session",
  getAuthService: () => auth,
  codeLoginEnabled: () => true,
}));
vi.mock("@/repositories/tenderRepository", () => ({
  tenderRepository: { list: vi.fn(async () => []) },
}));
vi.mock("@/repositories/analysisJobRepository", () => ({
  analysisJobRepository: { listCompleted: vi.fn(async () => []), findByTenderId: vi.fn(async () => []) },
}));
vi.mock("@/repositories/documentRepository", () => ({
  documentRepository: { findByTenderId: vi.fn(async () => []) },
}));
vi.mock("@/services/searchAssistService", () => ({
  searchAssist: { expand: vi.fn(async () => ({ synonyms: ["a"], cached: false })), rerank: vi.fn() },
}));
vi.mock("@/repositories/syncJobRepository", () => ({
  syncJobRepository: { findRecent: vi.fn(async () => []), readHeartbeat: vi.fn(async () => null) },
}));
vi.mock("@/services/syncJobService", () => ({
  SyncJobRequestError: class extends Error {},
  enqueueWithStatus: vi.fn(),
  readWorkerStatus: vi.fn(async () => ({ workerId: "w", now: "n", status: { lastJob: null }, view: {} })),
  queueDocumentsForAnalysis: vi.fn(),
}));

import { GET as analysisCompleted } from "@/app/api/analysis/completed/route";
import { POST as analysisTrigger } from "@/app/api/analysis/trigger/route";
import { GET as documents } from "@/app/api/documents/route";
import { POST as documentsParse } from "@/app/api/documents/parse/route";
import { GET as estimateGet, POST as estimatePost } from "@/app/api/estimate/route";
import { POST as expand } from "@/app/api/search/expand/route";
import { POST as liveSearch } from "@/app/api/search/live/route";
import { GET as syncJobsGet, POST as syncJobsPost } from "@/app/api/sync-jobs/route";
import { GET as tenders } from "@/app/api/tenders/route";
import { EXPIRED_MESSAGE, LOGIN_REQUIRED_MESSAGE } from "@/app/api/auth/requireAccess";

/**
 * Платные и основные ручки требуют вход и действующий доступ.
 *
 * 401 без сессии, 402 по окончании пробного периода, пропуск оплаченным и
 * администратору, и обход по секрету воркера или ключу владельца: воркер ходит
 * на эти адреса без куки. Проверяется на нескольких ручках разных семейств —
 * проверка стоит в начале каждой, и забытая вызывала бы дыру только в одной.
 */

const NOW = Date.now();
const H = 3_600_000;

let counter = 0;
function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): NextRequest {
  counter += 1;
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", "x-real-ip": `10.9.0.${String(counter)}`, ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const withCookie = { cookie: "tf_session=tok" };

interface Handler {
  name: string;
  call: (headers: Record<string, string>) => Promise<Response>;
}

const handlers: Handler[] = [
  { name: "GET /api/tenders", call: (headers) => tenders(req("/api/tenders", { headers })) },
  { name: "GET /api/documents", call: (headers) => documents(req("/api/documents?tenderId=1", { headers })) },
  {
    // Тело не multipart: до разбора файла дело не доходит — важна только проверка входа.
    name: "POST /api/documents/parse",
    call: (headers) => documentsParse(req("/api/documents/parse", { method: "POST", headers, body: {} })),
  },
  { name: "GET /api/analysis/completed", call: (headers) => analysisCompleted(req("/api/analysis/completed", { headers })) },
  {
    name: "POST /api/analysis/trigger",
    call: (headers) => analysisTrigger(req("/api/analysis/trigger", { method: "POST", headers, body: { tenderId: "1" } })),
  },
  { name: "GET /api/estimate", call: (headers) => estimateGet(req("/api/estimate?jobId=x", { headers })) },
  {
    name: "POST /api/estimate",
    call: (headers) => estimatePost(req("/api/estimate", { method: "POST", headers, body: { tenderId: "1" } })),
  },
  {
    name: "POST /api/search/expand",
    call: (headers) => expand(req("/api/search/expand", { method: "POST", headers, body: { query: "юристы" } })),
  },
  {
    name: "POST /api/search/live",
    call: (headers) => liveSearch(req("/api/search/live", { method: "POST", headers, body: { query: "юристы" } })),
  },
  { name: "GET /api/sync-jobs", call: (headers) => syncJobsGet(req("/api/sync-jobs", { headers })) },
  {
    name: "POST /api/sync-jobs",
    call: (headers) => syncJobsPost(req("/api/sync-jobs", { method: "POST", headers, body: { kind: "full_sync" } })),
  },
];

const user = (access: { trialEndsAt: number | null; paidUntil: number | null; plan: string | null }, email = "ivan@firma.ru") => ({
  id: "u1",
  email,
  access,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SUPABASE_URL", "http://supabase.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key-for-test");
  vi.stubEnv("ADMIN_EMAILS", "");
  auth.getUser.mockResolvedValue(null);
});

describe.each(handlers)("$name", ({ call }) => {
  it("без сессии — 401 «Войдите, чтобы продолжить»", async () => {
    const response = await call({});

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe(LOGIN_REQUIRED_MESSAGE);
  });

  it("пробный период закончился — 402 с reason: expired", async () => {
    auth.getUser.mockResolvedValue(user({ trialEndsAt: NOW - H, paidUntil: null, plan: null }));

    const response = await call(withCookie);

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: EXPIRED_MESSAGE, reason: "expired" });
  });

  it("пробный период идёт — ручка отрабатывает (не 401 и не 402)", async () => {
    auth.getUser.mockResolvedValue(user({ trialEndsAt: NOW + H, paidUntil: null, plan: null }));

    const status = (await call(withCookie)).status;

    expect([401, 402]).not.toContain(status);
  });

  it("оплачено — пропускает, даже если пробный кончился", async () => {
    auth.getUser.mockResolvedValue(user({ trialEndsAt: NOW - 9 * H, paidUntil: NOW + 99 * H, plan: "calc" }));

    expect([401, 402]).not.toContain((await call(withCookie)).status);
  });

  it("администратор из ADMIN_EMAILS — пропускает без сроков", async () => {
    vi.stubEnv("ADMIN_EMAILS", "Owner@Firma.ru");
    auth.getUser.mockResolvedValue(user({ trialEndsAt: null, paidUntil: null, plan: null }, "owner@firma.ru"));

    expect([401, 402]).not.toContain((await call(withCookie)).status);
  });

  it("секрет воркера обходит проверку: куки нет, а ручка отрабатывает", async () => {
    vi.stubEnv("TENDERFIT_WORKER_SECRET", "worker-secret-123456");

    const status = (await call({ "x-worker-secret": "worker-secret-123456" })).status;

    expect([401, 402]).not.toContain(status);
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it("чужой секрет воркера не обходит: 401", async () => {
    vi.stubEnv("TENDERFIT_WORKER_SECRET", "worker-secret-123456");

    expect((await call({ "x-worker-secret": "wrong-secret-wrong" })).status).toBe(401);
  });

  it("ключ владельца обходит проверку", async () => {
    vi.stubEnv("ADMIN_TOKEN", "owner-token-123456");

    const status = (await call({ "x-admin-token": "owner-token-123456" })).status;

    expect([401, 402]).not.toContain(status);
  });

  it("секрет воркера не задан в окружении — пустой заголовок не открывает ручку", async () => {
    vi.stubEnv("TENDERFIT_WORKER_SECRET", "");

    expect((await call({ "x-worker-secret": "" })).status).toBe(401);
  });

  it("сбой чтения сессии — 503, а не открытая ручка", async () => {
    auth.getUser.mockRejectedValue(new Error("база недоступна"));

    expect((await call(withCookie)).status).toBe(503);
  });
});
