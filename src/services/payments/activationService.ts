import { buildPaidAdminEmail, buildPaidUserEmail, buildPaymentProblemAdminEmail } from "@/domain/paymentEmails";
import type { PaymentInvoice } from "@/domain/payments";
import { planById } from "@/domain/plans";
import { extendPaidUntil, monthsToDays } from "@/domain/subscription";
import { describeError } from "@/lib/errors";
import { notifyAdmins, notifyUser, type PaymentDeps } from "@/services/payments/deps";

/**
 * Активация подписки по оплаченному счёту — единственный путь, которым деньги включают доступ
 * (вебхук банка, опрос воркера, подтверждение заявки владельцем — все приходят сюда).
 *
 * Идемпотентность держит база: функция `payment_apply_activation` в одной транзакции блокирует
 * счёт и пользователя, не даёт включить счёт дважды и сверяет, что срок пользователя не менялся
 * с момента расчёта. Здесь — расчёт нового срока (общее правило с grant-access: от большего из
 * «сейчас» и текущего paid_until), повтор при конфликте и всё, что идёт после включения: письма
 * клиенту и владельцу, закрывающий акт. Сбой любого из этих шагов подписку не откатывает: он
 * пишется в журнал и уходит владельцу письмом.
 */

export type ActivationOutcome =
  | { kind: "activated"; invoice: PaymentInvoice; activatedUntil: number }
  | { kind: "already" }
  | { kind: "not_payable"; status: string }
  | { kind: "no_user" }
  | { kind: "not_found" };

const MAX_CONFLICT_RETRIES = 5;

export interface ActivationOptions {
  /** Письма и акт — в фоне, не удерживая ответ (вебхук должен ответить банку быстро). */
  background?: boolean;
}

export async function activateInvoice(
  deps: PaymentDeps,
  invoiceId: string,
  ref: string,
  source: string,
  options: ActivationOptions = {},
): Promise<ActivationOutcome> {
  const invoice = await deps.store.getInvoice(invoiceId);
  if (invoice === null) return { kind: "not_found" };
  if (invoice.activatedUntil !== null) return { kind: "already" };

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
    const user = await deps.users.findByEmail(invoice.userEmail);
    if (user === null) return { kind: "no_user" };
    const nowMs = deps.now();
    const newUntilMs = extendPaidUntil(user.paidUntil, nowMs, monthsToDays(invoice.months));

    const result = await deps.store.applyActivation({
      invoiceId,
      ref,
      newUntilMs,
      expectedPrevMs: user.paidUntil,
      nowMs,
    });
    switch (result.result) {
      case "applied": {
        const paid: PaymentInvoice = {
          ...invoice,
          status: "paid",
          paidAt: nowMs,
          tochkaPaymentRef: ref,
          activatedUntil: result.activatedUntil,
        };
        const after = afterActivation(deps, paid, result.activatedUntil, source);
        if (options.background === true) {
          void after.catch((error: unknown) => deps.log(`после оплаты ${invoiceId}: ${describeError(error)}`));
        } else {
          await after;
        }
        return { kind: "activated", invoice: paid, activatedUntil: result.activatedUntil };
      }
      case "already":
        return { kind: "already" };
      case "not_payable":
        return { kind: "not_payable", status: result.status };
      case "no_user":
        return { kind: "no_user" };
      case "not_found":
        return { kind: "not_found" };
      case "conflict":
        // Срок пользователя сдвинулся (другой счёт, grant-access): читаем заново и считаем снова.
        continue;
    }
  }
  throw new Error(`Не удалось включить подписку по счёту ${invoiceId}: срок пользователя менялся ${String(MAX_CONFLICT_RETRIES)} раз подряд`);
}

/** Всё после включения: письма и акт. Ничего не бросает наружу. */
async function afterActivation(deps: PaymentDeps, invoice: PaymentInvoice, activatedUntil: number, source: string): Promise<void> {
  const userMail = buildPaidUserEmail({ invoice, activatedUntilMs: activatedUntil });
  const adminMail = buildPaidAdminEmail({ invoice, activatedUntilMs: activatedUntil, source });
  await Promise.all([notifyUser(deps, invoice.userEmail, userMail), notifyAdmins(deps, adminMail)]);
  await issueClosingDocument(deps, invoice);
}

/**
 * Закрывающий акт после оплаты: создаётся в банке по счёту и уходит на почту плательщика.
 * Только для счетов банка (у заявки по QR документа нет) и если акты не выключены
 * (TOCHKA_CLOSING_DOCS=0). Повторный вызов не создаёт второй акт: идентификатор сохраняется сразу.
 */
export async function issueClosingDocument(deps: PaymentDeps, invoice: PaymentInvoice): Promise<void> {
  const tochka = deps.tochka;
  if (tochka === null || !tochka.config.closingDocs) return;
  if (invoice.method !== "invoice" || invoice.tochkaDocumentId === null || invoice.invoiceNumber === null) return;
  if (invoice.buyerInn === null || invoice.buyerName === null || invoice.buyerEmail === null) return;

  let step = "создать акт";
  try {
    let closingId = invoice.closingDocumentId;
    if (closingId === null) {
      const plan = planById(invoice.plan);
      const created = await tochka.createAct({
        number: invoice.invoiceNumber,
        buyer: { inn: invoice.buyerInn, kpp: invoice.buyerKpp, name: invoice.buyerName, email: invoice.buyerEmail },
        planName: plan?.name ?? invoice.plan,
        months: invoice.months,
        amountRub: invoice.amountRub,
        nowMs: deps.now(),
        invoiceDocumentId: invoice.tochkaDocumentId,
      });
      closingId = created.documentId;
      await deps.store.updateInvoice(invoice.id, { closingDocumentId: closingId });
    }
    step = "отправить акт на почту";
    await tochka.sendClosingToEmail(closingId, invoice.buyerEmail);
    await deps.store.updateInvoice(invoice.id, { closingSentAt: deps.now() });
  } catch (error) {
    const text = describeError(error);
    deps.log(`акт по счёту ${invoice.invoiceNumber}: не удалось ${step}: ${text}`);
    await notifyAdmins(deps, buildPaymentProblemAdminEmail({ invoice, what: step, error: text }));
  }
}
