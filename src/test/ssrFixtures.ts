import type { EstimateDocument } from "@/domain/estimate/types";

/**
 * Смета для тестов сводного расчёта: разделы с заданной стоимостью СМР и лимитированные затраты, посчитанные, как их
 * считает `computeTotals` (временные от СМР, зимнее от СМР с временными). Только поля, которые читает ССР.
 */
export interface SsrEstimateOptions {
  readonly sections?: readonly { readonly title: string; readonly workCost: number }[];
  readonly temporaryPercent?: number;
  readonly winterPercent?: number;
  readonly vatPercent?: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function ssrEstimate(options: SsrEstimateOptions = {}): EstimateDocument {
  const sections = options.sections ?? [{ title: "Фасад", workCost: 1_000_000 }];
  const workCost = round2(sections.reduce((sum, section) => sum + section.workCost, 0));
  const temporaryPercent = options.temporaryPercent ?? 0;
  const winterPercent = options.winterPercent ?? 0;
  const vatPercent = options.vatPercent ?? 22;
  const temporaryStructures = round2((workCost * temporaryPercent) / 100);
  const winterSurcharge = round2(((workCost + temporaryStructures) * winterPercent) / 100);
  const beforeVat = round2(workCost + temporaryStructures + winterSurcharge);
  const vat = round2((beforeVat * vatPercent) / 100);
  return {
    title: "Тест",
    region: "Иркутская область",
    priceZone: "Иркутская область (1 зона)",
    period: "3 квартал 2026 г.",
    method: "RESOURCE_INDEX",
    baseEdition: "ФСНБ-2022",
    parameters: {
      vatPercent,
      indices: null,
      overhead: {},
      limited: { winterSurchargePercent: winterPercent, temporaryStructuresPercent: temporaryPercent, source: "test" },
    },
    wageScale: {},
    sections: sections.map((section) => ({
      title: section.title,
      lines: [{ materialCost: section.workCost * 0.4 }],
      directCost: round2(section.workCost * 0.7),
      overheadCost: round2(section.workCost * 0.2),
      profitCost: round2(section.workCost * 0.1),
      workCost: section.workCost,
    })),
    totals: {
      directCost: round2(workCost * 0.7),
      wageFund: round2(workCost * 0.3),
      overheadCost: round2(workCost * 0.2),
      profitCost: round2(workCost * 0.1),
      workCost,
      winterSurcharge,
      temporaryStructures,
      beforeVat,
      vat,
      total: round2(beforeVat + vat),
    },
    gaps: [],
    sources: [],
    generatedAt: "2026-10-06T00:00:00.000Z",
    disclaimer: "",
  } as unknown as EstimateDocument;
}
