import type { TenderRow } from "@/domain/filtering";

/**
 * Отметка «последний поиск»: что человек только что искал и что из ленты
 * этот поиск принёс.
 *
 * Зачем. После поиска на площадках (живого, первого по профилю или «Найти новые
 * закупки») лента просто перечитывалась и применяла к результату обычные
 * отсеивания: регион и слова профиля, «вне профиля поиска», оценку «Не подходит».
 * Живой поиск смотрит по всей России, поэтому найденное часто оказывалось
 * «скрытым»: чтобы увидеть последний результат, приходилось открывать
 * «Расширенный поиск» и нажимать «Показать скрытые» (замечание владельца
 * 12.10.2026). Отметка говорит ленте, какие строки принёс именно этот поиск: их
 * не прячут, ставят первыми и подписывают причину, по которой в обычной выдаче
 * их бы не было.
 *
 * Какие строки считаются результатом поиска:
 *  - новые: первое появление в базе (`created_at`) не раньше начала поиска;
 *  - уже лежавшие, но найденные тем же живым запросом (`raw_data.origin = "live"`
 *    и тот же `query`): живой поиск пишет пометку и в уже известные строки.
 *
 * Чистая логика без браузера; хранение — в конце файла, с запасом на
 * недоступную память.
 */

export type SearchMarkerKind = "live" | "first" | "full";

export interface SearchMarker {
  kind: SearchMarkerKind;
  /** Начало поиска, ISO. Новыми считаются строки, появившиеся не раньше (с допуском). */
  startedAt: string;
  /** Запросы живого поиска; у «Найти новые закупки» запроса нет. */
  queries: string[];
  /**
   * Когда человек в прошлый раз открывал ленту (до этого поиска), ISO.
   *
   * База пополняется сама каждые два часа, поэтому кнопка поиска редко приносит то,
   * чего в базе ещё нет: «новых» по началу поиска выходил ноль, и сверху вставали
   * старые совпадения (замечание владельца 15.10.2026). Человеку новое — то, чего он
   * не видел: всё, что появилось в базе после его прошлого визита, тоже результат.
   */
  seenBefore?: string;
}

/**
 * Допуск на расхождение часов браузера и базы.
 *
 * Начало поиска — время на часах человека, а `created_at` ставит Postgres. Часы
 * не обязаны совпадать, и без допуска закупка, записанная сразу после нажатия,
 * могла оказаться «старее» поиска, который её принёс, — то есть потерялась бы
 * ровно там, где её ищут. Цена допуска — при редком совпадении во времени в
 * результат попадёт закупка, найденная чужим поиском за пару минут до нашего.
 */
export const SEARCH_START_SLACK_MS = 2 * 60_000;

/** Отметка живёт сутки: дальше «последний поиск» перестаёт быть последним в смысле человека. */
export const SEARCH_MARKER_TTL_MS = 24 * 60 * 60_000;

export const SEARCH_MARKER_KEY = "tenderfit.lastSearch";

/** Когда человек последний раз открывал ленту: от этого момента закупки для него новые. */
export const FEED_SEEN_KEY = "tenderfit.feedSeenAt";
/** Прошлый визит старше недели не учитывается — см. `searchFreshSince`. */
export const FEED_SEEN_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Запрос для сравнения: без регистра и лишних пробелов, как его хранит живой поиск. */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Результат поиска в ленте: новые строки и найденные тем же запросом, но уже лежавшие. */
export interface SearchResultRows {
  fresh: TenderRow[];
  known: TenderRow[];
}

/** С какого момента строка считается новой для этого поиска: начало поиска или прошлый визит, что раньше. */
export function searchFreshSince(marker: SearchMarker): number {
  const started = Date.parse(marker.startedAt) - SEARCH_START_SLACK_MS;
  const seen = marker.seenBefore === undefined ? Number.NaN : Date.parse(marker.seenBefore);
  // Не глубже недели: после долгого перерыва «новым» оказалась бы вся база.
  const floor = Date.parse(marker.startedAt) - FEED_SEEN_MAX_AGE_MS;
  if (!Number.isFinite(seen) || seen >= started) return started;
  return Math.max(seen, floor);
}

export function rowsFromSearch(rows: readonly TenderRow[], marker: SearchMarker): SearchResultRows {
  const since = searchFreshSince(marker);
  const queries = new Set(marker.queries.map(normalizeQuery).filter((q) => q !== ""));
  const fresh: TenderRow[] = [];
  const known: TenderRow[] = [];
  for (const row of rows) {
    const seenAt = row.tender.firstSeenAt == null ? Number.NaN : Date.parse(row.tender.firstSeenAt);
    if (Number.isFinite(since) && Number.isFinite(seenAt) && seenAt >= since) {
      fresh.push(row);
      continue;
    }
    const live = row.tender.liveQuery;
    if (live !== null && live !== undefined && queries.has(normalizeQuery(live))) known.push(row);
  }
  return { fresh, known };
}

/** Разбор сохранённой отметки: чужое и просроченное — null. */
export function parseSearchMarker(raw: unknown, now: number = Date.now()): SearchMarker | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, startedAt, queries } = raw as Partial<Record<keyof SearchMarker, unknown>>;
  if (kind !== "live" && kind !== "first" && kind !== "full") return null;
  if (typeof startedAt !== "string") return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  if (now - started > SEARCH_MARKER_TTL_MS) return null;
  const list = Array.isArray(queries)
    ? queries.filter((q): q is string => typeof q === "string" && q.trim() !== "")
    : [];
  const seenBefore = (raw as { seenBefore?: unknown }).seenBefore;
  return typeof seenBefore === "string" && Number.isFinite(Date.parse(seenBefore))
    ? { kind, startedAt, queries: list, seenBefore }
    : { kind, startedAt, queries: list };
}

/** Прочитать отметку из памяти браузера; просроченная стирается. */
export function loadSearchMarker(now: number = Date.now()): SearchMarker | null {
  try {
    const text = window.localStorage.getItem(SEARCH_MARKER_KEY);
    if (text === null) return null;
    const marker = parseSearchMarker(JSON.parse(text) as unknown, now);
    if (marker === null) window.localStorage.removeItem(SEARCH_MARKER_KEY);
    return marker;
  } catch {
    // Память недоступна или в ней мусор: отметки просто нет.
    return null;
  }
}

/** Запомнить отметку, чтобы перезагрузка страницы сразу после поиска её не потеряла. */
export function saveSearchMarker(marker: SearchMarker): void {
  try {
    window.localStorage.setItem(SEARCH_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // Без памяти отметка живёт до перезагрузки — это удобство, а не данные.
  }
}

export function clearSearchMarker(): void {
  try {
    window.localStorage.removeItem(SEARCH_MARKER_KEY);
  } catch {
    // См. saveSearchMarker.
  }
}

/** Название поиска для заголовка: «запрос» в кавычках или пусто у «Найти новые закупки». */
export function markerQueryLabel(marker: SearchMarker): string | null {
  const first = marker.queries[0];
  return first === undefined ? null : `«${first}»`;
}

/** Строки, появившиеся в базе после момента `since` (мс): «новые для вас». */
export function rowsNewSince(rows: readonly TenderRow[], since: number | null): Set<string> {
  const ids = new Set<string>();
  if (since === null || !Number.isFinite(since)) return ids;
  for (const row of rows) {
    const seenAt = row.tender.firstSeenAt == null ? Number.NaN : Date.parse(row.tender.firstSeenAt);
    if (Number.isFinite(seenAt) && seenAt >= since) ids.add(row.tender.id);
  }
  return ids;
}

/**
 * Прочитать прошлый визит и сразу отметить нынешний. Возвращает прошлый (ISO) или null —
 * первый визит, память недоступна, или визит старше недели.
 */
let feedSeenThisLoad: string | null | undefined;

export function takeFeedSeen(now: number = Date.now()): string | null {
  // Один раз на загрузку страницы: повторное монтирование ленты (переход туда и обратно,
  // двойной эффект в разработке) не должно сдвигать «прошлый визит» на только что.
  if (feedSeenThisLoad !== undefined) return feedSeenThisLoad;
  feedSeenThisLoad = readAndMarkFeedSeen(now);
  return feedSeenThisLoad;
}

/** Для тестов: забыть, что визит уже отмечен. */
export function resetFeedSeenForTests(): void {
  feedSeenThisLoad = undefined;
}

function readAndMarkFeedSeen(now: number): string | null {
  try {
    const previous = window.localStorage.getItem(FEED_SEEN_KEY);
    window.localStorage.setItem(FEED_SEEN_KEY, new Date(now).toISOString());
    if (previous === null) return null;
    const at = Date.parse(previous);
    return Number.isFinite(at) && now - at <= FEED_SEEN_MAX_AGE_MS && at < now ? previous : null;
  } catch {
    return null;
  }
}
