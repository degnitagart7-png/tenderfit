import { describe, expect, it, vi } from "vitest";

import type { DigestUserRecord, ReadyJob, UserDigestData } from "@/repositories/notificationRepository";
import {
  digestSince,
  mayNotify,
  notifyRecipientsMode,
  runDigests,
  runFailureAlerts,
  runReadyNotifications,
  sendDigestNow,
  summarizeAnalysis,
  type NotificationDeps,
} from "@/services/notificationService";
import { DAY, H, NOW, contractor, dbRow, stroyka } from "@/test/digestFixtures";
import type { TenderRow as TenderRowDB } from "@/types/database";

const MIN = 60_000;
const ADMIN = "boss@firma.ru";
const iso = (ms: number): string => new Date(ms).toISOString();

/* ------------------------------ Письма о готовности ------------------------------ */

const job = (over: Partial<ReadyJob> = {}): ReadyJob => ({
  kind: "analysis",
  id: "job-1",
  requestedBy: ADMIN,
  createdAt: NOW - 15 * MIN,
  finishedAt: NOW - 5 * MIN,
  tenderId: "0373100000126000001",
  subject: null,
  mode: "estimate",
  totalRub: null,
  ...over,
});

interface Setup {
  deps: NotificationDeps;
  claimed: Set<string>;
  sent: { to: string; subject: string; text: string; html: string }[];
}

function setup(over: Partial<NotificationDeps> = {}, opts: { jobs?: ReadyJob[] } = {}): Setup {
  const claimed = new Set<string>();
  const sent: Setup["sent"] = [];
  const deps: NotificationDeps = {
    env: { ADMIN_EMAILS: ADMIN },
    now: () => NOW,
    smtpConfigured: () => true,
    sendMail: vi.fn(async (to: string, subject: string, text: string, html: string) => {
      sent.push({ to, subject, text, html });
    }),
    log: vi.fn(),

    listReadyJobs: vi.fn(async () => opts.jobs ?? []),
    claimJob: vi.fn(async (j: Pick<ReadyJob, "kind" | "id">) => {
      const key = `${j.kind}:${j.id}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    }),
    releaseJob: vi.fn(async (j: Pick<ReadyJob, "kind" | "id">) => void claimed.delete(`${j.kind}:${j.id}`)),
    readSettingsByEmail: vi.fn(async () => undefined),
    readTenderSubject: vi.fn(async () => "Капитальный ремонт школы"),
    readAnalysisRows: vi.fn(async () => []),

    listUsers: vi.fn(async () => []),
    findUserByEmail: vi.fn(async () => null),
    readSettings: vi.fn(async () => new Map()),
    readDigestData: vi.fn(async () => new Map()),
    loadTenderRows: vi.fn(async () => []),
    markDigestSent: vi.fn(async () => undefined),
    ...over,
  };
  return { deps, claimed, sent };
}

describe("runReadyNotifications", () => {
  it("анализ готов: письмо тому, кто запускал, с темой, итогом сводки и ссылкой; задача отмечена", async () => {
    const consolidated = {
      kind: "consolidated",
      summary: "Участвовать можно, нужна СРО.",
      findings: [{}, {}, {}],
      conflicts: [{}],
      questions: ["а", "б"],
      facts: {},
    };
    const { deps, sent, claimed } = setup({ readAnalysisRows: vi.fn(async () => [{ findings: [{}] }, consolidated]) }, { jobs: [job()] });

    const result = await runReadyNotifications(deps);

    expect(result.sent).toBe(1);
    expect(sent[0]?.to).toBe(ADMIN);
    expect(sent[0]?.subject).toBe("Анализ готов: Капитальный ремонт школы");
    expect(sent[0]?.html).toContain("Участвовать можно, нужна СРО.");
    expect(sent[0]?.html).toContain("противоречий: 1, вопросов заказчику: 2");
    expect(sent[0]?.html).toContain("/tenders/0373100000126000001?tab=analysis");
    expect(claimed.has("analysis:job-1")).toBe(true);
  });

  it("смета готова: тема с предметом из задания, итог из отчёта, ссылка на закупку", async () => {
    const { deps, sent } = setup(
      {},
      { jobs: [job({ kind: "estimate", id: "e1", subject: "Ремонт кровли", totalRub: 15_300_000 })] },
    );

    await runReadyNotifications(deps);

    expect(sent[0]?.subject).toBe("Смета готова: Ремонт кровли");
    expect(sent[0]?.html).toContain("Итого с НДС");
    expect(sent[0]?.html).toContain("/tenders/0373100000126000001?tab=analysis");
  });

  it("смета без закупки — ссылка на /estimate, предмет по умолчанию", async () => {
    const { deps, sent } = setup({}, { jobs: [job({ kind: "estimate", id: "e2", tenderId: null, subject: null })] });

    await runReadyNotifications(deps);

    expect(sent[0]?.subject).toBe("Смета готова: Смета");
    expect(sent[0]?.html).toContain("https://tender-fit.ru/estimate");
  });

  it("аудит сметы заказчика — не «смета готова»: письма нет, задача закрыта", async () => {
    const { deps, sent, claimed } = setup({}, { jobs: [job({ kind: "estimate", id: "e3", mode: "audit" })] });

    const result = await runReadyNotifications(deps);

    expect(sent).toEqual([]);
    expect(result.skippedJobs).toBe(1);
    expect(claimed.has("estimate:e3")).toBe(true);
  });

  it("задача старше 30 минут не рассылается: при первом запуске вчерашнее не уходит", async () => {
    const { deps, sent } = setup({}, { jobs: [job({ finishedAt: NOW - 31 * MIN, createdAt: NOW - 40 * MIN })] });

    await runReadyNotifications(deps);

    expect(sent).toEqual([]);
    expect(deps.claimJob).not.toHaveBeenCalled();
    // репозиторию передано то же окно
    expect(vi.mocked(deps.listReadyJobs)).toHaveBeenCalledWith(NOW - 30 * MIN);
  });

  it("ровно на границе окна (30 минут) — ещё шлём", async () => {
    const { deps, sent } = setup({}, { jobs: [job({ finishedAt: NOW - 30 * MIN, createdAt: NOW - 40 * MIN })] });

    await runReadyNotifications(deps);

    expect(sent).toHaveLength(1);
  });

  it("расчёт короче двух минут: человек дождался на экране — письма нет, но задача отмечена", async () => {
    const { deps, sent, claimed } = setup(
      {},
      { jobs: [job({ createdAt: NOW - 5 * MIN - 119_000, finishedAt: NOW - 5 * MIN })] },
    );

    const result = await runReadyNotifications(deps);

    expect(sent).toEqual([]);
    expect(result.skippedJobs).toBe(1);
    expect(claimed.has("analysis:job-1")).toBe(true);
  });

  it("ровно две минуты — письмо уходит", async () => {
    const { deps, sent } = setup({}, { jobs: [job({ createdAt: NOW - 7 * MIN, finishedAt: NOW - 5 * MIN })] });

    await runReadyNotifications(deps);

    expect(sent).toHaveLength(1);
  });

  it("человек отключил письмо о готовности — не шлём, задача отмечена", async () => {
    const { deps, sent, claimed } = setup(
      { readSettingsByEmail: vi.fn(async () => ({ readyEnabled: false })) },
      { jobs: [job()] },
    );

    await runReadyNotifications(deps);

    expect(sent).toEqual([]);
    expect(claimed.has("analysis:job-1")).toBe(true);
    expect(deps.readSettingsByEmail).toHaveBeenCalledWith(ADMIN);
  });

  it("задача без почты («служебная») пропускается", async () => {
    const { deps, sent } = setup({}, { jobs: [job({ requestedBy: "admin-token" })] });

    await runReadyNotifications(deps);

    expect(sent).toEqual([]);
    expect(deps.claimJob).not.toHaveBeenCalled();
  });

  it("повторная проверка тех же задач письма не шлёт: отметка занята", async () => {
    const { deps, sent } = setup({}, { jobs: [job()] });

    await runReadyNotifications(deps);
    await runReadyNotifications(deps);

    expect(sent).toHaveLength(1);
  });

  it("сбой почты: отметка снята, следующая проверка повторит; наружу ничего не летит", async () => {
    const sendMail = vi.fn().mockRejectedValueOnce(new Error("SMTP недоступен")).mockResolvedValue(undefined);
    const { deps, claimed } = setup({ sendMail }, { jobs: [job()] });

    const first = await runReadyNotifications(deps);
    expect(first.failed).toBe(1);
    expect(claimed.has("analysis:job-1")).toBe(false);

    const second = await runReadyNotifications(deps);
    expect(second.sent).toBe(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("SMTP недоступен"));
  });

  it("сбой базы при чтении задач не бросается наружу", async () => {
    const { deps } = setup({ listReadyJobs: vi.fn(async () => Promise.reject(new Error("база недоступна"))) });

    await expect(runReadyNotifications(deps)).resolves.toMatchObject({ sent: 0 });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("база недоступна"));
  });

  it("почта не настроена — пропуск без обращения к базе", async () => {
    const { deps } = setup({ smtpConfigured: () => false }, { jobs: [job()] });

    const result = await runReadyNotifications(deps);

    expect(result.skipped).toBe(true);
    expect(deps.listReadyJobs).not.toHaveBeenCalled();
  });

  describe("шлюз NOTIFY_RECIPIENTS", () => {
    const stranger = job({ id: "j-x", requestedBy: "client@example.ru" });

    it("по умолчанию (admins): чужим ничего не шлём и ничего не отмечаем; админу — шлём", async () => {
      const { deps, sent, claimed } = setup({}, { jobs: [stranger, job()] });

      await runReadyNotifications(deps);

      expect(sent.map((m) => m.to)).toEqual([ADMIN]);
      expect(claimed.has("analysis:j-x")).toBe(false);
    });

    it("регистр адреса не важен", async () => {
      const { deps, sent } = setup({ env: { ADMIN_EMAILS: ADMIN } }, { jobs: [job({ requestedBy: "BOSS@Firma.ru" })] });

      await runReadyNotifications(deps);

      expect(sent[0]?.to).toBe(ADMIN);
    });

    it("all: пишем всем", async () => {
      const { deps, sent } = setup({ env: { ADMIN_EMAILS: ADMIN, NOTIFY_RECIPIENTS: "all" } }, { jobs: [stranger] });

      await runReadyNotifications(deps);

      expect(sent.map((m) => m.to)).toEqual(["client@example.ru"]);
    });

    it("off: ничего не шлём и базу не трогаем", async () => {
      const { deps, sent } = setup({ env: { ADMIN_EMAILS: ADMIN, NOTIFY_RECIPIENTS: "off" } }, { jobs: [job()] });

      const result = await runReadyNotifications(deps);

      expect(result.skipped).toBe(true);
      expect(sent).toEqual([]);
      expect(deps.listReadyJobs).not.toHaveBeenCalled();
    });

    it("непонятное значение читается как admins", () => {
      expect(notifyRecipientsMode({ NOTIFY_RECIPIENTS: "все" })).toBe("admins");
      expect(notifyRecipientsMode({})).toBe("admins");
      expect(notifyRecipientsMode({ NOTIFY_RECIPIENTS: " ALL " })).toBe("all");
      expect(mayNotify("admins", "x@y.ru", { ADMIN_EMAILS: "a@b.ru" })).toBe(false);
      expect(mayNotify("all", "x@y.ru", {})).toBe(true);
      expect(mayNotify("off", "a@b.ru", { ADMIN_EMAILS: "a@b.ru" })).toBe(false);
    });
  });
});

describe("summarizeAnalysis", () => {
  it("берёт последнюю сводку; без неё считает выводы по документам", () => {
    expect(
      summarizeAnalysis([
        { kind: "consolidated", summary: "старая", findings: [], conflicts: [], questions: [], facts: {} },
        { kind: "consolidated", summary: "новая", findings: [{}], conflicts: [{}, {}], questions: [], facts: {} },
      ]),
    ).toEqual({ summary: "новая", findings: 1, conflicts: 2, questions: 0 });

    expect(summarizeAnalysis([{ findings: [{}, {}] }, { findings: [{}] }, null])).toEqual({
      summary: null,
      findings: 3,
      conflicts: null,
      questions: null,
    });
  });
});

/* ---------------------------------- Сводки ---------------------------------- */

/** NOW — 09:00 в Иркутске (+8) и 04:00 в Москве. */
const user = (over: Partial<DigestUserRecord> = {}): DigestUserRecord => ({
  id: "u1",
  email: ADMIN,
  trialEndsAt: null,
  paidUntil: NOW + 30 * DAY,
  plan: "start",
  digestSentAt: null,
  ...over,
});

const irkutskSettings = { enabled: true, sendTime: "08:00", timeZone: "Asia/Irkutsk", minFitScore: 0 };

const accountData = (over: Partial<UserDigestData> = {}): UserDigestData => ({
  searchProfiles: [stroyka],
  companyProfile: contractor,
  pipeline: {},
  ...over,
});

function digestSetup(opts: {
  users?: DigestUserRecord[];
  settings?: Record<string, unknown>;
  data?: Record<string, UserDigestData>;
  rows?: TenderRowDB[];
  deps?: Partial<NotificationDeps>;
}) {
  const users = opts.users ?? [user()];
  return setup({
    listUsers: vi.fn(async () => users),
    readSettings: vi.fn(async () => new Map(Object.entries(opts.settings ?? Object.fromEntries(users.map((u) => [u.id, irkutskSettings]))))),
    readDigestData: vi.fn(async () => new Map(Object.entries(opts.data ?? Object.fromEntries(users.map((u) => [u.id, accountData()]))))),
    loadTenderRows: vi.fn(async () => opts.rows ?? [dbRow("100")]),
    findUserByEmail: vi.fn(async (email: string) => users.find((u) => u.email === email) ?? null),
    ...opts.deps,
  });
}

describe("runDigests", () => {
  it("пора по часам клиента: письмо со сводкой, digest_sent_at = сейчас", async () => {
    const { deps, sent } = digestSetup({});

    const result = await runDigests(deps);

    expect(result).toMatchObject({ sent: 1, empty: 0, failed: 0 });
    expect(sent[0]?.to).toBe(ADMIN);
    expect(sent[0]?.subject).toBe("ТендерФит: 1 новая закупка по вашему профилю");
    // подача — через 10 суток от NOW (09:00 Иркутск → 09:00 Иркутск)
    expect(sent[0]?.html).toContain("подача до 26.10 09:00");
    expect(deps.markDigestSent).toHaveBeenCalledWith("u1", NOW);
  });

  it("рано по часам клиента (в Москве ещё ночь) — не шлём", async () => {
    const { deps, sent } = digestSetup({ settings: { u1: { ...irkutskSettings, timeZone: "Europe/Moscow" } } });

    await runDigests(deps);

    expect(sent).toEqual([]);
    expect(deps.markDigestSent).not.toHaveBeenCalled();
    expect(deps.loadTenderRows).not.toHaveBeenCalled();
  });

  it("сегодня уже отправляли — не шлём; вчера отправляли — шлём", async () => {
    const today = digestSetup({ users: [user({ digestSentAt: NOW - 30 * MIN })] });
    await runDigests(today.deps);
    expect(today.sent).toEqual([]);

    const yesterday = digestSetup({ users: [user({ digestSentAt: NOW - DAY })] });
    await runDigests(yesterday.deps);
    expect(yesterday.sent).toHaveLength(1);
  });

  it("сводка выключена у человека — не шлём", async () => {
    const { deps, sent } = digestSetup({ settings: { u1: { ...irkutskSettings, enabled: false } } });

    await runDigests(deps);

    expect(sent).toEqual([]);
  });

  it("настроек в аккаунте нет вовсе — действуют значения по умолчанию (включено, 08:00 по Москве)", async () => {
    const atMoscowMorning = Date.parse("2026-10-16T05:30:00Z");
    const { deps, sent } = digestSetup({ settings: {}, deps: { now: () => atMoscowMorning } });
    vi.mocked(deps.loadTenderRows).mockResolvedValue([dbRow("100", { created_at: iso(atMoscowMorning - H) })]);

    await runDigests(deps);

    expect(sent).toHaveLength(1);
  });

  it("пустая сводка не отправляется, но digest_sent_at обновляется", async () => {
    const { deps, sent } = digestSetup({ rows: [] });

    const result = await runDigests(deps);

    expect(sent).toEqual([]);
    expect(result.empty).toBe(1);
    expect(deps.markDigestSent).toHaveBeenCalledWith("u1", NOW);
  });

  it("новое считается с прошлой сводки; не отправляли раньше — за последние сутки", async () => {
    const rows = [dbRow("100", { created_at: iso(NOW - 30 * H) }), dbRow("101", { created_at: iso(NOW - 2 * H) })];

    const first = digestSetup({ rows });
    await runDigests(first.deps);
    expect(first.sent[0]?.subject).toContain("1 новая закупка");
    expect(vi.mocked(first.deps.loadTenderRows).mock.calls[0]?.[0].sinceMs).toBe(NOW - DAY);

    const later = digestSetup({ users: [user({ digestSentAt: NOW - 2 * DAY })], rows });
    await runDigests(later.deps);
    expect(later.sent[0]?.subject).toContain("2 новые закупки");
    expect(vi.mocked(later.deps.loadTenderRows).mock.calls[0]?.[0].sinceMs).toBe(NOW - 2 * DAY);
  });

  it("digestSince: глубже трёх суток не уходим", () => {
    expect(digestSince(null, NOW)).toBe(NOW - DAY);
    expect(digestSince(NOW - 10 * DAY, NOW)).toBe(NOW - 3 * DAY);
    expect(digestSince(NOW - 2 * DAY, NOW)).toBe(NOW - 2 * DAY);
  });

  it("строки закупок читаются один раз на прогон для всех, кому пора", async () => {
    const users = [user(), user({ id: "u2", email: "second@firma.ru" })];
    const { deps, sent } = digestSetup({
      users,
      deps: { env: { ADMIN_EMAILS: `${ADMIN},second@firma.ru` } },
    });

    await runDigests(deps);

    expect(sent.map((m) => m.to)).toEqual([ADMIN, "second@firma.ru"]);
    expect(deps.loadTenderRows).toHaveBeenCalledTimes(1);
  });

  it("воронка человека: номера закупок в работе передаются на чтение строк", async () => {
    const { deps } = digestSetup({
      data: { u1: accountData({ pipeline: { "555": { status: "ANALYZING" }, "556": { status: "SKIPPED" } } }) },
    });

    await runDigests(deps);

    expect(vi.mocked(deps.loadTenderRows).mock.calls[0]?.[0].regNumbers).toEqual(["555"]);
  });

  it("доступ закончился — сводку не шлём; оплачено или пробный период — шлём", async () => {
    const expired = user({ id: "u2", email: "expired@firma.ru", paidUntil: null, trialEndsAt: NOW - H });
    const trial = user({ id: "u3", email: "trial@firma.ru", paidUntil: null, trialEndsAt: NOW + DAY });
    const { deps, sent } = digestSetup({
      users: [expired, trial, user()],
      deps: { env: { NOTIFY_RECIPIENTS: "all", ADMIN_EMAILS: "" } },
    });

    await runDigests(deps);

    expect(sent.map((m) => m.to).sort()).toEqual([ADMIN, "trial@firma.ru"].sort());
  });

  describe("шлюз NOTIFY_RECIPIENTS", () => {
    const users = [user(), user({ id: "u2", email: "client@example.ru" })];

    it("по умолчанию — только админам; остальным ничего не шлём и не отмечаем", async () => {
      const { deps, sent } = digestSetup({ users });

      await runDigests(deps);

      expect(sent.map((m) => m.to)).toEqual([ADMIN]);
      expect(deps.markDigestSent).toHaveBeenCalledTimes(1);
      expect(deps.markDigestSent).not.toHaveBeenCalledWith("u2", NOW);
    });

    it("all — всем", async () => {
      const { deps, sent } = digestSetup({ users, deps: { env: { ADMIN_EMAILS: ADMIN, NOTIFY_RECIPIENTS: "all" } } });

      await runDigests(deps);

      expect(sent.map((m) => m.to)).toEqual([ADMIN, "client@example.ru"]);
    });

    it("off — никому, базу не читаем", async () => {
      const { deps, sent } = digestSetup({ users, deps: { env: { ADMIN_EMAILS: ADMIN, NOTIFY_RECIPIENTS: "off" } } });

      const result = await runDigests(deps);

      expect(result.skipped).toBe(true);
      expect(sent).toEqual([]);
      expect(deps.listUsers).not.toHaveBeenCalled();
    });
  });

  it("сбой почты у одного: не отмечен (повторится), остальные получают сводку", async () => {
    const users = [user(), user({ id: "u2", email: "second@firma.ru" })];
    const sendMail = vi.fn().mockRejectedValueOnce(new Error("SMTP недоступен")).mockResolvedValue(undefined);
    const { deps } = digestSetup({ users, deps: { sendMail, env: { ADMIN_EMAILS: `${ADMIN},second@firma.ru` } } });

    const result = await runDigests(deps);

    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(deps.markDigestSent).toHaveBeenCalledTimes(1);
    expect(deps.markDigestSent).toHaveBeenCalledWith("u2", NOW);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("SMTP недоступен"));
  });

  it("сбой базы не бросается наружу; почта не настроена — пропуск без обращения к базе", async () => {
    const broken = digestSetup({ deps: { listUsers: vi.fn(async () => Promise.reject(new Error("нет связи"))) } });
    await expect(runDigests(broken.deps)).resolves.toMatchObject({ sent: 0 });
    expect(broken.deps.log).toHaveBeenCalledWith(expect.stringContaining("нет связи"));

    const noMail = digestSetup({ deps: { smtpConfigured: () => false } });
    expect((await runDigests(noMail.deps)).skipped).toBe(true);
    expect(noMail.deps.listUsers).not.toHaveBeenCalled();
  });
});

describe("sendDigestNow — пробная сводка", () => {
  it("собирает и отправляет сейчас, возвращает число строк; digest_sent_at не трогает", async () => {
    const { deps, sent } = digestSetup({
      rows: [dbRow("100", { created_at: iso(NOW - 20 * H) }), dbRow("101", { created_at: iso(NOW - 2 * H) })],
    });

    const result = await sendDigestNow(ADMIN, deps);

    expect(result).toEqual({ sent: true, items: 2 });
    expect(sent[0]?.to).toBe(ADMIN);
    expect(deps.markDigestSent).not.toHaveBeenCalled();
    expect(vi.mocked(deps.loadTenderRows).mock.calls[0]?.[0].sinceMs).toBe(NOW - DAY);
  });

  it("за последние сутки: что старше — не в письме", async () => {
    const { deps } = digestSetup({ rows: [dbRow("100", { created_at: iso(NOW - 30 * H) })] });

    const result = await sendDigestNow(ADMIN, deps);

    expect(result.sent).toBe(false);
    expect(result.items).toBe(0);
    expect(result.reason).toContain("нечего");
  });

  it("работает и для не-админа при NOTIFY_RECIPIENTS=admins: это письмо на собственную почту", async () => {
    const { deps, sent } = digestSetup({
      users: [user({ email: "client@example.ru" })],
      deps: { env: { ADMIN_EMAILS: ADMIN } },
    });

    const result = await sendDigestNow("client@example.ru", deps);

    expect(result.sent).toBe(true);
    expect(sent[0]?.to).toBe("client@example.ru");
  });

  it("off — не отправляет и называет причину; нет аккаунта и нет почты — тоже", async () => {
    const off = digestSetup({ deps: { env: { NOTIFY_RECIPIENTS: "off" } } });
    expect(await sendDigestNow(ADMIN, off.deps)).toMatchObject({ sent: false, reason: expect.stringContaining("выключена") });

    const unknown = digestSetup({ users: [] });
    expect(await sendDigestNow("nobody@x.ru", unknown.deps)).toMatchObject({ sent: false, reason: "Аккаунт не найден" });

    const noMail = digestSetup({ deps: { smtpConfigured: () => false } });
    expect(await sendDigestNow(ADMIN, noMail.deps)).toMatchObject({ sent: false, reason: expect.stringContaining("не настроена") });
  });

  it("сбой почты не бросается: sent=false с понятной причиной", async () => {
    const { deps } = digestSetup({ deps: { sendMail: vi.fn(async () => Promise.reject(new Error("SMTP недоступен"))) } });

    const result = await sendDigestNow(ADMIN, deps);

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("Не удалось");
  });
});

describe("runFailureAlerts: сбой задачи — письмо администраторам", () => {
  const failed = {
    kind: "analysis" as const,
    id: "job-f",
    tenderId: "32616445639",
    requestedBy: "client@firma.ru",
    error: "canceling statement due to statement timeout (57014)",
    at: NOW - 2 * MIN,
  };

  it("каждому администратору — письмо с причиной, кто запускал и ссылкой; задача отмечена, повторно не шлётся", async () => {
    const { deps, sent } = setup({
      env: { ADMIN_EMAILS: `${ADMIN}, second@firma.ru` },
      listFailedJobs: vi.fn(async () => [failed]),
    });
    const result = await runFailureAlerts(deps);

    expect(result.sent).toBe(1);
    expect(sent.map((m) => m.to)).toEqual([ADMIN, "second@firma.ru"]);
    expect(sent[0]!.subject).toBe("ТендерФит: глубокий анализ не удался — Капитальный ремонт школы");
    expect(sent[0]!.text).toContain("client@firma.ru");
    expect(sent[0]!.text).toContain("57014");
    expect(sent[0]!.text).toContain("/tenders/32616445639?tab=analysis");

    const again = await runFailureAlerts(deps);
    expect(again.sent).toBe(0);
  });

  it("NOTIFY_RECIPIENTS=off или нет администраторов — ничего не шлётся", async () => {
    const off = setup({ env: { ADMIN_EMAILS: ADMIN, NOTIFY_RECIPIENTS: "off" }, listFailedJobs: vi.fn(async () => [failed]) });
    expect((await runFailureAlerts(off.deps)).skipped).toBe(true);
    const noAdmins = setup({ env: {}, listFailedJobs: vi.fn(async () => [failed]) });
    expect((await runFailureAlerts(noAdmins.deps)).skipped).toBe(true);
    expect(off.sent).toHaveLength(0);
  });

  it("письмо не ушло — отметка снята, следующая проверка повторит", async () => {
    const { deps, claimed } = setup({
      listFailedJobs: vi.fn(async () => [failed]),
      sendMail: vi.fn(async () => {
        throw new Error("SMTP недоступен");
      }),
    });
    const result = await runFailureAlerts(deps);
    expect(result.failed).toBe(1);
    expect(claimed.size).toBe(0);
  });
});
