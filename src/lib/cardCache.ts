import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CARD_CACHE_SCHEMA,
  type CachedCard,
  type ProcedureCardCache,
} from "@/domain/cardReuse";

/**
 * Дисковый кэш прочитанных карточек процедур (Росэлторг, Фабрикант).
 *
 * Зачем на диске, а не в базе: см. `src/domain/cardReuse.ts` — строки `tenders`
 * не хранят момент настоящего запроса карточки и не хранят отброшенные профилем
 * процедуры, а их большинство. Файл лежит в `data/` (воркеру разрешена запись —
 * `ReadWritePaths` в `deploy/tenderfit-worker.service`), путь переопределяет
 * `SYNC_CARD_CACHE_DIR`. Кэш — оптимизация, а не источник истины: файла нет, он
 * битый, другой версии или не пишется — карточки просто читаются заново.
 *
 * Запись атомарная (временный файл и rename), а перед записью файл читается ещё раз
 * и сливается с памятью: плановый прогон и живой поиск могут работать одновременно,
 * и позднее чтение карточки не должно затирать чужие записи. Из двух записей одной
 * процедуры побеждает свежее чтение.
 */

/** Сколько хранить запись в файле. Больше окна свежести: файл не должен пухнуть, а не решать, что свежо. */
export const CARD_CACHE_RETAIN_MS = 48 * 60 * 60 * 1000;
/** Потолок записей в файле: у процедуры со сто лотами запись — десятки килобайт. */
export const CARD_CACHE_MAX_ENTRIES = 4000;

interface CacheFile {
  schema: number;
  entries: Record<string, CachedCard>;
}

export interface DiskCardCacheOptions {
  /** Файл кэша. */
  file: string;
  retainMs?: number;
  maxEntries?: number;
  /** Часы; для тестов. */
  now?: () => number;
}

export interface DiskCardCache extends ProcedureCardCache {
  /** Записать накопленное на диск. true — записано или записывать было нечего. */
  flush(): boolean;
  /** Сколько записей сейчас в памяти. */
  readonly size: number;
}

/** Каталог кэша карточек: `SYNC_CARD_CACHE_DIR` или `data/` проекта. */
export function cardCacheDir(): string {
  const fromEnv = process.env["SYNC_CARD_CACHE_DIR"]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(process.cwd(), "data");
}

/** Файл кэша карточек одной площадки. */
export function cardCacheFile(source: string, dir: string = cardCacheDir()): string {
  return join(dir, `card-cache-${source.toLowerCase()}.json`);
}

function isCachedCard(value: unknown): value is CachedCard {
  if (typeof value !== "object" || value === null) return false;
  const card = value as Partial<CachedCard>;
  return (
    typeof card.fetchedAt === "number" &&
    Number.isFinite(card.fetchedAt) &&
    typeof card.complete === "boolean" &&
    (card.lastLotEndMs === null || typeof card.lastLotEndMs === "number") &&
    typeof card.tender === "object" &&
    card.tender !== null &&
    typeof card.tender.regNumber === "string"
  );
}

function readEntries(file: string): Map<string, CachedCard> {
  const entries = new Map<string, CachedCard>();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<CacheFile> | null;
    if (typeof parsed !== "object" || parsed === null) return entries;
    if (parsed.schema !== CARD_CACHE_SCHEMA) return entries;
    for (const [key, value] of Object.entries(parsed.entries ?? {})) {
      if (isCachedCard(value)) entries.set(key, value);
    }
  } catch {
    // Файла нет или он не читается — кэша нет.
  }
  return entries;
}

export function createDiskCardCache(options: DiskCardCacheOptions): DiskCardCache {
  const now = options.now ?? Date.now;
  const retainMs = options.retainMs ?? CARD_CACHE_RETAIN_MS;
  const maxEntries = options.maxEntries ?? CARD_CACHE_MAX_ENTRIES;
  let entries: Map<string, CachedCard> | null = null;
  let dirty = false;

  const load = (): Map<string, CachedCard> => {
    if (entries === null) entries = readEntries(options.file);
    return entries;
  };

  return {
    get size() {
      return load().size;
    },
    get: (number) => load().get(number),
    set: (number, card) => {
      load().set(number, card);
      dirty = true;
    },
    flush: () => {
      if (!dirty) return true;
      // Чужие записи, появившиеся с момента чтения, не затираем: побеждает более
      // свежее чтение карточки.
      const merged = readEntries(options.file);
      for (const [key, card] of load()) {
        const other = merged.get(key);
        if (other === undefined || other.fetchedAt <= card.fetchedAt) merged.set(key, card);
      }
      const cutoff = now() - retainMs;
      const kept = [...merged]
        .filter(([, card]) => card.fetchedAt >= cutoff)
        .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
        .slice(0, maxEntries);
      const body: CacheFile = { schema: CARD_CACHE_SCHEMA, entries: Object.fromEntries(kept) };
      const tmp = `${options.file}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      try {
        mkdirSync(dirname(options.file), { recursive: true });
        writeFileSync(tmp, JSON.stringify(body), "utf-8");
        renameSync(tmp, options.file);
        entries = new Map(kept);
        dirty = false;
        return true;
      } catch {
        // Писать некуда — кэш остаётся в памяти этого прогона.
        try {
          unlinkSync(tmp);
        } catch {
          // временного файла могло не быть
        }
        return false;
      }
    },
  };
}
