/**
 * Адаптер источника «Контур.Закупки» (zakupki.kontur.ru).
 *
 * Работает ТОЛЬКО на сервере. Реализует общий порт TenderSourceAdapter,
 * поэтому UI и пайплайн анализа не знают, откуда пришла закупка.
 *
 * Контракт подтверждён спецификацией OpenAPI 3.0.4 «АПИ Закупок» и живым зондом
 * тестовым ключом (подробности — konturContract.ts и docs/REFERENCE_KONTUR_API.md).
 * Из него следуют четыре правила, которые адаптер и реализует:
 *
 *  1. **Каждый запрос стоит денег, и счётчик у каждой группы свой.** Выдача
 *     расходует группу `search`, карточка — группу `purchase`; превышение хотя
 *     бы на один запрос — ошибка. Поэтому cache-first: перед обращением к API
 *     проверяется кэш сырых ответов, а остаток лимита берётся из бесплатного
 *     `/limitGroups`, а не пересчитывается по нашему журналу.
 *  2. **Размер страницы и окно дат диктует API.** Страница всегда 50 закупок,
 *     нумерация с нуля, `DateTimeFrom`/`DateTimeTo` обязательны — без них поиск
 *     отвечает 400. С одним диапазоном дат отдаётся не больше 10 000 закупок.
 *  3. **Не больше пяти одновременных обращений на ключ** — слоты раздаёт
 *     семафор внутри адаптера.
 *  4. **Метода для документов нет.** Ссылки приходят полем `Docs` карточки,
 *     поэтому `fetchDocuments` читает ту же карточку и тот же ключ кэша:
 *     документы после карточки достаются бесплатно.
 *
 * Бесплатные эндпоинты (`/testpurchases/{id}`, `/limitGroups`) дневной бюджет
 * не расходуют и в нём не учитываются.
 */
import type { Tender, TenderDocument } from "@/domain/entities";
import type { TenderSourceAdapter } from "@/adapters/types";
import {
  KONTUR_KIND_LABELS,
  KONTUR_PROTOCOL,
  KonturAuthError,
  KonturRateLimitError,
  KonturResponseParseError,
  hasKonturApiKey,
  isBillableKonturKind,
  isRetryableKonturError,
  konturAuthHeaders,
  konturErrorFromResponse,
  konturLimitGroupsUrl,
  konturSearchUrl,
  konturTenderUrl,
  konturTestTenderUrl,
  resolveKonturContract,
  type KonturApiContract,
  type KonturBillableKind,
} from "@/adapters/tender-source/konturContract";
import {
  buildKonturSearchPayload,
  describeKonturBlur,
  extractKonturItems,
  extractKonturTotal,
  isRawRecord,
  konturCacheKey,
  konturCardDocumentRefs,
  matchesKonturLocalFilters,
  normalizeKonturDocuments,
  normalizeKonturLimitGroups,
  normalizeKonturSearchResults,
  normalizeKonturTender,
  type KonturBlurReport,
  type KonturBlurredField,
  type KonturCardDocumentRef,
  type KonturLimitGroupInfo,
  type KonturSearchQuery,
  type KonturSkipReason,
} from "@/adapters/tender-source/konturParser";
import {
  isEntryFresh,
  nullKonturStore,
  nullKonturUsageSink,
  type KonturRawResponseStore,
  type KonturRequestKind,
  type KonturUsageSink,
} from "@/adapters/tender-source/konturCache";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ключ не задан — интеграция не подключена. */
export class KonturNotConfiguredError extends Error {
  constructor() {
    super(
      "KONTUR_API_KEY не задан: ключ выдаётся в Кабинете Интегратора (integrations.kontur.ru) " +
        "после подключения тарифа",
    );
    this.name = "KonturNotConfiguredError";
  }
}

/**
 * Суточный лимит платных запросов исчерпан — свой (`dailyLimitPerMethod`) или
 * тарифной группы по данным `/external/v1/limitGroups`.
 *
 * Лимит у каждого метода свой (30 поисков и 30 карточек в сутки), поэтому
 * ошибка называет метод: «исчерпан лимит» без уточнения заставило бы оператора
 * думать, что закупки больше не читаются вовсе, хотя карточки ещё доступны.
 */
export class KonturDailyLimitError extends Error {
  constructor(
    readonly limit: number,
    readonly spent: number,
    readonly kind: KonturBillableKind | null = null,
  ) {
    const method = kind ? ` (${KONTUR_KIND_LABELS[kind]})` : "";
    super(
      `Исчерпан суточный лимит запросов Контур.Закупок${method}: ${spent} из ${limit}. ` +
        "Счётчик обновится в 00:00 следующих суток.",
    );
    this.name = "KonturDailyLimitError";
  }
}

export interface KonturAdapterOptions {
  contract?: KonturApiContract;
  fetchImpl?: typeof fetch;
  /** Время передаётся извне: домен и тесты не должны зависеть от Date.now(). */
  nowProvider?: () => string;
  rateLimitPerSec?: number;
  maxRetries?: number;
  /** Постоянный кэш сырых ответов (Supabase). По умолчанию — ничего не хранить. */
  store?: KonturRawResponseStore;
  /** Журнал расхода API. */
  usage?: KonturUsageSink;
  /**
   * Закупок на странице. API всегда отдаёт 50 (`KONTUR_PROTOCOL.pageSize`),
   * значение больше урезается. Меньше — можно, но только в тестах: иначе
   * условие остановки «страница неполная» сработает раньше конца выдачи.
   */
  pageSize?: number;
  /**
   * Сколько страниц выдачи снимать за один вызов fetchTenders. Каждая
   * страница — отдельный платный поиск, поэтому значение задаёт цену вызова:
   * 1 — один запрос на ключевое слово, 5 (по умолчанию) — до пяти.
   */
  maxPages?: number;
  /** TTL кэша поиска, сек. По умолчанию сутки. */
  searchTtlSec?: number;
  /** TTL кэша карточки, сек. По умолчанию неделя. */
  cardTtlSec?: number;
  /**
   * Насколько свежей должна быть карточка для проверки изменений, сек.
   * По умолчанию 15 минут: это самый частый запрос, а карточка стоит денег.
   */
  changesTtlSec?: number;
  /** TTL кэша остатка лимита, сек. По умолчанию 5 минут. */
  limitsTtlSec?: number;
  /** TTL кэша тестовой карточки, сек. Тестовые закупки не меняются. */
  testCardTtlSec?: number;
  /**
   * Дневной бюджет платных запросов на каждый метод. Тариф считает группы
   * `search` и `purchase` раздельно (боевой тариф с 24.09.2026 — 30 запросов в
   * сутки на метод), поэтому общий счётчик либо не давал бы потратить купленное,
   * либо пропускал бы превышение по одной из групп. null — без ограничения.
   * Настоящий остаток всё равно берётся из `fetchLimitGroups()`: этот бюджет —
   * страховка на случай, когда тариф прочитать не удалось.
   */
  dailyLimitPerMethod?: number | null;
  /** Сколько платных запросов каждого метода уже сделано сегодня. */
  requestsTodayByMethod?: Partial<Record<KonturBillableKind, number>>;
  /** Вызывается при 401/403: ключ отозван, истёк trial или не подключена группа. */
  onAuthError?: (error: KonturAuthError) => void;
}

/**
 * Сколько страниц выдачи (по 50 записей) снимать на один поиск по умолчанию.
 *
 * Каждая страница — отдельный платный запрос, поэтому потолок обязан быть
 * виден снаружи: API-роут ограничивает им тело запроса. Без этого обещание
 * «не больше трёх платных поисков на нажатие» расходилось бы с фактом —
 * профиль с фильтром региона заставляет адаптер листать выдачу, пока не
 * наберётся `limit` подходящих записей (см. «Регион и ОКПД2 фильтруются
 * локально» в docs/REFERENCE_KONTUR_API.md).
 */
export const KONTUR_MAX_PAGES_DEFAULT = 5;
const DAY_SEC = 86_400;
const WEEK_SEC = 604_800;
const CHANGES_TTL_SEC = 900;
const LIMITS_TTL_SEC = 300;
const TEST_CARD_TTL_SEC = 30 * DAY_SEC;
/** Через сколько миллисекунд повторно проверить свободный слот. */
const SLOT_POLL_MS = 25;

function parseJsonBody(text: string, url: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new KonturResponseParseError(url, trimmed);
  }
}

/** Внутренний ID закупки из идентификатора ТендерФит («kontur-32616401973»). */
function sourceIdOf(id: string): string {
  return id.startsWith("kontur-") ? id.slice("kontur-".length) : id;
}

export class KonturTenderSourceAdapter implements TenderSourceAdapter {
  private readonly contract: KonturApiContract;
  private readonly fetchImpl: typeof fetch;
  private readonly nowProvider: () => string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly store: KonturRawResponseStore;
  private readonly usageSink: KonturUsageSink;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly searchTtlSec: number;
  private readonly cardTtlSec: number;
  private readonly changesTtlSec: number;
  private readonly limitsTtlSec: number;
  private readonly testCardTtlSec: number;
  private readonly maxConcurrent: number;
  private readonly dailyLimitPerMethod: number | null;
  private readonly onAuthError?: (error: KonturAuthError) => void;

  private lastRequestAt = 0;
  private inFlight = 0;
  /** Расход по методам: у групп `search` и `purchase` счётчики независимые. */
  private readonly requestsByMethod: Record<KonturBillableKind, number>;
  private apiCalls = 0;
  /**
   * Ответы из кэша — только по платным видам запросов.
   *
   * Счётчик везде показывается рядом с числом платных запросов («Платных
   * запросов: 3 · из кэша: 3»), поэтому обязан означать «столько платных
   * обращений сэкономили». Бесплатные чтения остатка тарифа (`limits`) в него
   * не входят: живой прогон 24.09.2026 на проде дал три оплаченных поиска
   * и три бесплатных чтения тарифа из кэша, и прежний подсчёт печатал
   * «из кэша 3» напротив трёх реально списанных поисков — партнёр решал бы,
   * что поиски достались бесплатно. Суточная сводка в
   * `konturCacheRepository.summaryToday` фильтрует те же виды, значит оба
   * счётчика теперь означают одно.
   */
  private cacheHits = 0;
  private skipped: KonturSkipReason[] = [];
  private blurredFields = new Set<KonturBlurredField>();
  private blurredDocuments = 0;
  /** Закупки, которые источник вернул, а мы отсекли локальными фильтрами. */
  private filteredOut = 0;
  /** Сырые записи по номеру закупки — кладутся в tenders.raw_data. */
  private readonly rawItems = new Map<string, Record<string, unknown>>();

  constructor(options: KonturAdapterOptions = {}) {
    this.contract = options.contract ?? resolveKonturContract();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowProvider = options.nowProvider ?? (() => new Date().toISOString());
    this.minIntervalMs = 1000 / (options.rateLimitPerSec ?? 2);
    this.maxRetries = options.maxRetries ?? 3;
    this.store = options.store ?? nullKonturStore;
    this.usageSink = options.usage ?? nullKonturUsageSink;
    this.pageSize = Math.max(
      1,
      Math.min(options.pageSize ?? KONTUR_PROTOCOL.pageSize, KONTUR_PROTOCOL.pageSize),
    );
    this.maxPages = Math.max(1, options.maxPages ?? KONTUR_MAX_PAGES_DEFAULT);
    this.searchTtlSec = options.searchTtlSec ?? DAY_SEC;
    this.cardTtlSec = options.cardTtlSec ?? WEEK_SEC;
    this.changesTtlSec = options.changesTtlSec ?? CHANGES_TTL_SEC;
    this.limitsTtlSec = options.limitsTtlSec ?? LIMITS_TTL_SEC;
    this.testCardTtlSec = options.testCardTtlSec ?? TEST_CARD_TTL_SEC;
    this.maxConcurrent = Math.max(1, KONTUR_PROTOCOL.maxConcurrent);
    this.dailyLimitPerMethod = options.dailyLimitPerMethod ?? null;
    this.requestsByMethod = {
      search: options.requestsTodayByMethod?.search ?? 0,
      card: options.requestsTodayByMethod?.card ?? 0,
    };
    this.onAuthError = options.onAuthError;
  }

  /** Контракт точки подключения (без ключа в логах). */
  get contractSummary(): {
    baseUrl: string;
    configured: boolean;
    paths: {
      search: string;
      tender: string;
      testTender: string;
      limitGroups: string;
    };
  } {
    return {
      baseUrl: this.contract.baseUrl,
      configured: hasKonturApiKey(this.contract),
      paths: {
        search: this.contract.searchPath,
        tender: this.contract.tenderPath,
        testTender: this.contract.testTenderPath,
        limitGroups: this.contract.limitGroupsPath,
      },
    };
  }

  /**
   * Сколько платных запросов сделано этим экземпляром и сколько ответов взято
   * из кэша. `requestsToday` — сумма по методам для журнала, а решение о
   * превышении принимается по `requestsTodayByMethod`: группы тарифа независимы.
   */
  get counters(): {
    apiCalls: number;
    cacheHits: number;
    requestsToday: number;
    requestsTodayByMethod: Record<KonturBillableKind, number>;
  } {
    return {
      apiCalls: this.apiCalls,
      cacheHits: this.cacheHits,
      requestsToday: this.requestsByMethod.search + this.requestsByMethod.card,
      requestsTodayByMethod: { ...this.requestsByMethod },
    };
  }

  /**
   * Причины, по которым записи последнего поиска не стали закупками.
   * Ненулевое значение означает, что часть выдачи отброшена: `cancelled` и
   * `abandoned` — штатно, `no-deadline` и `no-number` — повод посмотреть
   * kontur_raw_responses.
   */
  get lastSkipped(): KonturSkipReason[] {
    return [...this.skipped];
  }

  /**
   * Какие поля источник отдал закрашенными. Непустой список означает, что ключ
   * тестовой: данные есть, но часть значений скрыта, и сохранять их как пустоту
   * молча нельзя — это нужно показать в журнале синхронизации.
   */
  get lastBlurred(): KonturBlurReport {
    return { fields: [...this.blurredFields].sort(), documents: this.blurredDocuments };
  }

  /**
   * Сколько закупок источник вернул, а адаптер отсек локальными фильтрами
   * (наименование региона и коды ОКПД2 — их API не принимает).
   *
   * Число обязательно нужно показывать: поиск уже оплачен, а часть выдачи
   * сознательно не сохранена. Без него «найдено 0» неотличимо от поломки.
   */
  get lastFilteredOut(): number {
    return this.filteredOut;
  }

  /**
   * Сырая запись источника по номеру закупки. Сохраняется в tenders.raw_data:
   * при уточнении разбора закупку можно пересобрать без нового запроса к
   * платному API.
   */
  getRaw(regNumber: string): Record<string, unknown> | null {
    return this.rawItems.get(regNumber) ?? null;
  }

  private assertConfigured(): void {
    if (!hasKonturApiKey(this.contract)) throw new KonturNotConfiguredError();
  }

  private assertBudget(kind: KonturRequestKind): void {
    if (!isBillableKonturKind(kind)) return;
    if (this.dailyLimitPerMethod === null) return;
    const spent = this.requestsByMethod[kind];
    if (spent >= this.dailyLimitPerMethod) {
      throw new KonturDailyLimitError(this.dailyLimitPerMethod, spent, kind);
    }
  }

  /** Простейший rate-limit: не чаще N запросов в секунду. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.lastRequestAt + this.minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /**
   * Свободный слот обращения к API. Между проверкой и занятостью слота нет
   * await, поэтому в однопоточной среде гонки нет.
   */
  private async acquireSlot(): Promise<() => void> {
    while (this.inFlight >= this.maxConcurrent) {
      await sleep(SLOT_POLL_MS);
    }
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
    };
  }

  private async recordUsage(
    kind: KonturRequestKind,
    url: string,
    status: number | null,
    fromCache: boolean,
    durationMs: number,
    error: string | null,
  ): Promise<void> {
    await this.usageSink.record({
      kind,
      url,
      status,
      fromCache,
      durationMs,
      at: this.nowProvider(),
      error,
    });
  }

  /** Кэш → API. Совпадение по ключу означает ноль расходов тарифа. */
  private async readThroughCache(
    kind: KonturRequestKind,
    url: string,
    method: "GET" | "POST",
    body: string | undefined,
    cacheKey: string,
    ttlSec: number,
  ): Promise<unknown> {
    const cached = await this.store.read(cacheKey);
    const now = this.nowProvider();
    if (cached && isEntryFresh(cached, ttlSec, now)) {
      // Экономия считается только по платным видам: бесплатный `limits` из кэша
      // не делает оплаченный поиск бесплатным (см. комментарий у `cacheHits`).
      if (isBillableKonturKind(kind)) this.cacheHits += 1;
      await this.recordUsage(kind, url, null, true, 0, null);
      return cached.payload;
    }
    return this.performRequest(kind, url, method, body, cacheKey);
  }

  private async performRequest(
    kind: KonturRequestKind,
    url: string,
    method: "GET" | "POST",
    body: string | undefined,
    cacheKey: string,
  ): Promise<unknown> {
    this.assertConfigured();
    this.assertBudget(kind);
    const release = await this.acquireSlot();
    try {
      return await this.attemptRequest(kind, url, method, body, cacheKey);
    } finally {
      release();
    }
  }

  private async attemptRequest(
    kind: KonturRequestKind,
    url: string,
    method: "GET" | "POST",
    body: string | undefined,
    cacheKey: string,
  ): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      const startedAt = Date.now();
      await this.throttle();
      if (isBillableKonturKind(kind)) {
        this.requestsByMethod[kind] += 1;
        this.apiCalls += 1;
      }
      let status: number | null = null;
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...konturAuthHeaders(this.contract),
          },
          body: method === "POST" ? body : undefined,
        });
        const text = await response.text();
        status = response.status;
        if (!response.ok) {
          const retryAfter =
            typeof response.headers?.get === "function"
              ? response.headers.get("Retry-After")
              : null;
          throw konturErrorFromResponse(response.status, url, text, retryAfter);
        }
        const payload = parseJsonBody(text, url);
        await this.recordUsage(kind, url, status, false, Date.now() - startedAt, null);
        await this.store.write({
          cacheKey,
          kind,
          url,
          method,
          status,
          payload,
          requestBody: body ? parseJsonBody(body, url) : null,
        });
        return payload;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        await this.recordUsage(kind, url, status, false, durationMs, message);
        // 401/403 повторяют бессмысленно: сообщаем наверх и выходим.
        if (error instanceof KonturAuthError) {
          this.onAuthError?.(error);
          throw error;
        }
        attempt += 1;
        if (!isRetryableKonturError(error) || attempt > this.maxRetries) throw error;
        const retryAfterSec =
          error instanceof KonturRateLimitError ? error.retryAfterSec : null;
        await sleep(retryAfterSec ? retryAfterSec * 1000 : 300 * 2 ** attempt);
      }
    }
  }

  private collectBlur(raw: unknown): void {
    const blur = describeKonturBlur(raw);
    for (const field of blur.fields) this.blurredFields.add(field);
    this.blurredDocuments += blur.documents;
  }

  /**
   * Поиск закупок. Один широкий запрос на страницу (50 записей) вместо
   * множества узких: каждый запрос стоит денег.
   *
   * Момент «сейчас» фиксируется один раз на весь обход страниц. Иначе окно
   * публикации и `ApplicationDeadlineFrom` на второй странице отличались бы от
   * первой, выдача сдвинулась бы под ногами, а ключ кэша перестал бы совпадать
   * для одного и того же логического запроса.
   *
   * Наименования регионов и коды ОКПД2 в теле запроса не участвуют — API их не
   * принимает, поэтому они применяются к полученной выдаче
   * (`matchesKonturLocalFilters`). `limit` из-за этого означает «сколько
   * подходящих закупок нужно», а не «сколько записей прочитать»: обход страниц
   * продолжается, пока не наберётся нужное число или не кончится `maxPages`.
   */
  async fetchTenders(query: KonturSearchQuery): Promise<Tender[]> {
    const now = this.nowProvider();
    const limit = query.limit ?? Number.POSITIVE_INFINITY;
    // Больше 10 000 закупок с одного диапазона дат API не отдаёт в принципе.
    const reachable = Math.min(this.maxPages * this.pageSize, KONTUR_PROTOCOL.maxPerDateRange);
    const collected = new Map<string, Tender>();
    this.skipped = [];
    this.blurredFields = new Set();
    this.blurredDocuments = 0;
    this.filteredOut = 0;

    for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
      const payload = buildKonturSearchPayload(query, { pageNumber, now });
      const cacheKey = konturCacheKey("search", payload);
      const raw = await this.readThroughCache(
        "search",
        konturSearchUrl(this.contract),
        "POST",
        JSON.stringify(payload),
        cacheKey,
        this.searchTtlSec,
      );

      const result = normalizeKonturSearchResults(raw, now);
      this.skipped.push(...result.skipped);
      for (const field of result.blurredFields) this.blurredFields.add(field);
      this.blurredDocuments += result.blurredDocuments;

      for (const tender of result.tenders) {
        // Регион и ОКПД2 источник не фильтрует: отсеиваем выдачу сами, иначе
        // профиль с заданным субъектом молча соберёт закупки со всей России.
        if (!matchesKonturLocalFilters(tender, query)) {
          this.filteredOut += 1;
          continue;
        }
        if (!collected.has(tender.regNumber)) collected.set(tender.regNumber, tender);
        const item = result.rawByRegNumber[tender.regNumber];
        if (isRawRecord(item)) this.rawItems.set(tender.regNumber, item);
      }

      const items = extractKonturItems(raw).length;
      if (collected.size >= limit) break;
      // Неполная страница — выдача закончилась.
      if (items < this.pageSize) break;
      const reached = (pageNumber + 1) * this.pageSize;
      if (reached >= reachable) break;
      const total = extractKonturTotal(raw);
      if (total !== null && reached >= total) break;
    }

    return [...collected.values()].slice(0, Number.isFinite(limit) ? limit : undefined);
  }

  /**
   * Карточка закупки по внутреннему идентификатору Контур.Закупок.
   * Тот же ответ и тот же ключ кэша используют `fetchDocuments` и
   * `checkChanges`, поэтому карточка оплачивается один раз.
   */
  private async readCard(sourceId: string, ttlSec: number): Promise<unknown> {
    const url = konturTenderUrl(this.contract, sourceId);
    const cacheKey = konturCacheKey("card", { id: sourceId });
    return this.readThroughCache("card", url, "GET", undefined, cacheKey, ttlSec);
  }

  /**
   * Карточка закупки. В путь подставляется идентификатор, который передал
   * вызывающий код: для сохранённых закупок это externalId (внутренний ID
   * Контур.Закупок), иначе — номер извещения.
   */
  async fetchTenderById(id: string): Promise<Tender | null> {
    const sourceId = sourceIdOf(id);
    if (!sourceId) return null;
    const raw = await this.readCard(sourceId, this.cardTtlSec);
    this.collectBlur(raw);
    const { tender } = normalizeKonturTender(raw, this.nowProvider());
    if (tender && isRawRecord(raw)) this.rawItems.set(tender.regNumber, raw);
    return tender;
  }

  /**
   * Документы закупки. Отдельного метода у API нет: ссылки лежат в `Docs`
   * карточки, поэтому читается она же — из кэша, если карточка уже загружена.
   */
  async fetchDocuments(tenderId: string): Promise<TenderDocument[]> {
    const sourceId = sourceIdOf(tenderId);
    if (!sourceId) return [];
    const raw = await this.readCard(sourceId, this.cardTtlSec);
    this.collectBlur(raw);
    return normalizeKonturDocuments(raw, `kontur-${sourceId}`);
  }

  /**
   * Документы карточки списком: имена всегда, ссылка — только если тариф её
   * отдаёт. Читает ту же карточку и тот же ключ кэша, что `fetchDocuments`,
   * поэтому повторный вызов бесплатный.
   *
   * Метод нужен там, где важно показать файл, который нельзя скачать: на
   * пониженном тарифе источник закрашивает `Docs[].Url`, и без списка имён
   * закупка выглядела бы вовсе без документации, хотя заказчик её выложил.
   * Боевой тариф (проверено 24.09.2026) отдаёт и имена, и настоящие ссылки.
   */
  async fetchCardDocumentList(tenderId: string): Promise<KonturCardDocumentRef[]> {
    const sourceId = sourceIdOf(tenderId);
    if (!sourceId) return [];
    const raw = await this.readCard(sourceId, this.cardTtlSec);
    this.collectBlur(raw);
    return konturCardDocumentRefs(raw);
  }

  /**
   * Изменилась ли закупка с указанной даты. Читает ту же карточку, но требует
   * более свежую (15 минут вместо недели): это самый частый запрос, а карточка
   * стоит денег.
   *
   * Осторожно с пониженным тарифом: поле `UpdatedDatetime` он закрашивает, и
   * тогда дата обновления берётся из даты публикации — проверка будет отвечать
   * «изменений нет». Признак закрашенности виден в `lastBlurred`.
   */
  async checkChanges(tenderId: string, since: string): Promise<boolean> {
    const sourceId = sourceIdOf(tenderId);
    if (!sourceId) return false;
    const raw = await this.readCard(sourceId, this.changesTtlSec);
    const { tender } = normalizeKonturTender(raw, this.nowProvider());
    if (!tender) return false;
    return tender.deadlines.lastUpdateDate > since;
  }

  /**
   * Карточка из бесплатного тестового набора `/external/v1/testpurchases/{id}`.
   * Суточный лимит не расходует и значения не закрашивает, но работает только
   * для id из спецификации. Нужен для разработки и проверки разбора на реальных
   * ответах без списаний; в боевой синхронизации не используется.
   */
  async fetchTestTenderById(id: string): Promise<Tender | null> {
    const sourceId = sourceIdOf(id);
    if (!sourceId) return null;
    const url = konturTestTenderUrl(this.contract, sourceId);
    const cacheKey = konturCacheKey("testcard", { id: sourceId });
    const raw = await this.readThroughCache(
      "testcard",
      url,
      "GET",
      undefined,
      cacheKey,
      this.testCardTtlSec,
    );
    const { tender } = normalizeKonturTender(raw, this.nowProvider());
    return tender;
  }

  /**
   * Остаток суточного лимита по группам тарифа. Запрос бесплатный, поэтому
   * остаток всегда берётся отсюда, а не пересчитывается по нашему журналу:
   * счётчик Контур.Закупок — единственный авторитет.
   *
   * `force` — читать у источника, минуя кэш. Нужно после синхронизации:
   * кэшированное значение показало бы остаток до неё.
   */
  async fetchLimitGroups(force = false): Promise<KonturLimitGroupInfo[]> {
    const url = konturLimitGroupsUrl(this.contract);
    const cacheKey = konturCacheKey("limits", { path: this.contract.limitGroupsPath });
    const raw = await this.readThroughCache(
      "limits",
      url,
      "GET",
      undefined,
      cacheKey,
      // TTL 0 — запись никогда не считается свежей, запрос уходит в сеть.
      force ? 0 : this.limitsTtlSec,
    );
    return normalizeKonturLimitGroups(raw);
  }
}
