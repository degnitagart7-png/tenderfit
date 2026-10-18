import type { BimBase, BimElement } from "@/domain/estimate/bimIndicesTypes";

/**
 * Сведения аудита БИМ-сметы, которых нет у аудита ресурсной сметы: чем проверены базисные цены и индексы и что
 * проверить не удалось. Лежат в отчёте `AuditReport.bim`, чтобы карточка и отчёт Word показали их теми же словами.
 */

export interface BimQuarterRef {
  readonly quarter: number;
  readonly year: number;
}

/** Индексы по элементам затрат: у заказчика или в письме. */
export interface BimIndexTriple {
  readonly labour: number | null;
  readonly machines: number | null;
  readonly materials: number | null;
}

export type BimIndexStatus =
  /** Индексы заказчика сверены с письмом. */
  | "CHECKED"
  /** Не сверены: справка без вывода; причина — в `indexNote`. */
  | "NOT_CHECKED"
  /** В смете индексов нет: она в базисных ценах 2001 года. */
  | "NOT_APPLIED";

/** Строка сверки базисной цены расценки. */
export interface BimBaseCheckRow {
  readonly number: string;
  readonly code: string;
  /** Базисная цена за единицу у заказчика, ₽ (с поправочными коэффициентами, как напечатана). */
  readonly customerPrice: number | null;
  /** Цена по ФЕР-2020 с теми же коэффициентами, ₽; null — расценки в базе нет. */
  readonly ferPrice: number | null;
  readonly status: "MATCH" | "MISMATCH" | "NOT_FOUND" | "TER_NO_BASE" | "OTHER_BASE" | "UNIT_MISMATCH" | "COEFFICIENTS_UNPARSED";
}

export interface BimAuditDetails {
  /** Субъект, по которому искались индексы, и откуда он взят. */
  readonly subject: string | null;
  readonly zone: number | null;
  readonly subjectSource: "ESTIMATE" | "ZONE" | null;
  /** Объект строительства по наименованию стройки; null — не определён. */
  readonly object: string | null;
  readonly objectReason: string | null;
  readonly objectCandidates: readonly string[];
  /** Квартал цен сметы и откуда он известен. */
  readonly customerQuarter: BimQuarterRef | null;
  readonly quarterSource: "ESTIMATE" | "TEXT" | null;
  /** Базисные расценки сметы: ФЕР или ТЕР (по преобладанию). */
  readonly base: BimBase;
  readonly indexStatus: BimIndexStatus;
  readonly indexNote: string;
  /** Индексы, применённые заказчиком (по преобладающему значению позиций), и индексы письма. */
  readonly customerIndices: BimIndexTriple | null;
  readonly letterIndices: (BimIndexTriple & { readonly letterNumber: string; readonly letterDate: string; readonly object: string }) | null;
  /** Сводка сверки базисных цен: сколько позиций сверено и сколько совпало. */
  readonly baseChecks: {
    readonly compared: number;
    readonly matched: number;
    readonly mismatched: number;
    readonly terNotChecked: number;
    readonly otherNotChecked: number;
    readonly notFound: number;
  };
  readonly rows: readonly BimBaseCheckRow[];
  /** Нормативы НР и СП, по которым составлена смета, и проверялись ли они. */
  readonly overheadNorms: "812_774" | "MDS" | null;
  readonly overheadChecked: boolean;
  readonly overheadNote: string;
  /** Откуда разница, ₽ (входит в группы отчёта, а не прибавляется к ним): базисные цены, индексы, нормативы, арифметика. */
  readonly impactBySource: {
    readonly basePrices: number;
    readonly indices: number;
    readonly norms: number;
    readonly arithmetic: number;
  };
  /** Сколько индексов письма отличается от применённых по элементам. */
  readonly indexDeviations: ReadonlyArray<{
    readonly element: BimElement;
    readonly customer: number;
    readonly letter: number;
    readonly impact: number | null;
  }>;
}
