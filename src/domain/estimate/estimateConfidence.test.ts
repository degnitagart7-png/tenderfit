import { describe, expect, it } from "vitest";

import {
  computeEstimateConfidence,
  estimateConfidenceRange,
  isForm421Source,
} from "@/domain/estimate/estimateConfidence";
import type { EstimateDocument, VolumeSource } from "@/domain/estimate/types";

function doc(workCost: number, basis?: "UNKNOWN_REGION" | "MUNICIPALITY"): Pick<EstimateDocument, "totals" | "priceZoneChoice"> {
  return {
    totals: { workCost } as EstimateDocument["totals"],
    ...(basis === undefined ? {} : { priceZoneChoice: { basis, matched: null } }),
  };
}

const FORM_421: VolumeSource = {
  level: "CUSTOMER_ESTIMATE",
  documents: ["ЛСР 02-01.pdf"],
  note: "Объёмы и шифры — из сметы заказчика (форма 421/пр); ведомость объёмов работ использована для сверки",
};
const BILL: VolumeSource = { level: "BILL", documents: ["ВОР.xlsx"], note: "Объёмы взяты из ведомости объёмов работ «ВОР.xlsx»" };
const SPEC: VolumeSource = { level: "SPEC", documents: ["ТЗ.docx"], note: "Ведомости объёмов в документации нет — ..." };
const CONTRACT: VolumeSource = { level: "CONTRACT_ESTIMATE", documents: ["Смета контракта.xlsx"], note: "..." };
// Смета заказчика, которую прочитала модель, а не код: в тексте пояснения нет «форма 421/пр».
const AI_READ: VolumeSource = {
  level: "CUSTOMER_ESTIMATE",
  documents: ["смета скан.pdf"],
  note: "Ведомости объёмов в документации нет — объёмы взяты из сметы заказчика «смета скан.pdf»",
};

describe("computeEstimateConfidence", () => {
  it("форма 421/пр, зона известна — расчёт по смете заказчика", () => {
    const result = computeEstimateConfidence({ document: doc(1_000_000, "MUNICIPALITY"), volumeSource: FORM_421 });

    expect(result.level).toBe("customer");
    expect(result.title).toBe("Расчёт по смете заказчика");
    expect(result.explanation).toBe(
      "Объёмы и нормы взяты из локальной сметы заказчика; цены — на текущий квартал. Обычно расхождение с суммой заказчика — до 5 %.",
    );
    expect(result.range).toBeUndefined();
  });

  it("признак формы 421 берётся из флага источника", () => {
    const source: VolumeSource = { ...AI_READ, form421: true };
    expect(computeEstimateConfidence({ document: doc(500_000), volumeSource: source }).level).toBe("customer");
  });

  it("признак формы 421 берётся из ЛСР, прочитанных кодом, когда они лежат в документах источника", () => {
    const lsrs = [{ documentName: "смета скан.pdf", documents: ["смета скан.pdf"] }];
    expect(computeEstimateConfidence({ document: doc(500_000), volumeSource: AI_READ, customerLsrs: lsrs }).level).toBe("customer");
    expect(computeEstimateConfidence({ document: doc(500_000), volumeSource: AI_READ, customerLsrs: [] }).level).toBe("approximate");
  });

  it("расчёт без записи зоны (до выбора зоны) считается с известной зоной", () => {
    expect(computeEstimateConfidence({ document: doc(1_000_000), volumeSource: FORM_421 }).level).toBe("customer");
  });

  it("форма 421/пр, но регион не определён — примерная оценка с советом выбрать зону", () => {
    const result = computeEstimateConfidence({ document: doc(1_000_000, "UNKNOWN_REGION"), volumeSource: FORM_421 });

    expect(result.level).toBe("approximate");
    expect(result.explanation).toContain("ценовая зона не определена");
  });

  it.each([
    ["ведомость", BILL, "ведомость объёмов работ"],
    ["ТЗ и спецификация", SPEC, "ТЗ и спецификации"],
    ["смета контракта", CONTRACT, "смета контракта"],
    ["смета, прочитанная ИИ", AI_READ, "смета заказчика, прочитанная ИИ"],
  ])("%s — примерная оценка с названием источника", (_name, source, label) => {
    const result = computeEstimateConfidence({ document: doc(1_000_000, "MUNICIPALITY"), volumeSource: source });

    expect(result.level).toBe("approximate");
    expect(result.title).toBe("Примерная оценка");
    expect(result.sourceLabel).toBe(label);
    expect(result.explanation).toContain("Точность обычно ±30 %, бывает хуже");
    expect(result.explanation).toContain("Для цены заявки проверьте позиции и объёмы.");
  });

  it("ведомость: пояснение называет источник", () => {
    const result = computeEstimateConfidence({ document: doc(1_000_000), volumeSource: BILL });
    expect(result.explanation).toContain("Сметы заказчика формы 421/пр в расчёте нет");
    expect(result.explanation).toContain("«ведомость объёмов работ»");
  });

  it("источник не записан — всё равно примерная оценка", () => {
    const result = computeEstimateConfidence({ document: doc(1_000_000), volumeSource: null });
    expect(result.level).toBe("approximate");
    expect(result.sourceLabel).toBeNull();
  });

  it("диапазон примерной оценки: от 0,7 до 1,3 суммы", () => {
    const result = computeEstimateConfidence({ document: doc(10_000_000), volumeSource: BILL });

    expect(result.range?.low).toBeCloseTo(7_000_000);
    expect(result.range?.high).toBeCloseTo(13_000_000);
    expect(result.range?.text).toBe("≈ 10 млн ₽ (от 7 млн ₽ до 13 млн ₽)");
  });

  it("нет суммы — неизвестно", () => {
    expect(computeEstimateConfidence({ document: null, volumeSource: BILL }).level).toBe("unknown");
    expect(computeEstimateConfidence({ document: doc(0), volumeSource: FORM_421 }).level).toBe("unknown");
    expect(computeEstimateConfidence({ document: doc(Number.NaN), volumeSource: BILL }).level).toBe("unknown");
  });
});

describe("isForm421Source", () => {
  it("только у сметы заказчика", () => {
    expect(isForm421Source(BILL)).toBe(false);
    expect(isForm421Source({ ...BILL, form421: true })).toBe(false);
    expect(isForm421Source(FORM_421)).toBe(true);
    expect(isForm421Source(null)).toBe(false);
  });
});

describe("estimateConfidenceRange", () => {
  it("не меняет сумму расчёта, только считает границы", () => {
    const range = estimateConfidenceRange(1_000_000);
    expect(range.low).toBeCloseTo(700_000);
    expect(range.high).toBeCloseTo(1_300_000);
  });
});
