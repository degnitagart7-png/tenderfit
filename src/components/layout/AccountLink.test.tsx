import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const me = vi.fn();
const onSignedOut = vi.fn();
vi.mock("@/services/accountApiService", () => ({
  accountApiService: { me: (...a: unknown[]) => me(...a), logout: vi.fn(async () => undefined) },
}));
vi.mock("@/services/accountSync", () => ({
  accountSync: {
    startAutoPush: () => () => undefined,
    onSignedIn: async () => ({ deviceChanged: false }),
    onSignedOut: () => onSignedOut(),
  },
}));

import { AccountLink } from "@/components/layout/AccountLink";

afterEach(() => {
  cleanup();
  me.mockReset();
  onSignedOut.mockReset();
});

describe("AccountLink — личный кабинет справа вверху", () => {
  it("вошедший: иконка с первой буквой почты, меню с кабинетом, оплатой и выходом", async () => {
    me.mockResolvedValue({ user: { email: "client@example.ru" }, loginEnabled: true });
    render(<AccountLink />);

    const button = await screen.findByRole("button", { name: "Личный кабинет" });
    await waitFor(() => expect(button.textContent).toBe("C"));
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(button);
    expect(screen.getByRole("menuitem", { name: "Личный кабинет" }).getAttribute("href")).toBe("/account");
    expect(screen.getByRole("menuitem", { name: "Оплата и тарифы" }).getAttribute("href")).toBe("/billing");
    expect(screen.getByRole("menuitem", { name: "Выйти" })).toBeTruthy();
    expect(screen.getByText("client@example.ru")).toBeTruthy();
  });

  it("гость: в меню «Войти», без «Выйти»; кабинет и оплата доступны", async () => {
    me.mockResolvedValue({ user: null, loginEnabled: true });
    render(<AccountLink />);

    fireEvent.click(await screen.findByRole("button", { name: "Личный кабинет" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Войти" })).toBeTruthy());
    expect(screen.queryByRole("menuitem", { name: "Выйти" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Оплата и тарифы" })).toBeTruthy();
  });

  it("вход на сервере не настроен: «Войти» нет, иконка и оплата на месте", async () => {
    me.mockResolvedValue({ user: null, loginEnabled: false });
    render(<AccountLink />);

    fireEvent.click(await screen.findByRole("button", { name: "Личный кабинет" }));
    expect(screen.queryByRole("menuitem", { name: "Войти" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Оплата и тарифы" })).toBeTruthy();
  });

  it("Escape закрывает меню", async () => {
    me.mockResolvedValue({ user: null, loginEnabled: true });
    render(<AccountLink />);

    fireEvent.click(await screen.findByRole("button", { name: "Личный кабинет" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("выход стирает с устройства данные аккаунта", async () => {
    me.mockResolvedValue({ user: { email: "client@example.ru" }, loginEnabled: true });
    render(<AccountLink />);

    fireEvent.click(await screen.findByRole("button", { name: "Личный кабинет" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Выйти" }));

    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  });
  describe("часовой пояс для утренней сводки", () => {
    const readZone = (): unknown => {
      const raw = window.localStorage.getItem("tf.digestSettings");
      return raw === null ? undefined : (JSON.parse(raw) as { timeZone?: string }).timeZone;
    };

    beforeEach(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
        timeZone: "Asia/Irkutsk",
      } as Intl.ResolvedDateTimeFormatOptions);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("вошедший при первом открытии: пояс браузера сохраняется в настройки", async () => {
      me.mockResolvedValue({ user: { email: "client@example.ru" }, loginEnabled: true });
      render(<AccountLink />);

      await waitFor(() => expect(readZone()).toBe("Asia/Irkutsk"));
    });

    it("слияние за вкладку уже было — пояс всё равно запоминается (старый аккаунт без него)", async () => {
      window.sessionStorage.setItem("tenderfit.accountSynced", "1");
      me.mockResolvedValue({ user: { email: "client@example.ru" }, loginEnabled: true });
      render(<AccountLink />);

      await waitFor(() => expect(readZone()).toBe("Asia/Irkutsk"));
    });

    it("уже выбранный пояс не перезаписывается", async () => {
      window.localStorage.setItem("tf.digestSettings", JSON.stringify({ enabled: true, sendTime: "08:00", minFitScore: 50, timeZone: "Asia/Yakutsk" }));
      me.mockResolvedValue({ user: { email: "client@example.ru" }, loginEnabled: true });
      render(<AccountLink />);

      await screen.findByRole("button", { name: "Личный кабинет" });
      await waitFor(() => expect(me).toHaveBeenCalled());
      expect(readZone()).toBe("Asia/Yakutsk");
    });

    it("гость: настройки не создаются", async () => {
      me.mockResolvedValue({ user: null, loginEnabled: true });
      render(<AccountLink />);

      await screen.findByRole("button", { name: "Личный кабинет" });
      await waitFor(() => expect(me).toHaveBeenCalled());
      expect(window.localStorage.getItem("tf.digestSettings")).toBeNull();
    });
  });
});
