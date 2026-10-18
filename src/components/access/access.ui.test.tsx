import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ value: "/tenders" }));
const redirectToLogin = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));
vi.mock("@/components/layout/AccountLink", () => ({ AccountLink: () => null }));
vi.mock("@/lib/accessClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/accessClient")>();
  return { ...original, redirectToLogin };
});

import { ExpiredScreen } from "@/components/access/ExpiredScreen";
import { TrialBanner } from "@/components/access/TrialBanner";
import { announceExpired } from "@/lib/accessClient";
import { AppShell } from "@/components/layout/AppShell";
import { OPERATOR } from "@/lib/legal";
import type { AccessInfo } from "@/domain/access";

/**
 * Оболочка приложения и доступ: баннер пробного периода, экран «Пробный период
 * закончился», уход на вход без сессии. Доступ приходит из /api/auth/me.
 */

const H = 3_600_000;

function access(over: Partial<AccessInfo>): AccessInfo {
  return { status: "trial", endsAt: new Date(Date.now() + 50 * H).toISOString(), plan: null, daysLeft: 3, hoursLeft: 50, ...over };
}

/** Оболочка оборачивает window.fetch, поэтому вызовы считаем по исходной заглушке. */
let meFetch = vi.fn();

function stubMe(user: { email: string; access?: AccessInfo } | null, loginEnabled = true) {
  meFetch = vi.fn(async () => new Response(JSON.stringify({ user, loginEnabled, codeLoginEnabled: false }), { status: 200 }));
  vi.stubGlobal("fetch", meFetch);
}

beforeEach(() => {
  pathname.value = "/tenders";
  redirectToLogin.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TrialBanner", () => {
  it("«Пробный период: осталось 2 дня · Выбрать тариф», ссылка ведёт на оплату", () => {
    render(<TrialBanner access={access({ daysLeft: 2, hoursLeft: 40 })} />);

    const banner = screen.getByTestId("trial-banner");
    expect(banner.textContent).toMatch(/Пробный период: осталось 2 дня/);
    expect(banner.getAttribute("data-last-day")).toBe("false");
    expect((screen.getByRole("link", { name: "Выбрать тариф" }) as HTMLAnchorElement).getAttribute("href")).toBe("/billing");
  });

  it("последние сутки: часы и горчичный цвет", () => {
    render(<TrialBanner access={access({ daysLeft: 1, hoursLeft: 5 })} />);

    const banner = screen.getByTestId("trial-banner");
    expect(banner.textContent).toMatch(/осталось 5 часов/);
    expect(banner.getAttribute("data-last-day")).toBe("true");
    expect(banner.className).toMatch(/mustard/);
  });

  it.each(["paid", "admin", "expired"] as const)("статус %s — баннера нет", (status) => {
    render(<TrialBanner access={access({ status })} />);

    expect(screen.queryByTestId("trial-banner")).toBeNull();
  });

  it("доступ неизвестен — баннера нет", () => {
    render(<TrialBanner access={null} />);

    expect(screen.queryByTestId("trial-banner")).toBeNull();
  });
});

describe("ExpiredScreen", () => {
  it("заголовок, что получит после оплаты, переход к тарифам и «Написать нам» на почту оператора", () => {
    render(<ExpiredScreen email="ivan@firma.ru" />);

    expect(screen.getByRole("heading", { name: "Пробный период закончился" })).toBeTruthy();
    expect(screen.getByText(/Глубокий анализ документации/)).toBeTruthy();
    expect(screen.getByText(/ivan@firma.ru/)).toBeTruthy();
    expect((screen.getByRole("link", { name: /Выбрать тариф/ }) as HTMLAnchorElement).getAttribute("href")).toBe("/billing");
    const mail = screen.getByRole("link", { name: /Написать нам/ }) as HTMLAnchorElement;
    expect(mail.getAttribute("href")).toMatch(new RegExp(`^mailto:${OPERATOR.email}`));
  });
});

describe("AppShell и доступ", () => {
  it("пробный период идёт: баннер над страницей, страница на месте", async () => {
    stubMe({ email: "ivan@firma.ru", access: access({ daysLeft: 3 }) });

    render(<AppShell>содержимое страницы</AppShell>);

    expect(await screen.findByTestId("trial-banner")).toBeTruthy();
    expect(screen.getByText("содержимое страницы")).toBeTruthy();
    expect(screen.queryByTestId("expired-screen")).toBeNull();
  });

  it("оплачено — ни баннера, ни заглушки", async () => {
    stubMe({ email: "ivan@firma.ru", access: access({ status: "paid", plan: "calc" }) });

    render(<AppShell>содержимое страницы</AppShell>);

    await waitFor(() => expect(meFetch).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId("trial-banner")).toBeNull();
    expect(screen.getByText("содержимое страницы")).toBeTruthy();
  });

  it("пробный период закончился: вместо страницы экран с тарифами", async () => {
    stubMe({ email: "ivan@firma.ru", access: access({ status: "expired", endsAt: null, daysLeft: 0, hoursLeft: 0 }) });

    render(<AppShell>содержимое страницы</AppShell>);

    expect(await screen.findByTestId("expired-screen")).toBeTruthy();
    expect(screen.queryByText("содержимое страницы")).toBeNull();
    // Меню остаётся: можно перейти к оплате и настройкам.
    expect(screen.getAllByRole("link", { name: "Оплата и тарифы" }).length).toBeGreaterThan(0);
  });

  it.each(["/billing", "/account", "/settings/profile", "/settings/search"])(
    "истёк, но %s открыт: страница на месте",
    async (path) => {
      pathname.value = path;
      stubMe({ email: "ivan@firma.ru", access: access({ status: "expired", endsAt: null, daysLeft: 0, hoursLeft: 0 }) });

      render(<AppShell>содержимое страницы</AppShell>);

      await waitFor(() => expect(meFetch).toHaveBeenCalled());
      await act(async () => undefined);
      expect(screen.getByText("содержимое страницы")).toBeTruthy();
      expect(screen.queryByTestId("expired-screen")).toBeNull();
    },
  );

  it("ответ 402 посреди работы превращает страницу в экран «Пробный период закончился»", async () => {
    stubMe({ email: "ivan@firma.ru", access: access({}) });
    render(<AppShell>содержимое страницы</AppShell>);
    await screen.findByTestId("trial-banner");

    act(() => announceExpired());

    expect(await screen.findByTestId("expired-screen")).toBeTruthy();
  });

  it("сессии нет, а вход настроен — уход на /login", async () => {
    stubMe(null, true);

    render(<AppShell>содержимое страницы</AppShell>);

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalledTimes(1));
  });

  it("вход не настроен на сервере — страница работает как гостевая, без перехода", async () => {
    stubMe(null, false);

    render(<AppShell>содержимое страницы</AppShell>);

    await waitFor(() => expect(meFetch).toHaveBeenCalled());
    await act(async () => undefined);
    expect(redirectToLogin).not.toHaveBeenCalled();
    expect(screen.getByText("содержимое страницы")).toBeTruthy();
  });

  it("сеть не ответила — страница не ломается", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("сеть"); }));

    render(<AppShell>содержимое страницы</AppShell>);

    await act(async () => undefined);
    expect(screen.getByText("содержимое страницы")).toBeTruthy();
    expect(redirectToLogin).not.toHaveBeenCalled();
  });
});
