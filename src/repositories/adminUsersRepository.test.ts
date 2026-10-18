import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Репозиторий админ-панели читает только нужные колонки: хэш пароля и хэш токена
 * сессии не запрашиваются вовсе, поэтому не могут попасть в ответ.
 */

const calls: Array<{ table: string; select: string }> = [];
let result: { data: unknown; error: unknown } = { data: [], error: null };
/** Ответ отдельной таблицы поверх общего `result` — для методов, читающих несколько таблиц. */
let resultByTable: Record<string, { data: unknown; error: unknown }> = {};

function chain(table: string): unknown {
  const builder: Record<string, unknown> = {};
  const self = new Proxy(builder, {
    get(_target, prop) {
      if (prop === "then") return (resolve: (value: unknown) => unknown) => resolve(resultByTable[table] ?? result);
      if (prop === "select") {
        return (columns: string) => {
          calls.push({ table, select: columns });
          return self;
        };
      }
      return () => self;
    },
  });
  return self;
}

vi.mock("@/lib/supabase", () => ({ getSupabaseServerClient: () => ({ from: (table: string) => chain(table) }) }));

import { adminUsersRepository, isMissingTable } from "@/repositories/adminUsersRepository";

beforeEach(() => {
  calls.length = 0;
  result = { data: [], error: null };
  resultByTable = {};
});

describe("adminUsersRepository", () => {
  it("секретных колонок в запросах нет: password_hash, token_hash, code_hash", async () => {
    await adminUsersRepository.listUsers();
    await adminUsersRepository.listSessionsSince("2026-09-14T00:00:00.000Z");
    await adminUsersRepository.listEventsSince("2026-09-14T00:00:00.000Z");
    await adminUsersRepository.listAttributedJobs();
    await adminUsersRepository.listUserEvents("a@b.ru", 200);
    await adminUsersRepository.listFailedJobs("a@b.ru", 200);

    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) {
      expect(call.select).not.toMatch(/hash|\*/i);
    }
    expect(calls.find((c) => c.table === "app_users")?.select).toContain("trial_ends_at");
  });

  it("таблицы журнала нет — пустой результат с available: false, а не ошибка", async () => {
    result = { data: null, error: { code: "42P01", message: "relation does not exist" } };

    expect(await adminUsersRepository.listEventsSince("2026-09-14T00:00:00.000Z")).toEqual({ rows: [], available: false });
    expect(await adminUsersRepository.listUserEvents("a@b.ru", 5)).toEqual({ rows: [], available: false });
  });

  it("прочая ошибка базы пробрасывается", async () => {
    result = { data: null, error: { code: "XX000", message: "boom" } };

    await expect(adminUsersRepository.listUsers()).rejects.toMatchObject({ message: "boom" });
    expect(isMissingTable({ code: "PGRST205" })).toBe(true);
    expect(isMissingTable({ code: "XX000" })).toBe(false);
  });

  it("строки приводятся к записям домена", async () => {
    result = {
      data: [{ id: "u1", email: "a@b.ru", created_at: "2026-10-01T00:00:00Z", last_login_at: null, trial_ends_at: "2026-10-08T00:00:00Z", paid_until: null, plan: null }],
      error: null,
    };

    expect(await adminUsersRepository.listUsers()).toEqual([
      { id: "u1", email: "a@b.ru", created_at: "2026-10-01T00:00:00Z", last_login_at: null, trial_ends_at: "2026-10-08T00:00:00Z", paid_until: null, plan: null },
    ]);
  });

  describe("loadFunnelFacts", () => {
    it("берёт из app_state только два флага путём JSON и не читает хэши", async () => {
      await adminUsersRepository.loadFunnelFacts();

      const userData = calls.find((c) => c.table === "user_data");
      expect(userData?.select).toContain("app_state->onboardingDone");
      expect(userData?.select).toContain("app_state->tourDone");
      expect(userData?.select).not.toMatch(/app_state(?!->)/);
      for (const call of calls) expect(call.select).not.toMatch(/hash|\*/i);
      // Четыре чтения на всё, а не запрос на человека.
      expect(calls.map((c) => c.table).sort()).toEqual(["analysis_jobs", "sync_jobs", "user_data", "user_events"]);
    });

    it("сворачивает данные в признаки и почты", async () => {
      resultByTable = {
        user_data: {
          error: null,
          data: [
            { user_id: "u1", search_profiles: [{ keywords: ["  ", ""] }, { keywords: ["ремонт"] }], company_profile: { legalName: "ООО Ромашка" }, onboarding_done: true, tour_done: null },
            { user_id: "u2", search_profiles: [{ keywords: [] }], company_profile: { name: " ", activityDescription: "" }, onboarding_done: null, tour_done: true },
            { user_id: "u3", search_profiles: null, company_profile: null, onboarding_done: null, tour_done: null },
          ],
        },
        user_events: {
          error: null,
          data: [
            { email: "Ivan@Firma.ru", kind: "feed_open", ok: true, created_at: "2026-10-15T08:00:00Z" },
            { email: "ivan@firma.ru", kind: "feed_open", ok: true, created_at: "2026-10-16T08:00:00Z" },
            { email: "ivan@firma.ru", kind: "deep_analysis", ok: false, created_at: "2026-10-16T09:00:00Z" },
          ],
        },
        analysis_jobs: { error: null, data: [{ id: "a1", requested_by: "Ivan@Firma.ru" }, { id: "a2", requested_by: "ivan@firma.ru" }] },
        sync_jobs: { error: null, data: [{ id: "s1", requested_by: "anna@firma.ru" }] },
      };

      const facts = await adminUsersRepository.loadFunnelFacts();

      expect(facts.profiles).toEqual([
        { userId: "u1", hasSearchProfile: true, hasCompanyProfile: true, onboardingDone: true, tourDone: false },
        { userId: "u2", hasSearchProfile: false, hasCompanyProfile: false, onboardingDone: false, tourDone: true },
        { userId: "u3", hasSearchProfile: false, hasCompanyProfile: false, onboardingDone: false, tourDone: false },
      ]);
      expect(facts.events).toEqual([
        { email: "ivan@firma.ru", kind: "feed_open", ok: true, lastAt: "2026-10-16T08:00:00Z" },
        { email: "ivan@firma.ru", kind: "deep_analysis", ok: false, lastAt: "2026-10-16T09:00:00Z" },
      ]);
      expect(facts.analysisDoneEmails).toEqual(["ivan@firma.ru"]);
      expect(facts.estimateDoneEmails).toEqual(["anna@firma.ru"]);
      expect(facts.eventsAvailable).toBe(true);
    });

    it("журнала нет — события пусты, eventsAvailable: false; колонки requested_by нет — заданий нет", async () => {
      resultByTable = {
        user_events: { data: null, error: { code: "42P01", message: "relation does not exist" } },
        analysis_jobs: { data: null, error: { code: "42703", message: "column does not exist" } },
      };

      const facts = await adminUsersRepository.loadFunnelFacts();

      expect(facts.eventsAvailable).toBe(false);
      expect(facts.events).toEqual([]);
      expect(facts.analysisDoneEmails).toEqual([]);
    });

    it("прочая ошибка базы пробрасывается", async () => {
      resultByTable = { user_data: { data: null, error: { code: "XX000", message: "boom" } } };
      await expect(adminUsersRepository.loadFunnelFacts()).rejects.toMatchObject({ message: "boom" });
    });
  });
});
