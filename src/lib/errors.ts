/**
 * Расшифровка ошибки в строку, пригодную для лога, отчёта задания и панели.
 *
 * Одна функция на все источники сбоев — сеть, база, дочерний процесс, — потому
 * что каждый из них приходит в своей форме, и потерянная деталь стоит часов:
 *
 *   · `fetch failed` без кода причины не отличает «источник не пускает наш
 *     адрес» от «сервис не отвечает». Код живёт в `err.cause.code`;
 *   · ошибка PostgREST — не `Error`, а простой объект `{ message, details, hint,
 *     code }`. `String(err)` на нём даёт `[object Object]`, и именно так
 *     25.09.2026 воркер сообщил о неприменённой миграции: причину пришлось
 *     угадывать по контексту;
 *   · `err.code` у сетевой ошибки отсутствует, а у ошибки базы — присутствует,
 *     поэтому код ищется в обоих местах.
 */

/**
 * Коды, означающие «соединение не установлено».
 *
 * Именно так ЕИС и её хранилище отвечают зарубежному адресу: запрос не доходит
 * до приложения, поэтому нет ни статуса, ни тела — только обрыв на уровне
 * сокета. Таймаут чтения заголовков и сбой разрешения имени сюда не входят:
 * первый означает медленный ответ, второй — проблему с DNS, и подпись «источник
 * не пускает наш адрес» в обоих случаях была бы неверной.
 */
const BLOCKED_CODES = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Код ошибки: у сети он в `cause.code`, у базы — в `code`. */
function errorCode(err: unknown): string | null {
  const record = asRecord(err);
  if (!record) return null;
  return (
    nonEmptyString(record["code"]) ?? nonEmptyString(asRecord(record["cause"])?.["code"]) ?? null
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;

  const text = nonEmptyString(err);
  if (text !== null) return text;

  // Примитивы JSON.stringify может исказить (NaN превращается в null).
  if (err !== null && err !== undefined && typeof err !== "object") return String(err);

  const record = asRecord(err);
  if (record) {
    const message =
      nonEmptyString(record["message"]) ??
      nonEmptyString(record["error"]) ??
      nonEmptyString(record["msg"]);
    if (message !== null) {
      // `details` у PostgREST обычно пусто, но когда заполнено — это самое
      // полезное место сообщения: там названа недостающая таблица или колонка.
      const details = nonEmptyString(record["details"]);
      return details !== null ? `${message} — ${details}` : message;
    }
  }

  // Последняя защита: JSON, а не `[object Object]`.
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

export function describeError(err: unknown): string {
  const message = errorMessage(err);
  const code = errorCode(err);
  if (!code) return message;

  return BLOCKED_CODES.has(code)
    ? `${message} (${code}) — соединение не установлено: источник не пускает наш адрес ` +
        "(VPN/прокси, зарубежный выход или фильтр сети)"
    : `${message} (${code})`;
}
