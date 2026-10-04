import { describe, expect, it } from "vitest";

import { computeAssurance } from "@/domain/estimate/assurance";
import {
  buildEstimate,
  type EstimatePriceBook,
} from "@/domain/estimate/calculate";
import type {
  BillOfWorkSection,
  EstimateDocument,
  EstimateParameters,
} from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_DRAGLINE,
  BILL_DREDGER,
  BILL_GRADING,
  NORM_DRAGLINE_15,
  NORM_DREDGER_800,
  NORM_MANUAL_GRADING,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

const NORMS = [NORM_MANUAL_GRADING, NORM_DRAGLINE_15, NORM_DREDGER_800];

function wageScale() {
  return buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);
}

function build(
  sections: readonly BillOfWorkSection[],
  patch: {
    priceBook?: Partial<EstimatePriceBook>;
    parameters?: Partial<EstimateParameters>;
  } = {},
): EstimateDocument {
  return buildEstimate({
    title: "Тестовый расчёт",
    sections,
    priceBook: makePriceBook(wageScale(), patch.priceBook),
    parameters: makeParameters(patch.parameters),
    resolveNorm: makeResolver(NORMS),
    sources: [],
    generatedAt: "2026-09-27T00:00:00.000Z",
    disclaimer: "Информационно-аналитическая справка, не является сметой",
  });
}

describe("computeAssurance", () => {
  it("даёт нулевую долю, когда ни одно начисление не держится на допущении", () => {
    const document = build([
      makeBillSection("Земляные работы", [BILL_GRADING]),
    ]);

    const assurance = computeAssurance(document);

    expect(assurance.assumedCost).toBe(0);
    expect(assurance.assumedPercent).toBe(0);
    expect(assurance.assumptions).toEqual([]);
  });

  it("считает объяснённую и допущенную стоимость в сумме равными стоимости СМР", () => {
    const document = build([
      makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE]),
    ]);

    const assurance = computeAssurance(document);

    expect(assurance.workCost).toBe(document.totals.workCost);
    expect(assurance.explainedCost + assurance.assumedCost).toBeCloseTo(
      document.totals.workCost,
      2,
    );
  });

  it("относит к допущениям накладные расходы и прибыль, начисленные резервом документа", () => {
    const document = build(
      [makeBillSection("Земляные работы", [BILL_GRADING])],
      {
        priceBook: { overheadRates: new Map() },
      },
    );

    const assurance = computeAssurance(document);
    const reserve = assurance.assumptions.find(
      (item) => item.kind === "OVERHEAD_DEFAULT",
    );

    expect(reserve?.cost).toBeCloseTo(
      document.totals.overheadCost + document.totals.profitCost,
      2,
    );
  });

  it("относит к допущениям стоимость ресурсов, взятых по цене базового уровня 2022 года", () => {
    const document = build([
      makeBillSection("Земляные работы", [BILL_DRAGLINE]),
    ]);

    const assurance = computeAssurance(document);
    const basePrice = assurance.assumptions.find(
      (item) => item.kind === "BASE_PRICE",
    );

    const expected = document.sections
      .flatMap((section) => section.lines)
      .flatMap((line) => line.resources)
      .filter(
        (resource) =>
          resource.source === "BASE_2022" ||
          resource.source === "BASE_2022_INDEXED",
      )
      .reduce((total, resource) => total + resource.total, 0);

    expect(expected).toBeGreaterThan(0);
    expect(basePrice?.cost).toBeCloseTo(expected, 2);
  });

  it("считает ресурсы с расходом и без денег отдельно, не увеличивая стоимость допущений", () => {
    const document = build([
      makeBillSection("Земляные работы", [BILL_DREDGER]),
    ]);

    const assurance = computeAssurance(document);

    expect(assurance.unpricedResources).toBeGreaterThan(0);
    expect(assurance.assumptions.every((item) => item.cost > 0)).toBe(true);
  });

  it("считает позицию, для которой норма не нашлась, выпавшей из расчёта", () => {
    const document = build([
      makeBillSection("Земляные работы", [
        BILL_GRADING,
        makeBillItem({
          id: "item-missing",
          normCode: "99-99-999-99",
          normBaseType: "ГЭСН",
        }),
      ]),
    ]);

    const assurance = computeAssurance(document);

    expect(assurance.droppedPositions).toBe(1);
  });

  it("считает долю от стоимости СМР, а не от итога с НДС", () => {
    const document = build(
      [makeBillSection("Земляные работы", [BILL_DRAGLINE])],
      {
        parameters: { vatPercent: 20 },
      },
    );

    const assurance = computeAssurance(document);

    expect(assurance.assumedPercent).toBeCloseTo(
      (assurance.assumedCost / document.totals.workCost) * 100,
      2,
    );
  });

  it("не превращает нулевую стоимость СМР в NaN", () => {
    const document = build([makeBillSection("Пустой раздел", [])]);

    const assurance = computeAssurance(document);

    expect(document.totals.workCost).toBe(0);
    expect(assurance.assumedPercent).toBe(0);
    expect(assurance.explainedCost).toBe(0);
  });

  it("печатает каждое допущение с его долей в стоимости СМР", () => {
    const document = build(
      [makeBillSection("Земляные работы", [BILL_DRAGLINE])],
      {
        priceBook: { overheadRates: new Map() },
      },
    );

    const assurance = computeAssurance(document);

    expect(assurance.assumptions.length).toBeGreaterThan(1);
    for (const assumption of assurance.assumptions) {
      expect(assumption.percent).toBeCloseTo(
        (assumption.cost / document.totals.workCost) * 100,
        2,
      );
      expect(assumption.message.length).toBeGreaterThan(0);
    }
  });

  it("сортирует допущения по убыванию стоимости", () => {
    const document = build(
      [makeBillSection("Земляные работы", [BILL_DRAGLINE])],
      {
        priceBook: { overheadRates: new Map() },
      },
    );

    const costs = computeAssurance(document).assumptions.map(
      (item) => item.cost,
    );

    expect(costs).toEqual([...costs].sort((left, right) => right - left));
  });
});
