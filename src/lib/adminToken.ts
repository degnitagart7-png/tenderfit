import { createHash, timingSafeEqual } from "node:crypto";

/** Короче — подбирается перебором за минуты, и ручка остаётся выключенной. */
export const MIN_ADMIN_TOKEN_LENGTH = 12;

export type AdminTokenCheck = "ok" | "disabled" | "denied";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Сверяет присланный ключ с ключом из окружения.
 *
 * Не задан или слишком короток — `disabled`: ручка выключена, а не открыта.
 * Сравнение идёт по хэшам равной длины через `timingSafeEqual`, чтобы время
 * ответа не выдавало, сколько знаков угадано.
 */
export function checkAdminToken(
  provided: string | null | undefined,
  expected: string | undefined,
): AdminTokenCheck {
  const secret = (expected ?? "").trim();
  if (secret.length < MIN_ADMIN_TOKEN_LENGTH) return "disabled";
  if (provided === null || provided === undefined || provided === "") return "denied";
  return timingSafeEqual(digest(provided), digest(secret)) ? "ok" : "denied";
}
