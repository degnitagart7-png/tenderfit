import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminUsersPage from "@/app/(app)/admin/users/page";

/** Страница «Пользователи»: сводка, сортируемая таблица, журнал по клику, заглушка для не-администратора. */

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const row = (over: Record<string, unknown>) => ({
  email: "ivan@firma.ru",
  registeredAt: "2026-10-11T08:00:00.000Z",
  lastLoginAt: "2026-10-14T06:00:00.000Z",
  accessStatus: "trial",
  trialEndsAt: "2026-10-18T08:00:00.000Z",
  paidUntil: null,
  plan: null,
  logins30d: 3,
  activeDays7d: 2,
  activeDays30d: 4,
  lastActivityAt: "2026-10-14T06:00:00.000Z",
  deepAnalyses30d: 5,
  estimates30d: 1,
  liveSearches30d: 2,
  errors7d: 0,
  spend30d: 31.5,
  spendTotal: 40,
  ...over,
});

const LIST = {
  generatedAt: "2026-10-14T09:00:00.000Z",
  warnings: [],
  summary: {
    usersTotal: 4,
    newLast7d: 2,
    activeToday: 1,
    active7d: 3,
    active30d: 4,
    payingNow: 1,
    onTrial: 2,
    expired: 0,
    errors7d: 2,
    spendToday: 12.5,
    spend7d: 90,
    spend30d: 700,
    spendTotal: 1117,
    spendUnattributed: 1000,
    spendBenchExcluded: 0,
  },
  users: [
    row({}),
    row({ email: "anna@firma.ru", accessStatus: "paid", plan: "calc", errors7d: 2, spend30d: 80, spendTotal: 90, activeDays7d: 5, activeDays30d: 9 }),
    row({ email: "owner@firma.ru", accessStatus: "admin", spend30d: 0, spendTotal: 0 }),
  ],
};

const EVENTS = {
  email: "anna@firma.ru",
  eventsAvailable: true,
  items: [
    { at: "2026-10-14T08:00:00.000Z", kind: "error", label: "Ошибка сервиса", ok: false, tenderId: null, detail: "GET /api/tenders: база недоступна", source: "event" },
    { at: "2026-10-14T07:00:00.000Z", kind: "deep_analysis", label: "Глубокий анализ", ok: true, tenderId: "0373200123426000001", detail: null, source: "event" },
    { at: "2026-10-14T06:00:00.000Z", kind: "analysis_job", label: "Глубокий анализ не выполнен", ok: false, tenderId: "0373200123426000002", detail: "нет документов", source: "analysis_job" },
    { at: "2026-10-14T05:00:00.000Z", kind: "deep_analysis", label: "Глубокий анализ", ok: false, tenderId: null, detail: "отказ: лимит", source: "event" },
  ],
};

const FUNNEL_STEP_KEYS = ["registered", "profile", "feed", "tender", "analysis", "estimate", "paid"] as const;
const FUNNEL = {
  period: "all",
  generatedAt: "2026-10-14T09:00:00.000Z",
  warnings: [],
  registered: 2,
  steps: FUNNEL_STEP_KEYS.map((key, index) => ({
    key,
    label: `Шаг ${key}`,
    count: index === 0 ? 2 : index < 3 ? 1 : 0,
    shareOfRegistered: index === 0 ? 1 : index < 3 ? 0.5 : 0,
    shareOfPrevious: index === 0 ? 1 : index < 3 ? 1 : 0,
    emails: index === 0 ? ["ivan@firma.ru", "anna@firma.ru"] : index < 3 ? ["anna@firma.ru"] : [],
    stuckEmails: index === 0 ? ["ivan@firma.ru"] : index === 2 ? ["anna@firma.ru"] : [],
  })),
  users: [
    { email: "ivan@firma.ru", registeredAt: "2026-10-11T08:00:00.000Z", reachedStep: 0, reachedLabel: "Шаг registered", lastActivityAt: null, trialDaysLeft: 4, status: "trial", hasSearchProfile: false, hasCompanyProfile: false, onboardingDone: false, tourDone: false },
    { email: "anna@firma.ru", registeredAt: "2026-10-10T08:00:00.000Z", reachedStep: 2, reachedLabel: "Шаг feed", lastActivityAt: "2026-10-13T08:00:00.000Z", trialDaysLeft: null, status: "expired", hasSearchProfile: true, hasCompanyProfile: true, onboardingDone: true, tourDone: false },
  ],
};

/** Ответы по адресам: таблица, журнал и воронка — отдельные ручки; переопределяются точечно. */
function routeFetch(over: { users?: () => Response; funnel?: () => Response } = {}) {
  return vi.fn(async (url: string) => {
    const path = String(url);
    if (path.startsWith("/api/admin/users/events")) return answer(EVENTS);
    if (path.startsWith("/api/admin/funnel")) return over.funnel ? over.funnel() : answer(FUNNEL);
    return over.users ? over.users() : answer(LIST);
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", routeFetch());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const emailsInOrder = (): string[] =>
  screen
    .getAllByTestId(/^user-row-/)
    .map((tr) => tr.getAttribute("data-testid")?.replace("user-row-", "") ?? "");

describe("страница «Пользователи»", () => {
  it("показывает сводку: пользователи, активность, доступ, ошибки и расход в рублях", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("ivan@firma.ru");

    const summary = screen.getByLabelText("Сводка");
    const tile = (label: string) => within(summary).getByText(label).parentElement as HTMLElement;
    expect(tile("Пользователей").textContent).toContain("4");
    expect(tile("Новых за 7 дней").textContent).toContain("2");
    expect(tile("Активны сегодня").textContent).toContain("1");
    expect(tile("Активны за 7 дней").textContent).toContain("3");
    expect(tile("Платят").textContent).toContain("1");
    expect(tile("На пробном").textContent).toContain("2");
    expect(tile("Ошибок за 7 дней").textContent).toContain("2");
    expect(tile("Потрачено на ИИ сегодня").textContent).toMatch(/12,50\s*₽/);
    expect(tile("Потрачено на ИИ всего").textContent).toMatch(/1\s?117,00\s*₽/);
    expect(tile("Без привязки к пользователю").textContent).toMatch(/1\s?000,00\s*₽/);
  });

  it("таблица: строки пользователей, статусы доступа, дни активности 7 / 30 и расход", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("anna@firma.ru");

    const anna = screen.getByTestId("user-row-anna@firma.ru");
    expect(within(anna).getByText("Оплачен")).toBeTruthy();
    expect(within(anna).getByText("5 / 9")).toBeTruthy();
    expect(within(anna).getByText(/80,00\s*₽/)).toBeTruthy();
    expect(within(screen.getByTestId("user-row-owner@firma.ru")).getByText("Администратор")).toBeTruthy();
    expect(within(screen.getByTestId("user-row-ivan@firma.ru")).getByText("Пробный")).toBeTruthy();
  });

  it("сортировка по клику на заголовок: сначала по убыванию, повторный клик — по возрастанию", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("anna@firma.ru");

    fireEvent.click(screen.getByRole("button", { name: "₽ всего" }));
    expect(emailsInOrder()).toEqual(["anna@firma.ru", "ivan@firma.ru", "owner@firma.ru"]);

    fireEvent.click(screen.getByRole("button", { name: "₽ всего" }));
    expect(emailsInOrder()).toEqual(["owner@firma.ru", "ivan@firma.ru", "anna@firma.ru"]);

    fireEvent.click(screen.getByRole("button", { name: "Почта" }));
    expect(emailsInOrder()).toEqual(["anna@firma.ru", "ivan@firma.ru", "owner@firma.ru"]);
  });

  it("клик по строке раскрывает журнал: действия, результат, ссылка на закупку; ошибки выделены", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("anna@firma.ru");

    fireEvent.click(screen.getByRole("button", { name: "Журнал anna@firma.ru" }));

    expect(await screen.findByText("Журнал: anna@firma.ru")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/admin/users/events?email=anna%40firma.ru")).toBe(true);
    expect(screen.getByText("GET /api/tenders: база недоступна")).toBeTruthy();
    expect(screen.getByText("нет документов")).toBeTruthy();

    const link = screen.getByRole("link", { name: "0373200123426000001" });
    expect(link.getAttribute("href")).toBe("/tenders/0373200123426000001");

    // Два упавших (ошибка сервиса, упавшее задание) помечены «Ошибка», отказ по лимиту — «Отказ».
    expect(screen.getAllByText("Ошибка").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Отказ")).toBeTruthy();
    const failedRows = document.querySelectorAll('tr[data-failed="true"]');
    expect(failedRows.length).toBe(3);

    // Повторный клик сворачивает журнал.
    fireEvent.click(screen.getByRole("button", { name: "Журнал anna@firma.ru" }));
    expect(screen.queryByText("Журнал: anna@firma.ru")).toBeNull();
  });

  it("403 — «Раздел только для администратора», таблицы нет", async () => {
    vi.stubGlobal("fetch", routeFetch({ users: () => answer({ error: "Раздел только для администратора" }, 403) }));
    render(<AdminUsersPage />);

    expect(await screen.findByText("Раздел только для администратора")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("другая ошибка сервера показана сообщением, страница не падает", async () => {
    vi.stubGlobal("fetch", routeFetch({ users: () => answer({ error: "база недоступна" }, 500) }));
    render(<AdminUsersPage />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("база недоступна");
  });

  it("предупреждение сервера (журнал не создан) выводится над сводкой", async () => {
    vi.stubGlobal("fetch", routeFetch({ users: () => answer({ ...LIST, warnings: ["Журнал действий не создан: примените миграцию"] }) }));
    render(<AdminUsersPage />);

    expect(await screen.findByText(/Журнал действий не создан/)).toBeTruthy();
  });

  it("кнопка «Обновить» перечитывает данные", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("anna@firma.ru");
    const before = vi.mocked(fetch).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /обновить/i }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBe(before + 2));
  });

  it("вверху страницы воронка: шаги и раскрытие «застряли»; период переключается новым запросом", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("anna@firma.ru");

    expect(await screen.findByTestId("funnel-steps")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("funnel-step-feed")).getByRole("button"));
    expect(within(screen.getByTestId("funnel-people-feed")).getByText("anna@firma.ru")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "За 7 дней" }));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/admin/funnel?period=7d")).toBe(true),
    );
  });

  it("воронка не загрузилась — ошибка в её карточке, таблица пользователей на месте", async () => {
    vi.stubGlobal("fetch", routeFetch({ funnel: () => answer({ error: "воронка недоступна" }, 500) }));
    render(<AdminUsersPage />);

    expect(await screen.findByText(/Не удалось загрузить воронку: воронка недоступна/)).toBeTruthy();
    expect(await screen.findByText("anna@firma.ru")).toBeTruthy();
  });

  it("таблица лежит в контейнере с горизонтальной прокруткой — страница не ползёт вбок", async () => {
    render(<AdminUsersPage />);
    await screen.findByText("anna@firma.ru");

    expect(screen.getByRole("table").parentElement?.className).toContain("overflow-x-auto");
  });
});
