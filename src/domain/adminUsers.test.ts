import { describe, expect, it } from "vitest";

import {
  buildAdminUsersReport,
  buildUserJournal,
  mskDay,
  sortAdminUsers,
  type AdminUsersInput,
} from "@/domain/adminUsers";

/**
 * Свод «Пользователи»: расход относится к человеку только через задание с его
 * почтой, бенчмарки не считаются нигде, активность — по московским суткам.
 */

const DAY = 86_400_000;
// 14.10.2026, 12:00 МСК.
const NOW = Date.parse("2026-10-14T09:00:00.000Z");
const ago = (days: number, hours = 0): string => new Date(NOW - days * DAY - hours * 3_600_000).toISOString();
const ahead = (days: number): string => new Date(NOW + days * DAY).toISOString();

const ENV = { ADMIN_EMAILS: "owner@firma.ru" };

function input(patch: Partial<AdminUsersInput> = {}): AdminUsersInput {
  return {
    nowMs: NOW,
    env: ENV,
    users: [
      { id: "u1", email: "owner@firma.ru", created_at: ago(60), last_login_at: ago(0, 1), trial_ends_at: null, paid_until: null, plan: null },
      { id: "u2", email: "Ivan@Firma.ru", created_at: ago(3), last_login_at: ago(1), trial_ends_at: ahead(4), paid_until: null, plan: null },
      { id: "u3", email: "anna@firma.ru", created_at: ago(40), last_login_at: ago(20), trial_ends_at: ago(30), paid_until: ahead(10), plan: "calc" },
      { id: "u4", email: "old@firma.ru", created_at: ago(50), last_login_at: ago(45), trial_ends_at: ago(40), paid_until: null, plan: null },
    ],
    sessions: [],
    events: [],
    jobs: [],
    llm: [],
    ...patch,
  };
}

const user = (report: ReturnType<typeof buildAdminUsersReport>, email: string) => {
  const row = report.users.find((u) => u.email === email);
  if (!row) throw new Error(`нет строки ${email}`);
  return row;
};

describe("buildAdminUsersReport: пользователи и доступ", () => {
  it("статусы доступа и счётчики сводки", () => {
    const { summary, users } = buildAdminUsersReport(input());

    expect(summary.usersTotal).toBe(4);
    expect(users.map((u) => [u.email, u.accessStatus]).sort()).toEqual([
      ["anna@firma.ru", "paid"],
      ["ivan@firma.ru", "trial"],
      ["old@firma.ru", "expired"],
      ["owner@firma.ru", "admin"],
    ]);
    expect(summary.payingNow).toBe(1);
    expect(summary.onTrial).toBe(1);
    expect(summary.expired).toBe(1);
    expect(summary.newLast7d).toBe(1);
  });

  it("почты приводятся к нижнему регистру, хэшей и токенов в строках нет", () => {
    const report = buildAdminUsersReport(input());
    expect(report.users.some((u) => u.email === "ivan@firma.ru")).toBe(true);
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/password|token_hash|hash/i);
  });
});

describe("buildAdminUsersReport: активность", () => {
  it("дни активности — различные московские сутки из событий, сессий и последнего входа", () => {
    const report = buildAdminUsersReport(
      input({
        sessions: [{ email: "ivan@firma.ru", created_at: ago(2) }],
        events: [
          { email: "ivan@firma.ru", created_at: ago(0, 1), kind: "feed_open", ok: true },
          { email: "ivan@firma.ru", created_at: ago(0, 2), kind: "tender_open", ok: true }, // те же сутки
          { email: "ivan@firma.ru", created_at: ago(12), kind: "feed_open", ok: true },
        ],
      }),
    );
    const ivan = user(report, "ivan@firma.ru");

    // Сегодня, 2 дня назад (сессия), вчера (last_login_at) — за 7 суток; плюс 12 дней назад — за 30.
    expect(ivan.activeDays7d).toBe(3);
    expect(ivan.activeDays30d).toBe(4);
    expect(ivan.lastActivityAt).toBe(ago(0, 1));
  });

  it("сутки считаются по Москве: 23:30 UTC — уже следующий день", () => {
    expect(mskDay(Date.parse("2026-10-13T23:30:00.000Z"))).toBe("2026-10-14");
    expect(mskDay(Date.parse("2026-10-13T20:59:00.000Z"))).toBe("2026-10-13");
  });

  it("активны сегодня / 7 / 30 дней", () => {
    const { summary } = buildAdminUsersReport(
      input({
        events: [
          { email: "ivan@firma.ru", created_at: ago(0, 1), kind: "feed_open", ok: true },
          { email: "anna@firma.ru", created_at: ago(5), kind: "feed_open", ok: true },
        ],
      }),
    );

    // owner: last_login 1 час назад (сегодня); ivan: сегодня; anna: 5 дней назад и вход 20 дней назад; old: вход 45 дней назад — вне окна.
    expect(summary.activeToday).toBe(2);
    expect(summary.active7d).toBe(3); // owner, ivan (вчера+сегодня), anna
    expect(summary.active30d).toBe(3);
  });

  it("входов за 30 дней — большее из сессий и событий входа (сессия стирается при выходе)", () => {
    const report = buildAdminUsersReport(
      input({
        sessions: [{ email: "ivan@firma.ru", created_at: ago(2) }],
        events: [
          { email: "ivan@firma.ru", created_at: ago(1), kind: "login", ok: true },
          { email: "ivan@firma.ru", created_at: ago(0, 5), kind: "login", ok: true },
        ],
      }),
    );
    expect(user(report, "ivan@firma.ru").logins30d).toBe(2);
  });

  it("счётчики действий считают только успешные события за 30 дней", () => {
    const report = buildAdminUsersReport(
      input({
        events: [
          { email: "ivan@firma.ru", created_at: ago(1), kind: "deep_analysis", ok: true },
          { email: "ivan@firma.ru", created_at: ago(2), kind: "deep_analysis", ok: true },
          { email: "ivan@firma.ru", created_at: ago(2), kind: "deep_analysis", ok: false }, // отказ по лимиту
          { email: "ivan@firma.ru", created_at: ago(3), kind: "estimate", ok: true },
          { email: "ivan@firma.ru", created_at: ago(4), kind: "live_search", ok: true },
          { email: "ivan@firma.ru", created_at: ago(40), kind: "live_search", ok: true }, // старше 30 дней
        ],
      }),
    );
    const ivan = user(report, "ivan@firma.ru");
    expect(ivan.deepAnalyses30d).toBe(2);
    expect(ivan.estimates30d).toBe(1);
    expect(ivan.liveSearches30d).toBe(1);
  });
});

describe("buildAdminUsersReport: ошибки", () => {
  it("ошибки за 7 дней: события «error» и упавшие задания; отказ по лимиту ошибкой не считается", () => {
    const report = buildAdminUsersReport(
      input({
        events: [
          { email: "ivan@firma.ru", created_at: ago(1), kind: "error", ok: false },
          { email: "ivan@firma.ru", created_at: ago(2), kind: "deep_analysis", ok: false },
          { email: "ivan@firma.ru", created_at: ago(9), kind: "error", ok: false }, // старше 7 дней
        ],
        jobs: [
          { id: "j1", source: "analysis", email: "ivan@firma.ru", status: "failed", created_at: ago(3), finished_at: ago(3) },
          { id: "j2", source: "sync", email: "ivan@firma.ru", status: "completed", created_at: ago(3), finished_at: ago(3) },
          { id: "j3", source: "sync", email: "ivan@firma.ru", status: "failed", created_at: ago(20), finished_at: ago(20) }, // давно
          { id: "j4", source: "sync", email: "anna@firma.ru", status: "failed", created_at: ago(1), finished_at: null },
        ],
      }),
    );

    expect(user(report, "ivan@firma.ru").errors7d).toBe(2);
    expect(user(report, "anna@firma.ru").errors7d).toBe(1);
    expect(report.summary.errors7d).toBe(3);
  });
});

describe("buildAdminUsersReport: расход на ИИ", () => {
  const jobs: AdminUsersInput["jobs"] = [
    { id: "a1", source: "analysis", email: "ivan@firma.ru", status: "completed", created_at: ago(1), finished_at: ago(1) },
    { id: "s1", source: "sync", email: "ivan@firma.ru", status: "completed", created_at: ago(40), finished_at: ago(40) },
    { id: "a2", source: "analysis", email: "anna@firma.ru", status: "completed", created_at: ago(0, 2), finished_at: null },
    { id: "g1", source: "analysis", email: "gone@firma.ru", status: "completed", created_at: ago(2), finished_at: null }, // аккаунта нет
  ];

  it("расход относится к человеку по job_id задания: разбор и очередь", () => {
    const report = buildAdminUsersReport(
      input({
        jobs,
        llm: [
          { job_id: "a1", created_at: ago(1), cost_rub: 6 },
          { job_id: "a1", created_at: ago(1), cost_rub: 4 },
          { job_id: "s1", created_at: ago(40), cost_rub: 30 }, // смета 40 дней назад: в «всего», не в «30 дней»
          { job_id: "a2", created_at: ago(0, 1), cost_rub: 5 },
        ],
      }),
    );

    const ivan = user(report, "ivan@firma.ru");
    expect(ivan.spend30d).toBe(10);
    expect(ivan.spendTotal).toBe(40);
    expect(user(report, "anna@firma.ru").spendTotal).toBe(5);
    expect(user(report, "owner@firma.ru").spendTotal).toBe(0);
    expect(report.summary.spendUnattributed).toBe(0);
    expect(report.summary.spendTotal).toBe(45);
  });

  it("без привязки: старые вызовы без задания, служебные job_id, задание без почты и чужая почта без аккаунта", () => {
    const report = buildAdminUsersReport(
      input({
        jobs,
        llm: [
          { job_id: null, created_at: ago(1), cost_rub: 2 }, // помощник поиска
          { job_id: "sync-old", created_at: ago(10), cost_rub: 3 }, // задание до 14.10: почты нет
          { job_id: "g1", created_at: ago(2), cost_rub: 7 }, // почта без аккаунта
          { job_id: "a1", created_at: ago(1), cost_rub: 10 },
        ],
      }),
    );

    expect(report.summary.spendUnattributed).toBe(12);
    expect(report.summary.spendTotal).toBe(22);
    expect(user(report, "ivan@firma.ru").spendTotal).toBe(10);
    // Сумма по людям и «без привязки» дают итог: ничего не потеряно и не посчитано дважды.
    const perUser = report.users.reduce((sum, u) => sum + u.spendTotal, 0);
    expect(perUser + report.summary.spendUnattributed).toBe(report.summary.spendTotal);
  });

  it("бенчмарки (job_id начинается с «bench») не входят ни в одну сумму, но показаны отдельно", () => {
    const report = buildAdminUsersReport(
      input({
        jobs,
        llm: [
          { job_id: "bench-blind:1", created_at: ago(0, 1), cost_rub: 500 },
          { job_id: "Bench-x", created_at: ago(20), cost_rub: 100 },
          { job_id: "a1", created_at: ago(0, 1), cost_rub: 6 },
        ],
      }),
    );

    expect(report.summary.spendToday).toBe(6);
    expect(report.summary.spend7d).toBe(6);
    expect(report.summary.spend30d).toBe(6);
    expect(report.summary.spendTotal).toBe(6);
    expect(report.summary.spendUnattributed).toBe(0);
    expect(report.summary.spendBenchExcluded).toBe(600);
  });

  it("окна расхода: сегодня (с полуночи по Москве), 7, 30 дней и всего", () => {
    const report = buildAdminUsersReport(
      input({
        llm: [
          { job_id: null, created_at: ago(0, 1), cost_rub: 1 }, // 11:00 МСК сегодня
          { job_id: null, created_at: "2026-10-13T20:00:00.000Z", cost_rub: 10 }, // 23:00 МСК вчера
          { job_id: null, created_at: "2026-10-13T21:30:00.000Z", cost_rub: 100 }, // 00:30 МСК сегодня
          { job_id: null, created_at: ago(6), cost_rub: 1000 },
          { job_id: null, created_at: ago(20), cost_rub: 10000 },
          { job_id: null, created_at: ago(100), cost_rub: 100000 },
        ],
      }),
    );

    expect(report.summary.spendToday).toBe(101);
    expect(report.summary.spend7d).toBe(1111);
    expect(report.summary.spend30d).toBe(11111);
    expect(report.summary.spendTotal).toBe(111111);
  });
});

describe("sortAdminUsers", () => {
  const rows = buildAdminUsersReport(
    input({
      events: [{ email: "anna@firma.ru", created_at: ago(1), kind: "feed_open", ok: true }],
      jobs: [{ id: "a1", source: "analysis", email: "ivan@firma.ru", status: "completed", created_at: ago(1), finished_at: null }],
      llm: [{ job_id: "a1", created_at: ago(1), cost_rub: 9 }],
    }),
  ).users;

  it("по расходу по убыванию и по почте по возрастанию", () => {
    expect(sortAdminUsers(rows, "spendTotal", "desc")[0]?.email).toBe("ivan@firma.ru");
    expect(sortAdminUsers(rows, "email", "asc").map((r) => r.email)).toEqual([
      "anna@firma.ru",
      "ivan@firma.ru",
      "old@firma.ru",
      "owner@firma.ru",
    ]);
  });

  it("пустые даты всегда в конце, исходный массив не меняется", () => {
    const withNull = [...rows, { ...rows[0]!, email: "zzz@firma.ru", lastLoginAt: null }];
    const copy = [...withNull];
    expect(sortAdminUsers(withNull, "lastLoginAt", "asc").at(-1)?.email).toBe("zzz@firma.ru");
    expect(sortAdminUsers(withNull, "lastLoginAt", "desc").at(-1)?.email).toBe("zzz@firma.ru");
    expect(withNull).toEqual(copy);
  });
});

describe("buildUserJournal", () => {
  it("события и упавшие задания вперемешку, новые сверху, с русскими подписями", () => {
    const items = buildUserJournal(
      [
        { created_at: ago(0, 3), kind: "deep_analysis", ok: true, tender_id: "T1", detail: null },
        { created_at: ago(0, 1), kind: "error", ok: false, tender_id: null, detail: "GET /api/tenders: база недоступна" },
      ],
      [
        { source: "analysis", tender_id: "T1", error: "нет документов", created_at: ago(0, 2), finished_at: ago(0, 2) },
        { source: "sync", kind: "estimate", tender_id: "T2", error: "модель недоступна", created_at: ago(1), finished_at: null },
      ],
    );

    expect(items.map((i) => i.label)).toEqual([
      "Ошибка сервиса",
      "Глубокий анализ не выполнен",
      "Глубокий анализ",
      "Смета не рассчитана",
    ]);
    expect(items[1]).toMatchObject({ ok: false, tenderId: "T1", detail: "нет документов", source: "analysis_job" });
  });

  it("не длиннее лимита", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ created_at: ago(i), kind: "feed_open", ok: true, tender_id: null, detail: null }));
    expect(buildUserJournal(events, [], 3)).toHaveLength(3);
  });
});
