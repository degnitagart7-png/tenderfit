import { timingSafeEqual } from "node:crypto";

import { trialEndsAtFor, type UserAccessRecord } from "@/domain/access";
import { buildCodeEmail, type CodeEmailKind } from "@/domain/emailTemplates";
import {
  emailDomain,
  isBlockedEmailDomain,
  isGoogleHostedMx,
  normalizeEmail,
} from "@/domain/emailPolicy";

/**
 * Вход по коду из письма.
 *
 * Пароля нет: человек вводит почту, получает шестизначный код и вводит его.
 * Сервис не знает ни базы, ни почтового сервера, ни часов: всё это приходит
 * параметрами, поэтому правила входа проверяются тестом, а не письмами.
 *
 * Что делает вход безопасным:
 *  - код живёт десять минут и одноразовый;
 *  - на код пять попыток, затем он мёртв (шесть цифр иначе подобрать нетрудно);
 *  - письма — не чаще раза в минуту и не больше пяти в час на адрес;
 *  - в базе лежат хэши кода и токена сессии, а не они сами;
 *  - на неверный код и на несуществующую почту отвечаем одинаково;
 *  - почта Google не принимается вовсе (см. emailPolicy).
 */

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60_000;
export const MAX_CODES_PER_HOUR = 5;
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
/** Пароль не короче восьми знаков и не длиннее двухсот (хэширование — не бесплатная нагрузка). */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
/** Ошибок пароля на адрес почты до блокировки и срок блокировки. */
export const MAX_PASSWORD_FAILURES = 10;
export const PASSWORD_LOCK_MS = 15 * 60_000;

const HOUR_MS = 3_600_000;

export interface OpenCode {
  id: string;
  codeHash: string;
  attempts: number;
}

export interface AuthUser {
  id: string;
  email: string;
  /** Сроки доступа из базы; есть там, где пользователя читали по сессии (см. getUser). */
  access?: UserAccessRecord;
}

export interface AuthStore {
  lastCodeAt(email: string): Promise<number | null>;
  countCodesSince(email: string, sinceMs: number): Promise<number>;
  insertCode(row: { email: string; codeHash: string; expiresAt: number; createdAt: number }): Promise<string>;
  discardCode(id: string): Promise<void>;
  /** Последний код, который ещё можно ввести: не использован, не просрочен, попытки не исчерпаны. */
  latestOpenCode(email: string, nowMs: number): Promise<OpenCode | null>;
  bumpAttempts(id: string): Promise<void>;
  /** Помечает код использованным; false — его уже использовали (два входа одним кодом наперегонки). */
  consumeCode(id: string): Promise<boolean>;
  /** Найти или завести пользователя; новому — пробный период до `trialEndsAt` (мс). Существующему срок не меняется. */
  upsertUser(email: string, trialEndsAt: number): Promise<AuthUser>;
  findUser(email: string): Promise<{ id: string; email: string; passwordHash: string | null } | null>;
  /** null — такая почта уже есть (уникальный ключ, гонка двух регистраций). Пробный период — до `trialEndsAt` (мс). */
  createUser(email: string, passwordHash: string, trialEndsAt: number): Promise<AuthUser | null>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  createSession(row: { userId: string; email: string; tokenHash: string; expiresAt: number }): Promise<void>;
  findSession(
    tokenHash: string,
    nowMs: number,
  ): Promise<{ userId: string; email: string; access?: UserAccessRecord } | null>;
  deleteSession(tokenHash: string): Promise<void>;
}

export interface AuthDeps {
  store: AuthStore;
  /** `html` — вторая версия письма; без неё уходит один текст. */
  sendMail(to: string, subject: string, text: string, html?: string): Promise<void>;
  now(): number;
  randomCode(): string;
  randomToken(): string;
  /** Хэш с секретом сервера: по украденной таблице код и токен не восстановить. */
  hash(value: string): string;
  /** Медленный хэш пароля с солью (scrypt); в тестах — подставной. */
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, stored: string): Promise<boolean>;
  /** Почтовые серверы домена; null — узнать не удалось. */
  mxHosts(domain: string): Promise<string[] | null>;
  /** Конец пробного периода для нового аккаунта; по умолчанию — TRIAL_DAYS (7 дней) от `nowMs`. */
  trialEndsAt?(nowMs: number): number;
}

export type RequestCodeResult =
  | { ok: true }
  | {
      ok: false;
      reason: "invalid_email" | "consent_required" | "blocked_google" | "too_soon" | "too_many" | "mail_failed";
      retryAfterSec?: number;
    };

export type VerifyCodeResult =
  | { ok: true; token: string; user: AuthUser; maxAgeSec: number }
  | { ok: false; reason: "invalid" };

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type RegisterResult =
  | { ok: true; token: string; user: AuthUser; maxAgeSec: number }
  | {
      ok: false;
      reason: "invalid_email" | "consent_required" | "blocked_google" | "weak_password" | "exists" | "invalid_code";
    };

export type RequestRegisterCodeResult =
  | RequestCodeResult
  | { ok: false; reason: "exists"; retryAfterSec?: undefined };

export type PasswordLoginResult =
  | { ok: true; token: string; user: AuthUser; maxAgeSec: number }
  | { ok: false; reason: "invalid" | "locked" };

export type ResetPasswordResult =
  | { ok: true; token: string; user: AuthUser; maxAgeSec: number }
  | { ok: false; reason: "invalid" | "weak_password" };

export type ChangePasswordResult = { ok: true } | { ok: false; reason: "invalid" | "weak_password" };

function passwordAcceptable(password: string): boolean {
  return password.trim().length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

export function createAuthService(deps: AuthDeps) {
  const { store } = deps;
  const trialEnd = (nowMs: number): number => (deps.trialEndsAt ? deps.trialEndsAt(nowMs) : trialEndsAtFor(nowMs));
  const codeHash = (email: string, code: string): string => deps.hash(`${email}:${code}`);

  /** Ошибки пароля по адресу почты: время каждой ошибки за последние 15 минут. */
  const failures = new Map<string, number[]>();
  const recentFailures = (email: string, nowMs: number): number[] => {
    const fresh = (failures.get(email) ?? []).filter((at) => nowMs - at < PASSWORD_LOCK_MS);
    failures.set(email, fresh);
    return fresh;
  };

  /** Почта Google закрыта: по домену и по почтовым серверам домена. */
  const googleMail = async (email: string): Promise<boolean> => {
    const domain = emailDomain(email);
    if (isBlockedEmailDomain(domain)) return true;
    const mx = await deps.mxHosts(domain);
    return mx !== null && isGoogleHostedMx(mx);
  };

  /**
   * Проверить код и пометить использованным. Неверный код считается попыткой;
   * код одноразовый даже при двух одновременных запросах.
   */
  const consumeValidCode = async (email: string, code: string): Promise<boolean> => {
    if (!/^\d{6}$/.test(code)) return false;
    const open = await store.latestOpenCode(email, deps.now());
    if (open === null) return false;
    if (!safeEqual(open.codeHash, codeHash(email, code))) {
      await store.bumpAttempts(open.id);
      return false;
    }
    return store.consumeCode(open.id);
  };

  const openSession = async (user: AuthUser) => {
    const token = deps.randomToken();
    await store.createSession({
      userId: user.id,
      email: user.email,
      tokenHash: deps.hash(token),
      expiresAt: deps.now() + SESSION_TTL_MS,
    });
    return { ok: true as const, token, user, maxAgeSec: SESSION_TTL_MS / 1000 };
  };

  /**
   * Отправить код на уже проверенный адрес: лимиты писем, запись хэша, письмо.
   * Письмо не ушло — код отзывается, чтобы сбой почты не включал минутное ожидание.
   */
  const sendCode = async (email: string, kind: CodeEmailKind): Promise<RequestCodeResult> => {
    const nowMs = deps.now();
    const last = await store.lastCodeAt(email);
    if (last !== null && nowMs - last < RESEND_COOLDOWN_MS) {
      return {
        ok: false,
        reason: "too_soon",
        retryAfterSec: Math.ceil((RESEND_COOLDOWN_MS - (nowMs - last)) / 1000),
      };
    }
    if ((await store.countCodesSince(email, nowMs - HOUR_MS)) >= MAX_CODES_PER_HOUR) {
      return { ok: false, reason: "too_many" };
    }

    const code = deps.randomCode();
    const id = await store.insertCode({
      email,
      codeHash: codeHash(email, code),
      expiresAt: nowMs + CODE_TTL_MS,
      createdAt: nowMs,
    });
    try {
      const mail = buildCodeEmail({ kind, code, ttlMinutes: CODE_TTL_MS / 60_000 });
      await deps.sendMail(email, mail.subject, mail.text, mail.html);
    } catch {
      await store.discardCode(id);
      return { ok: false, reason: "mail_failed" };
    }
    return { ok: true };
  };

  return {
    /**
     * Код подтверждения почты для регистрации. Адрес проверяется так же, как
     * при самой регистрации, и занятую почту видно до письма, а не после.
     */
    async requestRegisterCode(input: { email: string; consent: boolean }): Promise<RequestRegisterCodeResult> {
      const email = normalizeEmail(input.email);
      if (email === null) return { ok: false, reason: "invalid_email" };
      if (!input.consent) return { ok: false, reason: "consent_required" };
      if (await googleMail(email)) return { ok: false, reason: "blocked_google" };
      if ((await store.findUser(email)) !== null) return { ok: false, reason: "exists" };
      return sendCode(email, "register");
    },

    /**
     * Регистрация по почте и паролю. С `requireCode` (на сервере настроена
     * почта) аккаунт создаётся только по коду из письма — так почта
     * подтверждена; без почтового сервера — сразу.
     */
    async register(
      input: { email: string; password: string; consent: boolean; code?: string },
      options: { requireCode: boolean } = { requireCode: false },
    ): Promise<RegisterResult> {
      const email = normalizeEmail(input.email);
      if (email === null) return { ok: false, reason: "invalid_email" };
      if (!input.consent) return { ok: false, reason: "consent_required" };
      if (!passwordAcceptable(input.password)) return { ok: false, reason: "weak_password" };
      if (await googleMail(email)) return { ok: false, reason: "blocked_google" };

      if ((await store.findUser(email)) !== null) return { ok: false, reason: "exists" };
      if (options.requireCode && !(await consumeValidCode(email, input.code ?? ""))) {
        return { ok: false, reason: "invalid_code" };
      }
      const user = await store.createUser(email, await deps.hashPassword(input.password), trialEnd(deps.now()));
      if (user === null) return { ok: false, reason: "exists" };
      return openSession(user);
    },

    /**
     * Вход по паролю. Неверный пароль, неизвестная почта и пользователь без
     * пароля отвечают одинаково: перебор адресов ничего не даёт. После десяти
     * ошибок за 15 минут адрес закрыт и для верного пароля.
     */
    async loginWithPassword(input: { email: string; password: string }): Promise<PasswordLoginResult> {
      const email = normalizeEmail(input.email);
      if (email === null || input.password.length > MAX_PASSWORD_LENGTH) return { ok: false, reason: "invalid" };
      const nowMs = deps.now();
      if (recentFailures(email, nowMs).length >= MAX_PASSWORD_FAILURES) return { ok: false, reason: "locked" };

      const user = await store.findUser(email);
      const valid =
        user !== null &&
        user.passwordHash !== null &&
        input.password !== "" &&
        (await deps.verifyPassword(input.password, user.passwordHash));
      if (!valid || user === null) {
        recentFailures(email, nowMs).push(nowMs);
        return { ok: false, reason: "invalid" };
      }
      failures.delete(email);
      return openSession({ id: user.id, email: user.email });
    },

    /**
     * Смена пароля из личного кабинета. Кто вошёл по коду и пароля не имеет,
     * задаёт его без текущего: сессия уже подтвердила владение почтой.
     */
    async changePassword(input: { email: string; current: string; next: string }): Promise<ChangePasswordResult> {
      if (!passwordAcceptable(input.next)) return { ok: false, reason: "weak_password" };
      const user = await store.findUser(input.email);
      if (user === null) return { ok: false, reason: "invalid" };
      if (user.passwordHash !== null) {
        const valid = input.current !== "" && (await deps.verifyPassword(input.current, user.passwordHash));
        if (!valid) return { ok: false, reason: "invalid" };
      }
      await store.setPasswordHash(user.id, await deps.hashPassword(input.next));
      return { ok: true };
    },

    /** `purpose` — для чего код: вход (по умолчанию) или восстановление пароля; от него зависит текст письма. */
    async requestCode(input: {
      email: string;
      consent: boolean;
      purpose?: "login" | "reset";
    }): Promise<RequestCodeResult> {
      const email = normalizeEmail(input.email);
      if (email === null) return { ok: false, reason: "invalid_email" };
      if (!input.consent) return { ok: false, reason: "consent_required" };

      const domain = emailDomain(email);
      if (isBlockedEmailDomain(domain)) return { ok: false, reason: "blocked_google" };
      // Не удалось узнать MX — адрес принимается: ложный отказ клиенту хуже.
      const mx = await deps.mxHosts(domain);
      if (mx !== null && isGoogleHostedMx(mx)) return { ok: false, reason: "blocked_google" };

      return sendCode(email, input.purpose ?? "login");
    },

    async verifyCode(input: { email: string; code: string }): Promise<VerifyCodeResult> {
      const email = normalizeEmail(input.email);
      if (email === null || !(await consumeValidCode(email, input.code))) return { ok: false, reason: "invalid" };
      const user = await store.upsertUser(email, trialEnd(deps.now()));
      return openSession(user);
    },

    /**
     * Восстановление пароля: код из письма подтверждает владение почтой, и
     * пароль заменяется новым. Только для существующего аккаунта; ответ на
     * неверный код и неизвестную почту одинаковый.
     */
    async resetPassword(input: { email: string; code: string; password: string }): Promise<ResetPasswordResult> {
      if (!passwordAcceptable(input.password)) return { ok: false, reason: "weak_password" };
      const email = normalizeEmail(input.email);
      if (email === null) return { ok: false, reason: "invalid" };
      const user = await store.findUser(email);
      if (user === null || !(await consumeValidCode(email, input.code))) return { ok: false, reason: "invalid" };
      await store.setPasswordHash(user.id, await deps.hashPassword(input.password));
      failures.delete(email);
      return openSession({ id: user.id, email: user.email });
    },

    async getUser(token: string | undefined | null): Promise<AuthUser | null> {
      if (token === undefined || token === null || token === "") return null;
      const session = await store.findSession(deps.hash(token), deps.now());
      if (session === null) return null;
      return {
        id: session.userId,
        email: session.email,
        ...(session.access === undefined ? {} : { access: session.access }),
      };
    },

    async logout(token: string | undefined | null): Promise<void> {
      if (token === undefined || token === null || token === "") return;
      await store.deleteSession(deps.hash(token));
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
