import { NextRequest, NextResponse } from "next/server";
import {
  createKonturAdapter,
  syncKonturTenders,
  type KonturSyncResult,
} from "@/services/konturSyncService";
import { queueDocumentsAfterSearch } from "@/services/syncJobService";
import {
  KONTUR_MAX_PAGES_DEFAULT,
  KonturDailyLimitError,
  KonturNotConfiguredError,
} from "@/adapters/tender-source/konturTenderSourceAdapter";
import {
  KonturAuthError,
  KonturResponseParseError,
} from "@/adapters/tender-source/konturContract";
import type { KonturSearchQuery } from "@/adapters/tender-source/konturParser";
import type { TenderLaw } from "@/types/database";

export const dynamic = "force-dynamic";
/**
 * Запас по времени выполнения.
 *
 * Синхронизация последовательная: по одному платному поиску на ключевое слово
 * (с ограничением частоты) и по два обращения к БД на каждую закупку. В
 * отведённые по умолчанию 10 секунд серверлесс-функции такой прогон не
 * укладывается и был бы оборван на середине записи — лента осталась бы
 * неполной. 60 секунд уже использует /api/analysis/worker, значит план их
 * разрешает.
 */
export const maxDuration = 60;

const VALID_LAWS: TenderLaw[] = ["FZ_44", "FZ_223", "PP_RF_615", "COMMERCIAL"];

/**
 * Складывает результаты нескольких поисков в один ответ.
 *
 * Счётчики закупок и документов — за один поиск, их суммируем. Счётчики
 * адаптера (apiCalls, cacheHits, requestsToday, availableRequests) накопительные
 * за всё время жизни экземпляра, поэтому берём последнее значение, а не сумму.
 * Номера закупок объединяем без повторов: одна и та же закупка попадается на
 * несколько ключевых слов, а дважды поставленная в очередь документация
 * заставила бы воркер качать одни и те же файлы.
 */
function mergeResults(
  total: KonturSyncResult | null,
  next: KonturSyncResult,
): KonturSyncResult {
  if (!total) return next;
  return {
    ...total,
    synced: total.synced + next.synced,
    created: total.created + next.created,
    updated: total.updated + next.updated,
    duplicates: total.duplicates + next.duplicates,
    documents: total.documents + next.documents,
    skipped: [...new Set([...total.skipped, ...next.skipped])],
    filteredOut: total.filteredOut + next.filteredOut,
    blurredFields: [...new Set([...total.blurredFields, ...next.blurredFields])].sort(),
    blurredDocuments: total.blurredDocuments + next.blurredDocuments,
    apiCalls: next.apiCalls,
    cacheHits: next.cacheHits,
    requestsToday: next.requestsToday,
    availableRequests: next.availableRequests,
    usage: next.usage,
    documentsError: total.documentsError ?? next.documentsError,
    regNumbers: [...new Set([...total.regNumbers, ...next.regNumbers])],
  };
}

interface SyncBody {
  laws?: TenderLaw[];
  keywords?: string[];
  excludeKeywords?: string[];
  /** Наименования субъектов: API по ним не фильтрует, отбор идёт по готовой выдаче. */
  regions?: string[];
  /** UUID регионов Контур.Закупок (`RegionIds`) — единственный фильтр региона у источника. */
  regionIds?: string[];
  customerInns?: string[];
  /** Коды ОКПД2: API их не принимает, отбор идёт префиксом по готовой выдаче. */
  okpd2Codes?: string[];
  /** Способ отбора (`ApiSearchProcedure`): 0 аукцион, 1 котировки, 2 ед. поставщик, 3 конкурс, 5 мониторинг цен, 99 другие. */
  procedures?: number[];
  /** Идентификаторы ЭТП (`ElectronicPlaces`). */
  electronicPlaces?: number[];
  /** Этап (`ApiSearchPurchaseStatus`): 1 подача заявок, 2 работа комиссии, 3 завершены, 4 планируются, 5 отменены, 6 несостоявшиеся. */
  statuses?: number[];
  /** Только закупки для СМП (1) или без них (2); 0 — не учитывать. */
  smp?: 0 | 1 | 2;
  /** Точный поиск по фразе (`StrictSearch`). */
  strictSearch?: boolean;
  /** Искать также в тексте документов (`Attachments`). */
  attachments?: boolean;
  minPrice?: number | null;
  maxPrice?: number | null;
  publishDateFrom?: string | null;
  publishDateTo?: string | null;
  deadlineFrom?: string | null;
  deadlineTo?: string | null;
  limit?: number;
  /**
   * Сколько страниц выдачи (по 50 записей) снимать на одно ключевое слово.
   * Каждая страница — отдельный платный поиск, поэтому платное действие панели
   * «Найти новые закупки» присылает 1: иначе профиль с фильтром региона заставил
   * бы адаптер листать выдачу до `KONTUR_MAX_PAGES_DEFAULT` страниц, и обещанные
   * партнёру три поиска обошлись бы в пятнадцать. Не задано — значение по
   * умолчанию.
   */
  maxPages?: number;
  /** false — только собрать закупки, документы в БД не писать. */
  saveDocuments?: boolean;
  /**
   * Поставить найденные закупки в очередь на скачивание документации.
   *
   * Просит только платное действие панели «Найти новые закупки». Флаг нужен, а не
   * подразумевается: панель администратора зовёт тот же роут для проверки ключа и
   * парсера, и создавать фоновую работу на десятки минут из отладочного запуска —
   * неожиданный побочный эффект. Ответ сообщает исход постановки полем
   * `documentsQueue` (null — не просили).
   */
  queueDocuments?: boolean;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}

/**
 * Список целых чисел: справочники API (`ApiSearchProcedure`,
 * `ApiSearchPurchaseStatus`, `ElectronicPlaces`) принимают номера, а не строки.
 */
function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isInteger(item));
}

function innList(value: unknown): string[] {
  return stringList(value)
    .map((inn) => inn.replace(/\D/g, ""))
    .filter((inn) => /^\d{10,12}$/.test(inn));
}

/**
 * POST /api/kontur/sync
 *
 * Синхронизация закупок из Контур.Закупок (платный источник).
 * Перед любым платным запросом проверяется остаток по тарифу
 * (`/limitGroups`, запрос бесплатный) и кэш сырых ответов
 * (kontur_raw_responses) — повторный идентичный поиск тариф не расходует.
 * Суточный бюджет из KONTUR_DAILY_REQUEST_LIMIT остаётся страховкой.
 *
 * Каждое ключевое слово — отдельный поиск (Контур не умеет OR в одной строке),
 * но все они выполняются одним адаптером: кэш, счётчик бюджета и ограничение
 * частоты у них общие.
 *
 * Цена прогона = ключевые слова × страницы выдачи (`maxPages`, по умолчанию 5):
 * каждая страница — отдельный платный запрос, а локальные фильтры региона и
 * ОКПД2 заставляют адаптер листать, пока не наберётся `limit` подходящих
 * записей. Платное действие панели «Найти новые закупки» присылает `maxPages: 1`,
 * поэтому его расход равен числу слов и совпадает с тем, что показано в панели
 * подтверждения.
 *
 * Ответ: { synced, created, updated, duplicates, documents, skipped, filteredOut,
 *          blurredFields, blurredDocuments, apiCalls, cacheHits, requestsToday,
 *          availableRequests, usage, documentsError, documentsQueue, searches, errors }
 *
 * duplicates — закупки, которые уже лежат в базе от более авторитетного
 * источника: порядок площадок задаёт каталог `src/domain/sources.ts`, ручная
 * загрузка тоже выше агрегатора. Контур такие строки не перезаписывает.
 *
 * documentsQueue — что сделала очередь заданий с документацией найденных
 * закупок: { queued, jobId, deduped, error }. Поле приходит только когда тело
 * запроса содержало `queueDocuments: true`, иначе оно null.
 *
 * Коды ошибок:
 *  400 — пустой набор законов;
 *  401 — ключ не принят (нужен администратор: тариф/trial/ключ);
 *  429 — исчерпан суточный лимит запросов (по тарифу или по KONTUR_DAILY_REQUEST_LIMIT);
 *  502 — ответ API не похож на JSON (неверный путь или страница входа);
 *  503 — KONTUR_API_KEY не задан.
 * Если часть поисков не удалась, а часть удалась, возвращается 200 со списком
 * errors: сохранённые закупки важнее, чем точный код ошибки.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: SyncBody;
  try {
    body = (await request.json()) as SyncBody;
  } catch {
    return NextResponse.json({ error: "Ожидался JSON в теле запроса" }, { status: 400 });
  }

  const laws = (body.laws ?? VALID_LAWS).filter((law) => VALID_LAWS.includes(law));
  if (laws.length === 0) {
    return NextResponse.json(
      { error: "laws должен содержать хотя бы одно значение: 44-ФЗ, 223-ФЗ, ПП РФ 615, COMMERCIAL" },
      { status: 400 },
    );
  }

  const limit = Number.isFinite(body.limit) ? Math.max(1, Math.trunc(body.limit ?? 50)) : 50;
  /*
    Потолок страниц задаёт цену прогона, поэтому значение из тела запроса
    ограничено значением по умолчанию: попросить больше, чем тратит плановый
    прогон, клиент не может. Меньше — может, и кнопка на дашборде этим
    пользуется, чтобы обещание «не больше трёх платных поисков» выполнялось
    на сервере, а не на честном слове вёрстки.
  */
  const maxPages =
    typeof body.maxPages === "number" && Number.isFinite(body.maxPages)
      ? Math.min(KONTUR_MAX_PAGES_DEFAULT, Math.max(1, Math.trunc(body.maxPages)))
      : undefined;
  const keywords = stringList(body.keywords);

  const query: KonturSearchQuery = {
    laws,
    keywords,
    excludeKeywords: stringList(body.excludeKeywords),
    regions: stringList(body.regions),
    regionIds: stringList(body.regionIds),
    customerInns: innList(body.customerInns),
    okpd2Codes: stringList(body.okpd2Codes),
    procedures: numberList(body.procedures),
    electronicPlaces: numberList(body.electronicPlaces),
    statuses: numberList(body.statuses),
    smp: body.smp === 1 || body.smp === 2 ? body.smp : 0,
    strictSearch: body.strictSearch === true,
    attachments: body.attachments === true,
    minPrice: typeof body.minPrice === "number" ? body.minPrice : null,
    maxPrice: typeof body.maxPrice === "number" ? body.maxPrice : null,
    publishDateFrom: body.publishDateFrom ?? null,
    publishDateTo: body.publishDateTo ?? null,
    deadlineFrom: body.deadlineFrom ?? null,
    deadlineTo: body.deadlineTo ?? null,
    limit,
  };

  // По одному поиску на ключевое слово: Контур соединяет слова в одну строку,
  // и запрос «автомобиль ноутбук» не найдёт ни того ни другого.
  const groups = keywords.length > 1 ? keywords.map((keyword) => [keyword]) : [keywords];

  try {
    // Один адаптер на все поиски: у него общий кэш в памяти, общий счётчик
    // дневного бюджета и общее ограничение частоты запросов.
    const adapter = await createKonturAdapter(maxPages ? { maxPages } : {});
    let result: KonturSyncResult | null = null;
    const errors: string[] = [];
    let firstError: unknown = null;

    for (const group of groups) {
      try {
        const part = await syncKonturTenders(
          { ...query, keywords: group },
          { adapter, saveDocuments: body.saveDocuments !== false },
        );
        result = mergeResults(result, part);
      } catch (error) {
        // Уже сохранённые закупки терять нельзя: добираем остальные ключевые
        // слова, а ошибку показываем в ответе. Если не удалось ничего —
        // пробрасываем первую ошибку, чтобы коды ответа остались честными.
        if (firstError === null) firstError = error;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${group[0] ?? "все закупки"}: ${message}`);
      }
    }

    if (!result) throw firstError ?? new Error("Ни один поиск не выполнен");

    /*
      Документация найденных закупок уходит в очередь воркеру с российским IP:
      хранилище файлов ЕИС не отвечает зарубежным адресам, поэтому скачать её с
      Vercel нельзя. Постановка не бросает ошибок наружу — поиск уже оплачен и
      закупки уже сохранены, а её исход видно в `documentsQueue`.
    */
    const documentsQueue =
      body.queueDocuments === true
        ? await queueDocumentsAfterSearch(result.regNumbers)
        : null;

    // Номера закупок остаются на сервере: партнёру нужен исход постановки, а не
    // перечень, который он и так видит в ленте.
    const { regNumbers: _regNumbers, ...counters } = result;
    return NextResponse.json({
      ...counters,
      documentsQueue,
      searches: groups.length,
      errors,
    });
  } catch (error) {
    if (error instanceof KonturNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof KonturAuthError) {
      return NextResponse.json(
        {
          error:
            "Контур.Закупки отклонили API-ключ. Проверьте KONTUR_API_KEY, срок trial и оплаченный тариф.",
          status: error.status,
        },
        { status: 401 },
      );
    }
    if (error instanceof KonturDailyLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    if (error instanceof KonturResponseParseError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "Неизвестная ошибка";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
