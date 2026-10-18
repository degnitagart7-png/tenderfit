/**
 * Скользящий лимит запросов на адрес.
 *
 * Ручки, которые пересылают текст языковой модели, открыты без входа. Без
 * лимита любой, кто узнает адрес, получил бы бесплатный доступ к платному
 * шлюзу — на это указано и в комментарии к `/api/estimate/bill-rows`. Лимит
 * не заменяет входа, а ограничивает ущерб: «двадцать запросов за десять
 * минут с одного адреса» — достаточно для человека и мало для скрипта.
 *
 * Состояние живёт в памяти процесса: приложение у нас одно, а потеря счёта при
 * перезапуске лишь даёт лимиту новое окно.
 */
export interface RateDecision {
  allowed: boolean;
  /** Через сколько секунд повторить; 0, когда запрос пропущен. */
  retryAfterSec: number;
}

export interface RateLimiter {
  check(key: string, now?: number): RateDecision;
}

export function createRateLimiter(options: { limit: number; windowMs: number }): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key, now = Date.now()) {
      const recent = (hits.get(key) ?? []).filter((at) => now - at < options.windowMs);

      if (recent.length >= options.limit) {
        hits.set(key, recent);
        const oldest = recent[0] ?? now;
        const retryAfterMs = options.windowMs - (now - oldest);
        // Отказанное обращение в журнал не пишется: иначе поток запросов сам
        // себя держал бы за пределом лимита навсегда.
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }

      recent.push(now);
      hits.set(key, recent);

      // Чистка: ключи, по которым давно никто не приходил, не копятся.
      if (hits.size > 5000) {
        for (const [other, list] of hits) {
          if (list.every((at) => now - at >= options.windowMs)) hits.delete(other);
        }
      }
      return { allowed: true, retryAfterSec: 0 };
    },
  };
}

/**
 * Ключ клиента для лимита.
 *
 * Приложение стоит за nginx, который кладёт адрес в `X-Real-IP`. Заголовок
 * можно подделать только если запрос идёт в обход nginx, а порт приложения
 * слушает лишь 127.0.0.1. Без заголовков ключ общий, а не «пропустить»: пустой
 * адрес не должен давать неограниченный доступ.
 */
export function clientKey(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}
