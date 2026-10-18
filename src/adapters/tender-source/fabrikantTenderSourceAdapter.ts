/**
 * Адаптер источника данных «Фабрикант» (223-ФЗ, коммерческие и корпоративные секции).
 *
 * Работает ТОЛЬКО на сервере (Node). Использует публичный поиск площадки
 * `GET https://www.fabrikant.ru/procedure/search/purchases` и карточку процедуры
 * `GET https://www.fabrikant.ru/v2/trades/procedure/view/{id}` — оба без ключа и
 * без регистрации. `robots.txt` хоста `www.fabrikant.ru` запрещает 164 пути и не
 * разрешает ни одного явно, но ни одно из его правил не совпадает с этими двумя
 * адресами: правила для `/trades/*` требуют параметра `actions=`, а правила
 * `/*?action=*` — `action=`, ни того ни другого мы не отправляем (проверено
 * живыми запросами 02.10.2026, см. `docs/REFERENCE_PLATFORM_PROBES.md`, раздел
 * «Четвёртая волна»).
 *
 * Пять особенностей площадки, из-за которых адаптер устроен именно так:
 *
 * 1. **Строка выдачи — это лот, а не закупка.** Живой замер: 40 строк на странице
 *    относятся к 24 процедурам. Сложить цены найденных строк значило бы показать
 *    часть закупки, поэтому полный набор лотов добирается карточкой.
 *
 * 2. **Карточка печатает по пять лотов на страницу.** Число лотов знает только
 *    счётчик вкладки «Список лотов»; процедура с 18 лотами отдаёт на первой
 *    странице пять. Если собрать все страницы не удалось, цена не публикуется
 *    вовсе: сумма пяти лотов из восемнадцати прошла бы лимит профиля и показала
 *    владельцу закупку втрое дешевле настоящей.
 *
 * 3. **В строке выдачи нет ни срока, ни цены.** Срок приёма заявок площадка
 *    печатает только в карточке лота, поэтому просрочка отсеивается после добора
 *    лотов, а не до него. Процедура считается живой, пока жив хотя бы один лот.
 *
 * 4. **Границы цены площадке не отправляются.** `price_from` и `price_to` она
 *    принимает, но не замерено, отбрасывает ли серверный фильтр закупки
 *    «Без указания цены». Молча потерять их нельзя — правило «отфильтрованная
 *    закупка показывает причину» относится и к тем, которые мы вовсе не увидели.
 *    Поэтому отсев локальный, с правилом «неизвестная цена лимитом не отсекается».
 *    Параметр `customer_region_ids[]` не используется по той же причине: он
 *    фильтрует по региону заказчика, а не по месту поставки, и закупка с поставкой
 *    в нужный субъект исчезла бы без следа.
 *
 * 5. **Документов нет.** Вкладка «Документация» отдаёт байты без авторизации по
 *    адресу `/v2/trades/procedure/documentation/download/single/…`, но он отвечает
 *    302 на `storage.fabrikant.ru`, а `robots.txt` того хоста — `Disallow: /`.
 *    Переход по редиректу на запрещённый хост — ровно то, от чего мы отказались
 *    у ГПБ и Росэлторга. `fetchDocuments` возвращает пустой список и не делает
 *    запроса: ссылка на карточку под видом документа уехала бы в платный разбор
 *    как текст закупки. Причина показывается в каталоге источников
 *    (`src/domain/sources.ts`, поле `documentsReason`).
 *
 * Личных данных адаптер не видит вовсе: парсер карточки вырезает панель контактов
 * и подписанные площадкой блоки с именем и телефоном сотрудника до разбора, а не
 * после него.
 */
import type { Tender, TenderDocument } from "@/domain/entities";
import { isPriceKnown, isRegionKnown } from "@/domain/entities";
import { isSameRegion } from "@/domain/regionCodes";
import {
  CARD_REUSE_MAX_AGE_MS,
  isCardFresh,
  normalizeLotText,
  type CachedCard,
  type ProcedureCardCache,
} from "@/domain/cardReuse";
import type { TenderLaw } from "@/domain/enums";
import type { TenderSourceAdapter, TenderSourceQuery } from "@/adapters/types";
import {
  FABRIKANT_BASE_URL,
  FABRIKANT_DEFAULT_SECTIONS,
  FABRIKANT_OPEN_STATUSES,
  fabrikantHasNextPage,
  fabrikantSearchUrl,
  isFabrikantSearchPage,
  parseFabrikantRegions,
  parseFabrikantSearch,
} from "@/adapters/tender-source/fabrikantSearch";
import type {
  FabrikantLotRow,
  FabrikantRegion,
  FabrikantSearchParams,
  FabrikantSearchPage,
} from "@/adapters/tender-source/fabrikantSearch";
import {
  fabrikantCardPageCount,
  fabrikantCardPageUrl,
  fabrikantCardUrlKind,
  isFabrikantCardPage,
  isFabrikantCardUrl,
  parseFabrikantCard,
} from "@/adapters/tender-source/fabrikantCard";
import type {
  FabrikantCard,
  FabrikantCardUrlKind,
} from "@/adapters/tender-source/fabrikantCard";
import {
  fabrikantLawFromRow,
  mapFabrikantProcedure,
} from "@/adapters/tender-source/fabrikantMapper";

/** Задержка первого повтора; каждый следующий вдвое дольше. */
const RETRY_BACKOFF_MS = 300;

/**
 * Причина пропуска строки выдачи — по виду её адреса.
 *
 * Разные хосты означают разное. Строка, ведущая в ЕИС, не потеря: то же
 * извещение приносит адаптер реестра и приносит вместе с документами, которых
 * Фабрикант не отдаёт вовсе. «Маркет», секция Росатома и секция 44-ФЗ — потеря
 * настоящая, но и её видно отдельным счётчиком, а не в общей куче, где владелец
 * не отличил бы дубль от пробела.
 *
 * Значение для `v2` не печатается никогда: такие строки не пропускают. В наборе
 * оно есть, чтобы вид адреса и причина не могли разойтись молча — добавят новый
 * вид, тип потребует и новую причину.
 */
const DROP_REASONS = {
  v2: "карточка на публичном хосте",
  eis: "строка ведёт в ЕИС — закупку приносит адаптер реестра",
  market: "карточка на «Маркете»: другой хост и путь",
  atom: "карточка в секции Росатома",
  fz44: "карточка в секции 44-ФЗ",
  other: "карточка вне публичного хоста",
} as const satisfies Readonly<Record<FabrikantCardUrlKind, string>>;

/**
 * Заголовки обычного браузерного GET.
 *
 * Зонд 02.10.2026 прошёл вообще без них: площадка не проверяет ни `Referer`, ни
 * `X-Requested-With`. Набор минимальный и совпадает с адаптерами Сбербанк-АСТ и
 * Росэлторга — добавлять непроверенное значит рисковать рабочим запросом ради
 * правдоподобия.
 */
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9",
};

/**
 * Префикс ключа записи.
 *
 * Один и тот же префикс снимает и внутренний id (`fabrikant-5582388`), и номер в
 * базе (`FABRIKANT-5582388`): различается только регистром.
 */
const PLATFORM_ID_PREFIX = /^fabrikant-/i;

/**
 * Номер, по которому площадка ищет закупку: свой или ЕИС.
 *
 * Это два разных пространства номеров, и в базу ключом записи попадает номер ЕИС,
 * если он есть (`fabrikantRegNumber`). Зонд 02.10.2026 проверил оба: выдача
 * находит процедуру и по `5582388`, и по `32616433843`. Пустая строка означает
 * «спрашивать нечего» — запрос без номера вернул бы произвольную страницу выдачи.
 */
export function fabrikantTenderNumber(tenderId: string): string {
  return tenderId.trim().replace(PLATFORM_ID_PREFIX, "");
}

/** Площадка ответила не тем: HTTP-код ошибки, пустое тело или чужая страница. */
export class FabrikantResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FabrikantResponseError";
  }
}

/**
 * Причина, по которой строка выдачи не дошла до группировки.
 *
 * Причины по виду адреса берутся из `DROP_REASONS`, а не повторяются здесь
 * словами: новый вид адреса обязан добавить и причину, иначе тип не сойдётся.
 *
 * Номера процедуры в этом списке нет намеренно: строку без номера парсер выдачи
 * не отдаёт вовсе — ею площадка печатает объект-приманку, в котором есть `url` и
 * `lotId`, но нет `procedureNumber`.
 */
type RowRejection = "нет адреса карточки" | (typeof DROP_REASONS)[FabrikantCardUrlKind];

/**
 * Причина, по которой закупка не попала в выдачу.
 *
 * «Срок подачи заявок не напечатан» — не отсев по профилю, а признание, что
 * строку нельзя записать: `tenders.submission_end` объявлен NOT NULL. Причину
 * важно считать отдельно от просрочки — иначе владелец увидел бы «истёк» там,
 * где площадка дату не напечатала вовсе.
 */
type TenderRejection =
  | "закон"
  | "регион"
  | "регион не определён"
  | "цена"
  | "заказчик"
  | "срок приёма заявок истёк"
  | "срок подачи заявок не напечатан"
  | "карточка не разобрана";

/** Отбор, который площадка в запросе не поддерживает. */
interface PreparedFilters {
  readonly laws: readonly TenderLaw[];
  readonly regions: readonly string[];
  readonly customerInns: readonly string[];
  readonly minPrice: number | null;
  readonly maxPrice: number | null;
}

/**
 * Сколько строк отдала выдача и сколько из них дошло до владельца.
 *
 * Журнал прогона обязан различать «площадка ничего не отдала» и «мы отбросили»:
 * ноль в обоих случаях выглядит одинаково, а означает разное. Счётчики описывают
 * осмотренное окно, а не всю выдачу площадки: обход останавливается на `limit`, и
 * неосмотренные процедуры в `rejected` не попадают.
 */
export interface FabrikantFilterStats {
  /** Строк выдачи прочитано. Строка — это лот, а не закупка. */
  readonly rows: number;
  /** Различных номеров процедур в этих строках, у которых есть адрес карточки. */
  readonly discovered: number;
  /** Процедур из найденных, у которых есть номер извещения в ЕИС. */
  readonly withEisNumber: number;
  /** Процедур, по которым запрошена карточка (настоящие запросы к площадке). */
  readonly resolved: number;
  /**
   * Процедур, карточки которых взяты из кэша прошлых прогонов без запроса:
   * прочитаны недавно, срок не истёк, строка выдачи перемен не показала
   * (см. `cardReuse.ts`).
   */
  readonly reused: number;
  /**
   * Процедур, карточку которых этот прогон уже читал для другого профиля или
   * слова: повторного запроса нет, берётся тот же ответ.
   */
  readonly memoized: number;
  /** Процедур, у которых набор лотов остался неполным: цена не публикуется. */
  readonly incomplete: number;
  /** Закупок в выдаче после отбора и обрезки по `limit`. */
  readonly kept: number;
  /** Строки, отброшенные до группировки: причина → число строк. */
  readonly droppedRows: Readonly<Record<string, number>>;
  /** Закупки, отброшенные отбором: причина → число закупок. */
  readonly rejected: Readonly<Record<string, number>>;
  /** Обход остановлен пределом запросов карточек: часть процедур не осмотрена. */
  readonly resolveLimitReached: boolean;
  /**
   * Ключевых слов, по которым площадка ответила страницей с ограниченным
   * доступом: «Доступ к просмотру процедуры ограничен … авторизуйтесь на ЭТП».
   *
   * Это не сбой и не пустота: закупки площадка нашла и не показала их без входа.
   * Без отдельного счётчика такой ответ выглядел бы в журнале как «по этому слову
   * ничего нет», то есть как факт о рынке, а не как правило площадки.
   */
  readonly restrictedKeywords: number;
  /**
   * Ключевых слов, по которым площадка не ответила вовсе: сбой транспорта,
   * HTTP-код ошибки или чужая страница вместо выдачи.
   *
   * Вызов не падает, пока ответил хотя бы один запрос: потерянный профиль стоит
   * дороже, чем частичная выдача с названной причиной. Падает он только тогда,
   * когда не ответило ни одно слово, — это сбой источника, а не пустая выдача.
   */
  readonly failedKeywords: number;
  /**
   * Процедур, найденных проходом по региону заказчика (`customer_region_ids[]`).
   * Ноль при заданном регионе и `regionFilterFailed` — справочник площадки не
   * прочитался, и регион искался только отбором общероссийской выдачи.
   */
  readonly regional: number;
  readonly regionFilterFailed: boolean;
}

/** Процедура, которую показала выдача. */
interface DiscoveredProcedure {
  readonly number: string;
  /** Первая строка группы: по её адресу карточки идёт добор лотов. */
  readonly row: FabrikantLotRow;
  /** У процедуры есть номер извещения в ЕИС. */
  readonly publishedInEis: boolean;
  /** Найдена проходом по региону заказчика. */
  readonly regional: boolean;
}

/** Все страницы карточки одной процедуры и уверенность, что лоты собраны все. */
interface ResolvedProcedure {
  readonly cards: readonly FabrikantCard[];
  readonly lotsComplete: boolean;
}

export interface FabrikantAdapterOptions {
  /** Хост площадки. По умолчанию — боевой. */
  baseUrl?: string;
  /** Ограничение запросов в секунду. */
  rateLimitPerSec?: number;
  /** Максимум повторов при сбое транспорта или ответе не тем форматом. */
  maxRetries?: number;
  /** Таймаут одного запроса. Страница выдачи — около 700 КБ, карточка — около 200 КБ. */
  timeoutMs?: number;
  /** Секции площадки (`section_ids[]`). По умолчанию — без «Маркета» и 44-ФЗ. */
  sections?: readonly number[];
  /** Статусы (`statuses[]`). По умолчанию — приём заявок. */
  statuses?: readonly number[];
  /** Максимум страниц выдачи на одно ключевое слово. */
  maxPages?: number;
  /**
   * Максимум страниц карточки на одну процедуру.
   *
   * Страница карточки держит пять лотов, поэтому 4 покрывают процедуру с 20 лотами.
   * Живой замер 02.10.2026: у осмотренных процедур было до 18 лотов. Предел не
   * скрывается — процедура, у которой страниц не хватило, выходит без цены, а
   * счётчик `incomplete` виден в журнале прогона.
   */
  maxCardPages?: number;
  /**
   * Максимум процедур, по которым добираются лоты, на один вызов `fetchTenders`.
   *
   * Предел нужен потому, что каждая процедура — это один и более запросов карточки,
   * а обход выдачи останавливается на `limit` не всегда: если профиль отсекает
   * много, осмотреть придётся больше процедур, чем попадёт в выдачу. Значение по
   * умолчанию обязано быть не меньше `limit` рабочего профиля, иначе выдачу режет
   * страховочный потолок, а не настройка профиля.
   */
  maxResolves?: number;
  /**
   * Сколько карточек сверх `maxResolves` разрешено на процедуры, найденные по
   * региону заказчика. Их немного (по «ремонту» в Бурятии — 26 против 127 тысяч
   * по России, 05.10.2026), и каждая почти наверняка нужна профилю, поэтому общий
   * потолок на них не тратится.
   */
  maxRegionalResolves?: number;
  /** Страниц выдачи на слово в проходе по региону заказчика. */
  maxRegionalPages?: number;
  /** Оставлять только закупки, у которых жив хотя бы один лот. */
  activeOnly?: boolean;
  /**
   * Кэш прочитанных карточек прошлых прогонов. Не задан — каждая процедура
   * читается запросом (поведение до оптимизации прогона). Можно подключить и
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
 * Сколько ответ по карточке держится в памяти адаптера. Прогон живёт минуты, и
 * ответ внутри него считается свежим всегда; предел нужен долгоживущему процессу,
 * который вызывал бы `fetchTenders` часами.
 */
const CARD_MEMO_TTL_MS = 10 * 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function lower(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

export class FabrikantTenderSourceAdapter implements TenderSourceAdapter {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sections: readonly number[];
  private readonly statuses: readonly number[];
  private readonly maxPages: number;
  private readonly maxCardPages: number;
  private readonly maxResolves: number;
  private readonly maxRegionalResolves: number;
  private readonly maxRegionalPages: number;
  /** Справочник регионов площадки: читается один раз за жизнь адаптера (прогон). */
  private regionDirectory: Promise<readonly FabrikantRegion[]> | null = null;
  private readonly activeOnly: boolean;
  private readonly nowProvider: () => Date;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAt = 0;
  /**
   * Карточки процедур на время прогона, ключ — адрес карточки. Одну процедуру
   * находят и разные профили, и разные слова одного профиля, а карточка — до
   * четырёх запросов на процедуру; ответ у них один. Неудачное чтение из памяти
   * убирается: следующий профиль попробует снова, а не получит ту же ошибку.
   */
  private readonly cardMemo = new Map<string, { at: number; found: Promise<ResolvedProcedure> }>();
  private cardCache: ProcedureCardCache | null;
  private cardMaxAgeMs: number;
  private stats = emptyStats();

  constructor(options: FabrikantAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? FABRIKANT_BASE_URL;
    this.minIntervalMs = 1000 / (options.rateLimitPerSec ?? 2);
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sections = options.sections ?? [...FABRIKANT_DEFAULT_SECTIONS];
    this.statuses = options.statuses ?? [...FABRIKANT_OPEN_STATUSES];
    this.maxPages = options.maxPages ?? 5;
    this.maxCardPages = options.maxCardPages ?? 4;
    this.maxResolves = options.maxResolves ?? 60;
    this.maxRegionalResolves = options.maxRegionalResolves ?? 120;
    this.maxRegionalPages = options.maxRegionalPages ?? 10;
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
  get filterStats(): FabrikantFilterStats {
    return {
      rows: this.stats.rows,
      discovered: this.stats.discovered,
      withEisNumber: this.stats.withEisNumber,
      resolved: this.stats.resolved,
      reused: this.stats.reused,
      memoized: this.stats.memoized,
      incomplete: this.stats.incomplete,
      kept: this.stats.kept,
      droppedRows: { ...this.stats.droppedRows },
      rejected: { ...this.stats.rejected },
      resolveLimitReached: this.stats.resolveLimitReached,
      restrictedKeywords: this.stats.restrictedKeywords,
      failedKeywords: this.stats.failedKeywords,
      regional: this.stats.regional,
      regionFilterFailed: this.stats.regionFilterFailed,
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
    // Сброс до первого запроса, а не только в конце: сорвавшийся вызов не имеет
    // права оставить в `filterStats` числа предыдущего профиля (см. `emptyStats`).
    this.stats = emptyStats();
    const now = this.nowProvider();
    const limit = query.limit ?? 50;
    const filters = prepareFilters(query);
    const keywords = (query.keywords ?? []).map((value) => value.trim()).filter(Boolean);
    // Пустой список слов — это обход секций целиком: площадка отдаёт список без
    // `query`, и отменять запрос значило бы молча оставить источник пустым.
    const searches: readonly (string | undefined)[] =
      keywords.length > 0 ? keywords : [undefined];

    const droppedRows: Record<string, number> = {};
    const rejected: Record<string, number> = {};
    /** Номер процедуры → первая строка, которая к ней привела. */
    const discovered = new Map<string, DiscoveredProcedure>();
    let rows = 0;
    let restrictedKeywords = 0;
    let failedKeywords = 0;
    let lastFailure: Error | null = null;

    /*
      Регион профиля. Площадка ищет по слову по всей России, а предел карточек
      кончался на закупках других регионов: по Бурятии, Забайкалью и Иркутской
      области прогон 05.10.2026 не нашёл ни одной. Поэтому сначала проход по
      региону заказчика — его коды берутся из справочника площадки, — затем, как
      прежде, общероссийский: закупка московского заказчика с поставкой в регион
      найдётся там. Регион поставки проверяется по карточке в любом случае.
    */
    let regionIds: string[] = [];
    let regionFilterFailed = false;
    if (filters.regions.length > 0) {
      try {
        regionIds = await this.regionIdsFor(filters.regions);
      } catch {
        regionFilterFailed = true;
      }
    }
    const passes: ReadonlyArray<{ regional: boolean; customerRegionIds?: string[]; maxPages: number }> = [
      ...(regionIds.length > 0
        ? [{ regional: true, customerRegionIds: regionIds, maxPages: this.maxRegionalPages }]
        : []),
      { regional: false, maxPages: this.maxPages },
    ];

    for (const keyword of searches) {
      // Обход слов независим: отказ по одному не отменяет выдачу по остальным.
      // Живой прогон 02.10.2026 потерял так весь профиль «Компьютеры и
      // оргтехника»: исключение по слову «МФУ» вылетело из `fetchTenders` и унесло
      // уже собранные результаты четырёх других слов. Причина не прячется —
      // счётчики ниже попадают в строку журнала прогона.
      let restricted = false;
      let failedPasses = 0;
      for (const pass of passes) {
        try {
          const params = {
            query: keyword,
            ...(pass.customerRegionIds ? { customerRegionIds: pass.customerRegionIds } : {}),
          };
          for await (const page of this.walkSearch(params, pass.maxPages)) {
            if (page.restricted) restricted = true;
            rows += page.rows.length;
            for (const row of page.rows) {
              if (row.cardUrl.trim() === "") {
                count(droppedRows, "нет адреса карточки");
                continue;
              }
              // «Маркет», секция Росатома, секция 44-ФЗ и извещения ЕИС ведут на
              // другие хосты и другие пути, которые парсер карточки не понимает.
              // Пропускаем со счётчиком по виду адреса, а не пробуем.
              const kind = fabrikantCardUrlKind(row.cardUrl);
              if (kind !== "v2") {
                count(droppedRows, DROP_REASONS[kind]);
                continue;
              }
              const number = row.procedureNumber.trim();
              if (discovered.has(number)) continue;
              discovered.set(number, {
                number,
                row,
                publishedInEis: (row.eisNumber ?? "").trim() !== "",
                regional: pass.regional,
              });
            }
          }
        } catch (err) {
          failedPasses += 1;
          lastFailure = err instanceof Error ? err : new FabrikantResponseError(String(err));
        }
      }
      // Слово не опрошено, только если не ответил ни один проход: сбой прохода по
      // региону при живом общероссийском — потеря точности, а не потеря слова.
      if (failedPasses === passes.length) failedKeywords += 1;
      if (restricted) restrictedKeywords += 1;
    }

    // Не ответил ни один запрос — это сбой источника, а не пустая выдача. Молча
    // вернуть пустой список значило бы напечатать в журнале «найдено 0» вместо
    // причины: профиль, по которому площадка не ответила вовсе, и профиль, по
    // которому у неё действительно ничего нет, выглядели бы одинаково.
    if (failedKeywords === searches.length && lastFailure !== null) throw lastFailure;

    // Процедуры без номера ЕИС вперёд. Закупку с номером извещения принесёт адаптер
    // реестра, и приоритет источника всё равно оставит его версию: тратить предел
    // запросов карточек на дубли значит остаться без коммерческих закупок, которых
    // в реестре нет вовсе. Сортировка устойчива, поэтому внутри группы порядок
    // выдачи сохранён.
    // Найденные по региону — первыми: ради них профиль и задан.
    const ordered = [...discovered.values()].sort(
      (left, right) =>
        Number(right.regional) - Number(left.regional) ||
        Number(left.publishedInEis) - Number(right.publishedInEis),
    );

    const kept: Tender[] = [];
    let resolved = 0;
    let resolvedRegional = 0;
    let reused = 0;
    let memoized = 0;
    let incomplete = 0;
    let resolveLimitReached = false;

    for (const procedure of ordered) {
      if (kept.length >= limit) break;
      // Закон часто виден до запроса карточки: извещение 44-ФЗ профиль отбросит всё
      // равно, а платить за него запросом незачем. Решает только явное свидетельство
      // — форма номера ЕИС или слово секции. Строка без слова секции (RSC присылает
      // "$undefined") доходит до карточки: отбросить её значило бы молча потерять
      // закупку, закон которой площадка печатает в панели.
      if (filters.laws.length > 0) {
        const rowLaw = fabrikantLawFromRow(procedure.row);
        if (rowLaw !== null && !filters.laws.includes(rowLaw)) {
          count(rejected, "закон");
          continue;
        }
      }

      let tender: Tender | null;
      let lastLotEndMs: number | null;
      // Карточка, прочитанная в прошлых прогонах недавно, а строка выдачи не
      // показала перемен: запросы страниц карточки не нужны вовсе.
      const cached = this.reusableCard(procedure, now);
      if (cached !== null) {
        reused += 1;
        tender = cached.tender;
        lastLotEndMs = cached.lastLotEndMs;
      } else {
        // Бюджет считает настоящие запросы: ответ из памяти прогона платить не
        // заставляет, и обход идёт дальше, не отбрасывая «бесплатные» процедуры.
        if (this.hasFreshMemo(procedure.row.cardUrl)) {
          memoized += 1;
        } else if (procedure.regional && resolvedRegional < this.maxRegionalResolves) {
          // Карточки найденных по региону идут из своего бюджета: их немного, и
          // общий потолок должен остаться на общероссийскую выдачу.
          resolvedRegional += 1;
        } else {
          if (resolved >= this.maxResolves) {
            resolveLimitReached = true;
            continue;
          }
          resolved += 1;
        }

        const found = await this.resolveCardMemo(procedure.row.cardUrl);
        if (!found.lotsComplete) incomplete += 1;

        tender = mapFabrikantProcedure(procedure.number, found.cards, {
          row: procedure.row,
          lotsComplete: found.lotsComplete,
        });
        lastLotEndMs = latestLotEnd(found.cards);
        // В кэш идёт только разобранная и полностью прочитанная карточка: у
        // неполной цена не публикуется, а неразобранная — чаще заглушка антибота,
        // чем состояние процедуры, и запоминать её нельзя.
        if (tender !== null && found.lotsComplete) {
          this.cardCache?.set(procedure.number, {
            fetchedAt: this.nowProvider().getTime(),
            complete: true,
            tender,
            lastLotEndMs,
          });
        }
      }
      if (tender === null) {
        count(rejected, "карточка не разобрана");
        continue;
      }
      // Срок не напечатан ни в лоте, ни панелью процедуры — значит строку нельзя
      // записать вовсе: `tenders.submission_end` объявлен NOT NULL. Прогон
      // 03.10.2026 печатал на этом 44 ошибки 22007 вместо одной причины со
      // счётчиком. Выдуманная дата была бы хуже: она прошла бы проверку на
      // просрочку и показала владельцу закупку, срок которой неизвестен.
      if (tender.deadlines.submissionEnd.trim() === "") {
        count(rejected, "срок подачи заявок не напечатан");
        continue;
      }
      // Срок виден только в карточке, поэтому просрочка проверяется после добора
      // лотов, а не до него. Процедура жива, пока жив хотя бы один лот.
      if (this.activeOnly && lastLotEndMs !== null && lastLotEndMs <= now.getTime()) {
        count(rejected, "срок приёма заявок истёк");
        continue;
      }
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
      withEisNumber: ordered.filter((procedure) => procedure.publishedInEis).length,
      resolved: resolved + resolvedRegional,
      reused,
      memoized,
      incomplete,
      kept: kept.length,
      droppedRows,
      rejected,
      resolveLimitReached,
      restrictedKeywords,
      failedKeywords,
      regional: ordered.filter((procedure) => procedure.regional).length,
      regionFilterFailed,
    };
    return kept;
  }

  async fetchTenderById(tenderId: string): Promise<Tender | null> {
    const number = fabrikantTenderNumber(tenderId);
    if (number === "") return null;
    const row = await this.findRowByNumber(number);
    // Площадка не вернула строку этого номера — например, процедуру сняли.
    // Подставить соседнюю значило бы показать карточку чужой закупки.
    if (row === null) return null;
    const found = await this.resolveCard(row.cardUrl);
    return mapFabrikantProcedure(row.procedureNumber, found.cards, {
      row,
      lotsComplete: found.lotsComplete,
    });
  }

  /**
   * Документов нет, и это ответ, а не заглушка.
   *
   * Байты лежат на `storage.fabrikant.ru`, куда ведёт 302 с публичного пути
   * `/v2/trades/procedure/documentation/download/single/…`, а `robots.txt` того
   * хоста запрещает всё (`Disallow: /`, `Crawl-delay: 3`). Зонд 02.10.2026
   * подтвердил, что файлы технически отдаются без авторизации (206 на ranged GET,
   * `%PDF-1.3` в теле), — и всё равно ходить туда нельзя: обход запрета площадки
   * не тот фундамент, на котором строят продукт для партнёра. Письменное согласие
   * площадки превращает этот ответ в `bytes` без переделки остального.
   *
   * Соблазн вернуть ссылку на карточку как документ с `type: "NOTICE"` здесь уже
   * был, и это ложь в самом дорогом месте: разъём обещает документы, потребитель
   * их скачивает и разбирает, и вместо текста закупки в платный разбор уезжает
   * навигация площадки.
   */
  async fetchDocuments(_tenderId: string): Promise<TenderDocument[]> {
    return [];
  }

  /**
   * Изменилась ли процедура с переданного момента.
   *
   * Даты публикации и последнего изменения в строке выдачи нет, поэтому
   * сравнивается ближайший срок окончания приёма заявок: сдвинутый срок — то
   * событие, ради которого владелец и хочет знать об изменении. Правку
   * документации этот метод не видит, и молчать об этом значит обещать больше,
   * чем площадка позволяет.
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

  /** Карточка уже читалась этим прогоном и ответ ещё свеж. */
  private hasFreshMemo(cardUrl: string): boolean {
    const hit = this.cardMemo.get(cardUrl);
    return hit !== undefined && Date.now() - hit.at < CARD_MEMO_TTL_MS;
  }

  /** Чтение карточки с памятью прогона: вторая просьба о той же карточке запросов не делает. */
  private resolveCardMemo(cardUrl: string): Promise<ResolvedProcedure> {
    const hit = this.cardMemo.get(cardUrl);
    if (hit !== undefined && Date.now() - hit.at < CARD_MEMO_TTL_MS) return hit.found;
    const entry = { at: Date.now(), found: this.resolveCard(cardUrl) };
    this.cardMemo.set(cardUrl, entry);
    entry.found.catch(() => {
      if (this.cardMemo.get(cardUrl) === entry) this.cardMemo.delete(cardUrl);
    });
    return entry.found;
  }

  /**
   * Прочитанная карточка из кэша, если её можно не перечитывать; иначе null.
   *
   * Правило осторожное: любое сомнение — «читать». Берётся только полностью
   * прочитанная карточка не старше окна свежести, у которой срок приёма заявок
   * напечатан и читается у всех лотов и ещё не истёк (истёкший срок площадка
   * могла продлить — его перечитывают всегда). Строка выдачи Фабриканта не несёт
   * ни срока, ни цены, поэтому сверяется то, что есть: предмет совпавшего лота
   * должен значиться среди сохранённых лотов, а номер извещения ЕИС в строке — не
   * противоречить ключу записи. Изменение срока или цены, сделанное заказчиком
   * внутри окна свежести, кэш не увидит: это допущение окна (сутки).
   */
  private reusableCard(procedure: DiscoveredProcedure, now: Date): CachedCard | null {
    const cache = this.cardCache;
    if (cache === null || this.cardMaxAgeMs <= 0) return null;
    const card = cache.get(procedure.number);
    if (card === undefined || !card.complete) return null;
    if (!isCardFresh(card, now.getTime(), this.cardMaxAgeMs)) return null;
    const tender = card.tender;
    if (tender.dataSource !== "FABRIKANT") return null;
    if (tender.deadlines.submissionEnd.trim() === "") return null;
    if (card.lastLotEndMs === null || card.lastLotEndMs <= now.getTime()) return null;

    const subject = normalizeLotText(procedure.row.subject);
    if (subject === "") return null;
    if (!tender.lots.some((lot) => normalizeLotText(lot.subject) === subject)) return null;
    const eisNumber = (procedure.row.eisNumber ?? "").trim();
    if (eisNumber !== "" && tender.regNumber !== eisNumber) return null;
    return card;
  }

  /**
   * Все страницы карточки одной процедуры.
   *
   * Число страниц говорит счётчик вкладки «Список лотов»: без него процедура с 18
   * лотами выглядит пятилотовой. Пока счётчик не прочитан, запрашивается одна
   * страница — и если площадка его не напечатала вовсе, больше спрашивать нечего.
   */
  private async resolveCard(cardUrl: string): Promise<ResolvedProcedure> {
    const cards: FabrikantCard[] = [];
    let declared: number | null = null;
    let lotsComplete = true;

    for (let page = 1; ; page += 1) {
      const card = await this.requestCard(fabrikantCardPageUrl(cardUrl, page));
      cards.push(card);
      if (declared === null && card.declaredLotCount !== null) declared = card.declaredLotCount;

      const wanted = fabrikantCardPageCount(declared);
      // Объявленное число страниц пройдено: набор полный. Проверка идёт до
      // предела `maxCardPages`, чтобы процедура ровно в предел не выглядела неполной.
      if (page >= wanted) break;
      if (page >= this.maxCardPages) {
        lotsComplete = false;
        break;
      }
      // Площадка перестала печатать лоты, хотя счётчик обещал больше: продолжать
      // значит спрашивать пустоту, а публиковать сумму части лотов нельзя.
      if (card.lotsOnPage === 0) {
        lotsComplete = false;
        break;
      }
    }

    const collected = cards.reduce((total, card) => total + card.lots.length, 0);
    if (declared !== null && collected < declared) lotsComplete = false;
    return { cards, lotsComplete };
  }

  /** Обход страниц выдачи: генератор, чтобы условие остановки было в одном месте. */
  private async *walkSearch(
    params: Omit<FabrikantSearchParams, "page" | "sections" | "statuses">,
    maxPages: number,
  ): AsyncGenerator<FabrikantSearchPage> {
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.requestSearch({
        ...params,
        page,
        sections: this.sections,
        statuses: this.statuses,
      });
      yield result;
      // Два признака конца, и оба — слова площадки: «По вашему запросу ничего не
      // найдено» и отсутствие объявленных страниц. Длину страницы признаком не
      // считаем: 40 строк могут относиться к трём процедурам, и короткая страница
      // с живым продолжением в выдаче встречается. Предел `maxPages` обход ограничивает.
      if (result.noResults || !fabrikantHasNextPage(result, page)) return;
    }
  }

  /**
   * Строка выдачи по номеру — своему или ЕИС.
   *
   * Секции и статусы в этот запрос намеренно не передаются: по номеру владелец
   * спрашивает конкретную закупку, и она обязана находиться и после окончания
   * приёма заявок, и в секции, которую мы по умолчанию не обходим. Зонд
   * 02.10.2026 подтвердил точность поиска по номеру: `query=32616433843` вернул
   * одну строку процедуры 5582378, а `pages: 1`, поэтому одной страницы довольно.
   *
   * `query` у площадки — подстрока, а не точное совпадение, поэтому строка
   * сверяется с номером явно: на запрос `5582388` площадка может ответить
   * процедурой `55823880`, и её карточка показала бы чужую закупку.
   */
  private async findRowByNumber(number: string): Promise<FabrikantLotRow | null> {
    const page = await this.requestSearch({ query: number });
    for (const row of page.rows) {
      const matches =
        row.procedureNumber.trim() === number || (row.eisNumber ?? "").trim() === number;
      if (matches && isFabrikantCardUrl(row.cardUrl)) return row;
    }
    return null;
  }

  /**
   * Коды площадки для регионов профиля. Названия сравниваются по коду региона,
   * поэтому «Бурятия» и «Республика Бурятия» дают один и тот же код. Справочник
   * читается со страницы выдачи один раз; неудачная загрузка не запоминается.
   */
  private async regionIdsFor(wanted: readonly string[]): Promise<string[]> {
    if (this.regionDirectory === null) {
      const url = fabrikantSearchUrl({ page: 1, limit: 1 }, this.baseUrl);
      const load = this.requestText(url, isFabrikantSearchPage, "страница выдачи").then(parseFabrikantRegions);
      this.regionDirectory = load;
      load.catch(() => {
        this.regionDirectory = null;
      });
    }
    const directory = await this.regionDirectory;
    const ids: string[] = [];
    for (const region of directory) {
      if (wanted.some((name) => isSameRegion(name, region.name)) && !ids.includes(region.id)) {
        ids.push(region.id);
      }
    }
    return ids;
  }

  private async requestSearch(params: FabrikantSearchParams): Promise<FabrikantSearchPage> {
    const url = fabrikantSearchUrl(params, this.baseUrl);
    return parseFabrikantSearch(await this.requestText(url, isFabrikantSearchPage, "страница выдачи"));
  }

  private async requestCard(url: string): Promise<FabrikantCard> {
    return parseFabrikantCard(await this.requestText(url, isFabrikantCardPage, "карточка процедуры"));
  }

  /**
   * Один запрос с повторами.
   *
   * Повторяются сбой транспорта (пустое тело), HTTP-код ошибки и ответ не тем
   * форматом. Последнее обязательно отличать от пустой выдачи: страница антибота
   * или заглушки провайдера разбирается в ноль строк, и прогон напечатал бы
   * «новых закупок: 0» вместо причины.
   */
  private async requestText(
    url: string,
    looksRight: (text: string) => boolean,
    what: string,
  ): Promise<string> {
    let attempt = 0;
    for (;;) {
      await this.throttle();
      const response = await this.fetchImpl(url, {
        headers: { ...REQUEST_HEADERS },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      if (response.ok && looksRight(text)) return text;
      if (attempt >= this.maxRetries) {
        throw new FabrikantResponseError(
          response.ok
            ? `Фабрикант вернул ответ, который не разбирается как «${what}» (${url}).`
            : `Фабрикант ответил HTTP ${response.status} на запрос «${what}» (${url}).`,
        );
      }
      attempt += 1;
      await sleep(RETRY_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

/**
 * Пустой итог. Он же — значение сброса в начале каждого вызова `fetchTenders`.
 *
 * Сброс обязателен: одним адаптером прогон обходит несколько профилей, и если
 * вызов сорвался, `filterStats` не имеет права отдавать числа предыдущего
 * профиля. Журнал напечатал бы их под заголовком профиля, который не нашёл
 * ничего, — а это подмена причины, та самая, от которой предостерегает итог по
 * источникам в `scripts/sync-eis.ts`.
 */
function emptyStats() {
  return {
    rows: 0,
    discovered: 0,
    withEisNumber: 0,
    resolved: 0,
    reused: 0,
    memoized: 0,
    incomplete: 0,
    kept: 0,
    droppedRows: {} as Record<string, number>,
    rejected: {} as Record<string, number>,
    resolveLimitReached: false,
    restrictedKeywords: 0,
    failedKeywords: 0,
    regional: 0,
    regionFilterFailed: false,
  };
}

/**
 * Самый поздний срок приёма заявок среди лотов процедуры, мс.
 *
 * Срок в закупке — ближайший (`deadlines.submissionEnd`), а для решения «истекла
 * ли процедура» нужен последний: многолотовая процедура жива, пока жив хотя бы
 * один лот, и отбросить её из-за одного закрытого лота значит потерять остальные.
 *
 * null — срока нет или он нечитаем хотя бы у одного лота. Неизвестность — не
 * просрочка: отбросить закупку из-за того, что площадка напечатала дату словами,
 * значит показать владельцу пустую выдачу без причины. Процедура считается
 * истёкшей, только когда число известно и оно не позже «сейчас».
 */
function latestLotEnd(cards: readonly FabrikantCard[]): number | null {
  let latest: number | null = null;
  for (const card of cards) {
    for (const lot of card.lots) {
      if (lot.submissionEnd.trim() === "") return null;
      const deadline = new Date(lot.submissionEnd).getTime();
      if (Number.isNaN(deadline)) return null;
      if (latest === null || deadline > latest) latest = deadline;
    }
  }
  return latest;
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
 * Отбор, который площадка в запросе не поддерживает: закон, регион, цена и ИНН.
 *
 * Закон проверяется и здесь, а не только до запроса карточки: строка выдачи часто
 * его не называет, и тогда решает панель карточки. Отбросить закупку 44-ФЗ,
 * которую карточка опознала как 44-ФЗ, значило бы отдать владельцу не то, что он
 * просил в профиле.
 *
 * Ключевых слов здесь нет намеренно. Площадка уже отобрала строки по слову, и
 * совпадение могло оказаться в поле, которого мы не получаем (например, в тексте
 * документации). Перепроверка отбросила бы законную находку, а объяснить владельцу
 * «мы нашли, но сами же и выбросили» нельзя.
 */
function rejectionReason(tender: Tender, filters: PreparedFilters): TenderRejection | null {
  if (filters.laws.length > 0 && !filters.laws.includes(tender.law)) return "закон";

  if (filters.regions.length > 0) {
    // Неопределённый регион считается отдельно: это не «другой регион», а
    // неизвестность, и в журнале она должна быть видна своим числом.
    if (!isRegionKnown(tender.region)) return "регион не определён";
    if (!filters.regions.some((wanted) => isSameRegion(wanted, tender.region))) return "регион";
  }

  // Цена 0 означает «не опубликована», а не «бесплатно»: у закупки «Без указания
  // цены» и у процедуры с неполным набором лотов сумма в карточке есть не всегда,
  // и лимит профиля такие закупки не отсекает.
  const price = tender.financial.price;
  if (isPriceKnown(price)) {
    if (filters.minPrice !== null && price < filters.minPrice) return "цена";
    if (filters.maxPrice !== null && price > filters.maxPrice) return "цена";
  }

  // Карточка печатает организатора, а не заказчика: обычно это одно лицо, но при
  // несовпадении ИНН фильтр отбросит закупку, и это правильно — профиль ищет
  // закупки конкретного заказчика.
  if (filters.customerInns.length > 0) {
    const inn = tender.customerInn?.trim() ?? "";
    if (inn === "" || !filters.customerInns.includes(inn)) return "заказчик";
  }

  return null;
}
