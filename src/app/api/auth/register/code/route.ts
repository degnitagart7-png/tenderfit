import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAssistLimiter } from "@/app/api/search/guard";
import { GOOGLE_MAIL_BLOCKED_MESSAGE } from "@/domain/emailPolicy";
import { clientKey } from "@/lib/rateLimit";
import { codeLoginEnabled, getAuthService } from "@/services/authRuntime";

/**
 * Код подтверждения регистрации: POST { email, consent } — на почту уходит
 * шестизначный код, с которым POST /api/auth/register создаёт аккаунт.
 *
 * Защита та же, что у кода входа: лимит на адрес запроса, лимиты писем на
 * адрес почты внутри сервиса и закрытая почта Google. Занятая почта
 * отвечает 409 до письма.
 */
export const runtime = "nodejs";

const limiter = createAssistLimiter(10);

const bodySchema = z.object({ email: z.string().max(320), consent: z.boolean() });

const MESSAGES = {
  invalid_email: "Введите корректный адрес почты.",
  consent_required: "Нужно согласие на обработку персональных данных.",
  blocked_google: GOOGLE_MAIL_BLOCKED_MESSAGE,
  exists: "Эта почта уже зарегистрирована. Войдите с паролем.",
  too_soon: "Код уже отправлен. Подождите немного перед повторной отправкой.",
  too_many: "Слишком много писем на этот адрес. Попробуйте через час.",
  mail_failed: "Не удалось отправить письмо. Попробуйте позже.",
} as const;

const STATUS = {
  invalid_email: 400,
  consent_required: 400,
  blocked_google: 403,
  exists: 409,
  too_soon: 429,
  too_many: 429,
  mail_failed: 503,
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const decision = limiter.check(clientKey(request.headers));
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Слишком много попыток. Подождите немного.", retryAfterSec: decision.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
    );
  }

  const auth = getAuthService();
  if (auth === null || !codeLoginEnabled()) {
    return NextResponse.json({ error: "Подтверждение почты не настроено на сервере." }, { status: 503 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: MESSAGES.invalid_email }, { status: 400 });

  const result = await auth.requestRegisterCode(parsed.data);
  if (result.ok) return NextResponse.json({ sent: true });

  return NextResponse.json(
    { error: MESSAGES[result.reason], reason: result.reason, retryAfterSec: result.retryAfterSec },
    { status: STATUS[result.reason] },
  );
}
