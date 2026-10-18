import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authLimiter, readJson, tooMany, withSessionCookie } from "@/app/api/auth/session";
import { describeError } from "@/lib/errors";
import { getAuthService } from "@/services/authRuntime";
import { recordUserEvent } from "@/services/userEventLog";

/**
 * Вход по паролю: POST { email, password }.
 *
 * Неверный пароль и неизвестная почта отвечают одинаково. Подбор ограничен
 * дважды: лимитом на адрес запроса здесь и блокировкой почты после десяти
 * ошибок за 15 минут в сервисе.
 */
export const runtime = "nodejs";

const limiter = authLimiter(30);

const bodySchema = z.object({ email: z.string().max(320), password: z.string().max(500) });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = tooMany(request, limiter);
  if (limited) return limited;

  const auth = getAuthService();
  if (auth === null) return NextResponse.json({ error: "Вход пока не настроен на сервере." }, { status: 503 });

  const parsed = bodySchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "Неверная почта или пароль." }, { status: 400 });

  try {
    const result = await auth.loginWithPassword(parsed.data);
    if (!result.ok) {
      return result.reason === "locked"
        ? NextResponse.json({ error: "Слишком много неудачных попыток. Попробуйте через 15 минут." }, { status: 429 })
        : NextResponse.json({ error: "Неверная почта или пароль." }, { status: 400 });
    }
    void recordUserEvent({ email: result.user.email, kind: "login", detail: "пароль" });
    return withSessionCookie(NextResponse.json({ user: { email: result.user.email } }), result.token, result.maxAgeSec);
  } catch (error) {
    console.error("Вход не удался:", describeError(error));
    return NextResponse.json({ error: "Вход сейчас недоступен. Попробуйте позже." }, { status: 503 });
  }
}
