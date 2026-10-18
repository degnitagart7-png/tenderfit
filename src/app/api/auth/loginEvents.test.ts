import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  verifyCode: vi.fn(),
  register: vi.fn(),
  loginWithPassword: vi.fn(),
  resetPassword: vi.fn(),
}));
vi.mock("@/services/authRuntime", () => ({
  SESSION_COOKIE: "tf_session",
  getAuthService: () => auth,
  codeLoginEnabled: () => true,
}));
const record = vi.hoisted(() => vi.fn(async (_event: Record<string, unknown>) => undefined));
vi.mock("@/services/userEventLog", () => ({ recordUserEvent: record }));

import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as reset } from "@/app/api/auth/reset/route";
import { POST as verify } from "@/app/api/auth/verify/route";

/** Каждый успешный вход — событие login с способом входа; неудачный — нет (подбор чужих почт журнал не засоряет). */

let counter = 0;
function post(url: string, body: unknown): NextRequest {
  counter += 1;
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": `10.8.0.${String(counter)}` },
    body: JSON.stringify(body),
  });
}

const ok = { ok: true, token: "tok", user: { id: "u1", email: "ivan@firma.ru" }, maxAgeSec: 100 };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("событие login", () => {
  it("вход по паролю", async () => {
    auth.loginWithPassword.mockResolvedValue(ok);
    expect((await login(post("/api/auth/login", { email: "ivan@firma.ru", password: "пароль-12345" }))).status).toBe(200);
    expect(record).toHaveBeenCalledWith({ email: "ivan@firma.ru", kind: "login", detail: "пароль" });
  });

  it("регистрация", async () => {
    auth.register.mockResolvedValue(ok);
    await register(post("/api/auth/register", { email: "ivan@firma.ru", password: "пароль-12345", consent: true }));
    expect(record).toHaveBeenCalledWith({ email: "ivan@firma.ru", kind: "login", detail: "регистрация" });
  });

  it("вход по коду из письма", async () => {
    auth.verifyCode.mockResolvedValue(ok);
    await verify(post("/api/auth/verify", { email: "ivan@firma.ru", code: "123456" }));
    expect(record).toHaveBeenCalledWith({ email: "ivan@firma.ru", kind: "login", detail: "код из письма" });
  });

  it("восстановление пароля", async () => {
    auth.resetPassword.mockResolvedValue(ok);
    await reset(post("/api/auth/reset", { email: "ivan@firma.ru", code: "123456", password: "новый-пароль-1" }));
    expect(record).toHaveBeenCalledWith({ email: "ivan@firma.ru", kind: "login", detail: "восстановление пароля" });
  });

  it("неверный пароль и неверный код журнал не пишут", async () => {
    auth.loginWithPassword.mockResolvedValue({ ok: false, reason: "invalid" });
    auth.verifyCode.mockResolvedValue({ ok: false, reason: "invalid" });

    expect((await login(post("/api/auth/login", { email: "ivan@firma.ru", password: "неверный-1" }))).status).toBe(400);
    expect((await verify(post("/api/auth/verify", { email: "ivan@firma.ru", code: "000000" }))).status).toBe(400);

    expect(record).not.toHaveBeenCalled();
  });
});
