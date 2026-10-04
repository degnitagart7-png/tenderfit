/**
 * Кэш сырых ответов Контур.Закупок и учёт расхода API.
 *
 * Trial ограничен (3 дня, затем 43 000 ₽/мес за поиск и 26 000 ₽/мес за
 * карточки), поэтому правило жёсткое: ответ сохраняется целиком и повторно
 * используется без обращения к API. Порты объявлены в src/adapters/types.ts,
 * постоянный уровень (Supabase) — в repositories/konturCacheRepository.ts.
 */
import type {
  KonturCacheEntry,
  KonturRawResponseInput,
  KonturRawResponseStore,
  KonturRequestKind,
  KonturUsageEntry,
  KonturUsageSink,
} from "@/adapters/types";

export type {
  KonturCacheEntry,
  KonturRawResponseInput,
  KonturRawResponseStore,
  KonturRequestKind,
  KonturUsageEntry,
  KonturUsageSink,
};

/** Хранилище, которое ничего не делает: разработка и тесты без БД. */
export const nullKonturStore: KonturRawResponseStore = {
  async read() {
    return null;
  },
  async write() {
    /* сырой ответ не сохраняется */
  },
};

export const nullKonturUsageSink: KonturUsageSink = {
  async record() {
    /* расход не учитывается */
  },
};

/** Кэш в памяти процесса + журнал расхода. Уровень перед постоянным хранилищем. */
export interface MemoryKonturStore extends KonturRawResponseStore, KonturUsageSink {
  /** Записи журнала расхода за всё время жизни объекта. */
  usage(): KonturUsageEntry[];
  /** Сколько записей лежит в кэше. */
  size(): number;
}

export function createMemoryKonturStore(nowProvider?: () => string): MemoryKonturStore {
  const cache = new Map<string, KonturCacheEntry>();
  const log: KonturUsageEntry[] = [];
  const now = nowProvider ?? (() => new Date().toISOString());
  return {
    async read(cacheKey) {
      return cache.get(cacheKey) ?? null;
    },
    async write(input: KonturRawResponseInput) {
      cache.set(input.cacheKey, {
        cacheKey: input.cacheKey,
        payload: input.payload,
        fetchedAt: now(),
      });
    },
    async record(entry) {
      log.push(entry);
    },
    usage() {
      return [...log];
    },
    size() {
      return cache.size;
    },
  };
}

/**
 * Двухуровневый кэш: память процесса → постоянное хранилище.
 * В serverless-функции память живёт один вызов, поэтому основной уровень —
 * persistent; память лишь убирает повторные чтения внутри одного запуска.
 */
export function createLayeredKonturStore(
  persistent: KonturRawResponseStore,
  nowProvider: () => string = () => new Date().toISOString(),
): KonturRawResponseStore {
  const memory = new Map<string, KonturCacheEntry>();
  return {
    async read(cacheKey) {
      const hit = memory.get(cacheKey);
      if (hit) return hit;
      const stored = await persistent.read(cacheKey);
      if (stored) memory.set(cacheKey, stored);
      return stored;
    },
    async write(input) {
      memory.set(input.cacheKey, {
        cacheKey: input.cacheKey,
        payload: input.payload,
        fetchedAt: nowProvider(),
      });
      await persistent.write(input);
    },
  };
}

/** Свежа ли запись кэша при заданном TTL. */
export function isEntryFresh(entry: KonturCacheEntry, ttlSec: number, now: string): boolean {
  const fetched = new Date(entry.fetchedAt).getTime();
  if (Number.isNaN(fetched)) return false;
  const current = new Date(now).getTime();
  if (Number.isNaN(current)) return false;
  return current - fetched < ttlSec * 1000;
}
