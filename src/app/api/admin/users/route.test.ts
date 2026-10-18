import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = { getUser: vi.fn() };
vi.mock("@/services/authRuntime", () => ({
  SESSION_COOKIE: "tf_session",
  getAuthService: () => auth,
  codeLoginEnabled: () => true,
}));

const repo = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listSessionsSince: vi.fn(),
  listEventsSince: vi.fn(),
  listAttributedJobs: vi.fn(),
  listUserEvents: vi.fn(),
  listFailedJobs: vi.fn(),
}));
vi.mock("@/repositories/adminUsersRepository", () => ({ adminUsersRepository: repo }));
vi.mock("@/repositories/llmUsageRepository", () => ({ llmUsageRepository: { listBetween: vi.fn() } }));

import { GET as users } from "@/app/api/admin/users/route";
import { GET as events } from "@/app/api/admin/users/events/route";
import { LOGIN_REQUIRED_MESSAGE } from "@/app/api/auth/requireAccess";
import { llmUsageRepository } from "@/repositories/llmUsageRepository";

/**
 * Админ-ручки: только вошедший администратор из ADMIN_EMAILS. Служебные ключи
 * воркера и владельца, которые открывают остальное API, здесь не действуют.
 */

const NOW = Date.now();
const DAY = 86_400_000;

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { headers: { cookie: "tf_session=tok", ...headers } });

const sessionUser = (email: string) => ({
  id: "u1",
  email,
  access: { trialEndsAt: NOW + DAY, paidUntil: null, plan: null },
});

const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_EMAILS", "Owner@Firma.ru");
  auth.getUser.mockResolvedValue(null);
  repo.listUsers.mockResolvedValue([
    { id: "u1", email: "owner@firma.ru", created_at: iso(-30 * DAY), last_login_at: iso(-1000), trial_ends_at: null, paid_until: null, plan: null },
    { id: "u2", email: "ivan@firma.ru", created_at: iso(-2 * DAY), last_login_at: iso(-DAY), trial_ends_at: iso(DAY), paid_until: null, plan: null },
  ]);
  repo.listSessionsSince.mockResolvedValue([]);
  repo.listEventsSince.mockResolvedValue({ rows: [], available: true });
  repo.listAttributedJobs.mockResolvedValue([{ id: "a1", source: "analysis", email: "ivan@firma.ru", status: "completed", created_at: iso(-1000), finished_at: null }]);
  vi.mocked(llmUsageRepository.listBetween).mockResolvedValue([
    { created_at: iso(-1000), purpose: "deep_analysis", tender_id: "T1", job_id: "a1", prompt_tokens: 1, completion_tokens: 1, cost_rub: 6, input_chars: 1, ok: true },
    { created_at: iso(-1000), purpose: "deep_analysis", tender_id: "T1", job_id: "bench-x", prompt_tokens: 1, completion_tokens: 1, cost_rub: 100, input_chars: 1, ok: true },
  ]);
  repo.listUserEvents.mockResolvedValue({
    available: true,
    rows: [{ created_at: iso(-1000), kind: "deep_analysis", ok: true, tender_id: "T1", detail: null }],
  });
  repo.listFailedJobs.mockResolvedValue([
    { source: "sync", kind: "estimate", tender_id: "T2", error: "сбой", created_at: iso(-2000), finished_at: iso(-2000) },
  ]);
});

describe.each([
  { name: "GET /api/admin/users", call: (headers?: Record<string, string>) => users(request("/api/admin/users", headers)) },
  {
    name: "GET /api/admin/users/events",
    call: (headers?: Record<string, string>) => events(request("/api/admin/users/events?email=ivan@firma.ru", headers)),
  },
])("$name — доступ", ({ call }) => {
  it("без сессии — 401", async () => {
    const response = await call();
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe(LOGIN_REQUIRED_MESSAGE);
    expect(repo.listUsers).not.toHaveBeenCalled();
  });

  it("обычный пользователь — 403, данные не читаются", async () => {
    auth.getUser.mockResolvedValue(sessionUser("ivan@firma.ru"));
    const response = await call();
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("Раздел только для администратора");
    expect(repo.listUsers).not.toHaveBeenCalled();
    expect(repo.listUserEvents).not.toHaveBeenCalled();
  });

  it("ключ владельца и секрет воркера не открывают раздел: без сессии по-прежнему 401", async () => {
    vi.stubEnv("ADMIN_TOKEN", "owner-token-123456");
    vi.stubEnv("TENDERFIT_WORKER_SECRET", "worker-secret-123456");

    expect((await call({ "x-admin-token": "owner-token-123456", cookie: "" })).status).toBe(401);
    expect((await call({ "x-worker-secret": "worker-secret-123456", cookie: "" })).status).toBe(401);
  });

  it("служебный ключ не заменяет администратора и тогда, когда сессия обычного пользователя", async () => {
    vi.stubEnv("ADMIN_TOKEN", "owner-token-123456");
    auth.getUser.mockResolvedValue(sessionUser("ivan@firma.ru"));
    expect((await call({ "x-admin-token": "owner-token-123456" })).status).toBe(403);
  });

  it("сбой чтения сессии — 503, а не открытая ручка", async () => {
    auth.getUser.mockRejectedValue(new Error("база недоступна"));
    expect((await call()).status).toBe(503);
  });
});

describe("GET /api/admin/users", () => {
  it("администратор (почта без учёта регистра) получает сводку и строки; расход без бенчмарков", async () => {
    auth.getUser.mockResolvedValue(sessionUser("owner@firma.ru"));

    const response = await users(request("/api/admin/users"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary.usersTotal).toBe(2);
    expect(body.summary.spendTotal).toBe(6);
    expect(body.summary.spendBenchExcluded).toBe(100);
    const ivan = body.users.find((u: { email: string }) => u.email === "ivan@firma.ru");
    expect(ivan).toMatchObject({ accessStatus: "trial", spendTotal: 6 });
    expect(body.warnings).toEqual([]);
    // Секретов в ответе нет.
    expect(JSON.stringify(body)).not.toMatch(/password|token_hash/i);
  });

  it("журнала действий нет (миграция не применена) — 200 с предупреждением", async () => {
    auth.getUser.mockResolvedValue(sessionUser("owner@firma.ru"));
    repo.listEventsSince.mockResolvedValue({ rows: [], available: false });

    const body = await (await users(request("/api/admin/users"))).json();

    expect(body.warnings[0]).toContain("20261014000022_user_events.sql");
  });

  it("сбой базы — 500 с причиной", async () => {
    auth.getUser.mockResolvedValue(sessionUser("owner@firma.ru"));
    repo.listUsers.mockRejectedValue(new Error("база недоступна"));

    const response = await users(request("/api/admin/users"));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("база недоступна");
  });
});

describe("GET /api/admin/users/events", () => {
  beforeEach(() => auth.getUser.mockResolvedValue(sessionUser("owner@firma.ru")));

  it("отдаёт журнал: события и упавшие задания, новые сверху", async () => {
    const response = await events(request("/api/admin/users/events?email=Ivan@Firma.ru"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(repo.listUserEvents).toHaveBeenCalledWith("ivan@firma.ru", 200);
    expect(repo.listFailedJobs).toHaveBeenCalledWith("ivan@firma.ru", 200);
    expect(body.email).toBe("ivan@firma.ru");
    expect(body.eventsAvailable).toBe(true);
    expect(body.items.map((i: { label: string }) => i.label)).toEqual(["Глубокий анализ", "Смета не рассчитана"]);
  });

  it("без почты или с мусором вместо неё — 400", async () => {
    expect((await events(request("/api/admin/users/events"))).status).toBe(400);
    expect((await events(request("/api/admin/users/events?email=не-почта"))).status).toBe(400);
  });
});
