import { NextRequest, NextResponse } from "next/server";

import { describeError } from "@/lib/errors";
import { defaultPaymentDeps } from "@/services/payments/deps";
import { handleWebhookPayload } from "@/services/payments/webhookService";
import { getWebhookVerifier } from "@/services/payments/webhookRuntime";

/**
 * POST /api/payments/tochka/webhook — вебхуки Точка Банка (без сессии: бьёт банк).
 *
 * Тело — «голая» строка JWT (Content-Type: text/plain), подписанная RS256. Непроверенное — 401 и
 * ничего не делается. Проверенное событие обрабатывается сразу (запись в журнал, сопоставление,
 * включение подписки; письма и акт — в фоне) и получает 200: банк при любом другом ответе
 * повторяет доставку 30 раз с интервалом 10 секунд. Не-200 мы отдаём лишь когда не смогли
 * записать событие (база недоступна) — тогда повтор банка нам и нужен. Сбой разбора после записи
 * событие не теряет: воркер разберёт его заново.
 *
 * В журнал уходят только вид события и причина отказа: ни тело, ни подпись не пишутся.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 20_000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = (await request.text()).trim();
  if (token === "" || token.length > MAX_BODY_CHARS) return NextResponse.json({ error: "Пустое тело" }, { status: 400 });

  const verified = await getWebhookVerifier().verify(token);
  if (!verified.ok) {
    console.warn(`Вебхук Точки отклонён: ${verified.reason}`);
    return NextResponse.json({ error: "Подпись не подтверждена" }, { status: 401 });
  }

  try {
    const result = await handleWebhookPayload(defaultPaymentDeps(), verified.payload, token, { background: true });
    return NextResponse.json({ ok: true, status: result.status });
  } catch (error) {
    console.error("Вебхук Точки: событие не записано:", describeError(error));
    return NextResponse.json({ error: "Не удалось принять событие" }, { status: 500 });
  }
}
