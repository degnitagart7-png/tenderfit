import type { NormativeSourceInfo } from "@/domain/estimate/normativeTypes";

/**
 * Типы справочников сводного сметного расчёта (ССР) и прогнозной инфляции.
 *
 * Данные лежат в `data/fsnb/normatives/ssr.json` и `forecast-deflators.json`; их собирает
 * `scripts/fsnb/build-ssr.ts` из сохранённых текстов (421/пр гл. IX, приложения 6 и 9; 841/пр; письмо
 * Минэкономразвития). Каждое число и каждое правило несёт ссылку на пункт и дословный фрагмент
 * источника: `build-ssr.test.ts` проверяет, что фрагмент есть в сохранённом тексте.
 */

/** Ссылка на первоисточник: файл в `data/fsnb/normatives/sources/`, пункт и дословный фрагмент. */
export interface SsrCitation {
  readonly file: string;
  /** «421/пр, п. 179, подп. «а»». */
  readonly ref: string;
  /** Дословный фрагмент текста (без учёта пробелов и переносов); число правила стоит внутри него. */
  readonly fragment: string;
}

/**
 * Что глава ССР значит для цены контракта подрядчика (841/пр, п. 21: НМЦК включает «затраты на работы
 * и услуги, относящиеся к предмету закупки»):
 * - CONTRACT — работы подрядчика, входят в НМЦК;
 * - PARTIAL — часть строк подрядчика, часть заказчика: решает состав затрат главы;
 * - CUSTOMER — затраты заказчика, в цену контракта подряда не входят.
 */
export type SsrScope = "CONTRACT" | "PARTIAL" | "CUSTOMER";

export interface SsrChapterNorm {
  readonly number: number;
  /** Наименование главы по п. 138 421/пр, как в тексте. */
  readonly title: string;
  /** Короткая подпись для таблиц; не нормативная. */
  readonly shortTitle: string;
  readonly scope: SsrScope;
  /** Как понимать `scope`: что именно сказано в тексте. */
  readonly scopeNote: string;
  readonly nameCitation: SsrCitation;
  readonly scopeCitations: readonly SsrCitation[];
}

export type SsrGroupId = "1-7" | "1-8" | "1-9" | "1-12";

export interface SsrGroupTotalNorm {
  readonly id: SsrGroupId;
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

/** Назначение объекта для размера резерва на непредвиденные работы и затраты (421/пр, п. 179). */
export type ObjectPurpose = "NON_PRODUCTION" | "PRODUCTION" | "UNIQUE";

export interface SsrReserveRate {
  readonly id: ObjectPurpose;
  /** Предельный размер резерва, % («в размерах, не превышающих»). */
  readonly percent: number;
  readonly label: string;
  readonly citation: SsrCitation;
}

export interface SsrData {
  readonly source: NormativeSourceInfo;
  /** Остальные сохранённые тексты, на которые опирается справочник. */
  readonly relatedSources: readonly { readonly file: string; readonly title: string }[];
  readonly chapters: readonly SsrChapterNorm[];
  readonly groupTotals: readonly SsrGroupTotalNorm[];
  readonly groupTotalsCitation: SsrCitation;
  readonly reserve: {
    readonly rates: readonly SsrReserveRate[];
    /** «от итогов по главам 1 - 12». */
    readonly baseChapters: { readonly from: number; readonly to: number };
    readonly citations: readonly SsrCitation[];
    /** В п. 179 размер резерва зависит от назначения объекта, а не от вида работ. */
    readonly repairNote: string;
  };
  readonly vat: {
    readonly baseCitation: SsrCitation;
    readonly positionCitation: SsrCitation;
    readonly priceCitation: SsrCitation;
    /** Ставка в 421/пр не названа: «в размере, установленном законодательством». */
    readonly rateNote: string;
  };
  readonly authorSupervision: {
    /** % от итога графы 8 глав 1-9, лимит главы 12 (п. 173). */
    readonly percent: number;
    readonly citation: SsrCitation;
  };
  /** Строки приложения 9 к 421/пр, которые названы затратами заказчика. */
  readonly customerRows: readonly { readonly row: string; readonly title: string; readonly citation: SsrCitation }[];
  readonly contract: {
    /** Что входит в НМЦК и смету контракта по 841/пр. */
    readonly includes: readonly { readonly text: string; readonly citation: SsrCitation }[];
    readonly excludes: readonly { readonly text: string; readonly citation: SsrCitation }[];
    readonly reserveNote: string;
  };
  readonly inflation: {
    /** Показатель Минэкономразвития, по которому берутся индексы (841/пр, п. 8, подп. «б»). */
    readonly indicator: string;
    readonly indicatorCitation: SsrCitation;
    readonly formulaCitations: readonly SsrCitation[];
    readonly notes: readonly string[];
  };
}

export type ForecastStatus = "REPORT" | "ESTIMATE" | "FORECAST";

export interface ForecastDeflatorsData {
  readonly letter: {
    readonly title: string;
    /** ISO-дата письма. */
    readonly date: string;
    readonly number: string;
    /** Дата и номер письма стоят в самом сохранённом тексте. */
    readonly datedInText: boolean;
    readonly approvedByGovernment: string;
    readonly file: string;
    readonly pdfFile: string;
    readonly notes: readonly string[];
  };
  /** Годы таблицы и статус значения: отчёт, оценка, прогноз. */
  readonly years: readonly { readonly year: number; readonly status: ForecastStatus }[];
  /** Индекс-дефляторы, % к предыдущему году (г/г), по показателям. */
  readonly indicators: {
    readonly investments: ForecastIndicator;
    readonly construction: ForecastIndicator;
  };
  /** Показатель, по которому считается индекс прогнозной инфляции. */
  readonly used: "investments";
  readonly usedCitation: SsrCitation;
}

export interface ForecastIndicator {
  readonly title: string;
  /** Значения по годам: «109,3» → 109.3. */
  readonly values: readonly { readonly year: number; readonly percent: number }[];
  readonly citation: SsrCitation;
}
