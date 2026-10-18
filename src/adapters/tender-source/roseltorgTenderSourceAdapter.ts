/**
 * Адаптер источника данных «Росэлторг» (223-ФЗ и коммерческие закупки).
 *
 * Работает ТОЛЬКО на сервере (Node). Использует публичный серверный поиск площадки
 * `GET https://www.roseltorg.ru/procedures/search_ajax?page=N`, который отдаёт
 * фрагмент списка — 59 КБ вместо 426 КБ полной страницы, за 0,09 с, без ключа и
 * без регистрации. `robots.txt` хоста содержит `Allow: /procedures/search?page=` и
 * `Allow: /search/*?page=`; ни этот путь, ни карточка процедуры им не запрещены
 * (проверено живыми запросами 02.10.2026, см. `docs/REFERENCE_PLATFORM_PROBES.md`,
 * раздел «Третья волна»).
 *
 * Четыре особенности площадки, из-за которых адаптер устроен именно так:
 *
 * 1. **Строка выдачи — это лот, а не закупка.** Поиск по слову возвращает совпавшие
 *    лоты: «насадка» находит лоты 2 и 3 процедуры `B2509261618185`, в которой их
 *    больше сотни, от 250 ₽ до 280 000 ₽. Сложить цены найденного подмножества —
 *    значит показать владельцу закупку за 500 ₽ вместо закупки за миллионы. Поэтому
 *    поиск даёт только номера процедур, а полный набор лотов добирается отдельным
 *    запросом по номеру (`query_field` принимает и слово, и номер). Если набор
 *    собрать не удалось, цена не публикуется вовсе.
 *
 * 2. **Даты фильтрами не задаются.** `start_date_published` и `end_date_published`
 *    по GET площадкой игнорируются: ответ байт в байт совпадает с выдачей без них.
 *    Отсеивать закрытое приходится по сроку приёма заявок в самой строке.
 *
 * 3. **«Портал Поставщиков» печатает вечные лоты.** Статус «Прием заявок» сочетается
 *    там со сроком десять месяцев назад — лот перезапускается без новой даты. Фильтр
 *    `status[]=0` этого не лечит, поэтому просроченный срок отсеивается у нас, а
 *    секция 25 не входит в набор по умолчанию.
 *
 * 4. **Документов нет.** Ссылки ведут на `com.roseltorg.ru/file/get/…`, а
 *    `robots.txt` того хоста — `Disallow: /`. Прокси на `www` возвращает 404.
 *    `fetchDocuments` отдаёт пустой список и не делает запроса: ссылка на карточку
 *    под видом документа уехала бы в платный разбор как текст закупки.
 */
import type { Tender, TenderDocument } from "@/domain/entities";
import { isPriceKnown, isRegionKnown } from "@/domain/entities";
import { isSameRegion } from "@/domain/regionCodes";
import { regionFromAddress } from "@/domain/regions";
import {
  CARD_REUSE_MAX_AGE_MS,
  isCardFresh,
  normalizeLotText,
  sameInstant,
  type ProcedureCardCache,
} from "@/domain/cardReuse";
import type { TenderLaw } from "@/domain/enums";
import type { TenderSourceAdapter, TenderSourceQuery } from "@/adapters/types";
import {
  ROSELTORG_BASE_URL,
  ROSELTORG_DEFAULT_SECTIONS,
  ROSELTORG_OPEN_STATUSES,
  parseRoseltorgSearch,
  roseltorgSearchUrl,
} from "@/adapters/tender-source/roseltorgSearch";
import type {
  RoseltorgLotRow,
  RoseltorgSearchParams,
  RoseltorgSearchPage,
} from "@/adapters/tender-source/roseltorgSearch";
import { mapRoseltorgRows, roseltorgLaw } from "@/adapters/tender-source/roseltorgMapper";

/** Задержка первого повтора; каждый следующий вдвое дольше. */
const RETRY_BACKOFF_MS = 300;

/**
 * Заголовки обычного браузерного GET.
 *
 * Зонд 02.10.2026 прошёл вообще без них — площадка не проверяет ни `Referer`, ни
 * `X-Requested-With`. Добавлять непроверенное значит рисковать рабочим запросом
 * ради правдоподобия, поэтому набор минимальный и совпадает с адаптером
 * Сбербанк-АСТ.
 */
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9",
};

const PLATFORM_ID_PREFIX = /^roseltorg-/i;

/**
 * Номер процедуры на площадке из любого ключа, который к нам приходит.
 *
 * Принимает и внутренний id (`roseltorg-32616431971`), и номер из базы
 * (`ROSELTORG-B0210261118005`), и голый номер (`B0210261118005`): префикс один и
 * тот же, различается только регистром. Пустая строка означает «спрашивать
 * нечего» — запрос без номера вернул бы произвольную страницу выдачи.
 */
export function roseltorgProcedureNumber(tenderId: string): string {
  return tenderId.trim().replace(PLATFORM_ID_PREFIX, "");
}

/** Площадка ответила не фрагментом выдачи: HTTP-код ошибки, пустое тело или страница. */
export class RoseltorgResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoseltorgResponseError";
  }
}

/** Причина, по которой строка выдачи не дошла до склейки в закупку. */
type RowRejection = "нет номера в строке выдачи" | "срок приёма заявок истёк";

/** Причина, по которой закупка не попала в выдачу. */
type TenderRejection = "закон" | "регион" | "регион не определён" | "цена" | "заказчик";

/** Отбор, который площадка в запросе не поддерживает. */
interface PreparedFilters {
  readonly laws: readonly TenderLaw[];
  readonly regions: readonly string[];
  readonly customerInns: readonly string[];
  readonly minPrice: number | null;
  readonly maxPrice: number | null;
}

/**
 * Сколько строк отдал поиск и сколько из них дошло до выдачи.
 *
 * Журнал прогона обязан различать «площадка ничего не отдала» и «мы отбросили»:
 * ноль в обоих случаях выглядит одинаково, а означает разное. Счётчики описывают
 * осмотренное окно, а не всю выдачу площадки: обход останавливается на `limit`,
 * и неосмотренные процедуры в `rejected` не попадают.
 */
export interface RoseltorgFilterStats {
  /** Строк выдачи прочитано. Строка — это лот, а не закупка. */
  readonly rows: number;
  /** Различных номеров процедур в этих строках. */
  readonly discovered: number;
  /** Процедур, по которым запрошен полный набор лотов (настоящие запросы к площадке). */
  readonly resolved: number;
  /**
   * Процедур, лоты которых взяты из кэша прошлых прогонов без запроса: карточка
   * прочитана недавно, а строка выдачи не показала перемен (см. `cardReuse.ts`).
   */
  readonly reused: number;
  /**
   * Процедур, лоты которых этот прогон уже добирал для другого профиля или слова:
   * повторного запроса нет, берётся тот же ответ.
   */
  readonly memoized: number;
  /** Процедур, у которых набор лотов остался неполным: цена не публикуется. */
  readonly incomplete: number;
  /** Закупок в выдаче после отбора и обрезки по `limit`. */
  readonly kept: number;
  /** Строки, отброшенные до склейки: причина → число строк. */
  readonly droppedRows: Readonly<Record<string, number>>;
  /** Закупки, отброшенные локальным отбором: причина → число закупок. */
  readonly rejected: Readonly<Record<string, number>>;
  /** Обход остановлен пределом запросов по номерам: часть процедур не осмотрена. */
  readonly resolveLimitReached: boolean;
}

/** Полный набор лотов одной процедуры и уверенность, что он полный. */
interface ResolvedProcedure {
  readonly rows: readonly RoseltorgLotRow[];
  readonly complete: boolean;
}

export interface RoseltorgAdapterOptions {
  /** Хост площадки. По умолчанию — боевой. */
  baseUrl?: string;
  /** Ограничение запросов в секунду. */
  rateLimitPerSec?: number;
  /** Максимум повторов при сбое транспорта или ответе не тем форматом. */
  maxRetries?: number;
  /** Таймаут одного запроса. Фрагмент выдачи — около 59 КБ и 0,09 с. */
  timeoutMs?: number;
  /** Торговые секции (`source[]`). По умолчанию — без зеркал ЕИС и Портала Поставщиков. */
  sections?: readonly number[];
  /** Максимум страниц поиска на одно ключевое слово. */
  maxPages?: number;
  /** Максимум страниц при доборе лотов одной процедуры. */
  maxResolvePages?: number;
  /**
   * Максимум процедур, по которым добираются лоты, на один вызов `fetchTenders`.
   *
   * Предел нужен потому, что каждая процедура — это отдельный запрос к площадке, а
   * обход выдачи останавливается на `limit` не всегда: если профиль отсекает много,
   * осмотреть придётся больше процедур, чем попадёт в выдачу.
   *
   * Значение по умолчанию обязано быть не меньше `limit` рабочего профиля, иначе
   * решает не профиль, а страховочный потолок: при 40 и профиле из пяти слов
   * (`limitPerKeyword` 10 → `limit` 50) живой прогон 02.10.2026 нашёл 115 процедур,
   * осмотрел 40 и напечатал «предел достигнут» — выдача оказалась короче заказанной
   * без всякого отбора. 60 покрывает такой профиль с запасом на отброшенные.
   * Поднимать дальше стоит только по замеру: потолок платен запросами к площадке,
   * а плановый прогон работает каждые два часа.
   */
  maxResolves?: number;
  /**
   * Страниц поиска на слово, когда профиль задаёт регион.
   *
   * Региона в форме поиска нет, а обычные пять страниц (50 строк) по всей России
   * для небольшого региона пусты: по Бурятии, Забайкалью и Иркутской области
   * прогон 05.10.2026 не нашёл ни одной закупки. Строка выдачи печатает регион,
   * поэтому глубокий обход дешёв: лишние строки отсеиваются до запросов карточек,
   * а страница стоит один запрос в 59 КБ.
   */
  maxRegionalPages?: number;
  /** Оставлять только закупки с неистёкшим сроком приёма заявок. */
  activeOnly?: boolean;
  /**
   * Кэш прочитанных карточек прошлых прогонов. Не задан — каждая процедура
   * добирается запросом (поведение до оптимизации прогона). Можно подключить и
   * позже методом `useCardCache`: адаптер создаёт реестр привязок, а кэш знает
   * скрипт прогона.
   */
  cardCache?: ProcedureCardCache;
  /** Окно свежести карточки в кэше, мс; 0 — не использовать кэш. */
  cardMaxAgeMs?: number;
  /** Источник текущего времени (для детерминированных тестов). */
  nowProvider?: () => Date;
  fetchImpl?: typeof fetch;
}

/**
 * Сколько ответ по номеру процедуры держится в памяти адаптера. Прогон живёт
 * минуты, и ответ внутри него считается свежим всегда; предел нужен долгоживущему
 * процессу, который вызывал бы `fetchTenders` часами.
 */
const CARD_MEMO_TTL_MS = 10 * 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function lower(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

export class RoseltorgTenderSourceAdapter implements TenderSourceAdapter {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sections: readonly number[];
  private readonly maxPages: number;
  private readonly maxResolvePages: number;
  private readonly maxResolves: number;
  private readonly maxRegionalPages: number;
  private readonly activeOnly: boolean;
  private readonly nowProvider: () => Date;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;
  /**
   * Полный набор лотов по номеру процедуры на время прогона. Одну процедуру
   * находят и разные профили, и разные слова одного профиля; запрос по номеру
   * платный (минимум один обращение к площадке), а ответ у них один.
   * Неудачный запрос из памяти убирается — следующий профиль попробует снова.
   */
  private readonly cardMemo = new Map<string, { at: number; found: Promise<ResolvedProcedure> }>();
  private cardCache: ProcedureCardCache | null;
  private cardMaxAgeMs: number;
  private stats: {
    rows: number;
    discovered: number;
    resolved: number;
    reused: number;
    memoized: number;
    incomplete: number;
    kept: number;
    droppedRows: Record<string, number>;
    rejected: Record<string, number>;
    resolveLimitReached: boolean;
  } = emptyStats();

  constructor(options: RoseltorgAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? ROSELTORG_BASE_URL;
    this.minIntervalMs = 1000 / (options.rateLimitPerSec ?? 2);
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sections = options.sections ?? ROSELTORG_DEFAULT_SECTIONS;
    this.maxPages = options.maxPages ?? 5;
    this.maxResolvePages = options.maxResolvePages ?? 10;
    // Не 40: потолок ниже `limit` рабочего профиля означал бы, что выдачу режет
    // страховка, а не настройка профиля. Почему именно 60 — см. maxResolves выше.
    this.maxResolves = options.maxResolves ?? 60;
    this.maxRegionalPages = options.maxRegionalPages ?? 30;
    this.activeOnly = options.activeOnly ?? true;
    this.cardCache = options.cardCache ?? null;
    this.cardMaxAgeMs = options.cardMaxAgeMs ?? CARD_REUSE_MAX_AGE_MS;
    this.nowProvider = options.nowProvider ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Подключает (или отключает, null) кэш карточек прошлых прогонов. */
  useCardCache(cache: ProcedureCardCache | null, maxAgeMs?: number): void {
    this.cardCache = cache;
    if (maxAgeMs !== undefined) this.cardMaxAgeMs = maxAgeMs;
  }

  /** Итог последнего вызова `fetchTenders` — для честной строки в журнале прогона. */
  get filterStats(): RoseltorgFilterStats {
    return {
      rows: this.stats.rows,
      discovered: this.stats.discovered,
      resolved: this.stats.resolved,
      reused: this.stats.reused,
      memoized: this.stats.memoized,
      incomplete: this.stats.incomplete,
      kept: this.stats.kept,
      droppedRows: { ...this.stats.droppedRows },
      rejected: { ...this.stats.rejected },
      resolveLimitReached: this.stats.resolveLimitReached,
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

  async fetchTenders(query: TenderSourceQuery): Promise<Tender[]> {
    const now = this.nowProvider();
    const limit = query.limit ?? 50;
    const filters = prepareFilters(query);
    const keywords = (query.keywords ?? []).map((value) => value.trim()).filter(Boolean);
    // Пустой список слов — это обход секций целиком: площадка отдаёт список без
    // `query_field`, и отменять запрос значило бы молча оставить источник пустым.
    const searches: readonly (string | undefined)[] =
      keywords.length > 0 ? keywords : [undefined];

    const droppedRows: Record<string, number> = {};
    const rejected: Record<string, number> = {};
    /** Номер процедуры → строки, которые нашёл поиск. Порядок первого появления сохранён. */
    const discovered = new Map<string, RoseltorgLotRow[]>();
    let rows = 0;

    const pagesPerKeyword = filters.regions.length > 0 ? this.maxRegionalPages : this.maxPages;
    for (const keyword of searches) {
      for await (const page of this.walkPages({ query: keyword }, pagesPerKeyword)) {
        rows += page.rows.length;
        for (const row of page.rows) {
          const number = row.procedureNumber.trim();
          if (number === "") {
            count(droppedRows, "нет номера в строке выдачи");
            continue;
          }
          // Строку без читаемого срока не отбрасываем: неизвестность — не просрочка.
          if (this.activeOnly && isExpired(row.submissionEnd, now)) {
            count(droppedRows, "срок приёма заявок истёк");
            continue;
          }
          const group = discovered.get(number);
          if (group) group.push(row);
          else discovered.set(number, [row]);
        }
      }
    }

    const kept: Tender[] = [];
    let resolved = 0;
    let reused = 0;
    let memoized = 0;
    let incomplete = 0;
    let resolveLimitReached = false;

    for (const [number, matchedRows] of discovered) {
      if (kept.length >= limit) break;
      // Закон виден из формы номера, поэтому проверяется до запроса: извещение
      // 44-ФЗ профиль отбросит всё равно, а платить за него запросом незачем.
      if (filters.laws.length > 0 && !filters.laws.includes(roseltorgLaw(number))) {
        count(rejected, "закон");
        continue;
      }
      // Регион заказчика напечатан в строке выдачи — проверяем его тоже до
      // запроса: иначе предел карточек уходил на закупки других регионов.
      // Причины те же, что дала бы проверка после добора лотов.
      if (filters.regions.length > 0) {
        const rowRegion = regionFromAddress(matchedRows[0]?.region ?? "");
        if (!isRegionKnown(rowRegion)) {
          count(rejected, "регион не определён");
          continue;
        }
        if (!filters.regions.some((wanted) => isSameRegion(wanted, rowRegion))) {
          count(rejected, "регион");
          continue;
        }
      }

      let tender: Tender | undefined;
      // Карточка, прочитанная в прошлых прогонах недавно, а строка выдачи не
      // показала перемен: запрос по номеру не нужен вовсе.
      const cached = this.reusableCard(number, matchedRows, now);
      if (cached !== null) {
        reused += 1;
        tender = {
          ...cached,
          // Предмет — по совпавшему лоту ЭТОГО запроса, как у свежего маппинга.
          subject: matchedRows[0]?.subject.trim() || cached.subject,
        };
      } else {
        // Предел считает настоящие запросы: ответ из памяти прогона платить не
        // заставляет, и обход идёт дальше, не отбрасывая «бесплатные» процедуры.
        if (this.hasFreshMemo(number)) {
          memoized += 1;
        } else {
          if (resolved >= this.maxResolves) {
            resolveLimitReached = true;
            continue;
          }
          resolved += 1;
        }

        const found = await this.resolveProcedureMemo(number);
        // Площадка не вернула ни одной строки номера — например, процедуру сняли,
        // пока шёл обход. Выбрасывать её не за что: поиск её показал, значит, она
        // есть, а неполный набор лотов означает «цена не опубликована».
        const usedMatched = found.rows.length === 0;
        const lots = usedMatched ? matchedRows : found.rows;
        const complete = found.complete && !usedMatched;
        if (!complete) incomplete += 1;

        [tender] = mapRoseltorgRows(lots, {
          matchedLots: matchedRows,
          incompleteProcedures: complete ? undefined : new Set([number]),
        });
        // В кэш идёт только полностью прочитанная карточка: у неполной цена не
        // публикуется, и её стоит перечитать, а не повторять.
        if (tender !== undefined && complete) {
          this.cardCache?.set(number, {
            fetchedAt: this.nowProvider().getTime(),
            complete: true,
            tender,
            lastLotEndMs: null,
          });
        }
      }
      if (tender === undefined) continue;

      const reason = rejectionReason(tender, filters);
      if (reason !== null) {
        count(rejected, reason);
        continue;
      }
      kept.push(tender);
    }

    this.stats = {
      rows,
      discovered: discovered.size,
      resolved,
      reused,
      memoized,
      incomplete,
      kept: kept.length,
      droppedRows,
      rejected,
      resolveLimitReached,
    };
    return kept;
  }

  async fetchTenderById(tenderId: string): Promise<Tender | null> {
    const number = roseltorgProcedureNumber(tenderId);
    if (number === "") return null;
    const found = await this.resolveProcedure(number);
    // Пустой ответ — это «площадка номера не вернула», а не «закупка пуста»:
    // подставлять строки чужих процедур значит показать карточку чужой закупки.
    if (found.rows.length === 0) return null;
    const [tender] = mapRoseltorgRows(found.rows, {
      incompleteProcedures: found.complete ? undefined : new Set([number]),
    });
    return tender ?? null;
  }

  /**
   * Документов нет, и это ответ, а не заглушка.
   *
   * Файлы Росэлторга лежат на `com.roseltorg.ru/file/get/…`, а `robots.txt` того
   * хоста запрещает всё (`Disallow: /`, разрешена только корневая страница).
   * Прокси того же пути на `www` отвечает 404 — проверено 02.10.2026 на
   * `/file/get/t/ProcedureDocuments/id/1041743`.
   *
   * Соблазн вернуть ссылку на карточку как документ с `type: "NOTICE"` здесь уже
   * был и это ложь в самом дорогом месте: разъём обещает документы, потребитель их
   * скачивает и разбирает, и вместо текста закупки в платный разбор уезжает
   * навигация площадки. Причина показывается там, где её уже знают, — в каталоге
   * источников (`src/domain/sources.ts`, поле `documentsReason`).
   */
  async fetchDocuments(_tenderId: string): Promise<TenderDocument[]> {
    return [];
  }

  /**
   * Изменилась ли процедура с переданного момента.
   *
   * Даты публикации и последнего изменения в строке выдачи нет вовсе, поэтому
   * сравнивается срок окончания приёма заявок: сдвинутый срок — то событие, ради
   * которого владелец и хочет знать об изменении. Правку документации этот метод
   * не видит, и молчать об этом значит обещать больше, чем площадка позволяет.
   */
  async checkChanges(tenderId: string, since: string): Promise<boolean> {
    const sinceDate = new Date(since);
    // Дату, которую не удалось прочитать, нельзя ни расширить, ни сузить: любой
    // ответ здесь был бы выдуман. Пропускаем запрос и говорим «изменений нет».
    if (Number.isNaN(sinceDate.getTime())) return false;

    const tender = await this.fetchTenderById(tenderId);
    if (tender === null) return false;
    const deadline = new Date(tender.deadlines.submissionEnd).getTime();
    if (Number.isNaN(deadline)) return false;
    return deadline > sinceDate.getTime();
  }

  /** Ответ по номеру процедуры уже есть в памяти прогона и ещё свеж. */
  private hasFreshMemo(procedureNumber: string): boolean {
    const hit = this.cardMemo.get(procedureNumber);
    return hit !== undefined && Date.now() - hit.at < CARD_MEMO_TTL_MS;
  }

  /** Полный набор лотов с памятью прогона: вторая просьба о том же номере запроса не делает. */
  private resolveProcedureMemo(procedureNumber: string): Promise<ResolvedProcedure> {
    const hit = this.cardMemo.get(procedureNumber);
    if (hit !== undefined && Date.now() - hit.at < CARD_MEMO_TTL_MS) return hit.found;
    const entry = { at: Date.now(), found: this.resolveProcedure(procedureNumber) };
    this.cardMemo.set(procedureNumber, entry);
    entry.found.catch(() => {
      if (this.cardMemo.get(procedureNumber) === entry) this.cardMemo.delete(procedureNumber);
    });
    return entry.found;
  }

  /**
   * Закупка из кэша, если карточку можно не перечитывать; иначе null.
   *
   * Правило осторожное: любое сомнение — «читать». Берётся только полностью
   * прочитанная карточка не старше окна свежести, и каждая совпавшая строка
   * выдачи должна сходиться с сохранённой закупкой: тот же срок приёма заявок (до
   * момента), тот же регион, лот с тем же номером, предметом и ценой. Сдвинутый
   * срок или изменённая цена лота — признак, что процедуру правили, и кэш не
   * используется. Лоты, которых строка выдачи не показывает (поиск по слову
   * возвращает совпавшие), могли измениться — это допущение окна свежести.
   */
  private reusableCard(
    procedureNumber: string,
    matchedRows: readonly RoseltorgLotRow[],
    now: Date,
  ): Tender | null {
    const cache = this.cardCache;
    if (cache === null || this.cardMaxAgeMs <= 0) return null;
    const card = cache.get(procedureNumber);
    if (card === undefined || !card.complete) return null;
    if (!isCardFresh(card, now.getTime(), this.cardMaxAgeMs)) return null;
    const tender = card.tender;
    if (tender.dataSource !== "ROSELTORG") return null;
    if (matchedRows.length === 0) return null;

    for (const row of matchedRows) {
      if (!sameInstant(row.submissionEnd, tender.deadlines.submissionEnd)) return null;
      if (row.region.trim() !== "" && regionFromAddress(row.region) !== tender.region) return null;
      const lot = tender.lots.find((candidate) =>
        row.lotNumber !== null
          ? candidate.number === row.lotNumber
          : normalizeLotText(candidate.subject) === normalizeLotText(row.subject),
      );
      if (lot === undefined) return null;
      if (normalizeLotText(lot.subject) !== normalizeLotText(row.subject)) return null;
      if ((row.price ?? 0) !== lot.price) return null;
    }
    return tender;
  }

  /**
   * Полный набор лотов одной процедуры.
   *
   * Статусы в этот запрос намеренно не передаются: фильтр `status[]` площадка
   * применяет к строке выдачи, то есть к лоту, и часть лотов одной процедуры могла
   * бы не вернуться. Тогда сумма оказалась бы заниженной при формально полном
   * обходе — именно та ошибка, ради которой добор лотов вообще затеян.
   */
  private async resolveProcedure(procedureNumber: string): Promise<ResolvedProcedure> {
    const rows: RoseltorgLotRow[] = [];
    let complete = true;

    for (let page = 0; ; page += 1) {
      const result = await this.requestPage({
        page,
        sections: this.sections,
        query: procedureNumber,
      });
      // Поиск по номеру может вернуть и соседние процедуры: `query_field` — это
      // подстрока, а не точное совпадение. Чужие строки в закупку не берутся.
      for (const row of result.rows) {
        if (row.procedureNumber.trim() === procedureNumber) rows.push(row);
      }

      if (!result.hasNextPage) break;
      // Предел страниц — единственный случай, когда набор лотов считается неполным:
      // остановиться раньше, чем площадка перестала звать «Далее», значит выдать
      // сумму части лотов за сумму закупки.
      if (page + 1 >= this.maxResolvePages) {
        complete = false;
        break;
      }
    }

    return { rows, complete };
  }

  /** Обход страниц поиска: генератор, чтобы условие остановки было в одном месте. */
  private async *walkPages(
    params: Omit<RoseltorgSearchParams, "page" | "sections" | "statuses">,
    maxPages: number,
  ): AsyncGenerator<RoseltorgSearchPage> {
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.requestPage({
        ...params,
        page,
        sections: this.sections,
        statuses: ROSELTORG_OPEN_STATUSES,
      });
      yield result;
      // Два признака конца, и оба — слова площадки: «Нет результатов» на странице
      // вне диапазона (так она ответила на `page=5000`) и отсутствие кнопки «Далее»
      // на последней. Длину страницы признаком не считаем: 10 строк на страницу
      // площадка держит всегда, а решить за неё, что короткая страница последняя,
      // значит молча недосмотреть выдачу. Предел `maxPages` обход ограничивает.
      if (result.noResults || !result.hasNextPage) return;
    }
  }

  /**
   * Один запрос фрагмента выдачи с повторами.
   *
   * Повторяются сбой транспорта (пустое тело), HTTP-код ошибки и ответ не тем
   * форматом — полная HTML-страница вместо фрагмента. Последнее обязательно
   * отличать от пустой выдачи: страница антибота или заглушки провайдера
   * разбирается в ноль строк, и прогон напечатал бы «новых закупок: 0» вместо
   * причины.
   */
  private async requestPage(params: RoseltorgSearchParams): Promise<RoseltorgSearchPage> {
    const url = roseltorgSearchUrl(params, this.baseUrl);
    let attempt = 0;
    for (;;) {
      await this.throttle();
      const response = await this.fetchImpl(url, {
        headers: { ...REQUEST_HEADERS },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      if (response.ok && looksLikeSearchFragment(text)) return parseRoseltorgSearch(text);
      if (attempt >= this.maxRetries) {
        throw new RoseltorgResponseError(
          response.ok
            ? `Росэлторг вернул вместо фрагмента выдачи ответ, который не разбирается (${url}).`
            : `Росэлторг ответил HTTP ${response.status} на запрос поиска (${url}).`,
        );
      }
      attempt += 1;
      await sleep(RETRY_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

function emptyStats() {
  return {
    rows: 0,
    discovered: 0,
    resolved: 0,
    reused: 0,
    memoized: 0,
    incomplete: 0,
    kept: 0,
    droppedRows: {} as Record<string, number>,
    rejected: {} as Record<string, number>,
    resolveLimitReached: false,
  };
}

/** Похоже ли тело на фрагмент списка: пустой список и «Нет результатов» — оба да. */
function looksLikeSearchFragment(text: string): boolean {
  const body = text.trim();
  if (body === "") return false;
  return body.includes("search-results") || body.includes("search-autocomplete__no-result");
}

/** Срок приёма заявок уже прошёл. Пустая и нечитаемая дата просрочкой не считаются. */
function isExpired(submissionEnd: string, now: Date): boolean {
  if (submissionEnd.trim() === "") return false;
  const deadline = new Date(submissionEnd).getTime();
  if (Number.isNaN(deadline)) return false;
  return deadline <= now.getTime();
}

function count(target: Record<string, number>, reason: RowRejection | TenderRejection): void {
  target[reason] = (target[reason] ?? 0) + 1;
}

function prepareFilters(query: TenderSourceQuery): PreparedFilters {
  return {
    laws: query.laws,
    regions: lower(query.regions),
    customerInns: (query.customerInns ?? []).map((value) => value.trim()).filter(Boolean),
    minPrice: query.minPrice ?? null,
    maxPrice: query.maxPrice ?? null,
  };
}

/**
 * Отбор, который площадка в запросе не поддерживает: регион, цена и ИНН заказчика.
 *
 * Закона здесь нет — он проверен до запроса по номеру (`roseltorgLaw`).
 *
 * Ключевых слов здесь тоже нет намеренно. Площадка уже отобрала строки по слову,
 * и совпадение могло оказаться в поле, которого мы не получаем (например, в тексте
 * документации). Перепроверка отбросила бы законную находку, а объяснить владельцу
 * «мы нашли, но сами же и выбросили» нельзя.
 */
function rejectionReason(tender: Tender, filters: PreparedFilters): TenderRejection | null {
  if (filters.regions.length > 0) {
    // Неопределённый регион считается отдельно: это не «другой регион», а
    // неизвестность, и в журнале она должна быть видна своим числом.
    if (!isRegionKnown(tender.region)) return "регион не определён";
    if (!filters.regions.some((wanted) => isSameRegion(wanted, tender.region))) return "регион";
  }

  // Цена 0 означает «не опубликована», а не «бесплатно»: у «Росэлторг.Бизнес» блока
  // суммы в строке нет вовсе, и лимит профиля такие закупки не отсекает.
  const price = tender.financial.price;
  if (isPriceKnown(price)) {
    if (filters.minPrice !== null && price < filters.minPrice) return "цена";
    if (filters.maxPrice !== null && price > filters.maxPrice) return "цена";
  }

  // Список выдачи печатает организатора, а не заказчика: у корпоративных секций
  // это обычно одно лицо, но при несовпадении ИНН фильтр отбросит закупку, и это
  // правильно — профиль ищет закупки конкретного заказчика.
  if (filters.customerInns.length > 0) {
    const inn = tender.customerInn?.trim() ?? "";
    if (inn === "" || !filters.customerInns.includes(inn)) return "заказчик";
  }

  return null;
}
