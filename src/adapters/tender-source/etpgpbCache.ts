/**
 * Дисковые кэши адаптера ЭТП ГПБ: куски карты сайта и прочитанные карточки.
 *
 * Зачем два файла. Источник устроен так, что каждый запуск без кэша повторил бы тяжёлую
 * работу: кусок карты процедур весит ~4,7 МБ (по дате изменения в окно просмотра попадает до
 * двух-трёх десятков кусков), а каждая
 * карточка — отдельный запрос раз в секунду. Между плановыми прогонами почти ничего не
 * меняется, поэтому:
 *   - `etpgpb-sitemap-cache.json` — записи кусков карты, УЖЕ отобранные по окну
 *     просмотра и виду. Ключ — адрес куска; запись годится, пока `<lastmod>` куска у
 *     площадки тот же (площадка меняет его при любой правке куска) и пока граница
 *     окна, по которой запись отобрана, не новее нужной (иначе в кэше могло не
 *     оказаться записей, которые окно теперь требует);
 *   - `etpgpb-card-cache.json` — очищенная и отображённая карточка (`Tender`), метка «идёт ли
 *     приём заявок» и `<lastmod>` процедуры, при котором карточка прочитана. Ключ —
 *     адрес карточки; запись годится, пока `<lastmod>` из карты тот же и срок жизни
 *     (по умолчанию трое суток) не вышел. Закрытые и отброшенные профилем процедуры
 *     кэшируются тоже: их большинство, и без этого каждый прогон платил бы за них
 *     запросом заново.
 *
 * Каталог — `data/` проекта или `SYNC_CARD_CACHE_DIR` (см. `cardCacheDir`): воркеру там
 * разрешена запись (`ReadWritePaths`). Кэш — оптимизация, а не источник истины: файла нет,
 * он битый, чужой версии или не пишется — адаптер читает всё заново. Запись атомарная
 * (временный файл и rename), перед записью файл читается ещё раз и сливается с памятью:
 * плановый прогон и живой поиск могут идти одновременно, и позднее чтение не должно
 * затирать чужие записи. В файле лежат только очищенные данные: контактов, ссылок на
 * документы и сырой карточки в нём нет.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tender } from "@/domain/entities";
import type { EtpgpbSitemapEntry } from "@/adapters/tender-source/etpgpbSitemap";
import { etpgpbCardUrl } from "@/adapters/tender-source/etpgpbUrl";

/** Версия формата файлов: правка отбора или маппера, меняющая форму записи, поднимает её. */
export const ETPGPB_CACHE_SCHEMA = 1;

/**
 * Версия кэша карточек отдельно от кэша карты сайта: в нём лежат уже разобранные
 * `Tender`, и правка разбора (etpgpbMapper.ts) без смены версии оставила бы старый
 * результат на весь срок жизни записи — до 72 часов. Поднимать при каждой правке
 * разбора; кэш карты сайта (115 МБ при холодном старте) от этого не сбрасывается.
 * 2 — регион: голый город организатора в месте поставки уступает названию (19.10.2026).
 * 3 — регион: lot_regions, повторяющий офис заказчика, уступает прямо названному субъекту.
 */
export const ETPGPB_CARD_CACHE_SCHEMA = 3;

export const ETPGPB_SITEMAP_CACHE_FILE = "etpgpb-sitemap-cache.json";
export const ETPGPB_CARD_CACHE_FILE = "etpgpb-card-cache.json";

/** Сколько хранить запись карточки в файле, если срок не задан: больше срока жизни, чтобы файл не пух. */
const DEFAULT_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
/** Потолок записей карточек в файле: запись — несколько килобайт. */
const DEFAULT_MAX_CARDS = 3000;
/** Сколько хранить кусок карты: старше месяца он выходит за любое окно просмотра. */
const SITEMAP_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CHUNKS = 40;

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // Файла нет или он не читается — кэша нет.
    return null;
  }
}

/** Атомарная запись; false — писать некуда (кэш остаётся в памяти этого прогона). */
function writeJsonFile(file: string, body: unknown): boolean {
  const tmp = `${file}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(body), "utf-8");
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // временного файла могло не быть
    }
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ============================== куски карты сайта ============================== */

/** Отобранные записи одного куска карты. */
export interface SitemapChunkRecord {
  /** `<lastmod>` куска в том виде, как его напечатала площадка. */
  readonly lastmod: string | null;
  /** Граница окна, по которой записи отобраны, мс: записей старше неё в кэше нет. */
  readonly cutoffMs: number;
  readonly savedAt: number;
  readonly entries: readonly EtpgpbSitemapEntry[];
}

type PackedEntry = [kind: string, id: string, slug: string, lastmodMs: number];
interface PackedChunk {
  lastmod: string | null;
  cutoffMs: number;
  savedAt: number;
  entries: PackedEntry[];
}

function packEntries(entries: readonly EtpgpbSitemapEntry[]): PackedEntry[] {
  return entries.map((entry) => [entry.kind, entry.id, entry.slug, entry.lastmodMs]);
}

function unpackChunk(value: unknown): SitemapChunkRecord | null {
  if (!isObject(value)) return null;
  const { lastmod, cutoffMs, savedAt, entries } = value;
  if (typeof cutoffMs !== "number" || typeof savedAt !== "number" || !Array.isArray(entries)) return null;
  if (lastmod !== null && typeof lastmod !== "string") return null;
  const out: EtpgpbSitemapEntry[] = [];
  for (const raw of entries as unknown[]) {
    if (!Array.isArray(raw)) return null;
    const [kind, id, slug, lastmodMs] = raw as unknown[];
    if (typeof kind !== "string" || typeof id !== "string" || typeof slug !== "string") return null;
    if (typeof lastmodMs !== "number") return null;
    out.push({ url: etpgpbCardUrl(kind, id, slug), kind, id, slug, lastmodMs });
  }
  return { lastmod: lastmod ?? null, cutoffMs, savedAt, entries: out };
}

export interface EtpgpbSitemapCache {
  get(chunkUrl: string): SitemapChunkRecord | undefined;
  set(chunkUrl: string, record: SitemapChunkRecord): void;
  /** Записать накопленное. false — писать некуда. */
  flush(nowMs: number): boolean;
}

/** Кэш кусков карты. `dir` null — только память (кэш выключен). */
export function createEtpgpbSitemapCache(dir: string | null): EtpgpbSitemapCache {
  const file = dir === null ? null : join(dir, ETPGPB_SITEMAP_CACHE_FILE);
  let loaded: Map<string, SitemapChunkRecord> | null = null;
  const touched = new Set<string>();

  const readDisk = (): Map<string, SitemapChunkRecord> => {
    const out = new Map<string, SitemapChunkRecord>();
    if (file === null) return out;
    const parsed = readJsonFile(file);
    if (!isObject(parsed) || parsed["schema"] !== ETPGPB_CACHE_SCHEMA || !isObject(parsed["chunks"])) return out;
    for (const [url, value] of Object.entries(parsed["chunks"])) {
      const record = unpackChunk(value);
      if (record !== null) out.set(url, record);
    }
    return out;
  };
  const load = (): Map<string, SitemapChunkRecord> => {
    loaded ??= readDisk();
    return loaded;
  };

  return {
    get: (chunkUrl) => load().get(chunkUrl),
    set: (chunkUrl, record) => {
      load().set(chunkUrl, record);
      touched.add(chunkUrl);
    },
    flush: (nowMs) => {
      if (file === null || touched.size === 0) return true;
      const merged = readDisk();
      for (const [url, record] of load()) {
        const other = merged.get(url);
        if (other === undefined || other.savedAt <= record.savedAt) merged.set(url, record);
      }
      const kept = [...merged]
        .filter(([, record]) => nowMs - record.savedAt < SITEMAP_RETAIN_MS)
        .sort((a, b) => b[1].savedAt - a[1].savedAt)
        .slice(0, MAX_CHUNKS);
      const chunks: Record<string, PackedChunk> = {};
      for (const [url, record] of kept) {
        chunks[url] = {
          lastmod: record.lastmod,
          cutoffMs: record.cutoffMs,
          savedAt: record.savedAt,
          entries: packEntries(record.entries),
        };
      }
      const ok = writeJsonFile(file, { schema: ETPGPB_CACHE_SCHEMA, chunks });
      if (ok) touched.clear();
      return ok;
    },
  };
}

/* ============================== карточки ============================== */

/** Прочитанная карточка. `tender` null — отрицательный результат (не закупка поставщика). */
export interface CardRecord {
  /** `<lastmod>` процедуры в карте сайта, при котором карточка прочитана, мс. */
  readonly lastmodMs: number;
  /** Момент настоящего запроса карточки, мс. При повторном использовании не меняется. */
  readonly fetchedAt: number;
  /** Идёт ли приём заявок по мнению площадки (`stage === "accepting"`). */
  readonly accepting: boolean;
  readonly tender: Tender | null;
  /** `tender` пуст не потому, что процедура не нужна, а потому, что карточку не удалось разобрать. */
  readonly unparsed?: boolean;
}

function isCardRecord(value: unknown): value is CardRecord {
  if (!isObject(value)) return false;
  if (typeof value["lastmodMs"] !== "number" || typeof value["fetchedAt"] !== "number") return false;
  if (typeof value["accepting"] !== "boolean") return false;
  if (value["unparsed"] !== undefined && typeof value["unparsed"] !== "boolean") return false;
  const tender = value["tender"];
  if (tender === null) return true;
  return isObject(tender) && typeof tender["regNumber"] === "string" && typeof tender["subject"] === "string";
}

export interface EtpgpbCardCache {
  get(url: string): CardRecord | undefined;
  set(url: string, record: CardRecord): void;
  /** Все записи в памяти: для поиска закупки по номеру. */
  values(): IterableIterator<[string, CardRecord]>;
  flush(nowMs: number): boolean;
}

export interface CardCacheOptions {
  /** Каталог файла; null — только память. */
  readonly dir: string | null;
  /** Сколько хранить запись в файле, мс. */
  readonly retainMs?: number;
  readonly maxEntries?: number;
}

export function createEtpgpbCardCache(options: CardCacheOptions): EtpgpbCardCache {
  const file = options.dir === null ? null : join(options.dir, ETPGPB_CARD_CACHE_FILE);
  const retainMs = options.retainMs ?? DEFAULT_RETAIN_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CARDS;
  let loaded: Map<string, CardRecord> | null = null;
  let dirty = false;

  const readDisk = (): Map<string, CardRecord> => {
    const out = new Map<string, CardRecord>();
    if (file === null) return out;
    const parsed = readJsonFile(file);
    if (!isObject(parsed) || parsed["schema"] !== ETPGPB_CARD_CACHE_SCHEMA || !isObject(parsed["cards"])) return out;
    for (const [url, value] of Object.entries(parsed["cards"])) {
      if (isCardRecord(value)) out.set(url, value);
    }
    return out;
  };
  const load = (): Map<string, CardRecord> => {
    loaded ??= readDisk();
    return loaded;
  };

  return {
    get: (url) => load().get(url),
    set: (url, record) => {
      load().set(url, record);
      dirty = true;
    },
    values: () => load().entries(),
    flush: (nowMs) => {
      if (file === null || !dirty) return true;
      const merged = readDisk();
      for (const [url, record] of load()) {
        const other = merged.get(url);
        if (other === undefined || other.fetchedAt <= record.fetchedAt) merged.set(url, record);
      }
      const kept = [...merged]
        .filter(([, record]) => nowMs - record.fetchedAt < retainMs)
        .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
        .slice(0, maxEntries);
      const ok = writeJsonFile(file, { schema: ETPGPB_CARD_CACHE_SCHEMA, cards: Object.fromEntries(kept) });
      if (ok) {
        loaded = new Map(kept);
        dirty = false;
      }
      return ok;
    },
  };
}
