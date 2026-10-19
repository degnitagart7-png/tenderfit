import { describeError } from "@/lib/errors";
import { defaultPaymentDeps } from "@/services/payments/deps";
import { runPaymentPoll } from "@/services/payments/pollerService";

/**
 * Наблюдатель за оплатой для воркера: раз в 5 минут опрашивает банк по ждущим счетам и разбирает
 * застрявшие события вебхуков (`runPaymentPoll`).
 *
 * Не ждётся и не роняет цикл воркера; прогон не накладывается на предыдущий (медленный банк или база —
 * следующий тик пропускается). Банк не настроен (нет TOCHKA_JWT) — выполняется только отметка
 * просроченных счетов. Таймер не держит процесс. Возвращает остановку.
 */

export const PAYMENT_POLL_INTERVAL_MS = 5 * 60_000;

export function startPaymentWatch(log: (message: string) => void): () => void {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    // Зависимости собираются на каждый тик: JWT и адрес читаются из окружения процесса, а клиент банка дёшев.
    const deps = defaultPaymentDeps({ log: (message) => log(`оплата: ${message}`) });
    runPaymentPoll(deps)
      .catch((err: unknown) => log(`оплата: опрос упал: ${describeError(err)}`))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, PAYMENT_POLL_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
