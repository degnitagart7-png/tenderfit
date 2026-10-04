import type {
  CompanyProfile,
  Digest,
  DigestSettings,
  ExperienceRecord,
  License,
  Notification,
  SroMembership,
  Tender,
  TenderAnalysis,
  TenderDocument,
} from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";

/**
 * Интерфейсы будущих интеграций (порты). В MVP реализуются mock-адаптерами,
 * но могут быть заменены на реальные без изменения интерфейса и UI.
 */

export interface TenderSourceAdapter {
  /** Получение новых закупок по профилю поиска. */
  fetchTenders(query: TenderSourceQuery): Promise<Tender[]>;
  /** Получение закупки по идентификатору. */
  fetchTenderById(id: string): Promise<Tender | null>;
  /** Получение документов закупки. */
  fetchDocuments(tenderId: string): Promise<TenderDocument[]>;
  /** Проверка изменений документации с указанной даты. */
  checkChanges(tenderId: string, since: string): Promise<boolean>;
}

export interface TenderSourceQuery {
  /** Законы/секции: ЕИС работает с 44-ФЗ, 223-ФЗ и ПП РФ 615, COMMERCIAL — коммерческие площадки. */
  laws: TenderLaw[];
  keywords?: string[];
  regions?: string[];
  /** ИНН заказчиков: непустой список ограничивает выдачу этими заказчиками. */
  customerInns?: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
  okpd2Codes?: string[];
  limit?: number;
}

export interface ExtractedFragment {
  text: string;
  page: number | null;
  section: string | null;
  coordinates: { x: number; y: number; w: number; h: number } | null;
}

export interface DocumentExtractor {
  extractText(document: TenderDocument): Promise<string>;
  extractTables(document: TenderDocument): Promise<string[][]>;
  detectType(document: TenderDocument): Promise<TenderDocument["type"]>;
  extractFragments(document: TenderDocument): Promise<ExtractedFragment[]>;
}

export interface TenderAnalysisProvider {
  analyze(tender: Tender, profile: CompanyProfile): Promise<TenderAnalysis>;
  reanalyze(
    tender: Tender,
    profile: CompanyProfile,
    previous: TenderAnalysis | null,
  ): Promise<TenderAnalysis>;
}

export interface NotificationProvider {
  buildDailyDigest(
    analyses: TenderAnalysis[],
    tenders: Tender[],
    settings: DigestSettings,
  ): Promise<Digest>;
  sendUrgent(notification: Notification): Promise<void>;
  notifyDocumentChanged(tenderId: string): Promise<void>;
  notifyDeadlineApproaching(tenderId: string): Promise<void>;
}

export interface CompanyDataProvider {
  getProfile(organizationId: string): Promise<CompanyProfile>;
  getLicenses(organizationId: string): Promise<License[]>;
  getSro(organizationId: string): Promise<SroMembership[]>;
  getExperience(organizationId: string): Promise<ExperienceRecord[]>;
  getProductCatalog(organizationId: string): Promise<string[]>;
}

/* ==================== Платные источники: кэш и учёт расхода ==================== */

/**
 * Вид запроса к платному источнику: определяет группу суточного лимита и TTL кэша.
 *
 * Значения соответствуют эндпоинтам Контур.Закупок один к одному:
 *  - `search`   → POST /external/v1/search (группа лимита `search`);
 *  - `card`     → GET  /external/v1/purchases/{id} (группа `purchase`);
 *  - `testcard` → GET  /external/v1/testpurchases/{id} (бесплатно);
 *  - `limits`   → GET  /external/v1/limitGroups (бесплатно).
 *
 * Отдельных видов `documents` и `changes` нет: спецификация не содержит метода
 * для документов (ссылки приходят полем `Docs` карточки), а проверка изменений
 * читает ту же карточку — просто с более коротким TTL.
 */
export type KonturRequestKind = "search" | "card" | "testcard" | "limits";

/** Сохранённый сырой ответ. */
export interface KonturCacheEntry {
  cacheKey: string;
  /** Ответ API как есть (JSON). */
  payload: unknown;
  /** Момент получения, ISO-строка. */
  fetchedAt: string;
}

/** Что нужно, чтобы положить ответ в постоянное хранилище. */
export interface KonturRawResponseInput {
  cacheKey: string;
  kind: KonturRequestKind;
  url: string;
  method: "GET" | "POST";
  status: number;
  payload: unknown;
  /** Тело запроса (для POST-поиска) — нужно, чтобы воспроизвести запрос. */
  requestBody: unknown | null;
}

/** Запись журнала расхода API. */
export interface KonturUsageEntry {
  kind: KonturRequestKind;
  url: string;
  status: number | null;
  /** true — ответ взят из кэша, запрос к API не выполнялся. */
  fromCache: boolean;
  durationMs: number;
  at: string;
  error: string | null;
}

/** Порт хранения сырых ответов платного источника. */
export interface KonturRawResponseStore {
  read(cacheKey: string): Promise<KonturCacheEntry | null>;
  write(input: KonturRawResponseInput): Promise<void>;
}

/** Порт учёта расхода API. */
export interface KonturUsageSink {
  record(entry: KonturUsageEntry): Promise<void>;
}
