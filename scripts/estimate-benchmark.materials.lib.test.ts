import { describe, expect, it } from "vitest";

import { computeEstimateLine, computeResourceLine } from "../src/domain/estimate/calculate";
import { applyNormMaterial } from "../src/domain/estimate/normMaterial";
import {
  BITUMEN_NORM,
  BITUMEN_RESOURCE,
  bitumenItem,
  PROFILED_NORM,
  PROFILED_RESOURCE,
  profiledItem,
  ROOF,
  roofBook,
  roofPriceBook,
} from "../src/domain/estimate/normMaterial.roof.fixtures";
import { applyResourcePick, createResourceIndex } from "../src/domain/estimate/resourceCandidates";
import type { BillOfWorkItem, EstimateLine } from "../src/domain/estimate/types";
import { makeParameters } from "../src/test/estimateFixtures";
import { aiMaterialsOf, formatAiMaterialsSection, topAiMaterials, type AiMaterialRow, type AiMaterialsEstimate } from "./estimate-benchmark.materials.lib";

/**
 * Материалы, подобранные ИИ, в отчётах бенчмарка: по нашим строкам видно, какой материал встал под какую норму, с расходом, ценой, обоснованием и уверенностью.
 * Строки сметы считает настоящий расчёт на синтетическом справочнике кровли (`normMaterial.roof.fixtures.ts`).
 */

const index = createResourceIndex(roofBook());
const entry = (code: string) => {
  const found = index.byCode.get(code);
  if (found === undefined) throw new Error(`нет ресурса ${code}`);
  return found;
};

const params = makeParameters();
const lineOf = (item: BillOfWorkItem, norm: typeof BITUMEN_NORM): EstimateLine => {
  const computed = computeEstimateLine(item, { norm, reasons: [] }, roofPriceBook(), params);
  if (computed.line === null) throw new Error("строка не посчитана");
  return computed.line;
};

/** Позиции после подбора ИИ: битумная — ондулин (уверенность высокая), профилированная — стальной лист (низкая). */
const bitumen = applyNormMaterial(bitumenItem(), BITUMEN_NORM, BITUMEN_RESOURCE, entry(ROOF.bitumenOndulin), { source: "AI", reason: "ондулин — битумный волнистый лист.", confidence: "high", coverage: null });
const profiled = applyNormMaterial(profiledItem(), PROFILED_NORM, PROFILED_RESOURCE, entry(ROOF.steelHeavy), { source: "AI", reason: "лист для кровли с полимерным покрытием", confidence: "low", coverage: null });

function estimateOf(items: readonly BillOfWorkItem[], lines: readonly EstimateLine[]): AiMaterialsEstimate {
  return { document: { sections: [{ lines }] }, bill: { sections: [{ items }] } };
}

describe("материалы нормы «по проекту» по строкам сметы", () => {
  const rows = aiMaterialsOf(estimateOf([bitumen, profiled], [lineOf(bitumen, BITUMEN_NORM), lineOf(profiled, PROFILED_NORM)]));

  it("на каждую подобранную пару — строка: ресурс нормы, материал, расход, цена, сумма, выбор, обоснование, уверенность", () => {
    expect(rows).toHaveLength(2);
    const first = rows.find((row) => row.itemId === "bitumen") as AiMaterialRow;
    expect(first).toMatchObject({
      kind: "NORM_MATERIAL",
      lineName: "Устройство кровель из листов волнистых битумных (ондулин)",
      norm: "ГЭСН 12-01-007-12",
      normResource: { code: "12.1.02.06", name: "Листы волнистые битумные" },
      picked: { code: ROOF.bitumenOndulin, unit: "м2" },
      unitPrice: 520,
      pick: "AI",
      review: false,
      reason: "ондулин — битумный волнистый лист",
      confidence: "high",
    });
    // 480 м2 при норме на 100 м2 и расходе 105 м2 на единицу нормы.
    expect(first.quantity).toBeCloseTo(504, 6);
    expect(first.total).toBeCloseTo(504 * 520, 2);
    expect(first.picked.name).toContain("ондулин");
    expect(first.lineTotal).toBeGreaterThan(first.total);

    const second = rows.find((row) => row.itemId === "profiled") as AiMaterialRow;
    expect(second).toMatchObject({ norm: "ГЭСН 12-01-033-02", normResource: { code: "12.1.02.03", name: "Профилированный лист" }, picked: { code: ROOF.steelHeavy }, review: true, confidence: "low" });
    expect(second.total).toBeCloseTo(1008 * 1100, 2);
  });

  it("главные по рублям: дорогое покрытие первым; ограничение по числу", () => {
    expect(topAiMaterials(rows, 15).map((row) => row.itemId)).toEqual(["profiled", "bitumen"]);
    expect(topAiMaterials(rows, 1).map((row) => row.itemId)).toEqual(["profiled"]);
    expect(topAiMaterials(rows, 0)).toEqual([]);
  });

  it("строка отчёта переживает JSON без потерь", () => {
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
  });

  it("позиция без подбора и строка без пары в смете в список не попадают", () => {
    const plain = bitumenItem({ id: "plain" });
    expect(aiMaterialsOf(estimateOf([plain], [lineOf(plain, BITUMEN_NORM)]))).toEqual([]);
    // Подобранный материал, но норма строки другая: запись молчит, как и в расчёте.
    expect(aiMaterialsOf(estimateOf([bitumen], [lineOf(profiled, PROFILED_NORM)]))).toEqual([]);
    // Позиция из сметы не нашлась в ведомости.
    expect(aiMaterialsOf(estimateOf([], [lineOf(bitumen, BITUMEN_NORM)]))).toEqual([]);
  });

  it("запись, сделанная до появления полей причины и уверенности, читается: причина — из подписи, уверенность — null", () => {
    const { reason: _reason, confidence: _confidence, normResourceName: _name, ...legacy } = (bitumen.aiNormMaterials ?? [])[0] as NonNullable<typeof bitumen.aiNormMaterials>[number];
    const old: BillOfWorkItem = { ...bitumen, aiNormMaterials: [legacy] };
    const [row] = aiMaterialsOf(estimateOf([old], [lineOf(old, BITUMEN_NORM)]));
    expect(row).toMatchObject({ reason: "ондулин — битумный волнистый лист", confidence: null, normResource: { code: "12.1.02.06", name: "" } });
  });
});

describe("материалы строк ведомости (поставка по ресурсу справочника)", () => {
  it("строка-материал: выбор ИИ с причиной и уверенностью; пустой pick (ресурс не подобран) не берётся", () => {
    const base: BillOfWorkItem = { id: "sheet", workName: "Лист профилированный оцинкованный НС35, 120 м2", quantity: 120, quantityUnit: "м2", unitDivisor: 1, normCode: null, normBaseType: null, resourceCode: null, sourceQuote: null, sourceDocument: null };
    const picked = applyResourcePick(base, entry(ROOF.steelHeavy), { source: "AI", kindReason: "строка 5.1 под работой", reason: "совпала марка НС35.", confidence: "high", coverage: null });
    const computed = computeResourceLine(picked, roofPriceBook(), params);
    if (computed.line === null) throw new Error("строка не посчитана");
    const [row] = aiMaterialsOf(estimateOf([picked], [computed.line]));
    expect(row).toMatchObject({
      kind: "MATERIAL_ROW",
      itemId: "sheet",
      normResource: null,
      picked: { code: ROOF.steelHeavy, unit: "м2" },
      quantity: 120,
      unitPrice: 1100,
      total: 132000,
      pick: "AI",
      review: false,
      reason: "совпала марка НС35",
      confidence: "high",
    });

    const unpriced: BillOfWorkItem = { ...base, materialRow: { reason: "x", pick: null, review: true, coverage: null, note: "ресурс не подобран" } };
    expect(aiMaterialsOf(estimateOf([unpriced], [computed.line]))).toEqual([]);
  });
});

describe("раздел summary.md «материалы, подобранные ИИ»", () => {
  const rows = aiMaterialsOf(estimateOf([bitumen, profiled], [lineOf(bitumen, BITUMEN_NORM), lineOf(profiled, PROFILED_NORM)]));
  const text = formatAiMaterialsSection(rows, 15).join("\n").replace(/[  ]/gu, " ");

  it("заголовок с числом и суммой, таблица: позиция, норма, ресурс нормы, материал, расход, цена, сумма, выбор, уверенность, обоснование", () => {
    expect(text).toContain("### Материалы, подобранные ИИ (2 из 2 по рублям, всего");
    expect(text).toContain("Устройство кровель из листов волнистых битумных (ондулин)");
    expect(text).toContain("ГЭСН 12-01-007-12");
    expect(text).toContain("12.1.02.06 Листы волнистые битумные");
    expect(text).toContain(`${ROOF.bitumenOndulin} Лист волнистый битумный ондулин Смарт 1950х960 мм, м2`);
    expect(text).toContain("504,00");
    expect(text).toContain("1 108 800,00");
    expect(text).toContain("ИИ, проверьте");
    expect(text).toContain("высокая");
    expect(text).toContain("низкая");
    expect(text).toContain("ондулин — битумный волнистый лист");
    // Профилированный лист дороже и идёт первым.
    expect(text.indexOf("Монтаж кровли из профилированного листа")).toBeLessThan(text.indexOf("Устройство кровель из листов волнистых битумных"));
  });

  it("ограничение по числу строк; пустой список — раздела нет", () => {
    const one = formatAiMaterialsSection(rows, 1).join("\n");
    expect(one).toContain("(1 из 2 по рублям");
    expect(one).not.toContain("Устройство кровель из листов волнистых битумных");
    expect(formatAiMaterialsSection([], 15)).toEqual([]);
  });
});
