import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminFunnelResponse } from "@/app/api/admin/funnel/route";
import { AdminFunnel } from "@/components/admin/AdminFunnel";
import { FUNNEL_STEPS, type FunnelUserRow } from "@/domain/adminFunnel";

afterEach(cleanup);

const person = (email: string, over: Partial<FunnelUserRow> = {}): FunnelUserRow => ({
  email,
  registeredAt: "2026-10-10T08:00:00.000Z",
  reachedStep: 0,
  reachedLabel: "Зарегистрировались",
  lastActivityAt: "2026-10-16T08:00:00.000Z",
  trialDaysLeft: 3,
  status: "trial",
  hasSearchProfile: false,
  hasCompanyProfile: false,
  onboardingDone: false,
  tourDone: false,
  ...over,
});

const DATA: AdminFunnelResponse = {
  period: "all",
  generatedAt: "2026-10-18T12:00:00.000Z",
  warnings: [],
  registered: 4,
  users: [
    person("ivan@firma.ru", { reachedStep: 1 }),
    person("anna@firma.ru", { reachedStep: 2, trialDaysLeft: null, status: "expired" }),
    person("petr@firma.ru", { reachedStep: 6, trialDaysLeft: null, status: "paid" }),
    person("nina@firma.ru", { reachedStep: 0, lastActivityAt: null }),
  ],
  steps: FUNNEL_STEPS.map((definition, index) => {
    const counts = [4, 3, 2, 1, 1, 1, 1];
    const emails = [
      ["ivan@firma.ru", "anna@firma.ru", "petr@firma.ru", "nina@firma.ru"],
      ["ivan@firma.ru", "anna@firma.ru", "petr@firma.ru"],
      ["anna@firma.ru", "petr@firma.ru"],
      ["petr@firma.ru"],
      ["petr@firma.ru"],
      ["petr@firma.ru"],
      ["petr@firma.ru"],
    ][index] as string[];
    const stuck = [["nina@firma.ru"], ["ivan@firma.ru"], ["anna@firma.ru"], [], [], [], []][index] as string[];
    return {
      key: definition.key,
      label: definition.label,
      count: counts[index] as number,
      shareOfRegistered: (counts[index] as number) / 4,
      shareOfPrevious: index === 0 ? 1 : (counts[index] as number) / (counts[index - 1] as number),
      emails,
      stuckEmails: stuck,
    };
  }),
};

const props = { data: DATA, loading: false, error: null, period: "all" as const, onPeriodChange: () => undefined };

describe("AdminFunnel", () => {
  it("рисует все шаги: число, проценты, ширина полосы — доля от зарегистрировавшихся", () => {
    render(<AdminFunnel {...props} />);

    for (const definition of FUNNEL_STEPS) {
      expect(screen.getByTestId(`funnel-step-${definition.key}`)).toBeTruthy();
    }
    const profile = screen.getByTestId("funnel-step-profile");
    expect(within(profile).getByText("Заполнили профиль поиска")).toBeTruthy();
    expect(within(profile).getByText("3")).toBeTruthy();
    expect(within(profile).getByText("75% от зарегистрировавшихся")).toBeTruthy();
    expect(within(profile).getByText("75% от предыдущего шага")).toBeTruthy();
    expect((screen.getByTestId("funnel-bar-profile") as HTMLElement).style.width).toBe("75%");
    expect((screen.getByTestId("funnel-bar-feed") as HTMLElement).style.width).toBe("50%");
    // У первого шага сравнивать не с чем.
    expect(within(screen.getByTestId("funnel-step-registered")).queryByText(/от предыдущего/)).toBeNull();
  });

  it("клик по шагу раскрывает тех, кто застрял здесь, с остатком пробного и активностью; повторный клик сворачивает", () => {
    render(<AdminFunnel {...props} />);
    expect(screen.queryByTestId("funnel-people-profile")).toBeNull();

    fireEvent.click(within(screen.getByTestId("funnel-step-profile")).getByRole("button"));

    const panel = screen.getByTestId("funnel-people-profile");
    expect(within(panel).getByText("Застряли здесь: 1")).toBeTruthy();
    // Только застрявший на этом шаге, а не все, кто до него дошёл.
    expect(within(panel).getByText("ivan@firma.ru")).toBeTruthy();
    expect(within(panel).queryByText("anna@firma.ru")).toBeNull();
    expect(within(panel).getByText("пробный, ещё 3 дн.")).toBeTruthy();
    expect(within(panel).getByText(/был 16\.10\.2026/)).toBeTruthy();

    fireEvent.click(within(screen.getByTestId("funnel-step-profile")).getByRole("button"));
    expect(screen.queryByTestId("funnel-people-profile")).toBeNull();
  });

  it("истёкший, оплаченный и не заходивший подписаны словами", () => {
    render(<AdminFunnel {...props} />);

    fireEvent.click(within(screen.getByTestId("funnel-step-feed")).getByRole("button"));
    expect(within(screen.getByTestId("funnel-people-feed")).getByText("пробный истёк")).toBeTruthy();

    fireEvent.click(within(screen.getByTestId("funnel-step-registered")).getByRole("button"));
    expect(within(screen.getByTestId("funnel-people-registered")).getByText("не заходил")).toBeTruthy();

    // Последний шаг показывает оплативших.
    fireEvent.click(within(screen.getByTestId("funnel-step-paid")).getByRole("button"));
    const paid = screen.getByTestId("funnel-people-paid");
    expect(within(paid).getByText("Оплатили: 1")).toBeTruthy();
    expect(within(paid).getByText("оплачен")).toBeTruthy();
  });

  it("шаг, на котором никто не застрял, говорит об этом", () => {
    render(<AdminFunnel {...props} />);
    fireEvent.click(within(screen.getByTestId("funnel-step-tender")).getByRole("button"));
    expect(within(screen.getByTestId("funnel-people-tender")).getByText("Все, кто дошёл до этого шага, пошли дальше.")).toBeTruthy();
  });

  it("переключатель периода сообщает выбранное и отмечает активное", () => {
    const onPeriodChange = vi.fn();
    render(<AdminFunnel {...props} period="7d" onPeriodChange={onPeriodChange} />);

    expect(screen.getByRole("button", { name: "За 7 дней" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Все" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "За 30 дней" }));
    expect(onPeriodChange).toHaveBeenCalledWith("30d");
  });

  it("загрузка, ошибка, пустой период и предупреждения", () => {
    const { rerender } = render(<AdminFunnel {...props} data={null} loading />);
    expect(screen.getByText("Загружаю воронку…")).toBeTruthy();

    rerender(<AdminFunnel {...props} data={null} error="база недоступна" />);
    expect(screen.getByRole("alert").textContent).toContain("база недоступна");

    rerender(<AdminFunnel {...props} data={{ ...DATA, registered: 0, steps: [], users: [] }} />);
    expect(screen.getByText("За выбранный период регистраций нет.")).toBeTruthy();

    rerender(<AdminFunnel {...props} data={{ ...DATA, warnings: ["Журнал действий не создан"] }} />);
    expect(screen.getByText("Журнал действий не создан")).toBeTruthy();
  });
});
