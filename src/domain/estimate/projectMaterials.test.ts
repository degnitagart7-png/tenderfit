import { describe, expect, it } from "vitest";

import { applyBillEdits, anchorOf, clearEdit, describeBillEdits, recordEdit, billEditSchema, type BillEdit } from "@/domain/estimate/billEdits";
import { buildRowInfos } from "@/domain/estimate/billReview";
import { computeEstimateSection } from "@/domain/estimate/calculate";
import { computeAssurance } from "@/domain/estimate/assurance";
import { buildEstimate } from "@/domain/estimate/calculate";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { buildWageScale } from "@/domain/estimate/wageScale";
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
  Материалы «по проекту» в ведомости без ЛСР: у нормы с расходом «П» или материалом без марки нет ни количества, ни цены.
  Строка просит их у человека, предлагает количество и после правки «материал» считает их своей ценой.
*/

const PRICE_BOOK = makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE));
const PARAMETERS = makeParameters();
const INDEX = createNormSearchIndex([NORM_DRAINAGE_100]);

const drainage = (patch: Partial<Parameters<typeof makeBillItem>[0]> = {}) =>
  makeBillItem({
    id: "drain",
    workName: "Устройство закрытого дренажа из полиэтиленовых труб диаметром 100 мм",
    quantity: 2000,
    quantityUnit: "м",
    unitDivisor: 1000,
    normCode: "01-01-129-11",
    normBaseType: "ГЭСН",
    ...patch,
  });

const calc = (item = drainage()) =>
  computeEstimateSection(makeBillSection("Дренаж", [item]), PRICE_BOOK, PARAMETERS, makeResolver([NORM_DRAINAGE_100]));

describe("материал по проекту: подсказка к строке", () => {
  const item = drainage();
  const { section } = calc(item);
  const infos = buildRowInfos({ items: [item], lines: new Map(section.lines.map((line) => [line.itemId, line])), index: INDEX });
  const hints = infos[0]?.projectMaterials ?? [];

  it("называет материал с расходом «П» и материал без марки", () => {
    expect(hints.map((hint) => hint.code)).toEqual(["24.3.03.05", "24.3.03.06"]);
    expect(hints.every((hint) => !hint.supplied)).toBe(true);
  });

  it("расход «П»: единица шт, единица позиции м — количество предложить нечем", () => {
    const sleeve = hints.find((hint) => hint.code === "24.3.03.05");
    expect(sleeve?.suggestion).toBeNull();
    expect(sleeve?.suggestedQuantity).toBeNull();
  });

  it("расход в норме есть, марки нет: количество по норме на весь объём", () => {
    const pipe = hints.find((hint) => hint.code === "24.3.03.06");
    expect(pipe?.suggestion).toBe("NORM");
    // 1025 м на 1000 м нормы, позиция 2000 м
    expect(pipe?.suggestedQuantity).toBeCloseTo(2050, 6);
  });

  it("единицы ресурса и позиции совпадают, расхода нет: предложено 1 на единицу позиции, помечено «предложено»", () => {
    const meters = createNormSearchIndex([
      {
        ...NORM_DRAINAGE_100,
        resources: NORM_DRAINAGE_100.resources.map((resource) =>
          resource.code === "24.3.03.05" ? { ...resource, unit: "м" } : resource,
        ),
      },
    ]);
    const [info] = buildRowInfos({ items: [item], lines: new Map(section.lines.map((line) => [line.itemId, line])), index: meters });
    const sleeve = info?.projectMaterials?.find((hint) => hint.code === "24.3.03.05");
    expect(sleeve?.suggestion).toBe("ASSUMED");
    expect(sleeve?.suggestedQuantity).toBe(2000);
  });

  it("позиция ЛСР заказчика материалов не спрашивает: у неё его суммы", () => {
    const lsr = drainage({ customerMaterials: 100 });
    const [info] = buildRowInfos({ items: [lsr], lines: new Map(section.lines.map((line) => [line.itemId, line])), index: INDEX });
    expect(info?.projectMaterials).toBeUndefined();
  });

  it("строка без нормы подсказок не имеет", () => {
    const [info] = buildRowInfos({ items: [item], lines: new Map(), index: INDEX });
    expect(info?.projectMaterials).toBeUndefined();
  });
});

describe("материал по проекту: расчёт", () => {
  it("без правки стоимость материала не учтена и пробел назван", () => {
    const { section, gaps } = calc();
    expect(gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("24.3.03.05"))).toBe(true);
    expect(section.lines[0]?.resources.some((resource) => resource.code === "24.3.03.05")).toBe(false);
  });

  it("с названными количеством и ценой материал входит своей ценой, пробел по нему снят, соседний остаётся", () => {
    const base = calc();
    const withMaterial = calc(drainage({ projectMaterials: [{ code: "24.3.03.05", name: "Муфта", unit: "шт", quantity: 10, unitPrice: 150 }] }));
    const line = withMaterial.section.lines[0];
    const material = line?.resources.find((resource) => resource.code === "24.3.03.05");

    expect(material).toMatchObject({ source: "OWN_PRICE", kind: "MATERIAL", quantity: 10, unitPrice: 150, total: 1500 });
    expect((line?.directCost ?? 0) - (base.section.lines[0]?.directCost ?? 0)).toBeCloseTo(1500, 2);
    expect(withMaterial.section.lines[0]?.materialCost).toBeCloseTo((base.section.lines[0]?.materialCost ?? 0) + 1500, 2);
    expect(withMaterial.gaps.some((gap) => gap.message.includes("24.3.03.05"))).toBe(false);
    expect(withMaterial.gaps.some((gap) => gap.message.includes("24.3.03.06"))).toBe(true);
  });

  it("надёжность считает материалы по проекту без количества и цены", () => {
    const document = buildEstimate({
      title: "Тест",
      sections: [makeBillSection("Дренаж", [drainage()])],
      priceBook: PRICE_BOOK,
      parameters: PARAMETERS,
      resolveNorm: makeResolver([NORM_DRAINAGE_100]),
      sources: [],
      generatedAt: "2026-10-09T00:00:00.000Z",
      disclaimer: "тест",
    });
    expect(computeAssurance(document).projectMaterialGaps).toBeGreaterThanOrEqual(2);
  });
});

describe("материал по проекту: правка ведомости", () => {
  const item = drainage();
  const section = makeBillSection("Дренаж", [item]);
  const edit = (patch: Partial<Extract<BillEdit, { kind: "material" }>> = {}): BillEdit => ({
    kind: "material",
    anchor: anchorOf(item),
    code: "24.3.03.05",
    name: "Муфта",
    unit: "шт",
    quantity: 10,
    unitPrice: 150,
    ...patch,
  });

  it("форма правки проходит схему; нулевая цена — нет", () => {
    expect(billEditSchema.safeParse(edit()).success).toBe(true);
    expect(billEditSchema.safeParse(edit({ unitPrice: 0 })).success).toBe(false);
  });

  it("правка кладёт материал в позицию", () => {
    const applied = applyBillEdits([section], [edit()]);
    const result = applied.sections[0]?.items[0];
    expect(result?.projectMaterials).toEqual([{ code: "24.3.03.05", name: "Муфта", unit: "шт", quantity: 10, unitPrice: 150 }]);
    expect(applied.edited.has("drain")).toBe(true);
    expect(applied.unmatched).toEqual([]);
  });

  it("повторная правка того же материала заменяет прежнюю, другого — дополняет; убирается по шифру", () => {
    let edits = recordEdit([], edit());
    edits = recordEdit(edits, edit({ quantity: 12 }));
    edits = recordEdit(edits, edit({ code: "24.3.03.06", name: "Труба" }));
    expect(edits).toHaveLength(2);
    expect(applyBillEdits([section], edits).sections[0]?.items[0]?.projectMaterials).toHaveLength(2);

    const cleared = clearEdit(edits, "drain", "material", "24.3.03.05");
    expect(cleared).toHaveLength(1);
    expect(clearEdit(edits, "drain", "material")).toHaveLength(0);
  });

  it("правка описывается словами", () => {
    const marks = describeBillEdits({ baseSections: [section], edits: [edit()] });
    expect(marks[0]?.notes[0]).toContain("материал по проекту «Муфта»");
    expect(marks[0]?.kinds).toEqual(["material"]);
  });
});
