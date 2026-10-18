import { describe, expect, it, vi } from "vitest";

import { buildEstimate, computeEstimateSection, computeResourceLine } from "@/domain/estimate/calculate";
import { auditEstimateArithmetic, parseEstimateDocument } from "@/domain/estimate/schema";
import type { NormRecord, ResourcePrice } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_MANUAL_GRADING,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  Три ошибки расчёта, найденные на закупке 0302300048726001118 при сверке с ЛСР заказчика:
  поставка в «м» при единице справочника «1000 м» (6,77 млн ₽ вместо 6,8 тыс. ₽), оборудование по ТЦ,
  посчитанное нормой «похожей» работы, и ЛСР с исключениями материалов отрицательным объёмом.
*/

const WAGE_SCALE = buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);
const PARAMETERS = makeParameters();

const WIRE: ResourcePrice = {
  code: "21.2.02.02-0027",
  name: "Провод РПШЭ 2х2,5-380",
  unit: "1000 м",
  price: 66_392.28,
  machinistSalary: null,
  machinistHours: null,
  source: "CURRENT_ZONE",
  period: "3 квартал 2026 г.",
  zone: AMUR_ZONE.zone,
};
const PRICE_BOOK = makePriceBook(WAGE_SCALE, { current: new Map([[WIRE.code, WIRE]]) });

const wire = (patch: Partial<Parameters<typeof makeBillItem>[0]> = {}) =>
  makeBillItem({
    id: "wire",
    workName: "Провод РПШЭ 2х2,5-380",
    quantity: 102,
    quantityUnit: "м",
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    resourceCode: WIRE.code,
    ...patch,
  });

describe("поставка: единица справочника с множителем («1000 м») — масштаб, а не расхождение", () => {
  it("102 м при цене за 1000 м стоят 6 772 ₽, а не 6,77 млн ₽", () => {
    const outcome = computeResourceLine(wire(), PRICE_BOOK, PARAMETERS);

    expect(outcome.line?.directCost).toBeCloseTo(6_772.01, 2);
    expect(outcome.line?.quantity).toBeCloseTo(0.102, 6);
    expect(outcome.line?.billQuantity).toBe(102);
    expect(outcome.gaps.some((gap) => gap.kind === "UNIT_MISMATCH")).toBe(false);
  });

  it("то же в единицах справочника: 0,102 «1000 м» — тот же результат", () => {
    const outcome = computeResourceLine(wire({ quantity: 0.102, quantityUnit: "1000 м" }), PRICE_BOOK, PARAMETERS);

    expect(outcome.line?.directCost).toBeCloseTo(6_772.01, 2);
  });

  it("единицы разных величин по-прежнему не переводятся: пометка, а не догадка", () => {
    const outcome = computeResourceLine(wire({ quantityUnit: "м2" }), PRICE_BOOK, PARAMETERS);

    expect(outcome.gaps.some((gap) => gap.kind === "UNIT_MISMATCH")).toBe(true);
    expect(outcome.line?.quantity).toBe(102);
  });
});

describe("позиция по ТЦ, КП, прайсу не идёт в подбор нормы", () => {
  const equipment = makeBillItem({
    id: "pump",
    workName: "Насос центробежный RV80-200/2",
    quantity: 1,
    quantityUnit: "шт",
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    resourceCode: null,
    customerPriceOnly: true,
    customerPrice: { total: 169_754.31, unitPrice: 169_754.31, unit: "шт", origin: "POSITION_TOTAL", document: "ЛСР" },
  });

  it("норму никто не ищет, деньги заказчика входят строкой с пометкой", () => {
    const resolve = vi.fn(makeResolver([NORM_MANUAL_GRADING]));
    const { section, gaps } = computeEstimateSection(makeBillSection("ЛСР", [equipment]), PRICE_BOOK, PARAMETERS, resolve);

    expect(resolve).not.toHaveBeenCalled();
    expect(section.lines).toHaveLength(1);
    expect(section.lines[0]?.priceSource).toBe("CUSTOMER_PRICE");
    expect(section.directCost).toBe(169_754.31);
    expect(section.overheadCost).toBe(0);
    expect(gaps.map((gap) => gap.kind)).toEqual(["CUSTOMER_PRICE"]);
  });

  it("без цены заказчика — «норма не найдена», а не чужая норма", () => {
    const resolve = vi.fn(makeResolver([NORM_MANUAL_GRADING]));
    const { section, gaps } = computeEstimateSection(
      makeBillSection("ЛСР", [{ ...equipment, customerPrice: null }]),
      PRICE_BOOK,
      PARAMETERS,
      resolve,
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(section.lines).toHaveLength(0);
    expect(gaps.map((gap) => gap.kind)).toEqual(["NO_NORM"]);
  });
});

describe("строка-исключение: отрицательный объём в смете заказчика", () => {
  const supply = (id: string, deduction: boolean) =>
    wire({ id, quantity: 1_000, quantityUnit: "м", ...(deduction ? { deduction: true } : {}) });

  it("исключение вычитается: суммы строки со знаком минус, арифметика сходится", () => {
    const { section } = computeEstimateSection(
      makeBillSection("ЛСР", [supply("a", false), supply("b", true)]),
      PRICE_BOOK,
      PARAMETERS,
      makeResolver([]),
    );

    const [plain, minus] = section.lines;
    expect(plain?.directCost).toBeCloseTo(66_392.28, 2);
    expect(minus?.directCost).toBeCloseTo(-66_392.28, 2);
    expect(minus?.quantity).toBeCloseTo(-1, 6);
    expect(minus?.deduction).toBe(true);
    expect(minus?.resources[0]?.total).toBeCloseTo(-66_392.28, 2);
    expect(section.workCost).toBe(0);
  });

  it("документ с исключением проходит схему и сверку арифметики", () => {
    const document = buildEstimate({
      title: "Тест",
      sections: [makeBillSection("ЛСР", [supply("a", false), supply("b", true), wire({ id: "c", quantity: 500, quantityUnit: "м" })])],
      priceBook: PRICE_BOOK,
      parameters: PARAMETERS,
      resolveNorm: makeResolver([]),
      sources: [],
      generatedAt: "2026-10-09T00:00:00.000Z",
      disclaimer: "тест",
    });

    expect(document.totals.workCost).toBeCloseTo(33_196.14, 2);
    expect(auditEstimateArithmetic(parseEstimateDocument(document))).toEqual([]);
  });
});
