/**
 * Контракт API Контур.Закупок.
 *
 * СТАТУС КОНТРАКТА: ПОДТВЕРЖДЁН. Источник — официальная спецификация
 * OpenAPI 3.0.4 «АПИ Закупок» v1.0.0 (`zakupki.external_api-api.json`,
 * получена от вендора 2026-09-22) и живой зонд тестовым ключом 2026-09-23:
 * `GET /external/v1/limitGroups` → 200, `GET /external/v1/testpurchases/{id}`
 * → 200, `POST /external/v1/search` → 200 (379 закупок, 50 на странице).
 * Повторно проверен боевым ключом 2026-09-24: те же эндпоинты и та же схема
 * ответа, отличается только тариф (см. ниже) и отсутствие закрашенных значений.
 * Разбор спецификации — `docs/REFERENCE_KONTUR_API.md`.
 *
 * Ранняя версия этого файла держала рабочую гипотезу (zakupki.kontur.ru,
 * `Authorization: Bearer`, `/api/v1/search`, `/api/v1/tenders/{id}/documents`).
 * Все четыре предположения оказались неверными. Логика адаптера при этом не
 * изменилась — правится только конфигурация: именно для этого догадки были
 * собраны в одном месте.
 *
 * Что важно знать про стоимость. Тарифы «Поиск» и «Получение закупки»
 * считаются раздельно, по группам лимитов (`search`, `purchase`, `favorites`,
 * `results`); суточный счётчик сбрасывается в 00:00, а превышение лимита хотя
 * бы на один запрос — ошибка. Боевой тариф с 24.09.2026 — 30 запросов в сутки
 * на каждый метод (зонд `/limitGroups`: `search` 30, `purchase` 30, `results`
 * 30), то есть за день реально снять 30 поисковых выдач и 30 карточек. Отсюда
 * три правила адаптера: cache-first, дневной бюджет по каждому методу отдельно
 * и журнал каждого обращения.
 */
import type { KonturRequestKind } from "@/adapters/types";

/** Полное описание точки подключения. */
export interface KonturApiContract {
  baseUrl: string;
  /** API-ключ из Кабинета Интегратора. Пустая строка — ключ не задан. */
  apiKey: string;
  /**
   * Схема в заголовке авторизации. У Контур.Закупок её нет: ключ передаётся
   * значением заголовка как есть (`X-Kontur-Apikey: <ключ>`).
   */
  authScheme: string;
  /** Имя заголовка авторизации: не у всех API Контур это Authorization. */
  authHeader: string;
  /** Шаблон пути поиска. Метод — POST, тело JSON (`ExternalApiSearchArgs`). */
  searchPath: string;
  /** Шаблон пути карточки закупки. {id} заменяется идентификатором закупки. */
  tenderPath: string;
  /**
   * Шаблон пути карточки в тестовом режиме. Суточный лимит не расходуется,
   * данные не закрашены, но доступен только фиксированный список id из
   * спецификации. Нужен для разработки и проверки парсера на реальных ответах.
   */
  testTenderPath: string;
  /** Путь лимитов по группам методов (`ExternalApiLimitModel[]`). */
  limitGroupsPath: string;
}

/** Значения по умолчанию — подтверждены спецификацией и живым зондом. */
export const KONTUR_CONTRACT_DEFAULTS: Omit<KonturApiContract, "apiKey"> = {
  baseUrl: "https://api-zakupki.kontur.ru",
  authScheme: "",
  authHeader: "X-Kontur-Apikey",
  searchPath: "/external/v1/search",
  tenderPath: "/external/v1/purchases/{id}",
  testTenderPath: "/external/v1/testpurchases/{id}",
  limitGroupsPath: "/external/v1/limitGroups",
};

/**
 * Протокольные ограничения, зафиксированные спецификацией. Менять их нельзя —
 * это не настройки, а условия тарифа.
 */
export const KONTUR_PROTOCOL = {
  /** Закупок на одной странице выдачи. Больше API не отдаёт. */
  pageSize: 50,
  /** Сколько закупок максимум можно снять с одного диапазона дат. */
  maxPerDateRange: 10_000,
  /** Не более пяти одновременных обращений на ключ. */
  maxConcurrent: 5,
  /**
   * Обязательный диапазон дат публикации. Без него поиск отвечает 400,
   * поэтому адаптер всегда подставляет окно, а не «всё подряд».
   */
  requiresDateRange: true,
} as const;

/**
 * Маркер закрашенного значения. Тариф без права на данные скрывает персональные
 * и коммерчески значимые поля, заменяя их этим символом (`BlurredApiSchema` в
 * спецификации, пример `"#####"`; фактически API использует U+2591). На тестовом
 * ключе 2026-09-23 были закрашены ИНН, КПП, наименования организаций, контакты,
 * ссылки на ЭТП и ЕИС, адреса документов, места поставки и коды ОКПД2.
 *
 * С 24.09.2026 ключ боевой: зонд карточки и поисковой выдачи не нашёл ни одного
 * маркера, а `Docs[].Url` содержит настоящую ссылку на filestore zakupki.gov.ru.
 * Проверка остаётся — она ничего не стоит и защищает от возврата на
 * ограниченный тариф, при котором «░░░░░» в поле «регион» превратилось бы в
 * регион, которого не существует.
 */
export const KONTUR_BLUR_MARKER = "░";

/** Значение закрашено ограниченным тарифом (или целиком состоит из маркера). */
export function isBlurredValue(value: unknown): boolean {
  return typeof value === "string" && value.includes(KONTUR_BLUR_MARKER);
}

/** Группы суточных лимитов — ровно те, что возвращает /external/v1/limitGroups. */
export const KONTUR_LIMIT_GROUPS = ["search", "purchase", "favorites", "results"] as const;

export type KonturLimitGroup = (typeof KONTUR_LIMIT_GROUPS)[number];

/**
 * Виды запросов, за которые тариф списывает суточный лимит.
 *
 * Остальные бесплатны, и это проверено живым зондом 2026-09-23: после двух
 * вызовов `/external/v1/limitGroups` и четырёх `/external/v1/testpurchases/{id}`
 * счётчики групп остались `199/200` — по одному запросу на реально платные
 * `search` и `purchases`. Значит тестовые карточки и остаток лимита можно
 * запрашивать свободно, а дневной бюджет считать только по платным видам.
 */
export const KONTUR_BILLABLE_KINDS = ["search", "card"] as const;

/** Платный вид запроса — тот, у которого есть своя группа суточного лимита. */
export type KonturBillableKind = (typeof KONTUR_BILLABLE_KINDS)[number];

/**
 * Группа суточного лимита, которую расходует вид запроса; `null` — запрос
 * бесплатный. Боевой тариф с 24.09.2026 даёт 30 запросов в сутки на каждую
 * группу отдельно, поэтому и бюджет считается по видам, а не одной суммой.
 */
export const KONTUR_KIND_LIMIT_GROUP: Record<KonturRequestKind, KonturLimitGroup | null> = {
  search: "search",
  card: "purchase",
  testcard: null,
  limits: null,
};

/** Название метода для журнала и сообщения об исчерпанном лимите. */
export const KONTUR_KIND_LABELS: Record<KonturRequestKind, string> = {
  search: "поиск",
  card: "карточка закупки",
  testcard: "тестовая карточка",
  limits: "остаток лимита",
};

/** Списывает ли запрос суточный лимит. Одновременно сужает тип до платного. */
export function isBillableKonturKind(kind: KonturRequestKind): kind is KonturBillableKind {
  return (KONTUR_BILLABLE_KINDS as readonly string[]).includes(kind);
}

function readString(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/**
 * Как readString, но пустое значение считается заданным. Нужно для схемы
 * авторизации: у Контур.Закупок ключ передаётся отдельным заголовком без
 * префикса (KONTUR_API_AUTH_SCHEME= → «X-Kontur-Apikey: <ключ>»).
 */
function readStringAllowEmpty(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const value = env[key];
  return value === undefined ? fallback : value.trim();
}

/** Собирает контракт из переменных окружения. */
export function resolveKonturContract(
  env: Record<string, string | undefined> = process.env,
): KonturApiContract {
  return {
    baseUrl: readString(
      env,
      "KONTUR_API_BASE_URL",
      KONTUR_CONTRACT_DEFAULTS.baseUrl,
    ).replace(/\/+$/, ""),
    apiKey: readString(env, "KONTUR_API_KEY", ""),
    authScheme: readStringAllowEmpty(
      env,
      "KONTUR_API_AUTH_SCHEME",
      KONTUR_CONTRACT_DEFAULTS.authScheme,
    ),
    authHeader: readString(env, "KONTUR_API_AUTH_HEADER", KONTUR_CONTRACT_DEFAULTS.authHeader),
    searchPath: readString(env, "KONTUR_API_SEARCH_PATH", KONTUR_CONTRACT_DEFAULTS.searchPath),
    tenderPath: readString(env, "KONTUR_API_TENDER_PATH", KONTUR_CONTRACT_DEFAULTS.tenderPath),
    testTenderPath: readString(
      env,
      "KONTUR_API_TEST_TENDER_PATH",
      KONTUR_CONTRACT_DEFAULTS.testTenderPath,
    ),
    limitGroupsPath: readString(
      env,
      "KONTUR_API_LIMIT_GROUPS_PATH",
      KONTUR_CONTRACT_DEFAULTS.limitGroupsPath,
    ),
  };
}

/** Ключ задан — можно ходить в API. */
export function hasKonturApiKey(contract: KonturApiContract): boolean {
  return contract.apiKey.length > 0;
}

/** Заголовки авторизации. При пустом ключе не добавляем заголовок вовсе. */
export function konturAuthHeaders(contract: KonturApiContract): Record<string, string> {
  if (!hasKonturApiKey(contract)) return {};
  const value = contract.authScheme
    ? `${contract.authScheme} ${contract.apiKey}`
    : contract.apiKey;
  return { [contract.authHeader]: value };
}

function fillTemplate(template: string, id: string): string {
  return template.replace(/\{id\}/g, encodeURIComponent(id));
}

/** URL поиска (POST). */
export function konturSearchUrl(contract: KonturApiContract): string {
  return `${contract.baseUrl}${contract.searchPath}`;
}

/** URL карточки закупки (GET). */
export function konturTenderUrl(contract: KonturApiContract, id: string): string {
  return `${contract.baseUrl}${fillTemplate(contract.tenderPath, id)}`;
}

/** URL карточки в бесплатном тестовом режиме (GET). */
export function konturTestTenderUrl(contract: KonturApiContract, id: string): string {
  return `${contract.baseUrl}${fillTemplate(contract.testTenderPath, id)}`;
}

/** URL лимитов по группам методов (GET). */
export function konturLimitGroupsUrl(contract: KonturApiContract): string {
  return `${contract.baseUrl}${contract.limitGroupsPath}`;
}

/** Ошибка HTTP-ответа Контур.Закупок. */
export class KonturHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`Контур.Закупки: HTTP ${status} для ${url}`);
    this.name = "KonturHttpError";
    this.status = status;
    this.url = url;
    this.body = body.slice(0, 2000);
  }
}

/**
 * 401/403 — ключ не принят. Повторять запрос бессмысленно: нужна реакция
 * администратора (ключ отозван, истёк срок ключа, не подключена группа методов).
 */
export class KonturAuthError extends KonturHttpError {
  constructor(status: number, url: string, body: string) {
    super(status, url, body);
    this.name = "KonturAuthError";
  }
}

/** 429 — исчерпан суточный лимит группы. Адаптер ждёт и повторяет. */
export class KonturRateLimitError extends KonturHttpError {
  /** Задержка из Retry-After, секунд (null — заголовок не передан). */
  readonly retryAfterSec: number | null;

  constructor(status: number, url: string, body: string, retryAfterSec: number | null) {
    super(status, url, body);
    this.name = "KonturRateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Ответ 200, но тело не JSON. Почти всегда означает, что путь эндпоинта не
 * совпал с реальным API и сервер отдал HTML-страницу (в том числе страницу
 * входа). Повторять такой запрос нельзя: он стоит денег и не изменит результат.
 */
export class KonturResponseParseError extends Error {
  constructor(
    readonly url: string,
    readonly snippet: string,
  ) {
    super(
      `Контур.Закупки: ответ не JSON для ${url} (первые 200 символов: ${snippet.slice(0, 200)}). ` +
        "Проверьте KONTUR_API_BASE_URL и пути эндпоинтов по docs/REFERENCE_KONTUR_API.md.",
    );
    this.name = "KonturResponseParseError";
  }
}

/** Строит ошибку по статусу ответа. */
export function konturErrorFromResponse(
  status: number,
  url: string,
  body: string,
  retryAfter: string | null,
): KonturHttpError {
  if (status === 401 || status === 403) {
    return new KonturAuthError(status, url, body);
  }
  if (status === 429) {
    const seconds = retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;
    return new KonturRateLimitError(
      status,
      url,
      body,
      Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    );
  }
  return new KonturHttpError(status, url, body);
}

/** Ответ, который повторять можно (429, 5xx и сетевые сбои). */
export function isRetryableKonturError(error: unknown): boolean {
  if (error instanceof KonturRateLimitError) return true;
  if (error instanceof KonturAuthError) return false;
  // Неверный путь или HTML вместо JSON — повтор не поможет, только потратит лимит.
  if (error instanceof KonturResponseParseError) return false;
  if (error instanceof KonturHttpError) return error.status >= 500;
  // Сетевые сбои (DNS, таймаут, обрыв соединения) — тоже повторяем.
  return error instanceof Error;
}
