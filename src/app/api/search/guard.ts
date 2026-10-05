import { NextRequest, NextResponse } from "next/server";
import type { ZodType } from "zod";

import { clientKey, createRateLimiter, type RateLimiter } from "@/lib/rateLimit";

/**
 * Общая часть ручек помощника поиска: разбор тела и лимит на адрес.
 *
 * Ручки открыты без входа, а за каждым обращением стоит платный вызов модели,
 * поэтому проверка входа и лимит живут в одном месте: две ручки, у которых
 * правила разошлись, — это одна ручка без защиты.
 */

/** Десять минут: окно лимита. Достаточно для человека, мало для скрипта. */
export const ASSIST_WINDOW_MS = 10 * 60 * 1000;

export function createAssistLimiter(limit: number): RateLimiter {
  return createRateLimiter({ limit, windowMs: ASSIST_WINDOW_MS });
}

/**
 * Разбирает тело запроса или возвращает готовый ответ с ошибкой.
 *
 * Лимит проверяется ДО разбора и до обращения к модели: отказанный запрос не
 * должен стоить ни токенов, ни времени сервера.
 */
export async function readGuardedBody<T>(
  request: NextRequest,
  limiter: RateLimiter,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  const decision = limiter.check(clientKey(request.headers));
  if (!decision.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Слишком много запросов к помощнику. Подождите немного.", retryAfterSec: decision.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
      ),
    };
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 }) };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Запрос не прошёл проверку" }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}
