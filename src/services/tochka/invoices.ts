import { buyerTypeByInn, invoicePositionName, moscowDate } from "@/domain/payments";
import type { Buyer } from "@/domain/payments";
import type { TochkaConfig } from "@/services/tochka/config";
import { TochkaApiError, type TochkaTransport } from "@/services/tochka/client";

/**
 * Счета и закрывающие документы Точки (раздел «Создание счетов и закрывающих документов»,
 * разрешение ManageInvoiceData). Пути — из ссылок на методы документации:
 *
 *   POST /invoice/v1.0/bills                                         Create Invoice
 *   GET  /invoice/v1.0/bills/{customerCode}/{documentId}/file        Get Invoice (PDF)
 *   GET  /invoice/v1.0/bills/{customerCode}/{documentId}/payment-status
 *   POST /invoice/v1.0/bills/{customerCode}/{documentId}/email       Send Invoice To Email
 *   POST /invoice/v1.0/closing-documents                             Create Closing Document
 *   GET  /invoice/v1.0/closing-documents/{customerCode}/{documentId}/file
 *   POST /invoice/v1.0/closing-documents/{customerCode}/{documentId}/email
 *
 * Статусы оплаты: payment_waiting, payment_paid, payment_expired.
 */

export type InvoicePaymentStatus = "payment_waiting" | "payment_paid" | "payment_expired" | "unknown";

export interface CreateInvoiceInput {
  /** Наш номер счёта: «ТФ-0001». */
  number: string;
  buyer: Buyer;
  planName: string;
  months: number;
  amountRub: number;
  nowMs: number;
  /** Срок оплаты, мс от эпохи; банк сам пометит счёт просроченным. */
  expiresAtMs: number;
}

// «услуга.» из UnitCodeEnum спецификации Точки (swagger, 20.10.2026): подписка — услуга, не штука.
const unit = "услуга.";

/** Позиция счёта и акта: одна услуга за полную сумму, без НДС. */
function position(config: TochkaConfig, input: { planName: string; months: number; amountRub: number }) {
  return {
    positionName: invoicePositionName({ name: input.planName }, input.months),
    unitCode: unit,
    ndsKind: config.ndsKind,
    price: input.amountRub,
    quantity: 1,
    totalAmount: input.amountRub,
  };
}

/** Данные покупателя (SecondSide): ИНН и тип обязательны, КПП и название — для организаций. */
function secondSide(buyer: Buyer) {
  return {
    taxCode: buyer.inn,
    type: buyerTypeByInn(buyer.inn),
    secondSideName: buyer.name,
    ...(buyer.kpp === null ? {} : { kpp: buyer.kpp }),
  };
}

export function buildCreateInvoiceBody(config: TochkaConfig, input: CreateInvoiceInput): unknown {
  return {
    Data: {
      accountId: config.accountId,
      customerCode: config.customerCode,
      SecondSide: secondSide(input.buyer),
      Content: {
        Invoice: {
          Positions: [position(config, input)],
          date: moscowDate(input.nowMs),
          totalAmount: input.amountRub,
          number: input.number,
          basedOn: "Публичная оферта",
          comment: "Подписка на сервис ТендерФит. Без НДС (УСН).",
          paymentExpiryDate: moscowDate(input.expiresAtMs),
        },
      },
    },
  };
}

/**
 * Тело акта. В документации банка схема `Content` закрывающего документа не раскрыта: известно
 * лишь, что вид документа определяет дочерний объект (`Act` — акт выполненных работ) и что внутри
 * лежат `Positions`, итоги и дата. Поля повторяют счёт (`Content.Invoice`); сверка с боевым
 * ответом — при первой оплате, сбой акта оплату не отменяет.
 */
export type CreateActInput = Omit<CreateInvoiceInput, "expiresAtMs"> & { invoiceDocumentId: string };

export function buildCreateActBody(config: TochkaConfig, input: CreateActInput): unknown {
  return {
    Data: {
      accountId: config.accountId,
      customerCode: config.customerCode,
      SecondSide: secondSide(input.buyer),
      documentId: input.invoiceDocumentId,
      Content: {
        Act: {
          Positions: [position(config, input)],
          date: moscowDate(input.nowMs),
          totalAmount: input.amountRub,
          number: input.number,
          basedOn: "Публичная оферта",
        },
      },
    },
  };
}

interface DocumentCreated {
  Data?: { documentId?: unknown };
}
interface StatusResponse {
  Data?: { paymentStatus?: unknown };
}
interface BooleanResponse {
  Data?: { result?: unknown };
}

function documentIdOf(response: DocumentCreated): string {
  const id = response.Data?.documentId;
  if (typeof id !== "string" || id === "") throw new TochkaApiError("Банк не вернул номер документа", 200);
  return id;
}

const enc = encodeURIComponent;

export interface TochkaInvoices {
  createInvoice(input: CreateInvoiceInput): Promise<{ documentId: string }>;
  getInvoicePdf(documentId: string): Promise<{ bytes: Buffer; contentType: string }>;
  getInvoicePaymentStatus(documentId: string): Promise<InvoicePaymentStatus>;
  sendInvoiceToEmail(documentId: string, email: string): Promise<void>;
  createAct(input: CreateActInput): Promise<{ documentId: string }>;
  getClosingPdf(documentId: string): Promise<{ bytes: Buffer; contentType: string }>;
  sendClosingToEmail(documentId: string, email: string): Promise<void>;
}

export function createTochkaInvoices(config: TochkaConfig, transport: TochkaTransport): TochkaInvoices {
  const bills = (documentId: string, tail: string): string =>
    `/invoice/v1.0/bills/${enc(config.customerCode)}/${enc(documentId)}/${tail}`;
  const closing = (documentId: string, tail: string): string =>
    `/invoice/v1.0/closing-documents/${enc(config.customerCode)}/${enc(documentId)}/${tail}`;

  async function sendEmail(path: string, email: string): Promise<void> {
    const response = await transport.json<BooleanResponse>({
      method: "POST",
      path,
      body: { Data: { email } },
      // Повторная отправка письма безвредна.
      idempotent: true,
    });
    if (response.Data?.result !== true) throw new TochkaApiError("Банк не отправил документ на почту", 200);
  }

  return {
    async createInvoice(input) {
      // Не идемпотентно: после обрыва банк мог создать счёт, и повтор выставил бы второй.
      const response = await transport.json<DocumentCreated>({
        method: "POST",
        path: "/invoice/v1.0/bills",
        body: buildCreateInvoiceBody(config, input),
      });
      return { documentId: documentIdOf(response) };
    },
    getInvoicePdf: (documentId) => transport.file({ method: "GET", path: bills(documentId, "file") }),
    async getInvoicePaymentStatus(documentId) {
      const response = await transport.json<StatusResponse>({
        method: "GET",
        path: bills(documentId, "payment-status"),
        idempotent: true,
      });
      const status = response.Data?.paymentStatus;
      return status === "payment_waiting" || status === "payment_paid" || status === "payment_expired" ? status : "unknown";
    },
    sendInvoiceToEmail: (documentId, email) => sendEmail(bills(documentId, "email"), email),
    async createAct(input) {
      const response = await transport.json<DocumentCreated>({
        method: "POST",
        path: "/invoice/v1.0/closing-documents",
        body: buildCreateActBody(config, input),
      });
      return { documentId: documentIdOf(response) };
    },
    getClosingPdf: (documentId) => transport.file({ method: "GET", path: closing(documentId, "file") }),
    sendClosingToEmail: (documentId, email) => sendEmail(closing(documentId, "email"), email),
  };
}
