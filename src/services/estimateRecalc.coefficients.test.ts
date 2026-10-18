import { describe, expect, it } from "vitest";

import { anchorOf, type BillEdit } from "@/domain/estimate/billEdits";
import type { CustomerConditions } from "@/domain/estimate/types";
import { recalculateEstimate } from "@/services/estimateRecalc";
import { buildEditResult, makeEditBase } from "@/test/billEditFixtures";

/*
  Пересчёт после правки строки: «коэффициент заказчика» снимается по позиции без модели и без документов, на тех же ценах.
  Строка «Планировка вручную» (d1c1-2) несёт подтверждённое условие заказчика (т. 3, п. 1.1, ×1,2).
*/

const GRADING = "d1c1-2";
const CONDITIONS: CustomerConditions = {
  confirmed: { conditionIds: ["T3-1.1"], p58: false, phase: "RECONSTRUCTION" },
  rejected: [],
  label: "как у заказчика: приложение 10 к 421/пр, таблица 3, п. 1.1 (К = 1,2)",
  enabled: true,
  forceUnconfirmed: false,
};

async function source() {
  const base = makeEditBase();
  const built = await buildEditResult(base);
  const sections = built.bill.sections.map((section) => ({
    ...section,
    items: section.items.map((item) => (item.id === GRADING ? { ...item, customerConditions: CONDITIONS } : item)),
  }));
  return { base, document: built.document, bill: { ...built.bill, sections } };
}

const lineOf = (document: Awaited<ReturnType<typeof source>>["document"]) =>
  document.sections.flatMap((section) => section.lines).find((line) => line.itemId === GRADING);

describe("пересчёт: коэффициенты заказчика по позиции", () => {
  it("подтверждённый коэффициент применён при пересчёте, правка «снять» возвращает норму как есть", async () => {
    const { base, document, bill } = await source();
    const item = bill.sections.flatMap((section) => section.items).find((candidate) => candidate.id === GRADING);
    const off: BillEdit = { kind: "coefficients", anchor: anchorOf(item as NonNullable<typeof item>), apply: false };

    const applied = await recalculateEstimate({ document, bill }, [], { base });
    const removed = await recalculateEstimate({ document, bill }, [off], { base });

    const plain = lineOf(document)?.labourHours as number;
    expect(lineOf(applied.document)?.labourHours).toBeCloseTo(plain * 1.2, 6);
    expect(lineOf(applied.document)?.coefficients?.customer?.applied).toEqual(["T3-1.1"]);
    expect(lineOf(removed.document)?.labourHours).toBeCloseTo(plain, 6);
    expect(lineOf(removed.document)?.coefficients).toBeUndefined();
    expect(removed.applied.marks.find((mark) => mark.itemId === GRADING)?.notes).toEqual(["коэффициенты заказчика сняты"]);
    expect(removed.tokensUsed).toBe(0);
  });
});
