import { describe, expect, it } from "vitest";

import { PPU, PPU_NORM, PPU_TRUTH_PRICE, ppuBase, ppuResources } from "@/domain/estimate/normMaterial.fixtures";
import type { NormPicker } from "@/domain/estimate/normPick";
import { buildEstimateFromDocuments } from "@/services/estimateService";
import { makeParameters } from "@/test/estimateFixtures";

/**
 * Материал нормы «по проекту» от таблицы до строки сметы (ВОР без сметы заказчика): ведомость читает код, норму выбирает «ИИ-сметчик» (подменён),
 * материал нормы подбирается вторым этапом, расчёт ставит его в строку. Случай закупки 32616409061: изоляция кровли напыляемым ППУ, ГЭСН26-01-021-01.
 */

const VOR = [
  "Ведомость объемов работ",
  "№ п/п\tНаименование\tЕд. изм.\tКол-во",
  "1\tПодготовка площадки\tшт\t1",
  "2\tПрием и хранение материалов\tшт\t1",
  "3\tИзоляция кровли напыляемым пенополиуретаном толщиной 50 мм\tм2\t182",
].join("\n");

const NO_BILL = async () => ({ rows: [], hasBill: false, tokens: 0, malformed: 0, truncated: false });

/** Норму для работы выбирает по шифру из кандидатов; материалу нормы — настоящий состав. */
function model(seen: Parameters<NormPicker>[0][] = [], materialPick: string | null = `РЕСУРС|${PPU.truth}`): NormPicker {
  return async (batch) => {
    seen.push(batch);
    return {
      picks: batch.items.map((item) => ({
        id: item.id,
        pick: item.kind === "norm_material" ? materialPick : item.workName.startsWith("Изоляция") ? (item.candidates[0]?.key ?? null) : null,
        demolition: false,
        confidence: "high" as const,
        reason: item.kind === "norm_material" ? "полиуретановая смола для напыляемой теплоизоляции" : "изоляция напылением",
      })),
      tokens: 400,
      malformed: 0,
    };
  };
}

function run(normPicker?: NormPicker, resources = ppuResources()) {
  return buildEstimateFromDocuments(
    {
      regNumber: "32616409061",
      subject: "Капитальный ремонт кровли",
      documents: [{ name: "ВОР.xlsx", text: VOR }],
      parameters: makeParameters(),
      now: new Date("2026-10-11T00:00:00.000Z"),
    },
    { base: ppuBase(resources), fetcher: NO_BILL, ...(normPicker === undefined ? {} : { normPicker }) },
  );
}

type Result = Awaited<ReturnType<typeof run>>;
const lineOf = (result: Result) => result.document.sections.flatMap((section) => section.lines).find((line) => line.normCode === PPU_NORM.code);

describe("материал нормы «по проекту»: расчёт ведомости без сметы заказчика", () => {
  it("без материала: основной материал позиции выпадает пробелом (как было)", async () => {
    const result = await run(undefined);
    const line = lineOf(result);
    expect(line?.normCode).toBe(PPU_NORM.code);
    expect(line?.materialCost).toBe(0);
    expect(result.document.gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("14.2.05.03"))).toBe(true);
    expect(result.normPick.normMaterialRequested).toBe(0);
  });

  it("с моделью: норма и материал выбраны, состав 300,3 кг по цене зоны в строке; пробел «без марки» заменён пометкой; счётчики и токены сложены", async () => {
    const batches: Parameters<NormPicker>[0][] = [];
    const result = await run(model(batches));
    const line = lineOf(result);
    expect(line?.normCode).toBe(PPU_NORM.code);
    const material = line?.resources.find((resource) => resource.code === PPU.truth);
    expect(material?.quantity).toBeCloseTo(300.3, 6);
    expect(material?.total).toBeCloseTo(PPU_TRUTH_PRICE * 300.3, 2);
    expect(material?.note).toContain("материал подобран ИИ");
    expect(line?.materialCost).toBeCloseTo(PPU_TRUTH_PRICE * 300.3, 2);
    expect(result.document.gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("14.2.05.03"))).toBe(false);
    expect(result.document.gaps.some((gap) => gap.kind === "AI_MATERIAL_PICK")).toBe(true);

    // Два вызова модели: сначала норма, потом материал нормы (норма уже известна).
    expect(batches.map((batch) => batch.items.some((item) => item.kind === "norm_material"))).toEqual([false, true]);
    expect(batches[1]?.items).toHaveLength(1);
    expect(result.normPick).toMatchObject({ picked: 1, normMaterialRequested: 1, normMaterialPicked: 1, normMaterialRejected: 0, normMaterialFallback: 0, batches: 2, tokens: 800 });

    // Подбор записан в позицию снимка ведомости: пересчёт после правок без модели сохранит материал.
    const item = result.bill.sections.flatMap((section) => section.items).find((entry) => entry.positionNumber === "3");
    expect(item?.aiNormMaterials?.[0]).toMatchObject({ code: PPU.truth, normResourceCode: "14.2.05.03" });
  });

  it("сбой модели при подборе материала: остаётся пробел или выбор кодом по наименованию с «проверьте»; расчёт идёт", async () => {
    let calls = 0;
    const flaky: NormPicker = async (batch) => {
      calls += 1;
      if (calls === 2) throw new Error("шлюз недоступен");
      return model()(batch);
    };
    const withDecoy = await run(flaky);
    expect(withDecoy.normPick).toMatchObject({ normMaterialRequested: 1, normMaterialPicked: 0, normMaterialFallback: 0, failedBatches: 1 });
    expect(lineOf(withDecoy)?.materialCost).toBe(0);
    expect(withDecoy.document.gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("14.2.05.03"))).toBe(true);

    calls = 0;
    const single = await run(flaky, ppuResources({ perTonne: false }));
    expect(single.normPick).toMatchObject({ normMaterialFallback: 1, failedBatches: 1 });
    expect(lineOf(single)?.materialCost).toBeCloseTo(PPU_TRUTH_PRICE * 300.3, 2);
    const item = single.bill.sections.flatMap((section) => section.items).find((entry) => entry.positionNumber === "3");
    expect(item?.aiNormMaterials?.[0]).toMatchObject({ pick: "NAME", review: true });
  });

  it("ответ модели вне кандидатов отклонён: пробел остаётся, счётчик normMaterialRejected", async () => {
    const result = await run(model([], `РЕСУРС|${PPU.panel}`));
    expect(result.normPick).toMatchObject({ normMaterialRequested: 1, normMaterialPicked: 0, normMaterialRejected: 1 });
    expect(lineOf(result)?.materialCost).toBe(0);
  });
});
