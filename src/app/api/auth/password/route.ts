import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authLimiter, readJson, tooMany } from "@/app/api/auth/session";
import { describeError } from "@/lib/errors";
import { SESSION_COOKIE, getAuthService } from "@/services/authRuntime";
import { MIN_PASSWORD_LENGTH } from "@/services/authService";

/**
 * Смена пароля из личного кабинета: POST { current, next }. Только для вошедшего:
 * почта берётся из сессии, а не из тела запроса.
 */
export const runtime = "nodejs";

const limiter = authLimiter(20);

const bodySchema = z.object({ current: z.string().max(500), next: z.string().max(500) });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = tooMany(request, limiter);
  if (limited) return limited;

  const auth = getAuthService();
  if (auth === null) return NextResponse.json({ error: "Вход пока не настроен на сервере." }, { status: 503 });

  let user;
  try {
    user = await auth.getUser(request.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    user = null;
  }
  if (user === null) return NextResponse.json({ error: "Нужно войти." }, { status: 401 });

  const parsed = bodySchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "Данные не приняты." }, { status: 400 });

  try {
    const result = await auth.changePassword({ email: user.email, ...parsed.data });
    if (result.ok) return NextResponse.json({ ok: true });
    return result.reason === "weak_password"
      ? NextResponse.json({ error: `Пароль — не короче ${String(MIN_PASSWORD_LENGTH)} знаков.` }, { status: 400 })
      : NextResponse.json({ error: "Текущий пароль неверен." }, { status: 400 });
  } catch (error) {
    console.error("Пароль не сменён:", describeError(error));
    return NextResponse.json({ error: "Сменить пароль сейчас не удалось." }, { status: 503 });
  }
}
