/**
 * Выборка длиннее страницы базы — параллельными запросами.
 *
 * PostgREST отдаёт не больше тысячи строк за обращение (`max-rows`), а лента
 * хочет всё сразу. Раньше браузер сам листал страницы: два запроса подряд по
 * мегабайту с лишним, причём второй стартовал только после ответа на первый.
 * Теперь листает сервер, и страницы ему не нужно ждать по очереди: как только
 * известно, сколько строк подходит под фильтры, остальные страницы уходят в
 * базу одновременно, а склеиваются в порядке смещений — порядок строк тот же,
 * что у одного большого запроса.
 *
 * Первая страница и подсчёт идут вместе: если вся выдача уместилась в одну
 * страницу (первая вернулась неполной), подсчёт ничего не изменил и обошёлся
 * бесплатно по времени.
 *
 * Вынесено из роута, чтобы проверяться без базы и сети: оба обращения —
 * переданные функции.
 */

/** Сколько строк за раз отдаёт PostgREST. */
export const DB_PAGE_SIZE = 1000;

export interface PagedFetchPorts<T> {
  /** Одна страница: `limit` строк начиная со смещения `offset`. */
  fetchPage: (offset: number, limit: number) => Promise<T[]>;
  /** Сколько строк подходит под фильтры всего (без учёта смещения). */
  countTotal: () => Promise<number>;
}

export async function fetchPaged<T>(
  { limit, offset }: { limit: number; offset: number },
  { fetchPage, countTotal }: PagedFetchPorts<T>,
  pageSize: number = DB_PAGE_SIZE,
): Promise<T[]> {
  // Короткая выдача (явный `limit` у одной закупки и т.п.) — как раньше, одним
  // запросом и без подсчёта.
  if (limit <= pageSize) return fetchPage(offset, limit);

  const [first, total] = await Promise.all([fetchPage(offset, pageSize), countTotal()]);
  if (first.length < pageSize) return first;

  // Сколько строк просят на самом деле: не больше `limit` и не больше, чем есть.
  const wanted = Math.min(limit, Math.max(0, total - offset));
  const jobs: Array<Promise<T[]>> = [];
  for (let start = pageSize; start < wanted; start += pageSize) {
    jobs.push(fetchPage(offset + start, Math.min(pageSize, wanted - start)));
  }
  const rest = await Promise.all(jobs);
  // Порядок задаёт индекс задания, а не порядок прихода ответов.
  return first.concat(...rest);
}
