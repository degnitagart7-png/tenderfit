import { NextRequest, NextResponse } from "next/server";

import { hasAccess, resolveAccess, type AccessInfo } from "@/domain/access";
import { checkAdminToken } from "@/lib/adminToken";
import { rememberRequestEmail } from "@/app/api/auth/requestUser";
import { describeError } from "@/lib/errors";
import { WORKER_SECRET_HEADER } from "@/lib/workerSecret";
import { SESSION_COOKIE, getAuthService } from "@/services/authRuntime";

/**
 * Проверка доступа для ручек, которые стоят денег или составляют ядро продукта.
 *
 * Применение в начале обработчика:
 *
 *   const denied = await requireAccess(request);
 *   if (denied) return denied;
 *
 * Ответы:
 *  - 401 {error: "Войдите, чтобы продолжить"} — нет действующей сессии;
 *  - 402 {error: "Пробный период закончился — выберите тариф", reason: "expired"} —
 *    вошёл, но ни оплаты, ни пробного периода нет;
 *  - 503 — вход не настроен на сервере или база недоступна: открывать платное из-за
 *    сбоя нельзя.
 *
 * Мимо проверки идут запросы, которые приходят не от человека: воркер с верным
 * секретом `x-worker-secret` (TENDERFIT_WORKER_SECRET) и владелец с верным
 * ключом `x-admin-token` (ADMIN_TOKEN). Оба сравниваются в постоянное время
 * (см. adminToken), а ключ не задан или короткий — обход выключен, а не открыт.
 *
 * Для локальной разработки без базы: AUTH_DISABLED=1 выключает проверку, но
 * только вне production — на боевой сборке переменная ничего не значит.
 */

export const LOGIN_REQUIRED_MESSAGE = "Войдите, чтобы продолжить";
export const EXPIRED_MESSAGE = "Пробный период закончился — выберите тариф";

/** Запрос от воркера или владельца по служебному ключу. */
export function hasServiceKey(request: NextRequest): boolean {
  const worker = checkAdminToken(request.headers.get(WORKER_SECRET_HEADER), process.env["TENDERFIT_WORKER_SECRET"]);
  if (worker === "ok") return true;
  return checkAdminToken(request.headers.get("x-admin-token"), process.env["ADMIN_TOKEN"]) === "ok";
}

export function authDisabledForDev(): boolean {
  return process.env["NODE_ENV"] !== "production" && process.env["AUTH_DISABLED"] === "1";
}

export type AccessLookup =
  | { ok: true; email: string | null; access: AccessInfo | null }
  | { ok: false; response: NextResponse };

/**
 * Кто вошёл и какой у него доступ, без отказа: для ручек, которым нужна и
 * почта, и статус. Служебный ключ и режим разработки дают `access: null`.
 */
export async function lookupAccess(request: NextRequest): Promise<AccessLookup> {
  if (hasServiceKey(request) || authDisabledForDev()) return { ok: true, email: null, access: null };

  const auth = getAuthService();
  if (auth === null) {
    return { ok: false, response: NextResponse.json({ error: "Вход пока не настроен на сервере." }, { status: 503 }) };
  }

  let user;
  try {
    user = await auth.getUser(request.cookies.get(SESSION_COOKIE)?.value);
  } catch (error) {
    console.error("Доступ: сессия не прочитана:", describeError(error));
    return {
      ok: false,
      response: NextResponse.json({ error: "Сервис временно недоступен. Попробуйте позже." }, { status: 503 }),
    };
  }
  if (user === null) {
    return { ok: false, response: NextResponse.json({ error: LOGIN_REQUIRED_MESSAGE }, { status: 401 }) };
  }
  // Почта нужна журналу действий (/admin/users): см. requestUser.ts.
  rememberRequestEmail(request, user.email);
  return { ok: true, email: user.email, access: resolveAccess(user.access, user.email, Date.now()) };
}

/** null — пропустить; иначе готовый ответ 401, 402 или 503. */
export async function requireAccess(request: NextRequest): Promise<NextResponse | null> {
  const found = await lookupAccess(request);
  if (!found.ok) return found.response;
  if (found.access !== null && !hasAccess(found.access)) {
    return NextResponse.json({ error: EXPIRED_MESSAGE, reason: "expired" }, { status: 402 });
  }
  return null;
}
