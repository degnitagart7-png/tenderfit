import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tender } from "@/domain/entities";

/**
 * Дисковый кэш окна публикации ТЭК-Торга с коротким сроком жизни.
 *
 * Зачем. Экспорт процедур ключевых слов не принимает, поэтому каждый прогон скачивает
 * окно целиком: за 30 дней это около 1700 процедур, четыре страницы по 430 КБ и 45
 * секунд (прогон 11.10.2026). Адаптер уже держит окно в памяти на время прогона, но
 * ручной запуск кнопкой сразу после планового, а также повторный запуск после сбоя
 * скачивали то же самое заново. Окно, снятое пятнадцать минут назад, для сбора
 * закупок не отличается от нового: новые процедуры придут со следующим прогоном, а
 * отбор по словам, региону, цене и сроку идёт по кэшу заново.
 *
 * Что кэшируется. Окно как есть, до отбора профиля: карта «номер процедуры → закупка».
 * Ключ — секция, ИНН и длина окна: окно живого поиска (7 дней) и планового (30) —
 * разные файлы. Срок жизни считается от времени записи и по умолчанию 15 минут
 * (`SYNC_TEKTORG_WINDOW_CACHE_SEC`, 0 — выключить).
 *
 * Кэш — оптимизация, а не источник истины: файла нет, он битый, чужой версии или
 * не пишется — окно скачивается как раньше. Запись атомарная (временный файл и
 * rename), потому что плановый прогон и живой поиск могут идти одновременно.
 */

/** Версия формата файла: правка маппинга процедуры в закупку меняет форму записи. */
export const TEKTORG_WINDOW_CACHE_SCHEMA = 1;
/** Срок жизни окна по умолчанию. */
export const TEKTORG_WINDOW_CACHE_TTL_MS = 15 * 60_000;

export interface TektorgWindowCacheOptions {
  /** Каталог файлов кэша (`data/` проекта). */
  dir: string;
  /** Срок жизни окна, мс; 0 и меньше — кэш выключен. */
  ttlMs: number;
}

interface WindowFile {
  schema: number;
  key: string;
  savedAt: number;
  entries: [string, Tender][];
}

/** Срок жизни из `SYNC_TEKTORG_WINDOW_CACHE_SEC`: не задан или не число — 15 минут; 0 — выключен. */
export function tektorgWindowCacheTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return TEKTORG_WINDOW_CACHE_TTL_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return TEKTORG_WINDOW_CACHE_TTL_MS;
  return Math.round(seconds * 1000);
}

function windowFile(options: TektorgWindowCacheOptions, key: string): string {
  return join(options.dir, `tektorg-window-${key.replace(/[^a-zA-Z0-9]+/g, "_")}.json`);
}

/** Окно из кэша, если оно записано не раньше `ttlMs` назад; иначе null. */
export function readTektorgWindowCache(
  options: TektorgWindowCacheOptions,
  key: string,
  nowMs: number,
): Map<string, Tender> | null {
  if (options.ttlMs <= 0) return null;
  try {
    const parsed = JSON.parse(readFileSync(windowFile(options, key), "utf-8")) as Partial<WindowFile> | null;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.schema !== TEKTORG_WINDOW_CACHE_SCHEMA || parsed.key !== key) return null;
    if (typeof parsed.savedAt !== "number") return null;
    const age = nowMs - parsed.savedAt;
    if (age < 0 || age >= options.ttlMs) return null;
    if (!Array.isArray(parsed.entries)) return null;
    const window = new Map<string, Tender>();
    for (const entry of parsed.entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") return null;
      const tender = entry[1];
      if (typeof tender !== "object" || tender === null || typeof tender.regNumber !== "string") return null;
      window.set(entry[0], tender);
    }
    return window;
  } catch {
    return null;
  }
}

/** Записывает окно. Сбой записи молчалив: кэш не имеет права ломать прогон. */
export function writeTektorgWindowCache(
  options: TektorgWindowCacheOptions,
  key: string,
  window: ReadonlyMap<string, Tender>,
  nowMs: number,
): void {
  if (options.ttlMs <= 0) return;
  const file = windowFile(options, key);
  const tmp = `${file}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const body: WindowFile = {
    schema: TEKTORG_WINDOW_CACHE_SCHEMA,
    key,
    savedAt: nowMs,
    entries: [...window],
  };
  try {
    mkdirSync(options.dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(body), "utf-8");
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // временного файла могло не быть
    }
  }
}
