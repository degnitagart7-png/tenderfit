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
}

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
   * Читать ли карточку Контур.Закупок, когда ЕИС документацию не отдала.
   *
   * Каждый такой запрос платный (группа `purchase` тарифа), поэтому флаг
   * появляется только в задании, которое партнёр поставил явно на одну закупку,
   * и никогда — в плановом прогоне. Отсутствие флага читается как false:
   * задания, поставленные до его появления, бесплатны.
   */
  konturCards?: boolean;
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
}

/** Что воркер посчитал по заданию `estimate`. */
export interface EstimateJobResult {
  /** Готовый сметный документ (`EstimateDocument`), как его собрал расчёт. */
  document: unknown;
  /** Строки ведомости, не подтверждённые документацией, с причинами. */
  rejected: unknown[];
  /** Документы, в которых ведомости не нашлось вовсе. */
  documentsWithoutBill: string[];
  /** Сколько позиций вошло в ведомость. */
  billItems: number;
  /** Потрачено токенов модели на извлечение ведомости. */
  tokensUsed: number;
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
