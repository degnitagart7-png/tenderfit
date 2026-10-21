import { describe, expect, it } from "vitest";

import type { TaxSystem } from "@/domain/entities";
import {
  bidHeadline,
  buildPriceLadder,
  computeBidEconomics,
  costBaseOfDocument,
  evaluateMyPrice,
  type BidCostBase,
  type BidEconomicsInput,
} from "@/domain/estimate/bidEconomics";
import { DEFAULT_COST_PROFILE } from "@/domain/estimate/companyCostProfile";
import type { EstimateDocument } from "@/domain/estimate/types";

/**
 * Профиль затрат компании и «Моя цена».
 *
 * Смета (числа считаются в уме): труд 600 000, машины 400 000, материалы 1 500 000, ещё 500 000 «прочих» (позиции по ценам
 * заказчика — группами не разложены): прямые затраты 3 000 000; накладные 600 000, сметная прибыль 400 000, итог 4 000 000 без НДС,
 * НДС 20 %. НМЦК 5 400 000 с НДС.
 */

function estimate(): EstimateDocument {
  return {
    title: "Тест",
    parameters: { vatPercent: 20 },
    sections: [{ title: "Раздел", lines: [{ labourCost: 600_000, machineCost: 400_000, materialCost: 1_500_000 }] }],
    totals: {
      directCost: 3_000_000,
      wageFund: 800_000,
      overheadCost: 600_000,
      profitCost: 400_000,
      workCost: 4_000_000,
      winterSurcharge: 0,
      temporaryStructures: 0,
      beforeVat: 4_000_000,
      vat: 800_000,
      total: 4_800_000,
    },
  } as unknown as EstimateDocument;
}

function input(overrides: Partial<BidEconomicsInput> = {}, taxSystem: TaxSystem = "OSNO"): BidEconomicsInput {
  return {
    document: estimate(),
    nmc: 5_400_000,
    billItems: 10,
    droppedPositions: 0,
    assumedPercent: 0,
    unpricedResources: 0,
    company: { taxSystem, minMarginPercent: 10 },
    ...overrides,
  };
}

describe("профиль затрат: поправки к группам сметы", () => {
  it("нет профиля и нейтральный профиль — себестоимость сметная, как раньше", () => {
    const plain = computeBidEconomics(input());
    const neutral = computeBidEconomics(input({ costProfile: DEFAULT_COST_PROFILE }));
    expect(plain.basis.cost).toBe(3_600_000);
    expect(neutral.basis.cost).toBe(3_600_000);
    expect(neutral.assumptions.costProfileApplied).toBe(false);
    expect(neutral.breakEvenPrice).toBe(plain.breakEvenPrice);
    expect(plain.basis.costByEstimate).toBe(plain.basis.cost);
  });

  it("группы берутся из строк сметы, остаток прямых затрат — «прочие»", () => {
    const base = costBaseOfDocument(estimate());
    expect(base).toMatchObject({ labour: 600_000, machines: 400_000, materials: 1_500_000, other: 500_000, overhead: 600_000, profit: 400_000, beforeVat: 4_000_000, vatPercent: 20, origin: "ESTIMATE" });
  });

  it("труд 80 %, машины 90 %, скидка на материалы 10 %, накладные 50 %: каждая поправка на своей группе", () => {
    const result = computeBidEconomics(
      input({
        costProfile: { ...DEFAULT_COST_PROFILE, labourFactorPercent: 80, machinesFactorPercent: 90, materialDiscountPercent: 10, overheadRealizationPercent: 50 },
      }),
    );
    // 480 000 + 360 000 + 1 350 000 + 500 000 (прочие без поправок) + 300 000 (накладные)
    expect(result.basis.cost).toBe(2_990_000);
    expect(result.basis.costStructure).toMatchObject({ labour: 480_000, machines: 360_000, materials: 1_350_000, other: 500_000, overhead: 300_000, subcontract: 0 });
    expect(result.basis.costByEstimate).toBe(3_600_000);
    expect(result.assumptions.costProfileApplied).toBe(true);
    expect(result.flags.some((flag) => flag.code === "COST_PROFILE_APPLIED")).toBe(true);
  });

  it("части структуры складываются в себестоимость", () => {
    const result = computeBidEconomics(
      input({ costProfile: { ...DEFAULT_COST_PROFILE, labourFactorPercent: 70, subcontractSharePercent: 20, subcontractPricePercent: 150, materialDiscountPercent: 5 } }, "USN_INCOME"),
    );
    const parts = Object.values(result.basis.costStructure).reduce((sum, value) => sum + value, 0);
    expect(parts).toBeCloseTo(result.basis.cost, 1);
  });

  it("субподряд: доля прямых затрат по цене субподрядчика, остальное — своё", () => {
    const result = computeBidEconomics(
      input({ costProfile: { ...DEFAULT_COST_PROFILE, subcontractSharePercent: 20, subcontractPricePercent: 150 } }),
    );
    // прямые по группам 2 500 000: своих 80 % = 2 000 000, субподряд 20 % × 150 % = 750 000; плюс прочие 500 000 и накладные 600 000
    expect(result.basis.costStructure.subcontract).toBe(750_000);
    expect(result.basis.cost).toBe(3_850_000);
  });

  it("не плательщик НДС: невозвратный НДС считается с материалов после скидки", () => {
    const result = computeBidEconomics(input({ costProfile: { ...DEFAULT_COST_PROFILE, materialDiscountPercent: 10 } }, "USN_INCOME"));
    // материалы 1 350 000 × 20 % = 270 000
    expect(result.basis.costStructure.nonDeductibleVat).toBe(270_000);
    expect(result.basis.cost).toBe(3_000_000 - 150_000 + 600_000 + 270_000);
  });

  it("явная доля накладных (overheadRealization) сильнее профиля", () => {
    const result = computeBidEconomics(input({ overheadRealization: 0.5, costProfile: { ...DEFAULT_COST_PROFILE, overheadRealizationPercent: 100 } }));
    expect(result.basis.cost).toBe(3_300_000);
  });

  it("поправки двигают границы цены: скидка на материалы снижает безубыточную цену и увеличивает допустимое снижение", () => {
    const before = computeBidEconomics(input());
    const after = computeBidEconomics(input({ costProfile: { ...DEFAULT_COST_PROFILE, materialDiscountPercent: 20 } }));
    expect(after.breakEvenPrice!).toBeLessThan(before.breakEvenPrice!);
    expect(after.maxReductionPercent!).toBeGreaterThan(before.maxReductionPercent!);
  });

  it("смета без разбивки по группам (строки без полей) не падает: всё прямое — «прочие»", () => {
    const bare = { ...estimate(), sections: [{ title: "Р", lines: [{}] }] } as unknown as EstimateDocument;
    const result = computeBidEconomics(input({ document: bare, costProfile: { ...DEFAULT_COST_PROFILE, labourFactorPercent: 50 } }));
    expect(result.status).toBe("COMPUTED");
    expect(result.basis.cost).toBe(3_600_000);
  });

  it("ни документа, ни основы — пустой расчёт без падения", () => {
    const result = computeBidEconomics(input({ document: undefined }));
    expect(result.status).toBe("EMPTY");
    expect(evaluateMyPrice(result, { price: 1_000_000 })).toBeNull();
  });
});

describe("evaluateMyPrice: деньги при названной цене", () => {
  const economics = computeBidEconomics(input());

  it("снижение 5 %: цена 5 130 000, выручка без НДС 4 275 000, налог 20 % с прибыли, маржа выше цели — выгодно", () => {
    const result = evaluateMyPrice(economics, { reductionPercent: 5 })!;
    expect(result.price).toBe(5_130_000);
    expect(result.revenue).toBe(4_275_000);
    expect(result.cost).toBe(3_600_000);
    expect(result.tax).toBe(135_000);
    expect(result.profit).toBe(540_000);
    expect(result.marginPercent).toBeCloseTo(12.63, 2);
    expect(result.verdict).toBe("OK");
    expect(result.reductionPercent).toBe(5);
    expect(result.percentOfNmc).toBe(95);
  });

  it("снижение 10 %: прибыль есть, но маржа 8,89 % ниже цели 10 %", () => {
    const result = evaluateMyPrice(economics, { reductionPercent: 10 })!;
    expect(result.profit).toBe(360_000);
    expect(result.marginPercent).toBeCloseTo(8.89, 2);
    expect(result.verdict).toBe("BELOW_TARGET_MARGIN");
  });

  it("снижение 25 %: выручка ниже затрат — убыток, налога нет", () => {
    const result = evaluateMyPrice(economics, { reductionPercent: 25 })!;
    expect(result.profit).toBe(-225_000);
    expect(result.tax).toBe(0);
    expect(result.verdict).toBe("LOSS");
    expect(result.safetyMarginPercent).toBe(0);
  });

  it("цена в рублях и тот же процент снижения дают одно и то же", () => {
    const byPrice = evaluateMyPrice(economics, { price: 4_860_000 })!;
    const byPercent = evaluateMyPrice(economics, { reductionPercent: 10 })!;
    expect(byPrice).toEqual(byPercent);
  });

  it("цена из рублей важнее процента, если названы обе", () => {
    const result = evaluateMyPrice(economics, { price: 5_130_000, reductionPercent: 50 })!;
    expect(result.reductionPercent).toBe(5);
  });

  it("цена выше НМЦК — помечена, снижение отрицательное", () => {
    const result = evaluateMyPrice(economics, { price: 5_500_000 })!;
    expect(result.aboveNmc).toBe(true);
    expect(result.reductionPercent!).toBeLessThan(0);
  });

  it("границы: на минимальной цене маржа равна цели, на безубыточной прибыль ноль", () => {
    const atMin = evaluateMyPrice(economics, { price: economics.minAcceptablePrice })!;
    expect(atMin.marginPercent).toBeGreaterThanOrEqual(10 - 0.01);
    expect(atMin.verdict === "OK" || atMin.verdict === "BELOW_TARGET_MARGIN").toBe(true);
    const atBreakEven = evaluateMyPrice(economics, { price: economics.breakEvenPrice })!;
    expect(Math.abs(atBreakEven.profit)).toBeLessThan(1);
  });

  it("мусор и ноль — null: нечего считать", () => {
    expect(evaluateMyPrice(economics, {})).toBeNull();
    expect(evaluateMyPrice(economics, { price: 0 })).toBeNull();
    expect(evaluateMyPrice(economics, { price: -10 })).toBeNull();
    expect(evaluateMyPrice(economics, { price: Number.NaN })).toBeNull();
    expect(evaluateMyPrice(economics, { reductionPercent: 100 })).toBeNull();
  });

  it("НМЦК не объявлена: цена в рублях считается, проценты — нет", () => {
    const noNmc = computeBidEconomics(input({ nmc: null }));
    expect(evaluateMyPrice(noNmc, { reductionPercent: 10 })).toBeNull();
    const result = evaluateMyPrice(noNmc, { price: 4_800_000 })!;
    expect(result.percentOfNmc).toBeNull();
    expect(result.reductionPercent).toBeNull();
    expect(result.antiDumping).toBeNull();
    expect(result.profit).toBeGreaterThan(0);
  });

  it("УСН «доходы»: налог 6 % с выручки, НДС не вычитается", () => {
    const usn = computeBidEconomics(input({}, "USN_INCOME"));
    const result = evaluateMyPrice(usn, { price: 5_000_000 })!;
    expect(result.revenue).toBe(5_000_000);
    expect(result.tax).toBe(300_000);
  });
});

describe("evaluateMyPrice: антидемпинг по закону закупки", () => {
  it("44-ФЗ: снижение 24 % — меры нет, 25 % — есть, обеспечение ×1,5", () => {
    const economics = computeBidEconomics(input({ law: "FZ_44" }));
    expect(evaluateMyPrice(economics, { reductionPercent: 24 })!.antiDumping).toBeNull();
    const note = evaluateMyPrice(economics, { reductionPercent: 25 })!.antiDumping!;
    expect(note.conditional).toBe(false);
    expect(note.securityMultiplier).toBe(1.5);
  });

  it("закон не известен: правило есть, но условное", () => {
    const economics = computeBidEconomics(input());
    const note = evaluateMyPrice(economics, { reductionPercent: 30 })!.antiDumping!;
    expect(note.conditional).toBe(true);
  });

  it("223-ФЗ: меры нет и при снижении 40 %", () => {
    const economics = computeBidEconomics(input({ law: "FZ_223" }));
    expect(evaluateMyPrice(economics, { reductionPercent: 40 })!.antiDumping).toBeNull();
  });

  it("НМЦК до 15 млн и выше 15 млн: разные правила в тексте", () => {
    const small = computeBidEconomics(input({ law: "FZ_44", nmc: 14_000_000 }));
    expect(evaluateMyPrice(small, { reductionPercent: 30 })!.antiDumping!.goodFaithAlternative).toBe(true);
    const big = computeBidEconomics(input({ law: "FZ_44", nmc: 16_000_000 }));
    expect(evaluateMyPrice(big, { reductionPercent: 30 })!.antiDumping!.goodFaithAlternative).toBe(false);
  });

  it("порог совпадает с пометкой таблицы цен: строка 75 % — антидемпинг только при 44-ФЗ", () => {
    const fz44 = computeBidEconomics(input({ law: "FZ_44" }));
    expect(fz44.priceTable.find((row) => row.percentOfNmc === 75)!.antiDumping).toBe(true);
    expect(fz44.priceTable.find((row) => row.percentOfNmc === 80)!.antiDumping).toBe(false);
  });
});

describe("лестница цен и заголовок", () => {
  const economics = computeBidEconomics(input({ law: "FZ_44" }));

  it("лестница: НМЦК и −5…−30 % с шагом 5, первая строка совпадает с таблицей цен", () => {
    const ladder = buildPriceLadder(economics);
    expect(ladder.map((row) => row.reductionPercent)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(ladder[0]!.result.price).toBe(economics.priceTable[0]!.price);
    expect(ladder[0]!.result.profit).toBe(economics.priceTable[0]!.profit);
    expect(ladder[5]!.result.antiDumping).not.toBeNull();
    expect(ladder[4]!.result.antiDumping).toBeNull();
  });

  it("без НМЦК лестницы нет", () => {
    expect(buildPriceLadder(computeBidEconomics(input({ nmc: null })))).toEqual([]);
  });

  it("заголовок: безубыточная цена · минимальная цена с маржой · допустимое снижение", () => {
    const headline = bidHeadline(economics)!;
    expect(headline.breakEven).toMatch(/^Безубыточная цена 4\s320\s000\s₽$/);
    expect(headline.minPrice).toMatch(/^Минимальная цена с маржой 10 % — 4\s937\s143\s₽$/);
    expect(headline.reduction).toBe("Можно снижать до 8,6 % от НМЦК");
    expect(headline.text.split(" · ")).toHaveLength(3);
  });

  it("НМЦК ниже минимальной цены: «снижать нельзя»; нет НМЦК — без третьей части", () => {
    expect(bidHeadline(computeBidEconomics(input({ nmc: 4_500_000 })))!.reduction).toBe("Снижать от НМЦК нельзя");
    expect(bidHeadline(computeBidEconomics(input({ nmc: null })))!.reduction).toBeNull();
  });

  it("пустой расчёт — заголовка нет", () => {
    expect(bidHeadline(computeBidEconomics(input({ document: undefined })))).toBeNull();
  });
});

describe("основа из пересчёта сметы заказчика", () => {
  const audit: BidCostBase = {
    labour: 600_000,
    machines: 400_000,
    materials: 1_500_000,
    other: 500_000,
    overhead: 600_000,
    profit: 400_000,
    limited: 0,
    beforeVat: 4_000_000,
    vatPercent: 20,
    origin: "AUDIT",
  };

  it("те же деньги, что у сметы с теми же группами; пометка об основе; НМЦК — итог сметы заказчика", () => {
    const fromDocument = computeBidEconomics(input());
    const fromAudit = computeBidEconomics(input({ document: undefined, costBase: audit }));
    expect(fromAudit.basis.cost).toBe(fromDocument.basis.cost);
    expect(fromAudit.baseOrigin).toBe("AUDIT");
    expect(fromAudit.flags.some((flag) => flag.code === "BASE_CUSTOMER_AUDIT")).toBe(true);
  });

  it("без разбивки: вся сумма — себестоимость, поправки профиля не применяются, пометка и штраф к надёжности", () => {
    const lump: BidCostBase = { ...audit, labour: 0, machines: 0, materials: 0, other: 4_000_000, overhead: 0, profit: 0, origin: "AUDIT_LUMP" };
    const result = computeBidEconomics(
      input({ document: undefined, costBase: lump, costProfile: { ...DEFAULT_COST_PROFILE, labourFactorPercent: 50, materialDiscountPercent: 20 } }),
    );
    expect(result.basis.cost).toBe(4_000_000);
    expect(result.flags.some((flag) => flag.code === "COST_BASE_LUMP")).toBe(true);
    expect(result.confidence.reasons.some((reason) => reason.includes("Нет разбивки"))).toBe(true);
    expect(result.flags.some((flag) => flag.code === "COST_PROFILE_APPLIED")).toBe(false);
  });

  it("доля непереоценённого: от 30 % — пометка, надёжность падает", () => {
    const clean = computeBidEconomics(input({ document: undefined, costBase: audit, unverifiedPercent: 0 }));
    const partial = computeBidEconomics(input({ document: undefined, costBase: audit, unverifiedPercent: 50 }));
    expect(partial.flags.some((flag) => flag.code === "UNVERIFIED_SHARE")).toBe(true);
    expect(clean.flags.some((flag) => flag.code === "UNVERIFIED_SHARE")).toBe(false);
    expect(partial.confidence.score).toBeLessThan(clean.confidence.score);
  });
});
