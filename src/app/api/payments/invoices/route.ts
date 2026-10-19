import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { toInvoiceView } from "@/domain/payments";
import { describeError } from "@/lib/errors";
import { createRateLimiter } from "@/lib/rateLimit";
import { defaultPaymentDeps } from "@/services/payments/deps";
import { createInvoice, listAllInvoices, listMyInvoices } from "@/services/payments/invoiceService";
import { requirePayer, tooManyRequests } from "@/services/payments/routeAuth";

/**
 * Счета на оплату подписки.
 *
 * GET  /api/payments/invoices            — мои счета и заявки по QR, новые сверху; `?scope=all` — все (только администратор).
 * POST /api/payments/invoices            — выставить счёт: {planId, inn, kpp?, name, email}.
 *
 * Нужна только сессия, срок доступа не проверяется: у человека с закончившимся пробным периодом
 * страница оплаты открыта, и счёт ему выставить можно (см. routeAuth). Выставление — не чаще пяти
 * раз в час на человека: каждый счёт — настоящий документ в банке владельца.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createLimiter = createRateLimiter({ limit: 5, windowMs: 3_600_000 });

const bodySchema = z.object({
  planId: z.string().min(1).max(20),
  inn: z.string().max(20),
  kpp: z.string().max(20).optional(),
  name: z.string().max(400),
  email: z.string().max(254),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const payer = await requirePayer(request);
  if (!payer.ok) return payer.response;

  try {
    const deps = defaultPaymentDeps();
    if (request.nextUrl.searchParams.get("scope") === "all") {
      if (!payer.isAdmin) return NextResponse.json({ error: "Раздел только для администратора" }, { status: 403 });
      const all = await listAllInvoices(deps);
      return NextResponse.json({ invoices: all.map((invoice) => ({ ...toInvoiceView(invoice), userEmail: invoice.userEmail })) });
    }
    const mine = await listMyInvoices(deps, payer.email);
    // billingReady — банк настроен: без него форма счёта скрыта, остаётся запрос по почте.
    return NextResponse.json({ invoices: mine.map(toInvoiceView), billingReady: deps.tochka !== null });
  } catch (error) {
    console.error("Счета: список не прочитан:", describeError(error));
    return NextResponse.json({ error: "Не удалось загрузить счета. Попробуйте позже." }, { status: 503 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const payer = await requirePayer(request);
  if (!payer.ok) return payer.response;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Заполните тариф, ИНН, название и почту для счёта." }, { status: 400 });
  }

  const decision = createLimiter.check(payer.email);
  if (!decision.allowed) return tooManyRequests(decision.retryAfterSec);

  try {
    const result = await createInvoice(defaultPaymentDeps(), {
      email: payer.email,
      planId: body.planId,
      buyer: { inn: body.inn, kpp: body.kpp, name: body.name, email: body.email },
    });
    if (!result.ok) {
      const status = result.code === "bank_error" ? 502 : result.code === "not_configured" ? 503 : result.code === "too_many_open" ? 409 : 400;
      return NextResponse.json({ error: result.message, code: result.code, ...(result.code === "invalid_buyer" ? { field: result.field } : {}) }, { status });
    }
    return NextResponse.json({ invoice: toInvoiceView(result.invoice), emailSent: result.emailSent }, { status: 201 });
  } catch (error) {
    console.error("Счета: выставление не удалось:", describeError(error));
    return NextResponse.json({ error: "Не удалось выставить счёт. Попробуйте позже." }, { status: 500 });
  }
}
