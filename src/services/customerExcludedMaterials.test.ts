import { describe, expect, it } from "vitest";

import { buildEstimate } from "@/domain/estimate/calculate";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import type { BillOfWorkItem, NormResource } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import { calculateBill } from "@/services/estimateService";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAINAGE_100,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  Материалы, которых заказчик в позиции не учёл. Если у позиции его ЛСР есть строки ресурсов, а группа «М» напечатана и равна нулю,
  заказчик убрал материалы нормы из позиции сознательно: они вынесены отдельной позицией (закупка 0134300025826000377, поз. 1
  ГЭСН15-01-070-01 «Облицовка оконных проемов … откосной планкой» — планки в поз. 2; закупка 0391300028226000005, поз. 3 ГЭСН12-01-007-12).
  Раньше правило «сумма материалов по группе М» действовало только без состава заказчика, и материалы нормы шли в смету второй раз.
*/

const NOT_MATERIAL = NORM_DRAINAGE_100.resources.filter((resource) => resource.kind !== "MATERIAL");
const MATERIALS = NORM_DRAINAGE_100.resources.filter((resource) => resource.kind === "MATERIAL" && !resource.projectSpecific && resource.quantityNote === null);
const SAND: NormResource = { code: "02.3.01.02-1118", kind: "MATERIAL", name: "Песок природный", quantity: 10, unit: "м3", quantityNote: null, projectSpecific: false, technologyGroup: null };

const WAGE = buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);
const ITEM: Partial<BillOfWorkItem> = { id: "d", workName: "Облицовка откосной планкой", quantity: 1000, quantityUnit: "м", unitDivisor: 1000, normCode: "01-01-129-11", normBaseType: "ГЭСН" };

describe("без замены состава нормы (резолвер отдаёт норму как есть): «М» = 0 при строках ресурсов", () => {
  const book = makePriceBook(WAGE);
  const calc = (patch: Partial<BillOfWorkItem>) =>
    buildEstimate({
      title: "Тест",
      sections: [makeBillSection("ЛСР", [makeBillItem({ ...ITEM, ...patch })])],
      priceBook: book,
      parameters: makeParameters(),
      resolveNorm: makeResolver([NORM_DRAINAGE_100]),
      sources: [],
      generatedAt: "2026-10-10T00:00:00.000Z",
      disclaimer: "тест",
    });
  const plain = calc({});
  const plainLine = plain.sections[0]?.lines[0];

  it("позиция без материалов заказчика: материалы нормы не считаются, в строке пометка CUSTOMER_PRICE, остальное без изменений", () => {
    expect(plainLine?.materialCost).toBeGreaterThan(0);

    const document = calc({ customerResources: NOT_MATERIAL, customerMaterials: 0 });
    const line = document.sections[0]?.lines[0];

    expect(line?.materialCost).toBe(0);
    expect(line?.resources.filter((resource) => resource.kind === "MATERIAL")).toEqual([]);
    expect(line?.labourCost).toBeCloseTo(plainLine?.labourCost ?? 0, 2);
    expect(line?.machineCost).toBeCloseTo(plainLine?.machineCost ?? 0, 2);
    expect(line?.directCost).toBeCloseTo((line?.labourCost ?? 0) + (line?.machineCost ?? 0), 2);
    // Начисления идут от ФОТ, материалы их не меняют.
    expect(line?.overheadCost).toBeCloseTo(plainLine?.overheadCost ?? 0, 2);
    const note = document.gaps.find((gap) => gap.kind === "CUSTOMER_PRICE" && gap.message.includes("материалы у заказчика в позиции не учтены (вынесены отдельно)"));
    expect(note).toBeDefined();
    expect(line?.gaps.some((gap) => gap.kind === "CUSTOMER_PRICE")).toBe(true);
  });

  it("пометки о ценах снятых материалов (нет цены, цена базы) вместе с ними не остаются", () => {
    const document = calc({ customerResources: NOT_MATERIAL, customerMaterials: 0 });
    const withMaterials = plain.gaps.filter((gap) => ["NO_PRICE", "ZERO_PRICE", "NO_CURRENT_PRICE", "INDEXED_PRICE"].includes(gap.kind) && MATERIALS.some((resource) => gap.message.includes(resource.code)));

    for (const gap of withMaterials) expect(document.gaps.some((candidate) => candidate.message === gap.message)).toBe(false);
  });

  it("у заказчика материалы в позиции есть («М» больше нуля): правило не действует, расчёт прежний", () => {
    const document = calc({ customerResources: [...NOT_MATERIAL, SAND], customerMaterials: 12_345.67 });
    const line = document.sections[0]?.lines[0];

    expect(line?.materialCost).toBeCloseTo(plainLine?.materialCost ?? 0, 2);
    expect(document.gaps.some((gap) => gap.message.includes("вынесены отдельно"))).toBe(false);
  });

  it("«М» заказчика неизвестна (не передана): материалы не снимаются", () => {
    const document = calc({ customerResources: NOT_MATERIAL });
    const line = document.sections[0]?.lines[0];

    expect(line?.materialCost).toBeCloseTo(plainLine?.materialCost ?? 0, 2);
    expect(document.gaps.some((gap) => gap.message.includes("вынесены отдельно"))).toBe(false);
  });

  it("строк ресурсов у позиции нет, есть только «М» = 0: прежнее правило сверки по сумме, не новое", () => {
    const document = calc({ customerMaterials: 0 });
    const line = document.sections[0]?.lines[0];

    expect(line?.materialCost).toBe(0);
    expect(document.gaps.some((gap) => gap.message.includes("вынесены отдельно"))).toBe(false);
    expect(document.gaps.some((gap) => gap.message.includes("материалы по сумме заказчика"))).toBe(true);
  });

  it("материалы, названные человеком (projectMaterials), правило не трогает", () => {
    const named = { code: "99.9.99.99-0001", name: "Планка откосная", unit: "м", quantity: 100, unitPrice: 50 };
    const document = calc({ customerResources: NOT_MATERIAL, customerMaterials: 0, projectMaterials: [named] });
    const line = document.sections[0]?.lines[0];

    expect(line?.materialCost).toBeCloseTo(5_000, 2);
  });
});

describe("через расчёт ведомости: состав по строкам ЛСР заменяет состав нормы", () => {
  const baseOf = (): EstimateBase => ({
    info: {
      indexDir: "x",
      builtAt: "2026-09-28T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: AMUR_ZONE.region,
      priceZone: AMUR_ZONE.zone,
      period: AMUR_ZONE.period,
      decree: "тест",
      counts: { norms: 1, basePrices: 0, currentPrices: 0, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    priceBook: makePriceBook(WAGE),
    searchIndex: createNormSearchIndex([NORM_DRAINAGE_100]),
    zones: [],
    sources: [],
    loadMs: 0,
  });
  const run = (patch: Partial<BillOfWorkItem>) => {
    const base = baseOf();
    return calculateBill({
      title: "Тест",
      sections: [makeBillSection("ЛСР", [makeBillItem({ ...ITEM, ...patch })])],
      base,
      priceBook: base.priceBook,
      parameters: makeParameters(),
      appliedNormatives: [],
      sources: [],
      generatedAt: "2026-10-10T00:00:00.000Z",
    }).document;
  };
  const line = (document: ReturnType<typeof run>) => document.sections[0]?.lines[0];

  it("строки ресурсов без материалов и «М» = 0: материалов в позиции нет", () => {
    const document = run({ customerResources: NOT_MATERIAL, customerMaterials: 0 });

    expect(line(document)?.materialCost).toBe(0);
    expect(line(document)?.directCost).toBeCloseTo((line(document)?.labourCost ?? 0) + (line(document)?.machineCost ?? 0), 2);
  });

  it("у заказчика в строках есть материал, но «М» напечатана нулём (цена не проставлена): материалы не считаются, пометка названа", () => {
    const document = run({ customerResources: [...NOT_MATERIAL, SAND], customerMaterials: 0 });

    expect(line(document)?.materialCost).toBe(0);
    expect(document.gaps.some((gap) => gap.kind === "CUSTOMER_PRICE" && gap.message.includes("вынесены отдельно"))).toBe(true);
  });

  it("у заказчика есть материал и «М» > 0: считается по его составу нашими ценами, пометки нет", () => {
    const document = run({ customerResources: [...NOT_MATERIAL, SAND], customerMaterials: 777 });
    const materials = line(document)?.resources.filter((resource) => resource.kind === "MATERIAL") ?? [];

    expect(materials.map((resource) => resource.code)).toEqual([SAND.code]);
    expect(line(document)?.materialCost).toBeGreaterThan(0);
    expect(document.gaps.some((gap) => gap.message.includes("вынесены отдельно"))).toBe(false);
  });
});
