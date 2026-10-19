import type { EmailMessage } from "@/domain/emailTemplates";
import type { PaymentInvoice } from "@/domain/payments";
import type {
  ActivationRpcResult,
  EventOutcome,
  InvoicePatch,
  NewEvent,
  NewInvoiceRow,
  PaymentEvent,
  PaymentStore,
} from "@/repositories/paymentRepository";
import type { SubscriptionUser } from "@/repositories/subscriptionRepository";
import type { PaymentDeps, TochkaPort } from "@/services/payments/deps";
import type { TochkaConfig } from "@/services/tochka/config";

/**
 * Набор для тестов оплаты: хранилище в памяти с теми же правилами, что у SQL-функции
 * `payment_apply_activation`, поддельный банк и записывающая почта. Только для тестов.
 */

export interface MemoryState {
  invoices: PaymentInvoice[];
  events: PaymentEvent[];
  users: SubscriptionUser[];
}

export function createMemoryStore(initial: Partial<MemoryState> = {}) {
  const state: MemoryState = { invoices: [], events: [], users: [], ...initial };
  let seq = 0;
  let clock = () => Date.now();
  const refs = new Set<string>();

  const store: PaymentStore & { state: MemoryState; setClock(fn: () => number): void } = {
    state,
    setClock(fn) {
      clock = fn;
    },
    async nextInvoiceNumber() {
      seq += 1;
      return `ТФ-${String(seq).padStart(4, "0")}`;
    },
    async insertInvoice(row: NewInvoiceRow) {
      const now = clock();
      const invoice: PaymentInvoice = {
        id: `00000000-0000-4000-8000-${String(state.invoices.length + 1).padStart(12, "0")}`,
        userEmail: row.userEmail,
        plan: row.plan,
        amountRub: row.amountRub,
        months: row.months,
        status: "issued",
        method: row.method,
        buyerInn: row.buyerInn,
        buyerKpp: row.buyerKpp,
        buyerName: row.buyerName,
        buyerEmail: row.buyerEmail,
        invoiceNumber: row.invoiceNumber,
        tochkaDocumentId: null,
        tochkaPaymentRef: null,
        paidAt: null,
        activatedUntil: null,
        closingDocumentId: null,
        closingSentAt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.invoices.push(invoice);
      return { ...invoice };
    },
    async getInvoice(id) {
      const found = state.invoices.find((i) => i.id === id);
      return found ? { ...found } : null;
    },
    async updateInvoice(id, patch: InvoicePatch) {
      const found = state.invoices.find((i) => i.id === id);
      if (!found) return;
      if (patch.status !== undefined) found.status = patch.status;
      if (patch.tochkaDocumentId !== undefined) found.tochkaDocumentId = patch.tochkaDocumentId;
      if (patch.closingDocumentId !== undefined) found.closingDocumentId = patch.closingDocumentId;
      if (patch.closingSentAt !== undefined) found.closingSentAt = patch.closingSentAt;
      found.updatedAt = clock();
    },
    async listByUser(email, limit) {
      return state.invoices
        .filter((i) => i.userEmail === email && i.status !== "cancelled")
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((i) => ({ ...i }));
    },
    async listAll(limit) {
      return [...state.invoices].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((i) => ({ ...i }));
    },
    async countOpenByUser(email) {
      return state.invoices.filter((i) => i.userEmail === email && i.status === "issued" && i.method === "invoice").length;
    },
    async findOpenClaim(email, plan, sinceMs) {
      const found = state.invoices.find(
        (i) => i.userEmail === email && i.method === "sbp_claim" && i.status === "issued" && i.plan === plan && i.createdAt >= sinceMs,
      );
      return found ? { ...found } : null;
    },
    async listIssuedForPoll(sinceMs, limit) {
      return state.invoices
        .filter((i) => i.method === "invoice" && i.status === "issued" && i.tochkaDocumentId !== null && i.createdAt >= sinceMs)
        .slice(0, limit)
        .map((i) => ({ ...i }));
    },
    async listForMatching(sinceMs, paidSinceMs) {
      return state.invoices
        .filter((i) => (i.status === "issued" && i.createdAt >= sinceMs) || (i.status === "paid" && (i.paidAt ?? 0) >= paidSinceMs))
        .map((i) => ({ ...i }));
    },
    async expireIssued(method, olderThanMs) {
      let n = 0;
      for (const i of state.invoices) {
        if (i.status === "issued" && i.method === method && i.createdAt < olderThanMs) {
          i.status = "expired";
          n += 1;
        }
      }
      return n;
    },
    async applyActivation(args): Promise<ActivationRpcResult> {
      const inv = state.invoices.find((i) => i.id === args.invoiceId);
      if (!inv) return { result: "not_found" };
      if (inv.activatedUntil !== null) return { result: "already", activatedUntil: inv.activatedUntil };
      if (inv.status !== "issued" && inv.status !== "expired") return { result: "not_payable", status: inv.status };
      const user = state.users.find((u) => u.email === inv.userEmail);
      if (!user) return { result: "no_user" };
      if (user.paidUntil !== args.expectedPrevMs) return { result: "conflict" };
      if (refs.has(args.ref)) return { result: "already", activatedUntil: null };
      refs.add(args.ref);
      user.paidUntil = args.newUntilMs;
      user.plan = inv.plan;
      inv.status = "paid";
      inv.paidAt = args.nowMs;
      inv.tochkaPaymentRef = args.ref;
      inv.activatedUntil = args.newUntilMs;
      return { result: "applied", activatedUntil: args.newUntilMs };
    },
    async recordEvent(event: NewEvent) {
      const existing = state.events.find((e) => e.ref === event.ref);
      if (existing) return { event: { ...existing }, created: false };
      const row: PaymentEvent = {
        id: `ev-${String(state.events.length + 1)}`,
        ref: event.ref,
        kind: event.kind,
        amountRub: event.amountRub,
        purpose: event.purpose,
        payerInn: event.payerInn,
        payerName: event.payerName,
        receivedAt: clock(),
        processedAt: null,
        outcome: null,
        matchedInvoiceId: null,
      };
      state.events.push(row);
      return { event: { ...row }, created: true };
    },
    async markEventProcessed(id, outcome: EventOutcome, matchedInvoiceId, nowMs) {
      const row = state.events.find((e) => e.id === id);
      if (!row) return;
      row.processedAt = nowMs;
      row.outcome = outcome;
      row.matchedInvoiceId = matchedInvoiceId;
    },
    async listPendingEvents(olderThanMs, limit) {
      return state.events.filter((e) => e.processedAt === null && e.receivedAt < olderThanMs).slice(0, limit).map((e) => ({ ...e }));
    },
    async listUnmatchedSbpEvents(sinceMs, amountRub) {
      return state.events
        .filter((e) => (e.kind === "sbp" || e.kind === "sbp_b2b") && e.outcome === "unmatched" && e.amountRub === amountRub && e.receivedAt >= sinceMs)
        .map((e) => ({ ...e }));
    },
  };
  return store;
}

export const TEST_CONFIG: TochkaConfig = {
  baseUrl: "https://bank.test/uapi",
  jwt: "SECRET-JWT",
  clientId: "client-1",
  customerCode: "304550680",
  accountId: "40802810000000000001/044525104",
  sandbox: false,
  ndsKind: "without_nds",
  closingDocs: true,
  webhookPublicKey: null,
};

export interface FakeBank extends TochkaPort {
  calls: Array<{ method: string; args: unknown[] }>;
  statuses: Map<string, "payment_waiting" | "payment_paid" | "payment_expired">;
  failNext: Partial<Record<keyof Omit<TochkaPort, "config">, Error>>;
}

export function createFakeBank(config: TochkaConfig = TEST_CONFIG): FakeBank {
  let docs = 0;
  const bank: FakeBank = {
    config,
    calls: [],
    statuses: new Map(),
    failNext: {},
    async createInvoice(input) {
      bank.calls.push({ method: "createInvoice", args: [input] });
      const err = bank.failNext.createInvoice;
      if (err) {
        delete bank.failNext.createInvoice;
        throw err;
      }
      docs += 1;
      const documentId = `1cf95c4f-e794-4407-bac4-${String(docs).padStart(12, "0")}`;
      bank.statuses.set(documentId, "payment_waiting");
      return { documentId };
    },
    async getInvoicePdf(documentId) {
      bank.calls.push({ method: "getInvoicePdf", args: [documentId] });
      return { bytes: Buffer.from("%PDF-1.4 test"), contentType: "application/pdf" };
    },
    async getInvoicePaymentStatus(documentId) {
      bank.calls.push({ method: "getInvoicePaymentStatus", args: [documentId] });
      const err = bank.failNext.getInvoicePaymentStatus;
      if (err) {
        delete bank.failNext.getInvoicePaymentStatus;
        throw err;
      }
      return bank.statuses.get(documentId) ?? "payment_waiting";
    },
    async sendInvoiceToEmail(documentId, email) {
      bank.calls.push({ method: "sendInvoiceToEmail", args: [documentId, email] });
      const err = bank.failNext.sendInvoiceToEmail;
      if (err) {
        delete bank.failNext.sendInvoiceToEmail;
        throw err;
      }
    },
    async createAct(input) {
      bank.calls.push({ method: "createAct", args: [input] });
      const err = bank.failNext.createAct;
      if (err) {
        delete bank.failNext.createAct;
        throw err;
      }
      return { documentId: "act-0001" };
    },
    async sendClosingToEmail(documentId, email) {
      bank.calls.push({ method: "sendClosingToEmail", args: [documentId, email] });
      const err = bank.failNext.sendClosingToEmail;
      if (err) {
        delete bank.failNext.sendClosingToEmail;
        throw err;
      }
    },
  };
  return bank;
}

export interface TestKit {
  deps: PaymentDeps;
  store: ReturnType<typeof createMemoryStore>;
  bank: FakeBank;
  mails: Array<{ to: string; message: EmailMessage }>;
  logs: string[];
  setNow(ms: number): void;
}

export const T0 = Date.parse("2026-10-20T09:00:00Z");

export function createTestKit(options: { users?: SubscriptionUser[]; env?: Record<string, string>; bank?: FakeBank | null } = {}): TestKit {
  const store = createMemoryStore({
    users: options.users ?? [{ id: "u1", email: "client@firma.ru", paidUntil: null, trialEndsAt: null, plan: null }],
  });
  const bank = options.bank === null ? null : (options.bank ?? createFakeBank());
  const mails: TestKit["mails"] = [];
  const logs: string[] = [];
  let now = T0;
  store.setClock(() => now);
  const deps: PaymentDeps = {
    store,
    users: { findByEmail: async (email) => store.state.users.find((u) => u.email === email.toLowerCase()) ?? null },
    tochka: bank,
    sendMail: async (to, message) => {
      mails.push({ to, message });
    },
    env: { ADMIN_EMAILS: "owner@tender-fit.ru", PAYMENT_CONFIRM_SECRET: "test-secret-0123456789", APP_BASE_URL: "https://tender-fit.ru", ...options.env },
    now: () => now,
    log: (m) => {
      logs.push(m);
    },
  };
  return { deps, store, bank: bank as FakeBank, mails, logs, setNow: (ms) => (now = ms) };
}
