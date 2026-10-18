/**
 * Сбой «устаревшая вкладка после выкладки».
 *
 * Зачем. После каждой выкладки у Next меняются файлы страниц. Вкладка, открытая
 * до неё, при переходе просит старый файл, сервер его уже не отдаёт, и Next
 * показывает голое «Application error: a client-side exception has occurred» —
 * так 11.10.2026 выглядел первый вход после запуска пробного периода.
 *
 * Лечится это перезагрузкой, но не всегда первой: сервер собирается на месте,
 * и минуту-две, пока идёт сборка, файлов страниц нет вовсе (12.10.2026 одна
 * перезагрузка попала ровно в это окно и снова упала). Поэтому перезагрузок
 * несколько, с растущими паузами — в сумме около двух минут. Дальше сбой уже не
 * похож на выкладку, и крутить перезагрузки по кругу нельзя.
 */

const ATTEMPTS_KEY = "tenderfit:chunk-reload-attempts";

/** Паузы перед перезагрузками, мс: 0 — сразу, дальше всё реже (≈2 мин в сумме). */
export const CHUNK_RELOAD_DELAYS_MS: readonly number[] = [0, 5_000, 10_000, 20_000, 30_000, 45_000];

/** Серия попыток забывается через столько: следующая выкладка — новая серия. */
const SERIES_TTL_MS = 10 * 60_000;

/** Ошибка — недогруженный файл страницы (устаревшая сборка), а не сбой кода. */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  const text = typeof message === "string" ? message : "";
  return /Loading (?:CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    text,
  );
}

function readAttempts(now: number): number[] {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(ATTEMPTS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((t): t is number => typeof t === "number" && now - t < SERIES_TTL_MS);
  } catch {
    return [];
  }
}

/**
 * Через сколько мс перезагрузить страницу, или null — попытки кончились
 * (или хранилище недоступно: без отметок нельзя гарантировать, что круга не будет).
 * Попытка сразу записывается, поэтому вызывать — только когда перезагрузка будет.
 */
export function nextChunkReloadDelay(now: number = Date.now()): number | null {
  const attempts = readAttempts(now);
  const delay = CHUNK_RELOAD_DELAYS_MS[attempts.length];
  if (delay === undefined) return null;
  try {
    window.sessionStorage.setItem(ATTEMPTS_KEY, JSON.stringify([...attempts, now]));
  } catch {
    return null;
  }
  return delay;
}

/** Страница открылась нормально — серия попыток больше не нужна. */
export function clearChunkReloadAttempts(): void {
  try {
    window.sessionStorage.removeItem(ATTEMPTS_KEY);
  } catch {
    // хранилище недоступно — помнить нечего
  }
}
