import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAssistLimiter } from "@/app/api/search/guard";
import { clientKey } from "@/lib/rateLimit";
import { SESSION_COOKIE, getAuthService } from "@/services/authRuntime";
import { recordUserEvent } from "@/services/userEventLog";

/**
 * Проверка кода входа: POST { email, code } — при успехе ставит сессионную куку.
 *
 * Кука httpOnly (страница её не читает, значит и чужой скрипт на странице не
 * украдёт), SameSite=Lax (чужой сайт не отправит запрос от имени человека),
 * Secure на проде. Подбор кода ограничен пятью попытками на код внутри сервиса
 * и лимитом на адрес запроса здесь.
 */
export const runtime = "nodejs";

const limiter = createAssistLimiter(30);

const bodySchema = z.object({ email: z.string().max(320), code: z.string().max(12) });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const decision = limiter.check(clientKey(request.headers));
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Слишком много попыток. Подождите немного.", retryAfterSec: decision.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
    );
  }

  const auth = getAuthService();
  if (auth === null) {
    return NextResponse.json({ error: "Вход по почте пока не настроен на сервере." }, { status: 503 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Код не подошёл или устарел. Запросите новый." }, { status: 400 });
  }

  const result = await auth.verifyCode(parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: "Код не подошёл или устарел. Запросите новый." }, { status: 400 });
  }

  void recordUserEvent({ email: result.user.email, kind: "login", detail: "код из письма" });
  const response = NextResponse.json({ user: { email: result.user.email } });
  response.cookies.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: result.maxAgeSec,
  });
  return response;
}
