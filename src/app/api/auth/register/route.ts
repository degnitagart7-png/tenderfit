import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authLimiter, readJson, tooMany, withSessionCookie } from "@/app/api/auth/session";
import { GOOGLE_MAIL_BLOCKED_MESSAGE } from "@/domain/emailPolicy";
import { describeError } from "@/lib/errors";
import { getAuthService } from "@/services/authRuntime";
import { MIN_PASSWORD_LENGTH } from "@/services/authService";

/**
 * Регистрация: POST { email, password, consent } — создаёт аккаунт и сразу входит.
 *
 * Письмо не нужно, поэтому регистрация работает и без почтового сервера.
 * Почта Google не принимается, как и во входе по коду.
 */
export const runtime = "nodejs";

const limiter = authLimiter(10);

const bodySchema = z.object({
  email: z.string().max(320),
  password: z.string().max(500),
  consent: z.boolean(),
});

const MESSAGES = {
  invalid_email: "Введите корректный адрес почты.",
  consent_required: "Нужно согласие на обработку персональных данных.",
  blocked_google: GOOGLE_MAIL_BLOCKED_MESSAGE,
  weak_password: `Пароль — не короче ${String(MIN_PASSWORD_LENGTH)} знаков.`,
  exists: "Эта почта уже зарегистрирована. Войдите с паролем.",
} as const;

const STATUS = {
  invalid_email: 400,
  consent_required: 400,
  blocked_google: 403,
  weak_password: 400,
  exists: 409,
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = tooMany(request, limiter);
  if (limited) return limited;

  const auth = getAuthService();
  if (auth === null) return NextResponse.json({ error: "Вход пока не настроен на сервере." }, { status: 503 });

  const parsed = bodySchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: MESSAGES.invalid_email }, { status: 400 });

  try {
    const result = await auth.register(parsed.data);
    if (!result.ok) {
      return NextResponse.json({ error: MESSAGES[result.reason], reason: result.reason }, { status: STATUS[result.reason] });
    }
    return withSessionCookie(NextResponse.json({ user: { email: result.user.email } }), result.token, result.maxAgeSec);
  } catch (error) {
    console.error("Регистрация не удалась:", describeError(error));
    return NextResponse.json({ error: "Регистрация сейчас недоступна. Попробуйте позже." }, { status: 503 });
  }
}
