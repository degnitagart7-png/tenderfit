/**
 * Точка входа к языковой модели: адрес шлюза, ключ и имя модели.
 *
 * Проект начинался на OpenRouter, но шлюзов с тем же протоколом несколько.
 * Российский routerai.ru отдаёт и Gemini, и YandexGPT за рубли и отвечает с
 * российского IP — то есть после переезда на отечественный VPS разбор
 * продолжит работать, а OpenRouter из России не отвечает вовсе. Поэтому адрес,
 * ключ и модель читаются из окружения, а не зашиты в код: смена провайдера
 * должна быть правкой настроек, а не правкой программы.
 */
export interface LlmEndpoint {
  /** Корень API без завершающего слэша, например https://routerai.ru/api/v1. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Модель по умолчанию — та, на которой замерена стоимость разбора. */
export const DEFAULT_MODEL = "google/gemini-2.5-flash";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

type Env = Record<string, string | undefined>;

/**
 * Собирает настройки шлюза из окружения.
 *
 * Прежние имена OPENROUTER_* остаются запасными: на проде они уже заданы, и
 * переход на другой шлюз не должен ломать работающий разбор в тот момент, когда
 * новый ключ ещё не пополнен. Время и окружение передаются параметрами, чтобы
 * правило можно было проверить тестом без подмены process.env.
 */
export function resolveLlmEndpoint(env: Env = process.env): LlmEndpoint {
  const apiKey = (env.LLM_API_KEY ?? env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("Не задан ключ языковой модели: LLM_API_KEY (или прежний OPENROUTER_API_KEY)");
  }

  return {
    // Пустое значение означает «не задано», а не «адрес — пустая строка»: на
    // Vercel переменную часто обнуляют вместо удаления.
    baseUrl: normalizeBaseUrl(
      firstNonEmpty(env.LLM_BASE_URL, env.OPENROUTER_BASE_URL) ?? DEFAULT_BASE_URL,
    ),
    apiKey,
    model: resolveLlmModel(env),
  };
}

/**
 * Имя модели — отдельно от ключа.
 *
 * Пайплайну нужно записать, какая модель делала выводы (`model_used`), ещё до
 * первого вызова. Требовать для этого ключ означало бы ронять задачу, которая до
 * модели может и не дойти: например, когда ни один документ закупки не читается.
 */
export function resolveLlmModel(env: Env = process.env): string {
  return firstNonEmpty(env.LLM_MODEL, env.OPENROUTER_MODEL) ?? DEFAULT_MODEL;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * Нормализует адрес шлюза.
 *
 * Завершающий слэш срезаем: путь chat/completions прибавляется к корню, и лишний
 * слэш дал бы двойной — одни шлюзы это прощают, другие отвечают 404.
 * http:// запрещён: ключ модели уходит в заголовке, и по открытому соединению
 * его перехватит любой посредник на пути.
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("https://") || trimmed === "https://") {
    throw new Error(`Адрес шлюза модели должен начинаться с https://, получено: ${raw}`);
  }
  return trimmed;
}

/** Хост шлюза для сообщений об ошибках: по нему оператор понимает, кто отказал. */
export function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
