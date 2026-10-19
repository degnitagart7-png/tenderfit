import type { PaymentInvoiceView } from "@/domain/payments";
import { readJsonOrThrow } from "@/lib/readJson";

/** Клиент ручек оплаты (/api/payments/*). Сообщение ошибки — слова сервера. */

export interface InvoiceList {
  invoices: PaymentInvoiceView[];
  /** Банк настроен: можно выставлять счёт онлайн. */
  billingReady: boolean;
}

export interface CreateInvoicePayload {
  planId: string;
  inn: string;
  kpp?: string;
  name: string;
  email: string;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow<T>(response);
}

export const paymentsApiService = {
  async list(): Promise<InvoiceList> {
    const response = await fetch("/api/payments/invoices", { cache: "no-store" });
    const data = await readJsonOrThrow<Partial<InvoiceList>>(response);
    return { invoices: data.invoices ?? [], billingReady: data.billingReady !== false };
  },

  createInvoice(payload: CreateInvoicePayload): Promise<{ invoice: PaymentInvoiceView; emailSent: boolean }> {
    return post("/api/payments/invoices", payload);
  },

  resend(id: string, email?: string): Promise<{ sent: boolean; sentTo: string }> {
    return post(`/api/payments/invoices/${encodeURIComponent(id)}/send`, email === undefined ? {} : { email });
  },

  claimSbp(planId: string): Promise<{ claim: PaymentInvoiceView; confirmed: boolean }> {
    return post("/api/payments/sbp-claim", { planId });
  },

  /** Ссылка на PDF: открывается обычным переходом, файл отдаёт наш сервер после проверки владельца. */
  pdfUrl(id: string): string {
    return `/api/payments/invoices/${encodeURIComponent(id)}/pdf`;
  },
};
