import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

import { TOCHKA_PUBLIC_KEY_URL } from "@/services/tochka/config";

/**
 * Проверка вебхука Точки: тело — «голая» строка JWT, подписанная RS256. Подпись сверяется
 * открытым ключом банка (https://enter.tochka.com/doc/openapi/static/keys/public, формат JWK);
 * непроверенное событие обрабатывать нельзя.
 *
 * Ключ берётся по адресу и кэшируется в памяти (ключ банка может смениться — документация
 * советует не зашивать его в код). Если подпись не сошлась с кэшированным ключом, ключ
 * перечитывается один раз (не чаще раза в минуту): так смена ключа не ломает приём. Запасной
 * вариант — ключ из TOCHKA_WEBHOOK_PUBLIC_KEY (JWK-JSON или PEM) на случай, когда адрес
 * банка недоступен с сервера.
 *
 * Принимается только алгоритм RS256: токен с `alg: none` или HS256 (подделка, где «секретом»
 * служит открытый ключ) отклоняется до проверки подписи.
 */

const KEY_TTL_MS = 6 * 3_600_000;
const REFETCH_MIN_MS = 60_000;

export interface WebhookVerifyDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Адрес ключа банка. */
  keyUrl?: string;
  /** Запасной ключ из окружения. */
  pinnedKey?: string | null;
}

export type VerifyResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: "malformed" | "algorithm" | "signature" | "no_key" | "payload" };

const b64 = (part: string): Buffer => Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Ключи из JWK-JSON (один ключ, `{keys:[…]}` или массив) либо PEM. Нечитаемое пропускается. */
export function parsePublicKeys(text: string): KeyObject[] {
  const trimmed = text.trim();
  const out: KeyObject[] = [];
  if (trimmed.startsWith("-----BEGIN")) {
    try {
      out.push(createPublicKey(trimmed));
    } catch {
      /* ключ нечитаем — пропускаем */
    }
    return out;
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return out;
  }
  const items: unknown[] = Array.isArray(json)
    ? json
    : typeof json === "object" && json !== null && Array.isArray((json as { keys?: unknown }).keys)
      ? (json as { keys: unknown[] }).keys
      : [json];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    try {
      out.push(createPublicKey({ key: item as import("node:crypto").JsonWebKey, format: "jwk" }));
    } catch {
      /* пропускаем */
    }
  }
  return out;
}

function verifySignature(signingInput: string, signature: Buffer, key: KeyObject): boolean {
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    return verifier.verify(key, signature);
  } catch {
    return false;
  }
}

export interface WebhookVerifier {
  verify(token: string): Promise<VerifyResult>;
}

export function createWebhookVerifier(deps: WebhookVerifyDeps = {}): WebhookVerifier {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const keyUrl = deps.keyUrl ?? TOCHKA_PUBLIC_KEY_URL;
  const pinned = deps.pinnedKey ? parsePublicKeys(deps.pinnedKey) : [];

  let cached: KeyObject[] = [];
  let fetchedAt = 0;
  let attemptedAt = 0;

  async function refresh(): Promise<void> {
    attemptedAt = now();
    try {
      const response = await doFetch(keyUrl, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
      if (!response.ok) return;
      const keys = parsePublicKeys(await response.text());
      if (keys.length > 0) {
        cached = keys;
        fetchedAt = now();
      }
    } catch {
      /* адрес банка недоступен: остаются кэш и запасной ключ */
    }
  }

  return {
    async verify(token) {
      const parts = token.trim().split(".");
      if (parts.length !== 3 || parts.some((p) => p === "")) return { ok: false, reason: "malformed" };
      const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

      let header: { alg?: unknown };
      let payload: unknown;
      try {
        header = JSON.parse(b64(headerB64).toString("utf8")) as { alg?: unknown };
        payload = JSON.parse(b64(payloadB64).toString("utf8"));
      } catch {
        return { ok: false, reason: "malformed" };
      }
      if (header.alg !== "RS256") return { ok: false, reason: "algorithm" };
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { ok: false, reason: "payload" };

      const signingInput = `${headerB64}.${payloadB64}`;
      const signature = b64(signatureB64);
      const tryKeys = (keys: KeyObject[]): boolean => keys.some((key) => verifySignature(signingInput, signature, key));

      if (cached.length === 0 || now() - fetchedAt > KEY_TTL_MS) await refresh();
      if (tryKeys(cached) || tryKeys(pinned)) return { ok: true, payload: payload as Record<string, unknown> };

      // Подпись не сошлась: возможно, банк сменил ключ. Перечитываем, но не чаще раза в минуту.
      if (now() - attemptedAt >= REFETCH_MIN_MS) {
        await refresh();
        if (tryKeys(cached)) return { ok: true, payload: payload as Record<string, unknown> };
      }
      return { ok: false, reason: cached.length === 0 && pinned.length === 0 ? "no_key" : "signature" };
    },
  };
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Строка JWT из тела вебхука.
 *
 * По документации Точка шлёт «голую» строку с `Content-Type: text/plain`, но первые тестовые
 * вебхуки боевого контура (20.10.2026) отклонились как malformed. Поэтому тело принимается в
 * трёх видах: голая строка, та же строка в кавычках (JSON-строка) и JSON-объект, в одном из
 * строковых полей которого лежит JWT. Подпись проверяется дальше как обычно — терпимость
 * к упаковке ничего не ослабляет.
 */
export function extractWebhookToken(raw: string): string {
  const body = raw.trim();
  if (JWT_SHAPE.test(body)) return body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "string" && JWT_SHAPE.test(parsed.trim())) return parsed.trim();
    if (parsed !== null && typeof parsed === "object") {
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (typeof value === "string" && JWT_SHAPE.test(value.trim())) return value.trim();
      }
    }
  } catch {
    // не JSON — вернём как есть, проверка скажет malformed
  }
  return body;
}

/** Форма тела для журнала без содержимого: длина, число частей через точку, первый символ, тип. */
export function describeWebhookBody(raw: string, contentType: string | null): string {
  const body = raw.trim();
  const first = body.charAt(0);
  const firstLabel = /[A-Za-z0-9]/.test(first) ? "буква/цифра" : JSON.stringify(first);
  return `длина ${String(body.length)}, частей ${String(body.split(".").length)}, первый символ ${firstLabel}, content-type ${contentType ?? "нет"}`;
}

