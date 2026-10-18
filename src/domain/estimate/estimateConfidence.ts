import type { EstimateDocument, VolumeSource, VolumeSourceLevel } from "@/domain/estimate/types";
import { formatCompactRub } from "@/utils/format";

/**
 * Насколько расчёту можно верить: два честно разных уровня точности.
 *
 * Замер на закупках (`scripts/estimate-benchmark.ts`):
 * - смета заказчика формы 421/пр, которую прочитал код: сумма расчёта сходится с суммой заказчика в пределах 5 %, потому
 *   что объёмы, шифры и нормы взяты из самой сметы, а наши только цены;
 * - всё остальное (ведомость, смета контракта, ТЗ и спецификация, смета, прочитанная моделью, нормы, подобранные ИИ):
 *   отклонение обычно 5–30 %, бывает 45–77 % — когда заказчик даёт свои материалы по проекту или часть работ в документах
 *   не описана.
 *
 * Здесь только подпись для экрана и отчёта: суммы расчёта эта функция не меняет и не пересчитывает.
 */

export type EstimateConfidenceLevel = "customer" | "approximate" | "unknown";

/** Диапазон вокруг суммы расчёта для примерной оценки. */
export interface EstimateConfidenceRange {
  readonly low: number;
  readonly high: number;
  /** «≈ 1,4 млн ₽ (от 980 тыс ₽ до 1,8 млн ₽)» — готовая строка. */
  readonly text: string;
}

export interface EstimateConfidence {
  readonly level: EstimateConfidenceLevel;
  readonly title: string;
  readonly explanation: string;
  /** Откуда взяты объёмы, короткой фразой; null — у уровня «customer» и «unknown», либо источник расчёта не записан. */
  readonly sourceLabel: string | null;
  /** Есть только у «approximate». */
  readonly range?: EstimateConfidenceRange;
}

/** Нижняя и верхняя граница примерной оценки относительно суммы расчёта. */
export const APPROXIMATE_RANGE_LOW = 0.7;
export const APPROXIMATE_RANGE_HIGH = 1.3;

const CUSTOMER_TITLE = "Расчёт по смете заказчика";
const CUSTOMER_EXPLANATION =
  "Объёмы и нормы взяты из локальной сметы заказчика; цены — на текущий квартал. Обычно расхождение с суммой заказчика — до 5 %.";
const APPROXIMATE_TITLE = "Примерная оценка";
const APPROXIMATE_TAIL =
  "Точность обычно ±30 %, бывает хуже — например, если заказчик даёт свои материалы или часть работ не описана. " +
  "Для цены заявки проверьте позиции и объёмы.";

/** Короткое имя источника объёмов для строки «объёмы прочитаны из …». */
const SOURCE_LABEL: Readonly<Record<VolumeSourceLevel, string>> = {
  BILL: "ведомость объёмов работ",
  CUSTOMER_ESTIMATE: "смета заказчика, прочитанная ИИ",
  CONTRACT_ESTIMATE: "смета контракта",
  SPEC: "ТЗ и спецификации",
};

/** Минимум, который функции нужен от локальной сметы заказчика, прочитанной кодом (`LsrSourceInfo`). */
export interface EstimateConfidenceLsr {
  readonly documentName: string;
  readonly documents?: readonly string[];
}

export interface EstimateConfidenceInput {
  /** Расчёт; нет или нулевая сумма — «unknown». */
  readonly document: Pick<EstimateDocument, "totals" | "priceZoneChoice"> | null | undefined;
  /** Откуда взяты объёмы; нет у расчётов, посчитанных до приоритета источников. */
  readonly volumeSource?: VolumeSource | null;
  /**
   * Локальные сметы заказчика, которые прочитал код (форма 421/пр). Совпадение их документов с документами источника
   * объёмов — признак «смету разобрал код, а не модель». Нет — признак берётся из `volumeSource.form421` и пояснения.
   */
  readonly customerLsrs?: readonly EstimateConfidenceLsr[] | null;
}

/** Объёмы расчёта взяты из ЛСР формы 421/пр, разобранной кодом. */
export function isForm421Source(
  source: VolumeSource | null | undefined,
  lsrs?: readonly EstimateConfidenceLsr[] | null,
): boolean {
  if (source == null || source.level !== "CUSTOMER_ESTIMATE") return false;
  if (source.form421 === true) return true;
  if (/форма 421\/пр/u.test(source.note)) return true;
  if (lsrs == null || lsrs.length === 0) return false;
  const used = new Set(source.documents);
  return lsrs.some(
    (lsr) => used.has(lsr.documentName) || (lsr.documents ?? []).some((name) => used.has(name)),
  );
}

/** Ценовая зона известна: расчёт не пришлось вести «по умолчанию» из-за нераспознанного региона. */
function isZoneKnown(document: Pick<EstimateDocument, "priceZoneChoice">): boolean {
  const choice = document.priceZoneChoice;
  // Расчёты до выбора зоны считались в единственной собранной зоне: зона у них была.
  return choice == null || choice.basis !== "UNKNOWN_REGION";
}

export function estimateConfidenceRange(workCost: number): EstimateConfidenceRange {
  const low = workCost * APPROXIMATE_RANGE_LOW;
  const high = workCost * APPROXIMATE_RANGE_HIGH;
  return {
    low,
    high,
    text: `≈ ${formatCompactRub(workCost)} (от ${formatCompactRub(low)} до ${formatCompactRub(high)})`,
  };
}

export function computeEstimateConfidence(input: EstimateConfidenceInput): EstimateConfidence {
  const { document, volumeSource = null } = input;
  const workCost = document?.totals.workCost;
  if (document == null || workCost === undefined || !Number.isFinite(workCost) || workCost <= 0) {
    return {
      level: "unknown",
      title: "Точность не определена",
      explanation: "Итоговой суммы расчёта нет — оценивать точность не с чем.",
      sourceLabel: null,
    };
  }

  const form421 = isForm421Source(volumeSource, input.customerLsrs);
  const zoneKnown = isZoneKnown(document);

  if (form421 && zoneKnown) {
    return {
      level: "customer",
      title: CUSTOMER_TITLE,
      explanation: CUSTOMER_EXPLANATION,
      sourceLabel: null,
    };
  }

  const range = estimateConfidenceRange(workCost);

  if (form421) {
    // Смета заказчика есть, но регион закупки не определён: цены взяты не в той зоне, что у заказчика, точность ниже обычной.
    return {
      level: "approximate",
      title: APPROXIMATE_TITLE,
      explanation:
        "Объёмы и нормы взяты из локальной сметы заказчика, но ценовая зона не определена — цены могут отличаться от зоны заказчика. " +
        "Выберите зону вручную. " +
        APPROXIMATE_TAIL,
      sourceLabel: "локальная смета заказчика (форма 421/пр)",
      range,
    };
  }

  if (volumeSource == null) {
    return {
      level: "approximate",
      title: APPROXIMATE_TITLE,
      explanation:
        "Расчёт посчитан без записи источника объёмов: сметы заказчика формы 421/пр в нём не видно, нормы подобраны автоматически. " +
        APPROXIMATE_TAIL,
      sourceLabel: null,
      range,
    };
  }

  const sourceLabel = SOURCE_LABEL[volumeSource.level];
  const head =
    volumeSource.level === "CUSTOMER_ESTIMATE"
      ? "Смета заказчика прочитана ИИ (скан или нестандартная вёрстка), а не разобрана по форме 421/пр: строки могли потеряться, нормы подобраны автоматически."
      : `Сметы заказчика формы 421/пр в расчёте нет: объёмы прочитаны из источника «${sourceLabel}», нормы подобраны автоматически.`;
  return {
    level: "approximate",
    title: APPROXIMATE_TITLE,
    explanation: `${head} ${APPROXIMATE_TAIL}`,
    sourceLabel,
    range,
  };
}
