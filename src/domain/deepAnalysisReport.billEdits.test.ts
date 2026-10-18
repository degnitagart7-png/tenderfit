import { describe, expect, it } from "vitest";

import type { DeepAnalysisSummary } from "@/domain/deepAnalysis";
import { buildDeepAnalysisReport, type DeepAnalysisReportInput } from "@/domain/deepAnalysisReport";
import { computeBidEconomics } from "@/domain/estimate/bidEconomics";
import type { EstimateDocument } from "@/domain/estimate/types";
import { demoTenders } from "@/mocks/tenders";

/*
  Word, раздел «Смета и цена участия»: если ведомость правили, отчёт говорит об этом до чисел и
  называет изменённые позиции — читатель файла не видит экран, где они помечены.
*/

const tender = demoTenders[0]!;

const document = {
  parameters: { vatPercent: 22 },
  sections: [{ lines: [{ materialCost: 1_500_000 }] }],
  totals: {
    directCost: 3_000_000, wageFund: 800_000, overheadCost: 600_000, profitCost: 400_000,
    workCost: 4_000_000, winterSurcharge: 0, temporaryStructures: 0, beforeVat: 4_000_000, vat: 880_000, total: 4_880_000,
  },
} as unknown as EstimateDocument;

function section(billEdits: DeepAnalysisReportInput["billEdits"]): string {
  const bidEconomics = computeBidEconomics({
    document,
    nmc: 5_400_000,
    billItems: 10,
    droppedPositions: 0,
    assumedPercent: 0,
    unpricedResources: 0,
    company: { taxSystem: "OSNO", minMarginPercent: 10 },
  });
  const report = buildDeepAnalysisReport({
    regNumber: tender.regNumber,
    subject: tender.subject,
    summary: { state: "completed", title: "", detail: "", job: null, documents: [], documentsWithText: 0, documentsSkipped: 0, documentsTruncated: 0, chunksAnalyzed: 0, findings: [], findingGroups: [], modelUsed: null, verdictChange: null } as unknown as DeepAnalysisSummary,
    generatedAt: new Date("2026-10-09T12:00:00Z"),
    tender,
    bidEconomics,
    billEdits,
  });
  return JSON.stringify(report.sections.find((item) => item.title === "Смета и цена участия"));
}

describe("отчёт Word: правки ведомости", () => {
  const EDITS = {
    count: 3,
    marks: [
      { title: "Демонтаж наружных стен", notes: ["объём 120 → 150 м2", "норма ГЭСН 46-04-010-01 вместо ГЭСН 06-01-001-01"] },
      { title: "Вывоз мусора", notes: ["добавлена вручную", "своя цена 500 ₽ за т без НДС"] },
    ],
  };

  it("строка «Ведомость отредактирована: N правок» и пометки у изменённых позиций", () => {
    const text = section(EDITS);
    expect(text).toContain("Ведомость отредактирована: 3 правки");
    expect(text).toContain("«Демонтаж наружных стен»: объём 120 → 150 м2; норма ГЭСН 46-04-010-01 вместо ГЭСН 06-01-001-01");
    expect(text).toContain("«Вывоз мусора»: добавлена вручную; своя цена 500 ₽ за т без НДС");
  });

  it("склонение: 1 правка, 5 правок", () => {
    expect(section({ count: 1, marks: [] })).toContain("Ведомость отредактирована: 1 правка");
    expect(section({ count: 5, marks: [] })).toContain("Ведомость отредактирована: 5 правок");
  });

  it("длинный список позиций обрезается счётчиком, а не растягивает отчёт", () => {
    const marks = Array.from({ length: 45 }, (_, index) => ({ title: `Позиция ${String(index)}`, notes: ["удалена из расчёта"] }));
    const text = section({ count: 45, marks });
    expect(text).toContain("Позиция 39");
    expect(text).not.toContain("Позиция 40");
    expect(text).toContain("и ещё изменённых позиций: 5");
  });

  it("правок нет — отчёт как прежде", () => {
    expect(section(null)).not.toContain("Ведомость отредактирована");
    expect(section({ count: 0, marks: [] })).not.toContain("Ведомость отредактирована");
    expect(section(undefined)).not.toContain("Ведомость отредактирована");
  });
});
