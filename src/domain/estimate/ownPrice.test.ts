import { describe, expect, it } from "vitest";

import { computeAssurance } from "@/domain/estimate/assurance";
import { computeBidEconomics } from "@/domain/estimate/bidEconomics";
import { buildEstimate, ownPriceLine } from "@/domain/estimate/calculate";
import { estimateDocumentSchema, auditEstimateArithmetic } from "@/domain/estimate/schema";
import type { BillOfWorkItem, EstimateDocument } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_DRAGLINE,
  BILL_GRADING,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  Своя цена: человек назвал цену за единицу вместо цены по норме. Позиция считается как
  «объём × цена», НР и СП не начисляются (как у цены заказчика), а в допущения она не входит:
  цену назвал человек, расчёт её вместо недостающей не подставлял.
*/

function build(items: readonly BillOfWorkItem[], vatPercent = 20): EstimateDocument {
  return buildEstimate({
    title: "Тест",
    sections: [makeBillSection("Раздел", items)],
    priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE)),
    parameters: makeParameters({ vatPercent }),
    resolveNorm: makeResolver([NORM_MANUAL_GRADING, NORM_DRAGLINE_15]),
    sources: [],
    generatedAt: "2026-10-09T00:00:00.000Z",
    disclaimer: "—",
  });
}

const OWN = makeBillItem({
  id: "own-1",
  workName: "Демонтаж наружных стен",
  quantity: 120,
  quantityUnit: "м2",
  unitDivisor: 1,
  normCode: null,
  normBaseType: null,
  ownUnitPrice: 1250.5,
});

describe("своя цена за единицу", () => {
  it("позиция = объём × цена; НР и СП не начисляются, норма не ищется", () => {
    const document = build([OWN]);
    const line = document.sections[0]?.lines[0];

    expect(line?.priceSource).toBe("OWN_PRICE");
    expect(line?.directCost).toBe(150_060);
    expect(line?.overheadCost).toBe(0);
    expect(line?.profitCost).toBe(0);
    expect(line?.normBaseType).toBe("Своя цена");
    expect(line?.gaps).toEqual([]);
    expect(document.gaps).toEqual([]);
    expect(document.totals.workCost).toBe(150_060);
    expect(document.totals.vat).toBe(30_012);
    expect(document.totals.total).toBe(180_072);
  });

  it("своя цена важнее нормы: у позиции с шифром считается по цене, а не по норме", () => {
    const withNorm = build([BILL_GRADING]);
    const priced = build([{ ...BILL_GRADING, ownUnitPrice: 10 }]);

    expect(withNorm.sections[0]?.lines[0]?.priceSource).toBeUndefined();
    expect(priced.sections[0]?.lines[0]?.priceSource).toBe("OWN_PRICE");
    expect(priced.sections[0]?.lines[0]?.directCost).toBe(8000);
  });

  it("в итоги вынесена доля своих цен; цена заказчика по-прежнему считается отдельно", () => {
    const document = build([OWN, BILL_GRADING]);
    expect(document.totals.ownPricedCount).toBe(1);
    expect(document.totals.ownPriced).toBe(150_060);
    expect(document.totals.customerPricedCount).toBeUndefined();
  });

  it("не допущение: доля допущений нулевая, пока других допущений нет", () => {
    const document = build([OWN]);
    const assurance = computeAssurance(document);
    expect(assurance.assumedPercent).toBe(0);
    expect(assurance.assumptions).toEqual([]);
    expect(assurance.droppedPositions).toBe(0);
  });

  it("цена заказчика — допущение, как и раньше: вся её стоимость в доле допущений", () => {
    const customer = makeBillItem({
      id: "cust-1",
      workName: "Работа без нормы",
      quantity: 10,
      quantityUnit: "м2",
      unitDivisor: 1,
      normCode: null,
      normBaseType: null,
      customerPrice: { total: 5000, unitPrice: 500, unit: "м2", origin: "LINE", document: "Смета.pdf" },
    });
    const document = build([OWN, customer]);
    const assurance = computeAssurance(document);

    expect(assurance.assumptions.map((item) => item.kind)).toEqual(["CUSTOMER_PRICE"]);
    expect(assurance.assumedCost).toBe(5000);
    // Своя цена в долю не попала: знаменатель — вся стоимость СМР, числитель — только цена заказчика.
    expect(assurance.assumedPercent).toBeCloseTo((5000 / 155_060) * 100, 1);
  });

  it("надёжность расчёта: своя цена её не снижает, цена заказчика снижает", () => {
    const economics = (doc: EstimateDocument) => {
      const assurance = computeAssurance(doc);
      return computeBidEconomics({
        document: doc,
        nmc: 300_000,
        billItems: 1,
        droppedPositions: assurance.droppedPositions,
        assumedPercent: assurance.assumedPercent,
        unpricedResources: assurance.unpricedResources,
        company: { taxSystem: "OSNO", minMarginPercent: 10 },
      });
    };
    const own = economics(build([OWN]));
    expect(own.confidence.score).toBe(100);
    expect(own.confidence.reasons).toEqual(["Все позиции оценены по текущим ценам"]);

    const customer = makeBillItem({
      id: "cust-1",
      workName: "Работа без нормы",
      quantity: 10,
      quantityUnit: "м2",
      unitDivisor: 1,
      normCode: null,
      normBaseType: null,
      customerPrice: { total: 150_000, unitPrice: 15_000, unit: "м2", origin: "LINE", document: "Смета.pdf" },
    });
    expect(economics(build([customer])).confidence.score).toBeLessThan(100);
  });

  it("арифметика документа со своей ценой сходится и проходит схему", () => {
    const document = build([OWN, BILL_DRAGLINE]);
    const parsed = estimateDocumentSchema.parse(JSON.parse(JSON.stringify(document)));
    expect(auditEstimateArithmetic(parsed)).toEqual([]);
  });

  it("объём не больше нуля или цена не больше нуля — строки по своей цене нет", () => {
    expect(ownPriceLine({ ...OWN, quantity: 0 })).toBeNull();
    expect(ownPriceLine({ ...OWN, ownUnitPrice: 0 })).toBeNull();
    expect(ownPriceLine({ ...OWN, ownUnitPrice: null })).toBeNull();
  });

  it("зимнее удорожание и временные здания начисляются и на свою цену, как на цену заказчика", () => {
    const document = buildEstimate({
      title: "Тест",
      sections: [makeBillSection("Раздел", [OWN])],
      priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE)),
      parameters: makeParameters({
        limited: { winterSurchargePercent: 2, temporaryStructuresPercent: 1, source: "тест" },
      }),
      resolveNorm: () => null,
      sources: [],
      generatedAt: "2026-10-09T00:00:00.000Z",
      disclaimer: "—",
    });
    expect(document.totals.temporaryStructures).toBe(1500.6);
    expect(document.totals.winterSurcharge).toBeCloseTo(3031.21, 2);
  });
});
