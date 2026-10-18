import { describe, expect, it } from "vitest";

import {
  buildFunnel,
  hasPaid,
  parseFunnelPeriod,
  type FunnelEventFact,
  type FunnelFacts,
  type FunnelUserRecord,
} from "@/domain/adminFunnel";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const ENV = { ADMIN_EMAILS: "Owner@Firma.ru" };

const user = (id: string, over: Partial<FunnelUserRecord> = {}): FunnelUserRecord => ({
  id,
  email: `${id}@firma.ru`,
  created_at: iso(-3 * DAY),
  last_login_at: null,
  trial_ends_at: iso(4 * DAY),
  paid_until: null,
  plan: null,
  ...over,
});

const event = (id: string, kind: string, over: Partial<FunnelEventFact> = {}): FunnelEventFact => ({
  email: `${id}@firma.ru`,
  kind,
  ok: true,
  lastAt: iso(-DAY),
  ...over,
});

const facts = (over: Partial<FunnelFacts> = {}): FunnelFacts => ({
  profiles: [],
  events: [],
  analysisDoneEmails: [],
  estimateDoneEmails: [],
  ...over,
});

const profile = (userId: string, hasSearchProfile = true) => ({
  userId,
  hasSearchProfile,
  hasCompanyProfile: false,
  onboardingDone: false,
  tourDone: false,
});

const step = (report: ReturnType<typeof buildFunnel>, key: string) => {
  const found = report.steps.find((s) => s.key === key);
  if (!found) throw new Error(key);
  return found;
};

describe("buildFunnel", () => {
  const users = [
    user("a"), // только зарегистрировался
    user("b"), // профиль, дальше ничего
    user("c"), // профиль + лента
    user("d"), // профиль + лента + карточка
    user("e"), // глубокий анализ (событием)
    user("f"), // смета по заданию
    user("g", { paid_until: iso(10 * DAY), plan: "calc" }), // оплатил
  ];
  const data = facts({
    profiles: [profile("b"), profile("c"), profile("d"), profile("e"), profile("f"), profile("g")],
    events: [
      event("c", "feed_open"),
      event("d", "live_search"),
      event("d", "tender_open"),
      event("e", "deep_analysis"),
    ],
    estimateDoneEmails: ["F@firma.ru"],
  });

  it("считает шаги, доли и «застряли здесь»", () => {
    const report = buildFunnel(users, data, NOW, "all", ENV);

    expect(report.registered).toBe(7);
    expect(report.steps.map((s) => s.count)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(step(report, "profile").shareOfRegistered).toBeCloseTo(6 / 7);
    expect(step(report, "profile").shareOfPrevious).toBeCloseTo(6 / 7);
    expect(step(report, "tender").shareOfPrevious).toBeCloseTo(4 / 5);
    expect(step(report, "registered").shareOfPrevious).toBe(1);

    expect(step(report, "registered").stuckEmails).toEqual(["a@firma.ru"]);
    expect(step(report, "profile").stuckEmails).toEqual(["b@firma.ru"]);
    expect(step(report, "feed").stuckEmails).toEqual(["c@firma.ru"]);
    expect(step(report, "tender").stuckEmails).toEqual(["d@firma.ru"]);
    expect(step(report, "analysis").stuckEmails).toEqual(["e@firma.ru"]);
    expect(step(report, "estimate").stuckEmails).toEqual(["f@firma.ru"]);
    // У последнего шага «застрявших» нет: дальше идти некуда.
    expect(step(report, "paid").stuckEmails).toEqual([]);
    expect(step(report, "paid").emails).toEqual(["g@firma.ru"]);

    // Застрявшие — непересекающиеся группы, а вместе с оплатившими дают всех.
    const stuckTotal = report.steps.reduce((sum, s) => sum + s.stuckEmails.length, 0);
    expect(stuckTotal + step(report, "paid").count).toBe(report.registered);
  });

  it("поздний шаг засчитывает и ранние: анализ без записи о ленте в журнале не ломает воронку", () => {
    const report = buildFunnel([user("h")], facts({ analysisDoneEmails: ["h@firma.ru"] }), NOW, "all", ENV);

    expect(report.steps.map((s) => s.count)).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(report.users[0]?.reachedLabel).toBe("Запустили глубокий анализ");
  });

  it("отказ по лимиту (ok = false) глубоким анализом и сметой не считается", () => {
    const report = buildFunnel(
      [user("a")],
      facts({ events: [event("a", "deep_analysis", { ok: false }), event("a", "estimate", { ok: false })] }),
      NOW,
      "all",
      ENV,
    );
    expect(step(report, "analysis").count).toBe(0);
    expect(step(report, "estimate").count).toBe(0);
  });

  it("шаг «ленту открыли или искали»: feed_open, live_search, find_new, link_import; вход — нет", () => {
    for (const kind of ["feed_open", "live_search", "find_new", "link_import"]) {
      const report = buildFunnel([user("a")], facts({ events: [event("a", kind)] }), NOW, "all", ENV);
      expect(step(report, "feed").count, kind).toBe(1);
    }
    const login = buildFunnel([user("a")], facts({ events: [event("a", "login")] }), NOW, "all", ENV);
    expect(step(login, "feed").count).toBe(0);
  });

  it("администраторы в воронку не входят (почта без учёта регистра)", () => {
    const report = buildFunnel(
      [user("owner"), user("a")],
      facts({ events: [event("owner", "estimate")] }),
      NOW,
      "all",
      ENV,
    );
    expect(report.registered).toBe(1);
    expect(report.users.map((u) => u.email)).toEqual(["a@firma.ru"]);
    expect(step(report, "estimate").count).toBe(0);
  });

  it("фильтр периода отбирает по дате регистрации", () => {
    const list = [
      user("new", { created_at: iso(-2 * DAY) }),
      user("mid", { created_at: iso(-20 * DAY) }),
      user("old", { created_at: iso(-60 * DAY) }),
    ];
    const emails = (period: "all" | "7d" | "30d") =>
      buildFunnel(list, facts(), NOW, period, ENV)
        .users.map((u) => u.email)
        .sort();

    expect(emails("all")).toEqual(["mid@firma.ru", "new@firma.ru", "old@firma.ru"]);
    expect(emails("30d")).toEqual(["mid@firma.ru", "new@firma.ru"]);
    expect(emails("7d")).toEqual(["new@firma.ru"]);
  });

  it("пустой период: нули, без деления на ноль", () => {
    const report = buildFunnel([], facts(), NOW, "7d", ENV);
    expect(report.registered).toBe(0);
    for (const s of report.steps) {
      expect(s.count).toBe(0);
      expect(s.shareOfRegistered).toBe(0);
      expect(s.shareOfPrevious).toBe(0);
    }
  });

  it("оплата: срок в будущем или пакет, не пробный; пробный и пустой пакет — нет", () => {
    expect(hasPaid({ paid_until: iso(DAY), plan: null }, NOW)).toBe(true);
    expect(hasPaid({ paid_until: iso(-DAY), plan: "calc" }, NOW)).toBe(true); // оплатил, срок истёк
    expect(hasPaid({ paid_until: null, plan: "trial" }, NOW)).toBe(false);
    expect(hasPaid({ paid_until: null, plan: "" }, NOW)).toBe(false);
    expect(hasPaid({ paid_until: iso(-DAY), plan: null }, NOW)).toBe(false);

    const report = buildFunnel(
      [user("p", { paid_until: iso(-DAY), plan: "start" }), user("q", { plan: "trial" })],
      facts(),
      NOW,
      "all",
      ENV,
    );
    expect(step(report, "paid").emails).toEqual(["p@firma.ru"]);
  });

  it("по человеку: шаг, последняя активность, остаток пробного, статус", () => {
    const report = buildFunnel(
      [
        user("a", { last_login_at: iso(-5 * DAY), trial_ends_at: iso(2 * DAY + 3600_000) }),
        user("b", { trial_ends_at: iso(-DAY) }),
        user("c", { paid_until: iso(5 * DAY), plan: "calc" }),
      ],
      facts({ events: [event("a", "feed_open", { lastAt: iso(-DAY) }), event("a", "tender_open", { lastAt: iso(-2 * DAY) })] }),
      NOW,
      "all",
      ENV,
    );
    const by = (email: string) => report.users.find((u) => u.email === email);

    expect(by("a@firma.ru")).toMatchObject({ reachedStep: 3, status: "trial", trialDaysLeft: 3, lastActivityAt: iso(-DAY) });
    expect(by("b@firma.ru")).toMatchObject({ status: "expired", trialDaysLeft: null, lastActivityAt: null });
    expect(by("c@firma.ru")).toMatchObject({ status: "paid", trialDaysLeft: null });
    // Сверху — свежая активность, не заходившие — в конце.
    expect(report.users.map((u) => u.email)).toEqual(["a@firma.ru", "b@firma.ru", "c@firma.ru"]);
  });

  it("признаки аккаунта попадают в строку человека", () => {
    const report = buildFunnel(
      [user("a")],
      facts({ profiles: [{ userId: "a", hasSearchProfile: false, hasCompanyProfile: true, onboardingDone: true, tourDone: true }] }),
      NOW,
      "all",
      ENV,
    );
    expect(report.users[0]).toMatchObject({ hasSearchProfile: false, hasCompanyProfile: true, onboardingDone: true, tourDone: true });
  });
});

describe("parseFunnelPeriod", () => {
  it("пусто — all; неизвестное — null", () => {
    expect(parseFunnelPeriod(null)).toBe("all");
    expect(parseFunnelPeriod("")).toBe("all");
    expect(parseFunnelPeriod("7d")).toBe("7d");
    expect(parseFunnelPeriod("30d")).toBe("30d");
    expect(parseFunnelPeriod("year")).toBeNull();
  });
});
