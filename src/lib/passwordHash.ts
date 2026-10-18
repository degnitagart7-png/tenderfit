import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Хэш пароля: scrypt с солью.
 *
 * Строка: `scrypt$N$r$p$соль$хэш` (соль и хэш в base64url). Параметры хранятся
 * в строке, чтобы их можно было усилить позже, не ломая старые пароли.
 */

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Совпадает ли пароль с хэшем. Испорченная строка — «нет», а не исключение. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltText, keyText] = parts;
  const expected = Buffer.from(keyText ?? "", "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  try {
    const key = await derive(password, Buffer.from(saltText ?? "", "base64url"), Number(n), Number(r), Number(p));
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
