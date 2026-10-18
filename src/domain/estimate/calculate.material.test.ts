import { describe, expect, it } from "vitest";

import { buildEstimate } from "@/domain/estimate/calculate";
import { RES, vorBook } from "@/domain/estimate/resourceCandidates.fixtures";
import type { MaterialRow, NormRecord } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import { AMUR_WAGE_ANCHORS, AMUR_ZONE, NORM_MANUAL_GRADING, makeBillItem, makeBillSection, makeParameters, makePriceBook } from "@/test/estimateFixtures";

/**
 * Расчёт строк-материалов (`BillOfWorkItem.materialRow`): поставка по цене ресурса без труда, НР и СП; материал без ресурса — норму работы не ищет.
 */

const GATE_MOUNT: NormRecord = {
  ...NORM_MANUAL_GRADING,
  code: "12-12-001-09",
  tableCode: "12-12-001",
  fullName: "Установка задвижек клиновых с выдвижным шпинделем",
  unit: "шт",
  baseType: "ГЭСНм",
};

const book = vorBook();
const priceBook = makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE), { current: book.current, base: book.base });
const MATERIAL: MaterialRow = { reason: "подстрока 13.1", pick: null, review: true, coverage: null, note: "материал: ресурс не подобран" };

/** Подборщик, который на любой запрос отвечает нормой монтажа: если бы материал в него попал, строка стала бы работой. */
const resolveNorm = (): { norm: NormRecord; reasons: readonly string[] } => ({ norm: GATE_MOUNT, reasons: [] });

function estimate(items: Parameters<typeof makeBillSection>[1]) {
  return buildEstimate({
    title: "Тест",
    sections: [makeBillSection("ВОР", items)],
    priceBook,
    parameters: makeParameters(),
    resolveNorm,
    sources: [],
    generatedAt: "2026-09-28T00:00:00.000Z",
    disclaimer: "тест",
  });
}

const base = { quantityUnit: "шт", unitDivisor: 1, normCode: null, normBaseType: null, resourceCode: null } as const;

describe("поставка-материал в расчёте", () => {
  it("ресурс подобран: цена × объём, труда, машин, НР и СП нет; единица «кг» при цене за «т» переводится, а не умножается", () => {
    const document = estimate([
      makeBillItem({ ...base, id: "gate", workName: "Задвижка клиновая 30с41нж", quantity: 2, resourceCode: RES.gate50, materialRow: { ...MATERIAL, pick: "AI" } }),
      makeBillItem({ ...base, id: "pipe", workName: "Трубы стальные 89×5", quantity: 1036, quantityUnit: "кг", resourceCode: RES.pipe89PerTonne, materialRow: { ...MATERIAL, pick: "AI" } }),
    ]);
    const [gate, pipe] = document.sections[0]?.lines ?? [];
    expect(gate).toMatchObject({ normBaseType: "ФСБЦ", normCode: RES.gate50, labourCost: 0, machineCost: 0, overheadCost: 0, profitCost: 0 });
    expect(gate?.directCost).toBeCloseTo(2 * 14800, 2);
    expect(pipe).toMatchObject({ normUnit: "т" });
    expect(pipe?.quantity).toBeCloseTo(1.036, 6);
    expect(pipe?.directCost).toBeCloseTo(1.036 * 86000, 2);
    expect(document.gaps.filter((gap) => gap.kind === "UNIT_MISMATCH")).toEqual([]);
  });

  it("«м» при цене ресурса за «т» по-прежнему не переводится: пометка UNIT_MISMATCH, а не догадка о плотности", () => {
    const document = estimate([makeBillItem({ ...base, id: "pipe", workName: "Трубы стальные 89×5", quantity: 100, quantityUnit: "м", resourceCode: RES.pipe89PerTonne })]);
    expect(document.gaps.some((gap) => gap.kind === "UNIT_MISMATCH")).toBe(true);
  });

  it("материал без ресурса: нормы работы нет, строки нет, пробел NO_PRICE называет причину — подборщик норм не вызывается", () => {
    const document = estimate([makeBillItem({ ...base, id: "gate", workName: "Задвижка клиновая 30с41нж", quantity: 2, materialRow: MATERIAL })]);
    expect(document.sections[0]?.lines).toEqual([]);
    const gap = document.gaps.find((entry) => entry.kind === "NO_PRICE");
    expect(gap?.message).toContain("материал или оборудование, а не работа");
    expect(gap?.message).toContain("подстрока 13.1");
    expect(document.gaps.some((entry) => entry.kind === "NO_NORM")).toBe(false);
  });

  it("материал без ресурса, но с ценой заказчика: входит по ней с пометкой, как любая позиция без нормы", () => {
    const document = estimate([
      makeBillItem({
        ...base,
        id: "gate",
        workName: "Задвижка клиновая 30с41нж",
        quantity: 2,
        materialRow: MATERIAL,
        customerPrice: { total: 31_000, unitPrice: 15_500, unit: "шт", origin: "LINE", document: "ЛСР" },
      }),
    ]);
    const line = document.sections[0]?.lines[0];
    expect(line?.priceSource).toBe("CUSTOMER_PRICE");
    expect(line?.directCost).toBeCloseTo(31_000, 2);
  });

  it("норма, названная человеком или документом, возвращает позицию в работы: пометка материала её не блокирует", () => {
    const document = estimate([makeBillItem({ ...base, id: "gate", workName: "Задвижка клиновая 30с41нж", quantity: 2, normCode: "12-12-001-09", normBaseType: "ГЭСНм", materialRow: MATERIAL })]);
    expect(document.sections[0]?.lines[0]).toMatchObject({ normCode: "12-12-001-09", normBaseType: "ГЭСНм" });
  });
});
