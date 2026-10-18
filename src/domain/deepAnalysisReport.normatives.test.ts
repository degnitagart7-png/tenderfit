import { describe, expect, it } from "vitest";

import type { DeepAnalysisSummary } from "@/domain/deepAnalysis";
import { buildDeepAnalysisReport } from "@/domain/deepAnalysisReport";
import { computeBidEconomics } from "@/domain/estimate/bidEconomics";
import type { AppliedNormative, EstimateDocument } from "@/domain/estimate/types";
import { demoTenders } from "@/mocks/tenders";

/*
  Word, раздел «Смета и цена участия»: нормативы сверх норм — приказ и пункт, причины неначисленного.
*/

const tender = demoTenders[0]!;
const NOW = new Date("2026-10-08T12:00:00Z");

const document = {
  parameters: { vatPercent: 22 },
  sections: [{ lines: [{ materialCost: 1_500_000 }] }],
  totals: {
    directCost: 3_000_000, wageFund: 800_000, overheadCost: 600_000, profitCost: 400_000,
    workCost: 4_000_000, winterSurcharge: 0, temporaryStructures: 0, beforeVat: 4_000_000, vat: 880_000, total: 4_880_000,
  },
} as unknown as EstimateDocument;

const NORMATIVES: AppliedNormative[] = [
  {
    code: "WORK_CONDITION",
    title: "Условие работ: в жилых помещениях без расселения",
    text: "Производство ремонтно-строительных работ осуществляется в жилых помещениях без расселения",
    value: "К = 1,50 к труду; применён к 12 из 14 позиций",
    source: "приложение 10 к 421/пр, таблица 5, п. 8",
    applied: true,
  },
  {
    code: "WINTER",
    title: "Зимнее удорожание",
    text: "НДЗ",
    value: "0 %",
    source: "Приказ Минстроя России от 25.05.2021 N 325/пр",
    applied: false,
    reason: "зимнее удорожание не начислено: не известен период работ",
    missingData: true,
  },
];

function section(normatives: readonly AppliedNormative[] | null) {
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
    generatedAt: NOW,
    tender,
    bidEconomics,
    appliedNormatives: normatives,
  });
  return JSON.stringify(report.sections.find((item) => item.title === "Смета и цена участия"));
}

describe("отчёт Word: нормативы сверх норм", () => {
  it("фраза «Применены коэффициенты условий работ: … (приложение 10 к 421/пр, п. …)», приказ и пункт у каждого", () => {
    const text = section(NORMATIVES);
    expect(text).toContain("Нормативы расчёта сверх норм");
    expect(text).toContain("Применены коэффициенты условий работ: в жилых помещениях без расселения — К 1,50");
    expect(text).toContain("приложение 10 к 421/пр, таблица 5, п. 8");
    expect(text).toContain("Источник: Приказ Минстроя России от 25.05.2021 N 325/пр");
  });

  it("неначисленное из-за неизвестных данных названо с причиной", () => {
    expect(section(NORMATIVES)).toContain("не начислено — зимнее удорожание не начислено: не известен период работ");
  });

  it("без нормативов блока нет — отчёт как прежде", () => {
    expect(section(null)).not.toContain("Нормативы расчёта сверх норм");
    expect(section([])).not.toContain("Нормативы расчёта сверх норм");
  });
});
