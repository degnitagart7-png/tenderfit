import { NextRequest, NextResponse } from "next/server";

import { requireAccess } from "@/app/api/auth/requireAccess";
import { requestEmail } from "@/app/api/auth/requestUser";
import { createRateLimiter } from "@/lib/rateLimit";
import { defaultNotificationDeps, sendDigestNow } from "@/services/notificationService";

/**
 * POST /api/notifications/test — «Прислать пробную сводку сейчас».
 *
 * Собирает сводку для вошедшего (новое за сутки, сроки, закупки в работе) и отправляет её на его
 * же почту. Тело не нужно: адрес берётся из сессии, а не из запроса, поэтому написать этой ручкой
 * постороннему нельзя. Письмо уходит при любом шлюзе `NOTIFY_RECIPIENTS`, кроме `off`.
 *
 * Ответ: `{ sent, items, reason? }`. Нечего сообщить или почта не настроена — это не ошибка
 * сервера, а `sent: false` с причиной, которую страница показывает человеку. Лимит — пять писем
 * за десять минут на человека: пробное письмо можно нажать подряд, а почтовый ящик сервиса — не резиновый.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 5, windowMs: 10 * 60_000 });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  // Почту знает только проверка сессии: служебный ключ и режим разработки её не дают, а это письмо — личное.
  const email = requestEmail(request);
  if (email === null) return NextResponse.json({ error: "Войдите, чтобы получить сводку." }, { status: 401 });

  const decision = limiter.check(email);
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Слишком часто. Подождите немного и повторите.", retryAfterSec: decision.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
    );
  }

  const result = await sendDigestNow(email, defaultNotificationDeps());
  return NextResponse.json(result);
}
