import { describe, expect, it } from "vitest";

import {
  applyNormMaterial,
  checkNormMaterialPick,
  collectNormMaterialMatches,
  groupEntriesOf,
  inResourceGroup,
  normResourceOwnPrice,
  NORM_MATERIAL_MAX_PRICE_RATIO,
  resourceGroupOf,
  unitPriceInNormUnit,
  vetNormMaterial,
  type NormMaterialPickContext,
} from "@/domain/estimate/normMaterial";
import {
  BITUMEN_NORM,
  BITUMEN_RESOURCE,
  bitumenItem,
  PROFILED_NORM,
  PROFILED_RESOURCE,
  ROOF,
  roofBook,
  roofResources,
} from "@/domain/estimate/normMaterial.roof.fixtures";
import { createResourceIndex, resourceCandidateOf } from "@/domain/estimate/resourceCandidates";
import type { NormResource } from "@/domain/estimate/types";

/**
 * Случай кровли (закупка 0391300028226000005): материал битумных листов и материал профилированного листа не должны меняться местами.
 * Группа ресурса нормы ограничивает кандидатов и принятый выбор; род по словам названия и здравость цены — отдельные проверки.
 */

const index = createResourceIndex(roofBook());
const premiumIndex = createResourceIndex(roofBook(roofResources({ premium: true })));

const search = (resource: NormResource, workName: string, normName: string, over: Partial<Parameters<typeof collectNormMaterialMatches>[1]> = {}, target = index) =>
  collectNormMaterialMatches(target, { resourceCode: resource.code, resourceName: resource.name, unit: resource.unit, workName, normName, ...over });

const codesOf = (matches: readonly { readonly entry: { readonly code: string } }[]) => matches.map((match) => match.entry.code).sort();

const BITUMEN_CONTEXT: NormMaterialPickContext = {
  resourceCode: BITUMEN_RESOURCE.code,
  resourceName: BITUMEN_RESOURCE.name,
  workName: bitumenItem().workName,
  normName: BITUMEN_NORM.fullName,
};

describe("группа ресурса нормы", () => {
  it("код группы распознаётся; запись справочника лежит в группе по префиксу с дефисом или точкой", () => {
    expect(resourceGroupOf("12.1.02.06")).toBe("12.1.02.06");
    expect(resourceGroupOf("999-9901")).toBeNull();
    expect(resourceGroupOf("12.1.02.06-0001")).toBeNull();
    expect(inResourceGroup("12.1.02.06-0001", "12.1.02.06")).toBe(true);
    expect(inResourceGroup("12.1.02.06-0001", "12.1.02.0")).toBe(false);
    expect(inResourceGroup("12.1.02.0610-0001", "12.1.02.06")).toBe(false);
    // Группа короче: подгруппы входят.
    expect(inResourceGroup("12.1.02.06-0001", "12.1.02")).toBe(true);
  });

  it("записи группы берутся из справочника независимо от единицы", () => {
    expect(codesOf(groupEntriesOf(index, "12.1.02.06").map((entry) => ({ entry })))).toEqual([ROOF.bitumenOndulin, ROOF.bitumenPlain, ROOF.bitumenPainted].sort());
    expect(groupEntriesOf(index, "12.1.09.09")).toEqual([]);
    expect(groupEntriesOf(index, "999-9901")).toEqual([]);
  });
});

describe("кандидаты: норма битумных листов и норма профилированного листа", () => {
  it("битумная норма: только группа 12.1.02.06; профилированные листы, асбестоцемент и болты не предлагаются", () => {
    const found = search(BITUMEN_RESOURCE, bitumenItem().workName, BITUMEN_NORM.fullName);
    expect(found.scope).toBe("GROUP");
    expect(codesOf(found.matches)).toEqual([ROOF.bitumenOndulin, ROOF.bitumenPlain, ROOF.bitumenPainted].sort());
    expect(found.byResourceName.every((match) => match.entry.code.startsWith("12.1.02.06-"))).toBe(true);
  });

  it("профилированная норма: только группа 12.1.02.03; битумные листы не предлагаются", () => {
    const found = search(PROFILED_RESOURCE, "Монтаж кровли из профилированного листа", PROFILED_NORM.fullName);
    expect(found.scope).toBe("GROUP");
    expect(codesOf(found.matches)).toEqual([ROOF.steelLight, ROOF.steelHeavy].sort());
  });

  it("у группы есть записи, но ни одна не подходит по единице, — кандидатов нет: шире группы не ищем", () => {
    const found = search(BITUMEN_RESOURCE, bitumenItem().workName, BITUMEN_NORM.fullName, { unit: "кг" });
    expect(found.scope).toBe("GROUP");
    expect(found.matches).toEqual([]);
  });

  it("у группы записей нет: кандидаты шире по словам, область WIDE", () => {
    const found = search({ ...BITUMEN_RESOURCE, code: "12.1.09.09" }, bitumenItem().workName, BITUMEN_NORM.fullName, { resourceCode: "12.1.09.09" });
    expect(found.scope).toBe("WIDE");
    expect(codesOf(found.matches)).toEqual(expect.arrayContaining([ROOF.bitumenOndulin, ROOF.bitumenPlain]));
  });

  it("код ресурса — не группа: область WIDE", () => {
    expect(search(BITUMEN_RESOURCE, bitumenItem().workName, BITUMEN_NORM.fullName, { resourceCode: "999-8801" }).scope).toBe("WIDE");
  });
});

describe("принятый выбор: группа", () => {
  const candidatesOf = (codes: readonly string[]) => codes.map((code) => ({ key: `РЕСУРС|${code}` }));

  it("материал своей группы принимается", () => {
    const check = checkNormMaterialPick(`РЕСУРС|${ROOF.bitumenOndulin}`, candidatesOf([ROOF.bitumenOndulin]), index, "м2", BITUMEN_CONTEXT);
    expect(check).toMatchObject({ status: "ACCEPTED", widened: false });
  });

  it("материал чужой группы отклоняется, даже если он попал в список кандидатов", () => {
    const check = checkNormMaterialPick(`РЕСУРС|${ROOF.steelHeavy}`, candidatesOf([ROOF.steelHeavy]), index, "м2", BITUMEN_CONTEXT);
    expect(check).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("вне группы 12.1.02.06") });
  });

  it("материал, названный не из списка кандидатов, отклоняется прежней проверкой", () => {
    const check = checkNormMaterialPick(`РЕСУРС|${ROOF.steelHeavy}`, candidatesOf([ROOF.bitumenOndulin]), index, "м2", BITUMEN_CONTEXT);
    expect(check).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("вне списка кандидатов") });
  });

  it("у группы нет записей: выбор принимается, но widened — «проверьте»", () => {
    const wide: NormMaterialPickContext = { ...BITUMEN_CONTEXT, resourceCode: "12.1.09.09" };
    const check = checkNormMaterialPick(`РЕСУРС|${ROOF.bitumenOndulin}`, candidatesOf([ROOF.bitumenOndulin]), index, "м2", wide);
    expect(check).toMatchObject({ status: "ACCEPTED", widened: true });
    if (check.status !== "ACCEPTED") return;
    const applied = applyNormMaterial(bitumenItem(), BITUMEN_NORM, BITUMEN_RESOURCE, check.entry, { source: "AI", reason: "битумный волнистый лист", confidence: "high", coverage: null, widened: check.widened });
    expect(applied.aiNormMaterials?.[0]).toMatchObject({ review: true, pick: "AI", confidence: "high", reason: "битумный волнистый лист", normResourceName: "Листы волнистые битумные" });
    expect(applied.aiNormMaterials?.[0]?.note).toContain("нет записей в справочнике цен");
  });

  it("у группы есть записи и выбор в ней при уверенной модели — без «проверьте»", () => {
    const entry = index.byCode.get(ROOF.bitumenOndulin);
    if (entry === undefined) throw new Error("нет ресурса");
    const applied = applyNormMaterial(bitumenItem(), BITUMEN_NORM, BITUMEN_RESOURCE, entry, { source: "AI", reason: "ок", confidence: "high", coverage: null, widened: false });
    expect(applied.aiNormMaterials?.[0]?.review).toBe(false);
  });
});

describe("принятый выбор: род материала", () => {
  /** Родитель обеих групп: 12.1.02 — в нём и битумные листы, и профилированные стальные. */
  const bitumenParent: NormMaterialPickContext = { ...BITUMEN_CONTEXT, resourceCode: "12.1.02" };
  const profiledParent: NormMaterialPickContext = { resourceCode: "12.1.02", resourceName: PROFILED_RESOURCE.name, workName: "Монтаж кровли из профилированного листа", normName: PROFILED_NORM.fullName };
  const candidates = [ROOF.bitumenOndulin, ROOF.bitumenPlain, ROOF.steelLight, ROOF.steelHeavy].map((code) => ({ key: `РЕСУРС|${code}` }));

  it("общая группа предлагает оба рода кандидатов", () => {
    const found = search(BITUMEN_RESOURCE, bitumenItem().workName, BITUMEN_NORM.fullName, { resourceCode: "12.1.02" });
    expect(found.scope).toBe("GROUP");
    expect(codesOf(found.matches)).toEqual(expect.arrayContaining([ROOF.bitumenOndulin, ROOF.steelHeavy]));
  });

  it("норма битумных листов: стальной профилированный лист отклоняется, битумный принимается", () => {
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.steelHeavy}`, candidates, index, "м2", bitumenParent)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("другого рода") });
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.steelLight}`, candidates, index, "м2", bitumenParent)).toMatchObject({ status: "REJECTED" });
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.bitumenPlain}`, candidates, index, "м2", bitumenParent)).toMatchObject({ status: "ACCEPTED" });
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.bitumenOndulin}`, candidates, index, "м2", bitumenParent)).toMatchObject({ status: "ACCEPTED" });
  });

  it("норма профилированного листа: битумный лист отклоняется, стальной принимается", () => {
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.bitumenPlain}`, candidates, index, "м2", profiledParent)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("другого рода") });
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.bitumenOndulin}`, candidates, index, "м2", profiledParent)).toMatchObject({ status: "REJECTED" });
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.steelHeavy}`, candidates, index, "м2", profiledParent)).toMatchObject({ status: "ACCEPTED" });
  });

  it("название ресурса нормы общее («Материалы кровельные»): род берётся из названия работы", () => {
    const generic: NormMaterialPickContext = { ...bitumenParent, resourceName: "Материалы кровельные" };
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.steelHeavy}`, candidates, index, "м2", generic)).toMatchObject({ status: "REJECTED" });
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.bitumenPlain}`, candidates, index, "м2", generic)).toMatchObject({ status: "ACCEPTED" });
  });
});

describe("принятый выбор: здравость цены", () => {
  const bitumenGroup = [ROOF.bitumenOndulin, ROOF.bitumenPlain, ROOF.bitumenPainted, ROOF.bitumenPremium].map((code) => ({ key: `РЕСУРС|${code}` }));

  it("цена дороже 5 медиан группы отклоняется; обычные записи группы принимаются", () => {
    // Группа: 460, 520, 610, 9000 — медиана 565, порог 2825.
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.bitumenPremium}`, bitumenGroup, premiumIndex, "м2", BITUMEN_CONTEXT)).toMatchObject({
      status: "REJECTED",
      reason: expect.stringContaining("медианы цен группы 12.1.02.06"),
    });
    for (const code of [ROOF.bitumenOndulin, ROOF.bitumenPlain, ROOF.bitumenPainted]) {
      expect(checkNormMaterialPick(`РЕСУРС|${code}`, bitumenGroup, premiumIndex, "м2", BITUMEN_CONTEXT)).toMatchObject({ status: "ACCEPTED" });
    }
  });

  it("цена ровно в 5 медиан не отклоняется (строго больше)", () => {
    const entry = { ...(index.byCode.get(ROOF.bitumenPlain) as NonNullable<ReturnType<typeof index.byCode.get>>), price: 520 * NORM_MATERIAL_MAX_PRICE_RATIO };
    // Медиана группы 520 (460, 520, 610): 2600 = 5 × 520.
    expect(vetNormMaterial(entry, index, "м2", BITUMEN_CONTEXT)).toMatchObject({ ok: true });
    expect(vetNormMaterial({ ...entry, price: 2601 }, index, "м2", BITUMEN_CONTEXT)).toMatchObject({ ok: false });
  });

  it("цена приводится к единице ресурса нормы: запись «за тонну» рядом с записями «за кг» не выглядит выбросом", () => {
    expect(unitPriceInNormUnit({ price: 1_650_000, unit: "т" }, "кг")).toBe(1650);
    expect(unitPriceInNormUnit({ price: 250_000, unit: "100 м2" }, "м2")).toBe(2500);
    expect(unitPriceInNormUnit({ price: 10, unit: "м3" }, "м2")).toBeNull();
  });

  it("собственная цена ресурса нормы в книге: дороже в 5 раз отклоняется", () => {
    const withOwn: NormMaterialPickContext = { ...BITUMEN_CONTEXT, ownPrice: 100 };
    // 520 / 100 = 5,2 > 5; 460 / 100 = 4,6.
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.bitumenOndulin}`, bitumenGroup, premiumIndex, "м2", withOwn)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("собственной цены ресурса нормы") });
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.bitumenPlain}`, bitumenGroup, premiumIndex, "м2", withOwn)).toMatchObject({ status: "ACCEPTED" });
  });

  it("собственная цена ресурса нормы берётся из книги: база, иначе текущая; единица приводится к единице ресурса", () => {
    const resource = { code: "12.1.02.06-0002", unit: "м2" };
    const price = (value: number, unit: string, source: "CURRENT_ZONE" | "BASE_2022") => ({ code: resource.code, name: "x", unit, price: value, machinistSalary: null, machinistHours: null, source, period: null, zone: null });
    const current = price(460, "м2", "CURRENT_ZONE");
    const base = price(300, "м2", "BASE_2022");
    expect(normResourceOwnPrice({ current: new Map([[resource.code, current]]), base: new Map([[resource.code, base]]) }, resource)).toBe(300);
    expect(normResourceOwnPrice({ current: new Map([[resource.code, current]]), base: new Map() }, resource)).toBe(460);
    expect(normResourceOwnPrice({ current: new Map(), base: new Map() }, resource)).toBeNull();
    expect(normResourceOwnPrice({ current: new Map(), base: new Map([[resource.code, price(30_000, "100 м2", "BASE_2022")]]) }, resource)).toBe(300);
    expect(normResourceOwnPrice({ current: new Map(), base: new Map([[resource.code, price(5, "кг", "BASE_2022")]]) }, resource)).toBeNull();
  });

  it("группы нет — род проверяется всё равно: стальной лист в широком списке отклоняется для битумной нормы", () => {
    const wide: NormMaterialPickContext = { ...BITUMEN_CONTEXT, resourceCode: "12.1.09.09" };
    const candidates = [ROOF.bitumenPlain, ROOF.steelHeavy].map((code) => ({ key: `РЕСУРС|${code}` }));
    expect(checkNormMaterialPick(`РЕСУРС|${ROOF.steelHeavy}`, candidates, index, "м2", wide)).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("другого рода") });
  });

  it("группы нет — медиана по кандидатам запроса; запись без цены в запросе не мешает", () => {
    const wide: NormMaterialPickContext = { ...BITUMEN_CONTEXT, resourceCode: "12.1.09.09" };
    const premium = resourceCandidateOf(premiumIndex.byCode.get(ROOF.bitumenPremium) as NonNullable<ReturnType<typeof index.byCode.get>>);
    const peers = [ROOF.bitumenOndulin, ROOF.bitumenPlain, ROOF.bitumenPainted].map((code) => resourceCandidateOf(premiumIndex.byCode.get(code) as NonNullable<ReturnType<typeof index.byCode.get>>));
    const check = checkNormMaterialPick(premium.key, [...peers, premium, { key: "РЕСУРС|без-цены" }], premiumIndex, "м2", wide);
    expect(check).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("кандидатов") });
  });
});
