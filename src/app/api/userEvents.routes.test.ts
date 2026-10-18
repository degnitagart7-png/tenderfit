import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/services/authRuntime", () => ({
  SESSION_COOKIE: "tf_session",
  getAuthService: () => auth,
  codeLoginEnabled: () => true,
}));

const record = vi.hoisted(() => vi.fn(async (_event: Record<string, unknown>) => undefined));
vi.mock("@/services/userEventLog", () => ({ recordUserEvent: record }));

vi.mock("@/repositories/tenderRepository", () => ({
  tenderRepository: { list: vi.fn(async () => []), count: vi.fn(async () => 0), findByRegNumber: vi.fn(async () => null) },
}));
vi.mock("@/repositories/analysisJobRepository", () => ({
  analysisJobRepository: {
    findByTenderId: vi.fn(async () => []),
    countCreatedSince: vi.fn(async () => 0),
    create: vi.fn(),
  },
}));
vi.mock("@/repositories/documentRepository", () => ({ documentRepository: { listMetaByTenderId: vi.fn(async () => []) } }));
vi.mock("@/repositories/documentAnalysisRepository", () => ({ documentAnalysisRepository: { findByTenderId: vi.fn(async () => []) } }));
vi.mock("@/repositories/verdictHistoryRepository", () => ({ verdictHistoryRepository: { findByTenderId: vi.fn(async () => []) } }));
vi.mock("@/repositories/syncJobRepository", () => ({
  syncJobRepository: {
    readHeartbeat: vi.fn(),
    findActiveEstimate: vi.fn(async () => null),
    findActiveLive: vi.fn(async () => null),
    findRecentLive: vi.fn(async () => null),
    findRecent: vi.fn(async () => []),
    create: vi.fn(),
  },
}));
vi.mock("@/services/searchAssistService", () => ({ searchAssist: { expand: vi.fn(async () => ({ synonyms: [] })) } }));
vi.mock("@/services/syncJobService", () => ({
  SyncJobRequestError: class extends Error {},
  enqueueWithStatus: vi.fn(),
  readWorkerStatus: vi.fn(),
  queueDocumentsForAnalysis: vi.fn(async () => ({ jobId: "d1", deduped: false, error: null })),
}));

import { POST as analysisTrigger } from "@/app/api/analysis/trigger/route";
import { GET as analysisStatus } from "@/app/api/analysis/status/route";
import { POST as estimatePost } from "@/app/api/estimate/route";
import { POST as liveSearch } from "@/app/api/search/live/route";
import { POST as syncJobsPost } from "@/app/api/sync-jobs/route";
import { GET as tenders } from "@/app/api/tenders/route";
import { POST as linkImport } from "@/app/api/tenders/link/route";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import { tenderRepository } from "@/repositories/tenderRepository";
import { enqueueWithStatus, queueDocumentsForAnalysis } from "@/services/syncJobService";

/**
 * Журнал действий: какие ручки что пишут и на чью почту.
 *
 * Доступ проверяет настоящий requireAccess (сессия подменена), поэтому почта
 * доходит до журнала тем же путём, что в бою. Сам журнал подменён шпионом.
 */

const NOW = Date.now();
const H = 3_600_000;
const withCookie = { cookie: "tf_session=tok" };

let counter = 0;
function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): NextRequest {
  counter += 1;
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", "x-real-ip": `10.7.0.${String(counter)}`, ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const sessionUser = (email = "Ivan@Firma.ru") => ({
  id: "u1",
  email,
  access: { trialEndsAt: NOW + H, paidUntil: null, plan: null },
});

const eventsOf = (kind: string) => record.mock.calls.map((c) => c[0]).filter((e) => e["kind"] === kind);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SUPABASE_URL", "http://supabase.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key-for-test");
  vi.stubEnv("ADMIN_EMAILS", "");
  auth.getUser.mockResolvedValue(sessionUser());
  vi.mocked(syncJobRepository.readHeartbeat).mockResolvedValue({
    version: "2026-10-14 22:28",
    last_seen_at: new Date().toISOString(),
  } as never);
  vi.mocked(syncJobRepository.create).mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", status: "pending", kind: "estimate", created_at: "", finished_at: null, error: null, report: null } as never);
  vi.mocked(analysisJobRepository.create).mockResolvedValue({ id: "a1", requested_by: "ivan@firma.ru" } as never);
});

describe("лента и карточка", () => {
  it("GET /api/tenders пишет feed_open на почту вошедшего; запрос одной закупки по номеру — нет", async () => {
    await tenders(req("/api/tenders", { headers: withCookie }));
    await tenders(req("/api/tenders?reg_number=123", { headers: withCookie }));

    expect(eventsOf("feed_open")).toEqual([{ email: "ivan@firma.ru", kind: "feed_open" }]);
  });

  it("служебный запрос (ключ воркера) пишется без почты — рекордер его отбросит", async () => {
    vi.stubEnv("TENDERFIT_WORKER_SECRET", "worker-secret-123456");

    await tenders(req("/api/tenders", { headers: { "x-worker-secret": "worker-secret-123456" } }));

    expect(eventsOf("feed_open").every((e) => e["email"] === null)).toBe(true);
  });

  it("сбой базы в ленте: ответ 500 и событие error с описанием ручки", async () => {
    vi.mocked(tenderRepository.list).mockRejectedValueOnce(new Error("база недоступна"));

    const response = await tenders(req("/api/tenders", { headers: withCookie }));

    expect(response.status).toBe(500);
    expect(eventsOf("error")).toEqual([
      { email: "ivan@firma.ru", kind: "error", ok: false, detail: "GET /api/tenders: база недоступна" },
    ]);
  });

  it("GET /api/analysis/status пишет tender_open с номером закупки; задачи отдаются без почты постановщика", async () => {
    vi.mocked(analysisJobRepository.findByTenderId).mockResolvedValueOnce([
      { id: "a1", status: "completed", requested_by: "other@firma.ru" },
    ] as never);

    const response = await analysisStatus(req("/api/analysis/status?tenderId=0123", { headers: withCookie }));
    const body = await response.json();

    // Регистр почты приводит к нижнему сам рекордер (userEventLog.test.ts).
    expect(eventsOf("tender_open")).toEqual([{ email: "Ivan@Firma.ru", kind: "tender_open", tenderId: "0123" }]);
    expect(body.jobs).toEqual([{ id: "a1", status: "completed" }]);
  });
});

describe("POST /api/analysis/trigger", () => {
  const trigger = () =>
    analysisTrigger(req("/api/analysis/trigger", { method: "POST", headers: withCookie, body: { tenderId: "0123" } }));

  it("поставленный разбор: событие deep_analysis, задание и загрузка записаны на почту", async () => {
    const response = await trigger();

    expect(response.status).toBe(201);
    expect(analysisJobRepository.create).toHaveBeenCalledWith("0123", "full_analysis", 0, "ivan@firma.ru");
    expect(queueDocumentsForAnalysis).toHaveBeenCalledWith("0123", "ivan@firma.ru");
    expect(eventsOf("deep_analysis")).toEqual([{ email: "ivan@firma.ru", kind: "deep_analysis", tenderId: "0123" }]);
    expect((await response.json()).job).not.toHaveProperty("requested_by");
  });

  it("отказ по суточному лимиту: ok = false и причина", async () => {
    vi.mocked(analysisJobRepository.countCreatedSince).mockResolvedValue(20);

    const response = await trigger();

    expect(response.status).toBe(429);
    const [event] = eventsOf("deep_analysis");
    expect(event).toMatchObject({ email: "ivan@firma.ru", ok: false, tenderId: "0123" });
    expect(String(event?.["detail"])).toMatch(/^отказ:/);
    vi.mocked(analysisJobRepository.countCreatedSince).mockResolvedValue(0);
  });

  it("повторное нажатие по идущему разбору событие не пишет", async () => {
    vi.mocked(analysisJobRepository.findByTenderId).mockResolvedValueOnce([{ id: "a0", status: "pending", requested_by: "other@firma.ru" }] as never);

    const response = await trigger();

    expect(response.status).toBe(200);
    expect(eventsOf("deep_analysis")).toEqual([]);
    expect((await response.json()).job).toEqual({ id: "a0", status: "pending" });
  });

  it("пробный период закончился: 402, а в журнале — отказ", async () => {
    auth.getUser.mockResolvedValue({ ...sessionUser(), access: { trialEndsAt: NOW - H, paidUntil: null, plan: null } });

    const response = await trigger();

    expect(response.status).toBe(402);
    expect(eventsOf("deep_analysis")[0]).toMatchObject({ email: "ivan@firma.ru", ok: false });
  });

  it("сбой базы: 500 и событие error", async () => {
    vi.mocked(analysisJobRepository.create).mockRejectedValueOnce(new Error("insert failed"));

    const response = await trigger();

    expect(response.status).toBe(500);
    expect(eventsOf("error")[0]).toMatchObject({ ok: false, detail: "POST /api/analysis/trigger: insert failed" });
  });
});

describe("задания очереди записываются на вошедшего", () => {
  it("POST /api/estimate: третий аргумент create — почта, событие estimate", async () => {
    const response = await estimatePost(req("/api/estimate", { method: "POST", headers: withCookie, body: { tenderId: "0123" } }));

    expect(response.status).toBe(200);
    expect(syncJobRepository.create).toHaveBeenCalledWith("estimate", expect.objectContaining({ tenderId: "0123" }), "ivan@firma.ru");
    expect(eventsOf("estimate")).toEqual([{ email: "ivan@firma.ru", kind: "estimate", tenderId: "0123", detail: "расчёт сметы" }]);
  });

  it("POST /api/estimate по служебному ключу остаётся с меткой «ui»", async () => {
    vi.stubEnv("ADMIN_TOKEN", "owner-token-123456");

    await estimatePost(req("/api/estimate", { method: "POST", headers: { "x-admin-token": "owner-token-123456" }, body: { tenderId: "0123" } }));

    expect(syncJobRepository.create).toHaveBeenCalledWith("estimate", expect.anything(), "ui");
  });

  it("POST /api/estimate: воркер устарел — 503 и событие error", async () => {
    vi.mocked(syncJobRepository.readHeartbeat).mockResolvedValue({ version: "2026-01-01 00:00" } as never);

    const response = await estimatePost(req("/api/estimate", { method: "POST", headers: withCookie, body: { tenderId: "0123" } }));

    expect(response.status).toBe(503);
    expect(eventsOf("error")[0]).toMatchObject({ email: "ivan@firma.ru", ok: false, tenderId: "0123" });
    expect(eventsOf("estimate")).toEqual([]);
  });

  it("POST /api/search/live: задание на почте, событие live_search с запросом", async () => {
    vi.mocked(syncJobRepository.create).mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", status: "pending" } as never);

    const response = await liveSearch(req("/api/search/live", { method: "POST", headers: withCookie, body: { query: "юридические услуги" } }));

    expect(response.status).toBe(200);
    expect(syncJobRepository.create).toHaveBeenCalledWith("full_sync", expect.objectContaining({ liveQuery: "юридические услуги" }), "ivan@firma.ru");
    expect(eventsOf("live_search")).toEqual([{ email: "ivan@firma.ru", kind: "live_search", detail: "юридические услуги" }]);
  });

  it("POST /api/tenders/link: задание на почте, событие link_import", async () => {
    vi.mocked(syncJobRepository.create).mockResolvedValue({ id: "j1", status: "pending", kind: "documents", report: null, error: null } as never);

    const response = await linkImport(
      req("/api/tenders/link", { method: "POST", headers: withCookie, body: { link: "https://zakupki.gov.ru/epz/order/notice/ea44/view/common-info.html?regNumber=0373200123426000001" } }),
    );

    expect(response.status).toBe(201);
    expect(syncJobRepository.create).toHaveBeenCalledWith("documents", expect.objectContaining({ importFromLink: true }), "ivan@firma.ru");
    expect(eventsOf("link_import")).toEqual([{ email: "ivan@firma.ru", kind: "link_import", tenderId: "0373200123426000001" }]);
  });

  it("POST /api/sync-jobs: почта вошедшего передаётся в очередь, «Найти новые» пишет find_new", async () => {
    vi.mocked(enqueueWithStatus).mockResolvedValue({ job: { id: "j1", kind: "full_sync", payload: {} }, deduped: false, view: {} } as never);

    const response = await syncJobsPost(req("/api/sync-jobs", { method: "POST", headers: withCookie, body: { kind: "full_sync", requestedBy: "чужая@почта.ru" } }));

    expect(response.status).toBe(201);
    expect(enqueueWithStatus).toHaveBeenCalledWith(expect.anything(), { requestedBy: "ivan@firma.ru" });
    expect(eventsOf("find_new")).toEqual([{ email: "ivan@firma.ru", kind: "find_new" }]);
  });

  it("POST /api/sync-jobs: повтор (deduped) событие не пишет", async () => {
    vi.mocked(enqueueWithStatus).mockResolvedValue({ job: { id: "j1", kind: "full_sync", payload: {} }, deduped: true, view: {} } as never);

    await syncJobsPost(req("/api/sync-jobs", { method: "POST", headers: withCookie, body: { kind: "full_sync" } }));

    expect(eventsOf("find_new")).toEqual([]);
  });
});
