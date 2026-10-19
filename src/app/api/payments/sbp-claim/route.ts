import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { toInvoiceView } from "@/domain/payments";
import { describeError } from "@/lib/errors";
import { createRateLimiter } from "@/lib/rateLimit";
import { defaultPaymentDeps } from "@/services/payments/deps";
import { requirePayer, tooManyRequests } from "@/services/payments/routeAuth";
import { createSbpClaim } from "@/services/payments/sbpClaimService";

/**
 * POST /api/payments/sbp-claim — «Я оплатил» по статическому СБП-QR: {planId}.
 *
 * Создаёт заявку и пишет владельцу со ссылкой подтверждения; доступ до подтверждения не
 * открывается. Ответ: {claim, confirmed} — `confirmed: true`, если банк уже сообщил о платеже
 * на эту сумму (платёж пришёл раньше нажатия), и подписка включена сразу. Пять заявок в час на человека.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 5, windowMs: 3_600_000 });
const bodySchema = z.object({ planId: z.string().min(1).max(20) });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const payer = await requirePayer(request);
  if (!payer.ok) return payer.response;

  let planId: string;
  try {
    planId = bodySchema.parse(await request.json()).planId;
  } catch {
    return NextResponse.json({ error: "Выберите тариф." }, { status: 400 });
  }

  const decision = limiter.check(payer.email);
  if (!decision.allowed) return tooManyRequests(decision.retryAfterSec);

  try {
    const result = await createSbpClaim(defaultPaymentDeps(), { email: payer.email, planId });
    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: result.code === "not_configured" ? 503 : 400 });
    }
    return NextResponse.json({ claim: toInvoiceView(result.claim), confirmed: result.confirmed }, { status: 201 });
  } catch (error) {
    console.error("Заявка по QR не создана:", describeError(error));
    return NextResponse.json({ error: "Не удалось отправить заявку. Попробуйте позже или напишите нам." }, { status: 500 });
  }
}
