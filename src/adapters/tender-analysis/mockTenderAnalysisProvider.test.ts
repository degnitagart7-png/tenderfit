import { describe, expect, it } from "vitest";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import type { Tender } from "@/domain/entities";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { demoTenders } from "@/mocks/tenders";

const HOUR = 3600 * 1000;

/**
 * Одна и та же закупка с разным сроком подачи.
 *
 * Всё остальное (цена, регион, требования) остаётся от демо-закупки, поэтому
 * отличие в вердикте даёт только срок: тест проверяет правило, а не подбор
 * удобной фикстуры.
 */
function withDeadline(hoursFromNow: number): Tender {
  const base = demoTenders[0] as Tender;
  return {
    ...base,
    deadlines: {
      ...base.deadlines,
      submissionEnd: new Date(Date.now() + hoursFromNow * HOUR).toISOString(),
    },
  };
}

describe("analyzeTender — истёкший срок подачи", () => {
  it("просроченная закупка не может быть рекомендована", () => {
    const analysis = analyzeTender(withDeadline(-2), demoCompanyProfile, new Date());
    expect(analysis.verdict).toBe("NOT_RECOMMENDED");
  });

  it("блокер «Срок подачи истёк» критический и стоит первым", () => {
    const analysis = analyzeTender(withDeadline(-2), demoCompanyProfile, new Date());
    expect(analysis.hardBlockers[0]?.reason).toBe("Срок подачи истёк");
    expect(analysis.hardBlockers[0]?.critical).toBe(true);
  });

  it("следующий шаг просроченной закупки — не готовить документы", () => {
    const analysis = analyzeTender(withDeadline(-2), demoCompanyProfile, new Date());
    expect(analysis.nextActions).toEqual([
      "Срок подачи истёк — участвовать уже нельзя.",
    ]);
  });

  it("открытая закупка блокера о сроке не получает", () => {
    const analysis = analyzeTender(withDeadline(24 * 10), demoCompanyProfile, new Date());
    expect(analysis.hardBlockers.some((b) => b.reason === "Срок подачи истёк")).toBe(
      false,
    );
  });

  it("подача закрывается меньше чем через сутки — шаг про срочность, а не отказ", () => {
    const analysis = analyzeTender(withDeadline(5), demoCompanyProfile, new Date());
    expect(analysis.nextActions.some((a) => a.includes("Подача закрывается"))).toBe(true);
    expect(analysis.hardBlockers.some((b) => b.reason === "Срок подачи истёк")).toBe(
      false,
    );
  });
});
