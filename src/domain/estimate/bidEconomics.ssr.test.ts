import { describe, expect, it } from "vitest";

import { computeBidEconomics, type BidEconomicsInput } from "@/domain/estimate/bidEconomics";
import { buildSsr, type SsrResult } from "@/domain/estimate/ssr";
import { ssrEstimate } from "@/test/ssrFixtures";

/*
  Цена участия с учётом сводного расчёта. Смета — 1 000 000 ₽ СМР без начислений (материалы 400 000), НДС 22 %.
  Резерв — 2 % (32 ... → 20 000), инфляция — 1,0047 (октябрь-ноябрь 2026), поэтому наша оценка НМЦК без НДС:
  без сроков 1 020 000, со сроками 1 020 000 × 1,0047 = 1 024 794.
*/

const DOCUMENT = ssrEstimate({ sections: [{ title: "Фасад", workCost: 1_000_000 }] });
const OCT_NOV = { kind: "DATES", start: "2026-10-01", end: "2026-11-30" } as const;

function ssrFor(period: Parameters<typeof buildSsr>[0]["period"] = null): SsrResult {
  return buildSsr({ document: DOCUMENT, purpose: "NON_PRODUCTION", workKind: null, period, priceDate: "2026-10-01", today: "2026-10-09" });
}

function input(over: Partial<BidEconomicsInput> = {}): BidEconomicsInput {
  return {
    document: DOCUMENT,
    nmc: 1_300_000,
    billItems: 10,
    droppedPositions: 0,
    assumedPercent: 0,
    unpricedResources: 0,
    company: { taxSystem: "OSNO", minMarginPercent: 10 },
    nmcIncludesVat: true,
    ...over,
  };
}

describe("регресс: без ССР расчёт прежний", () => {
  it("без поля ssr и с ssr: null результат одинаков, поле ssr пустое", () => {
    const plain = computeBidEconomics(input());
    const withNull = computeBidEconomics(input({ ssr: null }));
    expect(withNull).toEqual(plain);
    expect(plain.ssr).toBeNull();
    expect(plain.basis.comparedWithBeforeVat).toBe(plain.basis.estimateBeforeVat);
    expect(plain.flags.map((flag) => flag.code)).not.toContain("RESERVE_NOT_IN_COST");
  });

  it("пустой ССР (смета пуста) не меняет расчёт", () => {
    const empty = buildSsr({ document: ssrEstimate({ sections: [] }), purpose: null, workKind: null, period: null, priceDate: null, today: "2026-10-09" });
    expect(computeBidEconomics(input({ ssr: empty })).ssr).toBeNull();
  });
});

describe("НМЦК сравнивается с нашей оценкой НМЦК, а не со сметой", () => {
  it("отношение к оценке — к 1 020 000 (смета + резерв 2 %), а не к 1 000 000", () => {
    const result = computeBidEconomics(input({ ssr: ssrFor() }));
    expect(result.basis.estimateBeforeVat).toBe(1_000_000);
    expect(result.basis.comparedWithBeforeVat).toBe(1_020_000);
    // 1 300 000 с НДС 22 % → 1 065 573,77 без НДС
    expect(result.nmcBeforeVat).toBeCloseTo(1_065_573.77, 2);
    expect(result.ratioToEstimate).toBeCloseTo(1.04, 2);
    expect(computeBidEconomics(input()).ratioToEstimate).toBeCloseTo(1.07, 2);
  });

  it("полоса сравнения меняется: НМЦК выше сметы на 6 %, но рядом с ценой контракта", () => {
    const nmc = 1_060_000 * 1.22;
    expect(computeBidEconomics(input({ nmc })).band).toBe("ABOVE_ESTIMATE");
    expect(computeBidEconomics(input({ nmc, ssr: ssrFor() })).band).toBe("NEAR_ESTIMATE");
  });

  it("сообщения называют цену контракта, а не расчёт по текущим ценам", () => {
    const below = computeBidEconomics(input({ nmc: 900_000 * 1.22, ssr: ssrFor() }));
    expect(below.flags.find((flag) => flag.code === "NMC_BELOW_ESTIMATE")?.message).toContain("нашей оценки цены контракта");
    const above = computeBidEconomics(input({ nmc: 1_400_000, nmcIncludesVat: true, ssr: ssrFor() }));
    const text = above.flags.find((flag) => flag.code === "NMC_ABOVE_ESTIMATE")?.message ?? "";
    expect(text).toContain("нашей оценки цены контракта");
  });

  it("верхняя граница поиска цены учитывает оценку НМЦК: безубыточная цена находится", () => {
    expect(computeBidEconomics(input({ ssr: ssrFor() })).breakEvenPrice).not.toBeNull();
  });
});

describe("себестоимость не включает резерв на непредвиденные", () => {
  const without = computeBidEconomics(input());
  const withReserve = computeBidEconomics(input({ ssr: ssrFor() }));

  it("себестоимость с ССР без сроков такая же, как без ССР: резерв в затраты не заложен", () => {
    expect(withReserve.basis.cost).toBe(without.basis.cost);
    expect(withReserve.basis.cost).toBe(700_000 + 200_000);
    expect(withReserve.ssr?.reserve).toBe(20_000);
    expect(withReserve.ssr?.reservePercent).toBe(2);
  });

  it("пометка RESERVE_NOT_IN_COST называет сумму резерва и объясняет, чьи это деньги", () => {
    const flag = withReserve.flags.find((item) => item.code === "RESERVE_NOT_IN_COST");
    expect(flag?.severity).toBe("INFO");
    expect(flag?.message.replace(/[  ]/gu, " ")).toContain("20 000 ₽ (2 % от итога глав)");
    expect(flag?.message).toContain("деньги заказчика на риск");
    expect(flag?.message).toContain("в себестоимость они не входят");
    expect(flag?.message).toContain("если это предусмотрено контрактом");
  });

  it("резерв остаётся в цене: при НМЦК, равной оценке с резервом, прибыль выше, чем при цене без него", () => {
    const priceWithReserve = 1_020_000 * 1.22;
    const priceWithoutReserve = 1_000_000 * 1.22;
    const rich = computeBidEconomics(input({ nmc: priceWithReserve, ssr: ssrFor() }));
    const poor = computeBidEconomics(input({ nmc: priceWithoutReserve, ssr: ssrFor() }));
    expect(rich.priceTable[0]!.profit).toBeGreaterThan(poor.priceTable[0]!.profit);
  });
});

describe("прогнозная инфляция — сквозная статья, как НДС", () => {
  const plain = computeBidEconomics(input({ ssr: ssrFor() }));
  const inflated = computeBidEconomics(input({ ssr: ssrFor(OCT_NOV) }));

  it("цена контракта в прогнозном уровне: 1 020 000 × 1,0047", () => {
    expect(inflated.ssr?.inflationIndex).toBe(1.0047);
    expect(inflated.basis.comparedWithBeforeVat).toBeCloseTo(1_020_000 * 1.0047, 0);
  });

  it("себестоимость тоже в прогнозном уровне цен: 900 000 × 1,0047", () => {
    expect(inflated.basis.cost).toBeCloseTo(900_000 * 1.0047, 0);
    expect(inflated.ssr?.costInflated).toBe(true);
    expect(plain.ssr?.costInflated).toBe(false);
  });

  it("маржа при цене, равной нашей оценке НМЦК, не зависит от инфляции: она не прибавляет к марже", () => {
    const marginPlain = computeBidEconomics(input({ nmc: 1_020_000 * 1.22, ssr: ssrFor() })).priceTable[0]!.marginPercent;
    const marginInflated = computeBidEconomics(input({ nmc: 1_020_000 * 1.0047 * 1.22, ssr: ssrFor(OCT_NOV) })).priceTable[0]!.marginPercent;
    expect(marginInflated).toBeCloseTo(marginPlain, 1);
  });

  it("пометка INFLATION_PASS_THROUGH есть только когда индекс применён", () => {
    expect(inflated.flags.map((flag) => flag.code)).toContain("INFLATION_PASS_THROUGH");
    expect(plain.flags.map((flag) => flag.code)).not.toContain("INFLATION_PASS_THROUGH");
  });
});

describe("НДС — по прежней логике", () => {
  it("УСН: НМЦК с НДС сравнивается с оценкой с НДС так же; выручка — вся цена", () => {
    const usn = computeBidEconomics(input({ ssr: ssrFor(), company: { taxSystem: "USN_INCOME", minMarginPercent: 10 } }));
    expect(usn.assumptions.nmcIncludesVat).toBe(true);
    expect(usn.priceTable[0]!.revenue).toBe(1_300_000);
    // НМЦК без НДС считается так же, как у плательщика НДС.
    expect(usn.nmcBeforeVat).toBeCloseTo(1_065_573.77, 2);
  });

  it("НМЦК без НДС: сравнение без деления на 1,22", () => {
    const noVat = computeBidEconomics(input({ nmc: 1_040_000, nmcIncludesVat: false, ssr: ssrFor() }));
    expect(noVat.nmcBeforeVat).toBe(1_040_000);
    expect(noVat.ratioToEstimate).toBeCloseTo(1.02, 2);
  });
});

describe("надёжность расчёта: допущения ССР", () => {
  it("без сроков и без назначения — две причины, минус 3 и минус 2", () => {
    const unknown = buildSsr({ document: DOCUMENT, purpose: null, workKind: null, period: null, priceDate: "2026-10-01", today: "2026-10-09" });
    const result = computeBidEconomics(input({ ssr: unknown }));
    expect(result.confidence.score).toBe(95);
    const joined = result.confidence.reasons.join(" | ");
    expect(joined).toContain("Резерв на непредвиденные");
    expect(joined).toContain("Прогнозная инфляция не применена");
    expect(joined).toContain("(−3)");
    expect(joined).toContain("(−2)");
  });

  it("назначение и сроки заданы — надёжность 100, причина «Все позиции оценены»", () => {
    const result = computeBidEconomics(input({ ssr: ssrFor(OCT_NOV) }));
    expect(result.confidence.score).toBe(100);
    expect(result.confidence.reasons).toEqual(["Все позиции оценены по текущим ценам"]);
  });

  it("без ССР надёжность прежняя", () => {
    expect(computeBidEconomics(input()).confidence).toEqual({ score: 100, reasons: ["Все позиции оценены по текущим ценам"] });
  });
});
