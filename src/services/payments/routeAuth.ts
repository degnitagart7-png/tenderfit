import { NextResponse, type NextRequest } from "next/server";

import { lookupAccess, LOGIN_REQUIRED_MESSAGE } from "@/app/api/auth/requireAccess";
import { isAdminEmail } from "@/domain/access";

/**
 * Кто платит: вошедший пользователь, в том числе с истёкшим доступом.
 *
 * Ручки оплаты нельзя закрывать `requireAccess`: у человека с закончившимся пробным периодом
 * приложение закрыто, но «Оплата» открыта (`isOpenWhenExpired`), иначе платить было бы нечем.
 * Поэтому проверяется только сессия (`lookupAccess` без решения о сроке). Служебные ключи
 * воркера и владельца и режим разработки почты не дают — счёт всегда чей-то, а не «ничей».
 */

export type Payer = { ok: true; email: string; isAdmin: boolean } | { ok: false; response: NextResponse };

export async function requirePayer(request: NextRequest): Promise<Payer> {
  const found = await lookupAccess(request);
  if (!found.ok) return found;
  if (found.email === null) {
    return { ok: false, response: NextResponse.json({ error: LOGIN_REQUIRED_MESSAGE }, { status: 401 }) };
  }
  return { ok: true, email: found.email, isAdmin: isAdminEmail(found.email) };
}

export function tooManyRequests(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    { error: "Слишком часто. Подождите немного и повторите.", retryAfterSec },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}
