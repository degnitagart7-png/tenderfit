const MOSCOW_OFFSET_MS = 3 * 60 * 60_000;

/**
 * Время в Москве (UTC+3, без перехода на летнее) в виде «15:42».
 *
 * Отдельный модуль без Node-зависимостей: подпись «повторим после 15:42 МСК»
 * нужна и затвору ЕИС (серверная часть), и интерфейсу.
 */
export function formatMoscowTime(ms: number): string {
  const d = new Date(ms + MOSCOW_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
