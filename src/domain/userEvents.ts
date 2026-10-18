/**
 * Журнал действий пользователей: виды событий, подписи и ограничитель частоты.
 *
 * Чистый модуль без базы и часов (время приходит параметром): им пользуются и
 * запись (services/userEventLog), и страница администратора, и тесты.
 */

export const USER_EVENT_KINDS = [
  "login",
  "feed_open",
  "tender_open",
  "deep_analysis",
  "estimate",
  "live_search",
  "link_import",
  "find_new",
  "error",
] as const;

export type UserEventKind = (typeof USER_EVENT_KINDS)[number];

/** Подписи действий для журнала администратора. Неизвестный вид печатается как есть. */
export const USER_EVENT_LABELS: Record<UserEventKind, string> = {
  login: "Вход",
  feed_open: "Открыл ленту",
  tender_open: "Открыл карточку закупки",
  deep_analysis: "Глубокий анализ",
  estimate: "Смета",
  live_search: "Живой поиск",
  link_import: "Добавил закупку по ссылке",
  find_new: "«Найти новые закупки»",
  error: "Ошибка сервиса",
};

export function userEventLabel(kind: string): string {
  return (USER_EVENT_LABELS as Record<string, string>)[kind] ?? kind;
}

/** Сколько знаков подробности хранится: длинный текст ошибки журналу ни к чему. */
export const MAX_EVENT_DETAIL_CHARS = 300;

/** Почта в виде, как в app_users: без пробелов и в нижнем регистре. Пустая — null. */
export function normalizeEventEmail(email: string | null | undefined): string | null {
  const value = (email ?? "").trim().toLowerCase();
  return value === "" ? null : value;
}

/** Подробность для записи: без нулевых символов (Postgres их не принимает), не длиннее предела. */
export function normalizeEventDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const clean = detail.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  return clean.length > MAX_EVENT_DETAIL_CHARS ? `${clean.slice(0, MAX_EVENT_DETAIL_CHARS - 1)}…` : clean;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Как часто пишется шумный вид события.
 *
 * Лента и карточка открываются десятки раз за сессию, и строка на каждое открытие
 * заполнила бы таблицу и ничего не добавила: для «как часто пользуется» хватает
 * отметки «был здесь в этот час». Ошибки одной ручки у одного человека тоже
 * схлопываются: опрос каждые пару секунд при упавшей базе дал бы сотни одинаковых строк.
 */
export const EVENT_THROTTLE_MS: Partial<Record<UserEventKind, number>> = {
  feed_open: 10 * MINUTE_MS,
  tender_open: HOUR_MS,
  error: MINUTE_MS,
};

/** Ключ ограничителя: у карточки — почта и закупка, у ошибки — почта и начало описания (ручка), у остального — почта. */
export function throttleKey(kind: UserEventKind, email: string, tenderId?: string | null, detail?: string | null): string {
  if (kind === "tender_open") return `${kind}|${email}|${tenderId ?? ""}`;
  if (kind === "error") return `${kind}|${email}|${(detail ?? "").slice(0, 60)}`;
  return `${kind}|${email}`;
}

export interface EventThrottle {
  /** true — событие нужно записать (и окно начато заново); false — слишком скоро после прошлого. */
  allow(key: string, windowMs: number): boolean;
  /** Сколько ключей помнит (для тестов). */
  size(): number;
}

/**
 * Ограничитель «не чаще раза за окно» в памяти процесса.
 *
 * Память одного процесса — осознанно: сервер один (VPS), а потеря памяти при
 * перезапуске стоит одной лишней строки. Забытые ключи вычищаются, когда их
 * набирается больше `maxKeys`, чтобы карта не росла от каждой закупки.
 */
export function createEventThrottle(now: () => number = Date.now, maxKeys = 5000): EventThrottle {
  const last = new Map<string, number>();
  return {
    allow(key, windowMs) {
      const at = now();
      const previous = last.get(key);
      if (previous !== undefined && at - previous < windowMs) return false;
      if (last.size >= maxKeys) {
        // Сначала выбрасываем то, что и так уже вне окна; если не помогло — самое старое.
        for (const [k, t] of last) if (at - t >= HOUR_MS) last.delete(k);
        if (last.size >= maxKeys) {
          const oldest = last.keys().next().value;
          if (oldest !== undefined) last.delete(oldest);
        }
      }
      last.delete(key); // порядок вставки = порядок давности
      last.set(key, at);
      return true;
    },
    size: () => last.size,
  };
}
