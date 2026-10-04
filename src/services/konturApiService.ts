import type {
  KonturBlurredField,
  KonturLimitGroupInfo,
} from "@/adapters/tender-source/konturParser";
import type { ApiUsageLogRow, ApiUsageSummary, TenderLaw } from "@/types/database";

/**
 * Клиентский сервис Контур.Закупок: обращение к API-роутам приложения.
 *
 * Сами запросы к платному API выполняет сервер (см. src/services/konturSyncService.ts);
 * здесь только транспорт и типы ответов, чтобы компонент не знал ни путей
 * эндпоинтов Контур.Закупок, ни ключа.
 */

/**
 * Платный метод Контур.Закупок. Повторяет `KonturBillableKind` сервера:
 * клиент не импортирует серверные модули, а форма ответа роута обязана совпадать.
 */
export type KonturBillableMethod = "search" | "card";

/** Остаток по тарифу. Повторяет `KonturTariffInfo` сервера: клиент его не импортирует. */
export interface KonturTariffPayload {
  groups: KonturLimitGroupInfo[];
  /** Минимальный остаток среди групп, которые расходует синхронизация. */
  available: number | null;
  /** Группа, которая кончится первой. */
  tightest: KonturLimitGroupInfo | null;
  /** Самая ранняя дата окончания подписки. */
  subscriptionEnd: string | null;
}

/** Сводка расхода платного API — ответ GET /api/kontur/usage. */
export interface KonturUsageResponse {
  /** Задан ли KONTUR_API_KEY на сервере. */
  configured: boolean;
  baseUrl: string;
  /** Пути эндпоинтов: их видно в журнале, чтобы расхождение было заметно. */
  paths: { search: string; tender: string; testTender: string; limitGroups: string };
  /** Суточный бюджет на каждый метод из KONTUR_DAILY_REQUEST_LIMIT; null — без ограничения. */
  dailyRequestLimit: number | null;
  /** Платных запросов сегодня всего (поиск и карточки). */
  spentToday: number;
  /** Расход по методам: группы тарифа `search` и `purchase` независимы. */
  spentTodayByMethod: Record<KonturBillableMethod, number>;
  /** Остаток по самому узкому методу; null — бюджет не ограничен. */
  remainingToday: number | null;
  /** Остаток по каждому методу; null — бюджет не ограничен. */
  remainingTodayByMethod: Record<KonturBillableMethod, number | null>;
  summary: ApiUsageSummary;
  recent: ApiUsageLogRow[];
  /** Сколько сырых ответов лежит в кэше и может быть использовано без API. */
  storedResponses: number;
  /** Остаток по тарифным группам; null — ключ не задан или тариф не прочитан. */
  tariff: KonturTariffPayload | null;
  /** Почему тариф не прочитан. Журнал при этом показывается. */
  tariffError: string | null;
}

export interface KonturSyncRequest {
  laws: TenderLaw[];
  /** Каждое ключевое слово — отдельный поиск на стороне сервера. */
  keywords?: string[];
  excludeKeywords?: string[];
  regions?: string[];
  customerInns?: string[];
  okpd2Codes?: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
  limit?: number;
  /**
   * Сколько страниц выдачи (по 50 записей) снимать на одно ключевое слово.
   * Каждая страница — отдельный платный поиск, поэтому кнопка на дашборде
   * просит одну: расход обязан совпадать с тем, что показано до подтверждения.
   * Не задано — сервер берёт значение по умолчанию (5).
   */
  maxPages?: number;
  saveDocuments?: boolean;
  /**
   * Поставить найденные закупки в очередь на документацию.
   *
   * Кнопка на дашборде просит это явно: файлы лежат в хранилище ЕИС, которое не
   * отвечает зарубежным адресам, поэтому скачивает их воркер на сервере в России.
   * Не попросить — значит получить закупки без документации и без объяснения.
   */
  queueDocuments?: boolean;
}

/**
 * Что очередь заданий сделала с документацией найденных закупок.
 *
 * Повторяет `DocumentsQueueOutcome` сервера: клиент не импортирует серверные
 * модули, а форма ответа роута обязана совпадать.
 */
export interface KonturDocumentsQueue {
  /** Сколько закупок попало в задание. 0 — ставить было нечего или очередь отказала. */
  queued: number;
  /** Идентификатор задания очереди; null — задание не создано. */
  jobId: string | null;
  /** Равное задание уже стояло в очереди: новое не создавалось. */
  deduped: boolean;
  /** Почему документация не поставлена; null — поставлена. */
  error: string | null;
}

/** Результат синхронизации — ответ POST /api/kontur/sync. */
export interface KonturSyncResponse {
  synced: number;
  created: number;
  updated: number;
  /**
   * Закупки уже были в базе от более авторитетного источника — порядок
   * площадок задаёт каталог `src/domain/sources.ts`. Контур такие строки не
   * перезаписывает.
   */
  duplicates: number;
  documents: number;
  /** Причины отброшенных записей: признак расхождения схемы ответа. */
  skipped: string[];
  /** Сколько закупок источник вернул, но отсекли фильтры региона и ОКПД2. */
  filteredOut: number;
  apiCalls: number;
  cacheHits: number;
  requestsToday: number;
  usage: ApiUsageSummary;
  documentsError: string | null;
  /**
   * Документация найденных закупок в очереди воркера.
   *
   * null — прогон её не просил (`queueDocuments` не передан): так ведёт себя
   * панель администратора, которая проверяет ключ и парсер, а не пополняет ленту.
   * Кнопка на дашборде просит всегда, поэтому для неё null означает, что ответ
   * пришёл от прежней версии сервера, и обещать документацию нельзя.
   */
  documentsQueue: KonturDocumentsQueue | null;
  /** Что скрыл тестовый ключ. Непустой список — закупки сохранены с пустотами. */
  blurredFields: KonturBlurredField[];
  /** Документы, у которых закрашена ссылка: скачать их нельзя. */
  blurredDocuments: number;
  /** Остаток платных запросов по тарифу после синхронизации. */
  availableRequests: number | null;
  /** Сколько поисков выполнил сервер (по числу ключевых слов). */
  searches: number;
  /** Ошибки отдельных поисков: часть закупок при этом могла сохраниться. */
  errors: string[];
}

/** Текст ошибки из ответа роута; если тело не JSON — статус запроса. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    // Тело не JSON (например, страница входа прокси) — оставляем статус.
    return fallback;
  }
}

export const konturApiService = {
  async getUsage(limit = 50): Promise<KonturUsageResponse> {
    const res = await fetch(`/api/kontur/usage?limit=${limit}`);
    if (!res.ok) {
      throw new Error(await errorMessage(res, `Не удалось получить расход API: HTTP ${res.status}`));
    }
    return (await res.json()) as KonturUsageResponse;
  },

  async sync(request: KonturSyncRequest): Promise<KonturSyncResponse> {
    const res = await fetch("/api/kontur/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new Error(await errorMessage(res, `Синхронизация не выполнена: HTTP ${res.status}`));
    }
    return (await res.json()) as KonturSyncResponse;
  },
};
