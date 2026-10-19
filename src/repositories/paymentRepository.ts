import type { PaymentInvoice, PaymentMethod, PaymentStatus } from "@/domain/payments";
import { getSupabaseServerClient } from "@/lib/supabase";

/**
 * База оплаты: счета/заявки (`payment_invoices`), журнал событий банка (`payment_events`) и
 * функции `payment_apply_activation`, `payment_next_invoice_number`. Читает и пишет только
 * серверный код и воркер с ключом service role. Всё создаёт миграция
 * 20261020000026_payment_invoices.sql.
 *
 * Интерфейс `PaymentStore` — то, что нужно сервисам оплаты; тесты подставляют своё
 * хранилище в памяти, а `paymentRepository` — боевое.
 */

export interface NewInvoiceRow {
  userEmail: string;
  plan: string;
  amountRub: number;
  months: number;
  method: PaymentMethod;
  invoiceNumber: string | null;
  buyerInn: string | null;
  buyerKpp: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
}

export type InvoicePatch = Partial<{
  status: PaymentStatus;
  tochkaDocumentId: string | null;
  closingDocumentId: string | null;
  closingSentAt: number | null;
  rawLastStatus: Record<string, unknown> | null;
}>;

export type ActivationRpcResult =
  | { result: "applied"; activatedUntil: number }
  | { result: "already"; activatedUntil: number | null }
  | { result: "conflict" }
  | { result: "not_payable"; status: string }
  | { result: "not_found" }
  | { result: "no_user" };

export type EventKind = "payment" | "sbp" | "sbp_b2b";
export type EventOutcome = "activated" | "already_paid" | "unmatched" | "ambiguous" | "amount_mismatch" | "ignored" | "error";

export interface PaymentEvent {
  id: string;
  ref: string;
  kind: EventKind;
  amountRub: number;
  purpose: string;
  payerInn: string | null;
  payerName: string | null;
  receivedAt: number;
  processedAt: number | null;
  outcome: EventOutcome | null;
  matchedInvoiceId: string | null;
}

export interface NewEvent {
  ref: string;
  kind: EventKind;
  amountRub: number;
  purpose: string;
  payerInn: string | null;
  payerName: string | null;
  raw: Record<string, unknown>;
}

export interface PaymentStore {
  nextInvoiceNumber(): Promise<string>;
  insertInvoice(row: NewInvoiceRow): Promise<PaymentInvoice>;
  getInvoice(id: string): Promise<PaymentInvoice | null>;
  updateInvoice(id: string, patch: InvoicePatch): Promise<void>;
  listByUser(email: string, limit: number): Promise<PaymentInvoice[]>;
  listAll(limit: number): Promise<PaymentInvoice[]>;
  countOpenByUser(email: string): Promise<number>;
  /** Открытая заявка по QR того же человека на тот же тариф (двойной клик не плодит заявки). */
  findOpenClaim(email: string, plan: string, sinceMs: number): Promise<PaymentInvoice | null>;
  /** Счета с documentId, ждущие оплату, не старше `sinceMs`: что опрашивает воркер. */
  listIssuedForPoll(sinceMs: number, limit: number): Promise<PaymentInvoice[]>;
  /** Ждущие счета и заявки + недавно оплаченные: пул для сопоставления платежа. */
  listForMatching(sinceMs: number, paidSinceMs: number): Promise<PaymentInvoice[]>;
  /** Перевод ждущих в «просрочен»: число закрытых. */
  expireIssued(method: PaymentMethod, olderThanMs: number): Promise<number>;
  applyActivation(args: {
    invoiceId: string;
    ref: string;
    newUntilMs: number;
    expectedPrevMs: number | null;
    nowMs: number;
  }): Promise<ActivationRpcResult>;

  /** Записать событие банка; `created: false` — такой ref уже был (повторная доставка). */
  recordEvent(event: NewEvent): Promise<{ event: PaymentEvent; created: boolean }>;
  markEventProcessed(id: string, outcome: EventOutcome, matchedInvoiceId: string | null, nowMs: number): Promise<void>;
  listPendingEvents(olderThanMs: number, limit: number): Promise<PaymentEvent[]>;
  /** Платежи по QR без пары за последние часы и на ту сумму: кандидаты для заявки, созданной позже платежа. */
  listUnmatchedSbpEvents(sinceMs: number, amountRub: number): Promise<PaymentEvent[]>;
}

/* ---------------------------------- Боевое хранилище ---------------------------------- */

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const ms = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : parsed;
};
const iso = (value: number): string => new Date(value).toISOString();

function fail(error: { message?: string; code?: string } | null): void {
  if (error) throw error;
}

export function rowToInvoice(row: Row): PaymentInvoice {
  return {
    id: String(row["id"]),
    userEmail: String(row["user_email"]),
    plan: String(row["plan"]),
    amountRub: num(row["amount_rub"]),
    months: num(row["months"]),
    status: String(row["status"]) as PaymentStatus,
    method: String(row["method"]) as PaymentMethod,
    buyerInn: str(row["buyer_inn"]),
    buyerKpp: str(row["buyer_kpp"]),
    buyerName: str(row["buyer_name"]),
    buyerEmail: str(row["buyer_email"]),
    invoiceNumber: str(row["invoice_number"]),
    tochkaDocumentId: str(row["tochka_document_id"]),
    tochkaPaymentRef: str(row["tochka_payment_ref"]),
    paidAt: ms(row["paid_at"]),
    activatedUntil: ms(row["activated_until"]),
    closingDocumentId: str(row["closing_document_id"]),
    closingSentAt: ms(row["closing_sent_at"]),
    createdAt: ms(row["created_at"]) ?? 0,
    updatedAt: ms(row["updated_at"]) ?? 0,
  };
}

function rowToEvent(row: Row): PaymentEvent {
  return {
    id: String(row["id"]),
    ref: String(row["ref"]),
    kind: String(row["kind"]) as EventKind,
    amountRub: num(row["amount_rub"]),
    purpose: str(row["purpose"]) ?? "",
    payerInn: str(row["payer_inn"]),
    payerName: str(row["payer_name"]),
    receivedAt: ms(row["received_at"]) ?? 0,
    processedAt: ms(row["processed_at"]),
    outcome: (str(row["outcome"]) as EventOutcome | null) ?? null,
    matchedInvoiceId: str(row["matched_invoice_id"]),
  };
}

const TABLE = "payment_invoices";
const EVENTS = "payment_events";

export const paymentRepository: PaymentStore = {
  async nextInvoiceNumber() {
    const { data, error } = await getSupabaseServerClient().rpc("payment_next_invoice_number");
    fail(error);
    if (typeof data !== "string" || data === "") throw new Error("База не выдала номер счёта");
    return data;
  },

  async insertInvoice(row) {
    const { data, error } = await getSupabaseServerClient()
      .from(TABLE)
      .insert({
        user_email: row.userEmail,
        plan: row.plan,
        amount_rub: row.amountRub,
        months: row.months,
        method: row.method,
        invoice_number: row.invoiceNumber,
        buyer_inn: row.buyerInn,
        buyer_kpp: row.buyerKpp,
        buyer_name: row.buyerName,
        buyer_email: row.buyerEmail,
      })
      .select("*")
      .single();
    fail(error);
    return rowToInvoice(data as Row);
  },

  async getInvoice(id) {
    const { data, error } = await getSupabaseServerClient().from(TABLE).select("*").eq("id", id).limit(1);
    fail(error);
    const row = (data as Row[] | null)?.[0];
    return row ? rowToInvoice(row) : null;
  },

  async updateInvoice(id, patch) {
    const update: Row = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) update["status"] = patch.status;
    if (patch.tochkaDocumentId !== undefined) update["tochka_document_id"] = patch.tochkaDocumentId;
    if (patch.closingDocumentId !== undefined) update["closing_document_id"] = patch.closingDocumentId;
    if (patch.closingSentAt !== undefined) update["closing_sent_at"] = patch.closingSentAt === null ? null : iso(patch.closingSentAt);
    if (patch.rawLastStatus !== undefined) update["raw_last_status"] = patch.rawLastStatus;
    const { error } = await getSupabaseServerClient().from(TABLE).update(update).eq("id", id);
    fail(error);
  },

  async listByUser(email, limit) {
    const { data, error } = await getSupabaseServerClient()
      .from(TABLE)
      .select("*")
      .eq("user_email", email)
      // Счёт, который банк не принял, клиенту не показывается: он не существует ни для кого.
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(limit);
    fail(error);
    return ((data as Row[] | null) ?? []).map(rowToInvoice);
  },

  async listAll(limit) {
    const { data, error } = await getSupabaseServerClient()
      .from(TABLE)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    fail(error);
    return ((data as Row[] | null) ?? []).map(rowToInvoice);
  },

  async countOpenByUser(email) {
    const { count, error } = await getSupabaseServerClient()
      .from(TABLE)
      .select("id", { count: "exact", head: true })
      .eq("user_email", email)
      .eq("status", "issued")
      .eq("method", "invoice");
    fail(error);
    return count ?? 0;
  },

  async findOpenClaim(email, plan, sinceMs) {
    const { data, error } = await getSupabaseServerClient()
      .from(TABLE)
      .select("*")
      .eq("user_email", email)
      .eq("method", "sbp_claim")
      .eq("status", "issued")
      .eq("plan", plan)
      .gte("created_at", iso(sinceMs))
      .order("created_at", { ascending: false })
      .limit(1);
    fail(error);
    const row = (data as Row[] | null)?.[0];
    return row ? rowToInvoice(row) : null;
  },

  async listIssuedForPoll(sinceMs, limit) {
    const { data, error } = await getSupabaseServerClient()
      .from(TABLE)
      .select("*")
      .eq("method", "invoice")
      .eq("status", "issued")
      .not("tochka_document_id", "is", null)
      .gte("created_at", iso(sinceMs))
      .order("created_at", { ascending: true })
      .limit(limit);
    fail(error);
    return ((data as Row[] | null) ?? []).map(rowToInvoice);
  },

  async listForMatching(sinceMs, paidSinceMs) {
    const client = getSupabaseServerClient();
    const [open, paid] = await Promise.all([
      client.from(TABLE).select("*").eq("status", "issued").gte("created_at", iso(sinceMs)).limit(2000),
      client.from(TABLE).select("*").eq("status", "paid").gte("paid_at", iso(paidSinceMs)).limit(500),
    ]);
    fail(open.error);
    fail(paid.error);
    return [...((open.data as Row[] | null) ?? []), ...((paid.data as Row[] | null) ?? [])].map(rowToInvoice);
  },

  async expireIssued(method, olderThanMs) {
    const { data, error } = await getSupabaseServerClient()
      .from(TABLE)
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("status", "issued")
      .eq("method", method)
      .lt("created_at", iso(olderThanMs))
      .select("id");
    fail(error);
    return (data ?? []).length;
  },

  async applyActivation(args) {
    const { data, error } = await getSupabaseServerClient().rpc("payment_apply_activation", {
      p_invoice_id: args.invoiceId,
      p_ref: args.ref,
      p_new_until: iso(args.newUntilMs),
      p_expected_prev: args.expectedPrevMs === null ? null : iso(args.expectedPrevMs),
      p_now: iso(args.nowMs),
    });
    // 23505 — этот платёж уже включил другой счёт: повторная обработка, а не сбой.
    if (error?.code === "23505") return { result: "already", activatedUntil: null };
    fail(error);
    const body = (data ?? {}) as Row;
    switch (body["result"]) {
      case "applied":
        return { result: "applied", activatedUntil: ms(body["activated_until"]) ?? args.newUntilMs };
      case "already":
        return { result: "already", activatedUntil: ms(body["activated_until"]) };
      case "conflict":
        return { result: "conflict" };
      case "not_payable":
        return { result: "not_payable", status: String(body["status"] ?? "") };
      case "no_user":
        return { result: "no_user" };
      default:
        return { result: "not_found" };
    }
  },

  async recordEvent(event) {
    const client = getSupabaseServerClient();
    const inserted = await client
      .from(EVENTS)
      .insert({
        ref: event.ref,
        kind: event.kind,
        amount_rub: event.amountRub,
        purpose: event.purpose.slice(0, 1000),
        payer_inn: event.payerInn,
        payer_name: event.payerName,
        raw: event.raw,
      })
      .select("*")
      .single();
    if (!inserted.error) return { event: rowToEvent(inserted.data as Row), created: true };
    // 23505 — событие с таким ref уже записано: читаем его.
    if (inserted.error.code !== "23505") throw inserted.error;
    const existing = await client.from(EVENTS).select("*").eq("ref", event.ref).limit(1);
    fail(existing.error);
    const row = (existing.data as Row[] | null)?.[0];
    if (!row) throw new Error("Событие банка не найдено после конфликта ключей");
    return { event: rowToEvent(row), created: false };
  },

  async markEventProcessed(id, outcome, matchedInvoiceId, nowMs) {
    const { error } = await getSupabaseServerClient()
      .from(EVENTS)
      .update({ processed_at: iso(nowMs), outcome, matched_invoice_id: matchedInvoiceId })
      .eq("id", id);
    fail(error);
  },

  async listPendingEvents(olderThanMs, limit) {
    const { data, error } = await getSupabaseServerClient()
      .from(EVENTS)
      .select("*")
      .is("processed_at", null)
      .lt("received_at", iso(olderThanMs))
      .order("received_at", { ascending: true })
      .limit(limit);
    fail(error);
    return ((data as Row[] | null) ?? []).map(rowToEvent);
  },

  async listUnmatchedSbpEvents(sinceMs, amountRub) {
    const { data, error } = await getSupabaseServerClient()
      .from(EVENTS)
      .select("*")
      .in("kind", ["sbp", "sbp_b2b"])
      .eq("outcome", "unmatched")
      .eq("amount_rub", amountRub)
      .gte("received_at", iso(sinceMs))
      .order("received_at", { ascending: true })
      .limit(10);
    fail(error);
    return ((data as Row[] | null) ?? []).map(rowToEvent);
  },
};
