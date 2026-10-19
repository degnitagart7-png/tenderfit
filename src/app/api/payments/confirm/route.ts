import { NextRequest, NextResponse } from "next/server";

import { isAdminEmail } from "@/domain/access";
import { loginUrlWithNext } from "@/domain/loginRedirect";
import { confirmPageHtml } from "@/domain/paymentEmails";
import { describeError } from "@/lib/errors";
import { SESSION_COOKIE, getAuthService } from "@/services/authRuntime";
import { confirmSecret, verifyConfirmToken } from "@/services/payments/confirmToken";
import { defaultPaymentDeps } from "@/services/payments/deps";
import { confirmClaimByToken } from "@/services/payments/sbpClaimService";

/**
 * GET /api/payments/confirm?token=… — подтвердить оплату по QR (ссылка из письма владельцу).
 *
 * Три замка: подпись токена (HMAC, срок 14 дней), сессия администратора (ADMIN_EMAILS) и
 * одноразовость в базе (второе нажатие — «уже подтверждено»). Не вошёл — отправляем на /login
 * с возвратом сюда: после входа ссылка сработает сама. Ответ — маленькая HTML-страница, а не JSON:
 * её читает человек, открывший письмо.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(status: number, title: string, message: string): NextResponse {
  return new NextResponse(confirmPageHtml({ title, message }), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const deps = defaultPaymentDeps();

  const secret = confirmSecret(deps.env);
  if (secret === null) return page(503, "Подтверждение недоступно", "На сервере не задан PAYMENT_CONFIRM_SECRET.");
  // Подпись — до входа: по мусорной ссылке на логин не гоняем.
  const verified = verifyConfirmToken(token, deps.now(), secret);
  if (!verified.ok) {
    return verified.reason === "expired"
      ? page(410, "Ссылка устарела", "Срок ссылки (14 дней) вышел. Подтвердите оплату вручную: npx tsx scripts/grant-access.ts.")
      : page(400, "Ссылка не подходит", "Ссылка повреждена или подписана не нашим сервером.");
  }

  const auth = getAuthService();
  if (auth === null) return page(503, "Вход не настроен", "Войдите позже.");
  let user;
  try {
    user = await auth.getUser(request.cookies.get(SESSION_COOKIE)?.value);
  } catch (error) {
    console.error("Подтверждение оплаты: сессия не прочитана:", describeError(error));
    return page(503, "Сервис недоступен", "Попробуйте позже.");
  }
  if (user === null) {
    const next = `/api/payments/confirm?token=${encodeURIComponent(token)}`;
    return new NextResponse(null, { status: 302, headers: { Location: loginUrlWithNext(next), "Cache-Control": "no-store" } });
  }
  if (!isAdminEmail(user.email)) return page(403, "Только для администратора", "Откройте ссылку под аккаунтом администратора.");

  try {
    const result = await confirmClaimByToken(deps, token, user.email);
    switch (result.kind) {
      case "confirmed":
        return page(200, "Оплата подтверждена", `Подписка клиента ${result.claim.userEmail} включена. Ему отправлено письмо.`);
      case "already":
        return page(200, "Уже подтверждено", "Эта заявка уже закрыта — повторно подписка не продлевается.");
      case "not_found":
        return page(404, "Заявка не найдена", "Возможно, она удалена.");
      case "not_payable":
        return page(409, "Заявку нельзя подтвердить", `Статус заявки: ${result.status}.`);
      case "no_user":
        return page(409, "Аккаунт не найден", "Пользователь, подавший заявку, удалён.");
      case "expired":
        return page(410, "Ссылка устарела", "Срок ссылки вышел.");
      default:
        return page(400, "Ссылка не подходит", "Ссылка повреждена.");
    }
  } catch (error) {
    console.error("Подтверждение оплаты не удалось:", describeError(error));
    return page(500, "Не удалось подтвердить", "Попробуйте ещё раз: заявка не потеряна.");
  }
}
