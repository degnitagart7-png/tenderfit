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
function dbRowToTender(row: TenderRowDB): Tender {
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
    financial: {
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

  /** Получение закупок как TenderRow[] для UI (с анализом и статусом воронки). */
  async getRows(profile: CompanyProfile, filters?: TenderFilters): Promise<TenderRow[]> {
    const response = await this.list(filters);
    const rows: TenderRow[] = [];

    for (const row of response.tenders) {
      const tender = dbRowToTender(row);
      const analysis = await mockTenderAnalysisProvider.analyze(tender, profile);
      rows.push({
        tender,
        analysis,
        pipelineStatus: pipelineRepository.getStatus(tender.id),
      });
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
      return {
        tender,
        analysis,
        pipelineStatus: pipelineRepository.getStatus(tender.id),
      };
    }

    return null;
  },
};
