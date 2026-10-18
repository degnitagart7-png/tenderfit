import { describe, expect, it } from "vitest";

import type { ContractFacts } from "@/domain/analysisConsolidation";
import type { CustomerLsr } from "@/domain/estimate/customerLsr";
import { computeMoneyOutlook, hasMoneyOutlook } from "@/domain/moneyOutlook";

const facts: ContractFacts = {
  work_start: null,
  work_end: "2026-11-20",
  warranty_months: 60,
  bid_security_percent: 1,
  contract_security_percent: 5,
  warranty_security_percent: 5,
  advance_percent: null,
  payment_days: 7,
};

/** Смета с двумя позициями: прямые 800 000, накладные 100 000, сметная прибыль 60 000. */
function estimate(winter: number | null = null): CustomerLsr {
  const position = (overhead: number, profit: number) => ({
    overhead: { ref: null, rawRef: "", basePercent: null, percent: null, amount: overhead },
    profit: { ref: null, rawRef: "", basePercent: null, percent: null, amount: profit },
  });
  return {
    positionsTotal: 1_000_000,
    positions: [position(60_000, 40_000), position(40_000, 20_000)],
    limitedCosts: { winter: winter === null ? null : { percent: winter, quote: "Зимнее удорожание 2,1%" }, temporary: null },
  } as unknown as CustomerLsr;
}

describe("computeMoneyOutlook", () => {
  it("обеспечения считаются от НМЦК; пик — контракт плюс гарантия, а не все три", () => {
    const outlook = computeMoneyOutlook({ price: 10_000_000, facts, terms: null, estimates: [], submissionEnd: null });

    expect(outlook.securities.map((s) => [s.kind, s.amount])).toEqual([
      ["bid", 100_000],
      ["contract", 500_000],
      ["warranty", 500_000],
    ]);
    expect(outlook.securities[2]!.period).toMatch(/60 мес/);
    expect(outlook.frozenPeak).toBe(1_000_000);
    expect(outlook.paymentDays).toBe(7);
  });

  it("сумма из документа важнее процента; «не требуется» — строки нет", () => {
    const outlook = computeMoneyOutlook({
      price: 10_000_000,
      facts: { ...facts, contract_security_percent: null, warranty_security_percent: null },
      terms: {
        bidSecurity: { required: true, percent: null, amount: 98_316, quote: "", strong: true },
        contractSecurity: { required: false, percent: null, amount: null, quote: "", strong: true },
      },
      estimates: [],
      submissionEnd: null,
    });

    expect(outlook.securities.map((s) => [s.kind, s.amount])).toEqual([["bid", 98_316]]);
  });

  it("запас по цене: сметная прибыль 6 %, накладные 10 % — снижение на 5 % в плюсе, на 10 % ест накладные, на 25 % в убыток", () => {
    const outlook = computeMoneyOutlook({ price: 9_831_629, facts, terms: null, estimates: [estimate()], submissionEnd: null });
    const [five, ten, , twentyFive] = outlook.margin!.scenarios;

    expect(outlook.margin!.profit).toBe(60_000);
    expect(five!.profitLeft).toBeCloseTo(0.01);
    expect(five!.note).toMatch(/остаётся сметной прибыли около 1,0 %/);
    expect(ten!.note).toMatch(/съедена/);
    expect(twentyFive!.note).toMatch(/убыток/);
    expect(five!.price).toBeCloseTo(9_831_629 * 0.95);
  });

  it("зима: работы до 20 ноября от подачи в октябре; удорожание не начислено — так и сказано", () => {
    const outlook = computeMoneyOutlook({ price: 1, facts, terms: null, estimates: [estimate()], submissionEnd: "2026-10-20" });
    expect(outlook.winter).toEqual({ months: ["ноябрь"], included: null });

    const included = computeMoneyOutlook({ price: 1, facts, terms: null, estimates: [estimate(2.1)], submissionEnd: "2026-10-20" });
    expect(included.winter?.included?.percent).toBe(2.1);
  });

  it("летние работы и неизвестный срок — блока зимы нет; пустые данные — блока нет вовсе", () => {
    const summer = computeMoneyOutlook({
      price: 1,
      facts: { ...facts, work_start: "2026-05-01", work_end: "2026-08-30" },
      terms: null,
      estimates: [],
      submissionEnd: null,
    });
    expect(summer.winter).toBeNull();

    const empty = computeMoneyOutlook({ price: null, facts: null, terms: null, estimates: [], submissionEnd: null });
    expect(hasMoneyOutlook(empty)).toBe(false);
  });
});
