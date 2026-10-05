import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { AccountView } from "@/components/account/AccountView";

/** Личный кабинет: почта, смена пароля, выход; гостю — приглашение войти. */

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AccountView", () => {
  it("гость видит приглашение войти", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ user: null, loginEnabled: true }));
    render(<AccountView />);

    const link = await screen.findByRole("link", { name: /войти или зарегистрироваться/i });
    expect(link.getAttribute("href")).toBe("/login");
  });

  it("вошедший видит свою почту и ссылки на настройки", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ user: { email: "ivan@firma.ru" }, loginEnabled: true }));
    render(<AccountView />);

    expect(await screen.findByText("ivan@firma.ru")).toBeTruthy();
    expect(screen.getByRole("link", { name: /профили поиска/i }).getAttribute("href")).toBe("/settings/search");
  });

  it("смена пароля уходит на сервер и сообщает об успехе", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer({ user: { email: "ivan@firma.ru" }, loginEnabled: true }))
      .mockResolvedValueOnce(answer({ ok: true }));
    render(<AccountView />);
    await screen.findByText("ivan@firma.ru");
    fireEvent.change(screen.getByLabelText("Текущий пароль"), { target: { value: "старый-пароль-1" } });
    fireEvent.change(screen.getByLabelText("Новый пароль"), { target: { value: "новый-пароль-2" } });

    fireEvent.click(screen.getByRole("button", { name: /сменить пароль/i }));

    expect(await screen.findByText("Пароль изменён.")).toBeTruthy();
    const call = vi.mocked(fetch).mock.calls[1];
    expect(String(call?.[0])).toBe("/api/auth/password");
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ current: "старый-пароль-1", next: "новый-пароль-2" });
  });

  it("неверный текущий пароль — слова сервера", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer({ user: { email: "ivan@firma.ru" }, loginEnabled: true }))
      .mockResolvedValueOnce(answer({ error: "Текущий пароль неверен." }, 400));
    render(<AccountView />);
    await screen.findByText("ivan@firma.ru");
    fireEvent.change(screen.getByLabelText("Новый пароль"), { target: { value: "новый-пароль-2" } });

    fireEvent.click(screen.getByRole("button", { name: /сменить пароль/i }));

    expect(await screen.findByText("Текущий пароль неверен.")).toBeTruthy();
  });

  it("выход закрывает сессию и ведёт на страницу входа", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer({ user: { email: "ivan@firma.ru" }, loginEnabled: true }))
      .mockResolvedValueOnce(answer({ ok: true }));
    render(<AccountView />);
    await screen.findByText("ivan@firma.ru");

    fireEvent.click(screen.getByRole("button", { name: /выйти/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toBe("/api/auth/logout");
  });
});
