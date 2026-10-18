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
  loadFunnelFacts: vi.fn(),
}));
vi.mock("@/repositories/adminUsersRepository", () => ({ adminUsersRepository: repo }));

import { GET } from "@/app/api/admin/funnel/route";
import { LOGIN_REQUIRED_MESSAGE } from "@/app/api/auth/requireAccess";

/** Ручка воронки: только вошедший администратор; администраторы в воронку не входят. */

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { headers: { cookie: "tf_session=tok", ...headers } });

const sessionUser = (email: string) => ({ id: "u1", email, access: { trialEndsAt: NOW + DAY, paidUntil: null, plan: null } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_EMAILS", "Owner@Firma.ru");
  auth.getUser.mockResolvedValue(null);
  repo.listUsers.mockResolvedValue([
    { id: "u1", email: "owner@firma.ru", created_at: iso(-30 * DAY), last_login_at: null, trial_ends_at: null, paid_until: null, plan: null },
    { id: "u2", email: "ivan@firma.ru", created_at: iso(-2 * DAY), last_login_at: iso(-DAY), trial_ends_at: iso(5 * DAY), paid_until: null, plan: null },
    { id: "u3", email: "old@firma.ru", created_at: iso(-60 * DAY), last_login_at: null, trial_ends_at: iso(-50 * DAY), paid_until: null, plan: null },
  ]);
  repo.loadFunnelFacts.mockResolvedValue({
    profiles: [{ userId: "u2", hasSearchProfile: true, hasCompanyProfile: false, onboardingDone: true, tourDone: false }],
    events: [{ email: "ivan@firma.ru", kind: "feed_open", ok: true, lastAt: iso(-1000) }],
    analysisDoneEmails: [],
    estimateDoneEmails: [],
    eventsAvailable: true,
  });
});

describe("GET /api/admin/funnel — доступ", () => {
  it("без сессии — 401, данные не читаются", async () => {
    const response = await GET(request("/api/admin/funnel"));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe(LOGIN_REQUIRED_MESSAGE);
    expect(repo.listUsers).not.toHaveBeenCalled();
    expect(repo.loadFunnelFacts).not.toHaveBeenCalled();
  });

  it("обычный пользователь — 403, данные не читаются", async () => {
    auth.getUser.mockResolvedValue(sessionUser("ivan@firma.ru"));
    const response = await GET(request("/api/admin/funnel"));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("Раздел только для администратора");
    expect(repo.listUsers).not.toHaveBeenCalled();
    expect(repo.loadFunnelFacts).not.toHaveBeenCalled();
  });

  it("служебные ключи сессию не заменяют", async () => {
    vi.stubEnv("ADMIN_TOKEN", "owner-token-123456");
    vi.stubEnv("TENDERFIT_WORKER_SECRET", "worker-secret-123456");
    expect((await GET(request("/api/admin/funnel", { "x-admin-token": "owner-token-123456", cookie: "" }))).status).toBe(401);
    expect((await GET(request("/api/admin/funnel", { "x-worker-secret": "worker-secret-123456", cookie: "" }))).status).toBe(401);
  });
});

describe("GET /api/admin/funnel", () => {
  it("администратор получает воронку без админов; период по умолчанию — все", async () => {
    auth.getUser.mockResolvedValue(sessionUser("owner@firma.ru"));

    const response = await GET(request("/api/admin/funnel"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.period).toBe("all");
    expect(body.registered).toBe(2);
    expect(body.users.map((u: { email: string }) => u.email).sort()).toEqual(["ivan@firma.ru", "old@firma.ru"]);
    expect(body.steps.map((s: { count: number }) => s.count)).toEqual([2, 1, 1, 0, 0, 0, 0]);
    expect(body.steps[2].stuckEmails).toEqual(["ivan@firma.ru"]);
    expect(body.warnings).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/password|token_hash/i);
  });

  it("period=7d отбирает недавно зарегистрированных", async () => {
    auth.getUser.mockResolvedValue(sessionUser("owner@firma.ru"));
    const body = await (await GET(request("/api/admin/funnel?period=7d"))).json();
    expect(body.period).toBe("7d");
    expect(body.users.map((u: { email: string }) => u.email)).toEqual(["ivan@firma.ru"]);
  });

  it("неизвестный период — 400", async () => {
    auth.getUser.mockResolvedValue(sessionUser("owner@firma.ru"));
    expect((await GET(request("/api/admin/funnel?period=year"))).status).toBe(400);
  });

  it("журнала действий нет — 200 с предупреждением", async () => {
    auth.getUser.mockResolvedValue(sessionUser("owner@firma.ru"));
    repo.loadFunnelFacts.mockResolvedValue({ profiles: [], events: [], analysisDoneEmails: [], estimateDoneEmails: [], eventsAvailable: false });
    const body = await (await GET(request("/api/admin/funnel"))).json();
    expect(body.warnings[0]).toContain("20261014000022_user_events.sql");
  });

  it("сбой базы — 500 с описанием", async () => {
    auth.getUser.mockResolvedValue(sessionUser("owner@firma.ru"));
    repo.loadFunnelFacts.mockRejectedValue(new Error("база недоступна"));
    const response = await GET(request("/api/admin/funnel"));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("база недоступна");
  });
});
