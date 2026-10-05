import { createHmac, randomBytes, randomInt } from "node:crypto";
import { promises as dns } from "node:dns";
import { domainToASCII } from "node:url";

import nodemailer from "nodemailer";

import { authStoreRepository } from "@/repositories/authStoreRepository";
import { hashPassword, verifyPassword } from "@/lib/passwordHash";
import { createAuthService, type AuthService } from "@/services/authService";

/**
 * Боевая сборка сервиса входа: база, почта, секрет и DNS.
 *
 * Секрет AUTH_SECRET и почтовый сервер SMTP_* приходят из окружения сервера.
 * Секрета нет или он короткий — вход выключен (ручки отвечают 503), а не
 * работает с хэшами, которые легко подобрать.
 */

export const MIN_AUTH_SECRET_LENGTH = 16;

const MX_TIMEOUT_MS = 3000;

let service: AuthService | null | undefined;

async function lookupMx(domain: string): Promise<string[] | null> {
  try {
    const records = await Promise.race([
      dns.resolveMx(domainToASCII(domain)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("MX timeout")), MX_TIMEOUT_MS)),
    ]);
    return records.map((r) => r.exchange);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Домен существует, но почтовых серверов у него нет, — это ответ, а не сбой.
    return code === "ENODATA" || code === "ENOTFOUND" ? [] : null;
  }
}

function smtpTransport() {
  const host = process.env["SMTP_HOST"];
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASSWORD"];
  if (!host || !user || !pass) return null;
  const port = Number(process.env["SMTP_PORT"] ?? "465");
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const transport = smtpTransport();
  if (transport === null) {
    console.error("Вход по почте: не заданы SMTP_HOST, SMTP_USER, SMTP_PASSWORD — письмо не отправлено.");
    throw new Error("SMTP не настроен");
  }
  const from = process.env["SMTP_FROM"] ?? process.env["SMTP_USER"];
  try {
    await transport.sendMail({ from, to, subject, text });
  } catch (error) {
    console.error("Вход по почте: письмо не отправлено:", error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Сервис входа или null, если не задан секрет AUTH_SECRET.
 *
 * Вход по паролю и регистрация работают с одним секретом. Вход по коду из
 * письма дополнительно требует почтового сервера (см. `codeLoginEnabled`).
 */
export function getAuthService(): AuthService | null {
  if (service !== undefined) return service;

  const secret = (process.env["AUTH_SECRET"] ?? "").trim();
  if (secret.length < MIN_AUTH_SECRET_LENGTH) {
    service = null;
    return service;
  }

  service = createAuthService({
    store: authStoreRepository,
    sendMail,
    now: () => Date.now(),
    randomCode: () => String(randomInt(0, 1_000_000)).padStart(6, "0"),
    randomToken: () => randomBytes(32).toString("base64url"),
    hash: (value) => createHmac("sha256", secret).update(value, "utf8").digest("hex"),
    hashPassword,
    verifyPassword,
    mxHosts: lookupMx,
  });
  return service;
}

/** Настроен ли почтовый сервер: без него вход по коду из письма недоступен. */
export function codeLoginEnabled(): boolean {
  return smtpTransport() !== null;
}

/** Для тестов: сбросить запомненный сервис после смены окружения. */
export function resetAuthServiceForTests(): void {
  service = undefined;
}

export const SESSION_COOKIE = "tf_session";
