/**
 * Общий запрос с короткой памятью: одновременные вызовы делят один обмен с
 * сервером, а свежий ответ какое-то время отдаётся без обмена вовсе.
 *
 * Зачем. Страница ленты собирается из нескольких независимых компонентов и
 * хуков, и каждому нужны одни и те же данные: список закупок читали два раза,
 * `/api/auth/me` — от двух до четырёх, журнал очереди — дважды. Договариваться
 * между компонентами о том, кто спросит, значит связать их друг с другом;
 * проще, чтобы спрашивали все, а сервис склеивал одинаковые вопросы.
 *
 * Правила:
 *  - вызов, пришедший пока идёт такой же запрос, получает тот же `Promise`;
 *  - удачный ответ живёт `ttlMs` (считая от момента получения), потом следующий
 *    вызов спрашивает заново;
 *  - ошибка не запоминается: следующий вызов пробует снова, иначе короткий
 *    сбой сети держался бы ещё `ttlMs`;
 *  - `invalidate` забывает и готовый ответ, и идущий запрос: после изменения
 *    данных (вход, выход, поиск закончился, задание поставлено) вызов обязан
 *    увидеть новое, а не ответ, начатый до изменения. Те, кто уже ждёт старый
 *    запрос, получат его результат — отменять им нечего.
 *
 * Тайм-аут короткий намеренно (секунды): это защита от дубликатов в один момент
 * времени, а не кэш данных. Всё, что должно быть видно сразу после действия
 * человека, сбрасывается через `invalidate`.
 */

export interface SharedRequestCache<T> {
  /** Ответ на `key`: общий идущий запрос, свежий результат или новый вызов `load`. */
  get(key: string, load: () => Promise<T>): Promise<T>;
  /** Забыть ответ по ключу или, без ключа, все ответы. */
  invalidate(key?: string): void;
}

interface Entry<T> {
  promise: Promise<T>;
  /** Момент получения ответа; null — запрос ещё идёт. */
  settledAt: number | null;
}

/** Все созданные кэши: тесты сбрасывают их разом (`clearAllSharedRequests`). */
const registry = new Set<SharedRequestCache<never>>();

export function createSharedRequestCache<T>(
  ttlMs: number,
  now: () => number = Date.now,
): SharedRequestCache<T> {
  const entries = new Map<string, Entry<T>>();

  const cache: SharedRequestCache<T> = {
    get(key, load) {
      const existing = entries.get(key);
      if (existing !== undefined && (existing.settledAt === null || now() - existing.settledAt < ttlMs)) {
        return existing.promise;
      }

      const entry: Entry<T> = { promise: undefined as unknown as Promise<T>, settledAt: null };
      entry.promise = (async () => load())().then(
        (value) => {
          // Запись могли сбросить, пока запрос шёл, — тогда ответ устарел и
          // «свежим» не становится.
          if (entries.get(key) === entry) entry.settledAt = now();
          return value;
        },
        (error: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
      entries.set(key, entry);
      return entry.promise;
    },

    invalidate(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };

  registry.add(cache as SharedRequestCache<never>);
  return cache;
}

/** Забыть всё во всех кэшах — для тестов, которые подставляют разные ответы сервера. */
export function clearAllSharedRequests(): void {
  for (const cache of registry) cache.invalidate();
}
