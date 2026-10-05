import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = {
  requestCode: vi.fn(),
  verifyCode: vi.fn(),
  getUser: vi.fn(),
  logout: vi.fn(),
  register: vi.fn(),
  loginWithPassword: vi.fn(),
  changePassword: vi.fn(),
  resetPassword: vi.fn(),
};
let enabled = true;
let mail = true;

vi.mock("@/services/authRuntime", () => ({
  SESSION_COOKIE: "tf_session",
  getAuthService: () => (enabled ? auth : null),
  codeLoginEnabled: () => mail,
}));

import { GET as me } from "@/app/api/auth/me/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as requestCode } from "@/app/api/auth/request/route";
import { POST as verify } from "@/app/api/auth/verify/route";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as changePassword } from "@/app/api/auth/password/route";
import { POST as reset } from "@/app/api/auth/reset/route";

/**
 * Ручки входа по коду.
 *
 * Главное: почта Google отвечает 403 с понятным текстом, а не молчаливой
 * ошибкой; сессионная кука недоступна скриптам страницы; вход, который не
 * настроен, отвечает 503, а не притворяется рабочим.
 */

let counter = 0;
function post(url: string, body: unknown, cookie?: string): NextRequest {
  counter += 1;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-real-ip": `10.4.0.${String(counter)}`,
  };
  if (cookie) headers["cookie"] = cookie;
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetAllMocks();
  enabled = true;
  mail = true;
});

describe("POST /api/auth/request", () => {
  it("успех: письмо отправлено", async () => {
    auth.requestCode.mockResolvedValue({ ok: true });

    const response = await requestCode(post("/api/auth/request", { email: "ivan@firma.ru", consent: true }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    expect(auth.requestCode).toHaveBeenCalledWith({ email: "ivan@firma.ru", consent: true });
  });

  it("почта Google — 403 и объяснение, что делать", async () => {
    auth.requestCode.mockResolvedValue({ ok: false, reason: "blocked_google" });

    const response = await requestCode(post("/api/auth/request", { email: "ivan@gmail.com", consent: true }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.reason).toBe("blocked_google");
    expect(body.error).toMatch(/gmail\.com/);
    expect(body.error).toMatch(/другой адрес/);
  });

  it("слишком частый запрос — 429 с временем ожидания", async () => {
    auth.requestCode.mockResolvedValue({ ok: false, reason: "too_soon", retryAfterSec: 40 });

    const response = await requestCode(post("/api/auth/request", { email: "ivan@firma.ru", consent: true }));

    expect(response.status).toBe(429);
    expect((await response.json()).retryAfterSec).toBe(40);
  });

  it("сбой почты — 503", async () => {
    auth.requestCode.mockResolvedValue({ ok: false, reason: "mail_failed" });

    const response = await requestCode(post("/api/auth/request", { email: "ivan@firma.ru", consent: true }));

    expect(response.status).toBe(503);
  });

  it("вход не настроен (нет AUTH_SECRET) — 503, сервис не вызывается", async () => {
    enabled = false;

    const response = await requestCode(post("/api/auth/request", { email: "ivan@firma.ru", consent: true }));

    expect(response.status).toBe(503);
    expect(auth.requestCode).not.toHaveBeenCalled();
  });

  it("тело без согласия или не по форме — 400, сервис не вызывается", async () => {
    const response = await requestCode(post("/api/auth/request", { email: "ivan@firma.ru" }));

    expect(response.status).toBe(400);
    expect(auth.requestCode).not.toHaveBeenCalled();
  });

  it("лимит на адрес: одиннадцатый запрос подряд отклоняется", async () => {
    auth.requestCode.mockResolvedValue({ ok: true });
    const same = () =>
      new NextRequest("http://localhost/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-real-ip": "10.8.8.8" },
        body: JSON.stringify({ email: "ivan@firma.ru", consent: true }),
      });

    let last = 0;
    for (let i = 0; i < 11; i += 1) last = (await requestCode(same())).status;

    expect(last).toBe(429);
  });
});

describe("POST /api/auth/verify", () => {
  it("верный код ставит куку: httpOnly и SameSite=Lax", async () => {
    auth.verifyCode.mockResolvedValue({
      ok: true,
      token: "tok-123",
      user: { id: "u1", email: "ivan@firma.ru" },
      maxAgeSec: 2_592_000,
    });

    const response = await verify(post("/api/auth/verify", { email: "ivan@firma.ru", code: "123456" }));
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { email: "ivan@firma.ru" } });
    expect(cookie).toContain("tf_session=tok-123");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toContain("Max-Age=2592000");
  });

  it("неверный код — 400 и ни одной куки", async () => {
    auth.verifyCode.mockResolvedValue({ ok: false, reason: "invalid" });

    const response = await verify(post("/api/auth/verify", { email: "ivan@firma.ru", code: "000000" }));

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("вход не настроен — 503", async () => {
    enabled = false;

    expect((await verify(post("/api/auth/verify", { email: "a@b.ru", code: "123456" }))).status).toBe(503);
  });
});

describe("GET /api/auth/me и выход", () => {
  const meRequest = (cookie?: string) =>
    new NextRequest("http://localhost/api/auth/me", { headers: cookie ? { cookie } : {} });

  it("с действующей сессией отдаёт почту", async () => {
    auth.getUser.mockResolvedValue({ id: "u1", email: "ivan@firma.ru" });

    const body = await (await me(meRequest("tf_session=tok-123"))).json();

    expect(body.user).toEqual({ email: "ivan@firma.ru" });
    expect(auth.getUser).toHaveBeenCalledWith("tok-123");
  });

  it("без куки — гость", async () => {
    auth.getUser.mockResolvedValue(null);

    expect((await (await me(meRequest())).json()).user).toBeNull();
  });

  it("сбой базы не роняет страницу: ответ как для гостя", async () => {
    auth.getUser.mockRejectedValue(new Error("база недоступна"));

    const response = await me(meRequest("tf_session=tok-123"));

    expect(response.status).toBe(200);
    expect((await response.json()).user).toBeNull();
  });

  it("выход закрывает сессию и стирает куку", async () => {
    auth.logout.mockResolvedValue(undefined);

    const response = await logout(post("/api/auth/logout", {}, "tf_session=tok-123"));

    expect(auth.logout).toHaveBeenCalledWith("tok-123");
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});


describe("вход по коду без почтового сервера", () => {
  it("запрос кода — 503 с подсказкой войти паролем, сервис не вызывается", async () => {
    mail = false;

    const response = await requestCode(post("/api/auth/request", { email: "ivan@firma.ru", consent: true }));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/паролем/);
    expect(auth.requestCode).not.toHaveBeenCalled();
  });

  it("/me сообщает, доступен ли вход по коду", async () => {
    mail = false;
    auth.getUser.mockResolvedValue(null);

    const body = await (await me(new NextRequest("http://localhost/api/auth/me"))).json();

    expect(body).toMatchObject({ loginEnabled: true, codeLoginEnabled: false });
  });
});

describe("POST /api/auth/register", () => {
  const body = { email: "ivan@firma.ru", password: "надёжный-пароль-1", consent: true };

  it("успех: аккаунт создан и сразу открыта сессия", async () => {
    auth.register.mockResolvedValue({ ok: true, token: "tok-r", user: { id: "u1", email: "ivan@firma.ru" }, maxAgeSec: 100 });

    const response = await register(post("/api/auth/register", body));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/tf_session=tok-r.*HttpOnly/i);
  });

  it("почта Google — 403", async () => {
    auth.register.mockResolvedValue({ ok: false, reason: "blocked_google" });

    expect((await register(post("/api/auth/register", { ...body, email: "a@gmail.com" }))).status).toBe(403);
  });

  it("почта уже есть — 409 с подсказкой войти", async () => {
    auth.register.mockResolvedValue({ ok: false, reason: "exists" });

    const response = await register(post("/api/auth/register", body));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/Войдите/);
  });

  it("сбой базы (миграция не применена) — 503, а не 500", async () => {
    auth.register.mockRejectedValue(new Error('column "password_hash" does not exist'));

    expect((await register(post("/api/auth/register", body))).status).toBe(503);
  });

  it("регистрация работает без почтового сервера", async () => {
    mail = false;
    auth.register.mockResolvedValue({ ok: true, token: "t", user: { id: "u1", email: "ivan@firma.ru" }, maxAgeSec: 1 });

    expect((await register(post("/api/auth/register", body))).status).toBe(200);
  });
});

describe("POST /api/auth/login", () => {
  it("верный пароль — кука", async () => {
    auth.loginWithPassword.mockResolvedValue({ ok: true, token: "tok-l", user: { id: "u1", email: "a@b.ru" }, maxAgeSec: 1 });

    const response = await login(post("/api/auth/login", { email: "a@b.ru", password: "надёжный-пароль-1" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/tf_session=tok-l/);
  });

  it("неверный — 400 без куки и без подсказки, что именно не так", async () => {
    auth.loginWithPassword.mockResolvedValue({ ok: false, reason: "invalid" });

    const response = await login(post("/api/auth/login", { email: "a@b.ru", password: "x" }));

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await response.json()).error).toBe("Неверная почта или пароль.");
  });

  it("почта заблокирована после подбора — 429", async () => {
    auth.loginWithPassword.mockResolvedValue({ ok: false, reason: "locked" });

    expect((await login(post("/api/auth/login", { email: "a@b.ru", password: "x" }))).status).toBe(429);
  });
});

describe("POST /api/auth/password", () => {
  it("без сессии — 401", async () => {
    auth.getUser.mockResolvedValue(null);

    expect((await changePassword(post("/api/auth/password", { current: "a", next: "b" }))).status).toBe(401);
    expect(auth.changePassword).not.toHaveBeenCalled();
  });

  it("почта берётся из сессии, а не из тела", async () => {
    auth.getUser.mockResolvedValue({ id: "u1", email: "ivan@firma.ru" });
    auth.changePassword.mockResolvedValue({ ok: true });

    const response = await changePassword(
      post("/api/auth/password", { email: "chuzhoy@firma.ru", current: "старый", next: "новый-пароль-2" }, "tf_session=t"),
    );

    expect(response.status).toBe(200);
    expect(auth.changePassword).toHaveBeenCalledWith({ email: "ivan@firma.ru", current: "старый", next: "новый-пароль-2" });
  });
});


describe("POST /api/auth/reset", () => {
  it("верный код — новый пароль и кука", async () => {
    auth.resetPassword.mockResolvedValue({ ok: true, token: "tok-x", user: { id: "u1", email: "a@b.ru" }, maxAgeSec: 1 });

    const response = await reset(post("/api/auth/reset", { email: "a@b.ru", code: "123456", password: "новый-пароль-2" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/tf_session=tok-x/);
  });

  it("неверный код — 400 без куки", async () => {
    auth.resetPassword.mockResolvedValue({ ok: false, reason: "invalid" });

    const response = await reset(post("/api/auth/reset", { email: "a@b.ru", code: "000000", password: "новый-пароль-2" }));

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("без почтового сервера — 503", async () => {
    mail = false;

    expect((await reset(post("/api/auth/reset", { email: "a@b.ru", code: "1", password: "x" }))).status).toBe(503);
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });
});
