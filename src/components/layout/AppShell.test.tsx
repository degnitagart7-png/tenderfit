import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/components/layout/AppShell";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/tenders"),
}));

// Вход в аккаунт к меню отношения не имеет: он ходит в сеть за сессией.
vi.mock("@/components/layout/AccountLink", () => ({ AccountLink: () => null }));

// Оболочка читает доступ из /api/auth/me; здесь он не важен — гость без ограничений.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ user: null, loginEnabled: false }), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mainMenuLabels(): string[] {
  // Первый <nav> без aria-label внутри боковой панели — «Главное».
  const aside = document.querySelector("aside") as HTMLElement;
  const nav = aside.querySelectorAll("nav")[0] as HTMLElement;
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent?.trim() ?? "");
}

describe("AppShell — боковое меню", () => {
  it("порядок пунктов: Закупки, Мои закупки, Смета, Сегодня, Отчёты", () => {
    render(<AppShell>содержимое</AppShell>);

    expect(mainMenuLabels()).toEqual(["Закупки", "Мои закупки", "Смета", "Сегодня", "Отчёты"]);
  });

  it("«Сегодня» стоит после «Сметы»", () => {
    render(<AppShell>содержимое</AppShell>);
    const labels = mainMenuLabels();

    expect(labels.indexOf("Сегодня")).toBe(labels.indexOf("Смета") + 1);
  });

  it("в меню нет плашки про демо и вымышленные данные", () => {
    render(<AppShell>содержимое</AppShell>);

    expect(screen.queryByText(/Демо/)).toBeNull();
    expect(screen.queryByText(/вымышленн/i)).toBeNull();
  });

  it("в шапке нет неработающей кнопки уведомлений", () => {
    render(<AppShell>содержимое</AppShell>);

    expect(screen.queryByRole("button", { name: "Уведомления" })).toBeNull();
  });

  it("пункт «Пользователи» в меню — только у администратора", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { email: "owner@firma.ru", access: { status: "admin", endsAt: null, plan: null, daysLeft: 0, hoursLeft: 0 } },
          loginEnabled: true,
        }),
        { status: 200 },
      ),
    );
    render(<AppShell>содержимое</AppShell>);

    const link = await screen.findByRole("link", { name: "Пользователи" });
    expect(link.getAttribute("href")).toBe("/admin/users");
  });

  it("гостю и обычному пользователю пункта «Пользователи» нет", async () => {
    render(<AppShell>содержимое</AppShell>);
    await Promise.resolve();

    expect(screen.queryByRole("link", { name: "Пользователи" })).toBeNull();
  });
});
