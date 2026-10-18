import { describe, expect, it } from "vitest";

import { computeEstimateLine } from "@/domain/estimate/calculate";
import {
  BITUMEN_NORM,
  BITUMEN_RESOURCE,
  bitumenItem,
  PROFILED_NORM,
  PROFILED_RESOURCE,
  profiledItem,
  ROOF,
  ROOF_PRICES,
  roofBook,
  roofPriceBook,
  roofResources,
} from "@/domain/estimate/normMaterial.roof.fixtures";
import type { NormPicker, RawNormPick } from "@/domain/estimate/normPick";
import type { BillOfWorkItem, BillOfWorkSection, NormRecord } from "@/domain/estimate/types";
import { withNormMaterials, type NormMaterialStageOptions } from "@/services/estimateNormMaterial";
import { makeParameters } from "@/test/estimateFixtures";

/**
 * Случай кровли (закупка 0391300028226000005) целиком: две позиции в одном разделе, модель подменена. Дорогое покрытие (профилированный стальной лист) обязано оказаться
 * на позиции профилированного листа, а не на битумных листах, и наоборот; ошибка модели — пробел «проверьте», а не чужие деньги.
 */

const KEY = (code: string) => `РЕСУРС|${code}`;
const section = (items: readonly BillOfWorkItem[]): BillOfWorkSection => ({ title: "Кровля", items });

/** Норма на битумные листы с ресурсом из общей группы 12.1.02 (в ней и битумные, и стальные листы). */
const BITUMEN_NORM_SHARED: NormRecord = { ...BITUMEN_NORM, resources: BITUMEN_NORM.resources.map((resource) => (resource === BITUMEN_RESOURCE ? { ...resource, code: "12.1.02" } : resource)) };
const PROFILED_NORM_SHARED: NormRecord = { ...PROFILED_NORM, resources: PROFILED_NORM.resources.map((resource) => (resource === PROFILED_RESOURCE ? { ...resource, code: "12.1.02" } : resource)) };

function normsOf(...norms: readonly NormRecord[]) {
  return (item: BillOfWorkItem): NormRecord | null => norms.find((norm) => norm.code === item.normCode) ?? null;
}

/** Модель отвечает по позиции: id запроса → ответ. Позиции — по наименованию работы. */
function answering(byWork: (workName: string) => Partial<RawNormPick> | null, seen?: Parameters<NormPicker>[0][]): NormPicker {
  return async (batch) => {
    seen?.push(batch);
    return {
      picks: batch.items.flatMap((item) => {
        const choice = byWork(item.workName);
        return choice === null ? [] : [{ id: item.id, pick: null, demolition: false, confidence: "high" as const, reason: "подходит по виду покрытия", ...choice }];
      }),
      tokens: 700,
      malformed: 0,
    };
  };
}

const CORRECT = answering((work) => (work.includes("битумных") ? { pick: KEY(ROOF.bitumenOndulin) } : { pick: KEY(ROOF.steelHeavy) }));
/** Модель перепутала покрытия: стальной лист на битумные листы и битумный — на профилированный. */
const SWAPPED = answering((work) => (work.includes("битумных") ? { pick: KEY(ROOF.steelHeavy) } : { pick: KEY(ROOF.bitumenOndulin) }));

function options(over: Partial<NormMaterialStageOptions> = {}): NormMaterialStageOptions {
  return {
    picker: CORRECT,
    context: { regNumber: "0391300028226000005", subject: "Капитальный ремонт кровли" },
    resources: roofBook(),
    normOf: normsOf(BITUMEN_NORM, PROFILED_NORM),
    ...over,
  };
}

const run = (over: Partial<NormMaterialStageOptions> = {}, items: readonly BillOfWorkItem[] = [bitumenItem(), profiledItem()]) => withNormMaterials([section(items)], options(over));
const itemOf = (result: Awaited<ReturnType<typeof run>>, id: string): BillOfWorkItem => {
  const found = result.sections.flatMap((entry) => entry.items).find((item) => item.id === id);
  if (found === undefined) throw new Error(`нет позиции ${id}`);
  return found;
};

function calculate(item: BillOfWorkItem, norm: NormRecord, resources = roofResources()) {
  const computed = computeEstimateLine(item, { norm, reasons: [] }, roofPriceBook(resources), makeParameters());
  if (computed.line === null) throw new Error("строка не посчитана");
  return computed;
}

describe("кровля: материалы встают на свои позиции", () => {
  it("модели уходят группы своих норм: битумным листам — битумные, профилированному — стальные", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    await run({ picker: answering(() => ({ pick: null }), batches) });
    const requests = batches.flatMap((batch) => batch.items);
    const bitumen = requests.find((request) => request.workName.includes("битумных"));
    const profiled = requests.find((request) => request.workName.includes("профилированного"));
    expect(bitumen?.resources?.map((resource) => resource.code).sort()).toEqual([ROOF.bitumenOndulin, ROOF.bitumenPlain, ROOF.bitumenPainted].sort());
    expect(profiled?.resources?.map((resource) => resource.code).sort()).toEqual([ROOF.steelLight, ROOF.steelHeavy].sort());
  });

  it("верные ответы: стальной лист стоит на профилированной позиции, битумный — на битумной; деньги не меняются местами", async () => {
    const result = await run();
    expect(result.stats).toMatchObject({ requested: 2, picked: 2, rejected: 0, declined: 0 });

    const bitumen = itemOf(result, "bitumen");
    const profiled = itemOf(result, "profiled");
    expect(bitumen.aiNormMaterials?.[0]).toMatchObject({ normResourceCode: "12.1.02.06", code: ROOF.bitumenOndulin, review: false });
    expect(profiled.aiNormMaterials?.[0]).toMatchObject({ normResourceCode: "12.1.02.03", code: ROOF.steelHeavy, review: false });

    // 480 м2 при норме на 100 м2 и расходе 105 м2 — 504 м2; 900 м2 при расходе 112 — 1008 м2.
    const bitumenCost = calculate(bitumen, BITUMEN_NORM).line.materialCost;
    const profiledCost = calculate(profiled, PROFILED_NORM).line.materialCost;
    expect(bitumenCost).toBeCloseTo(504 * ROOF_PRICES.bitumenOndulin, 2);
    expect(profiledCost).toBeCloseTo(1008 * ROOF_PRICES.steelHeavy, 2);
    expect(profiledCost).toBeGreaterThan(bitumenCost);
  });

  it("модель перепутала покрытия: вне группы — отклонено (вне списка кандидатов), у обеих позиций пробел «проверьте», чужих материалов нет", async () => {
    const result = await run({ picker: SWAPPED });
    expect(result.stats).toMatchObject({ requested: 2, picked: 0, rejected: 2 });
    expect(result.stats.notes.join(" ")).toContain("вне списка кандидатов");
    for (const [id, norm] of [["bitumen", BITUMEN_NORM], ["profiled", PROFILED_NORM]] as const) {
      const item = itemOf(result, id);
      expect(item.aiNormMaterials).toBeUndefined();
      const { line, gaps } = calculate(item, norm);
      expect(gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE")).toBe(true);
      expect(line.materialCost).toBe(0);
    }
  });
});

describe("кровля: общая группа, где рядом битумные и стальные листы", () => {
  const shared = { normOf: normsOf(BITUMEN_NORM_SHARED, PROFILED_NORM_SHARED) };

  it("кандидаты обеих позиций смешаны, но выбор чужого рода отклоняется проверкой рода", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    const result = await run({ ...shared, picker: answering((work) => (work.includes("битумных") ? { pick: KEY(ROOF.steelHeavy) } : { pick: KEY(ROOF.bitumenPlain) }), batches) });
    const codes = batches.flatMap((batch) => batch.items).flatMap((request) => request.resources?.map((resource) => resource.code) ?? []);
    expect(codes).toEqual(expect.arrayContaining([ROOF.steelHeavy, ROOF.bitumenPlain]));
    expect(result.stats).toMatchObject({ picked: 0, rejected: 2 });
    expect(result.stats.notes.join(" ")).toContain("другого рода");
    expect(itemOf(result, "bitumen").aiNormMaterials).toBeUndefined();
    expect(itemOf(result, "profiled").aiNormMaterials).toBeUndefined();
  });

  it("верный выбор в общей группе принимается", async () => {
    const result = await run({ ...shared });
    expect(result.stats).toMatchObject({ picked: 2, rejected: 0 });
    expect(itemOf(result, "bitumen").aiNormMaterials?.[0]?.code).toBe(ROOF.bitumenOndulin);
    expect(itemOf(result, "profiled").aiNormMaterials?.[0]?.code).toBe(ROOF.steelHeavy);
  });
});

describe("кровля: цена-выброс и группа без записей", () => {
  it("запись-выброс в группе (9 000 ₽ при соседях 460–610) отклоняется; пробел остаётся", async () => {
    const result = await run({ resources: roofBook(roofResources({ premium: true })), picker: answering((work) => (work.includes("битумных") ? { pick: KEY(ROOF.bitumenPremium) } : null)) }, [bitumenItem()]);
    expect(result.stats).toMatchObject({ picked: 0, rejected: 1 });
    expect(result.stats.notes.join(" ")).toContain("медианы цен группы");
    expect(itemOf(result, "bitumen").aiNormMaterials).toBeUndefined();
  });

  it("у группы нет записей: кандидаты шире по словам, выбор принят, но всегда «проверьте» даже при высокой уверенности", async () => {
    const norm: NormRecord = { ...BITUMEN_NORM, resources: BITUMEN_NORM.resources.map((resource) => (resource === BITUMEN_RESOURCE ? { ...resource, code: "12.1.09.09" } : resource)) };
    const result = await run({ normOf: normsOf(norm), picker: answering(() => ({ pick: KEY(ROOF.bitumenPlain), confidence: "high" })) }, [bitumenItem()]);
    expect(result.stats).toMatchObject({ picked: 1, rejected: 0 });
    const picked = itemOf(result, "bitumen").aiNormMaterials?.[0];
    expect(picked).toMatchObject({ code: ROOF.bitumenPlain, pick: "AI", review: true, confidence: "high" });
    expect(picked?.note).toContain("нет записей в справочнике цен");
  });
});

describe("кровля: выбор без модели тоже в рамках группы", () => {
  it("без подборщика единственный кандидат группы с высоким покрытием слов берётся кодом и подсвечивается «проверьте»", async () => {
    const result = await run({ picker: undefined }, [bitumenItem()]);
    expect(result.stats).toMatchObject({ requested: 0, picked: 0, fallback: 1 });
    expect(itemOf(result, "bitumen").aiNormMaterials?.[0]).toMatchObject({ code: ROOF.bitumenPlain, pick: "NAME", review: true });
  });

  it("точное совпадение по словам вне группы не берётся: в группе только слабый кандидат — пробел остаётся", async () => {
    const price = (code: string, name: string, value: number) => ({ code, name, unit: "м2", price: value, machinistSalary: null, machinistHours: null, source: "CURRENT_ZONE" as const, period: null, zone: null });
    const book = roofBook([price("12.1.02.06-0001", "Ондулин кровельный", 520), price("12.1.07.01-0001", "Листы волнистые битумные кровельные", 470)]);
    const result = await run({ picker: undefined, resources: book }, [bitumenItem()]);
    expect(itemOf(result, "bitumen").aiNormMaterials).toBeUndefined();
    expect(result.stats.fallback).toBe(0);
  });
});
