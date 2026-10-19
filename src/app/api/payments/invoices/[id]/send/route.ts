import { NextRequest, NextResponse } from "next/server";

import { createRateLimiter } from "@/lib/rateLimit";
import { defaultPaymentDeps } from "@/services/payments/deps";
import { getOwnInvoice, resendInvoice } from "@/services/payments/invoiceService";
import { requirePayer, tooManyRequests } from "@/services/payments/routeAuth";

/**
 * POST /api/payments/invoices/{id}/send — отправить свой счёт на почту ещё раз: {email?}
 * (без поля — на почту, указанную при выставлении). Не чаще десяти раз в час на человека.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 10, windowMs: 3_600_000 });

export async function POST(request: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const payer = await requirePayer(request);
  if (!payer.ok) return payer.response;

  const deps = defaultPaymentDeps();
  const own = await getOwnInvoice(deps, params.id, payer.email, payer.isAdmin);
  if (!own.ok) return NextResponse.json({ error: own.message }, { status: own.status });

  const decision = limiter.check(payer.email);
  if (!decision.allowed) return tooManyRequests(decision.retryAfterSec);

  let email: string | null = null;
  try {
    const body = (await request.json()) as { email?: unknown };
    if (typeof body.email === "string" && body.email.trim() !== "") email = body.email;
  } catch {
    /* тело необязательно */
  }
  const sent = await resendInvoice(deps, own.invoice, email);
  if (!sent.ok) return NextResponse.json({ error: sent.message }, { status: sent.status });
  return NextResponse.json({ sent: true, sentTo: sent.sentTo });
}
