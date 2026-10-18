import { describe, expect, it } from "vitest";

import { computeEstimateLine } from "@/domain/estimate/calculate";
import { PPU, PPU_NORM, PPU_TRUTH_PRICE, ppuBook, ppuPriceBook, ppuResources, roofItem } from "@/domain/estimate/normMaterial.fixtures";
import { NO_NORM_PICKER, type NormPicker, type RawNormPick } from "@/domain/estimate/normPick";
import type { BillOfWorkItem, BillOfWorkSection, NormRecord } from "@/domain/estimate/types";
import { makeParameters } from "@/test/estimateFixtures";
import { withNormMaterials, type NormMaterialStageOptions } from "@/services/estimateNormMaterial";

/**
 * Материал нормы «по проекту» для ведомости без сметы заказчика: пара «позиция + ресурс нормы без марки» → кандидаты справочника → выбор модели → проверка →
 * материал в позиции → цена в строке сметы. Модель подменена; справочник и норма синтетические (`normMaterial.fixtures.ts`).
 */

const KEY = (code: string) => `РЕСУРС|${code}`;

const section = (items: readonly BillOfWorkItem[]): BillOfWorkSection => ({ title: "Кровля", items });
const normOf = (item: BillOfWorkItem): NormRecord | null => (item.normCode === PPU_NORM.code ? PPU_NORM : null);

function picker(choose: (item: { id: string; kind?: string; resources?: readonly { code: string }[] }) => Partial<RawNormPick> | null, seen?: Parameters<NormPicker>[0][]): NormPicker {
  return async (batch) => {
    seen?.push(batch);
    return {
      picks: batch.items.flatMap((item) => {
        const choice = choose(item);
        return choice === null ? [] : [{ id: item.id, pick: null, demolition: false, confidence: "high" as const, reason: "полиуретановая смола для напыления, как в работе", ...choice }];
      }),
      tokens: 500,
      malformed: 0,
    };
  };
}

const truthful = picker(() => ({ pick: KEY(PPU.truth) }));

function options(over: Partial<NormMaterialStageOptions> = {}): NormMaterialStageOptions {
  return {
    picker: truthful,
    context: { regNumber: "32616409061", subject: "Капитальный ремонт кровли" },
    resources: ppuBook(),
    normOf,
    ...over,
  };
}

const run = (items: readonly BillOfWorkItem[], over: Partial<NormMaterialStageOptions> = {}) => withNormMaterials([section(items)], options(over));
const itemOf = (result: Awaited<ReturnType<typeof run>>, id = "roof"): BillOfWorkItem => {
  const found = result.sections.flatMap((entry) => entry.items).find((item) => item.id === id);
  if (found === undefined) throw new Error(`нет позиции ${id}`);
  return found;
};

function calculate(item: BillOfWorkItem) {
  const computed = computeEstimateLine(item, { norm: PPU_NORM, reasons: [] }, ppuPriceBook(), makeParameters());
  if (computed.line === null) throw new Error("строка не посчитана");
  return computed;
}

describe("материал нормы «по проекту»: запрос к модели", () => {
  it("модели уходит одна пара: ресурс без марки с числовым расходом; «по проекту» без числа и служебный «МАТЕРИАЛЫ» — не уходят", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    await run([roofItem()], { picker: picker(() => ({ pick: null }), batches) });
    const sent = batches.flatMap((batch) => batch.items);

    expect(sent).toHaveLength(1);
    const request = sent[0];
    expect(request).toMatchObject({ kind: "norm_material", workName: "Изоляция кровли напыляемым пенополиуретаном толщиной 50 мм", quantity: 182, unit: "м2" });
    expect(request?.candidates).toEqual([]);
    expect(request?.normResource).toMatchObject({ code: "14.2.05.03", name: "Состав двухкомпонентный на основе полиуретановых смол", unit: "кг", quantity: 165, total: 300.3 });
    expect(request?.normResource?.norm).toContain("ГЭСН 26-01-021-01");
  });

  it("кандидаты: настоящий материал и двойники одной группы с переводимой единицей; панель в м2 не предлагается", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    await run([roofItem()], { picker: picker(() => ({ pick: null }), batches) });
    const codes = batches.flatMap((batch) => batch.items).flatMap((item) => item.resources?.map((resource) => resource.code) ?? []);
    expect(codes).toEqual(expect.arrayContaining([PPU.truth, PPU.epoxy, PPU.perTonne]));
    // Группа названа нормой — её записи идут первыми.
    expect(codes.slice(0, 3).sort()).toEqual([PPU.truth, PPU.epoxy, PPU.perTonne].sort());
    expect(codes).not.toContain(PPU.panel);
    expect(codes).not.toContain(PPU.bolts);
    expect(codes.length).toBeLessThanOrEqual(15);
  });

  it("id пары внутри пачки короткие, пачки не больше десяти", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    const items = Array.from({ length: 12 }, (_, index) => roofItem({ id: `roof-${String(index)}`, positionNumber: String(index + 1) }));
    await run(items, { picker: picker(() => ({ pick: null }), batches) });
    expect(batches.map((batch) => batch.items.length)).toEqual([10, 2]);
    expect(batches[0]?.items.map((item) => item.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  });
});

describe("материал нормы «по проекту»: принятый выбор", () => {
  it("пример 32616409061: состав на 300,3 кг по текущей цене зоны попадает в строку; пробела «без марки» нет, есть пометка", async () => {
    const result = await run([roofItem()]);
    const item = itemOf(result);
    expect(item.aiNormMaterials).toHaveLength(1);
    expect(item.aiNormMaterials?.[0]).toMatchObject({ normCode: "26-01-021-01", normBaseType: "ГЭСН", normResourceCode: "14.2.05.03", code: PPU.truth, unit: "кг", pick: "AI", review: false });
    expect(item.aiNormMaterials?.[0]?.note).toContain("материал подобран ИИ: полиуретановая смола для напыления");
    expect(result.stats).toMatchObject({ requested: 1, picked: 1, declined: 0, rejected: 0, fallback: 0, batches: 1, failedBatches: 0, tokens: 500 });

    const { line, gaps } = calculate(item);
    const material = line.resources.find((resource) => resource.code === PPU.truth);
    expect(material).toMatchObject({ kind: "MATERIAL", unit: "кг", unitPrice: PPU_TRUTH_PRICE, source: "CURRENT_ZONE" });
    expect(material?.quantity).toBeCloseTo(300.3, 6);
    expect(material?.total).toBeCloseTo(PPU_TRUTH_PRICE * 300.3, 2);
    expect(material?.note).toContain("материал подобран ИИ");
    expect(line.materialCost).toBeCloseTo(PPU_TRUTH_PRICE * 300.3, 2);
    expect(line.directCost).toBeCloseTo(line.labourCost + PPU_TRUTH_PRICE * 300.3, 2);

    // Пробел по этому ресурсу заменён информационной пометкой.
    expect(gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("14.2.05.03"))).toBe(false);
    const note = gaps.find((gap) => gap.kind === "AI_MATERIAL_PICK");
    expect(note?.message).toContain(PPU.truth);
    expect(note?.message).toContain("проверьте");
    expect(line.gaps.filter((gap) => gap.kind === "AI_MATERIAL_PICK")).toHaveLength(1);
  });

  it("расход «по проекту» без числа (и служебный «МАТЕРИАЛЫ») остаётся пробелом: количество не придумывается", async () => {
    const result = await run([roofItem()]);
    const { line, gaps } = calculate(itemOf(result));
    expect(gaps.filter((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE").map((gap) => gap.message).join("\n")).toContain("14.4.02.09");
    expect(gaps.filter((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE").map((gap) => gap.message).join("\n")).toContain("999-9901");
    expect(line.resources.some((resource) => resource.code === PPU.paint)).toBe(false);
    expect(line.resources.filter((resource) => resource.kind === "MATERIAL")).toHaveLength(1);
  });

  it("ресурс нормы с расходом «П» (не abstract) — пробел QUANTITY_BY_PROJECT, модель про него не спрашивалась", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    const norm: NormRecord = { ...PPU_NORM, resources: [...PPU_NORM.resources.filter((resource) => resource.kind === "LABOUR"), { code: "14.4.02.19-0001", kind: "MATERIAL", name: "Краска", quantity: 0, unit: "кг", quantityNote: "П", projectSpecific: false, technologyGroup: null }] };
    const result = await run([roofItem()], { normOf: () => norm, picker: picker(() => ({ pick: null }), batches) });
    expect(batches).toEqual([]);
    expect(result.stats.requested).toBe(0);
    const computed = computeEstimateLine(roofItem(), { norm, reasons: [] }, ppuPriceBook(), makeParameters());
    expect(computed.gaps.map((gap) => gap.kind)).toContain("QUANTITY_BY_PROJECT");
  });

  it("позиции без подобранного материала возвращаются теми же объектами", async () => {
    const other = roofItem({ id: "other", normCode: null, normBaseType: null });
    const input = [roofItem(), other];
    const result = await run(input);
    expect(itemOf(result, "other")).toBe(other);
    expect(itemOf(result)).not.toBe(input[0]);
  });
});

describe("материал нормы «по проекту»: проверка ответа модели", () => {
  it("«нет подходящего» — пробел остаётся, счётчик declined", async () => {
    const result = await run([roofItem()], { picker: picker(() => ({ pick: null, reason: "нет данных о плотности" })) });
    expect(itemOf(result).aiNormMaterials).toBeUndefined();
    expect(result.stats).toMatchObject({ requested: 1, picked: 0, declined: 1, rejected: 0 });
    const { gaps } = calculate(itemOf(result));
    expect(gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("14.2.05.03"))).toBe(true);
  });

  it("шифр вне кандидатов (панель в м2, сочинённый код) отклоняется; единица не сходится — отклоняется", async () => {
    for (const pick of [KEY(PPU.panel), KEY("14.2.05.03-9999"), KEY(PPU.bolts)]) {
      const result = await run([roofItem()], { picker: picker(() => ({ pick })) });
      expect(itemOf(result).aiNormMaterials).toBeUndefined();
      expect(result.stats).toMatchObject({ picked: 0, rejected: 1 });
      expect(result.stats.notes.join(" ")).toContain("вне списка кандидатов");
    }
  });

  it("норма вместо ресурса не принимается", async () => {
    const result = await run([roofItem()], { picker: picker(() => ({ pick: "ГЭСН|26-01-021-01" })) });
    expect(itemOf(result).aiNormMaterials).toBeUndefined();
    expect(result.stats).toMatchObject({ rejected: 1, picked: 0 });
  });

  it("материал с единицей «т» принимается и пересчитывается: расход 300,3 кг = 0,3003 т по цене за тонну", async () => {
    const result = await run([roofItem()], { picker: picker(() => ({ pick: KEY(PPU.perTonne) })) });
    expect(itemOf(result).aiNormMaterials?.[0]).toMatchObject({ code: PPU.perTonne, unit: "т" });
    const { line } = calculate(itemOf(result));
    const material = line.resources.find((resource) => resource.code === PPU.perTonne);
    expect(material?.unit).toBe("т");
    expect(material?.quantity).toBeCloseTo(0.3003, 6);
    expect(material?.total).toBeCloseTo(0.3003 * 1_650_000, 2);
  });

  it("модель не назвала уверенность или назвала «low» — выбор принят и подсвечен «проверьте»", async () => {
    for (const confidence of [null, "low" as const]) {
      const result = await run([roofItem()], { picker: picker(() => ({ pick: KEY(PPU.truth), confidence })) });
      expect(itemOf(result).aiNormMaterials?.[0]?.review).toBe(true);
    }
  });
});

describe("материал нормы «по проекту»: сбой модели и работа без модели", () => {
  it("пачка не получена: единственный кандидат с высоким покрытием слов выбран кодом без модели и подсвечен «проверьте»", async () => {
    const failing: NormPicker = async () => {
      throw new Error("шлюз недоступен");
    };
    const result = await run([roofItem()], { picker: failing, resources: ppuBook(ppuResources({ perTonne: false })) });
    expect(result.stats).toMatchObject({ requested: 1, picked: 0, fallback: 1, failedBatches: 1, batches: 1 });
    expect(result.stats.notes.join(" ")).toContain("шлюз недоступен");
    const picked = itemOf(result).aiNormMaterials?.[0];
    expect(picked).toMatchObject({ code: PPU.truth, pick: "NAME", review: true });
    expect(picked?.note).toContain("проверьте");
    expect(calculate(itemOf(result)).line.materialCost).toBeCloseTo(PPU_TRUTH_PRICE * 300.3, 2);
  });

  it("без подборщика — тот же запасной выбор; двойник «за тонну» с теми же словами делает выбор неоднозначным, и остаётся пробел", async () => {
    const withoutModel = await run([roofItem()], { picker: undefined, resources: ppuBook(ppuResources({ perTonne: false })) });
    expect(itemOf(withoutModel).aiNormMaterials?.[0]).toMatchObject({ code: PPU.truth, pick: "NAME" });
    expect(withoutModel.stats).toMatchObject({ requested: 0, fallback: 1, batches: 0 });

    const ambiguous = await run([roofItem()], { picker: undefined });
    expect(itemOf(ambiguous).aiNormMaterials).toBeUndefined();
    expect(ambiguous.stats.fallback).toBe(0);
    expect(calculate(itemOf(ambiguous)).gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("14.2.05.03"))).toBe(true);
  });

  it("модель пропустила пару — тоже запасной выбор; сбой не роняет расчёт", async () => {
    const skipping = picker(() => null);
    const result = await run([roofItem()], { picker: skipping, resources: ppuBook(ppuResources({ perTonne: false })) });
    expect(result.stats).toMatchObject({ picked: 0, fallback: 1, failedBatches: 0 });
    expect(result.stats.notes.join(" ")).toContain("модель пропустила");
  });

  it("запасной выбор не работает, когда название ресурса нормы — одно слово", async () => {
    const norm: NormRecord = { ...PPU_NORM, resources: PPU_NORM.resources.map((resource) => (resource.code === "14.2.05.03" ? { ...resource, name: "Состав" } : resource)) };
    const result = await run([roofItem()], { picker: undefined, normOf: () => norm });
    expect(itemOf(result).aiNormMaterials).toBeUndefined();
  });
});

describe("материал нормы «по проекту»: когда этап не идёт и ничего не считает дважды", () => {
  it("в ведомости есть отдельная строка материала под работой (подномер 3.1 с ресурсом) — ресурс нормы не подбирается, модель не зовётся", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    const supply: BillOfWorkItem = {
      id: "supply",
      workName: "Состав двухкомпонентный на основе полиуретановых смол для напыления",
      quantity: 300.3,
      quantityUnit: "кг",
      unitDivisor: 1,
      normCode: null,
      normBaseType: null,
      resourceCode: PPU.truth,
      sourceQuote: null,
      sourceDocument: null,
      positionNumber: "3.1",
      materialRow: { reason: "подстрока 3.1 под строкой «3»", pick: "AI", review: false, coverage: null, note: "материал подобран ИИ" },
    };
    const result = await run([roofItem(), supply], { picker: picker(() => ({ pick: KEY(PPU.truth) }), batches) });
    expect(batches).toEqual([]);
    expect(itemOf(result).aiNormMaterials).toBeUndefined();
    expect(result.stats.requested).toBe(0);
    expect(result.stats.notes.join(" ")).toContain("указан отдельной строкой ведомости");
    // Расчёт: материал стоит поставкой отдельной строкой, у работы ресурс по-прежнему пробел — двойного счёта нет.
    const { line, gaps } = calculate(itemOf(result));
    expect(line.resources.some((resource) => resource.code === PPU.truth)).toBe(false);
    expect(gaps.some((gap) => gap.kind === "AI_MATERIAL_PICK")).toBe(false);
  });

  it("подстрока без ресурса (материал не подобран, «нет цены») тоже считается строкой материала", async () => {
    const supply: BillOfWorkItem = {
      id: "supply",
      workName: "Утеплитель напыляемый",
      quantity: 300.3,
      quantityUnit: "кг",
      unitDivisor: 1,
      normCode: null,
      normBaseType: null,
      resourceCode: null,
      sourceQuote: null,
      sourceDocument: null,
      positionNumber: "3.1",
      materialRow: { reason: "подстрока 3.1", pick: null, review: true, coverage: null, note: "нет цены" },
    };
    const result = await run([roofItem(), supply]);
    expect(itemOf(result).aiNormMaterials).toBeUndefined();
  });

  it("подстрока работы («3.1 Устройство …») материалом не считается: материал нормы подбирается", async () => {
    const child: BillOfWorkItem = { id: "sub", workName: "Устройство пароизоляции", quantity: 182, quantityUnit: "м2", unitDivisor: 1, normCode: null, normBaseType: null, resourceCode: null, sourceQuote: null, sourceDocument: null, positionNumber: "3.1" };
    const result = await run([roofItem(), child]);
    expect(itemOf(result).aiNormMaterials).toHaveLength(1);
  });

  it("ресурс другой строки раздела совпал с кандидатом (строка без подномера) — материал, скорее всего, уже в ведомости: не подбирается", async () => {
    const supply: BillOfWorkItem = { id: "supply", workName: "Состав полиуретановый", quantity: 300.3, quantityUnit: "кг", unitDivisor: 1, normCode: null, normBaseType: null, resourceCode: PPU.epoxy, sourceQuote: null, sourceDocument: null, positionNumber: "9" };
    const result = await run([roofItem(), supply]);
    expect(itemOf(result).aiNormMaterials).toBeUndefined();
    expect(result.stats.requested).toBe(0);
  });

  it("ЛСР заказчика не трогается: позиция с материалами заказчика, состав заказчика, уровень источника «смета заказчика», остаток ЛСР — на подбор не уходят", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    const spy = picker(() => ({ pick: KEY(PPU.truth) }), batches);
    const customer = [
      roofItem({ id: "rows", customerMaterialRows: [{ code: "14.2.05.03-0020", name: "Состав", costPerUnit: 2932, kind: "MATERIAL" } as never] }),
      roofItem({ id: "resources", customerResources: PPU_NORM.resources }),
      roofItem({ id: "sum", customerMaterials: 1000 }),
      roofItem({ id: "level", sourceLevel: "CUSTOMER_ESTIMATE" }),
      roofItem({ id: "rest", unaccountedOf: "rows" }),
      roofItem({ id: "own", ownUnitPrice: 5 }),
    ];
    const result = await run(customer, { picker: spy });
    expect(batches).toEqual([]);
    expect(result.stats).toMatchObject({ requested: 0, picked: 0 });
    for (const item of customer) expect(itemOf(result, item.id)).toBe(item);
  });

  it("путь customerMaterialRows в расчёте прежний: без подобранного материала строка заказчика закрывает ресурс по его цене", () => {
    const row = { code: "14.2.05.03-0020", name: "Состав двухкомпонентный", costPerUnit: 2932, kind: "MATERIAL" } as never;
    const { line, gaps } = calculate(roofItem({ customerMaterialRows: [row] }));
    expect(line.resources.some((resource) => resource.source === "CUSTOMER_SUM")).toBe(true);
    expect(gaps.some((gap) => gap.kind === "CUSTOMER_PRICE")).toBe(true);
    expect(gaps.some((gap) => gap.kind === "AI_MATERIAL_PICK")).toBe(false);
  });

  it("смета заказчика целиком (skip) и заглушка бенчмарка по ЛСР (NO_NORM_PICKER) — этап не идёт", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    const spy = picker(() => ({ pick: KEY(PPU.truth) }), batches);
    const skipped = await run([roofItem()], { picker: spy, skip: "смета заказчика" });
    expect(skipped.stats.requested).toBe(0);
    expect(itemOf(skipped).aiNormMaterials).toBeUndefined();
    const stub = await run([roofItem()], { picker: NO_NORM_PICKER });
    expect(stub.stats.requested).toBe(0);
    expect(batches).toEqual([]);
  });

  it("материал, названный человеком, важнее подобранного: в строке только он, двойного счёта нет", async () => {
    const result = await run([roofItem()]);
    const withHuman: BillOfWorkItem = { ...itemOf(result), projectMaterials: [{ code: "14.2.05.03", name: "Свой состав", unit: "кг", quantity: 310, unitPrice: 1800 }] };
    const { line, gaps } = calculate(withHuman);
    expect(line.resources.filter((resource) => resource.kind === "MATERIAL" && resource.code !== PPU.paint)).toHaveLength(1);
    expect(line.resources.find((resource) => resource.source === "OWN_PRICE")?.total).toBeCloseTo(310 * 1800, 2);
    expect(gaps.some((gap) => gap.kind === "AI_MATERIAL_PICK")).toBe(false);
    // Пометка при подготовке позиции к человеческому материалу — тоже без ИИ-резервов: человек назвал код нормы, подбор молчит.
    expect(line.resources.some((resource) => resource.code === PPU.truth)).toBe(false);
  });

  it("запись относится к своей норме: при другой норме позиции подобранный материал молчит", async () => {
    const result = await run([roofItem()]);
    const other: NormRecord = { ...PPU_NORM, code: "26-01-021-02" };
    const computed = computeEstimateLine(itemOf(result), { norm: other, reasons: [] }, ppuPriceBook(), makeParameters());
    expect(computed.line?.resources.some((resource) => resource.code === PPU.truth)).toBe(false);
    expect(computed.gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE")).toBe(true);
  });

  it("единица позиции к норме не приводится (м3 вместо м2, делитель 1) — позиция в смету не попадёт, и материал ей не подбирается", async () => {
    const result = await run([roofItem({ quantityUnit: "м3", unitDivisor: 1 })]);
    expect(result.stats.requested).toBe(0);
  });
});
