import { NextRequest, NextResponse } from "next/server";

import { defaultPaymentDeps } from "@/services/payments/deps";
import { downloadInvoicePdf, getOwnInvoice } from "@/services/payments/invoiceService";
import { requirePayer } from "@/services/payments/routeAuth";

/**
 * GET /api/payments/invoices/{id}/pdf — PDF своего счёта (проксируется из банка).
 *
 * Чужой счёт неотличим от несуществующего: 404 в обоих случаях. Администратор открывает любой.
 * Ссылку на файл банка клиент не получает: документ отдаёт наш сервер под нашей проверкой владельца.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const payer = await requirePayer(request);
  if (!payer.ok) return payer.response;

  const deps = defaultPaymentDeps();
  const own = await getOwnInvoice(deps, params.id, payer.email, payer.isAdmin);
  if (!own.ok) return NextResponse.json({ error: own.message }, { status: own.status });

  const file = await downloadInvoicePdf(deps, own.invoice);
  if (!file.ok) return NextResponse.json({ error: file.message }, { status: file.status });
  return new NextResponse(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      "Content-Type": file.contentType.includes("pdf") ? file.contentType : "application/pdf",
      "Content-Disposition": `attachment; filename="invoice.pdf"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
