import { describeError } from "@/lib/errors";
import {
  defaultNotificationDeps,
  runDigests,
  runFailureAlerts,
  runReadyNotifications,
  type NotificationDeps,
} from "@/services/notificationService";

/**
 * Наблюдатель за письмами для воркера: «готов анализ или смета» — каждую минуту, утренние сводки —
 * раз в десять минут.
 *
 * Не ждётся и не роняет цикл воркера: `runReadyNotifications` и `runDigests` сами не бросают, а
 * `.catch` — на случай, если это изменится. Прогон не накладывается на предыдущий: пока тот идёт
 * (медленная база или почта), следующий тик пропускается — иначе одно письмо могло бы уйти дважды.
 * Таймеры не держат процесс (`unref`). Возвращает остановку обоих.
 */

export const READY_CHECK_INTERVAL_MS = 60_000;
export const DIGEST_CHECK_INTERVAL_MS = 10 * 60_000;

export function startNotificationWatch(
  log: (message: string) => void,
  deps: NotificationDeps = { ...defaultNotificationDeps(), log: (message: string) => log(`уведомления: ${message}`) },
): () => void {
  const guarded = (name: string, run: (d: NotificationDeps) => Promise<unknown>): (() => void) => {
    let running = false;
    return () => {
      if (running) return;
      running = true;
      run(deps)
        .catch((err: unknown) => {
          log(`уведомления: ${name} — проверка упала: ${describeError(err)}`);
        })
        .finally(() => {
          running = false;
        });
    };
  };

  const checkReady = guarded("готовность", runReadyNotifications);
  // Сбои — тем же шагом, что готовность: письмо администратору в течение минуты после сбоя.
  const checkFailures = guarded("сбои", runFailureAlerts);
  const checkDigests = guarded("сводки", runDigests);
  checkReady();
  checkFailures();
  checkDigests();
  const readyTimer = setInterval(() => {
    checkReady();
    checkFailures();
  }, READY_CHECK_INTERVAL_MS);
  const digestTimer = setInterval(checkDigests, DIGEST_CHECK_INTERVAL_MS);
  readyTimer.unref();
  digestTimer.unref();
  return () => {
    clearInterval(readyTimer);
    clearInterval(digestTimer);
  };
}
