import { NextRequest, NextResponse } from "next/server";

import { hasAccess, resolveAccess } from "@/domain/access";
import { describeError } from "@/lib/errors";
import { LOGIN_REQUIRED_MESSAGE, EXPIRED_MESSAGE } from "@/app/api/auth/requireAccess";
import { rememberRequestEmail } from "@/app/api/auth/requestUser";
import { SESSION_COOKIE, getAuthService } from "@/services/authRuntime";

/**
 * Вошедший пользователь для ручек «Компания»: нужен и его `id` (по нему лежат анкета и результаты сверки), а не только почта.
 *
 * Служебный ключ воркера здесь не годится: ручки работают с данными конкретного человека, а «от имени воркера» такого
 * человека нет. Нет входа — 401, срок доступа вышел — 402 (как у остальных платных ручек), вход не настроен — 503.
 */
export interface CompanyUser {
  id: string;
  email: string;
}

export async function requireCompanyUser(request: NextRequest): Promise<{ ok: true; user: CompanyUser } | { ok: false; response: NextResponse }> {
  const auth = getAuthService();
  if (auth === null) {
    return { ok: false, response: NextResponse.json({ error: "Вход пока не настроен на сервере." }, { status: 503 }) };
  }
  let user;
  try {
    user = await auth.getUser(request.cookies.get(SESSION_COOKIE)?.value);
  } catch (error) {
    console.error("Компания: сессия не прочитана:", describeError(error));
    return { ok: false, response: NextResponse.json({ error: "Сервис временно недоступен. Попробуйте позже." }, { status: 503 }) };
  }
  if (user === null) return { ok: false, response: NextResponse.json({ error: LOGIN_REQUIRED_MESSAGE }, { status: 401 }) };
  rememberRequestEmail(request, user.email);
  if (!hasAccess(resolveAccess(user.access, user.email, Date.now()))) {
    return { ok: false, response: NextResponse.json({ error: EXPIRED_MESSAGE, reason: "expired" }, { status: 402 }) };
  }
  return { ok: true, user: { id: user.id, email: user.email } };
}
