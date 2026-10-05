import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authLimiter, readJson, tooMany, withSessionCookie } from "@/app/api/auth/session";
import { describeError } from "@/lib/errors";
import { codeLoginEnabled, getAuthService } from "@/services/authRuntime";
import { MIN_PASSWORD_LENGTH } from "@/services/authService";

/**
 * Восстановление пароля: POST { email, code, password }. Код приходит письмом
 * (запрашивается той же ручкой, что и вход по коду). При успехе пароль заменён
 * и человек сразу внутри.
 */
export const runtime = "nodejs";

const limiter = authLimiter(30);

const bodySchema = z.object({ email: z.string().max(320), code: z.string().max(12), password: z.string().max(500) });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = tooMany(request, limiter);
  if (limited) return limited;

  const auth = getAuthService();
  if (auth === null || !codeLoginEnabled()) {
    return NextResponse.json({ error: "Восстановление пароля пока не настроено." }, { status: 503 });
  }

  const parsed = bodySchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "Код не подошёл или устарел." }, { status: 400 });

  try {
    const result = await auth.resetPassword(parsed.data);
    if (!result.ok) {
      return result.reason === "weak_password"
        ? NextResponse.json({ error: `Пароль — не короче ${String(MIN_PASSWORD_LENGTH)} знаков.` }, { status: 400 })
        : NextResponse.json({ error: "Код не подошёл или устарел. Запросите новый." }, { status: 400 });
    }
    return withSessionCookie(NextResponse.json({ user: { email: result.user.email } }), result.token, result.maxAgeSec);
  } catch (error) {
    console.error("Пароль не восстановлен:", describeError(error));
    return NextResponse.json({ error: "Восстановить пароль сейчас не удалось." }, { status: 503 });
  }
}
