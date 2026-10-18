import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRIAL_DAYS,
  effectiveAccess,
  formatTimeLeft,
  hasAccess,
  isLastDay,
  isOpenWhenExpired,
  parseAdminEmails,
  resolveAccess,
  trialDays,
  trialEndsAtFor,
  type UserAccessRecord,
} from "@/domain/access";

/**
 * Правила доступа: администратор > оплачено > пробный период > истёк.
 * Время — параметр, поэтому три дня проверяются без ожидания.
 */

const NOW = Date.parse("2026-10-11T12:00:00Z");
const H = 3_600_000;
const D = 24 * H;
const none = {};

const rec = (over: Partial<UserAccessRecord>): UserAccessRecord => ({
  trialEndsAt: null,
  paidUntil: null,
  plan: null,
  ...over,
});

describe("resolveAccess", () => {
  it("пробный период идёт: статус trial, срок и остаток", () => {
    const info = resolveAccess(rec({ trialEndsAt: NOW + 2 * D - H }), "a@firma.ru", NOW, none);

    expect(info.status).toBe("trial");
    expect(info.endsAt).toBe(new Date(NOW + 2 * D - H).toISOString());
    expect(info.daysLeft).toBe(2);
    expect(info.hoursLeft).toBe(47);
  });

  it("пробный период кончился — expired без срока", () => {
    const info = resolveAccess(rec({ trialEndsAt: NOW - 1 }), "a@firma.ru", NOW, none);

    expect(info).toMatchObject({ status: "expired", endsAt: null, daysLeft: 0, hoursLeft: 0 });
  });

  it("ровно в момент окончания доступа уже нет", () => {
    expect(resolveAccess(rec({ trialEndsAt: NOW }), "a@firma.ru", NOW, none).status).toBe("expired");
  });

  it("оплата сильнее пробного периода, даже если пробный кончился", () => {
    const info = resolveAccess(rec({ trialEndsAt: NOW - D, paidUntil: NOW + 10 * D, plan: "calc" }), "a@firma.ru", NOW, none);

    expect(info).toMatchObject({ status: "paid", plan: "calc", daysLeft: 10 });
  });

  it("оплата кончилась и пробный тоже — expired, пакет помним", () => {
    const info = resolveAccess(rec({ trialEndsAt: NOW - 5 * D, paidUntil: NOW - D, plan: "start" }), "a@firma.ru", NOW, none);

    expect(info.status).toBe("expired");
    expect(info.plan).toBe("start");
  });

  it("оплата кончилась, пробный ещё идёт — trial (оплата не отнимает бесплатного)", () => {
    const info = resolveAccess(rec({ trialEndsAt: NOW + D, paidUntil: NOW - 1, plan: "start" }), "a@firma.ru", NOW, none);

    expect(info.status).toBe("trial");
    expect(info.plan).toBeNull();
  });

  it("администратор — по почте из ADMIN_EMAILS, без регистра и с пробелами", () => {
    const env = { ADMIN_EMAILS: " Owner@Firma.ru , second@x.ru " };

    expect(resolveAccess(rec({}), "owner@firma.ru", NOW, env).status).toBe("admin");
    expect(resolveAccess(rec({}), "SECOND@x.ru", NOW, env).status).toBe("admin");
    expect(resolveAccess(rec({}), "other@firma.ru", NOW, env).status).toBe("expired");
  });

  it("администратор сильнее всего, и срока у него нет", () => {
    const info = resolveAccess(rec({ trialEndsAt: NOW - D }), "owner@firma.ru", NOW, { ADMIN_EMAILS: "owner@firma.ru" });

    expect(info).toMatchObject({ status: "admin", endsAt: null });
  });

  it("нет записи или нет дат — доступа нет, а не бесплатно навсегда", () => {
    expect(resolveAccess(null, "a@firma.ru", NOW, none).status).toBe("expired");
    expect(resolveAccess(undefined, "a@firma.ru", NOW, none).status).toBe("expired");
    expect(resolveAccess(rec({}), "a@firma.ru", NOW, none).status).toBe("expired");
  });
});

describe("hasAccess, isLastDay, isOpenWhenExpired", () => {
  it("доступ закрыт только у expired", () => {
    expect(hasAccess({ status: "expired" })).toBe(false);
    for (const status of ["trial", "paid", "admin"] as const) expect(hasAccess({ status })).toBe(true);
  });

  it("последние сутки — когда осталось 24 часа или меньше", () => {
    expect(isLastDay({ status: "trial", hoursLeft: 24 })).toBe(true);
    expect(isLastDay({ status: "trial", hoursLeft: 25 })).toBe(false);
    expect(isLastDay({ status: "paid", hoursLeft: 3 })).toBe(false);
  });

  it("после окончания открыты оплата, кабинет и настройки; закупки и смета — нет", () => {
    for (const path of ["/billing", "/account", "/settings/profile", "/settings/search", "/settings"]) {
      expect(isOpenWhenExpired(path)).toBe(true);
    }
    for (const path of ["/tenders", "/tenders/123", "/estimate", "/dashboard", "/pipeline", "/reports/daily", "/billing-evil"]) {
      expect(isOpenWhenExpired(path)).toBe(false);
    }
  });
});

describe("пробный период: срок и подпись", () => {
  it("по умолчанию семь дней, TRIAL_DAYS переопределяет", () => {
    expect(DEFAULT_TRIAL_DAYS).toBe(7);
    expect(trialDays({})).toBe(7);
    expect(trialDays({ TRIAL_DAYS: "7" })).toBe(7);
    expect(trialDays({ TRIAL_DAYS: "0.5" })).toBe(0.5);
    expect(trialDays({ TRIAL_DAYS: "мусор" })).toBe(7);
    expect(trialDays({ TRIAL_DAYS: "-2" })).toBe(7);
  });

  it("конец периода — момент регистрации плюс срок", () => {
    expect(trialEndsAtFor(NOW, {})).toBe(NOW + 7 * D);
    expect(trialEndsAtFor(NOW, { TRIAL_DAYS: "14" })).toBe(NOW + 14 * D);
  });

  it("подпись остатка: дни, а в последние сутки — часы", () => {
    expect(formatTimeLeft({ daysLeft: 3, hoursLeft: 72 })).toBe("3 дня");
    expect(formatTimeLeft({ daysLeft: 2, hoursLeft: 40 })).toBe("2 дня");
    expect(formatTimeLeft({ daysLeft: 5, hoursLeft: 100 })).toBe("5 дней");
    expect(formatTimeLeft({ daysLeft: 21, hoursLeft: 500 })).toBe("21 день");
    expect(formatTimeLeft({ daysLeft: 1, hoursLeft: 5 })).toBe("5 часов");
    expect(formatTimeLeft({ daysLeft: 1, hoursLeft: 1 })).toBe("1 час");
    expect(formatTimeLeft({ daysLeft: 1, hoursLeft: 22 })).toBe("22 часа");
  });

  it("список администраторов пустой, если переменной нет", () => {
    expect(parseAdminEmails(undefined).size).toBe(0);
    expect(parseAdminEmails(" , ").size).toBe(0);
  });
});

describe("effectiveAccess — снимок с сервера устаревает", () => {
  const snapshot = resolveAccess(rec({ trialEndsAt: NOW + 2 * H }), "a@firma.ru", NOW, none);

  it("остаток пересчитывается по часам браузера", () => {
    const later = effectiveAccess(snapshot, NOW + H + 1);

    expect(later.status).toBe("trial");
    expect(later.hoursLeft).toBe(1);
  });

  it("срок вышел — expired без нового запроса", () => {
    expect(effectiveAccess(snapshot, NOW + 2 * H).status).toBe("expired");
  });

  it("администратор и истёкший не меняются", () => {
    const admin = resolveAccess(rec({}), "o@x.ru", NOW, { ADMIN_EMAILS: "o@x.ru" });
    expect(effectiveAccess(admin, NOW + 99 * D)).toBe(admin);
    const expired = resolveAccess(rec({}), "a@x.ru", NOW, none);
    expect(effectiveAccess(expired, NOW)).toBe(expired);
  });
});
