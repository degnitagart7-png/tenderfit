import { createHash } from "node:crypto";

import { looksLikeSubscription, matchIncoming, RECENT_PAID_MS, type IncomingKind, type IncomingPayment, type MatchBy } from "@/domain/paymentMatching";
import { buildUnmatchedAdminEmail } from "@/domain/paymentEmails";
import { INVOICE_TTL_MS, toKopecks } from "@/domain/payments";
import { describeError } from "@/lib/errors";
import type { EventOutcome, NewEvent, PaymentEvent } from "@/repositories/paymentRepository";
import { activateInvoice, type ActivationOutcome } from "@/services/payments/activationService";
import { notifyAdmins, type PaymentDeps } from "@/services/payments/deps";
import { accountNumberOf, tochkaConfigProblem } from "@/services/tochka/config";

/**
 * Разбор подтверждённого вебхука Точки: входящий платёж → событие в журнале → счёт → подписка.
 *
 * Подпись проверена выше (webhookVerify), здесь только содержание. Порядок надёжности:
 *   1. событие записывается в журнал по уникальному ключу (paymentId / operationId): повторная
 *      доставка того же платежа видит запись и ничего не включает второй раз;
 *   2. сопоставление со счётом (domain/paymentMatching);
 *   3. включение подписки — через activationService (идемпотентно в базе);
 *   4. итог записывается в событие. Сбой на шагах 2–3 событие не теряет: оно остаётся
 *      необработанным, и воркер разберёт его заново (pollerService).
 * Запись события не удалась (база недоступна) — бросаем ошибку: ручка отвечает банку не-200, и банк
 * повторит доставку сам (30 раз с интервалом 10 с).
 */

const KIND_LABEL: Record<IncomingKind, string> = {
  payment: "платёж по реквизитам",
  sbp: "СБП по QR-коду",
  sbp_b2b: "СБП по B2B QR-коду",
};

type Payload = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const obj = (value: unknown): Payload => (typeof value === "object" && value !== null ? (value as Payload) : {});

export type NormalizedWebhook =
  | { kind: "ignore"; reason: string }
  | { kind: "incoming"; event: NewEvent };

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Приводит тело вебхука к событию журнала. Чужие виды событий и платежи на другие счета — игнорируются. */
export function normalizeWebhook(payload: Payload, token: string, env: Record<string, string | undefined>): NormalizedWebhook {
  const type = text(payload["webhookType"]);
  const sanitized = (extra: Payload = {}): Payload => ({
    webhookType: type,
    customerCode: text(payload["customerCode"]),
    ...extra,
  });

  if (type === "incomingPayment") {
    const payer = obj(payload["SidePayer"]);
    const recipient = obj(payload["SideRecipient"]);
    // На счёт владельца приходят все деньги всех его счетов компании: подписку принимает один счёт.
    const config = tochkaConfigProblem(env).config;
    const ourAccount = config === null ? "" : accountNumberOf(config.accountId);
    const theirAccount = text(recipient["account"]);
    if (ourAccount !== "" && theirAccount !== "" && theirAccount !== ourAccount) {
      return { kind: "ignore", reason: "платёж на другой счёт" };
    }
    const currency = text(recipient["currency"]) || text(payer["currency"]);
    if (currency !== "" && currency !== "RUB") return { kind: "ignore", reason: "не рубли" };
    const amount = toKopecks(text(recipient["amount"]) || text(payer["amount"]) || text(payload["amount"]));
    if (!Number.isFinite(amount) || amount <= 0) return { kind: "ignore", reason: "нет суммы" };
    const paymentId = text(payload["paymentId"]);
    return {
      kind: "incoming",
      event: {
        ref: paymentId !== "" ? `payment:${paymentId}` : `payment:h:${tokenHash(token)}`,
        kind: "payment",
        amountRub: amount / 100,
        purpose: text(payload["purpose"]),
        payerInn: text(payer["inn"]) || null,
        payerName: text(payer["name"]) || null,
        raw: sanitized({ date: text(payload["date"]), documentNumber: text(payload["documentNumber"]) }),
      },
    };
  }

  if (type === "incomingSbpPayment") {
    const amount = toKopecks(text(payload["amount"]));
    if (!Number.isFinite(amount) || amount <= 0) return { kind: "ignore", reason: "нет суммы" };
    const operationId = text(payload["operationId"]);
    return {
      kind: "incoming",
      event: {
        ref: operationId !== "" ? `sbp:${operationId}` : `sbp:h:${tokenHash(token)}`,
        kind: "sbp",
        amountRub: amount / 100,
        purpose: text(payload["purpose"]),
        payerInn: null,
        // Банк присылает имя в сокращённом виде («Иван Иванович И.»); телефон не сохраняем.
        payerName: text(payload["payerName"]) || null,
        raw: sanitized({ paymentType: text(payload["paymentType"]), qrcId: text(payload["qrcId"]) }),
      },
    };
  }

  if (type === "incomingSbpB2BPayment") {
    const amount = toKopecks(text(payload["amount"]));
    if (!Number.isFinite(amount) || amount <= 0) return { kind: "ignore", reason: "нет суммы" };
    // У B2B-события нет собственного номера операции: ключом служит хэш всего токена (повторная
    // доставка того же события несёт тот же токен).
    return {
      kind: "incoming",
      event: {
        ref: `b2b:${tokenHash(token)}`,
        kind: "sbp_b2b",
        amountRub: amount / 100,
        purpose: text(payload["purpose"]),
        payerInn: null,
        payerName: null,
        raw: sanitized({ qrcId: text(payload["qrcId"]) }),
      },
    };
  }

  return { kind: "ignore", reason: `событие ${type || "без типа"} не обрабатывается` };
}

export type WebhookResult =
  | { status: "ignored"; reason: string }
  | { status: "duplicate" }
  | { status: "processed"; outcome: EventOutcome }
  /** Событие записано, но разобрать его сейчас не вышло: воркер повторит. */
  | { status: "deferred"; error: string };

export async function handleWebhookPayload(
  deps: PaymentDeps,
  payload: Payload,
  token: string,
  options: { background?: boolean } = {},
): Promise<WebhookResult> {
  const normalized = normalizeWebhook(payload, token, deps.env);
  if (normalized.kind === "ignore") return { status: "ignored", reason: normalized.reason };

  // Бросает, если база недоступна: ручка ответит не-200, и банк повторит доставку.
  const { event, created } = await deps.store.recordEvent(normalized.event);
  if (!created && event.processedAt !== null) return { status: "duplicate" };

  try {
    const outcome = await processEvent(deps, event, options);
    return { status: "processed", outcome };
  } catch (error) {
    const message = describeError(error);
    deps.log(`событие ${event.ref}: не разобрано, будет повтор: ${message}`);
    return { status: "deferred", error: message };
  }
}

function sourceLabel(kind: IncomingKind, by: MatchBy, ref: string): string {
  const how: Record<MatchBy, string> = {
    document_id: "по документу банка в назначении",
    invoice_number: "по номеру счёта в назначении",
    inn_amount: "по ИНН плательщика и сумме",
    sbp_claim: "по заявке «Я оплатил» и сумме",
  };
  return `банк: ${KIND_LABEL[kind]}, ${how[by]} (операция ${ref})`;
}

/** Сопоставить событие журнала со счётом и довести до итога. Бросает при сбое базы: событие остаётся необработанным. */
export async function processEvent(deps: PaymentDeps, event: PaymentEvent, options: { background?: boolean } = {}): Promise<EventOutcome> {
  const nowMs = deps.now();
  const payment: IncomingPayment = {
    kind: event.kind,
    ref: event.ref,
    amountKop: toKopecks(event.amountRub),
    purpose: event.purpose,
    payerInn: event.payerInn,
  };
  const pool = await deps.store.listForMatching(nowMs - INVOICE_TTL_MS, nowMs - RECENT_PAID_MS);
  const match = matchIncoming(payment, pool, nowMs);

  const finish = async (outcome: EventOutcome, invoiceId: string | null): Promise<EventOutcome> => {
    await deps.store.markEventProcessed(event.id, outcome, invoiceId, deps.now());
    return outcome;
  };
  const alert = async (reason: Parameters<typeof buildUnmatchedAdminEmail>[0]["reason"], invoices?: Parameters<typeof buildUnmatchedAdminEmail>[0]["invoices"]): Promise<void> => {
    await notifyAdmins(
      deps,
      buildUnmatchedAdminEmail({
        reason,
        amountRub: event.amountRub,
        purpose: event.purpose,
        payerInn: event.payerInn,
        payerName: event.payerName,
        kindLabel: KIND_LABEL[event.kind],
        ref: event.ref,
        ...(invoices === undefined ? {} : { invoices }),
      }),
    );
  };

  switch (match.kind) {
    case "matched": {
      const result: ActivationOutcome = await activateInvoice(deps, match.invoice.id, event.ref, sourceLabel(event.kind, match.by, event.ref), options);
      if (result.kind === "activated") return finish("activated", match.invoice.id);
      if (result.kind === "already") return finish("already_paid", match.invoice.id);
      await alert(result.kind === "no_user" ? "no_user" : "not_payable", [match.invoice]);
      return finish("error", match.invoice.id);
    }
    case "already_paid":
      return finish("already_paid", match.invoice.id);
    case "amount_mismatch":
      await alert("amount_mismatch", [match.invoice]);
      return finish("amount_mismatch", match.invoice.id);
    case "ambiguous":
      await alert("ambiguous", match.candidates);
      return finish("ambiguous", null);
    case "unmatched":
      // Чужие поступления на счёт владельца письмами не засоряем: тревога — только если платёж похож на подписку.
      if (!looksLikeSubscription(payment)) return finish("ignored", null);
      await alert("unmatched");
      // Платёж по QR остаётся «без пары»: заявка, созданная позже, подхватит его (sbpClaimService).
      return finish("unmatched", null);
  }
}
