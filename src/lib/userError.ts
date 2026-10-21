/**
 * Ошибка для человека. Сбой сети, разрыв соединения с внутренним сервисом или падение разбора приходят в `error.message` как
 * «TypeError: fetch failed — … ECONNREFUSED 127.0.0.1:18088»: показывать такое пользователю нельзя, он не может с этим ничего сделать,
 * а адрес внутреннего сервиса выдавать не стоит. Техническое сообщение уходит в консоль (его читает тот, кто чинит), а на экране —
 * спокойная фраза. Человеческие причины из наших роутов («Расчёт не найден», «Проверка ещё не закончена») проходят как есть.
 */

export const FRIENDLY_LOAD_ERROR = "Не удалось загрузить — повторите через минуту.";

const TECHNICAL = /TypeError|ReferenceError|SyntaxError|fetch failed|failed to fetch|networkerror|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang|\bHTTP \d{3}\b|Unexpected token|is not valid JSON|ответ не является JSON|PGRST|undefined|\bat \S+ \(|\.ts:\d+|stack/i;

export function isTechnicalError(message: string): boolean {
  return TECHNICAL.test(message);
}

/** Текст ошибки для экрана; техническое пишется в консоль. */
export function userFacingError(error: unknown, fallback: string = FRIENDLY_LOAD_ERROR): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.trim() === "") return fallback;
  if (isTechnicalError(message)) {
    console.error("[user-error]", error);
    return fallback;
  }
  return message;
}
