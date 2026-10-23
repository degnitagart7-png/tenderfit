import type {
  ChangeLogEntry,
  CompanyProfile,
  Tender,
  TenderLot,
  TenderRequirement,
  TenderDocument,
} from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import { pipelineRepository } from "@/repositories/pipelineRepository";
import { importedTendersRepository } from "@/repositories/importedTendersRepository";
import { mockTenderAnalysisProvider } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import type { TenderLaw, TenderDataSource, TenderRow as TenderRowDB } from "@/types/database";
import { applyDocumentTerms, parseDocumentTerms } from "@/domain/documentTerms";
import { createSharedRequestCache } from "@/lib/sharedRequest";
import { cardVerdictRepository, profileFingerprint } from "@/repositories/cardVerdictRepository";

/**
 * Сервис закупок для работы с реальным API (Supabase + ЕИС).
 *
 * Использует API-роуты:
 * - GET /api/tenders — получение списка закупок
 *
 * Синхронизации здесь нет намеренно: `POST /api/tenders/sync` поднимает ЕИС
 * внутри серверлесс-функции и на Vercel падает всегда (реестр не отвечает
 * зарубежным IP). Ленту пополняет прогон на сервере в России: кнопка «Найти
 * новые закупки» ставит в очередь задание `full_sync`
 * (`syncJobApiService.enqueueFullSync`), а платный поиск агрегатора — отдельное
 * необязательное действие той же панели (см. `konturApiService.sync` и
 * `useTenderData.syncKontur`). Локально роут ЕИС работает и нужен для ручной
 * отладки; плановый прогон `scripts/sync-eis.ts` берёт адаптеры источников
 * напрямую, минуя HTTP.
 *
 * Для анализа используется mockTenderAnalysisProvider (детерминированный скоринг).
 * В будущем можно заменить на реальный AI-провайдер.
 */

export interface TenderListResponse {
  tenders: TenderRowDB[];
  count: number;
}

export interface TenderFilters {
  law?: TenderLaw;
  region?: string;
  data_source?: TenderDataSource;
  customer_inn?: string;
  okpd2_code?: string;
  submission_end_after?: string;
  submission_end_before?: string;
  price_min?: number;
  price_max?: number;
  /** Реестровый номер — для выборки одной конкретной закупки. */
  reg_number?: string;
  limit?: number;
  offset?: number;
}

/** Преобразование TenderRowDB (из БД) в Tender (доменный объект). */
/** Запрос живого поиска из пометки строки (`raw_data.origin = "live"`). */
function liveQueryOf(raw: TenderRowDB["raw_data"]): string | null {
  if (raw === null || raw === undefined || raw["origin"] !== "live") return null;
  const query = raw["query"];
  return typeof query === "string" && query.trim() !== "" ? query : null;
}

/** Слова, под которые закупку отобрала модель (`raw_data.origin = "sense"`). */
function senseKeywordsOf(raw: TenderRowDB["raw_data"]): string[] | null {
  if (raw === null || raw === undefined || raw["origin"] !== "sense") return null;
  const keywords = raw["keywords"];
  return Array.isArray(keywords) ? keywords.filter((k): k is string => typeof k === "string") : null;
}

export function dbRowToTender(row: TenderRowDB): Tender {
  // Обеспечение и аванс из документации дополняют пустые реквизиты площадки —
  // ЕИС и большинство площадок в выдаче их не отдают вовсе.
  const { financial, applied } = applyDocumentTerms(
    {
      price: row.price ?? 0,
      currency: row.currency ?? "RUB",
      advancePercent: row.advance_payment ?? null,
      advanceAmount: null,
      paymentTermDays: 0,
      postpaymentDays: null,
      bidSecurityAmount: row.security_bid ?? null,
      bidSecurityPercent: null,
      contractSecurityAmount: row.security_contract ?? null,
      contractSecurityPercent: null,
      treasurySupport: false,
      expectedMarginPercent: null,
    },
    parseDocumentTerms(row.doc_terms),
  );
  return {
    id: row.reg_number,
    regNumber: row.reg_number,
    externalId: row.external_id,
    law: row.law,
    placingWay: row.placing_way,
    subject: row.subject,
    customerName: row.customer_name,
    customerInn: row.customer_inn,
    region: row.region,
    deliveryAddress: row.delivery_address ?? "",
    financial,
    documentTerms: applied,
    deadlines: {
      submissionEnd: row.submission_end,
      publicationDate: row.publication_date ?? "",
      lastUpdateDate: row.last_update_date ?? "",
      deliveryTermDays: row.delivery_term_days ?? null,
      warrantyMonths: null,
    },
    okpd2Codes: row.okpd2_codes ?? [],
    lots: (row.lots ?? []) as TenderLot[],
    requirements: (row.requirements ?? []) as TenderRequirement[],
    /*
      Документы здесь всегда пусты, и это не упущение: строка списка их не
      несёт. Карточка догружает их отдельным запросом — см. `loadDocuments`.
      Приложить текст документации к списку из двухсот закупок значило бы
      отдать браузеру десятки мегабайт ради страницы с названиями.
    */
    documents: [],
    nationalRegime: row.national_regime ?? false,
    onlyForSmp: row.only_for_smp ?? false,
    eisUrl: row.eis_url ?? "",
    dataSource: row.data_source,
    changeLog: (row.change_log ?? []) as ChangeLogEntry[],
    liveQuery: liveQueryOf(row.raw_data),
    senseKeywords: senseKeywordsOf(row.raw_data),
    // Обе метки приезжают из БД как есть: по `synced_at` находится партия
    // последнего прогона, по `created_at` — новая закупка или уже лежала.
    // Придумывать значение вместо отсутствующего нельзя — порядок в списках
    // строится на этих датах.
    syncedAt: row.synced_at ?? null,
    firstSeenAt: row.created_at ?? null,
  };
}

/** Строка таблицы документов, как её отдаёт `GET /api/documents`. */
interface DocumentApiRow {
  id?: string;
  filename?: string;
  document_type?: string;
  file_url?: string | null;
  parsed_text?: string | null;
  updated_at?: string | null;
}

/**
 * Документы закупки для карточки.
 *
 * Отказ не роняет карточку: закупка без документации читается хуже, но
 * читается, а пустой экран вместо неё не помогает никому. Поэтому ошибка
 * гасится до пустого списка — её видно в разборе, где нет ни одной ссылки на
 * документ.
 */
async function loadDocuments(regNumber: string): Promise<TenderDocument[]> {
  try {
    const response = await fetch(
      `/api/documents?tenderId=${encodeURIComponent(regNumber)}`,
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as { documents?: DocumentApiRow[] };
    return (payload.documents ?? []).map((row, index) => ({
      id: row.id ?? `doc-${String(index + 1)}`,
      type: (row.document_type ?? "OTHER") as TenderDocument["type"],
      title: row.filename ?? "Документ",
      fileName: row.filename ?? "Документ",
      url: row.file_url ?? "",
      text: row.parsed_text ?? "",
      pageCount: null,
      lastModified: row.updated_at ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Предел ленты. Выше — уже не «лента», а выгрузка: браузер держит всё в памяти
 * и пересчитывает на каждое нажатие клавиши. Если база дорастёт сюда, пора
 * переносить поиск на сервер, и предупреждение в консоли скажет об этом.
 * Ручка `GET /api/tenders` принимает тот же предел (`MAX_FEED_ROWS` в роуте).
 */
const MAX_FEED_ROWS = 5000;

/**
 * Сколько секунд готовая лента отдаётся без запроса.
 *
 * Защита от дублей в один момент (два компонента страницы просят одно и то же),
 * а не кэш данных: после поиска, синхронизации и ручного обновления лента
 * сбрасывается явно (`fresh` в `getRows`, `invalidateFeed`).
 */
const FEED_TTL_MS = 8_000;

/** Лента по фильтрам: ключ — сами фильтры; одновременные вызовы делят один запрос. */
const feedCache = createSharedRequestCache<TenderRowDB[]>(FEED_TTL_MS);

/** Параметры чтения ленты. */
export interface FeedReadOptions {
  /**
   * Не брать готовую ленту из памяти и не примыкать к запросу, начатому раньше:
   * данные только что изменились (поиск закончился, нажато «Обновить»), и
   * человек должен увидеть новые строки.
   */
  fresh?: boolean;
}

export const tenderApiService = {
  /** Получение списка закупок с фильтрацией. */
  async list(filters?: TenderFilters): Promise<TenderListResponse> {
    const params = new URLSearchParams();

    if (filters?.law) params.set("law", filters.law);
    if (filters?.region) params.set("region", filters.region);
    if (filters?.data_source) params.set("data_source", filters.data_source);
    if (filters?.customer_inn) params.set("customer_inn", filters.customer_inn);
    if (filters?.okpd2_code) params.set("okpd2_code", filters.okpd2_code);
    if (filters?.submission_end_after) params.set("submission_end_after", filters.submission_end_after);
    if (filters?.submission_end_before) params.set("submission_end_before", filters.submission_end_before);
    if (filters?.price_min !== undefined) params.set("price_min", String(filters.price_min));
    if (filters?.price_max !== undefined) params.set("price_max", String(filters.price_max));
    if (filters?.reg_number) params.set("reg_number", filters.reg_number);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));

    const url = `/api/tenders${params.toString() ? `?${params.toString()}` : ""}`;
    const res = await fetch(url);

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(error.error || `Failed to fetch tenders: ${res.status}`);
    }

    return res.json();
  },

  /**
   * Все закупки одним запросом.
   *
   * Ручка по умолчанию отдаёт пятьсот строк, а лента вызывала её без
   * параметров. Пока в базе было 382 закупки, потолок был невидим; при росте
   * базы лента молча обрезалась бы, а заголовок «Найдено N из N» продолжал бы
   * утверждать, что N — это всё. Тихая потеря хуже видимой ошибки: человек не
   * знает, что чего-то не увидел.
   *
   * Явный `limit` в фильтрах уважается: так просят одну закупку или короткий
   * список, и обходить это не нужно.
   *
   * Одновременные вызовы с теми же фильтрами делят один запрос, а готовая
   * лента живёт несколько секунд (`FEED_TTL_MS`). Запросов за лентой при
   * открытии страницы (замер 12.10.2026): было четыре подряд-параллельных
   * (по два компонента × две страницы по 1000 строк), стало один.
   */
  async listAll(filters?: TenderFilters, options?: FeedReadOptions): Promise<TenderRowDB[]> {
    if (filters?.limit !== undefined) return (await this.list(filters)).tenders;

    const key = JSON.stringify(filters ?? {});
    if (options?.fresh === true) feedCache.invalidate(key);
    // Копия массива: общий ответ получают несколько вызывающих, и сортировка
    // или правка у одного не должна менять список у другого.
    return [...(await feedCache.get(key, () => this.fetchFeed(filters)))];
  },

  /** Сбросить память ленты: после действия, которое меняет базу закупок. */
  invalidateFeed(): void {
    feedCache.invalidate();
  },

  /**
   * Один запрос за всей лентой.
   *
   * Раньше браузер листал страницы по тысяче строк друг за другом (второй
   * запрос стартовал после ответа на первый); теперь листает сервер, и страницы
   * базы он берёт параллельно (`domain/pagedFetch`).
   */
  async fetchFeed(filters?: TenderFilters): Promise<TenderRowDB[]> {
    const page = (await this.list({ ...filters, limit: MAX_FEED_ROWS, offset: 0 })).tenders;
    const seen = new Set<string>();
    const rows: TenderRowDB[] = [];
    for (const row of page) {
      // Повтор возможен, если базу пересобрали, пока сервер брал страницы:
      // номер закупки уникален, и вторая копия не нужна.
      if (seen.has(row.reg_number)) continue;
      seen.add(row.reg_number);
      rows.push(row);
    }
    if (page.length >= MAX_FEED_ROWS) {
      console.warn(
        `Лента загружена не целиком: достигнут предел ${String(MAX_FEED_ROWS)} закупок. Остальные не показаны.`,
      );
    }
    return rows;
  },

  /** Закупки как TenderRow[] для UI (с анализом и статусом воронки). */
  async getRows(
    profile: CompanyProfile,
    filters?: TenderFilters,
    options?: FeedReadOptions,
  ): Promise<TenderRow[]> {
    const dbRows = await this.listAll(filters, options);
    const rows: TenderRow[] = [];
    // Итоги открытых карточек (по документации) сильнее оценки по реквизитам.
    const cardVerdicts = cardVerdictRepository.allFor(profileFingerprint(profile));

    for (const row of dbRows) {
      /*
        Одна закупка с изъяном не должна ронять всю ленту. 04.10.2026 анализ
        упал на первой закупке без даты публикации, цикл не ловил исключение, и
        вместо списка пользователь увидел текст ошибки валидации: сто двадцать
        три нормальные закупки пропали вместе с одной непригодной.

        Пропуск не молчаливый: номер и причина идут в журнал браузера, чтобы
        закупка не исчезла бесследно. Известную причину (пустые даты) убрали
        в схеме; здесь защита от следующей, которую принесёт новая площадка.
      */
      try {
        const tender = dbRowToTender(row);
        const computed = await mockTenderAnalysisProvider.analyze(tender, profile);
        const card = cardVerdicts.get(tender.id);
        const analysis =
          card === undefined ? computed : { ...computed, verdict: card.verdict, fitScore: card.fitScore };
        rows.push({
          tender,
          analysis,
          pipelineStatus: pipelineRepository.getStatus(tender.id),
        });
      } catch (error) {
        console.error(
          `Закупка ${row.reg_number} пропущена в ленте: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Добавляем импортированные закупки (CSV/ручной ввод)
    const importedTenders = importedTendersRepository.asTenders();
    for (const tender of importedTenders) {
      const analysis = await mockTenderAnalysisProvider.analyze(tender, profile);
      rows.push({
        tender,
        analysis,
        pipelineStatus: pipelineRepository.getStatus(tender.id),
      });
    }

    return rows;
  },

  /** Получение одной закупки по ID. */
  async getRowById(id: string, profile: CompanyProfile): Promise<TenderRow | null> {
    // Сначала ищем в импортированных
    const imported = importedTendersRepository.asTenders().find((t) => t.id === id);
    if (imported) {
      const analysis = await mockTenderAnalysisProvider.analyze(imported, profile);
      return {
        tender: imported,
        analysis,
        pipelineStatus: pipelineRepository.getStatus(imported.id),
      };
    }

    // Ищем в БД по реестровому номеру: доменный id закупки — это её reg_number.
    const response = await this.list({ reg_number: id, limit: 1 });
    const row = response.tenders.find((r) => r.reg_number === id);
    if (row) {
      /*
        Документы догружаются до разбора, а не после.

        Разбор читает `tender.documents`: требования, обеспечения, условия
        договора берутся оттуда. Пока список был пуст, карточка 32616426639 с
        двумя скачанными файлами на 199 003 знака показывала «существенных
        ограничений не найдено» — вывод о тексте, которого разбор не видел.
      */
      const tender = { ...dbRowToTender(row), documents: await loadDocuments(id) };
      const analysis = await mockTenderAnalysisProvider.analyze(tender, profile);
      // Списки показывают этот же итог (см. cardVerdictRepository): карточка видит документацию.
      cardVerdictRepository.save(id, {
        verdict: analysis.verdict,
        fitScore: analysis.fitScore,
        profileKey: profileFingerprint(profile),
      });
      return {
        tender,
        analysis,
        pipelineStatus: pipelineRepository.getStatus(tender.id),
      };
    }

    return null;
  },
};
