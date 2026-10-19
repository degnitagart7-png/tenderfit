import {
  INVOICE_TTL_MS,
  MAX_OPEN_INVOICES_PER_USER,
  invoiceAmount,
  isValidEmail,
  parseBuyer,
  payablePlan,
  type BuyerInput,
  type PaymentInvoice,
} from "@/domain/payments";
import { describeError } from "@/lib/errors";
import type { PaymentDeps } from "@/services/payments/deps";
import { TochkaApiError } from "@/services/tochka";

/**
 * Счета клиента: выставить, показать свои, скачать PDF, отправить на почту ещё раз.
 *
 * Выставление: валидируем покупателя и тариф → берём наш номер из последовательности базы →
 * записываем счёт (`issued`, ещё без documentId) → создаём документ в Точке → дописываем
 * documentId → просим банк отправить PDF на почту покупателя. Банк отказал — строка помечается
 * `cancelled` (клиенту не показывается), клиент видит понятную причину. Письмо не ушло — счёт всё
 * равно выставлен: PDF можно скачать, письмо — отправить повторно.
 */

export type CreateInvoiceError =
  | { code: "invalid_plan"; message: string }
  | { code: "invalid_buyer"; message: string; field: "inn" | "kpp" | "name" | "email" }
  | { code: "not_configured"; message: string }
  | { code: "too_many_open"; message: string }
  | { code: "bank_error"; message: string };

export type CreateInvoiceResult =
  | { ok: true; invoice: PaymentInvoice; emailSent: boolean }
  | ({ ok: false } & CreateInvoiceError);

export interface CreateInvoiceInput {
  email: string;
  planId: string;
  months?: number;
  buyer: BuyerInput;
}

export async function createInvoice(deps: PaymentDeps, input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
  const plan = payablePlan(input.planId);
  if (plan === null) {
    return { ok: false, code: "invalid_plan", message: "На этот тариф счёт онлайн не выставляется: условия пакета обсуждаются по почте." };
  }
  const months = input.months ?? 1;
  if (!Number.isInteger(months) || months < 1 || months > 12) {
    return { ok: false, code: "invalid_plan", message: "Срок подписки — от 1 до 12 месяцев." };
  }
  const buyer = parseBuyer(input.buyer);
  if (!buyer.ok) return { ok: false, code: "invalid_buyer", message: buyer.error, field: buyer.field };

  const tochka = deps.tochka;
  if (tochka === null) {
    return { ok: false, code: "not_configured", message: "Выставление счетов временно недоступно. Напишите нам — выставим счёт вручную." };
  }
  if ((await deps.store.countOpenByUser(input.email)) >= MAX_OPEN_INVOICES_PER_USER) {
    return { ok: false, code: "too_many_open", message: "У вас уже много неоплаченных счетов. Оплатите один из них или напишите нам." };
  }

  const amountRub = invoiceAmount(plan, months);
  const number = await deps.store.nextInvoiceNumber();
  const row = await deps.store.insertInvoice({
    userEmail: input.email,
    plan: plan.id,
    amountRub,
    months,
    method: "invoice",
    invoiceNumber: number,
    buyerInn: buyer.buyer.inn,
    buyerKpp: buyer.buyer.kpp,
    buyerName: buyer.buyer.name,
    buyerEmail: buyer.buyer.email,
  });

  const nowMs = deps.now();
  let documentId: string;
  try {
    ({ documentId } = await tochka.createInvoice({
      number,
      buyer: buyer.buyer,
      planName: plan.name,
      months,
      amountRub,
      nowMs,
      expiresAtMs: nowMs + INVOICE_TTL_MS,
    }));
  } catch (error) {
    deps.log(`счёт ${number}: банк не выставил: ${describeError(error)}`);
    await deps.store.updateInvoice(row.id, { status: "cancelled" }).catch(() => undefined);
    const message =
      error instanceof TochkaApiError && error.status === 400
        ? "Банк не принял реквизиты счёта. Проверьте ИНН, КПП и название организации."
        : "Не удалось выставить счёт: банк сейчас не отвечает. Попробуйте через несколько минут или напишите нам.";
    return { ok: false, code: "bank_error", message };
  }

  try {
    await deps.store.updateInvoice(row.id, { tochkaDocumentId: documentId });
  } catch (error) {
    // Счёт в банке есть, а связать его со строкой не вышло: документ не теряем — он в журнале.
    deps.log(`счёт ${number}: documentId ${documentId} не записан в базу: ${describeError(error)}`);
    throw error;
  }
  const invoice: PaymentInvoice = { ...row, tochkaDocumentId: documentId };

  let emailSent = false;
  try {
    await tochka.sendInvoiceToEmail(documentId, buyer.buyer.email);
    emailSent = true;
  } catch (error) {
    deps.log(`счёт ${number}: письмо с PDF не отправлено: ${describeError(error)}`);
  }
  return { ok: true, invoice, emailSent };
}

export async function listMyInvoices(deps: PaymentDeps, email: string, limit = 50): Promise<PaymentInvoice[]> {
  return deps.store.listByUser(email, limit);
}

export async function listAllInvoices(deps: PaymentDeps, limit = 200): Promise<PaymentInvoice[]> {
  return deps.store.listAll(limit);
}

export type OwnInvoice =
  | { ok: true; invoice: PaymentInvoice }
  | { ok: false; status: 404; message: string };

/** Свой счёт по id; чужой (или несуществующий) — одинаковое «не найден»: существование чужих счетов не раскрываем. */
export async function getOwnInvoice(deps: PaymentDeps, id: string, email: string, isAdmin: boolean): Promise<OwnInvoice> {
  const notFound: OwnInvoice = { ok: false, status: 404, message: "Счёт не найден" };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound;
  const invoice = await deps.store.getInvoice(id);
  if (invoice === null || invoice.method !== "invoice") return notFound;
  if (invoice.userEmail !== email.trim().toLowerCase() && !isAdmin) return notFound;
  return { ok: true, invoice };
}

export async function downloadInvoicePdf(
  deps: PaymentDeps,
  invoice: PaymentInvoice,
): Promise<{ ok: true; bytes: Buffer; contentType: string; filename: string } | { ok: false; status: number; message: string }> {
  if (deps.tochka === null || invoice.tochkaDocumentId === null) {
    return { ok: false, status: 409, message: "У этого счёта нет файла" };
  }
  try {
    const file = await deps.tochka.getInvoicePdf(invoice.tochkaDocumentId);
    const safeNumber = (invoice.invoiceNumber ?? invoice.id).replace(/[^\p{L}\d-]/gu, "");
    return { ok: true, bytes: file.bytes, contentType: file.contentType, filename: `Счёт-${safeNumber}.pdf` };
  } catch (error) {
    deps.log(`PDF счёта ${invoice.invoiceNumber ?? invoice.id}: ${describeError(error)}`);
    return { ok: false, status: 502, message: "Не удалось получить файл из банка. Попробуйте позже." };
  }
}

export async function resendInvoice(
  deps: PaymentDeps,
  invoice: PaymentInvoice,
  email: string | null,
): Promise<{ ok: true; sentTo: string } | { ok: false; status: number; message: string }> {
  const to = (email ?? invoice.buyerEmail ?? "").trim().toLowerCase();
  if (!isValidEmail(to)) return { ok: false, status: 400, message: "Укажите почту, на которую отправить счёт." };
  if (invoice.status !== "issued") return { ok: false, status: 409, message: "Счёт уже не ждёт оплаты." };
  if (deps.tochka === null || invoice.tochkaDocumentId === null) return { ok: false, status: 409, message: "У этого счёта нет файла" };
  try {
    await deps.tochka.sendInvoiceToEmail(invoice.tochkaDocumentId, to);
    return { ok: true, sentTo: to };
  } catch (error) {
    deps.log(`письмо со счётом ${invoice.invoiceNumber ?? invoice.id}: ${describeError(error)}`);
    return { ok: false, status: 502, message: "Банк не смог отправить письмо. Скачайте счёт и отправьте сами." };
  }
}
