"use client";

import { useState } from "react";
import { Download, Mail } from "lucide-react";
import { Badge, Button } from "@/components/ui/primitives";
import { formatDay, formatRub, planLabel, statusText, statusTone } from "@/components/billing/paymentFormat";
import type { PaymentInvoiceView } from "@/domain/payments";
import { paymentsApiService } from "@/services/paymentsApiService";

/** Строка счёта или заявки: номер, сумма, статус, файл и повторная отправка. */
export function InvoiceRow({ invoice }: { invoice: PaymentInvoiceView }) {
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const isInvoice = invoice.method === "invoice";

  async function resend() {
    setSending(true);
    setNotice(null);
    try {
      const sent = await paymentsApiService.resend(invoice.id);
      setNotice({ text: `Отправили на ${sent.sentTo}`, error: false });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Не удалось отправить", error: true });
    } finally {
      setSending(false);
    }
  }

  return (
    <li className="py-3.5" data-testid="invoice-row">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[15px] font-medium text-foreground">
          {isInvoice ? `Счёт № ${invoice.invoiceNumber ?? "—"}` : "Оплата по QR (СБП)"}
          <span className="ml-2 font-normal text-muted-foreground">
            «{planLabel(invoice.plan)}» · {formatRub(invoice.amountRub)}
          </span>
        </p>
        <Badge tone={statusTone(invoice.status)}>{statusText(invoice)}</Badge>
      </div>
      <p className="mt-1 text-[13px] text-faint">
        {formatDay(invoice.createdAt)}
        {invoice.status === "paid" && invoice.activatedUntil !== null ? ` · подписка до ${formatDay(invoice.activatedUntil)}` : ""}
        {isInvoice && invoice.buyerName ? ` · ${invoice.buyerName}` : ""}
      </p>
      {isInvoice && invoice.hasPdf && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <a
            href={paymentsApiService.pdfUrl(invoice.id)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[14px] text-foreground hover:border-border-strong"
          >
            <Download className="h-4 w-4" aria-hidden /> Скачать PDF
          </a>
          {invoice.status === "issued" && (
            <Button variant="secondary" size="sm" loading={sending} onClick={() => void resend()}>
              {!sending && <Mail className="h-4 w-4" aria-hidden />} Отправить на почту
            </Button>
          )}
          {notice && (
            <span role="status" className={notice.error ? "text-[13px] text-brick-fg" : "text-[13px] text-olive-fg"}>
              {notice.text}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

/** «Мои счета»: новые сверху. */
export function MyInvoices({ invoices }: { invoices: readonly PaymentInvoiceView[] }) {
  if (invoices.length === 0) return null;
  return (
    <section aria-label="Мои счета">
      <h2 className="text-[17px] font-semibold tracking-tight text-foreground">Мои счета</h2>
      <ul className="mt-3 divide-y divide-border border-y border-border" data-testid="invoice-list">
        {invoices.map((invoice) => (
          <InvoiceRow key={invoice.id} invoice={invoice} />
        ))}
      </ul>
    </section>
  );
}
