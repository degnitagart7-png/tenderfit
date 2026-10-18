/**
 * Кэш с временем жизни и потолком размера.
 *
 * Для ответов языковой модели: один и тот же запрос люди повторяют, и каждый
 * повтор без кэша — платный вызов за тот же ответ. Потолок обязателен:
 * процесс сервера живёт неделями, и кэш без предела — это утечка памяти.
 *
 * Время передаётся параметром, а не читается из часов: правило проверяется
 * тестом без ожидания.
 */
export interface TtlCache<T> {
  get(key: string, now?: number): T | undefined;
  set(key: string, value: T, now?: number): void;
}

export function createTtlCache<T>(options: { ttlMs: number; maxEntries: number }): TtlCache<T> {
  const entries = new Map<string, { value: T; storedAt: number }>();

  return {
    get(key, now = Date.now()) {
      const found = entries.get(key);
      if (found === undefined) return undefined;
      if (now - found.storedAt >= options.ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return found.value;
    },
    set(key, value, now = Date.now()) {
      // Перезапись переносит ключ в конец: Map помнит порядок вставки, а
      // вытесняется самый давний.
      entries.delete(key);
      entries.set(key, { value, storedAt: now });
      while (entries.size > options.maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}
