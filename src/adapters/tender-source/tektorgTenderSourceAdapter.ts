/**
 * Адаптер источника данных «ТЭК-Торг» (223-ФЗ и коммерческие закупки).
 *
 * Работает ТОЛЬКО на сервере (Node). Использует официальный SOAP-экспорт процедур
 * `POST https://api.tektorg.ru/procedures/soap`, который отдаёт закупки вместе с
 * адресами документов без ключа и без регистрации (проверено живыми запросами
 * 01–02.10.2026, см. `docs/REFERENCE_TEK_TORG_API.md`).
 *
 * Четыре особенности площадки, из-за которых адаптер устроен именно так:
 *
 * 1. **Секцию нужно задавать явно.** Без `sectionCode` экспорт отдаёт `44fz` —
 *    государственные закупки, которые и так лежат в ЕИС по закону. Прирост даёт
 *    только секция `zakupki` («223-ФЗ и Коммерческие закупки»): из 75 процедур,
 *    опубликованных 01.10.2026, 49 несут номер извещения ЕИС, то есть 26 записей
 *    в сутки не приходят ни из одного подключённого источника.
 *
 * 2. **Окно публикации, а не окно изменений.** `startDate`/`endDate` за сутки дают
 *    75 процедур, и все их лоты в статусе «Приём заявок». `startUpdateAt`/
 *    `endUpdateAt` дают 105 процедур, из которых 72 — «Архив»: это уже закрытые
 *    закупки, которые площадка просто трогала. Поэтому `fetchTenders` берёт окно
 *    публикации и не нуждается в фильтре «только активные», а окно изменений
 *    остаётся за `checkChanges`.
 *
 * 3. **`eisRegistryNumber` в запросе игнорируется.** Зонд 02.10.2026: заведомо
 *    несуществующий номер извещения вернул всю секцию целиком (5 процедур при
 *    `limitPage=5`, `totalProcedures 136256`), а несуществующий `registryNumber` —
 *    пустую выдачу. Значит, точечный поиск есть только по номеру площадки, и все
 *    три метода одного объекта (`fetchTenderById`, `fetchDocuments`, `checkChanges`)
 *    ключуются на нём. Номер извещения ЕИС состоит только из цифр, и такой ключ до
 *    площадки не доходит вовсе: запрос по нему вернул бы произвольную страницу
 *    выдачи, а карточка показала бы чужие документы под видом своих.
 *
 * 4. **Успех приходит с `Content-Type: text/html`.** Отличить выдачу от ошибки по
 *    заголовку нельзя, поэтому смотрим на HTTP-код и на тело: конверт проверяет
 *    `parseProceduresResponse`. Пустое тело при HTTP 200 в живой выдаче встретилось
 *    один раз — это сбой транспорта, и он повторяется, в отличие от SOAP Fault.
 */
import type { Tender, TenderDocument } from "@/domain/entities";
import { isPriceKnown, isRegionKnown } from "@/domain/entities";
import { isSameRegion } from "@/domain/regionCodes";
import type { TenderLaw } from "@/domain/enums";
import type { TenderSourceAdapter, TenderSourceQuery } from "@/adapters/types";
import { documentTypeFromFileName } from "@/adapters/tender-source/documentType";
import {
  TEKTORG_ENDPOINTS,
  TEKTORG_REQUEST_HEADERS,
  TektorgSoapFaultError,
  buildProceduresRequest,
  parseProceduresResponse,
} from "@/adapters/tender-source/tektorgSoap";
import type {
  TektorgDocument,
  TektorgProcedure,
  TektorgProceduresPage,
  TektorgProceduresQuery,
} from "@/adapters/tender-source/tektorgSoap";
import {
  TEKTORG_ZAKUPKI_SECTION,
  mapTektorgProcedure,
} from "@/adapters/tender-source/tektorgMapper";
import {
  readTektorgWindowCache,
  writeTektorgWindowCache,
  type TektorgWindowCacheOptions,
} from "@/adapters/tender-source/tektorgWindowCache";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Смещение московского времени: площадка принимает и печатает даты в +03:00. */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
/** Задержка первого повтора; каждый следующий вдвое дольше. */
const RETRY_BACKOFF_MS = 300;

/**
 * Момент в формате площадки: `YYYY-MM-DDTHH:mm:ss+03:00`.
 *
 * Собирается через `getUTC*` от сдвинутого момента, а не через `toLocaleString` с
 * зоной: локаль и база часовых поясов зависят от машины, а прогон синхронизации
 * живёт на сервере в России, CI — нет, и окно запроса не должно разъезжаться на
 * час в зависимости от того, где его собрали.
 */
export function tektorgDateTime(value: Date): string {
  const shifted = new Date(value.getTime() + MSK_OFFSET_MS);
  const two = (n: number): string => String(n).padStart(2, "0");
  return (
    `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${two(shifted.getUTCMonth() + 1)}-${two(shifted.getUTCDate())}` +
    `T${two(shifted.getUTCHours())}:${two(shifted.getUTCMinutes())}:${two(shifted.getUTCSeconds())}+03:00`
  );
}

const PLATFORM_ID_PREFIX = /^tektorg-/i;
const DIGITS_ONLY = /^\d+$/;

/**
 * Номер процедуры на площадке из любого ключа, который к нам приходит.
 *
 * Принимает и внутренний id (`tektorg-ЗП610102`), и номер из базы
 * (`TEKTORG-ЗП610102`), и голый номер (`ЗП610102`).
 *
 * null означает «спросить площадку нечего». Две причины: пустой ключ и номер
 * извещения ЕИС (только цифры) — точечного поиска по нему у экспорта нет,
 * `eisRegistryNumber` в запросе площадка игнорирует. Запрос по такому ключу
 * вернул бы произвольную страницу выдачи, и карточка показала бы документы чужой
 * закупки под видом своих.
 */
export function tektorgPlatformNumber(tenderId: string): string | null {
  const value = tenderId.trim().replace(PLATFORM_ID_PREFIX, "");
  if (value === "" || DIGITS_ONLY.test(value)) return null;
  return value;
}

/** Площадка ответила HTTP-кодом ошибки вместо конверта. */
export class TektorgHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TektorgHttpError";
  }
}

/** Причина, по которой закупка не попала в выдачу. Текст уходит в журнал прогона. */
type Rejection =
  | "закон"
  | "регион"
  | "регион не определён"
  | "цена"
  | "ключевое слово"
  | "срок подачи истёк";

/** Отбор, который площадка в запросе не поддерживает. */
interface PreparedFilters {
  readonly laws: readonly TenderLaw[];
  readonly regions: readonly string[];
  readonly keywords: readonly string[];
  readonly minPrice: number | null;
  readonly maxPrice: number | null;
  /** Только открытые: закупка со сроком подачи раньше `nowMs` в выдачу не идёт. */
  readonly onlyOpen: boolean;
  readonly nowMs: number;
}

/**
 * Сколько процедур экспорт вернул и сколько из них дошло до выдачи.
 *
 * Журнал прогона обязан различать «площадка ничего не отдала» и «мы отбросили»:
 * ноль в обоих случаях выглядит одинаково, а означает разное.
 */
export interface TektorgFilterStats {
  /** Процедур после склейки дублей, до локального отбора. */
  readonly fetched: number;
  /** Закупок в выдаче после отбора и обрезки по `limit`. */
  readonly kept: number;
  /** Отклонения по причинам; причина — та же строка, что печатает журнал. */
  readonly rejected: Readonly<Record<string, number>>;
}

export interface TektorgAdapterOptions {
  /** Ограничение запросов в секунду. */
  rateLimitPerSec?: number;
  /** Максимум повторов при сбое транспорта или оборванном ответе. */
  maxRetries?: number;
  /**
   * Таймаут одного запроса в миллисекундах. Страница в 500 процедур — это около
   * 430 КБ, и живая площадка отдаёт её за 10–40 с; значение по умолчанию оставляет
   * запас на медленный вечер, но не позволяет запросу висеть до конца прогона.
   */
  timeoutMs?: number;
  /** Секция экспорта. По умолчанию — коммерческие закупки и 223-ФЗ. */
  sectionCode?: string;
  /** На сколько дней назад смотреть публикации. */
  lookbackDays?: number;
  /** Размер страницы выдачи. Площадка принимает до 500. */
  pageSize?: number;
  /** Максимум страниц на один поисковый запрос. */
  maxPages?: number;
  /**
   * Дисковый кэш окна публикации с коротким сроком жизни (см.
   * `tektorgWindowCache.ts`). Не задан — окно скачивается каждый прогон.
   */
  windowCache?: TektorgWindowCacheOptions;
  /** Источник текущего времени (для детерминированных тестов). */
  nowProvider?: () => Date;
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function lower(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean);
}

export class TektorgTenderSourceAdapter implements TenderSourceAdapter {
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sectionCode: string;
  private readonly lookbackDays: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly windowCache: TektorgWindowCacheOptions | null;
  private readonly nowProvider: () => Date;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;
  /**
   * Скачанные окна публикации на время жизни адаптера (один прогон).
   *
   * Экспорт ключевых слов не принимает, поэтому каждый профиль получал бы одну и
   * ту же страницу заново: при окне в месяц это несколько запросов по 430 КБ и
   * 10–40 с каждый. Ключ — секция, ИНН и длина окна; отбор по словам, региону и
   * цене идёт уже по кэшу.
   */
  private readonly windows = new Map<string, Promise<Map<string, Tender>>>();
  private stats: { fetched: number; kept: number; rejected: Record<string, number> } = {
    fetched: 0,
    kept: 0,
    rejected: {},
  };

  constructor(options: TektorgAdapterOptions = {}) {
    this.minIntervalMs = 1000 / (options.rateLimitPerSec ?? 2);
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.sectionCode = options.sectionCode?.trim() || TEKTORG_ZAKUPKI_SECTION;
    this.lookbackDays = options.lookbackDays ?? 1;
    this.pageSize = options.pageSize ?? 500;
    this.maxPages = options.maxPages ?? 10;
    this.windowCache = options.windowCache ?? null;
    this.nowProvider = options.nowProvider ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Итог последнего вызова `fetchTenders` — для честной строки в журнале прогона. */
  get filterStats(): TektorgFilterStats {
    return {
      fetched: this.stats.fetched,
      kept: this.stats.kept,
      rejected: { ...this.stats.rejected },
    };
  }

  /** Простейший rate-limit: не чаще N запросов в секунду. */
  private async throttle(): Promise<void> {
    if (this.lastRequestAt !== 0) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.lastRequestAt = Date.now();
  }

  /** Один запрос к экспорту процедур: конверт собирается здесь. */
  private async requestOnce(query: TektorgProceduresQuery): Promise<TektorgProceduresPage> {
    await this.throttle();
    const response = await this.fetchImpl(TEKTORG_ENDPOINTS.procedures, {
      method: "POST",
      headers: { ...TEKTORG_REQUEST_HEADERS },
      body: buildProceduresRequest(query),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new TektorgHttpError(
        `ТЭК-Торг ответил HTTP ${response.status} на запрос экспорта процедур ` +
          `(${TEKTORG_ENDPOINTS.procedures}).`,
      );
    }
    return parseProceduresResponse(await response.text());
  }

  /**
   * Запрос с повторами.
   *
   * SOAP Fault не повторяется: это отказ площадки по смыслу запроса («Некорректный
   * период обновления», «Section not found»), и второй такой же запрос даст тот же
   * ответ, только потратит минуту прогона. Повторяются сбой транспорта, HTTP-код
   * ошибки и оборванное тело — их в живой выдаче видели, и они проходят сами.
   */
  private async postProcedures(query: TektorgProceduresQuery): Promise<TektorgProceduresPage> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.requestOnce(query);
      } catch (err) {
        if (err instanceof TektorgSoapFaultError) throw err;
        if (attempt >= this.maxRetries) throw err;
        await sleep(RETRY_BACKOFF_MS * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  async fetchTenders(query: TenderSourceQuery): Promise<Tender[]> {
    const now = this.nowProvider();
    // Окно публикации: из запроса, если прогон его задал, иначе по умолчанию
    // адаптера. Плановый сбор берёт месяц — коммерческая закупка живёт неделями,
    // а суточное окно приносило единицы; живой поиск — неделю, ради скорости.
    const requested = query.publishedWithinDays;
    const lookbackDays =
      requested !== undefined && Number.isFinite(requested) && requested > 0 ? requested : this.lookbackDays;
    // Экспорт принимает один ИНН заказчика (`maxOccurs="1"`), поэтому несколько
    // заказчиков — это несколько запросов. Пустой список означает «вся секция».
    const customerInns = (query.customerInns ?? []).map((v) => v.trim()).filter(Boolean);
    const innFilters: readonly (string | undefined)[] =
      customerInns.length > 0 ? customerInns : [undefined];

    /** Закупки по id процедуры: страницы и запросы по ИНН могут их повторять. */
    const merged = new Map<string, Tender>();
    for (const customerINN of innFilters) {
      const window = await this.windowOf(customerINN, lookbackDays, now);
      for (const [id, tender] of window) {
        if (!merged.has(id)) merged.set(id, tender);
      }
    }

    const filters = prepareFilters(query, query.nowMs ?? now.getTime());
    const kept: Tender[] = [];
    const rejected: Record<string, number> = {};
    for (const tender of merged.values()) {
      const reason = rejectionReason(tender, filters);
      if (reason === null) {
        kept.push(tender);
        continue;
      }
      rejected[reason] = (rejected[reason] ?? 0) + 1;
    }

    const limit = query.limit ?? 50;
    const sliced = kept.slice(0, limit);
    this.stats = { fetched: merged.size, kept: sliced.length, rejected };
    return sliced;
  }

  /**
   * Окно публикации секции за `lookbackDays` дней, постранично и один раз за
   * прогон. Неудачная загрузка из кэша убирается: следующий профиль попробует
   * снова, а не получит ту же ошибку из памяти.
   */
  private windowOf(
    customerINN: string | undefined,
    lookbackDays: number,
    now: Date,
  ): Promise<Map<string, Tender>> {
    const key = `${this.sectionCode}|${customerINN ?? ""}|${String(lookbackDays)}`;
    const cached = this.windows.get(key);
    if (cached !== undefined) return cached;

    const load = (async () => {
      // Окно, скачанное недавно прошлым прогоном (плановым, ручным или живым),
      // берём с диска: 45 секунд скачивания не нужны, чтобы увидеть то же самое.
      const fromDisk =
        this.windowCache === null ? null : readTektorgWindowCache(this.windowCache, key, now.getTime());
      if (fromDisk !== null) return fromDisk;
      const startDate = tektorgDateTime(new Date(now.getTime() - lookbackDays * DAY_MS));
      const endDate = tektorgDateTime(now);
      const procedures = new Map<string, Tender>();
      for (let page = 1; page <= this.maxPages; page += 1) {
        const response = await this.postProcedures({
          startDate,
          endDate,
          sectionCode: this.sectionCode,
          customerINN,
          limitPage: this.pageSize,
          page,
        });

        for (const procedure of response.procedures) {
          if (procedures.has(procedure.id)) continue;
          procedures.set(procedure.id, mapTektorgProcedure(procedure, { sectionCode: this.sectionCode }));
        }

        // Страниц больше нет: выдача короче размера страницы или исчерпан totalPage.
        // `totalPage` у пустого ответа равен 0, поэтому первым смотрим на длину.
        if (response.procedures.length < this.pageSize) break;
        if (page >= (response.totalPage ?? page)) break;
      }
      if (this.windowCache !== null) {
        writeTektorgWindowCache(this.windowCache, key, procedures, now.getTime());
      }
      return procedures;
    })();
    this.windows.set(key, load);
    load.catch(() => this.windows.delete(key));
    return load;
  }

  async fetchTenderById(id: string): Promise<Tender | null> {
    const procedure = await this.findProcedure(id);
    if (procedure === null) return null;
    return mapTektorgProcedure(procedure, { sectionCode: this.sectionCode });
  }

  /**
   * Документы процедуры: адреса байт приходят в самом экспорте, отдельного метода
   * у площадки для них нет.
   *
   * Текста здесь нет и быть не может — `text` остаётся пустым, а байты по адресу
   * `url` скачивает и разбирает воркер (см. `services/tenderDocumentSync.ts`).
   * Документ, снятый с публикации, не отдаётся: адреса у него нет, а карточка
   * площадки под видом документа — это чужой текст в платном разборе.
   */
  async fetchDocuments(tenderId: string): Promise<TenderDocument[]> {
    const procedure = await this.findProcedure(tenderId);
    if (procedure === null) return [];

    return procedure.documents.flatMap((document) => {
      if (document.removed || document.url === null) return [];
      return [
        {
          id: document.id,
          type: documentTypeFromFileName(document.filename),
          title: document.filename,
          fileName: document.filename,
          url: document.url,
          text: "",
          pageCount: null,
          // Экспорт не печатает дату изменения отдельного документа; есть только
          // `dateUpdated` процедуры. Подставлять её значит заявить точность, которой нет.
          lastModified: null,
        },
      ];
    });
  }

  /**
   * Документы процедуры списком — включая снятые с публикации.
   *
   * От `fetchDocuments` отличается ровно одним: не выбрасывает документы с
   * `<removed>`. Загрузчику документации этот факт нужен, а не мешает: партнёр
   * обязан видеть, что заказчик отозвал файл, иначе документ просто исчезнет из
   * карточки без объяснения. Скачивать его нельзя — адреса нет, а запрос по
   * несуществующему адресу вернул бы страницу ошибки, которую парсер принял бы
   * за текст документа.
   *
   * Читает тот же экспорт процедур и тот же ключ (`tektorgPlatformNumber`),
   * поэтому отдельного запроса к площадке не добавляет.
   */
  async readDocumentList(tenderId: string): Promise<readonly TektorgDocument[]> {
    const procedure = await this.findProcedure(tenderId);
    return procedure?.documents ?? [];
  }

  /**
   * Изменилась ли процедура с переданного момента.
   *
   * Здесь работает окно изменений (`startUpdateAt`/`endUpdateAt`), а не окно
   * публикации: площадка попала в него — значит, её трогали.
   */
  async checkChanges(tenderId: string, since: string): Promise<boolean> {
    const platformNumber = tektorgPlatformNumber(tenderId);
    if (platformNumber === null) return false;

    const sinceDate = new Date(since);
    // Дату, которую не удалось прочитать, нельзя ни расширить, ни сузить: любой
    // ответ здесь был бы выдуман. Пропускаем запрос и говорим «изменений нет».
    if (Number.isNaN(sinceDate.getTime())) return false;

    const page = await this.postProcedures({
      startUpdateAt: tektorgDateTime(sinceDate),
      endUpdateAt: tektorgDateTime(this.nowProvider()),
      sectionCode: this.sectionCode,
      registryNumber: platformNumber,
      limitPage: this.pageSize,
    });
    return page.procedures.some(
      (procedure) => normalizeNumber(procedure.registryNumber) === platformNumber,
    );
  }

  /**
   * Одна процедура по номеру площадки.
   *
   * Номер совпадает буквально, а не «что вернула площадка»: `registryNumber` в
   * запросе — фильтр, но доверять ему на слово нельзя. Зонд показал, что соседнее
   * поле `eisRegistryNumber` экспорт молча игнорирует и отдаёт всю секцию; если так
   * же поведёт себя и этот, карточка показала бы чужую закупку.
   */
  private async findProcedure(tenderId: string): Promise<TektorgProcedure | null> {
    const platformNumber = tektorgPlatformNumber(tenderId);
    if (platformNumber === null) return null;

    const page = await this.postProcedures({
      sectionCode: this.sectionCode,
      registryNumber: platformNumber,
      limitPage: this.pageSize,
    });
    return (
      page.procedures.find(
        (procedure) => normalizeNumber(procedure.registryNumber) === platformNumber,
      ) ?? null
    );
  }
}

function normalizeNumber(value: string | null): string {
  return value?.trim() ?? "";
}

function prepareFilters(query: TenderSourceQuery, nowMs: number): PreparedFilters {
  return {
    onlyOpen: query.onlyOpen === true,
    nowMs,
    laws: query.laws,
    regions: lower(query.regions),
    keywords: lower(query.keywords),
    minPrice: query.minPrice ?? null,
    maxPrice: query.maxPrice ?? null,
  };
}

/**
 * Отбор, который площадка в запросе не поддерживает: закон, регион, цена и
 * ключевые слова.
 *
 * Ключевых слов в экспорте нет вовсе, поэтому они ищутся по названию процедуры,
 * предметам лотов и названию заказчика. У многолотовой закупки предмет лота часто
 * точнее названия: «Поставка электро-бензоинструмента (лот 1, лот 2)» против
 * «Оказание услуг по техническому обслуживанию…».
 *
 * ИНН заказчика здесь не проверяется намеренно: он уже ушёл в запрос, а повторная
 * сверка по `tender.customerInn` отбросила бы законные записи — экспорт понимает под
 * `customerINN` и организатора, а в домене заказчик и организатор могут различаться
 * (у ЗП6082206 это ООО «РГ-СНАБЖЕНИЕ» против АО «РЕГИОНГАЗ-ИНВЕСТ»).
 */
function rejectionReason(tender: Tender, filters: PreparedFilters): Rejection | null {
  // Пустой список законов означает «профиль закон не ограничивает»: отбросить всё
  // значило бы молча обнулить источник.
  if (filters.laws.length > 0 && !filters.laws.includes(tender.law)) return "закон";

  if (filters.regions.length > 0) {
    // Неопределённый регион считается отдельно: это не «другой регион», а
    // неизвестность, и в журнале она должна быть видна своим числом.
    if (!isRegionKnown(tender.region)) return "регион не определён";
    // По коду региона: «Кемеровская область Кузбасс» (тире съела чистка запроса)
    // и «Бурятия» совпадают с каноническими названиями площадки.
    if (!filters.regions.some((wanted) => isSameRegion(wanted, tender.region))) return "регион";
  }

  // Цена 0 означает «не опубликована», а не «бесплатно»: запросы ценовой информации
  // выходят без цены примерно в четверти случаев, и лимит профиля их не отсекает.
  const price = tender.financial.price;
  if (isPriceKnown(price)) {
    if (filters.minPrice !== null && price < filters.minPrice) return "цена";
    if (filters.maxPrice !== null && price > filters.maxPrice) return "цена";
  }

  // Окно публикации в месяц приносит и закупки, приём заявок по которым уже
  // закончился. Неизвестный срок закрытым не считается.
  if (filters.onlyOpen) {
    const deadline = Date.parse(tender.deadlines.submissionEnd);
    if (!Number.isNaN(deadline) && deadline < filters.nowMs) return "срок подачи истёк";
  }

  if (filters.keywords.length > 0 && !keywordHaystack(tender).some((hay) =>
    filters.keywords.some((keyword) => hay.includes(keyword)),
  )) {
    return "ключевое слово";
  }

  return null;
}

/** Где искать ключевое слово: название процедуры, предметы лотов, заказчик. */
function keywordHaystack(tender: Tender): string[] {
  return [tender.subject, tender.customerName, ...tender.lots.map((lot) => lot.subject)]
    .map((value) => value.toLowerCase())
    .filter(Boolean);
}
