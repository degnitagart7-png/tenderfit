import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installAccessFetchGuard } from "@/lib/accessClient";

/**
 * Обёртка над fetch: 401 уводит на вход, 402 сообщает об окончании доступа,
 * ответ при этом возвращается как есть; /api/auth/* и чужие адреса не трогаются.
 */

const onLoginRequired = vi.fn();
const onExpired = vi.fn();
let original: typeof fetch;
let remove: () => void;

function respondWith(status: number): void {
  window.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "текст сервера" }), { status })) as typeof fetch;
}

beforeEach(() => {
  onLoginRequired.mockReset();
  onExpired.mockReset();
  original = window.fetch;
});

afterEach(() => {
  remove?.();
  window.fetch = original;
});

function install(): void {
  remove = installAccessFetchGuard({ onLoginRequired, onExpired });
}

describe("installAccessFetchGuard", () => {
  it("401 на ручке приложения — на вход; ответ доходит вызывающему", async () => {
    respondWith(401);
    install();

    const response = await fetch("/api/tenders");

    expect(onLoginRequired).toHaveBeenCalledTimes(1);
    expect(onExpired).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "текст сервера" });
  });

  it("402 — доступ закончился: сообщается один раз на запрос, вход не требуется", async () => {
    respondWith(402);
    install();

    const response = await fetch("/api/estimate", { method: "POST" });

    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(onLoginRequired).not.toHaveBeenCalled();
    expect(response.status).toBe(402);
  });

  it("обычные ответы и ошибки пропускаются молча", async () => {
    install();
    for (const status of [200, 400, 403, 404, 500, 503]) {
      respondWith(status);
      // Обёртка поставлена поверх прежнего fetch: ставим новый ответ под ней.
      remove();
      install();
      await fetch("/api/tenders");
    }

    expect(onLoginRequired).not.toHaveBeenCalled();
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("/api/auth/* не трогается: там 401 — ответ формы, а не потеря сессии", async () => {
    respondWith(401);
    install();

    await fetch("/api/auth/password", { method: "POST" });
    await fetch("/api/auth/me");

    expect(onLoginRequired).not.toHaveBeenCalled();
  });

  it("чужой адрес не трогается", async () => {
    respondWith(401);
    install();

    await fetch("https://other.example/api/tenders");

    expect(onLoginRequired).not.toHaveBeenCalled();
  });

  it("повторная установка не вкладывает обёртки: обработчик срабатывает один раз", async () => {
    respondWith(401);
    install();
    installAccessFetchGuard({ onLoginRequired, onExpired });

    await fetch("/api/tenders");

    expect(onLoginRequired).toHaveBeenCalledTimes(1);
  });

  it("снятие возвращает исходный fetch", async () => {
    respondWith(401);
    const underlying = window.fetch;
    install();

    remove();

    expect(window.fetch).toBe(underlying);
  });
});
