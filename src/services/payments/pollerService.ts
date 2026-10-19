import { CLAIM_TTL_MS, INVOICE_TTL_MS } from "@/domain/payments";
import { describeError } from "@/lib/errors";
import { activateInvoice } from "@/services/payments/activationService";
import type { PaymentDeps } from "@/services/payments/deps";
import { processEvent } from "@/services/payments/webhookService";
import { TochkaApiError } from "@/services/tochka";

/**
 * Страховка вебхуков, раз в ~5 минут в воркере.
 *
 * Вебхуки быстры, но не вечны (банк повторяет доставку 30 раз, потом сдаётся; сервер мог лежать),
 * поэтому каждый ждущий счёт младше 45 дней раз в прогон спрашивается у банка («Get Invoice
 * Payment Status»): `payment_paid` включает подписку тем же путём, что и вебхук. Дальше:
 *   · счета старше 45 дней и заявки по QR старше 14 помечаются просроченными;
 *   · события журнала, которые не удалось разобрать (сбой базы посреди вебхука), разбираются заново.
 * Ошибка по одному счёту не прерывает остальные и наружу не бросается: воркер крутит это рядом
 * с очередью заданий.
 */

export interface PollResult {
  skipped: boolean;
  checked: number;
  activated: number;
  expired: number;
  cancelled: number;
  reprocessed: number;
  errors: number;
}

/** За прогон спрашиваем банк не больше стольких счетов: хватит на сотню оплат в сутки, а лимит банка цел. */
const POLL_BATCH = 100;
/** Событие, которому ещё нет минуты, обрабатывает вебхук; воркер подбирает только застрявшие. */
const PENDING_GRACE_MS = 60_000;

export async function runPaymentPoll(deps: PaymentDeps): Promise<PollResult> {
  const result: PollResult = { skipped: false, checked: 0, activated: 0, expired: 0, cancelled: 0, reprocessed: 0, errors: 0 };
  const nowMs = deps.now();

  try {
    result.expired += await deps.store.expireIssued("invoice", nowMs - INVOICE_TTL_MS);
    result.expired += await deps.store.expireIssued("sbp_claim", nowMs - CLAIM_TTL_MS);
  } catch (error) {
    result.errors += 1;
    deps.log(`просрочка счетов не отмечена: ${describeError(error)}`);
  }

  const tochka = deps.tochka;
  if (tochka === null) {
    result.skipped = true;
  } else {
    let issued: Awaited<ReturnType<typeof deps.store.listIssuedForPoll>> = [];
    try {
      issued = await deps.store.listIssuedForPoll(nowMs - INVOICE_TTL_MS, POLL_BATCH);
    } catch (error) {
      result.errors += 1;
      deps.log(`список счетов не прочитан: ${describeError(error)}`);
    }
    for (const invoice of issued) {
      const documentId = invoice.tochkaDocumentId;
      if (documentId === null) continue;
      try {
        result.checked += 1;
        const status = await tochka.getInvoicePaymentStatus(documentId);
        if (status === "payment_paid") {
          const outcome = await activateInvoice(deps, invoice.id, `status:${documentId}`, "банк: статус счёта «оплачен»");
          if (outcome.kind === "activated") result.activated += 1;
        } else if (status === "payment_expired") {
          await deps.store.updateInvoice(invoice.id, { status: "expired", rawLastStatus: { status, at: new Date(nowMs).toISOString() } });
          result.expired += 1;
        }
      } catch (error) {
        // 404 — документ удалили в банке: счёт больше не существует, ждать оплату по нему нечего.
        if (error instanceof TochkaApiError && error.status === 404) {
          await deps.store.updateInvoice(invoice.id, { status: "cancelled" }).catch(() => undefined);
          result.cancelled += 1;
          deps.log(`счёт ${invoice.invoiceNumber ?? invoice.id} удалён в банке — отменён`);
          continue;
        }
        result.errors += 1;
        deps.log(`счёт ${invoice.invoiceNumber ?? invoice.id}: опрос не удался: ${describeError(error)}`);
      }
    }
  }

  try {
    const pending = await deps.store.listPendingEvents(nowMs - PENDING_GRACE_MS, 20);
    for (const event of pending) {
      try {
        await processEvent(deps, event);
        result.reprocessed += 1;
      } catch (error) {
        result.errors += 1;
        deps.log(`событие ${event.ref}: повторный разбор не удался: ${describeError(error)}`);
      }
    }
  } catch (error) {
    result.errors += 1;
    deps.log(`необработанные события не прочитаны: ${describeError(error)}`);
  }

  if (result.activated + result.expired + result.cancelled + result.reprocessed + result.errors > 0) {
    deps.log(
      `опрос: проверено ${String(result.checked)}, включено ${String(result.activated)}, просрочено ${String(result.expired)}, ` +
        `отменено ${String(result.cancelled)}, событий разобрано ${String(result.reprocessed)}, сбоев ${String(result.errors)}`,
    );
  }
  return result;
}
