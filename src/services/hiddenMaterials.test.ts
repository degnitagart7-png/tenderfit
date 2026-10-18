import { describe, expect, it } from "vitest";

import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import type { NormResource } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import { calculateBill, withUnaccountedHints } from "@/services/estimateService";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAINAGE_100,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
} from "@/test/estimateFixtures";
import { DOCUMENTS_1118 } from "@/test/t1118Fixtures";

/*
  «Объяснимо до позиции»: скрытые материалы позиции ЛСР. «Всего по позиции» заказчика больше суммы видимых составляющих —
  в остатке ресурсы, которых в выгрузке нет. Остаток — отдельная строка, подсказка называет вероятный ресурс нормы;
  материалы по сумме заказчика и состав по строкам его ЛСР — два способа не потерять расходящийся состав.
*/

const set = buildLsrSet(parseCustomerLsr(DOCUMENTS_1118).estimates);
const sectionOf = (number: string) => {
  const index = set.entries.findIndex((entry) => entry.number === number);
  return lsrBillSection(set.entries[index] as (typeof set.entries)[number], index + 1).section;
};

describe("невидимый остаток позиции ЛСР", () => {
  const section = sectionOf("02-02-08");
  const item = (label: string) => section.items.find((candidate) => candidate.positionNumber === label);

  it("остаток — отдельная строка после позиции, по сумме заказчика, помечена и привязана к позиции", () => {
    const parent = item("13");
    const rest = item("13*");

    expect(rest?.unaccountedOf).toBe(parent?.id);
    expect(rest?.customerPriceOnly).toBe(true);
    expect(rest?.customerPrice?.total).toBeCloseTo(3502.5, 2);
    expect(rest?.workName).toContain("Неучтённые в выгрузке ресурсы позиции 13");
    const order = section.items.map((candidate) => candidate.positionNumber);
    expect(order.indexOf("13*")).toBe(order.indexOf("13") + 1);
  });

  it("позиция без остатка (1 ₽ и меньше) строки не получает; сумма позиции и остатка равна «Всего по позиции»", () => {
    expect(item("7*")).toBeUndefined();
    expect(item("12*")).toBeUndefined();
    // «Всего по позиции» поз. 13 = видимая часть + остаток; деньги не теряются (итог ЛСР сверен отдельным тестом).
    expect((item("13")?.customerPrice?.total ?? 0) + (item("13*")?.customerPrice?.total ?? 0)).toBeCloseTo(118117.24 + 3502.5, 1);
  });

  it("материалы группы «М» заказчика сохранены у позиции: по ним расчёт видит замену состава", () => {
    expect(item("12")?.customerMaterials).toBeCloseTo(5111.19, 2);
    expect(item("13")?.customerMaterials).toBeCloseTo(458.16, 2);
  });
});

describe("подсказка к остатку: вероятный ресурс нормы", () => {
  const index = createNormSearchIndex([NORM_DRAINAGE_100]);
  const base = { searchIndex: index } as unknown as Pick<EstimateBase, "searchIndex">;
  const parent = makeBillItem({ id: "p", workName: "Устройство дренажа", quantity: 2000, quantityUnit: "м", unitDivisor: 1000, normCode: "01-01-129-11", normBaseType: "ГЭСН" });
  const rest = makeBillItem({
    id: "p-rest",
    workName: "Неучтённые в выгрузке ресурсы позиции 1",
    quantity: 1,
    quantityUnit: "усл. ед.",
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    customerPriceOnly: true,
    unaccountedOf: "p",
    customerPrice: { unit: "усл. ед.", unitPrice: 5125, total: 5125, origin: "POSITION_TOTAL", document: null },
  });

  it("называет материал «по проекту», расход по норме и подразумеваемую цену за единицу", () => {
    const [section] = withUnaccountedHints([makeBillSection("ЛСР", [parent, rest])], base);
    const hinted = section?.items[1];

    expect(hinted?.workName).toContain("Труба дренажная полиэтиленовая");
    expect(hinted?.sourceQuote).toContain("Скорее всего, это");
    expect(hinted?.sourceQuote).toContain("допущение");
  });

  it("позиция без материалов по проекту подсказки не получает", () => {
    const plain = { ...parent, normCode: "01-01-129-11", id: "q" };
    const rest2 = { ...rest, unaccountedOf: "q" };
    const noHidden = createNormSearchIndex([
      { ...NORM_DRAINAGE_100, resources: NORM_DRAINAGE_100.resources.map((resource) => ({ ...resource, projectSpecific: false, quantityNote: null })) },
    ]);
    const [section] = withUnaccountedHints([makeBillSection("ЛСР", [plain, rest2])], { searchIndex: noHidden } as never);
    expect(section?.items[1]).toBe(rest2);
  });
});

describe("материалы по сумме заказчика и состав по его строкам", () => {
  const NORMS = [NORM_DRAINAGE_100];
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
    priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE)),
    searchIndex: createNormSearchIndex(NORMS),
    zones: [],
    sources: [],
    loadMs: 0,
  });
  const run = (patch: Partial<Parameters<typeof makeBillItem>[0]>) => {
    const base = baseOf();
    return calculateBill({
      title: "Тест",
      sections: [makeBillSection("ЛСР", [makeBillItem({ id: "d", workName: "Дренаж", quantity: 1000, quantityUnit: "м", unitDivisor: 1000, normCode: "01-01-129-11", normBaseType: "ГЭСН", ...patch })])],
      base,
      priceBook: base.priceBook,
      parameters: makeParameters(),
      appliedNormatives: [],
      sources: [],
      generatedAt: "2026-10-10T00:00:00.000Z",
    }).document;
  };
  const line = (document: ReturnType<typeof run>) => document.sections[0]?.lines[0];
  const ours = line(run({}))?.materialCost ?? 0;

  it("сумма заказчика близка к нашей — состав нормы остаётся, замены нет", () => {
    const document = run({ customerMaterials: ours });
    expect(line(document)?.resources.some((resource) => resource.source === "CUSTOMER_SUM")).toBe(false);
    expect(line(document)?.materialCost).toBeCloseTo(ours, 2);
  });

  it("сумма расходится больше чем на четверть и на 100 ₽ — материалы по сумме заказчика, допущение названо", () => {
    const theirs = ours / 2;
    const document = run({ customerMaterials: theirs });
    const result = line(document);

    expect(result?.materialCost).toBeCloseTo(theirs, 2);
    const summary = result?.resources.filter((resource) => resource.source === "CUSTOMER_SUM") ?? [];
    expect(summary).toHaveLength(1);
    expect(summary[0]?.total).toBeCloseTo(theirs, 2);
    expect(result?.resources.filter((resource) => resource.kind === "MATERIAL" && resource.source !== "CUSTOMER_SUM")).toEqual([]);
    expect(document.gaps.some((gap) => gap.kind === "CUSTOMER_PRICE" && gap.message.includes("материалы по сумме заказчика"))).toBe(true);
    // Арифметика документа сходится: прямые = труд + машины + материалы.
    expect((result?.directCost ?? 0) - ((result?.labourCost ?? 0) + (result?.machineCost ?? 0) + (result?.materialCost ?? 0))).toBeCloseTo(0, 2);
  });

  it("состав по строкам ЛСР: ресурсы нормы заменены ресурсами заказчика, цены наши", () => {
    const composition: NormResource[] = [
      ...NORM_DRAINAGE_100.resources.filter((resource) => resource.kind !== "MATERIAL"),
      { code: "02.3.01.02-1118", kind: "MATERIAL", name: "Песок природный", quantity: 10, unit: "м3", quantityNote: null, projectSpecific: false, technologyGroup: null },
    ];
    const document = run({ customerResources: composition });
    const materials = line(document)?.resources.filter((resource) => resource.kind === "MATERIAL") ?? [];

    expect(materials.map((resource) => resource.code)).toEqual(["02.3.01.02-1118"]);
    expect(materials[0]?.quantity).toBeCloseTo(10, 6);
    expect(materials[0]?.source).not.toBe("CUSTOMER_SUM");
    expect(document.gaps.some((gap) => gap.message.includes("24.3.03.06"))).toBe(false);
  });
});
