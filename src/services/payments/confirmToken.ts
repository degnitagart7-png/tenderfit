import { createHmac, timingSafeEqual } from "node:crypto";

import { CLAIM_TTL_MS } from "@/domain/payments";

/**
 * Подписанная ссылка «подтвердить оплату» для владельца.
 *
 * Токен — `<id заявки>.<срок мс>.<hmac-sha256>`: срок и заявка защищены подписью с секретом
 * PAYMENT_CONFIRM_SECRET (не короче 16 знаков; нет секрета — подтверждение по ссылке выключено).
 * Одноразовость даёт не токен, а база: подтверждение переводит заявку из «ждёт» в «оплачена»
 * транзакционно (см. activationService), второе нажатие видит «уже подтверждено». Кроме подписи
 * ручка требует сессию администратора — переслать письмо недостаточно.
 */

export const MIN_CONFIRM_SECRET_LENGTH = 16;

export function confirmSecret(env: Record<string, string | undefined>): string | null {
  const secret = (env["PAYMENT_CONFIRM_SECRET"] ?? "").trim();
  return secret.length >= MIN_CONFIRM_SECRET_LENGTH ? secret : null;
}

function sign(secret: string, claimId: string, expiresAtMs: number): string {
  return createHmac("sha256", secret).update(`payment-confirm:${claimId}:${String(expiresAtMs)}`).digest("hex");
}

export function signConfirmToken(claimId: string, nowMs: number, secret: string, ttlMs: number = CLAIM_TTL_MS): { token: string; expiresAtMs: number } {
  const expiresAtMs = nowMs + ttlMs;
  return { token: `${claimId}.${String(expiresAtMs)}.${sign(secret, claimId, expiresAtMs)}`, expiresAtMs };
}

export type ConfirmTokenResult =
  | { ok: true; claimId: string; expiresAtMs: number }
  | { ok: false; reason: "invalid" | "expired" };

export function verifyConfirmToken(token: string, nowMs: number, secret: string): ConfirmTokenResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [claimId, expiry, signature] = parts as [string, string, string];
  if (!/^[0-9a-f-]{36}$/i.test(claimId) || !/^\d{10,15}$/.test(expiry) || !/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: "invalid" };
  }
  const expiresAtMs = Number(expiry);
  const expected = Buffer.from(sign(secret, claimId, expiresAtMs), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "invalid" };
  if (nowMs > expiresAtMs) return { ok: false, reason: "expired" };
  return { ok: true, claimId, expiresAtMs };
}
