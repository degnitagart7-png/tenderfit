import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountLink } from "@/components/layout/AccountLink";

/**
 * Вход и выход в боковой панели: гость видит «Войти», вошедший — почту и
 * «Выйти», а когда вход на сервере не настроен, ссылки нет вовсе.
 */

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AccountLink", () => {
  it("гость: ссылка «Войти» на страницу входа", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ user: null, loginEnabled: true }));
    render(<AccountLink />);

    const link = await screen.findByRole("link", { name: /войти/i });

    expect(link.getAttribute("href")).toBe("/login");
  });

  it("вход не настроен — ничего не показывает", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ user: null, loginEnabled: false }));
    const { container } = render(<AccountLink />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(container.textContent).toBe("");
  });

  it("сервер не ответил — как гость без ссылки, без ошибки на странице", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("сеть"));
    const { container } = render(<AccountLink />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(container.textContent).toBe("");
  });

  it("вошедший: почта и «Выйти»; выход закрывает сессию и возвращает «Войти»", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer({ user: { email: "ivan@firma.ru" }, loginEnabled: true }))
      .mockResolvedValueOnce(answer({ searchProfiles: [], companyProfile: null }))
      .mockResolvedValueOnce(answer({ ok: true }));
    render(<AccountLink />);

    expect((await screen.findByRole("link", { name: /кабинет: ivan@firma\.ru/i })).getAttribute("href")).toBe("/account");
    fireEvent.click(screen.getByRole("button", { name: /выйти/i }));

    expect(await screen.findByRole("link", { name: /войти/i })).toBeTruthy();
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("/api/auth/logout");
  });
});
