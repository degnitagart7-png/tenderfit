import { NextRequest, NextResponse } from "next/server";

import { LOGIN_REQUIRED_MESSAGE } from "@/app/api/auth/requireAccess";
import { isAdminEmail } from "@/domain/access";
import { describeError } from "@/lib/errors";
import { SESSION_COOKIE, getAuthService } from "@/services/authRuntime";

/**
 * Проверка администратора для ручек /api/admin/*.
 *
 * Пускает только вошедшего человека, чья почта есть в ADMIN_EMAILS. Служебные
 * ключи (`x-worker-secret`, `x-admin-token`), которые обходят `requireAccess`,
 * здесь НЕ действуют: эти ручки отдают почты и расход всех пользователей, а ключ
 * воркера лежит на сервере с правами шире, чем у человека за экраном. Режим
 * разработки без входа (AUTH_DISABLED) тоже не открывает: без сессии нет почты,
 * которую можно сверить со списком.
 *
 * Ответы: 401 — не вошёл; 403 — вошёл, но не администратор; 503 — вход не
 * настроен или база сессий недоступна (открывать из-за сбоя нельзя).
 */

export const ADMIN_ONLY_MESSAGE = "Раздел только для администратора";

export type AdminGate = { ok: true; email: string } | { ok: false; response: NextResponse };

export async function requireAdmin(request: NextRequest): Promise<AdminGate> {
  const auth = getAuthService();
  if (auth === null) {
    return { ok: false, response: NextResponse.json({ error: "Вход пока не настроен на сервере." }, { status: 503 }) };
  }

  let user;
  try {
    user = await auth.getUser(request.cookies.get(SESSION_COOKIE)?.value);
  } catch (error) {
    console.error("Админ-панель: сессия не прочитана:", describeError(error));
    return {
      ok: false,
      response: NextResponse.json({ error: "Сервис временно недоступен. Попробуйте позже." }, { status: 503 }),
    };
  }
  if (user === null) {
    return { ok: false, response: NextResponse.json({ error: LOGIN_REQUIRED_MESSAGE }, { status: 401 }) };
  }
  if (!isAdminEmail(user.email)) {
    return { ok: false, response: NextResponse.json({ error: ADMIN_ONLY_MESSAGE }, { status: 403 }) };
  }
  return { ok: true, email: user.email };
}
