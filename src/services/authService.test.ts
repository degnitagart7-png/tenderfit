import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  MAX_PASSWORD_FAILURES,
  PASSWORD_LOCK_MS,
  MAX_CODES_PER_HOUR,
  RESEND_COOLDOWN_MS,
  SESSION_TTL_MS,
  createAuthService,
  type AuthStore,
} from "@/services/authService";

/**
 * Вход по коду из письма.
 *
 * Пароля нет: человек вводит почту, получает шестизначный код и вводит его.
 * Проверяем всё, что делает такой вход безопасным: код живёт десять минут,
 * подбор ограничен пятью попытками, письма нельзя слать чаще раза в минуту и
 * чаще пяти в час, а почта Google не принимается вовсе.
 */

interface CodeRow {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  consumed: boolean;
  createdAt: number;
}

function createMemoryStore() {
  const codes: CodeRow[] = [];
  const users = new Map<string, { id: string; email: string; passwordHash?: string | null }>();
  const sessions = new Map<string, { userId: string; email: string; expiresAt: number }>();
  let seq = 0;

  const store: AuthStore = {
    async lastCodeAt(email) {
      const mine = codes.filter((c) => c.email === email).map((c) => c.createdAt);
      return mine.length === 0 ? null : Math.max(...mine);
    },
    async countCodesSince(email, sinceMs) {
      return codes.filter((c) => c.email === email && c.createdAt >= sinceMs).length;
    },
    async insertCode(row) {
      seq += 1;
      const id = `c${String(seq)}`;
      codes.push({ id, ...row, attempts: 0, consumed: false });
      return id;
    },
    async discardCode(id) {
      const i = codes.findIndex((c) => c.id === id);
      if (i >= 0) codes.splice(i, 1);
    },
    async latestOpenCode(email, nowMs) {
      const open = codes
        .filter((c) => c.email === email && !c.consumed && c.expiresAt > nowMs && c.attempts < CODE_MAX_ATTEMPTS)
        .sort((a, b) => b.createdAt - a.createdAt);
      const c = open[0];
      return c ? { id: c.id, codeHash: c.codeHash, attempts: c.attempts } : null;
    },
    async bumpAttempts(id) {
      const c = codes.find((x) => x.id === id);
      if (c) c.attempts += 1;
    },
    async consumeCode(id) {
      const c = codes.find((x) => x.id === id);
      if (!c || c.consumed) return false;
      c.consumed = true;
      return true;
    },
    async findUser(email) {
      const u = users.get(email);
      return u ? { id: u.id, email: u.email, passwordHash: u.passwordHash ?? null } : null;
    },
    async createUser(email, passwordHash) {
      if (users.has(email)) return null;
      seq += 1;
      const user = { id: `u${String(seq)}`, email, passwordHash };
      users.set(email, user);
      return { id: user.id, email };
    },
    async setPasswordHash(userId, passwordHash) {
      for (const u of users.values()) if (u.id === userId) u.passwordHash = passwordHash;
    },
    async upsertUser(email) {
      const existing = users.get(email);
      if (existing) return existing;
      seq += 1;
      const user = { id: `u${String(seq)}`, email };
      users.set(email, user);
      return user;
    },
    async createSession(row) {
      sessions.set(row.tokenHash, { userId: row.userId, email: row.email, expiresAt: row.expiresAt });
    },
    async findSession(tokenHash, nowMs) {
      const s = sessions.get(tokenHash);
      return s && s.expiresAt > nowMs ? { userId: s.userId, email: s.email } : null;
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },
  };
  return { store, codes, users, sessions };
}

const T0 = Date.parse("2026-10-05T12:00:00Z");

function setup(over: { mx?: string[] | null; sendFails?: boolean } = {}) {
  const mem = createMemoryStore();
  let now = T0;
  let tokenSeq = 0;
  const sent: Array<{ to: string; text: string }> = [];
  const sendMail = vi.fn(async (to: string, _subject: string, text: string) => {
    if (over.sendFails) throw new Error("SMTP недоступен");
    sent.push({ to, text });
  });
  const service = createAuthService({
    store: mem.store,
    sendMail,
    now: () => now,
    randomCode: () => "123456",
    randomToken: () => {
      tokenSeq += 1;
      return `token-${String(tokenSeq)}`;
    },
    hash: (value) => `h(${value})`,
    hashPassword: async (password) => `pw(${password})`,
    verifyPassword: async (password, stored) => stored === `pw(${password})`,
    mxHosts: async () => (over.mx === undefined ? ["mx.yandex.net"] : over.mx),
  });
  return { service, mem, sent, sendMail, advance: (ms: number) => (now += ms) };
}

let ctx: ReturnType<typeof setup>;

beforeEach(() => {
  ctx = setup();
});

describe("requestCode", () => {
  it("высылает код на почту и называет срок его жизни", async () => {
    const result = await ctx.service.requestCode({ email: "Ivan@Firma.ru", consent: true });

    expect(result).toEqual({ ok: true });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]?.to).toBe("ivan@firma.ru");
    expect(ctx.sent[0]?.text).toContain("123456");
    expect(ctx.sent[0]?.text).toContain("10 минут");
  });

  it("в базе лежит хэш кода, а не сам код", async () => {
    await ctx.service.requestCode({ email: "ivan@firma.ru", consent: true });

    expect(ctx.mem.codes[0]?.codeHash).toBe("h(ivan@firma.ru:123456)");
    expect(JSON.stringify(ctx.mem.codes)).not.toContain('"123456"');
  });

  it("не адрес — отказ, письмо не уходит", async () => {
    const result = await ctx.service.requestCode({ email: "ivan", consent: true });

    expect(result).toEqual({ ok: false, reason: "invalid_email" });
    expect(ctx.sendMail).not.toHaveBeenCalled();
  });

  it("без согласия на обработку персональных данных — отказ", async () => {
    const result = await ctx.service.requestCode({ email: "ivan@firma.ru", consent: false });

    expect(result).toEqual({ ok: false, reason: "consent_required" });
    expect(ctx.sendMail).not.toHaveBeenCalled();
  });

  it.each(["ivan@gmail.com", "IVAN@GMAIL.COM", "i.van+tag@googlemail.com", "ivan@gmail.com."])(
    "почта Google %s не принимается, письмо не уходит",
    async (email) => {
      const result = await ctx.service.requestCode({ email, consent: true });

      expect(result).toEqual({ ok: false, reason: "blocked_google" });
      expect(ctx.sendMail).not.toHaveBeenCalled();
      expect(ctx.mem.codes).toHaveLength(0);
    },
  );

  it("свой домен на Google Workspace (MX у Google) не принимается", async () => {
    const google = setup({ mx: ["aspmx.l.google.com", "alt1.aspmx.l.google.com"] });

    const result = await google.service.requestCode({ email: "ivan@firma.ru", consent: true });

    expect(result).toEqual({ ok: false, reason: "blocked_google" });
    expect(google.sendMail).not.toHaveBeenCalled();
  });

  it("не удалось узнать MX — адрес принимается: ложный отказ клиенту хуже", async () => {
    const unknown = setup({ mx: null });

    const result = await unknown.service.requestCode({ email: "ivan@firma.ru", consent: true });

    expect(result).toEqual({ ok: true });
  });

  it("повторный запрос раньше чем через минуту — отказ с временем ожидания", async () => {
    await ctx.service.requestCode({ email: "ivan@firma.ru", consent: true });
    ctx.advance(20_000);

    const result = await ctx.service.requestCode({ email: "ivan@firma.ru", consent: true });

    expect(result).toEqual({ ok: false, reason: "too_soon", retryAfterSec: 40 });
    expect(ctx.sendMail).toHaveBeenCalledTimes(1);
  });

  it("не больше пяти писем в час на один адрес", async () => {
    for (let i = 0; i < MAX_CODES_PER_HOUR; i += 1) {
      const ok = await ctx.service.requestCode({ email: "ivan@firma.ru", consent: true });
      expect(ok).toEqual({ ok: true });
      ctx.advance(RESEND_COOLDOWN_MS + 1000);
    }

    const result = await ctx.service.requestCode({ email: "ivan@firma.ru", consent: true });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("too_many");
  });

  it("сбой почты — код отзывается, повторить можно сразу, а не через минуту", async () => {
    const broken = setup({ sendFails: true });

    const result = await broken.service.requestCode({ email: "ivan@firma.ru", consent: true });

    expect(result).toEqual({ ok: false, reason: "mail_failed" });
    expect(broken.mem.codes).toHaveLength(0);
  });
});

describe("verifyCode", () => {
  async function requested() {
    await ctx.service.requestCode({ email: "ivan@firma.ru", consent: true });
  }

  it("верный код открывает сессию и создаёт пользователя", async () => {
    await requested();

    const result = await ctx.service.verifyCode({ email: "ivan@firma.ru", code: "123456" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBe("token-1");
    expect(result.user.email).toBe("ivan@firma.ru");
    expect(result.maxAgeSec).toBe(SESSION_TTL_MS / 1000);
    expect(ctx.mem.users.has("ivan@firma.ru")).toBe(true);
  });

  it("в базе лежит хэш токена, а не сам токен", async () => {
    await requested();
    await ctx.service.verifyCode({ email: "ivan@firma.ru", code: "123456" });

    expect([...ctx.mem.sessions.keys()]).toEqual(["h(token-1)"]);
  });

  it("код одноразовый: второй вход тем же кодом отклоняется", async () => {
    await requested();
    await ctx.service.verifyCode({ email: "ivan@firma.ru", code: "123456" });

    const again = await ctx.service.verifyCode({ email: "ivan@firma.ru", code: "123456" });

    expect(again).toEqual({ ok: false, reason: "invalid" });
  });

  it("два входа одним кодом наперегонки: второй не проходит, сессия одна", async () => {
    await requested();
    const store = ctx.mem.store;
    const original = store.latestOpenCode;
    // Оба запроса увидели код открытым: гонка происходит между чтением и пометкой.
    store.latestOpenCode = async (email, nowMs) => original(email, nowMs);

    const [a, b] = await Promise.all([
      ctx.service.verifyCode({ email: "ivan@firma.ru", code: "123456" }),
      ctx.service.verifyCode({ email: "ivan@firma.ru", code: "123456" }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(ctx.mem.sessions.size).toBe(1);
  });

  it("неверный код отклоняется и считается попыткой", async () => {
    await requested();

    const result = await ctx.service.verifyCode({ email: "ivan@firma.ru", code: "000000" });

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(ctx.mem.codes[0]?.attempts).toBe(1);
  });

  it("после пяти ошибок код мёртв, даже если шестая попытка верна", async () => {
    await requested();
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i += 1) {
      await ctx.service.verifyCode({ email: "ivan@firma.ru", code: "000000" });
    }

    const result = await ctx.service.verifyCode({ email: "ivan@firma.ru", code: "123456" });

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("код старше десяти минут не работает", async () => {
    await requested();
    ctx.advance(CODE_TTL_MS + 1000);

    const result = await ctx.service.verifyCode({ email: "ivan@firma.ru", code: "123456" });

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("код другой почты не подходит: хэш привязан к адресу", async () => {
    await requested();
    await ctx.service.requestCode({ email: "petr@firma.ru", consent: true });

    const result = await ctx.service.verifyCode({ email: "petr@firma.ru", code: "123456" });
    const crossed = ctx.mem.codes.find((c) => c.email === "petr@firma.ru");

    expect(result.ok).toBe(true);
    expect(crossed?.codeHash).toBe("h(petr@firma.ru:123456)");
  });

  it("код не из шести цифр отклоняется без обращения к базе", async () => {
    await requested();

    for (const code of ["12345", "1234567", "abcdef", "12 456", ""]) {
      expect(await ctx.service.verifyCode({ email: "ivan@firma.ru", code })).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    expect(ctx.mem.codes[0]?.attempts).toBe(0);
  });

  it("ответ одинаков для несуществующей почты и неверного кода: перебор адресов ничего не даёт", async () => {
    const unknown = await ctx.service.verifyCode({ email: "nobody@firma.ru", code: "123456" });

    expect(unknown).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("сессия", () => {
  async function signedIn() {
    await ctx.service.requestCode({ email: "ivan@firma.ru", consent: true });
    const result = await ctx.service.verifyCode({ email: "ivan@firma.ru", code: "123456" });
    if (!result.ok) throw new Error("вход не удался");
    return result.token;
  }

  it("по токену находится пользователь", async () => {
    const token = await signedIn();

    expect(await ctx.service.getUser(token)).toMatchObject({ email: "ivan@firma.ru" });
  });

  it("чужой и пустой токен пользователя не дают", async () => {
    await signedIn();

    expect(await ctx.service.getUser("token-999")).toBeNull();
    expect(await ctx.service.getUser("")).toBeNull();
    expect(await ctx.service.getUser(undefined)).toBeNull();
  });

  it("через тридцать дней сессия кончается", async () => {
    const token = await signedIn();
    ctx.advance(SESSION_TTL_MS + 1000);

    expect(await ctx.service.getUser(token)).toBeNull();
  });

  it("выход закрывает сессию", async () => {
    const token = await signedIn();

    await ctx.service.logout(token);

    expect(await ctx.service.getUser(token)).toBeNull();
  });
});


/*
  Регистрация и вход по паролю. Код на почту требует почтового сервера, а
  пароль — нет: им можно пользоваться сразу. Правила почты те же, что у входа
  по коду: адрес Google не принимается.
*/
describe("register", () => {
  const ok = { email: "Ivan@Firma.ru", password: "надёжный-пароль-1", consent: true };

  it("создаёт пользователя, открывает сессию, хранит хэш пароля, а не пароль", async () => {
    const result = await ctx.service.register(ok);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.email).toBe("ivan@firma.ru");
    expect(result.token).toBe("token-1");
    expect(ctx.mem.users.get("ivan@firma.ru")?.passwordHash).toBe("pw(надёжный-пароль-1)");
    expect([...ctx.mem.sessions.keys()]).toEqual(["h(token-1)"]);
  });

  it("почта Google не принимается", async () => {
    expect(await ctx.service.register({ ...ok, email: "ivan@gmail.com" })).toEqual({ ok: false, reason: "blocked_google" });
    expect(ctx.mem.users.size).toBe(0);
  });

  it("домен на Google Workspace не принимается", async () => {
    const google = setup({ mx: ["aspmx.l.google.com"] });

    expect(await google.service.register(ok)).toEqual({ ok: false, reason: "blocked_google" });
  });

  it("без согласия на обработку данных — отказ", async () => {
    expect(await ctx.service.register({ ...ok, consent: false })).toEqual({ ok: false, reason: "consent_required" });
  });

  it.each(["", "1234567", "        "])("слабый пароль %j отклоняется", async (password) => {
    expect(await ctx.service.register({ ...ok, password })).toEqual({ ok: false, reason: "weak_password" });
  });

  it("слишком длинный пароль отклоняется: хэширование не должно быть бесплатной нагрузкой", async () => {
    expect(await ctx.service.register({ ...ok, password: "x".repeat(201) })).toEqual({ ok: false, reason: "weak_password" });
  });

  it("почта уже зарегистрирована — отказ, второй пользователь не создаётся", async () => {
    await ctx.service.register(ok);

    expect(await ctx.service.register({ ...ok, password: "другой-пароль-2" })).toEqual({ ok: false, reason: "exists" });
    expect(ctx.mem.users.size).toBe(1);
  });

  it("кривой адрес — отказ", async () => {
    expect(await ctx.service.register({ ...ok, email: "ivan" })).toEqual({ ok: false, reason: "invalid_email" });
  });
});

describe("loginWithPassword", () => {
  beforeEach(async () => {
    await ctx.service.register({ email: "ivan@firma.ru", password: "надёжный-пароль-1", consent: true });
  });

  it("верный пароль — сессия", async () => {
    const result = await ctx.service.loginWithPassword({ email: " IVAN@firma.ru ", password: "надёжный-пароль-1" });

    expect(result.ok).toBe(true);
  });

  it("неверный пароль и неизвестная почта отвечают одинаково", async () => {
    expect(await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "не-тот" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await ctx.service.loginWithPassword({ email: "nobody@firma.ru", password: "надёжный-пароль-1" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("у пользователя, вошедшего по коду, пароля нет — вход по паролю не проходит", async () => {
    await ctx.service.requestCode({ email: "petr@firma.ru", consent: true });
    await ctx.service.verifyCode({ email: "petr@firma.ru", code: "123456" });

    expect(await ctx.service.loginWithPassword({ email: "petr@firma.ru", password: "" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("после десяти ошибок за 15 минут вход по паролю закрыт даже с верным паролем", async () => {
    for (let i = 0; i < MAX_PASSWORD_FAILURES; i += 1) {
      await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "подбор" });
    }

    expect(await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "надёжный-пароль-1" })).toEqual({
      ok: false,
      reason: "locked",
    });
  });

  it("через 15 минут блокировка снимается", async () => {
    for (let i = 0; i < MAX_PASSWORD_FAILURES; i += 1) {
      await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "подбор" });
    }
    ctx.advance(PASSWORD_LOCK_MS + 1000);

    expect((await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "надёжный-пароль-1" })).ok).toBe(true);
  });
});

describe("changePassword", () => {
  it("меняет пароль при верном текущем", async () => {
    await ctx.service.register({ email: "ivan@firma.ru", password: "старый-пароль-1", consent: true });

    const result = await ctx.service.changePassword({ email: "ivan@firma.ru", current: "старый-пароль-1", next: "новый-пароль-2" });

    expect(result).toEqual({ ok: true });
    expect((await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "новый-пароль-2" })).ok).toBe(true);
  });

  it("неверный текущий пароль — отказ", async () => {
    await ctx.service.register({ email: "ivan@firma.ru", password: "старый-пароль-1", consent: true });

    expect(await ctx.service.changePassword({ email: "ivan@firma.ru", current: "не-тот", next: "новый-пароль-2" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("у вошедшего по коду пароля нет — его можно задать без текущего", async () => {
    await ctx.service.requestCode({ email: "petr@firma.ru", consent: true });
    await ctx.service.verifyCode({ email: "petr@firma.ru", code: "123456" });

    expect(await ctx.service.changePassword({ email: "petr@firma.ru", current: "", next: "новый-пароль-2" })).toEqual({ ok: true });
  });

  it("слабый новый пароль — отказ", async () => {
    await ctx.service.register({ email: "ivan@firma.ru", password: "старый-пароль-1", consent: true });

    expect(await ctx.service.changePassword({ email: "ivan@firma.ru", current: "старый-пароль-1", next: "123" })).toEqual({
      ok: false,
      reason: "weak_password",
    });
  });
});


describe("resetPassword", () => {
  beforeEach(async () => {
    await ctx.service.register({ email: "ivan@firma.ru", password: "забытый-пароль-1", consent: true });
    ctx.advance(RESEND_COOLDOWN_MS + 1000);
    await ctx.service.requestCode({ email: "ivan@firma.ru", consent: true });
  });

  it("верный код заменяет пароль и открывает сессию; старый пароль больше не подходит", async () => {
    const result = await ctx.service.resetPassword({ email: "ivan@firma.ru", code: "123456", password: "новый-пароль-2" });

    expect(result.ok).toBe(true);
    expect((await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "новый-пароль-2" })).ok).toBe(true);
    expect((await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "забытый-пароль-1" })).ok).toBe(false);
  });

  it("неверный код — отказ, пароль прежний", async () => {
    expect(await ctx.service.resetPassword({ email: "ivan@firma.ru", code: "000000", password: "новый-пароль-2" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect((await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "забытый-пароль-1" })).ok).toBe(true);
  });

  it("код одноразовый", async () => {
    await ctx.service.resetPassword({ email: "ivan@firma.ru", code: "123456", password: "новый-пароль-2" });

    expect((await ctx.service.resetPassword({ email: "ivan@firma.ru", code: "123456", password: "третий-пароль-3" })).ok).toBe(false);
  });

  it("неизвестная почта — тот же отказ, аккаунт не создаётся", async () => {
    await ctx.service.requestCode({ email: "nobody@firma.ru", consent: true });

    expect(await ctx.service.resetPassword({ email: "nobody@firma.ru", code: "123456", password: "новый-пароль-2" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(ctx.mem.users.has("nobody@firma.ru")).toBe(false);
  });

  it("слабый новый пароль — отказ до проверки кода: код не тратится", async () => {
    expect((await ctx.service.resetPassword({ email: "ivan@firma.ru", code: "123456", password: "123" })).ok).toBe(false);
    expect((await ctx.service.resetPassword({ email: "ivan@firma.ru", code: "123456", password: "новый-пароль-2" })).ok).toBe(true);
  });

  it("сброс снимает блокировку после подбора", async () => {
    for (let i = 0; i < MAX_PASSWORD_FAILURES; i += 1) {
      await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "подбор" });
    }

    await ctx.service.resetPassword({ email: "ivan@firma.ru", code: "123456", password: "новый-пароль-2" });

    expect((await ctx.service.loginWithPassword({ email: "ivan@firma.ru", password: "новый-пароль-2" })).ok).toBe(true);
  });
});
