import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TenderRow } from "@/domain/filtering";
import { FEED_SEEN_KEY } from "@/domain/searchMarker";
import { STORAGE_KEYS } from "@/lib/storage";
import { DAY, H, NOW, contractor, dbRow, stroyka, toRow } from "@/test/digestFixtures";

const me = vi.fn();
let rows: TenderRow[] = [];
vi.mock("@/services/accountApiService", () => ({
  accountApiService: { me: (...a: unknown[]) => me(...a) },
}));
// Графики рисует recharts: ему нужен ResizeObserver, которого в jsdom нет, а тест — про состав отчёта.
vi.mock("@/components/reports/ReportCharts", () => ({
  VerdictDonut: () => <div>Распределение закупок</div>,
  RegionBars: () => <div>Закупки по регионам</div>,
}));
vi.mock("@/hooks/useTenderData", () => ({
  useTenderData: () => ({ rows, loading: false, error: null, reload: vi.fn(), syncKontur: vi.fn(), syncState: {} }),
}));

import { DailyReportView } from "@/components/reports/DailyReportView";

const iso = (ms: number): string => new Date(ms).toISOString();
const put = (key: string, value: unknown): void => window.localStorage.setItem(key, JSON.stringify(value));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW); // 09:00 в Иркутске
  window.localStorage.clear();
  me.mockResolvedValue({ user: { email: "client@example.ru" }, loginEnabled: true });
  put(STORAGE_KEYS.profile, contractor);
  put(STORAGE_KEYS.searchProfiles, [stroyka]);
  put(STORAGE_KEYS.settings, { enabled: true, sendTime: "08:00", minFitScore: 0, timeZone: "Asia/Irkutsk" });
  rows = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  me.mockReset();
});

/** Рисует отчёт и ждёт ответа `me()`: иначе обновление состояния приходит уже после теста. */
async function renderReport(): Promise<void> {
  render(<DailyReportView />);
  await act(async () => {
    await Promise.resolve();
  });
}

const section = (title: RegExp): HTMLElement => {
  const heading = screen.getByRole("heading", { name: title });
  return heading.closest("section") as HTMLElement;
};

describe("DailyReportView — отчёт на тех же данных, что письмо", () => {
  it("строка про почту: «Сводка придёт завтра в 08:00 (Иркутск) на почту …»", async () => {
    await renderReport();

    await waitFor(() => expect(screen.getByTestId("digest-mail-line").textContent).toContain("client@example.ru"));
    expect(screen.getByTestId("digest-mail-line").textContent).toContain("Сводка придёт завтра в 08:00 (Иркутск) на почту client@example.ru");
  });

  it("до времени сводки — «сегодня»", async () => {
    vi.setSystemTime(Date.parse("2026-10-15T22:00:00Z")); // 06:00 в Иркутске
    await renderReport();

    await waitFor(() => expect(screen.getByTestId("digest-mail-line").textContent).toContain("client@example.ru"));
    expect(screen.getByTestId("digest-mail-line").textContent).toContain("Сводка придёт сегодня в 08:00 (Иркутск)");
  });

  it("сводка выключена: «Сводка на почту выключена — включить» со ссылкой на настройки", async () => {
    put(STORAGE_KEYS.settings, { enabled: false, sendTime: "08:00", minFitScore: 0, timeZone: "Asia/Irkutsk" });
    await renderReport();

    const line = screen.getByTestId("digest-mail-line");
    expect(line.textContent).toContain("Сводка на почту выключена");
    expect(within(line).getByRole("link", { name: "включить" }).getAttribute("href")).toBe("/settings/notifications");
  });

  it("не вошёл — предлагает войти, а не называет несуществующую почту", async () => {
    me.mockResolvedValue({ user: null, loginEnabled: true });
    await renderReport();

    await waitFor(() => expect(screen.getByTestId("digest-mail-line").textContent).toContain("войдите в аккаунт"));
  });

  it("три раздела в составе письма: новые по профилю, закрываются в 48 часов, в работе", async () => {
    put(FEED_SEEN_KEY, iso(NOW - 6 * H));
    put(STORAGE_KEYS.pipeline, { "300": { tenderId: "300", status: "ANALYZING", updatedAt: iso(NOW), note: null } });
    rows = [
      toRow(dbRow("100", { subject: "Строительство школы в Улан-Удэ", created_at: iso(NOW - 2 * H) })),
      toRow(dbRow("101", { subject: "Старая закупка по стройке", created_at: iso(NOW - 3 * DAY) })),
      toRow(dbRow("200", { subject: "Строительство склада", created_at: iso(NOW - 3 * DAY), submission_end: iso(NOW + 20 * H) })),
      toRow(dbRow("300", { subject: "Услуги связи", region: "Москва", created_at: iso(NOW - 3 * DAY), submission_end: iso(NOW + 5 * DAY) })),
    ];
    await renderReport();

    const fresh = section(/^Новые/);
    expect(within(fresh).getByText("Строительство школы в Улан-Удэ")).toBeTruthy();
    expect(within(fresh).queryByText("Старая закупка по стройке")).toBeNull(); // появилась до прошлого захода в ленту
    expect(within(fresh).getByRole("link", { name: "Строительство школы в Улан-Удэ" }).getAttribute("href")).toBe("/tenders/100");

    const closing = section(/^Закрываются в 48 часов/);
    expect(within(closing).getByText("Строительство склада")).toBeTruthy();
    // срок печатается по поясу клиента: NOW + 20 ч = 16.10 21:00 UTC = 17.10 05:00 в Иркутске
    expect(within(closing).getByText(/подача до 17\.10 05:00/)).toBeTruthy();

    const inWork = section(/^В работе/);
    expect(within(inWork).getByText("Услуги связи")).toBeTruthy();
  });

  it("без отметки визита «новое» — за сутки; об этом сказано", async () => {
    rows = [
      toRow(dbRow("100", { subject: "Строительство школы", created_at: iso(NOW - 5 * H) })),
      toRow(dbRow("101", { subject: "Строительство давнее", created_at: iso(NOW - 30 * H) })),
    ];
    await renderReport();

    expect(screen.getByText(/Новое за последние сутки/)).toBeTruthy();
    const fresh = section(/^Новые/);
    expect(within(fresh).getByText("Строительство школы")).toBeTruthy();
    expect(within(fresh).queryByText("Строительство давнее")).toBeNull();
  });

  it("новых больше десяти — «…и ещё N в ленте»", async () => {
    rows = Array.from({ length: 13 }, (_, i) => toRow(dbRow(`4${String(i).padStart(2, "0")}`, { created_at: iso(NOW - H) })));
    await renderReport();

    expect(screen.getByRole("heading", { name: "Новые (13)" })).toBeTruthy();
    expect(within(section(/^Новые/)).getAllByRole("listitem")).toHaveLength(10);
    expect(within(section(/^Новые/)).getByText(/…и ещё 3 в/)).toBeTruthy();
  });

  it("пусто: честное «Пока нечего сообщить», разделы объясняют почему", async () => {
    await renderReport();

    expect(screen.getByText("Пока нечего сообщить")).toBeTruthy();
    expect(screen.getByText("Горящих сроков нет.")).toBeTruthy();
  });

  it("профиля поиска нет — раздел «Новые» говорит, что делать", async () => {
    window.localStorage.removeItem(STORAGE_KEYS.searchProfiles);
    await renderReport();

    expect(screen.getByText(/Добавьте профиль со словами в разделе «Что ищем»/)).toBeTruthy();
  });

  it("графики по всей базе остались ниже разделов", async () => {
    rows = [toRow(dbRow("100"))];
    await renderReport();

    expect(screen.getByText("Распределение закупок")).toBeTruthy();
    expect(screen.getByText("Закупки по регионам")).toBeTruthy();
  });
});
