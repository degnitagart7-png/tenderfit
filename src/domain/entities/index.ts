import type {
  ConfidenceLevel,
  EvidenceSource,
  NotificationKind,
  PipelineStatus,
  PlacingWay,
  ProcessingJobStatus,
  ProcessingJobType,
  RequirementKind,
  RiskSeverity,
  SpecialistRegistry,
  SroKind,
  TenderDataSource,
  TenderDocumentType,
  TenderLaw,
  TenderVerdict,
} from "@/domain/enums";
import type { DocumentTerms } from "@/domain/documentTerms";

/** Реэкспорт перечислений для удобства: доменные типы импортируются из одного места. */
export type {
  ConfidenceLevel,
  EvidenceSource,
  NotificationKind,
  PipelineStatus,
  PlacingWay,
  ProcessingJobStatus,
  ProcessingJobType,
  RequirementKind,
  RiskSeverity,
  SpecialistRegistry,
  SroKind,
  TenderDataSource,
  TenderDocumentType,
  TenderLaw,
  TenderVerdict,
};

/* ============================== Пользователь и организация ============================== */

export type UserRole = "OWNER" | "ADMIN" | "MANAGER" | "ANALYST" | "VIEWER";

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  organizationId: string;
}

export interface Organization {
  id: string;
  name: string;
  inn: string;
}

/* ============================== Профиль компании ============================== */

export type TaxSystem = "OSNO" | "USN_INCOME" | "USN_INCOME_EXPENSES" | "PATENT";
export type LegalForm = "IP" | "OOO" | "AO" | "OTHER";

export interface CompanyCapability {
  /** Товары, работы, услуги — свободный список. */
  products: string[];
  works: string[];
  services: string[];
  brandsAndModels: string[];
  keywords: string[];
  synonyms: string[];
  stopWords: string[];
  okpd2Codes: string[];
}

export interface License {
  id: string;
  kind: string;
  number: string;
  issuer: string;
  validUntil: string | null;
  /** Подтверждена ли лицензия документально в профиле. */
  confirmed: boolean;
}

export interface SroMembership {
  id: string;
  /** Вид работ допуска: влияет на шкалу уровней ответственности. */
  kind: SroKind;
  /** Как допуск назван в выписке/профиле — свободный текст для показа. */
  type: string;
  /** Номер в реестре членов СРО (например, СРО-С-000-000000). */
  number: string;
  /**
   * Уровень ответственности (1..5 для строительства, 1..4 для изысканий
   * и проектирования). null — уровень в выписке не указан.
   */
  responsibilityLevel: number | null;
  /**
   * Предельная стоимость одного договора по этому допуску, ₽.
   * null — без ограничения. Заполняется из уровня ответственности
   * (ст. 55.16 ГрК РФ), но может быть задан вручную.
   */
  maxContractAmount: number | null;
  /** Дата окончания действия членства, ISO. null — бессрочно. */
  validUntil: string | null;
  confirmed: boolean;
}

/** Кадровый состав: численность и специалисты в реестрах НРС/НОПРИЗ. */
export interface StaffComposition {
  /** Штатная численность. null — не указана. */
  total: number | null;
  /** Специалистов в Национальном реестре специалистов (НОСТРОЙ), НРС. */
  nrsCount: number;
  /** Специалистов в реестре НОПРИЗ (изыскания и проектирование). */
  noprizCount: number;
}

/**
 * Совокупный опыт: сумма исполненных контрактов за периоды.
 * Значения заполняются вручную (так их указывает анкета контрагента)
 * либо считаются из записей опыта — см. resolveExperienceTotals.
 */
export interface ExperienceTotals {
  /** Сумма исполненных работ за предыдущий год, ₽. null — не задана. */
  lastYearAmount: number | null;
  /** Сумма исполненных работ за последние 3 года, ₽. null — не задана. */
  last3YearsAmount: number | null;
}

export interface ExperienceRecord {
  id: string;
  subject: string;
  customer: string;
  contractNumber: string;
  amount: number;
  completedAt: string;
  okpd2Code: string | null;
}

/** Жёсткие ограничения: нарушение ведёт к блокeру или ручной проверке. */
export interface CompanyRestriction {
  minPrice: number;
  maxPrice: number;
  /** Максимальная удалённость места поставки, км. null — без ограничения. */
  maxDistanceKm: number | null;
  /** Максимально допустимый срок оплаты (отсрочки), дней. */
  maxPaymentTermDays: number;
  /** Минимально допустимый срок поставки, дней (меньше — не успеваем). */
  minDeliveryTermDays: number;
  /** Минимально ожидаемая маржинальность, % (0..100). */
  minMarginPercent: number;
  maxBidSecurity: number;
  maxContractSecurity: number;
  /** Допускает ли компания участие без аванса. */
  allowNoAdvance: boolean;
  workRegions: string[];
  customerWhitelist: string[];
  customerBlacklist: string[];
  /** Дополнительные текстовые ограничения. */
  custom: string[];
}

/**
 * Предпочтения: влияют на приоритет и ранжирование, но не блокируют участие.
 * В отличие от жёстких ограничений (CompanyRestriction), нарушение предпочтения
 * не даёт блокера — только снижает привлекательность закупки.
 */
export interface CompanyPreferences {
  /** Регионы-приоритеты (не исключают другие, но повышают ранг). */
  priorityRegions: string[];
  /** Желаемый коридор НМЦК — вне его закупка ниже в приоритете, но не отсекается. */
  preferredMinPrice: number | null;
  preferredMaxPrice: number | null;
  /** Предпочтительна закупка с авансом. */
  preferAdvance: boolean;
  /** Предпочтителен короткий срок оплаты (отсрочки). */
  preferShortPaymentTerm: boolean;
  /** Предпочтительные бренды/модели для поставки. */
  priorityBrands: string[];
  /** Избегать контрактов с казначейским сопровождением (мягкий приоритет). */
  avoidTreasurySupport: boolean;
  /** Текстовые предпочтения/комментарии приоритетов. */
  notes: string[];
}

export interface CompanyDocument {
  id: string;
  fileName: string;
  fileType: "pdf" | "docx" | "csv" | "txt" | "unknown";
  size: number;
  uploadedAt: string;
  /** Извлечённый текст документа. */
  text: string;
  /** Количество страниц (для PDF). */
  pageCount?: number;
  /** Категория документа. */
  category: "license" | "sro" | "experience" | "financial" | "other";
}

export interface CompanyProfile {
  organizationId: string;
  legalName: string;
  inn: string;
  legalForm: LegalForm;
  taxSystem: TaxSystem;
  worksWithVat: boolean;
  activityDescription: string;
  capabilities: CompanyCapability;
  restrictions: CompanyRestriction;
  preferences: CompanyPreferences;
  licenses: License[];
  sroMemberships: SroMembership[];
  hasPersonnel: boolean;
  hasEquipment: boolean;
  /** Кадровый состав: численность, специалисты в НРС и НОПРИЗ. */
  staff: StaffComposition;
  /** Открыт ли специальный счёт для обеспечения заявок/контрактов. */
  hasSpecialAccount: boolean;
  experience: ExperienceRecord[];
  /** Совокупный опыт по суммам (анкета контрагента указывает именно суммы). */
  experienceTotals: ExperienceTotals;
  /** Загруженные документы компании. */
  documents: CompanyDocument[];
}

/* ============================== Профиль поиска ============================== */

export interface SearchProfile {
  id: string;
  name: string;
  laws: TenderLaw[];
  keywords: string[];
  stopWords: string[];
  okpd2Codes: string[];
  regions: string[];
  /** ИНН заказчиков: непустой список ограничивает профиль этими заказчиками. */
  customerInns: string[];
  minPrice: number | null;
  maxPrice: number | null;
  onlyOpenForSubmission: boolean;
  enabled: boolean;
}

/* ============================== Закупка ============================== */

export interface TenderRequirement {
  id: string;
  kind: RequirementKind;
  title: string;
  description: string;
  /** Является ли требование обязательным (единообразное для всех участников). */
  mandatory: boolean;
  /** Требуемое значение/идентификатор (например, тип лицензии). */
  requiredValue: string | null;
  evidenceId: string | null;
}

export interface TenderLot {
  id: string;
  number: number;
  subject: string;
  price: number;
  okpd2Codes: string[];
  deliveryRegion: string;
  deliveryAddress: string;
  deliveryTermDays: number | null;
}

export interface TenderFinancialTerms {
  /**
   * НМЦК. Нуль означает «цена не опубликована», а не бесплатную закупку:
   * коммерческие торги Сбербанк-АСТ публикуются без цены примерно в половине
   * случаев (запросы предложений, запросы цен). Сравнивать нуль с лимитами
   * профиля нельзя — см. isPriceKnown.
   */
  price: number;
  currency: string;
  advancePercent: number | null;
  advanceAmount: number | null;
  paymentTermDays: number;
  /** Оплата после поставки (постоплата), дней. */
  postpaymentDays: number | null;
  bidSecurityAmount: number | null;
  bidSecurityPercent: number | null;
  contractSecurityAmount: number | null;
  contractSecurityPercent: number | null;
  treasurySupport: boolean;
  expectedMarginPercent: number | null;
}

/** Цена опубликована и её можно сравнивать с границами профиля. */
export function isPriceKnown(price: number | null | undefined): price is number {
  return typeof price === "number" && price > 0;
}

/**
 * Значение поля `region`, когда регион установить не удалось.
 *
 * Это именно «не известно», а не «не совпадает»: в живой выдаче ЕИС региона
 * нет, и по состоянию на 22.09.2026 такое значение у 109 закупок из 151.
 * Фильтры обязаны отличать неизвестный регион от другого региона — иначе
 * большинство закупок исчезает молча (см. `matchesSearchProfile`).
 */
export const UNKNOWN_REGION = "Не указан";

/** Регион закупки определён, а не оставлен заглушкой. */
export function isRegionKnown(region: string | null | undefined): boolean {
  const value = (region ?? "").trim();
  return value.length > 0 && value !== UNKNOWN_REGION;
}

/**
 * Значение поля `customerName`, когда заказчик установить не удалось.
 *
 * Пара к `UNKNOWN_REGION`: списки закупок не должны печатать заглушку как
 * будто это данные («Заказчик не указан · Не указан» читается как поломка),
 * поэтому строки списков показывают только известные части строки.
 */
export const UNKNOWN_CUSTOMER = "Заказчик не указан";

/** Заказчик закупки определён, а не оставлен заглушкой. */
export function isCustomerKnown(customerName: string | null | undefined): boolean {
  const value = (customerName ?? "").trim();
  return value.length > 0 && value !== UNKNOWN_CUSTOMER;
}

export interface TenderDeadline {
  submissionEnd: string;
  publicationDate: string;
  lastUpdateDate: string;
  deliveryTermDays: number | null;
  warrantyMonths: number | null;
}

export interface TenderDocument {
  id: string;
  type: TenderDocumentType;
  title: string;
  fileName: string;
  url: string;
  /** Извлечённый текст (в mock — сокращённые фрагменты). */
  text: string;
  pageCount: number | null;
  lastModified: string | null;
}

export interface Tender {
  /**
   * Запрос живого поиска, которым закупка найдена. Нужен, чтобы закупка, найденная
   * по близкому слову («ремонт» вместо «строительство»), показывалась в ленте по
   * исходному запросу человека, хотя его слов в названии нет.
   */
  liveQuery?: string | null;
  /**
   * Слова профилей, под которые закупку отобрала модель по смыслу при обходе
   * региона («Благоустройство территории» для «строительство, ремонт»). Лента
   * показывает такую закупку по этим словам, хотя в названии их нет.
   */
  senseKeywords?: string[] | null;
  id: string;
  regNumber: string;
  externalId: string | null;
  law: TenderLaw;
  placingWay: PlacingWay;
  subject: string;
  customerName: string;
  customerInn: string | null;
  region: string;
  deliveryAddress: string;
  financial: TenderFinancialTerms;
  deadlines: TenderDeadline;
  okpd2Codes: string[];
  lots: TenderLot[];
  requirements: TenderRequirement[];
  documents: TenderDocument[];
  nationalRegime: boolean;
  onlyForSmp: boolean;
  eisUrl: string;
  dataSource: TenderDataSource;
  /** История изменений документации. */
  changeLog: ChangeLogEntry[];
  /**
   * Метка последней записи строки источником (`tenders.synced_at`).
   *
   * Один прогон пишет всем своим строкам одно и то же значение, поэтому метка
   * работает как идентификатор партии: по ней находится результат последнего
   * поиска Контур.Закупок. Поля необязательные — их заполняют только
   * источники из БД, у демо-данных и части фикстур меток нет.
   */
  syncedAt?: string | null;
  /** Когда закупка впервые появилась в базе (`tenders.created_at`). */
  firstSeenAt?: string | null;
  /**
   * Условия, взятые из текста документации, а не из реквизитов площадки:
   * значения уже подставлены в `financial`, здесь — откуда они и цитата.
   * Пусто, когда площадка отдала всё сама или документация не разобрана.
   */
  documentTerms?: DocumentTerms | null;
}

/* ============================== Анализ ============================== */

export interface Evidence {
  id: string;
  source: EvidenceSource;
  documentId: string | null;
  documentTitle: string | null;
  page: number | null;
  section: string | null;
  quote: string;
  confidence: ConfidenceLevel;
}

export interface AnalysisScore {
  subjectFit: number;
  legalEligibility: number;
  operationalFit: number;
  financialFit: number;
  /** Риск договора: чем выше, тем хуже (инвертируется в итоговом score). */
  contractRisk: number;
}

export interface AnalysisFinding {
  id: string;
  text: string;
  evidenceId: string | null;
}

export interface HardBlocker {
  id: string;
  reason: string;
  detail: string;
  evidenceId: string | null;
  /** Критический блокер всегда даёт NOT_RECOMMENDED. */
  critical: boolean;
}

export interface Uncertainty {
  id: string;
  question: string;
  detail: string;
  evidenceId: string | null;
  /** Существенная неопределённость не даёт RECOMMENDED. */
  material: boolean;
}

export interface ContractRisk {
  id: string;
  title: string;
  detail: string;
  severity: RiskSeverity;
  evidenceId: string | null;
  /** Категория риска для группировки в UI. */
  category?: ContractRiskCategory;
}

/** Категория договорного риска. */
export type ContractRiskCategory =
  | "PENALTY"
  | "ACCEPTANCE"
  | "UNILATERAL_REFUSAL"
  | "WARRANTY"
  | "TREASURY"
  | "PAYMENT_TERMS"
  | "CASH_GAP";

/** Специфика 223-ФЗ: положение о закупке, спецтребования, отличия от 44-ФЗ. */
export interface Fz223Specific {
  /** Краткое описание положения о закупке заказчика. */
  regulationSummary: string;
  /** Специальные требования заказчика (из положения). */
  customerRequirements: string[];
  /** Нестандартные критерии оценки заявок. */
  nonStandardCriteria: string[];
  /** Ключевые отличия от типовой логики 44-ФЗ. */
  differencesFrom44: string[];
  evidenceId: string | null;
}

/** Детализация операционной оценки по пунктам. */
export interface OperationalFitDetails {
  /** Срок поставки достаточен. */
  deliveryTerm: { ok: boolean; detail: string; evidenceId: string | null };
  /** География соответствует профилю. */
  geography: { ok: boolean; detail: string; evidenceId: string | null };
  /** Есть персонал. */
  personnel: { ok: boolean; detail: string; evidenceId: string | null };
  /** Есть техника/оборудование. */
  equipment: { ok: boolean; detail: string; evidenceId: string | null };
  /** Склад/логистика доступны. */
  logistics: { ok: boolean; detail: string; evidenceId: string | null };
  /** Ресурсы на выполнение. */
  resources: { ok: boolean; detail: string; evidenceId: string | null };
}

/** Детальная запись изменения документации. */
export interface ChangeLogEntry {
  date: string;
  description: string;
  /** Какой документ изменился (id). */
  documentId?: string;
  /** Повлияло ли это на вердикт. */
  affectedVerdict?: boolean;
  /** Нужно ли повторно проверить. */
  requiresRecheck?: boolean;
  /** Критическое изменение (уведомление). */
  critical?: boolean;
}

export interface RequiredDocument {
  id: string;
  title: string;
  /** Подтверждено ли наличие документа в профиле компании. */
  confirmedInProfile: boolean;
}

export interface TenderAnalysis {
  id: string;
  tenderId: string;
  verdict: TenderVerdict;
  fitScore: number;
  confidence: number;
  summary: string;
  scores: AnalysisScore;
  positiveFactors: AnalysisFinding[];
  negativeFactors: AnalysisFinding[];
  hardBlockers: HardBlocker[];
  uncertainties: Uncertainty[];
  requirements: TenderRequirement[];
  requiredDocuments: RequiredDocument[];
  deadlines: TenderDeadline;
  financialTerms: TenderFinancialTerms;
  contractRisks: ContractRisk[];
  nextActions: string[];
  evidence: Evidence[];
  analyzedAt: string;
  /** Специфика 223-ФЗ (только для FZ_223). */
  fz223Specific?: Fz223Specific;
  /** Детализация операционной оценки по пунктам. */
  operationalFitDetails?: OperationalFitDetails;
}

/* ============================== Разбор требований ============================== */

/** Группа требований на вкладке «Требования». */
export type RequirementGroupKey =
  | "SUBJECT"
  | "ADMISSION"
  | "APPLICATION_DOCS"
  | "DEADLINES"
  | "ECONOMICS"
  | "CONTRACT_TERMS";

/** Статус соответствия группы требований профилю компании. */
export type RequirementGroupStatus = "MATCH" | "REVIEW" | "MISMATCH";

export interface RequirementItem {
  id: string;
  label: string;
  value: string;
  /** Есть ли в профиле подтверждение/мощность под это требование. */
  status: RequirementGroupStatus;
  /** Идентификатор доказательства, если требование извлечено из документа. */
  evidenceId: string | null;
}

export interface RequirementGroup {
  key: RequirementGroupKey;
  title: string;
  status: RequirementGroupStatus;
  items: RequirementItem[];
}

/* ============================== Ручная проверка ============================== */

/** Действие аналитика по итогам ручной проверки. */
export type ManualReviewOutcome =
  | "CONFIRMED"
  | "REJECTED"
  | "CLARIFICATION_REQUESTED";

export interface ManualReviewDecision {
  id: string;
  tenderId: string;
  outcome: ManualReviewOutcome;
  /** Отмеченные пункты чек-листа (id → true). */
  checklist: Record<string, boolean>;
  comment: string;
  /** Вердикт системы на момент решения — для трассировки. */
  systemVerdict: TenderVerdict;
  decidedAt: string;
}

/* ============================== Импорт закупок ============================== */

/** Черновик закупки, загружаемый вручную или из CSV (до анализа). */
export interface ImportedTender {
  id: string;
  regNumber: string;
  law: TenderLaw;
  placingWay: PlacingWay;
  subject: string;
  customerName: string;
  customerInn: string | null;
  region: string;
  price: number;
  okpd2Codes: string[];
  submissionEnd: string;
  deliveryTermDays: number | null;
  /** Полный текст документации для разбора (в демо — вставляется вручную). */
  documentsText: string;
  importedAt: string;
  source: "CSV" | "MANUAL";
}

/* ============================== Воронка, отчёты, прочее ============================== */

export interface TenderDecision {
  tenderId: string;
  verdict: TenderVerdict;
  fitScore: number;
  useful: boolean | null;
  comment: string | null;
  decidedAt: string;
}

export interface PipelineItem {
  tenderId: string;
  status: PipelineStatus;
  updatedAt: string;
  note: string | null;
}

export interface DigestSettings {
  /** Присылать утреннюю сводку на почту аккаунта. */
  enabled: boolean;
  /** Время сводки по часовому поясу клиента, «ЧЧ:ММ». */
  sendTime: string;
  /** Устаревшее: письма идут на почту аккаунта, поле оставлено для старых сохранений. */
  email: string;
  minFitScore: number;
  urgentEnabled: boolean;
  urgentDeadlineHours: number;
  documentChangesEnabled: boolean;
  /**
   * Часовой пояс клиента (IANA, например «Asia/Irkutsk»). Нет — страница берёт пояс
   * браузера и сохраняет его при первом открытии; пока не сохранён, письма идут по Москве.
   * Необязательное поле: настройки, сохранённые до писем, его не содержат.
   */
  timeZone?: string;
  /** Письмо «готов анализ или смета». Нет — включено. */
  readyEnabled?: boolean;
}

export interface Digest {
  id: string;
  date: string;
  totalNew: number;
  recommended: string[];
  manualReview: string[];
  closingSoon: string[];
  excluded: { tenderId: string; reason: string }[];
  documentChanges: string[];
}

export interface FeedbackEvent {
  id: string;
  tenderId: string;
  verdict: TenderVerdict;
  useful: boolean;
  comment: string | null;
  createdAt: string;
}

export interface ProcessingJob {
  id: string;
  type: ProcessingJobType;
  status: ProcessingJobStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: number;
  message: string;
  error: string | null;
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}
