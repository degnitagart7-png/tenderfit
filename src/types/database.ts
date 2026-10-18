// TypeScript types matching supabase/migrations/20260921000000_create_document_analysis_pipeline.sql

export type DocumentSourceType =
  | "torgi_open_data"
  | "eis_api"
  | "manual_upload"
  | "kontur_api"
  | "tektorg_api";
export type DocumentType =
  | "notice"
  | "protocol"
  | "contract"
  | "attachment"
  | "other"
  | "tz"
  | "requirements";
export type DownloadStatus =
  | "pending"
  | "downloading"
  | "downloaded"
  | "failed";
export type ParsedStatus =
  | "pending"
  | "parsing"
  | "parsed"
  | "needs_ocr"
  | "failed";
export type JobType = "full_analysis" | "reanalyze" | "parse_only";
export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type Verdict = "RECOMMENDED" | "MANUAL_REVIEW" | "NOT_RECOMMENDED";
export type TriggeredBy =
  | "document_analysis"
  | "metadata_analysis"
  | "manual_override";

/**
 * Почему вложение не попало в разбор.
 *
 * Значение пишется в tender_documents.raw_json.skipped.code и показывается
 * партнёру в карточке закупки, поэтому набор закрыт: интерфейс отличает
 * осознанный пропуск от настоящей ошибки разбора и подписывает его по-русски.
 */
export type SkippedCode =
  | "over_char_budget"
  | "file_too_large"
  | "unsupported_format"
  | "empty_text"
  | "download_failed"
  | "parse_failed"
  /**
   * Том комплекта, прочитанный вместе с первым томом.
   *
   * Не ошибка и не отказ: текст всего комплекта лежит в строке первого тома, а
   * эта строка существует, чтобы том не скачивался заново на каждом прогоне и
   * чтобы партнёр видел во вкладке все файлы, которые выложил заказчик.
   */
  | "volume_of_set";

/** Признак пропуска в raw_json: код для интерфейса и готовая причина для партнёра. */
export interface DocumentSkipMark {
  code: SkippedCode;
  reason: string;
}

/**
 * Текст документа дошёл до разбора не целиком.
 *
 * Бюджет знаков на закупку конечный, и файл, которому остатка не хватило,
 * обрезается. Молчать об этом нельзя: на живой закупке 32616393585 архив
 * «ДОЗ.zip» из 15 вложений отдал 2 — остальное не влезло, а модель отвечала
 * так, будто документация прочитана вся.
 */
export interface DocumentTruncation {
  /** Для архива: сколько входов прочитано из скольких; null — файл не архив. */
  archive: { parsed: number; total: number } | null;
}

/**
 * Служебные поля, которые локальный скрипт кладёт в tender_documents.raw_json.
 *
 * Колонка JSONB уже есть, поэтому миграция не нужна; здесь только то, что читает
 * приложение. `chars` — сколько знаков документ занял в бюджете закупки:
 * по нему повторный прогон понимает, что осталось на вложения.
 */
export interface DocumentRawJson {
  title?: string;
  chars?: number;
  /** true — текст обрезан по остатку бюджета знаков на закупку. */
  truncated?: boolean;
  /** Прочитано входов архива из скольких; только когда truncated и файл — архив. */
  archive?: { parsed: number; total: number };
  /**
   * Текст распознан со скана (OCR), а не прочитан из файла: сколько страниц
   * распознано и сколько их в файле. Нет поля — текст был в самом файле. Первая
   * строка такого текста — «[Текст распознан со скана: N стр. из M]».
   */
  ocr?: { pages: number; totalPages: number };
  skipped?: DocumentSkipMark;
}

export interface TenderDocumentRow {
  id: string;
  tender_id: string;
  source_type: DocumentSourceType;
  filename: string;
  document_type: DocumentType;
  file_url: string | null;
  raw_json: Record<string, unknown> | null;
  file_size: number | null;
  mime_type: string | null;
  download_status: DownloadStatus;
  parsed_status: ParsedStatus;
  parsed_text: string | null;
  parsed_sections: unknown[] | null;
  content_hash: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Служебные поля документа без тяжёлого parsed_text: текст извещения весит
 * сотни килобайт, а карточке закупки нужны только статус и заголовок.
 */
export interface DocumentMeta {
  id: string;
  filename: string;
  document_type: DocumentType;
  source_type: DocumentSourceType;
  file_url: string | null;
  parsed_status: ParsedStatus;
  download_status: DownloadStatus;
  content_hash: string | null;
  file_size: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  raw_json: DocumentRawJson | null;
}

export interface DocumentAnalysisRow {
  id: string;
  tender_id: string;
  document_id: string;
  model_used: string;
  analysis: {
    findings: AnalysisFinding[];
    summary: string;
  };
  verdict_before: Verdict | null;
  verdict_after: Verdict | null;
  old_score: number | null;
  new_score: number | null;
  confidence_score: number | null;
  tokens_used: number | null;
  processing_time_ms: number | null;
  created_at: string;
}

export interface AnalysisFinding {
  category: "blocker" | "risk" | "requirement" | "neutral";
  title: string;
  detail: string;
  evidence_quote: string;
  evidence_section: string;
  severity: "high" | "medium" | "low";
  /**
   * Вид требования к участнику — для сверки с профилем компании. Есть только у
   * blocker и requirement из разборов после его появления; у прежних разборов
   * вид восстанавливается по тексту (src/domain/profileMatch.ts).
   */
  requirement_kind?: FindingRequirementKind | null;
  /** Что именно требуется: «лицензия МЧС…», «опыт не менее 20% НМЦК». */
  required_value?: string | null;
}

/** Виды требований, которые модель отмечает у фактора. */
export const FINDING_REQUIREMENT_KINDS = [
  "LICENSE",
  "SRO",
  "EXPERIENCE",
  "QUALIFIED_PERSONNEL",
  "EQUIPMENT",
  "SMP",
  "SECURITY",
  "DECLARATION",
  "OTHER",
] as const;

export type FindingRequirementKind = (typeof FINDING_REQUIREMENT_KINDS)[number];

export interface AnalysisJobRow {
  id: string;
  tender_id: string;
  job_type: JobType;
  status: JobStatus;
  priority: number;
  documents_total: number;
  documents_processed: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  /** Почта того, кто поставил разбор (с 14.10.2026); null — служебные и старые задачи. */
  requested_by?: string | null;
  /** Когда по задаче разобрались с письмом «анализ готов» (миграция 20261015000024); null — не разбирались. */
  notified_at?: string | null;
}

export interface VerdictHistoryRow {
  id: string;
  tender_id: string;
  old_verdict: Verdict | null;
  new_verdict: Verdict;
  old_score: number | null;
  new_score: number | null;
  reason: string;
  triggered_by: TriggeredBy;
  analysis_id: string | null;
  created_at: string;
}

// Types for tenders table (EIS integration)

export type TenderLaw = "FZ_44" | "FZ_223" | "PP_RF_615" | "COMMERCIAL";
export type PlacingWay =
  | "ELECTRONIC_AUCTION"
  | "OPEN_CONTEST"
  | "REQUEST_FOR_QUOTATION"
  | "REQUEST_FOR_PROPOSALS"
  | "SOLE_SUPPLIER"
  | "OTHER";
export type TenderDataSource =
  | "MOCK"
  | "EIS"
  | "IMPORT"
  | "SBER_AST"
  | "KONTUR"
  | "TEK_TORG"
  | "ROSELTORG"
  | "FABRIKANT";

export interface TenderRow {
  id: string;
  reg_number: string;
  external_id: string | null;
  law: TenderLaw;
  placing_way: PlacingWay;
  subject: string;
  customer_name: string;
  customer_inn: string | null;
  region: string;
  delivery_address: string | null;
  price: number | null;
  currency: string;
  advance_payment: number | null;
  security_bid: number | null;
  security_contract: number | null;
  submission_end: string;
  publication_date: string | null;
  last_update_date: string | null;
  delivery_term_days: number | null;
  delivery_date_end: string | null;
  okpd2_codes: string[] | null;
  lots: unknown[] | null;
  requirements: unknown[] | null;
  national_regime: boolean;
  only_for_smp: boolean;
  eis_url: string | null;
  data_source: TenderDataSource;
  change_log: unknown[] | null;
  /** Последний сырой ответ источника по этой закупке (миграция 20260921000003). */
  raw_data?: Record<string, unknown> | null;
  /** Момент последнего получения записи из источника. */
  synced_at?: string | null;
  /**
   * Условия из текста документации (миграция 20261005000015): обеспечение и
   * аванс, которых площадка не отдала. Читается через parseDocumentTerms.
   */
  doc_terms?: unknown;
  created_at: string;
  updated_at: string;
}

// Types for Контур.Закупки integration (migration 20260921000003)

/**
 * Вид запроса к Контур.Закупкам. Совпадает с `KonturRequestKind` из
 * `src/adapters/types.ts`; дубль нужен, потому что типы строк БД не должны
 * зависеть от слоя адаптеров. Значения закреплены CHECK-ограничением
 * `kontur_raw_responses.kind` в миграции 20260921000003.
 */
export type KonturRequestKind = "search" | "card" | "testcard" | "limits";

/** Строка кэша сырых ответов Контур.Закупок. */
export interface KonturRawResponseRow {
  id: string;
  cache_key: string;
  kind: KonturRequestKind;
  url: string;
  method: "GET" | "POST";
  status: number;
  request_body: Record<string, unknown> | null;
  payload: Record<string, unknown> | unknown[] | null;
  fetched_at: string;
  created_at: string;
}

/** Строка журнала расхода платного API. */
export interface ApiUsageLogRow {
  id: string;
  provider: string;
  kind: string;
  url: string;
  status: number | null;
  from_cache: boolean;
  duration_ms: number;
  error: string | null;
  requested_at: string;
}

/** Сводка расхода API за период. */
export interface ApiUsageSummary {
  /** Реальные обращения к платному API (from_cache = false). */
  apiCalls: number;
  /** Сколько раз ответ взят из кэша без обращения к API. */
  cacheHits: number;
  errors: number;
  firstCallAt: string | null;
  lastCallAt: string | null;
}

/**
 * Вид задания в очереди `sync_jobs`.
 *
 * `documents` — догрузить документацию по номерам и разобрать очередь
 * `analysis_jobs`; платных запросов к источникам не делает. `full_sync` —
 * полный прогон вне расписания, он может потратить поиски Контур.Закупок,
 * поэтому ограничен суточным бюджетом и интервалом, как плановое задание.
 */
export type SyncJobKind = "documents" | "full_sync" | "estimate";

export type SyncJobStatus = "pending" | "processing" | "completed" | "failed";

/** Параметры задания: что именно догрузить и почему задание поставлено. */
export interface SyncJobPayload {
  /** Номера закупок (reg_number), по которым нужна документация. */
  regNumbers?: string[];
  /**
   * Закупку добавил человек по ссылке или номеру (`/api/tenders/link`): до
   * загрузки документов воркер берёт из ЕИС закупки, которых ещё нет в базе.
   */
  importFromLink?: boolean;
  /**
   * Закупка, для которой считается смета. Только для вида `estimate`.
   *
   * Хранится отдельно от `regNumbers`, потому что по нему ищут: карточка
   * закупки при открытии достаёт последнюю смету, и запрос идёт по индексу
   * `sync_jobs_estimate_tender_idx`.
   */
  tenderId?: string;
  /** Наименование объекта для шапки сметы. */
  subject?: string;
  /**
   * Ценовая зона ФГИС ЦС, выбранная пользователем вручную. Только для вида
   * `estimate`. Нет — воркер определяет зону по региону, адресу и заказчику
   * закупки и, если не может, отказывает.
   */
  priceZoneId?: number;
  /**
   * Выбор пользователя для сметы: вид работ, условия производства работ, сроки (см.
   * `EstimateOptions`). Нет — начислений сверх норм нет. Воркер приводит значение к виду, пригодному
   * для расчёта, заново: payload пришёл из базы.
   */
  estimateOptions?: {
    phase?: "CONSTRUCTION" | "RECONSTRUCTION" | "CAPITAL_REPAIR" | "DEMOLITION" | null;
    workKind?: string | null;
    conditionIds?: readonly string[];
    newConstructionNorms?: boolean;
    winterWork?: "YES" | "NO" | "PART" | null;
    workPeriod?: { start: string | null; end: string | null } | null;
    winterPartId?: string | null;
    /** Метод расчёта; нет — как у заказчика (по документации), по умолчанию ресурсно-индексный. */
    method?: "RESOURCE_INDEX" | "BASE_INDEX" | null;
  };
  /**
   * Что считать по заданию `estimate`. `estimate` (по умолчанию) — смета по
   * ведомости объёмов; `audit` — построчная проверка локальной сметы заказчика:
   * без модели и токенов, по ценам зоны. Отдельного вида задания нет намеренно:
   * список видов закреплён ограничением в базе, а миграция ради этого не нужна.
   */
  mode?: "estimate" | "audit";
  /**
   * Тексты документов, присланные пользователем с экрана «Смета».
   *
   * Лежат в задании целиком: файлы разбираются в браузере, на сервер уходит
   * только текст, и хранить его больше негде — закупки, к которой его можно
   * было бы привязать, у такого расчёта нет.
   */
  documents?: { name: string; text: string }[];
  /** Откуда задание: 'press' — кнопка «Найти новые закупки», 'manual' — панель. */
  reason?: string;
  /**
   * Запрос живого поиска. Только для вида `full_sync`.
   *
   * Есть — воркер ищет этот запрос на бесплатных площадках и только добавляет
   * найденное, ничего не удаляя; нет — это обычный полный прогон. Отдельного
   * вида задания нет намеренно: список видов закреплён ограничением в базе, и
   * новый вид потребовал бы миграции.
   */
  liveQuery?: string;
  /** Регионы живого поиска (названия); нет — вся Россия. */
  liveRegions?: string[];
  /** Близкие слова запроса (от модели), которые ищутся вместе с ним. */
  liveKeywords?: string[];
  /**
   * Читать ли карточку Контур.Закупок, когда ЕИС документацию не отдала.
   *
   * Каждый такой запрос платный (группа `purchase` тарифа), поэтому флаг
   * появляется только в задании, которое партнёр поставил явно на одну закупку,
   * и никогда — в плановом прогоне. Отсутствие флага читается как false:
   * задания, поставленные до его появления, бесплатны.
   */
  konturCards?: boolean;
  /**
   * Разобрать закупку моделью сразу после загрузки документации. Ставит кнопка
   * «Глубокий анализ»; отсутствие флага — только загрузка, как раньше.
   */
  analyze?: boolean;
}

/**
 * Итог выполнения задания.
 *
 * Поля необязательные: воркер пишет только то, что реально сделал, а панель
 * показывает пустое место как «нет данных», а не как ноль. Ноль и «не
 * измеряли» — разные утверждения, и путать их в отчёте о платном прогоне нельзя.
 * Сколько задание выполнялось, здесь не хранится: `claimed_at` и `finished_at`
 * строки дают то же число без второго источника правды.
 */
export interface SyncJobReport {
  /** Закупок было в задании. */
  tenders?: number;
  /**
   * Закупок, чья документация получена этим прогоном.
   *
   * Единица — закупки, а не файлы, как и у соседних полей: задание по двум
   * закупкам может скачать полтора десятка файлов, и в отчёте это «закупок 2,
   * загружено 2». Сколько именно файлов легло в базу, видно в журнале воркера
   * на сервере («сохранено 5 (122 993 знаков)»), а не здесь.
   */
  documents?: number;
  /** Документация уже лежала в базе — повторно не качалась. */
  already?: number;
  /** Закупки, документацию которых источник не отдал. */
  unavailable?: number;
  /** Закупки, которых нет в ленте: задачам по ним браться неоткуда. */
  notFound?: number;
  /** Сбои загрузки. */
  failed?: number;
  /** Задач глубокого разбора закрыто тем же прогоном. */
  analysisJobs?: number;
  /**
   * Прогон прерван по времени: часть закупок осталась необработанной.
   *
   * Без этого флага отчёт «загружено 12 из 60» читался бы как успех, хотя
   * сорок восемь закупок дойдут только следующим прогоном.
   */
  stoppedEarly?: boolean;
  /** Короткая строка о плановом прогоне: его выполняет отдельный скрипт. */
  note?: string;
  /**
   * Результат расчёта сметы. Только для вида `estimate`.
   *
   * Документ лежит в отчёте целиком, вместе с ресурсными строками: из него
   * собираются и форма локальной сметы, и книга Excel, и ведомость объёмов, а
   * пересчитывать смету ради выгрузки значит получить другой документ — база
   * цен и редакция нормативов к тому времени могут смениться.
   */
  estimate?: EstimateJobResult;
  /** Результат аудита сметы заказчика. Только для задания `estimate` с `mode: "audit"`. */
  audit?: AuditJobResult;
}

/** Что воркер посчитал по заданию `estimate` в режиме `audit`. */
export interface AuditJobResult {
  /** Отчёты `AuditReport` по каждой распознанной смете. */
  reports: unknown[];
  /** Ценовая зона, по которой шла проверка, и почему она выбрана. */
  zone: { priceZoneId: number; zoneName: string; basis: string; matched: string | null; northZone: string };
  /** Период цен зоны. */
  period: string;
  /** Сметы, не подошедшие под форму 421/пр, с причинами. */
  notRecognized: { documentName: string; estimateName: string | null; reason: string }[];
}

/** Что воркер посчитал по заданию `estimate`. */
export interface EstimateJobResult {
  /** Готовый сметный документ (`EstimateDocument`), как его собрал расчёт. */
  document: unknown;
  /** Строки ведомости, не подтверждённые документацией, с причинами. */
  rejected: unknown[];
  /** Документы, в которых ведомости не нашлось вовсе. */
  documentsWithoutBill: string[];
  /** Документы и файлы архивов, которые модель не читала: объёмов в них не видно (проект контракта, требования к заявке, формы). */
  skippedNoVolumes?: { name: string; reason: string; chars: number }[];
  /** Сколько позиций вошло в ведомость. */
  billItems: number;
  /** Потрачено токенов модели на извлечение ведомости. */
  tokensUsed: number;
  /**
   * Подбор норм «ИИ-сметчиком» (`NormPickStats`): позиций отправлено, принято, отклонено проверкой, откатилось на подбор по
   * наименованию (`fallback`, `failedBatches`), подсвечено «проверьте», токены. Нет у расчётов до подбора норм ИИ.
   */
  normPick?: {
    requested: number;
    picked: number;
    declined: number;
    rejected: number;
    fallback: number;
    review: number;
    demolitionCoefficients: number;
    skipped: number;
    /** Материалы (поставка): опознано строк, неясных, отправлено модели, принято ресурсов, отклонено, выбрано без модели, без цены. Нет у расчётов до подбора ресурсов. */
    materialRows?: number;
    ambiguousRows?: number;
    materialRequested?: number;
    materialPicked?: number;
    materialRejected?: number;
    materialFallback?: number;
    materialUnpriced?: number;
    /** Материал нормы «по проекту» (ведомость без сметы заказчика): отправлено модели, принято, отказано, отклонено проверкой, выбрано кодом без модели. Нет у расчётов до этого этапа. */
    normMaterialRequested?: number;
    normMaterialPicked?: number;
    normMaterialDeclined?: number;
    normMaterialRejected?: number;
    normMaterialFallback?: number;
    batches: number;
    failedBatches: number;
    tokens: number;
    notes: string[];
  };
  /**
   * Строки, добавленные расчётом сверх ведомости (`GeneratedStats`): мусор по тоннажу из норм (`debris`) и работы по технологии от ИИ (`implied`) —
   * сколько добавлено, на сколько рублей, сколько отклонила проверка. Нет у расчётов до этих этапов.
   */
  generated?: {
    debris: { enabled: boolean; rows: number; tons: number; distanceKm: number | null; unpriced: number; skipped: string | null; rub: number };
    implied: { enabled: boolean; proposed: number; accepted: number; rejected: number; failed: number; tokens: number; rub: number; skipped: string | null; notes: string[] };
  };
  /**
   * Откуда взяты объёмы: уровень источника (ведомость, смета заказчика, ТЗ и
   * таблицы проекта), документы и пояснение. Нет у расчётов, посчитанных до
   * приоритета источников.
   */
  volumeSource?: { level: "BILL" | "CUSTOMER_ESTIMATE" | "CONTRACT_ESTIMATE" | "SPEC"; documents: string[]; note: string; details?: string[] } | null;
  /**
   * Локальные сметы заказчика, прочитанные кодом (`LsrSourceInfo`): по одной на смету, без повторов между
   * документами. Нет у расчётов, посчитанных до чтения смет кодом, и у закупок без разборной ЛСР.
   */
  customerLsrs?: unknown[];
  /** Сверка сметы контракта (приказ 841/пр) с ЛСР (`ContractCheck`); нет, когда сверять не с чем. */
  contractCheck?: unknown;
  /** Расхождения объёмов ведомости и сметы заказчика (`VolumeFinding`): на сумму не влияют. */
  volumeFindings?: unknown[];
  /** Позиции, норма которых взята по шифру из документа (`NormHintNote`). */
  normHints?: unknown[];
  /** Документы, попавшие в набор дважды и посчитанные один раз. */
  duplicateDocuments?: { name: string; duplicateOf: string }[];
  /**
   * Ведомость, как она ушла в расчёт, сведения о подборе норм и то, чем повторить расчёт без
   * модели (`EstimateBillSnapshot`). По ней человек правит ведомость, а `/api/estimate/recalc`
   * пересчитывает смету. Нет у расчётов, посчитанных до правки ведомости: править их нельзя.
   */
  bill?: unknown;
}

export interface SyncJobRow {
  id: string;
  kind: SyncJobKind;
  status: SyncJobStatus;
  payload: SyncJobPayload;
  requested_by: string | null;
  attempts: number;
  worker_id: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  report: SyncJobReport | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  /** Когда по заданию разобрались с письмом «смета готова» (миграция 20261015000024); null — не разбирались. */
  notified_at?: string | null;
}

/**
 * Пульс воркера с российским IP.
 *
 * `exit_ip` и `exit_country` — единственное честное доказательство для
 * партнёра, что документация качается из России: ЕИС не пускает зарубежные
 * адреса, и если выход сменится, задания начнут падать. Лучше показать адрес,
 * чем объяснять причину постфактум.
 */
export interface WorkerHeartbeatRow {
  worker_id: string;
  last_seen_at: string;
  last_full_sync_at: string | null;
  exit_ip: string | null;
  exit_country: string | null;
  host: string | null;
  version: string | null;
  last_job_id: string | null;
  last_error: string | null;
  created_at: string;
}

/** Что панель знает о воркере: пульс и последнее задание. */
export interface WorkerStatus {
  /** null — воркер ни разу не выходил на связь (таблица пуста). */
  heartbeat: WorkerHeartbeatRow | null;
  lastJob: SyncJobRow | null;
  /** Сколько заданий ждёт в очереди. */
  pending: number;
}
