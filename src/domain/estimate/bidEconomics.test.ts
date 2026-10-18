import { describe, expect, it } from "vitest";

import type { TaxSystem } from "@/domain/entities";
import {
  computeBidEconomics,
  PRICE_GRID_PERCENT,
  type BidEconomicsInput,
} from "@/domain/estimate/bidEconomics";
import type { EstimateDocument } from "@/domain/estimate/types";

/**
 * Деньги по индексной смете.
 *
 * Числа подобраны так, чтобы проверяться в уме. Смета: прямые затраты 3 000 000,
 * накладные 600 000, сметная прибыль 400 000 — итого 4 000 000 без НДС. Из них
 * материалы 1 500 000. Себестоимость при полном расходовании накладных —
 * 3 600 000.
 */

function estimate(
  overrides: Partial<EstimateDocument["totals"]> = {},
  materialCost = 1_500_000,
): EstimateDocument {
  const totals = {
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
    ...overrides,
  };
  return {
    title: "Тест",
    region: "Республика Бурятия",
    priceZone: "Республика Бурятия (1 зона)",
    period: "3 квартал 2026 г.",
    method: "RESOURCE_INDEX",
    baseEdition: "ФСНБ-2022",
    parameters: { vatPercent: 20 },
    wageScale: {},
    sections: [{ title: "Раздел", lines: [{ materialCost }], directCost: 0, overheadCost: 0, profitCost: 0, workCost: 0 }],
    totals,
    gaps: [],
    sources: [],
    generatedAt: "2026-10-06T00:00:00.000Z",
    disclaimer: "",
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

describe("computeBidEconomics: основа расчёта", () => {
  it("себестоимость — прямые затраты, накладные и лимитированные; сметная прибыль не входит", () => {
    const result = computeBidEconomics(
      input({ document: estimate({ winterSurcharge: 50_000, temporaryStructures: 30_000, beforeVat: 4_080_000 }) }),
    );

    expect(result.basis.cost).toBe(3_680_000);
    expect(result.basis.estimatedProfit).toBe(400_000);
    expect(result.basis.limitedCosts).toBe(80_000);
  });

  it("не вся доля накладных тратится — себестоимость ниже", () => {
    const result = computeBidEconomics(input({ overheadRealization: 0.5 }));
    expect(result.basis.cost).toBe(3_300_000);
    expect(result.assumptions.overheadRealization).toBe(0.5);
  });

  it("пустая смета не даёт цен и честно говорит об этом", () => {
    const result = computeBidEconomics(
      input({ document: estimate({ directCost: 0, overheadCost: 0, profitCost: 0, workCost: 0, beforeVat: 0, vat: 0, total: 0 }) }),
    );

    expect(result.status).toBe("EMPTY");
    expect(result.breakEvenPrice).toBeNull();
    expect(result.minAcceptablePrice).toBeNull();
    expect(result.flags[0]?.code).toBe("NO_ESTIMATE");
    expect(result.confidence.score).toBe(0);
  });
});

describe("computeBidEconomics: плательщик НДС (ОСНО)", () => {
  const result = computeBidEconomics(input());

  it("выручка — цена без НДС, налог на прибыль 20 %", () => {
    const atNmc = result.priceTable[0]!;
    expect(atNmc.price).toBe(5_400_000);
    expect(atNmc.revenue).toBe(4_500_000);
    expect(atNmc.cost).toBe(3_600_000);
    expect(atNmc.tax).toBe(180_000);
    expect(atNmc.profit).toBe(720_000);
    expect(atNmc.marginPercent).toBe(16);
  });

  it("безубыточная цена: выручка равна затратам, с НДС это 4 320 000", () => {
    expect(result.breakEvenPrice).toBeCloseTo(4_320_000, 0);
  });

  it("минимально допустимая цена даёт ровно минимальную маржу", () => {
    // 0,8 · (R − 3 600 000) = 0,1 · R  →  R = 4 114 285,71  →  цена с НДС 4 937 142,86
    expect(result.minAcceptablePrice).toBeCloseTo(4_937_142.86, 0);
  });

  it("допустимое снижение считается от НМЦК", () => {
    expect(result.maxReductionPercent).toBeCloseTo(8.57, 1);
  });

  it("на минимальной цене маржа не ниже заданной", () => {
    const again = computeBidEconomics(input({ nmc: result.minAcceptablePrice }));
    expect(again.priceTable[0]!.marginPercent).toBeGreaterThanOrEqual(9.99);
  });
});

describe("computeBidEconomics: упрощённая система", () => {
  it("УСН «доходы»: выручка — вся цена, налог 6 %, НДС поставщиков не вернуть", () => {
    const result = computeBidEconomics(input({}, "USN_INCOME"));
    const atNmc = result.priceTable[0]!;

    // Затраты: 3 600 000 + НДС 20 % на материалы 1 500 000 = 3 900 000.
    expect(result.basis.nonDeductibleVat).toBe(300_000);
    expect(atNmc.revenue).toBe(5_400_000);
    expect(atNmc.cost).toBe(3_900_000);
    expect(atNmc.tax).toBe(324_000);
    expect(atNmc.profit).toBe(1_176_000);
    // P · 0,94 = 3 900 000
    expect(result.breakEvenPrice).toBeCloseTo(4_148_936.17, 0);
  });

  it("УСН «доходы минус расходы»: 15 % с прибыли, не меньше 1 % с выручки", () => {
    const result = computeBidEconomics(input({}, "USN_INCOME_EXPENSES"));
    expect(result.priceTable[0]!.tax).toBe(225_000);
    expect(result.priceTable[0]!.profit).toBe(1_275_000);

    // Цена на уровне затрат: прибыли нет, но минимальный налог 1 % платится.
    const loss = computeBidEconomics(input({ nmc: 3_900_000 }, "USN_INCOME_EXPENSES"));
    expect(loss.priceTable[0]!.tax).toBe(39_000);
  });

  it("патент считается как УСН «доходы» и об этом сказано", () => {
    const result = computeBidEconomics(input({}, "PATENT"));
    expect(result.taxKind).toBe("PATENT_AS_USN_INCOME");
    expect(result.flags.map((f) => f.code)).toContain("TAX_REGIME_APPROXIMATE");
  });
});

describe("computeBidEconomics: сравнение с НМЦК", () => {
  it("выше расчёта больше чем на 5 %", () => {
    const result = computeBidEconomics(input({ nmc: 5_400_000 }));
    expect(result.band).toBe("ABOVE_ESTIMATE");
    expect(result.ratioToEstimate).toBe(1.13);
  });

  it("рядом с расчётом", () => {
    const result = computeBidEconomics(input({ nmc: 4_800_000 }));
    expect(result.band).toBe("NEAR_ESTIMATE");
    expect(result.ratioToEstimate).toBe(1);
  });

  it("ниже расчёта, но выше себестоимости", () => {
    const result = computeBidEconomics(input({ nmc: 4_380_000 }));
    expect(result.band).toBe("BELOW_ESTIMATE");
    expect(result.flags.map((f) => f.code)).toContain("NMC_BELOW_ESTIMATE");
  });

  it("НМЦК ниже себестоимости: критическая пометка и снижать нельзя вовсе", () => {
    const result = computeBidEconomics(input({ nmc: 3_600_000 }));

    expect(result.band).toBe("BELOW_COST");
    expect(result.flags.find((f) => f.code === "NMC_BELOW_COST")?.severity).toBe("CRITICAL");
    expect(result.maxReductionPercent).toBe(0);
  });

  it("неполный расчёт не позволяет сказать «выше» или «рядом»", () => {
    const result = computeBidEconomics(input({ nmc: 5_400_000, droppedPositions: 2 }));

    expect(result.band).toBe("INCOMPLETE");
    expect(result.coverage.isLowerBound).toBe(true);
    expect(result.flags.map((f) => f.code)).toContain("INCOMPLETE_ESTIMATE");
  });

  it("неполный расчёт, который уже выше цены заказчика, всё равно говорит «ниже себестоимости»", () => {
    const result = computeBidEconomics(input({ nmc: 3_600_000, droppedPositions: 2 }));
    expect(result.band).toBe("BELOW_COST");
  });

  it("большая доля непосчитанного — высокая серьёзность", () => {
    const high = computeBidEconomics(input({ droppedPositions: 3 }));
    const low = computeBidEconomics(input({ droppedPositions: 1 }));

    expect(high.flags.find((f) => f.code === "INCOMPLETE_ESTIMATE")?.severity).toBe("HIGH");
    expect(low.flags.find((f) => f.code === "INCOMPLETE_ESTIMATE")?.severity).toBe("MEDIUM");
  });

  it("маржа недостижима даже без снижения — отдельная пометка", () => {
    // НМЦК 4 800 000: выручка 4 000 000, маржа 8 % при минимуме 10 %.
    const result = computeBidEconomics(input({ nmc: 4_800_000 }));

    expect(result.flags.map((f) => f.code)).toContain("MARGIN_UNREACHABLE");
    expect(result.maxReductionPercent).toBe(0);
  });
});

describe("computeBidEconomics: цена не объявлена", () => {
  const result = computeBidEconomics(input({ nmc: null }));

  it("границы есть, сравнения и таблицы нет", () => {
    expect(result.band).toBe("NO_NMC");
    expect(result.nmc).toBeNull();
    expect(result.maxReductionPercent).toBeNull();
    expect(result.priceTable).toEqual([]);
    expect(result.stress).toEqual([]);
    expect(result.breakEvenPrice).toBeCloseTo(4_320_000, 0);
    expect(result.minAcceptablePrice).toBeGreaterThan(result.breakEvenPrice!);
  });

  it("ноль — тоже «не объявлена»", () => {
    expect(computeBidEconomics(input({ nmc: 0 })).band).toBe("NO_NMC");
  });
});

describe("computeBidEconomics: таблица цен и проверка на прочность", () => {
  const result = computeBidEconomics(input());

  it("таблица идёт от 100 % до 70 % НМЦК", () => {
    expect(result.priceTable.map((row) => row.percentOfNmc)).toEqual([...PRICE_GRID_PERCENT]);
  });

  it("вердикт строки: выгодно, маржа ниже цели, убыток", () => {
    const at = (percent: number) => result.priceTable.find((row) => row.percentOfNmc === percent)!;

    expect(at(100).verdict).toBe("OK");
    expect(at(95).verdict).toBe("OK");
    expect(at(90).verdict).toBe("BELOW_TARGET_MARGIN");
    expect(at(70).verdict).toBe("LOSS");
  });

  it("перерасход затрат на 20 % съедает прибыль", () => {
    const cell = result.stress.find((c) => c.percentOfNmc === 100 && c.costOverrunPercent === 20)!;

    expect(cell.cost).toBe(4_320_000);
    expect(cell.tax).toBe(36_000);
    expect(cell.profit).toBe(144_000);
  });

  it("проверка на прочность — девять ячеек: три цены на три перерасхода", () => {
    expect(result.stress).toHaveLength(9);
  });
});

describe("computeBidEconomics: надёжность расчёта", () => {
  it("полный расчёт без допущений — сто", () => {
    const result = computeBidEconomics(input());
    expect(result.confidence.score).toBe(100);
    expect(result.confidence.reasons).toEqual(["Все позиции оценены по текущим ценам"]);
  });

  it("непосчитанное, допущения и ресурсы без цены снижают надёжность, и причины названы", () => {
    const result = computeBidEconomics(
      input({ droppedPositions: 2, assumedPercent: 20, unpricedResources: 7 }),
    );

    // −12 (2 из 10 · 60) −6 (20 % · 0,3) −2 (⌈7 / 5⌉)
    expect(result.confidence.score).toBe(80);
    expect(result.confidence.reasons).toHaveLength(3);
  });

  it("надёжность не падает ниже пяти: расчёт пуст только когда он пуст", () => {
    const result = computeBidEconomics(
      input({ droppedPositions: 10, assumedPercent: 100, unpricedResources: 500 }),
    );
    expect(result.confidence.score).toBe(5);
  });

  it("много допущений — отдельная пометка", () => {
    const result = computeBidEconomics(input({ assumedPercent: 45 }));
    expect(result.flags.map((f) => f.code)).toContain("ASSUMPTIONS_HIGH");
  });
});

describe("computeBidEconomics: допущение об НДС", () => {
  it("НМЦК без НДС: выручка плательщика равна цене", () => {
    const result = computeBidEconomics(input({ nmc: 4_500_000, nmcIncludesVat: false }));

    expect(result.priceTable[0]!.revenue).toBe(4_500_000);
    expect(result.nmcBeforeVat).toBe(4_500_000);
    expect(result.flags.find((f) => f.code === "VAT_ASSUMPTION")?.message).toMatch(/без НДС/);
  });
});

describe("computeBidEconomics: запас прочности по затратам", () => {
  it("ОСНО при НМЦК: затраты могут вырасти на 25 % — (4 500 000 − 3 600 000) / 3 600 000", () => {
    const result = computeBidEconomics(input());
    expect(result.safetyMarginPercent).toBeCloseTo(25, 2);
  });

  it("запас в строках таблицы: чем ниже цена, тем он меньше, и 0 там, где уже убыток", () => {
    const result = computeBidEconomics(input());
    const at = (percent: number) => result.priceTable.find((row) => row.percentOfNmc === percent)!;

    // Выручка = цена / 1,2; запас = выручка / 3 600 000 − 1.
    expect(at(100).safetyMarginPercent).toBeCloseTo(25, 2);
    expect(at(95).safetyMarginPercent).toBeCloseTo(18.75, 2);
    expect(at(90).safetyMarginPercent).toBeCloseTo(12.5, 2);
    expect(at(85).safetyMarginPercent).toBeCloseTo(6.25, 2);
    // 80 %: выручка ровно равна затратам — запаса нет.
    expect(at(80).safetyMarginPercent).toBeCloseTo(0, 2);
    expect(at(75).safetyMarginPercent).toBe(0);
    expect(at(70).safetyMarginPercent).toBe(0);
  });

  it("УСН «доходы»: (5 400 000 · 0,94 − 3 900 000) / 3 900 000 = 30,15 %", () => {
    const result = computeBidEconomics(input({}, "USN_INCOME"));
    expect(result.safetyMarginPercent).toBeCloseTo(30.15, 2);
  });

  it("УСН «доходы минус расходы»: граница там, где работает минимальный налог 1 % — 37,08 %", () => {
    // Прибыль нулевая, когда затраты = 99 % выручки: 5 346 000 / 3 900 000 − 1.
    const result = computeBidEconomics(input({}, "USN_INCOME_EXPENSES"));
    expect(result.safetyMarginPercent).toBeCloseTo(37.08, 2);
  });

  it("запас согласован с расчётом: при затратах выше на этот запас прибыль при НМЦК нулевая", () => {
    // Затраты 3 600 000 · 1,25 = 4 500 000 (прямые 3 750 000 + накладные 750 000).
    const grown = computeBidEconomics(
      input({ document: estimate({ directCost: 3_750_000, overheadCost: 750_000 }) }),
    );
    expect(grown.basis.cost).toBe(4_500_000);
    expect(grown.priceTable[0]!.profit).toBe(0);
    expect(grown.safetyMarginPercent).toBe(0);
  });

  it("НМЦК ниже себестоимости — запас 0", () => {
    const result = computeBidEconomics(input({ nmc: 3_600_000 }));
    expect(result.safetyMarginPercent).toBe(0);
  });

  it("НМЦК нет — запаса при НМЦК нет (null)", () => {
    expect(computeBidEconomics(input({ nmc: null })).safetyMarginPercent).toBeNull();
  });

  it("пустая смета — null", () => {
    const result = computeBidEconomics(
      input({ document: estimate({ directCost: 0, overheadCost: 0, profitCost: 0, workCost: 0, beforeVat: 0, vat: 0, total: 0 }) }),
    );
    expect(result.safetyMarginPercent).toBeNull();
  });

  it("огромная цена упирается в верхнюю границу поиска 500 %", () => {
    const result = computeBidEconomics(input({ nmc: 500_000_000 }));
    expect(result.safetyMarginPercent).toBe(500);
  });
});

describe("computeBidEconomics: антидемпинг 44-ФЗ (ст. 37)", () => {
  it("44-ФЗ: строки со снижением от 25 % помечены, остальные нет", () => {
    const result = computeBidEconomics(input({ law: "FZ_44" }));
    const flagged = result.priceTable.filter((row) => row.antiDumping).map((row) => row.percentOfNmc);

    expect(flagged).toEqual([75, 70]);
  });

  it("44-ФЗ: допустимое снижение меньше 25 % — строки помечены, пометки (flag) нет", () => {
    const result = computeBidEconomics(input({ law: "FZ_44" }));

    expect(result.maxReductionPercent).toBeCloseTo(8.57, 1);
    expect(result.priceTable.some((row) => row.antiDumping)).toBe(true);
    expect(result.flags.map((f) => f.code)).not.toContain("ANTI_DUMPING_44");
  });

  it("44-ФЗ: допустимое снижение от 25 % — пометка ANTI_DUMPING_44 уровня MEDIUM со словами про обеспечение", () => {
    // НМЦК 7 200 000: минимальная цена 4 937 143 — снижение 31,4 %.
    const result = computeBidEconomics(input({ law: "FZ_44", nmc: 7_200_000 }));
    expect(result.maxReductionPercent).toBeGreaterThanOrEqual(25);
    const flag = result.flags.find((f) => f.code === "ANTI_DUMPING_44");

    expect(flag?.severity).toBe("MEDIUM");
    expect(flag?.message).toMatch(/ст\. 37/);
    expect(flag?.message).toMatch(/в 1,5 раза/);
    expect(flag?.message).toMatch(/15 млн/);
  });

  it("не 44-ФЗ и закон не указан — ни пометок строк, ни пометки", () => {
    for (const law of ["FZ_223", "PP_RF_615", "COMMERCIAL", undefined] as const) {
      const result = computeBidEconomics(input(law === undefined ? {} : { law }));
      expect(result.priceTable.some((row) => row.antiDumping)).toBe(false);
      expect(result.flags.map((f) => f.code)).not.toContain("ANTI_DUMPING_44");
    }
  });

  it("44-ФЗ без НМЦК: таблицы нет, снижение считать не от чего — пометки нет", () => {
    const result = computeBidEconomics(input({ law: "FZ_44", nmc: null }));
    expect(result.flags.map((f) => f.code)).not.toContain("ANTI_DUMPING_44");
  });
});

describe("computeBidEconomics: пометка об НДС зависит от основания", () => {
  const vatFlag = (overrides: Partial<BidEconomicsInput>) =>
    computeBidEconomics(input(overrides)).flags.find((f) => f.code === "VAT_ASSUMPTION")!;

  it("основание не передано — как раньше: INFO", () => {
    const flag = vatFlag({});
    expect(flag.severity).toBe("INFO");
    expect(flag.message).toMatch(/принята с НДС 20 %/);
  });

  it("DOCUMENT: INFO и цитата из документации", () => {
    const flag = vatFlag({ vatBasis: "DOCUMENT", vatQuote: "НМЦК 5 400 000 руб. с учетом НДС" });
    expect(flag.severity).toBe("INFO");
    expect(flag.message).toContain("«НМЦК 5 400 000 руб. с учетом НДС»");
    expect(flag.message).toMatch(/в документации/);
  });

  it("DOCUMENT без НДС: так и сказано", () => {
    const flag = vatFlag({ nmcIncludesVat: false, vatBasis: "DOCUMENT", vatQuote: "цена без НДС" });
    expect(flag.message).toMatch(/без НДС/);
    expect(flag.message).toContain("«цена без НДС»");
  });

  it("LAW_44: INFO, сказано, что в документации прямо не указано", () => {
    const flag = vatFlag({ vatBasis: "LAW_44" });
    expect(flag.severity).toBe("INFO");
    expect(flag.message).toMatch(/44-ФЗ/);
    expect(flag.message).toMatch(/прямо не указано/);
  });

  it("ASSUMPTION: MEDIUM — НДС не определён", () => {
    const flag = vatFlag({ vatBasis: "ASSUMPTION" });
    expect(flag.severity).toBe("MEDIUM");
    expect(flag.message).toMatch(/не определён/);
  });

  it("конфликт в документах: MEDIUM и просьба проверить вручную", () => {
    const flag = vatFlag({ vatBasis: "LAW_44", vatConflict: true });
    expect(flag.severity).toBe("MEDIUM");
    expect(flag.message).toMatch(/оба варианта/);
  });
});
