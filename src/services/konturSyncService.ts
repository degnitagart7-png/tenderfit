/**
 * Синхронизация закупок из Контур.Закупок в базу ТендерФит.
 *
 * Порядок действий (важен для экономии платных запросов):
 *   1. остаток по тарифу (`/limitGroups`, запрос бесплатный) — до платного поиска;
 *   2. кэш сырых ответов — повторный идентичный поиск API не расходует;
 *   3. свой суточный бюджет из env — страховка на случай, когда тариф прочитать
 *      не удалось, а ключ расходует кто-то ещё;
 *   4. upsert закупок в tenders (data_source = KONTUR) вместе с сырой записью;
 *   5. документы закупки в tender_documents (source_type = kontur_api), ключ —
 *      реестровый номер закупки.
 *
 * Документы в очередь разбора пока не попадают: `deepAnalysisBlocker` считает
 * Контур.Закупки источником без документации, потому что карточка закупки
 * (единственный источник `Docs`) — отдельный платный запрос группы `purchase`,
 * а плановая синхронизация карточки не открывает. С боевым ключом ссылки в
 * `Docs[].Url` настоящие (зонд 24.09.2026), поэтому документацию добирает
 * scripts/fetch-tender-documents.ts --kontur-cards: он сначала бесплатно читает
 * ЕИС и только потом тратит запрос на карточку. Скачивание возможно лишь с
 * российского IP: ссылки ведут на filestore zakupki.gov.ru.
 *
 * Ошибки авторизации (401/403) не повторяются: ключ отозван или тариф закончился,
 * нужно вмешательство администратора.
 */
import type { Tender } from "@/domain/entities";
import type { TenderDocumentType } from "@/domain/enums";
import type { ApiUsageSummary, DocumentType } from "@/types/database";
import {
  KonturDailyLimitError,
  KonturTenderSourceAdapter,
  type KonturAdapterOptions,
} from "@/adapters/tender-source/konturTenderSourceAdapter";
import {
  KonturAuthError,
} from "@/adapters/tender-source/konturContract";
import { createLayeredKonturStore } from "@/adapters/tender-source/konturCache";
import {
  konturAvailableBudget,
  konturSubscriptionEnd,
  konturTightestLimitGroup,
  type KonturBlurReport,
  type KonturBlurredField,
  type KonturLimitGroupInfo,
  type KonturSearchQuery,
  type KonturSkipReason,
} from "@/adapters/tender-source/konturParser";
import { konturCacheRepository } from "@/repositories/konturCacheRepository";
import { tenderRepository, type CreateTenderInput } from "@/repositories/tenderRepository";
import { documentRepository } from "@/repositories/documentRepository";
import { freeSourceTitles } from "@/domain/sources";
import { joinRuList } from "@/utils/format";

/** Доменный тип документа → значение tender_documents.document_type. */
const DOCUMENT_TYPE_TO_DB: Record<TenderDocumentType, DocumentType> = {
  NOTICE: "notice",
  TECHNICAL_SPEC: "tz",
  DRAFT_CONTRACT: "contract",
  PROJECT_DOCUMENTATION: "attachment",
  COST_JUSTIFICATION: "attachment",
  OTHER: "other",
};

/**
 * Суточный бюджет на каждый метод, если тариф прочитать не удалось.
 *
 * Равен боевому тарифу (зонд `/limitGroups` 24.09.2026: `search` 30/30,
 * `purchase` 30/30, `results` 30/30). Завышать нельзя — API ответит 429 уже
 * после тридцатого запроса метода, и запросы уйдут впустую; занижать — значит
 * не дать синхронизации потратить купленное.
 */
export const DEFAULT_DAILY_LIMIT = 30;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Что нужно сервису от адаптера — позволяет подменить его заглушкой в тестах. */
export interface KonturAdapterLike {
  fetchTenders(query: KonturSearchQuery): Promise<Tender[]>;
  /** Остаток по тарифным группам: запрос бесплатный, поэтому зовём его первым. */
  fetchLimitGroups(force?: boolean): Promise<KonturLimitGroupInfo[]>;
  getRaw(regNumber: string): Record<string, unknown> | null;
  readonly counters: { apiCalls: number; cacheHits: number; requestsToday: number };
  readonly lastSkipped: KonturSkipReason[];
  /** Что в последних ответах оказалось закрашено тестовым ключом. */
  readonly lastBlurred: KonturBlurReport;
  /** Сколько записей отдал источник, но отсекли фильтры региона и ОКПД2. */
  readonly lastFilteredOut: number;
}

export interface KonturSyncOptions {
  /** Свой адаптер (тесты, разовые прогоны). По умолчанию создаётся из env. */
  adapter?: KonturAdapterLike;
  /** Сохранять документы закупки в tender_documents. */
  saveDocuments?: boolean;
}

export interface KonturSyncResult {
  synced: number;
  created: number;
  updated: number;
  /**
   * Закупки, которые уже лежат в базе от более авторитетного источника: порядок
   * площадок задаёт каталог `src/domain/sources.ts`, ручная загрузка тоже выше
   * агрегатора. Контур — агрегатор тех же извещений, и его номер закупки
   * совпадает с номером в ЕИС, поэтому пересечение — норма, а не поломка
   * синхронизации. Строку первоисточника мы не перезаписываем: иначе менее
   * полные данные агрегатора затёрли бы заказчика, регион и ссылку на карточку
   * ЕИС.
   */
  duplicates: number;
  documents: number;
  /** Причины отброшенных записей — признак расхождения схемы ответа с гипотезой. */
  skipped: KonturSkipReason[];
  /**
   * Сколько закупок источник вернул, а синхронизация отсекла фильтрами региона
   * и ОКПД2 (API их не принимает). Число показывает пользователю, что поиск
   * сработал, а часть выдачи сознательно не сохранена — иначе «найдено 0»
   * неотличимо от поломки.
   */
  filteredOut: number;
  apiCalls: number;
  cacheHits: number;
  requestsToday: number;
  usage: ApiUsageSummary;
  /** Первая ошибка сохранения документов (сами закупки при этом записаны). */
  documentsError: string | null;
  /**
   * Поля, которые источник отдал закрашенными. Так ведёт себя пониженный
   * тариф: закупки сохранены, но часть значений в них — пустота, а не данные.
   * Боевой ключ с 24.09.2026 отдаёт поля целиком, поэтому непустой список
   * теперь читается как признак понижения тарифа, а не как норма. Показывать
   * его нужно в любом случае: иначе «регион не указан» выглядит как ошибка
   * разбора.
   */
  blurredFields: KonturBlurredField[];
  /** Документы, у которых закрашена ссылка: скачать их нельзя. */
  blurredDocuments: number;
  /** Остаток платных запросов по тарифу на момент окончания синхронизации. */
  availableRequests: number | null;
  /**
   * Реестровые номера закупок, которые прогон записал от имени Контур.Закупок
   * (`created` и `updated` вместе).
   *
   * Дублей первоисточника в списке нет: эти строки принадлежат другой площадке,
   * и их документацию обслуживает тот же плановый прогон, что и раньше. Список
   * нужен серверу, чтобы поставить найденное в очередь на скачивание
   * документации; в ответе кнопки его нет — партнёру важен исход постановки, а
   * сами номера он видит в ленте.
   */
  regNumbers: string[];
}

/**
 * Остаток по тарифу и срок его действия.
 *
 * `/external/v1/limitGroups` не списывает лимит (проверено живым зондом
 * 23.09.2026: счётчики групп не изменились), поэтому читать его можно свободно
 * и до платного запроса, и для панели.
 */
export interface KonturTariffInfo {
  groups: KonturLimitGroupInfo[];
  /** Минимальный остаток среди групп `search` и `purchase`; null — групп нет. */
  available: number | null;
  /** Группа, которая кончится первой. */
  tightest: KonturLimitGroupInfo | null;
  /** Самая ранняя дата окончания подписки. */
  subscriptionEnd: string | null;
}

export function toTariffInfo(groups: KonturLimitGroupInfo[]): KonturTariffInfo {
  return {
    groups,
    available: konturAvailableBudget(groups),
    tightest: konturTightestLimitGroup(groups),
    subscriptionEnd: konturSubscriptionEnd(groups),
  };
}

/** Адаптер с постоянным кэшем, журналом расхода и суточным бюджетом из env. */
export async function createKonturAdapter(
  overrides: Partial<KonturAdapterOptions> = {},
): Promise<KonturTenderSourceAdapter> {
  const dailyLimit = envNumber("KONTUR_DAILY_REQUEST_LIMIT", DEFAULT_DAILY_LIMIT);
  const now = new Date().toISOString();
  const spentByMethod = await konturCacheRepository.billableCallsToday(now);
  return new KonturTenderSourceAdapter({
    rateLimitPerSec: envNumber("KONTUR_RATE_LIMIT_PER_SEC", 2),
    maxRetries: 3,
    searchTtlSec: envNumber("KONTUR_CACHE_TTL_SEARCH_SEC", 86_400),
    cardTtlSec: envNumber("KONTUR_CACHE_TTL_CARD_SEC", 604_800),
    // Бюджет на метод, а не общий: тариф считает группы `search` и `purchase`
    // раздельно, и общая сумма заблокировала бы карточки, когда кончились поиски.
    dailyLimitPerMethod: dailyLimit > 0 ? dailyLimit : null,
    requestsTodayByMethod: spentByMethod,
    store: createLayeredKonturStore(konturCacheRepository),
    usage: konturCacheRepository,
    onAuthError: (error) => {
      // Повторять бессмысленно: нужен администратор (ключ, тариф, срок trial).
      console.error(
        `[kontur] авторизация отклонена (HTTP ${error.status}). Проверьте KONTUR_API_KEY и срок действия тарифа.`,
      );
    },
    ...overrides,
  });
}

/**
 * Как часто плановый прогон вправе опрашивать Контур.Закупки, в часах.
 *
 * Прогон `scripts/sync-eis.ts` запускается каждые два часа, три ключевых слова
 * профиля стоят три платных поиска, а боевой тариф даёт 30 поисков в сутки
 * (зонд `/limitGroups` 24.09.2026). Без интервала расход составил бы 36, и
 * группа `search` кончалась бы примерно на десятом запуске — последние часы
 * суток источник молчал бы. Раз в шесть часов — 12 поисков в сутки, остальные
 * 18 остаются на ручные запуски панели и на карточки.
 *
 * Закупки от более редкого прогона не теряются: окно поиска
 * `DEFAULT_SEARCH_WINDOW_DAYS` равно семи суткам, поэтому каждый прогон
 * перечитывает всю неделю публикаций, а не только прошедшие часы. Отстаёт
 * лишь свежесть — максимум на шесть часов.
 *
 * `KONTUR_MIN_INTERVAL_HOURS=0` отключает интервал: источник опрашивается
 * каждый прогон, а расход ограничивает только суточный бюджет метода.
 */
export const DEFAULT_KONTUR_SYNC_INTERVAL_HOURS = 6;

/** Интервал из env; отрицательное и нечисловое значение означает «по умолчанию». */
export function konturSyncIntervalHours(): number {
  const hours = envNumber("KONTUR_MIN_INTERVAL_HOURS", DEFAULT_KONTUR_SYNC_INTERVAL_HOURS);
  return hours > 0 ? hours : 0;
}

/** Решение «опрашивать ли Контур.Закупки в этом прогоне» и его объяснение. */
export interface KonturCadenceDecision {
  query: boolean;
  /** Сколько часов прошло с последнего платного поиска; null — поиска не было. */
  hoursSinceLastSearch: number | null;
  /** Причина пропуска для лога прогона; null, если источник опрашиваем. */
  reason: string | null;
}

/** Часы по-русски: запятая как разделитель, «меньше часа» вместо «0,3». */
function formatHours(hours: number): string {
  return (Math.round(hours * 10) / 10).toFixed(1).replace(".", ",");
}

/**
 * Чистая часть правила: опрос нужен, если с последнего платного поиска прошло
 * не меньше `minIntervalHours`.
 *
 * Отсчёт от журнала расхода, а не от часа суток: плановое задание может стоять
 * на нечётных часах, и привязка к «hour % 6 == 0» не сработала бы ни разу —
 * источник молчал бы всегда, и это выглядело бы как поломка, а не как экономия.
 *
 * Неизвестное время последнего поиска (журнал пуст, Supabase не настроен,
 * метка не читается) трактуется как «опрашивать»: лучше потратить один
 * запрос, чем остановить источник из-за отсутствия данных, а от перерасхода
 * защищает суточный бюджет метода.
 */
export function decideKonturSync(input: {
  lastPaidSearchAt: string | null;
  now: string;
  minIntervalHours: number;
}): KonturCadenceDecision {
  const open: KonturCadenceDecision = { query: true, hoursSinceLastSearch: null, reason: null };
  if (input.minIntervalHours <= 0 || !input.lastPaidSearchAt) return open;

  const last = Date.parse(input.lastPaidSearchAt);
  const now = Date.parse(input.now);
  if (Number.isNaN(last) || Number.isNaN(now)) return open;

  // Отрицательная разница возможна при расхождении часов: считаем её нулём,
  // чтобы «из будущего» не выглядело как «давно».
  const hours = Math.max(0, (now - last) / 3_600_000);
  if (hours >= input.minIntervalHours) {
    return { query: true, hoursSinceLastSearch: hours, reason: null };
  }
  const ago = hours < 1 ? "меньше часа назад" : `${formatHours(hours)} ч назад`;
  return {
    query: false,
    hoursSinceLastSearch: hours,
    reason:
      `последний платный поиск был ${ago}, а интервал между прогонами — ` +
      `${formatHours(input.minIntervalHours)} ч`,
  };
}

/** Когда Контур.Закупки в последний раз делали платный поиск; null — неизвестно. */
export async function konturLastPaidSearchAt(): Promise<string | null> {
  return konturCacheRepository.lastBillableCallAt("search");
}

/** Чем платный источник остановлен до конца прогона. */
export type KonturStopKind = "budget" | "auth";

/** Остановка источника и её объяснение: `message` — одна строка для лога прогона. */
export interface KonturSourceStop {
  readonly kind: KonturStopKind;
  readonly message: string;
}

/**
 * Останавливать ли Контур.Закупки до конца прогона.
 *
 * Два случая, когда повторять запрос бессмысленно:
 * - `budget` — суточный лимит группы исчерпан, счётчик обнулится в 00:00 UTC;
 * - `auth` — ключ отклонён (401/403): кончилась подписка, ключ отозван или не
 *   подключена группа методов.
 *
 * Ветка `auth` нужна потому, что подписку продлевают короткими шагами и она
 * кончается без предупреждения в логе. Без неё прогон глотал бы ошибку как
 * сбой одного ключевого слова и повторял обречённый запрос на каждое ключевое
 * слово каждого профиля, печатая `describeError` вместо внятной причины:
 * оператор видел бы десяток одинаковых строк и не понимал, что источник мёртв.
 *
 * Остальные сбои (429, 5xx, сеть, HTML вместо JSON) возвращают `null` — их
 * разбирает повтор адаптера и строка лога по ключевому слову: источник может
 * ожить на следующем запросе, и останавливать его навсегда оснований нет.
 */
export function konturSourceStop(error: unknown): KonturSourceStop | null {
  /*
    Какие источники продолжают работать, каталог знает лучше подписи: перечень
    бесплатных площадок менялся трижды за две недели, и строка, написанная от
    руки, каждый раз отставала. Читается она оператором как «остальное тоже
    сломалось», если площадки в ней не названы.
  */
  const others = `${joinRuList(freeSourceTitles())} продолжают работать.`;
  if (error instanceof KonturDailyLimitError) {
    return {
      kind: "budget",
      message:
        `${error.message} Остальные ключевые слова и профили этого источника ` +
        `пропущены до следующих суток; ${others} Чтобы источника хватало на весь ` +
        "день, уменьшите число ключевых слов или интервал плановой синхронизации " +
        "(см. docs/REFERENCE_KONTUR_API.md).",
    };
  }
  if (error instanceof KonturAuthError) {
    return {
      kind: "auth",
      message:
        `Контур.Закупки отклонили API-ключ (${error.status}): кончилась подписка, ` +
        "ключ отозван или не подключена группа методов. Источник пропущен до конца " +
        `прогона; ${others} Дату конца подписки показывает журнал заданий ` +
        "(/admin/jobs) — после неё нужен продлённый тариф или новый ключ: " +
        "ключом записи служит номер извещения, поэтому смена ключа закупки не двоит.",
    };
  }
  return null;
}

/**
 * Тариф ключа. Ключ не задан — возвращаем пустой набор, а не ошибку: панель
 * должна показать «интеграция не подключена», а не упасть.
 */
export async function fetchKonturTariff(): Promise<KonturTariffInfo> {
  const adapter = await createKonturAdapter();
  return toTariffInfo(await adapter.fetchLimitGroups());
}

/**
 * Остаток по тарифу; `null`, если прочитать его не удалось (нет сети, ключ не
 * принят, миграция не применена). Синхронизацию это не блокирует: решение
 * примет сам запрос к API, а суточный бюджет из env остаётся страховкой.
 *
 * `force` — читать у источника, минуя кэш адаптера: после синхронизации
 * кэшированное значение показывало бы остаток до неё.
 */
async function readTariff(
  adapter: KonturAdapterLike,
  force: boolean,
): Promise<KonturLimitGroupInfo[] | null> {
  try {
    return await adapter.fetchLimitGroups(force);
  } catch (error) {
    console.warn(
      `[kontur] остаток по тарифу не прочитан: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function toCreateInput(tender: Tender, now: string): CreateTenderInput {
  return {
    reg_number: tender.regNumber,
    external_id: tender.externalId,
    law: tender.law,
    placing_way: tender.placingWay,
    subject: tender.subject,
    customer_name: tender.customerName,
    customer_inn: tender.customerInn,
    region: tender.region,
    delivery_address: tender.deliveryAddress,
    price: tender.financial.price,
    currency: tender.financial.currency,
    advance_payment: tender.financial.advanceAmount,
    security_bid: tender.financial.bidSecurityAmount,
    security_contract: tender.financial.contractSecurityAmount,
    submission_end: tender.deadlines.submissionEnd,
    publication_date: tender.deadlines.publicationDate,
    last_update_date: tender.deadlines.lastUpdateDate,
    delivery_term_days: tender.deadlines.deliveryTermDays,
    delivery_date_end: null,
    okpd2_codes: tender.okpd2Codes.length > 0 ? tender.okpd2Codes : null,
    lots: tender.lots.length > 0 ? tender.lots : null,
    requirements: tender.requirements.length > 0 ? tender.requirements : null,
    national_regime: tender.nationalRegime,
    only_for_smp: tender.onlyForSmp,
    eis_url: tender.eisUrl || null,
    data_source: "KONTUR",
    change_log: tender.changeLog.length > 0 ? tender.changeLog : null,
    synced_at: now,
  };
}

/**
 * Документы закупки в tender_documents. Уже сохранённые файлы не дублируются:
 * проверка по имени файла внутри закупки.
 *
 * Ключ строки — реестровый номер, а не UUID строки tenders. Колонка
 * tender_documents.tender_id по схеме хранит номер закупки, по номеру документы
 * читает воркер разбора (analysis_jobs.tender_id — тоже номер) и панель на
 * карточке. UUID не годится ещё и потому, что плановая синхронизация
 * пересоздаёт строки закупок: номер остаётся прежним, идентификатор меняется
 * каждый прогон, и записанные под ним документы терялись бы навсегда.
 *
 * Экспортируется отдельно от syncKonturTenders, чтобы плановый скрипт
 * scripts/sync-eis.ts мог сохранять документы тем же способом.
 */
export async function saveKonturTenderDocuments(tender: Tender): Promise<number> {
  if (tender.documents.length === 0) return 0;
  const regNumber = tender.regNumber;
  const existing = await documentRepository.findByTenderId(regNumber);
  const known = new Set(existing.map((document) => document.filename));
  let saved = 0;
  for (const document of tender.documents) {
    if (known.has(document.fileName)) continue;
    await documentRepository.create({
      tender_id: regNumber,
      source_type: "kontur_api",
      filename: document.fileName,
      document_type: DOCUMENT_TYPE_TO_DB[document.type],
      file_url: document.url,
      raw_json: { konturDocumentId: document.id, title: document.title },
    });
    known.add(document.fileName);
    saved += 1;
  }
  return saved;
}

/** Забирает закупки из Контур.Закупок и кладёт их в tenders/tender_documents. */
export async function syncKonturTenders(
  query: KonturSearchQuery,
  options: KonturSyncOptions = {},
): Promise<KonturSyncResult> {
  const adapter: KonturAdapterLike = options.adapter ?? (await createKonturAdapter());
  const saveDocuments = options.saveDocuments ?? true;
  const now = new Date().toISOString();

  // Остаток тарифа проверяется до платного поиска: сам поиск при нуле вернёт
  // 429, но уже после того, как запрос уйдёт в сеть и попадёт в журнал.
  // Смотрим именно группу `search` — синхронизация расходует её. Группа
  // `purchase` (карточки) считается отдельно: ноль карточек не означает, что
  // поиск запрещён, и наоборот.
  const before = konturTightestLimitGroup((await readTariff(adapter, false)) ?? [], ["search"]);
  if (before && before.availableRequests <= 0) {
    throw new KonturDailyLimitError(before.totalLimit, before.totalLimit, "search");
  }

  const tenders = await adapter.fetchTenders(query);

  let created = 0;
  let updated = 0;
  let duplicates = 0;
  let documents = 0;
  let documentsError: string | null = null;
  const regNumbers: string[] = [];

  for (const tender of tenders) {
    const { created: isNew, duplicateOf } = await tenderRepository.upsertByRegNumber({
      ...toCreateInput(tender, now),
      // Сырая запись источника: пересобрать закупку можно без нового запроса к API.
      raw_data: adapter.getRaw(tender.regNumber),
    });
    if (isNew) created += 1;
    else if (duplicateOf) duplicates += 1;
    else updated += 1;
    // Строка первоисточника не наша: его документацию уже обслуживает плановый
    // прогон, и ставить её в очередь второй раз не нужно.
    if (!duplicateOf) regNumbers.push(tender.regNumber);

    // Документы строки первоисточника не трогаем: у него они уже свои, а
    // поисковая выдача Контур.Закупок `Docs` не содержит вовсе — список файлов
    // приходит только в карточке (см. konturDocumentFetch).
    if (!saveDocuments || duplicateOf) continue;
    try {
      documents += await saveKonturTenderDocuments(tender);
    } catch (error) {
      // Закупка уже сохранена: документы не должны рушить синхронизацию
      // (например, пока не применена миграция с source_type = kontur_api).
      documentsError = error instanceof Error ? error.message : String(error);
    }
  }

  const counters = adapter.counters;
  const blurred = adapter.lastBlurred;
  return {
    synced: tenders.length,
    created,
    updated,
    duplicates,
    documents,
    skipped: [...adapter.lastSkipped],
    filteredOut: adapter.lastFilteredOut,
    apiCalls: counters.apiCalls,
    cacheHits: counters.cacheHits,
    requestsToday: counters.requestsToday,
    usage: await konturCacheRepository.summaryToday(now),
    documentsError,
    blurredFields: blurred.fields,
    blurredDocuments: blurred.documents,
    availableRequests: konturAvailableBudget((await readTariff(adapter, true)) ?? []),
    regNumbers,
  };
}
