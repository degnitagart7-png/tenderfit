/**
 * Адаптер источника данных «ЭТП ГПБ» (etpgpb.ru, площадка Газпромбанка: «Закупки.Газпром»,
 * корпоративные и коммерческие заказчики, ЭТП Клик).
 *
 * Работает ТОЛЬКО на сервере (Node). Ключа и входа не требует: карточки процедур и карта
 * сайта публичны. Но площадка — единственная из подключённых, у которой роботу НЕЧЕМ
 * искать: `robots.txt` запрещает любой адрес с query-строкой (`Disallow: /*?`), а поиск и
 * внутренний JSON API (`/api/v2/procedures/?…`) без неё не работают. Поэтому адаптер
 * устроен иначе остальных, и каждое отличие — следствие правил площадки, а не вкуса.
 *
 * Пять особенностей, из-за которых адаптер устроен именно так:
 *
 * 1. **Только четыре вида адресов** (`etpgpbUrl.ts`): индекс карты сайта, список её
 *    кусков по процедурам, сами куски и карточки `/procedures/<вид>/<id>-<slug>/` без
 *    query-строки. Любой запрос проходит `assertEtpgpbUrlAllowed`, редиректы не
 *    выполняются вслепую: каждый шаг проверяется тем же правилом. Хосты `etp.gpb.ru` и
 *    `com.etpgpb.ru` закрыты целиком, туда адаптер не ходит никогда.
 *
 * 2. **Процедуры находятся по карте сайта, а не поиском.** Кусок карты — ~20 600 адресов
 *    и 4,7 МБ, а по дате изменения в окно просмотра попадает до двух-трёх десятков кусков
 *    (25 из 60 на 19.10.2026). Берутся куски и записи с `<lastmod>` не старше
 *    окна просмотра (21 день), без продажи имущества (`sale`), самые свежие первыми.
 *    Карта скачивается один раз за жизнь адаптера (прогон вызывает `fetchTenders` по разу на
 *    профиль, и все вызовы делят одну загрузку), а между прогонами куски не перекачиваются,
 *    пока их `<lastmod>` не изменился (`etpgpbCache.ts`).
 *
 * 3. **Ключевые слова — по slug адреса, потом по названию.** Slug — транслит названия: слово
 *    профиля, переведённое в тот же транслит, отсекает почти всё лишнее до запроса
 *    карточки; после чтения карточки слово проверяется по настоящему названию
 *    (`etpgpbKeywords.ts`). Остальные отборы — закон, цена, регион, ИНН — идут по уже
 *    прочитанной карточке, потому что в адресе их нет.
 *
 * 4. **Карточки — дорогие, и расход ограничен дважды.** Один запрос в секунду; не больше
 *    `maxCardsPerCall` настоящих запросов карточек на вызов (40) и `maxCardsPerRun` на жизнь
 *    адаптера (250). Карточка, прочитанная раньше и не менявшаяся по `<lastmod>`, берётся из
 *    кэша на диске без запроса и бюджет не тратит. Предел не молчит: число неосмотренных
 *    процедур попадает в `filterStats`, и прогон печатает его в журнале.
 *
 * 5. **Документов нет.** Ссылки на файлы ведут на `etp.gpb.ru/file/get/…` (закрыт
 *    `robots.txt`), поэтому `fetchDocuments` возвращает пустой список и не делает
 *    запроса. Причина — в каталоге источников (`src/domain/sources.ts`).
 *
 * Площадка может ограничить доступ (HTTP 403, повторные 429, страница защиты вместо
 * карточки). Обход защиты не делаем: после первого такого ответа запросы адаптера к
 * площадке прекращаются до конца жизни адаптера, а уже собранное возвращается с
 * пометкой в `filterStats.blocked`.
 *
 * Личных данных адаптер не видит: разбор карточки строится из белого списка полей и
 * контактов не выпускает (`etpgpbCard.ts`).
 */
import type { Tender, TenderDocument } from "@/domain/entities";
import { isPriceKnown, isRegionKnown } from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";
import type { TenderSourceAdapter, TenderSourceQuery } from "@/adapters/types";
import {
  buildEtpgpbKeywordGroups,
  etpgpbSlugMatches,
  etpgpbTitleMatches,
  type EtpgpbKeywordGroup,
} from "@/adapters/tender-source/etpgpbKeywords";
import { isEtpgpbCardPage, parseEtpgpbCard } from "@/adapters/tender-source/etpgpbCard";
import { etpgpbIsAccepting, mapEtpgpbCard } from "@/adapters/tender-source/etpgpbMapper";
import {
  createEtpgpbCardCache,
  createEtpgpbSitemapCache,
  type CardRecord,
  type EtpgpbCardCache,
  type EtpgpbSitemapCache,
} from "@/adapters/tender-source/etpgpbCache";
import {
  DAY_MS,
  ETPGPB_DEFAULT_LOOKBACK_DAYS,
  ETPGPB_EXCLUDED_KINDS,
  findProceduresSitemapUrl,
  parseChunkEntries,
  parseProcedureChunks,
  selectChunks,
  selectEntries,
  type EtpgpbSitemapEntry,
} from "@/adapters/tender-source/etpgpbSitemap";
import {
  ETPGPB_SITEMAP_INDEX_URL,
  assertEtpgpbUrlAllowed,
  parseEtpgpbCardUrl,
} from "@/adapters/tender-source/etpgpbUrl";

/** Задержка первого повтора; каждый следующий вдвое дольше. */
const RETRY_BACKOFF_MS = 300;
/** Потолок паузы по `Retry-After`: площадка просит подождать, но прогон не стоит часами. */
const MAX_RETRY_AFTER_MS = 30_000;
/** Сколько редиректов за один запрос; каждый шаг проверяется тем же правилом, что и сам запрос. */
const MAX_REDIRECTS = 3;
/** Срок жизни прочитанной карточки в кэше по умолчанию: трое суток. */
export const ETPGPB_CARD_TTL_MS = 3 * DAY_MS;
/** Сколько карта сайта держится в памяти адаптера. Прогон живёт минуты; предел — для долгоживущего процесса. */
const SITEMAP_MEMO_TTL_MS = 30 * 60_000;

/**
 * Заголовки обычного браузерного GET, те же, что у адаптеров Сбербанк-АСТ, Росэлторга и
 * Фабриканта: добавлять непроверенное значит рисковать рабочим запросом ради
 * правдоподобия.
 */
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9",
};

/**
 * Признаки страницы защиты вместо содержимого: капча и заглушки провайдеров. Русские
 * формулировки вроде «доступ ограничен» намеренно не ищутся: так площадка может
 * ответить и про одну процедуру, а не про робота, и из-за неё не стоит прекращать
 * весь прогон.
 */
const PROTECTION_PAGE = /captcha|капча|are you a robot|ddos-guard|attention required/i;

/** Площадка ответила не тем: HTTP-код ошибки, пустое тело или чужая страница. */
export class EtpgpbResponseError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "EtpgpbResponseError";
  }
}

/** Площадка ограничила доступ: дальше запросов нет — обход защиты не делаем. */
export class EtpgpbBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtpgpbBlockedError";
  }
}

/** Причина, по которой процедура не попала в выдачу. */
type Rejection =
  | "не закупка поставщика"
  | "карточка не разобрана"
  | "название не подходит под слово"
  | "приём заявок не идёт"
  | "срок приёма заявок не указан"
  | "срок приёма заявок истёк"
  | "закон"
  | "цена"
  | "регион"
  | "регион не определён"
  | "заказчик";

export interface EtpgpbFilterStats {
  /** Откуда взята карта сайта в этом вызове и что с ней было. */
  readonly sitemap: {
    readonly source: "сеть" | "память" | "нет";
    /** Кусков выбрано по дате. */
    readonly chunks: number;
    /** Кусков, подошедших по дате, но не взятых из-за потолка `maxChunks`. */
    readonly skipped: number;
    readonly downloaded: number;
    readonly cached: number;
    /** Куски, которые не скачались и взяты из кэша прошлых прогонов. */
    readonly stale: number;
    readonly failed: number;
    /** Записей карты после отбора по окну и виду. */
    readonly entries: number;
  };
  /** Процедур в окне просмотра. */
  readonly window: number;
  /** Из них подошли по slug к словам профиля. */
  readonly candidates: number;
  /** Настоящих запросов карточек. */
  readonly fetched: number;
  /** Карточек из кэша на диске: запроса нет. */
  readonly cached: number;
  /** Карточек, уже прочитанных этим прогоном для другого профиля. */
  readonly memoized: number;
  /** Процедур, не осмотренных из-за предела запросов карточек. */
  readonly deferred: number;
  /** Карточек, на которых запрос не прошёл. */
  readonly failed: number;
  /** Закупок в выдаче после отбора и обрезки по `limit`. */
  readonly kept: number;
  readonly rejected: Readonly<Record<string, number>>;
  /** Какой предел запросов карточек достигнут; null — ни один. */
  readonly budgetReached: "на вызов" | "на прогон" | null;
  /** Площадка ограничила доступ: текст причины; null — нет. */
  readonly blocked: string | null;
}

function emptyStats() {
  return {
    sitemap: { source: "нет" as "сеть" | "память" | "нет", chunks: 0, skipped: 0, downloaded: 0, cached: 0, stale: 0, failed: 0, entries: 0 },
    window: 0,
    candidates: 0,
    fetched: 0,
    cached: 0,
    memoized: 0,
    deferred: 0,
    failed: 0,
    kept: 0,
    rejected: {} as Record<string, number>,
    budgetReached: null as "на вызов" | "на прогон" | null,
    blocked: null as string | null,
  };
}

/** Срок жизни карточки в кэше из `SYNC_ETPGPB_CARD_TTL_HOURS`: не задан или не число — трое суток; 0 — не использовать кэш. */
export function etpgpbCardTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return ETPGPB_CARD_TTL_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return ETPGPB_CARD_TTL_MS;
  return Math.round(hours * 60 * 60 * 1000);
}

export interface EtpgpbAdapterOptions {
  /**
   * Пауза между запросами, мс. По умолчанию и по правилам проекта — 1000 (один запрос в
   * секунду). Меньшее значение нужно только тестам; боевая фабрика его не задаёт.
   */
  minIntervalMs?: number;
  /** Максимум повторов при сбое транспорта, HTTP 5xx/429 или ответе не тем форматом. */
  maxRetries?: number;
  /** Таймаут запроса карточки. */
  timeoutMs?: number;
  /** Таймаут запроса карты сайта: кусок — до 5 МБ. */
  sitemapTimeoutMs?: number;
  /** Окно просмотра, дней: процедуры и куски карты с `<lastmod>` не старше. */
  lookbackDays?: number;
  /** Потолок числа кусков карты за скачивание. */
  maxChunks?: number;
  /** Потолок настоящих запросов карточек на один вызов `fetchTenders`. */
  maxCardsPerCall?: number;
  /** Потолок настоящих запросов карточек на жизнь адаптера (прогон). */
  maxCardsPerRun?: number;
  /** Оставлять только закупки, у которых идёт приём заявок и срок в будущем. */
  activeOnly?: boolean;
  /** Виды процедур, которые не берём. По умолчанию — продажа имущества. */
  excludeKinds?: readonly string[];
  /** Каталог файлов кэша; не задан — кэш только в памяти. */
  cacheDir?: string | null;
  /** Срок жизни карточки в кэше, мс; 0 — кэш карточек не используется. */
  cardTtlMs?: number;
  /** Источник текущего времени (для детерминированных тестов). */
  nowProvider?: () => Date;
  fetchImpl?: typeof fetch;
  /** Ожидание (пауза между запросами и повторами); для тестов. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function count(target: Record<string, number>, reason: Rejection): void {
  target[reason] = (target[reason] ?? 0) + 1;
}

interface PreparedFilters {
  readonly laws: readonly TenderLaw[];
  readonly regions: readonly string[];
  readonly customerInns: readonly string[];
  readonly minPrice: number | null;
  readonly maxPrice: number | null;
}

function prepareFilters(query: TenderSourceQuery): PreparedFilters {
  return {
    laws: query.laws,
    regions: (query.regions ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    customerInns: (query.customerInns ?? []).map((value) => value.trim()).filter(Boolean),
    minPrice: query.minPrice ?? null,
    maxPrice: query.maxPrice ?? null,
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export class EtpgpbTenderSourceAdapter implements TenderSourceAdapter {
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sitemapTimeoutMs: number;
  private readonly lookbackMs: number;
  private readonly maxChunks: number;
  private maxCardsPerCall: number;
  private maxCardsPerRun: number;
  private readonly activeOnly: boolean;
  private readonly excludeKinds: readonly string[];
  private readonly cardTtlMs: number;
  private readonly nowProvider: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sitemapCache: EtpgpbSitemapCache;
  private readonly cardCache: EtpgpbCardCache;

  /** Ближайший свободный момент для запроса, мс: простая очередь, безопасная и при параллельных вызовах. */
  private nextSlotAt = 0;
  /** Настоящих запросов карточек за жизнь адаптера. */
  private cardRequests = 0;
  /** После ограничения доступа площадкой запросов нет вовсе. */
  private blocked: EtpgpbBlockedError | null = null;
  /** Карта сайта на время прогона: один вызов на профиль, а загрузка одна. */
  private sitemapMemo: { at: number; entries: Promise<LoadedSitemap> } | null = null;
  /** Карточки, прочитанные этим прогоном: ключ — адрес, запись годится при том же `<lastmod>`. */
  private readonly cardMemo = new Map<string, CardRecord>();
  /** Номера и ключи прочитанных закупок → адрес карточки: для `fetchTenderById`. */
  private readonly urlByKey = new Map<string, string>();
  private stats = emptyStats();

  constructor(options: EtpgpbAdapterOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sitemapTimeoutMs = options.sitemapTimeoutMs ?? 90_000;
    this.lookbackMs = (options.lookbackDays ?? ETPGPB_DEFAULT_LOOKBACK_DAYS) * DAY_MS;
    this.maxChunks = options.maxChunks ?? 30;
    this.maxCardsPerCall = options.maxCardsPerCall ?? 40;
    this.maxCardsPerRun = options.maxCardsPerRun ?? 250;
    this.activeOnly = options.activeOnly ?? true;
    this.excludeKinds = options.excludeKinds ?? ETPGPB_EXCLUDED_KINDS;
    this.cardTtlMs = options.cardTtlMs ?? ETPGPB_CARD_TTL_MS;
    this.nowProvider = options.nowProvider ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? defaultSleep;
    const dir = options.cacheDir ?? null;
    this.sitemapCache = createEtpgpbSitemapCache(dir);
    this.cardCache = createEtpgpbCardCache({
      dir,
      // В файле запись живёт вдвое дольше срока годности: файл не пухнет, а решает «свежо ли» не он.
      retainMs: Math.max(this.cardTtlMs * 2, 24 * 60 * 60 * 1000),
    });
  }

  /**
   * Меняет потолки запросов карточек. Нужен живому поиску: человек ждёт ответа, и сорока
   * секунд чтения карточек ему не нужно. Значение, не являющееся положительным числом,
   * не меняет ничего.
   */
  configureBudgets(budgets: { perCall?: number; perRun?: number }): void {
    if (budgets.perCall !== undefined && Number.isFinite(budgets.perCall) && budgets.perCall > 0) {
      this.maxCardsPerCall = Math.floor(budgets.perCall);
    }
    if (budgets.perRun !== undefined && Number.isFinite(budgets.perRun) && budgets.perRun > 0) {
      this.maxCardsPerRun = Math.floor(budgets.perRun);
    }
  }

  /** Итог последнего вызова `fetchTenders` — для честной строки в журнале прогона. */
  get filterStats(): EtpgpbFilterStats {
    return {
      sitemap: { ...this.stats.sitemap },
      window: this.stats.window,
      candidates: this.stats.candidates,
      fetched: this.stats.fetched,
      cached: this.stats.cached,
      memoized: this.stats.memoized,
      deferred: this.stats.deferred,
      failed: this.stats.failed,
      kept: this.stats.kept,
      rejected: { ...this.stats.rejected },
      budgetReached: this.stats.budgetReached,
      blocked: this.stats.blocked,
    };
  }

  /** Сколько настоящих запросов карточек сделано за жизнь адаптера. */
  get cardRequestsMade(): number {
    return this.cardRequests;
  }

  /** Записать кэши на диск. Вызывается в конце `fetchTenders`; сбой записи на результат не влияет. */
  flushCaches(): void {
    const nowMs = this.nowProvider().getTime();
    this.cardCache.flush(nowMs);
    this.sitemapCache.flush(nowMs);
  }

  /* ============================== сеть ============================== */

  /** Не чаще одного запроса за `minIntervalMs`; очередь слотов безопасна и при параллельных вызовах. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    const wait = slot - now;
    if (wait > 0) await this.sleep(wait);
  }

  private block(message: string): EtpgpbBlockedError {
    const error = new EtpgpbBlockedError(`ЭТП ГПБ ограничила доступ: ${message}. Запросы к площадке в этом прогоне прекращены.`);
    this.blocked = error;
    return error;
  }

  /**
   * Один запрос с повторами, проверкой адреса и ручным разбором редиректов.
   *
   * Повторяются сбой транспорта, HTTP 5xx и 429 (с паузой по `Retry-After`) и ответ не
   * тем форматом. НЕ повторяются: 403 и 401 — это защита площадки, и дальше запросов
   * нет вовсе (`EtpgpbBlockedError`); 404 и 410 — процедуры нет (`EtpgpbResponseError`
   * со статусом, решает вызывающий). Страница с признаками капчи вместо содержимого —
   * тоже ограничение доступа, а не повод повторять.
   */
  private async requestText(
    url: string,
    what: string,
    options: { timeoutMs: number; looksRight: (text: string) => boolean },
  ): Promise<string> {
    if (this.blocked !== null) throw this.blocked;
    let current = url;
    let redirects = 0;
    let attempt = 0;
    for (;;) {
      // Каждый шаг, включая переход по редиректу, — через проверку адреса.
      assertEtpgpbUrlAllowed(current);
      await this.throttle();
      if (this.blocked !== null) throw this.blocked;

      let response: Response;
      try {
        response = await this.fetchImpl(current, {
          headers: { ...REQUEST_HEADERS },
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        if (attempt >= this.maxRetries) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new EtpgpbResponseError(`ЭТП ГПБ не ответила на запрос «${what}» (${current}): ${reason}.`);
        }
        attempt += 1;
        await this.sleep(RETRY_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      const status = response.status;
      if (isRedirect(status)) {
        const location = response.headers?.get("location") ?? null;
        await response.body?.cancel();
        if (location === null || redirects >= MAX_REDIRECTS) {
          throw new EtpgpbResponseError(`ЭТП ГПБ вернула редирект без цели или слишком длинную цепочку (${current}).`, status);
        }
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          throw new EtpgpbResponseError(`ЭТП ГПБ вернула редирект на нечитаемый адрес (${current}).`, status);
        }
        // Редирект на закрытый хост или адрес с query-строкой — исключение, а не переход.
        assertEtpgpbUrlAllowed(next);
        current = next;
        redirects += 1;
        continue;
      }
      if (status === 401 || status === 403) {
        await response.body?.cancel();
        throw this.block(`HTTP ${String(status)} на запрос «${what}»`);
      }
      if (status === 404 || status === 410) {
        await response.body?.cancel();
        throw new EtpgpbResponseError(`ЭТП ГПБ: «${what}» не найдена, HTTP ${String(status)} (${current}).`, status);
      }

      const retryable = status === 429 || status >= 500;
      if (retryable) {
        await response.body?.cancel();
        if (attempt >= this.maxRetries) {
          if (status === 429) throw this.block(`HTTP 429 на запрос «${what}» после ${String(attempt + 1)} попыток`);
          throw new EtpgpbResponseError(`ЭТП ГПБ ответила HTTP ${String(status)} на запрос «${what}» (${current}).`, status);
        }
        attempt += 1;
        const retryAfter = Number(response.headers?.get("retry-after"));
        const pause =
          status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
            : RETRY_BACKOFF_MS * 2 ** (attempt - 1);
        await this.sleep(pause);
        continue;
      }

      const text = await response.text();
      if (response.ok && options.looksRight(text)) return text;
      if (response.ok && PROTECTION_PAGE.test(text.slice(0, 20_000))) {
        throw this.block(`вместо «${what}» пришла страница защиты`);
      }
      if (attempt >= this.maxRetries) {
        throw new EtpgpbResponseError(
          response.ok
            ? `ЭТП ГПБ вернула ответ, который не разбирается как «${what}» (${current}).`
            : `ЭТП ГПБ ответила HTTP ${String(status)} на запрос «${what}» (${current}).`,
          status,
        );
      }
      attempt += 1;
      await this.sleep(RETRY_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }

  private requestSitemap(url: string, what: string): Promise<string> {
    return this.requestText(url, what, {
      timeoutMs: this.sitemapTimeoutMs,
      looksRight: (text) => /<(?:urlset|sitemapindex)\b/.test(text),
    });
  }

  private requestCard(url: string): Promise<string> {
    return this.requestText(url, "карточка процедуры", { timeoutMs: this.timeoutMs, looksRight: isEtpgpbCardPage });
  }

  /* ============================== карта сайта ============================== */

  /**
   * Карта сайта: один раз за жизнь адаптера (и не дольше `SITEMAP_MEMO_TTL_MS`).
   * Неудачная загрузка из памяти убирается: следующий профиль попробует снова, а не
   * получит ту же ошибку.
   */
  private loadSitemap(nowMs: number): Promise<LoadedSitemap> {
    const hit = this.sitemapMemo;
    if (hit !== null && nowMs - hit.at < SITEMAP_MEMO_TTL_MS && nowMs - hit.at >= 0) {
      return hit.entries.then((loaded) => ({ ...loaded, source: "память" as const }));
    }
    const entries = this.downloadSitemap(nowMs);
    const memo = { at: nowMs, entries };
    this.sitemapMemo = memo;
    entries.catch(() => {
      if (this.sitemapMemo === memo) this.sitemapMemo = null;
    });
    return entries;
  }

  private async downloadSitemap(nowMs: number): Promise<LoadedSitemap> {
    const indexXml = await this.requestSitemap(ETPGPB_SITEMAP_INDEX_URL, "индекс карты сайта");
    const proceduresUrl = findProceduresSitemapUrl(indexXml);
    if (proceduresUrl === null) {
      throw new EtpgpbResponseError("ЭТП ГПБ: индекс карты сайта не перечисляет карту процедур (sitemap/procedures.xml) — структура сайта изменилась.");
    }
    const listXml = await this.requestSitemap(proceduresUrl, "список кусков карты процедур");
    const chunks = parseProcedureChunks(listXml);
    if (chunks.length === 0) {
      throw new EtpgpbResponseError("ЭТП ГПБ: карта процедур не содержит ни одного куска — структура сайта изменилась.");
    }

    const wanted = selectChunks(chunks, { nowMs, lookbackMs: this.lookbackMs, maxChunks: this.maxChunks });
    const cutoff = nowMs - this.lookbackMs;
    const qualified = chunks.filter((chunk) => chunk.lastmodMs !== null && chunk.lastmodMs >= cutoff).length;
    const sitemap = {
      source: "сеть" as const,
      chunks: wanted.length,
      skipped: qualified - wanted.length,
      downloaded: 0,
      cached: 0,
      stale: 0,
      failed: 0,
      entries: 0,
    };
    const all = new Map<string, EtpgpbSitemapEntry>();
    const add = (entries: readonly EtpgpbSitemapEntry[]): void => {
      for (const entry of entries) {
        const known = all.get(entry.url);
        if (known === undefined || known.lastmodMs < entry.lastmodMs) all.set(entry.url, entry);
      }
    };
    let lastError: unknown = null;

    for (const chunk of wanted) {
      const cached = this.sitemapCache.get(chunk.url);
      // Кусок из кэша годится, если площадка не меняла его и если записи в нём отобраны
      // по границе не новее нынешней: иначе в нём могло не оказаться нужных.
      if (cached !== undefined && cached.lastmod === chunk.lastmod && cached.cutoffMs <= cutoff) {
        add(cached.entries);
        sitemap.cached += 1;
        continue;
      }
      try {
        const xml = await this.requestSitemap(chunk.url, `кусок карты процедур №${String(chunk.number)}`);
        const entries = parseChunkEntries(xml, {
          minLastmodMs: cutoff,
          excludeKinds: this.excludeKinds,
          fallbackLastmodMs: chunk.lastmodMs,
        });
        this.sitemapCache.set(chunk.url, { lastmod: chunk.lastmod, cutoffMs: cutoff, savedAt: nowMs, entries });
        add(entries);
        sitemap.downloaded += 1;
      } catch (error) {
        // Ограничение доступа — не сбой куска: дальше запросов нет.
        if (error instanceof EtpgpbBlockedError) throw error;
        lastError = error;
        // Устаревший кусок лучше пропуска: записи в нём прежние, свежих он просто не знает.
        if (cached !== undefined) {
          add(cached.entries);
          sitemap.stale += 1;
        } else {
          sitemap.failed += 1;
        }
      }
    }
    if (all.size === 0 && sitemap.failed > 0 && lastError !== null) throw lastError;
    this.sitemapCache.flush(nowMs);
    sitemap.entries = all.size;
    return { entries: [...all.values()], sitemap };
  }

  /* ============================== карточки ============================== */

  /** Запись из памяти или кэша на диске, если карточку можно не читать. */
  private reusableRecord(entry: EtpgpbSitemapEntry, nowMs: number): { record: CardRecord; from: "memo" | "cache" } | null {
    const memo = this.cardMemo.get(entry.url);
    if (memo !== undefined && memo.lastmodMs === entry.lastmodMs) return { record: memo, from: "memo" };
    if (this.cardTtlMs <= 0) return null;
    const cached = this.cardCache.get(entry.url);
    if (cached === undefined || cached.lastmodMs !== entry.lastmodMs) return null;
    const age = nowMs - cached.fetchedAt;
    return age >= 0 && age < this.cardTtlMs ? { record: cached, from: "cache" } : null;
  }

  /** Читает карточку по сети и превращает в запись кэша. Бросает при сбое запроса. */
  private async readCard(url: string, lastmodMs: number): Promise<CardRecord> {
    const fetchedAt = this.nowProvider().getTime();
    let html: string;
    try {
      html = await this.requestCard(url);
    } catch (error) {
      // Процедуры больше нет: это ответ, а не сбой, и повторять его каждый прогон незачем.
      if (error instanceof EtpgpbResponseError && (error.status === 404 || error.status === 410)) {
        return { lastmodMs, fetchedAt, accepting: false, tender: null };
      }
      throw error;
    }
    const card = parseEtpgpbCard(html, url);
    if (card === null) return { lastmodMs, fetchedAt, accepting: false, tender: null, unparsed: true };
    const tender = mapEtpgpbCard(card, { cardUrl: url });
    return { lastmodMs, fetchedAt, accepting: etpgpbIsAccepting(card), tender };
  }

  private remember(url: string, tender: Tender): void {
    this.urlByKey.set(tender.regNumber, url);
    this.urlByKey.set(tender.id, url);
    if (tender.externalId !== null) this.urlByKey.set(tender.externalId, url);
  }

  async fetchTenders(query: TenderSourceQuery): Promise<Tender[]> {
    // Сброс до первого запроса, а не только в конце: сорвавшийся вызов не имеет права
    // оставить в `filterStats` числа предыдущего профиля.
    this.stats = emptyStats();
    const nowMs = query.nowMs ?? this.nowProvider().getTime();
    const limit = query.limit ?? 50;
    const groups: EtpgpbKeywordGroup[] = buildEtpgpbKeywordGroups(query.keywords);
    const filters = prepareFilters(query);

    const loaded = await this.loadSitemap(nowMs);
    this.stats.sitemap = { ...loaded.sitemap, source: loaded.source ?? loaded.sitemap.source };

    const window = selectEntries(loaded.entries, {
      nowMs,
      lookbackMs: this.lookbackMs,
      excludeKinds: this.excludeKinds,
    });
    this.stats.window = window.length;
    const candidates = window.filter((entry) => etpgpbSlugMatches(entry.slug, groups));
    this.stats.candidates = candidates.length;

    const kept = new Map<string, Tender>();
    let fetchedThisCall = 0;
    let blockedError: EtpgpbBlockedError | null = null;

    for (const entry of candidates) {
      if (limit <= kept.size) break;

      const reused = this.reusableRecord(entry, nowMs);
      let record: CardRecord;
      if (reused !== null) {
        record = reused.record;
        if (reused.from === "memo") this.stats.memoized += 1;
        else this.stats.cached += 1;
      } else {
        // Потолки: на вызов и на прогон. Упёршись, обход не останавливается — он ещё
        // может найти нужное в кэше, — но запросов карточек больше не делает.
        if (fetchedThisCall >= this.maxCardsPerCall || this.cardRequests >= this.maxCardsPerRun) {
          this.stats.budgetReached ??= fetchedThisCall >= this.maxCardsPerCall ? "на вызов" : "на прогон";
          this.stats.deferred += 1;
          continue;
        }
        fetchedThisCall += 1;
        this.cardRequests += 1;
        this.stats.fetched += 1;
        try {
          record = await this.readCard(entry.url, entry.lastmodMs);
        } catch (error) {
          if (error instanceof EtpgpbBlockedError) {
            blockedError = error;
            break;
          }
          this.stats.failed += 1;
          continue;
        }
        this.cardMemo.set(entry.url, record);
        this.cardCache.set(entry.url, record);
      }

      if (record.tender === null) {
        count(this.stats.rejected, record.unparsed === true ? "карточка не разобрана" : "не закупка поставщика");
        continue;
      }
      this.remember(entry.url, record.tender);

      const reason = this.rejectionOf(record, filters, groups, nowMs);
      if (reason !== null) {
        count(this.stats.rejected, reason);
        continue;
      }
      if (!kept.has(record.tender.regNumber)) kept.set(record.tender.regNumber, record.tender);
    }

    this.stats.kept = kept.size;
    this.flushCaches();

    if (blockedError !== null) {
      this.stats.blocked = blockedError.message;
      // Ничего не собрав, сообщаем об ограничении ошибкой: «найдено 0» скрыло бы причину.
      if (kept.size === 0) throw blockedError;
    }
    return [...kept.values()];
  }

  /**
   * Отбор по уже прочитанной карточке: название, срок, закон, цена, регион, ИНН.
   * Возвращает причину отказа; null — закупка проходит.
   */
  private rejectionOf(
    record: CardRecord,
    filters: PreparedFilters,
    groups: readonly EtpgpbKeywordGroup[],
    nowMs: number,
  ): Rejection | null {
    const tender = record.tender;
    if (tender === null) return "не закупка поставщика";

    if (!etpgpbTitleMatches(tender.subject, groups)) return "название не подходит под слово";

    if (this.activeOnly) {
      if (!record.accepting) return "приём заявок не идёт";
      const deadline = Date.parse(tender.deadlines.submissionEnd);
      if (Number.isNaN(deadline)) return "срок приёма заявок не указан";
      if (deadline <= nowMs) return "срок приёма заявок истёк";
    }

    if (filters.laws.length > 0 && !filters.laws.includes(tender.law)) return "закон";

    // Цена 0 — «не указана»: заказчики часто её не публикуют, и такие закупки не отсекаются.
    if (isPriceKnown(tender.financial.price)) {
      if (filters.minPrice !== null && tender.financial.price < filters.minPrice) return "цена";
      if (filters.maxPrice !== null && tender.financial.price > filters.maxPrice) return "цена";
    }

    if (filters.regions.length > 0) {
      // «Не определён» не равно «другой регион», но показать закупку, о регионе которой
      // ничего не известно, региональному профилю нельзя: причина считается отдельно.
      if (!isRegionKnown(tender.region)) return "регион не определён";
      const region = tender.region.toLowerCase();
      if (!filters.regions.some((wanted) => region.includes(wanted))) return "регион";
    }

    if (filters.customerInns.length > 0) {
      if (tender.customerInn === null || !filters.customerInns.includes(tender.customerInn)) return "заказчик";
    }
    return null;
  }

  /* ============================== точечные запросы ============================== */

  /**
   * Адрес карточки по идентификатору: сам адрес, номер закупки (ключ записи, номер
   * площадки или `etpgpb-<вид>-<id>`), уже встречавшийся этому адаптеру или лежащий в кэше
   * карточек. Для `etpgpb-<вид>-<id>` дополнительно смотрится карта сайта. Иначе null:
   * адрес по одному номеру не восстановить, а гадать нельзя.
   */
  private async resolveCardUrl(id: string): Promise<string | null> {
    const key = id.trim();
    if (key === "") return null;
    if (key.startsWith("https://")) return parseEtpgpbCardUrl(key)?.url ?? null;

    const remembered = this.urlByKey.get(key) ?? this.urlByKey.get(key.toUpperCase());
    if (remembered !== undefined) return remembered;
    for (const [url, record] of this.cardCache.values()) {
      const tender = record.tender;
      if (tender === null) continue;
      if (tender.regNumber === key || tender.id === key || tender.externalId === key) return url;
    }

    const byId = /^etpgpb-([a-z][a-z0-9_]*)-(\d+)$/i.exec(key);
    if (byId !== null) {
      const kind = (byId[1] ?? "").toLowerCase();
      const platformId = byId[2] ?? "";
      const loaded = await this.loadSitemap(this.nowProvider().getTime());
      const found = loaded.entries.find((entry) => entry.kind === kind && entry.id === platformId);
      return found?.url ?? null;
    }
    return null;
  }

  /** Закупка по адресу карточки, читается по сети (не из кэша): так отвечают на «что там сейчас». */
  private async loadTender(url: string): Promise<Tender | null> {
    const record = await this.readCard(url, 0);
    if (record.tender === null) return null;
    this.remember(url, record.tender);
    return record.tender;
  }

  async fetchTenderById(id: string): Promise<Tender | null> {
    const url = await this.resolveCardUrl(id);
    // Адрес не нашёлся — например, закупку давно убрали из окна просмотра. Подставить
    // соседнюю значило бы показать карточку чужой закупки.
    if (url === null) return null;
    return this.loadTender(url);
  }

  /**
   * Документов нет, и это ответ, а не заглушка.
   *
   * Ссылки на файлы в карточке ведут на `etp.gpb.ru/file/get/…` (у процедур
   * «ЭТП Клик» и «Коммерческих заказчиков» — на соседние хосты площадки), а
   * `robots.txt` хоста `etp.gpb.ru` и хоста `com.etpgpb.ru` — `Disallow: /` (проверено
   * 19.10.2026). Хост `click.etpgpb.ru` не проверялся вовсе, поэтому и он не
   * запрашивается. Ссылки на файлы адаптер не сохраняет и не отдаёт: ссылка под видом
   * документа уехала бы в платный разбор как текст закупки, и вместо ТЗ разбирался бы
   * чужой ответ. Письменное согласие площадки превращает этот ответ в список файлов без
   * переделки остального. Причина показывается в каталоге источников
   * (`src/domain/sources.ts`, поле `documentsReason`) и печатается загрузчиком документов.
   *
   * Запрос не делается: метод не зовёт ни `fetchTenderById`, ни сеть.
   */
  async fetchDocuments(_tenderId: string): Promise<TenderDocument[]> {
    return [];
  }

  /**
   * Изменилась ли процедура с переданного момента: сравнивается дата последнего
   * изменения карточки (`date_last_update`). Карточка читается по сети, а не из кэша —
   * иначе ответ был бы тем же, что и в прошлый раз. Правку документации метод не
   * видит: файлов адаптер не читает.
   */
  async checkChanges(tenderId: string, since: string): Promise<boolean> {
    const sinceMs = Date.parse(since);
    // Дату, которую не удалось прочитать, нельзя ни расширить, ни сузить: любой ответ
    // был бы выдуман. Запрос пропускаем и говорим «изменений нет».
    if (Number.isNaN(sinceMs)) return false;
    const tender = await this.fetchTenderById(tenderId);
    if (tender === null) return false;
    const updated = Date.parse(tender.deadlines.lastUpdateDate);
    if (Number.isNaN(updated)) return false;
    return updated > sinceMs;
  }
}

interface LoadedSitemap {
  readonly entries: readonly EtpgpbSitemapEntry[];
  readonly sitemap: EtpgpbFilterStats["sitemap"];
  /** «память», если карта взята из памяти адаптера этого прогона. */
  readonly source?: "сеть" | "память";
}
