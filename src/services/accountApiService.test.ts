import { afterEach, describe, expect, it, vi } from "vitest";
import { accountApiService } from "@/services/accountApiService";

/**
 * `/api/auth/me` при открытии страницы спрашивали от двух до четырёх раз
 * (оболочка, ссылка на аккаунт, синхронизация). Одновременные вызовы делят один
 * запрос; вход и выход сбрасывают ответ.
 */

function stubFetch(handler: (url: string) => unknown) {
  const spy = vi.fn(async (url: string) => {
    const body = handler(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("accountApiService.me", () => {
  it("четыре одновременных вызова — один запрос", async () => {
    const spy = stubFetch(() => ({ user: { email: "a@b.c" }, loginEnabled: true }));

    const all = await Promise.all([
      accountApiService.me(),
      accountApiService.me(),
      accountApiService.me(),
      accountApiService.me(),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(all.every((state) => state.user?.email === "a@b.c")).toBe(true);
  });

  it("выход сбрасывает ответ: следующий вызов спрашивает сервер", async () => {
    let signedIn = true;
    const spy = stubFetch((url) =>
      url.includes("/logout") ? { ok: true } : { user: signedIn ? { email: "a@b.c" } : null, loginEnabled: true },
    );

    expect((await accountApiService.me()).user).not.toBeNull();
    signedIn = false;
    await accountApiService.logout();
    expect((await accountApiService.me()).user).toBeNull();

    expect(spy.mock.calls.filter((c) => String(c[0]).includes("/auth/me"))).toHaveLength(2);
  });

  it("вход сбрасывает ответ", async () => {
    let signedIn = false;
    stubFetch((url) =>
      url.includes("/login") ? { user: { email: "a@b.c" } } : { user: signedIn ? { email: "a@b.c" } : null, loginEnabled: true },
    );

    expect((await accountApiService.me()).user).toBeNull();
    signedIn = true;
    await accountApiService.login("a@b.c", "pw");

    expect((await accountApiService.me()).user?.email).toBe("a@b.c");
  });
});
