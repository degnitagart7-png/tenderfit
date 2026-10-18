import { NextRequest, NextResponse } from "next/server";

import { createAssistLimiter } from "@/app/api/search/guard";
import { clientKey, type RateLimiter } from "@/lib/rateLimit";
import { SESSION_COOKIE } from "@/services/authRuntime";

/**
 * Общее для ручек входа: сессионная кука и лимит на адрес.
 *
 * Кука httpOnly (страница её не читает, значит и чужой скрипт на странице не
 * украдёт), SameSite=Lax (чужой сайт не отправит запрос от имени человека),
 * Secure на проде.
 */
export function withSessionCookie(response: NextResponse, token: string, maxAgeSec: number): NextResponse {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSec,
  });
  return response;
}

export function authLimiter(limit: number): RateLimiter {
  return createAssistLimiter(limit);
}

/** Ответ «слишком часто» или null, если запрос можно выполнять. */
export function tooMany(request: NextRequest, limiter: RateLimiter): NextResponse | null {
  const decision = limiter.check(clientKey(request.headers));
  if (decision.allowed) return null;
  return NextResponse.json(
    { error: "Слишком много попыток. Подождите немного.", retryAfterSec: decision.retryAfterSec },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
  );
}

export async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
