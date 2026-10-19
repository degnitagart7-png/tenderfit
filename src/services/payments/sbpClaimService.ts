import { buildClaimAdminEmail } from "@/domain/paymentEmails";
import {
  CLAIM_TTL_MS,
  EARLY_SBP_WINDOW_MS,
  payablePlan,
  toKopecks,
  type PaymentInvoice,
} from "@/domain/payments";
import { appBaseUrl } from "@/domain/digest";
import { describeError } from "@/lib/errors";
import { activateInvoice, type ActivationOutcome } from "@/services/payments/activationService";
import { confirmSecret, signConfirmToken, verifyConfirmToken } from "@/services/payments/confirmToken";
import { notifyAdmins, type PaymentDeps } from "@/services/payments/deps";

/**
 * Оплата по статическому СБП-QR владельца.
 *
 * Плательщик сам вводит сумму, поэтому банк не знает, чей это платёж: человек нажимает «Я оплатил»,
 * и заявка (`sbp_claim`) ждёт подтверждения. Подтверждается двумя способами, без временного доступа:
 *   1. вебхук банка `incomingSbpPayment` с точно такой суммой — автоматически (см. webhookService);
 *      если платёж пришёл РАНЬШЕ заявки (обычно так и бывает), он лежит в журнале событий без пары
 *      и подхватывается при создании заявки — здесь, `matchEarlyPayment`;
 *   2. владелец нажимает подписанную ссылку из письма (`confirmClaimByToken`).
 * Если под сумму подходят две заявки или два платежа — автоматически не выбираем, решает владелец.
 */

export type CreateClaimResult =
  | { ok: true; claim: PaymentInvoice; confirmed: boolean }
  | { ok: false; code: "invalid_plan" | "not_configured"; message: string };

export async function createSbpClaim(
  deps: PaymentDeps,
  input: { email: string; planId: string },
): Promise<CreateClaimResult> {
  const plan = payablePlan(input.planId);
  if (plan === null) return { ok: false, code: "invalid_plan", message: "Для этого тарифа оплата по QR недоступна." };
  const secret = confirmSecret(deps.env);
  if (secret === null) {
    return { ok: false, code: "not_configured", message: "Оплата по QR временно недоступна. Оплатите по счёту или напишите нам." };
  }

  const nowMs = deps.now();
  // Двойной клик и повторная заявка на тот же тариф не плодят строки: возвращаем открытую.
  const open = await deps.store.findOpenClaim(input.email, plan.id, nowMs - CLAIM_TTL_MS);
  if (open !== null) return { ok: true, claim: open, confirmed: false };

  const claim = await deps.store.insertInvoice({
    userEmail: input.email,
    plan: plan.id,
    amountRub: plan.priceRub,
    months: 1,
    method: "sbp_claim",
    invoiceNumber: null,
    buyerInn: null,
    buyerKpp: null,
    buyerName: null,
    buyerEmail: input.email,
  });

  // Платёж по QR мог прийти раньше нажатия кнопки.
  const early = await matchEarlyPayment(deps, claim);
  if (early !== null) return { ok: true, claim: { ...claim, status: "paid" }, confirmed: true };

  const { token, expiresAtMs } = signConfirmToken(claim.id, nowMs, secret);
  const confirmUrl = `${appBaseUrl(deps.env)}/api/payments/confirm?token=${encodeURIComponent(token)}`;
  await notifyAdmins(deps, buildClaimAdminEmail({ claim, confirmUrl, expiresAtMs }));
  return { ok: true, claim, confirmed: false };
}

/**
 * Платёж по QR на ту же сумму, пришедший за последние сутки и ещё без пары. Ровно один кандидат —
 * подтверждаем; два и больше — это может быть чужой платёж на такую же сумму, оставляем владельцу.
 */
async function matchEarlyPayment(deps: PaymentDeps, claim: PaymentInvoice): Promise<ActivationOutcome | null> {
  try {
    const events = await deps.store.listUnmatchedSbpEvents(deps.now() - EARLY_SBP_WINDOW_MS, claim.amountRub);
    const exact = events.filter((event) => toKopecks(event.amountRub) === toKopecks(claim.amountRub));
    if (exact.length !== 1) return null;
    const event = exact[0];
    if (event === undefined) return null;
    const outcome = await activateInvoice(deps, claim.id, event.ref, "платёж по СБП (пришёл до заявки)");
    if (outcome.kind === "activated") {
      await deps.store.markEventProcessed(event.id, "activated", claim.id, deps.now());
      return outcome;
    }
    return null;
  } catch (error) {
    deps.log(`заявка ${claim.id}: ранний платёж не сопоставлен: ${describeError(error)}`);
    return null;
  }
}

export type ConfirmClaimResult =
  | { kind: "confirmed"; claim: PaymentInvoice; activatedUntil: number }
  | { kind: "already" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "unavailable" }
  | { kind: "not_found" }
  | { kind: "not_payable"; status: string }
  | { kind: "no_user" };

/** Подтверждение по ссылке из письма. Вызывающий уже проверил, что открыл администратор. */
export async function confirmClaimByToken(deps: PaymentDeps, token: string, adminEmail: string): Promise<ConfirmClaimResult> {
  const secret = confirmSecret(deps.env);
  if (secret === null) return { kind: "unavailable" };
  const verified = verifyConfirmToken(token, deps.now(), secret);
  if (!verified.ok) return { kind: verified.reason };

  const claim = await deps.store.getInvoice(verified.claimId);
  if (claim === null || claim.method !== "sbp_claim") return { kind: "not_found" };
  if (claim.status === "paid") return { kind: "already" };

  const outcome = await activateInvoice(deps, claim.id, `manual:${claim.id}`, `подтверждено владельцем (${adminEmail})`);
  switch (outcome.kind) {
    case "activated":
      return { kind: "confirmed", claim: outcome.invoice, activatedUntil: outcome.activatedUntil };
    case "already":
      return { kind: "already" };
    case "not_payable":
      return { kind: "not_payable", status: outcome.status };
    case "no_user":
      return { kind: "no_user" };
    case "not_found":
      return { kind: "not_found" };
  }
}
