/**
 * Бизнес-статусы и перечисления предметной области «ТендерФит».
 * Используются union types, а не enum, чтобы значения были строковыми
 * литералами и удобно сериализовались в localStorage / JSON.
 */

import type { TenderDataSource } from "@/types/database";
import { SOURCES } from "@/domain/sources";

/**
 * Закон, по которому проводится закупка.
 * COMMERCIAL — закупки коммерческих заказчиков на электронных площадках
 * (например, Сбербанк-АСТ, секция «Торги коммерческих заказчиков»),
 * которые проводятся вне рамок 44-ФЗ / 223-ФЗ / ПП РФ 615.
 */
export type TenderLaw = "FZ_44" | "FZ_223" | "PP_RF_615" | "COMMERCIAL";

/**
 * Все законы в порядке показа в интерфейсе.
 *
 * Один массив на домен и UI: переключатель закона, счётчики по законам и
 * подписи в src/lib/labels.ts должны перечислять законы одинаково, иначе
 * добавленный закон появится в одном месте и потеряется в другом.
 */
export const TENDER_LAWS: readonly TenderLaw[] = [
  "FZ_44",
  "FZ_223",
  "PP_RF_615",
  "COMMERCIAL",
] as const;

/** Вердикт системы по закупке. */
export type TenderVerdict =
  | "RECOMMENDED"
  | "MANUAL_REVIEW"
  | "NOT_RECOMMENDED";

/** Все вердикты в порядке показа в интерфейсе. */
export const TENDER_VERDICTS: readonly TenderVerdict[] = [
  "RECOMMENDED",
  "MANUAL_REVIEW",
  "NOT_RECOMMENDED",
] as const;

/** Статус закупки в воронке работы. */
export type PipelineStatus =
  | "NEW"
  | "INTERESTING"
  | "ANALYZING"
  | "PREPARING_APPLICATION"
  | "SUBMITTED"
  | "WON"
  | "LOST"
  | "SKIPPED";

/** Все статусы воронки в порядке колонок доски. */
export const PIPELINE_STATUSES: readonly PipelineStatus[] = [
  "NEW",
  "INTERESTING",
  "ANALYZING",
  "PREPARING_APPLICATION",
  "SUBMITTED",
  "WON",
  "LOST",
  "SKIPPED",
] as const;

/** Источник вывода / доказательства. */
export type EvidenceSource =
  | "TENDER_DOCUMENT"
  | "COMPANY_PROFILE"
  | "AI_CONCLUSION"
  | "SYSTEM_RULE";

/** Уровень уверенности вывода. */
export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

/** Способ определения поставщика (процедура). */
export type PlacingWay =
  | "ELECTRONIC_AUCTION"
  | "OPEN_CONTEST"
  | "REQUEST_FOR_QUOTATION"
  | "REQUEST_FOR_PROPOSALS"
  | "SOLE_SUPPLIER"
  | "OTHER";

/** Категория требования к участнику. */
export type RequirementKind =
  | "LICENSE"
  | "SRO"
  | "EXPERIENCE"
  | "QUALIFIED_PERSONNEL"
  | "EQUIPMENT"
  | "FINANCIAL_STABILITY"
  | "NATIONAL_REGIME"
  | "RESTRICTION"
  | "PRODUCT_CHARACTERISTIC"
  | "OTHER";

/**
 * Вид работ, на который выдан допуск СРО.
 * От вида зависит шкала уровней ответственности (ст. 55.16 ГрК РФ):
 * для строительства она своя, для изысканий и проектирования — своя.
 */
export type SroKind = "CONSTRUCTION" | "DESIGN" | "SURVEY" | "OTHER";

/** Все виды допусков СРО в порядке показа в интерфейсе. */
export const SRO_KINDS: readonly SroKind[] = [
  "CONSTRUCTION",
  "DESIGN",
  "SURVEY",
  "OTHER",
] as const;

/**
 * Подписи видов допуска СРО.
 *
 * Один источник на домен и UI: тексты выводов (src/domain/scoring/admission.ts)
 * и селектор допуска (src/lib/labels.ts → sroKindLabels) берут подписи отсюда,
 * иначе добавленный вид работ появится в одном месте и потеряется в другом.
 */
export const SRO_KIND_LABELS: Record<SroKind, string> = {
  CONSTRUCTION: "Строительство",
  DESIGN: "Проектирование",
  SURVEY: "Инженерные изыскания",
  OTHER: "Иные работы",
};

/**
 * Уровни ответственности члена СРО и предельная стоимость одного договора.
 *
 * Строительство, реконструкция, капитальный ремонт — ч. 12 ст. 55.16 ГрК РФ:
 * 1) до 90 млн ₽, 2) до 500 млн ₽, 3) до 3 млрд ₽, 4) до 10 млрд ₽,
 * 5) 10 млрд ₽ и более (без ограничения сверху).
 * Инженерные изыскания (ч. 10) и архитектурно-строительное проектирование
 * (ч. 11) — четыре уровня: 1) до 25 млн ₽, 2) до 50 млн ₽, 3) до 300 млн ₽,
 * 4) 300 млн ₽ и более.
 *
 * `null` означает «без ограничения»: закупка любой суммы проходит по допуску.
 * Значения используются как справка и значение по умолчанию — фактический лимит
 * хранится в допуске профиля (SroMembership.maxContractAmount), потому что
 * СРО указывает уровень в выписке, а не в законе.
 */
export const SRO_LEVEL_LIMITS: Record<
  Exclude<SroKind, "OTHER">,
  ReadonlyArray<{ level: number; maxContractAmount: number | null }>
> = {
  CONSTRUCTION: [
    { level: 1, maxContractAmount: 90_000_000 },
    { level: 2, maxContractAmount: 500_000_000 },
    { level: 3, maxContractAmount: 3_000_000_000 },
    { level: 4, maxContractAmount: 10_000_000_000 },
    { level: 5, maxContractAmount: null },
  ],
  DESIGN: [
    { level: 1, maxContractAmount: 25_000_000 },
    { level: 2, maxContractAmount: 50_000_000 },
    { level: 3, maxContractAmount: 300_000_000 },
    { level: 4, maxContractAmount: null },
  ],
  SURVEY: [
    { level: 1, maxContractAmount: 25_000_000 },
    { level: 2, maxContractAmount: 50_000_000 },
    { level: 3, maxContractAmount: 300_000_000 },
    { level: 4, maxContractAmount: null },
  ],
};

/**
 * Предельная стоимость договора для уровня ответственности.
 * Для OTHER и неизвестного уровня — null (без ограничения).
 */
export function sroLevelLimit(
  kind: SroKind,
  level: number | null,
): number | null {
  if (level === null || kind === "OTHER") return null;
  const scale = SRO_LEVEL_LIMITS[kind];
  return scale.find((row) => row.level === level)?.maxContractAmount ?? null;
}

/** Реестр специалистов: НРС (НОСТРОЙ/НОПРИЗ) — обязательный допуск для СРО. */
export type SpecialistRegistry = "NRS" | "NOPRIZ";

/** Тип документа закупки. */
export type TenderDocumentType =
  | "NOTICE"
  | "TECHNICAL_SPEC"
  | "DRAFT_CONTRACT"
  | "PROJECT_DOCUMENTATION"
  | "COST_JUSTIFICATION"
  | "OTHER";

/** Severity риска договора. */
export type RiskSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Тип фонового задания. */
export type ProcessingJobType =
  | "TENDER_IMPORT"
  | "DOCUMENT_DOWNLOAD"
  | "TEXT_EXTRACTION"
  | "AI_ANALYSIS"
  | "REANALYSIS"
  | "DIGEST_PREPARATION";

/** Статус фонового задания. */
export type ProcessingJobStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED";

/** Тип уведомления. */
export type NotificationKind =
  | "DAILY_DIGEST"
  | "URGENT"
  | "DOCUMENT_CHANGED"
  | "DEADLINE_APPROACHING";

/**
 * Источник данных, из которого получен тендер.
 *
 * Объявление одно и живёт в `@/types/database` — там же, где описаны строки
 * таблицы `tenders`. До 01.10.2026 здесь была вторая копия того же union, и
 * компилятор не считал их одним типом: значение, добавленное в типы базы, не
 * появлялось в подписях интерфейса, а бейдж источника печатал `undefined`.
 */
export type { TenderDataSource };

/**
 * Все площадки-источники — белый список параметра `src` в адресе ленты.
 * Выводится из каталога `src/domain/sources.ts`, порядок — по авторитетности.
 */
export const TENDER_DATA_SOURCES: readonly TenderDataSource[] = SOURCES.map(
  (s) => s.source,
);

/**
 * Код способа определения поставщика в URL карточки закупки на zakupki.gov.ru.
 * Для 44-ФЗ путь зависит от процедуры: /notice/ea20/, /notice/ok20/, /notice/zk20/ и т.д.
 *
 * Экспортирован, потому что тот же код нужен вкладке документов
 * (src/services/eisAttachments.ts): путь /notice/{код}/view/documents.html.
 */
export const EIS_PROCEDURE_CODE: Record<PlacingWay, string> = {
  ELECTRONIC_AUCTION: "ea20",
  OPEN_CONTEST: "ok20",
  REQUEST_FOR_QUOTATION: "zk20",
  REQUEST_FOR_PROPOSALS: "ok20",
  SOLE_SUPPLIER: "ep44",
  OTHER: "zk20",
};

/**
 * Построить URL карточки закупки на zakupki.gov.ru.
 */
export function buildEisUrl(
  law: TenderLaw,
  regNumber: string,
  placingWay: PlacingWay,
): string {
  const base = "https://zakupki.gov.ru";
  if (law === "FZ_223") {
    return `${base}/223/purchase/public/purchase/info/common-info.html?regNumber=${regNumber}`;
  }
  const code = EIS_PROCEDURE_CODE[placingWay] ?? "zk20";
  return `${base}/epz/order/notice/${code}/view/common-info.html?regNumber=${regNumber}`;
}
