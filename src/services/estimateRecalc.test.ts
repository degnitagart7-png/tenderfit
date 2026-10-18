import { describe, expect, it } from "vitest";

import { computeAssurance } from "@/domain/estimate/assurance";
import { anchorOf, restoreEdit, type BillEdit } from "@/domain/estimate/billEdits";
import { auditEstimateArithmetic, estimateDocumentSchema } from "@/domain/estimate/schema";
import type { BillOfWorkItem } from "@/domain/estimate/types";
import { RecalcStaleError, RecalcUnavailableError, recalculateEstimate } from "@/services/estimateRecalc";
import { RIGHT_NORM, WRONG_NORM, buildEditResult, makeEditBase, modelCalls } from "@/test/billEditFixtures";

/*
  Пересчёт после правок: ведомость и нормы идут в расчёт напрямую, модель не вызывается, а числа
  считаются теми же ценами зоны, что и исходный расчёт.
*/

async function setup() {
  const base = makeEditBase();
  const result = await buildEditResult(base);
  const source = { document: result.document, bill: result.bill };
  const item = (name: string): BillOfWorkItem => {
    const found = result.bill.sections.flatMap((section) => section.items).find((candidate) => candidate.workName === name);
    if (found === undefined) throw new Error(`нет позиции ${name}`);
    return found;
  };
  const run = (edits: readonly BillEdit[]) => recalculateEstimate(source, edits, { base });
  const lineOf = (document: typeof result.document, id: string) =>
    document.sections.flatMap((section) => section.lines).find((line) => line.itemId === id);
  return { base, result, source, item, run, lineOf };
}

describe("пересчёт сметы после правок", () => {
  it("без правок даёт тот же итог, что и исходный расчёт, и не зовёт модель", async () => {
    const { result, run } = await setup();
    const calls = modelCalls.count;

    const recalculated = await run([]);

    expect(recalculated.document.totals).toEqual(result.document.totals);
    expect(recalculated.tokensUsed).toBe(0);
    expect(modelCalls.count).toBe(calls);
    expect(recalculated.billItems).toBe(result.billItems);
  });

  it("выбранная норма идёт в расчёт напрямую: «Демонтаж наружных стен» перестаёт считаться по опалубке", async () => {
    const { item, run, lineOf, result } = await setup();
    const walls = item("Демонтаж наружных стен");
    expect(lineOf(result.document, walls.id)?.normCode).toBe(WRONG_NORM.code);

    const recalculated = await run([{ kind: "norm", anchor: anchorOf(walls), norm: { code: RIGHT_NORM.code, baseType: RIGHT_NORM.baseType } }]);
    const line = lineOf(recalculated.document, walls.id);

    expect(line?.normCode).toBe(RIGHT_NORM.code);
    expect(line?.normName).toBe(RIGHT_NORM.fullName);
    expect(line?.directCost).not.toBe(lineOf(result.document, walls.id)?.directCost);
    expect(recalculated.document.totals.workCost).not.toBe(result.document.totals.workCost);
    // Остальные позиции посчитаны так же, как раньше.
    const grading = item("Планировка вручную дна и откосов выемок каналов");
    expect(lineOf(recalculated.document, grading.id)).toEqual(lineOf(result.document, grading.id));
    expect(recalculated.bill.rows.find((row) => row.itemId === walls.id)?.basis).toBe("MANUAL");
    expect(recalculated.applied.marks[0]?.notes[0]).toContain(`норма ГЭСН ${RIGHT_NORM.code}`);
  });

  it("объём: 120 → 240 м2 удваивает стоимость позиции (делитель единицы назначен по норме)", async () => {
    const { item, run, lineOf, result } = await setup();
    const walls = item("Демонтаж наружных стен");
    const before = lineOf(result.document, walls.id);

    const recalculated = await run([{ kind: "change", anchor: anchorOf(walls), quantity: 240 }]);
    const after = lineOf(recalculated.document, walls.id);

    expect(after?.billQuantity).toBe(240);
    expect(after?.quantity).toBeCloseTo((before?.quantity ?? 0) * 2, 6);
    expect(after?.directCost).toBeCloseTo((before?.directCost ?? 0) * 2, 1);
  });

  it("единица, не сходящаяся с единицей нормы, выбрасывает позицию из расчёта с причиной", async () => {
    const { item, run, lineOf } = await setup();
    const walls = item("Демонтаж наружных стен");

    const recalculated = await run([{ kind: "change", anchor: anchorOf(walls), unit: "т" }]);

    expect(lineOf(recalculated.document, walls.id)).toBeUndefined();
    expect(recalculated.document.gaps.some((gap) => gap.kind === "UNIT_MISMATCH")).toBe(true);
  });

  it("своя цена: объём × цена, источник «своя цена», НР и СП нет, допущений нет", async () => {
    const { item, run, lineOf } = await setup();
    const walls = item("Демонтаж наружных стен");

    const recalculated = await run([{ kind: "price", anchor: anchorOf(walls), unitPrice: 1000 }]);
    const line = lineOf(recalculated.document, walls.id);

    expect(line?.priceSource).toBe("OWN_PRICE");
    expect(line?.directCost).toBe(120_000);
    expect(line?.overheadCost).toBe(0);
    expect(line?.profitCost).toBe(0);
    expect(recalculated.document.totals.ownPricedCount).toBe(1);
    expect(computeAssurance(recalculated.document).assumptions.map((a) => a.kind)).not.toContain("CUSTOMER_PRICE");
  });

  it("удалить: позиции нет в смете и в ведомости; итог уменьшается на её стоимость", async () => {
    const { item, run, lineOf, result } = await setup();
    const grading = item("Планировка вручную дна и откосов выемок каналов");
    const cost = lineOf(result.document, grading.id)?.directCost ?? 0;

    const recalculated = await run([{ kind: "remove", anchor: anchorOf(grading) }]);

    expect(lineOf(recalculated.document, grading.id)).toBeUndefined();
    expect(recalculated.billItems).toBe(result.billItems - 1);
    expect(recalculated.document.totals.directCost).toBeCloseTo(result.document.totals.directCost - cost, 1);
  });

  it("добавить строку по своей цене: она в смете, в разделе «Добавлено вручную»", async () => {
    const { run, result } = await setup();

    const recalculated = await run([
      {
        kind: "add",
        id: "add-1",
        row: { workName: "Вывоз мусора", quantity: 10, unit: "т", norm: null, unitPrice: 500, sourceQuote: null, sourceDocument: null },
      },
    ]);
    const section = recalculated.document.sections.find((item) => item.title === "Добавлено вручную");

    expect(section?.lines[0]).toMatchObject({ itemId: "add-1", directCost: 5000, priceSource: "OWN_PRICE" });
    expect(recalculated.document.totals.workCost).toBeCloseTo(result.document.totals.workCost + 5000, 1);
    expect(recalculated.billItems).toBe(result.billItems + 1);
  });

  it("добавить строку с нормой: норма из базы, делитель по единице нормы", async () => {
    const { run } = await setup();

    const recalculated = await run([
      {
        kind: "add",
        id: "add-1",
        row: {
          workName: "Разборка стен",
          quantity: 100,
          unit: "м2",
          norm: { code: RIGHT_NORM.code, baseType: RIGHT_NORM.baseType },
          unitPrice: null,
          sourceQuote: null,
          sourceDocument: null,
        },
      },
    ]);
    const line = recalculated.document.sections.flatMap((section) => section.lines).find((candidate) => candidate.itemId === "add-1");

    expect(line?.normCode).toBe(RIGHT_NORM.code);
    expect(line?.quantity).toBe(1);
    expect(line?.directCost).toBeGreaterThan(0);
  });

  it("позиция, выпавшая из расчёта (нормы нет), возвращается, если назвать ей цену", async () => {
    const { item, run, lineOf, result } = await setup();
    const fence = item("Монтаж ограждения");
    expect(lineOf(result.document, fence.id)).toBeUndefined();

    const recalculated = await run([{ kind: "price", anchor: anchorOf(fence), unitPrice: 2000 }]);

    expect(lineOf(recalculated.document, fence.id)).toMatchObject({ priceSource: "OWN_PRICE", directCost: 30_000 });
    // Пробел «норма не найдена» исчез вместе с позицией, которая его вызывала.
    expect(recalculated.document.gaps.some((gap) => gap.kind === "NO_NORM")).toBe(false);
  });

  it("вернуть отклонённую строку: после исправления единицы она считается по подобранной норме", async () => {
    const { run, lineOf } = await setup();
    const edit = restoreEdit(
      {
        reason: "UNKNOWN_UNIT",
        row: { workName: "Планировка вручную дна и откосов выемок каналов", quantity: "400", unit: "кв.метров", evidenceQuote: "…" },
        message: "",
        documentName: "ВОР.docx",
      },
      { quantity: null, unit: "м2" },
    ) as BillEdit;

    const recalculated = await run([edit]);

    const line = lineOf(recalculated.document, edit.kind === "restore" ? edit.id : "");
    expect(line?.normCode).toBe("01-01-111-01");
    expect(line?.billQuantity).toBe(400);
    expect(recalculated.document.sections.some((section) => section.title === "Возвращено в расчёт")).toBe(true);
  });

  it("арифметика пересчитанного документа сходится", async () => {
    const { item, run } = await setup();
    const walls = item("Демонтаж наружных стен");
    const recalculated = await run([
      { kind: "norm", anchor: anchorOf(walls), norm: { code: RIGHT_NORM.code, baseType: RIGHT_NORM.baseType } },
      { kind: "price", anchor: anchorOf(item("Монтаж ограждения")), unitPrice: 10 },
    ]);
    const parsed = estimateDocumentSchema.parse(JSON.parse(JSON.stringify(recalculated.document)));
    expect(auditEstimateArithmetic(parsed)).toEqual([]);
  });

  it("правка строки, которой нет, не ломает пересчёт и названа в unmatched", async () => {
    const { item, run } = await setup();
    const ghost = { ...anchorOf(item("Демонтаж наружных стен")), itemId: "нет-такой" };
    const recalculated = await run([{ kind: "change", anchor: ghost, quantity: 5 }]);
    expect(recalculated.applied.unmatched).toHaveLength(1);
  });

  it("цены зоны обновились после расчёта: пересчёт отказывает, а не смешивает уровни", async () => {
    const { source } = await setup();
    const fresh = makeEditBase();
    const moved = { ...fresh, priceBook: { ...fresh.priceBook, period: "4 квартал 2026 г." } };
    await expect(recalculateEstimate(source, [], { base: moved })).rejects.toBeInstanceOf(RecalcStaleError);
  });

  it("расчёт без записи ведомости (старый воркер) пересчитать нельзя — сказано словами", async () => {
    const { source } = await setup();
    const { calc: _calc, ...withoutCalc } = source.bill;
    await expect(recalculateEstimate({ ...source, bill: withoutCalc }, [], { base: makeEditBase() })).rejects.toBeInstanceOf(
      RecalcUnavailableError,
    );
  });
});
