/** Сколько знаков чужого тела попадает в сообщение об ошибке. */
const MAX_BODY_CHARS = 200;

/**
 * Разбирает ответ, проверив сначала код, а потом тело.
 *
 * Зачем отдельная функция. Порядок «сначала `json()`, потом `response.ok`»
 * выглядит безобидно и ломается там, где неудача приходит не JSON'ом: маршрут,
 * которого нет, отдаёт страницу 404 целиком; шлюз и обратный прокси — свою
 * страницу ошибки; упавший процесс — пустое тело. Разбор падает первым, и
 * наверх уходит «Unexpected token <» вместо «HTTP 502» — теряется ровно та
 * часть, по которой чинят.
 *
 * Обратная крайность тоже неверна. Наши роуты кладут в JSON поле `error` с
 * человеческой причиной («Очередь заданий не настроена: примените миграцию…»),
 * и заменять её кодом было бы шагом назад: код говорит, что сломалось, а
 * `error` — что делать.
 *
 * Поэтому: тело читается как текст, разбор JSON — попытка, а не условие. Есть
 * `error` — берём его. Нет — называем код и показываем начало тела, обрезав:
 * страница ошибки шлюза занимает килобайты, и целиком в журнале она не нужна.
 */
export async function readJsonOrThrow<T>(response: Response): Promise<T> {
  const raw = await response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    const message = messageFrom(parsed);
    throw new Error(
      message === null
        ? `HTTP ${String(response.status)}: ${describeBody(raw)}`
        : message,
    );
  }

  if (parsed === undefined) {
    throw new Error(
      `HTTP ${String(response.status)}: ответ не является JSON — ${describeBody(raw)}`,
    );
  }

  return parsed as T;
}

function messageFrom(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const error = (parsed as { error?: unknown }).error;
  return typeof error === "string" && error.trim().length > 0 ? error : null;
}

function describeBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "тело ответа пустое";
  return flat.length > MAX_BODY_CHARS ? `${flat.slice(0, MAX_BODY_CHARS)}…` : flat;
}
