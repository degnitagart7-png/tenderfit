/**
 * Урезанный `raw_data` для строк списка закупок.
 *
 * В `raw_data` лежит последний сырой ответ источника целиком — десятки
 * килобайт на строку, а лента из тысячи строк тащила их все ради трёх мелочей.
 * Клиент читает из `raw_data` ровно:
 *  - `origin` — откуда строка: `"live"` (живой поиск) или `"sense"` (подбор
 *    моделью);
 *  - `query` — запрос живого поиска (`liveQueryOf` в tenderApiService);
 *  - `keywords` — слова, под которые закупку отобрала модель
 *    (`senseKeywordsOf` там же).
 * Больше никто в `src/components`, `src/domain` и `src/hooks` его не касается
 * (проверено поиском по `raw_data` / `rawData`). Сохраняем эти три ключа, остальное
 * срезаем. Полный `raw_data` остаётся в базе, и серверным путям (воркер,
 * разбор) он по-прежнему доступен: урезается только ответ `GET /api/tenders`.
 *
 * Добавляя в клиент чтение нового ключа `raw_data`, добавьте его сюда же —
 * иначе поле придёт пустым, а тест на список ключей напомнит об этом.
 */
export const FEED_RAW_DATA_KEYS = ["origin", "query", "keywords"] as const;

/** `raw_data` строки списка: только ключи из `FEED_RAW_DATA_KEYS`; пустое — как есть. */
export function trimFeedRawData(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const kept: Record<string, unknown> = {};
  for (const key of FEED_RAW_DATA_KEYS) {
    if (key in raw) kept[key] = raw[key];
  }
  // Ничего полезного — отдаём `null`: пустой объект занимал бы место ради
  // того же ответа «меток нет».
  return Object.keys(kept).length > 0 ? kept : null;
}

/** Строка списка с урезанным `raw_data`; остальные поля не трогаются. */
export function trimFeedRow<T extends { raw_data?: Record<string, unknown> | null }>(row: T): T {
  if (row.raw_data === undefined) return row;
  return { ...row, raw_data: trimFeedRawData(row.raw_data) as T["raw_data"] };
}
