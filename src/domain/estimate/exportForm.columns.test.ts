import { describe, expect, it } from "vitest";

import { buildEstimate, type EstimatePriceBook } from "@/domain/estimate/calculate";
import { CSV_BOM } from "@/domain/estimate/export";
import { buildLocalEstimateForm, buildLocalEstimateFormRows, hasBaseLevelResources, toLocalEstimateFormCsv } from "@/domain/estimate/exportForm";
import type { BillOfWorkItem, CustomerConditions, EstimateDocument } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_DRAINAGE,
  BILL_GRADING,
  NORM_DRAINAGE_100,
  NORM_MANUAL_GRADING,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  Форма 421/пр, колонки 5, 6, 8, 9 и 11: расход на единицу расценки, коэффициент к расходу, базисная цена и индекс,
  коэффициент к цене; оговорка «ресурсы без текущей цены — в базисном уровне 2022» — только если такие ресурсы остались.
*/

const build = (items: readonly BillOfWorkItem[], priceBook: Partial<EstimatePriceBook> = {}): EstimateDocument =>
  buildEstimate({
    title: "Тест",
    sections: [makeBillSection("Раздел", items)],
    priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE), priceBook),
    parameters: makeParameters(),
    resolveNorm: makeResolver([NORM_MANUAL_GRADING, NORM_DRAINAGE_100]),
    sources: [],
    generatedAt: "2026-10-10T00:00:00.000Z",
    disclaimer: "тест",
  });

const input = (document: EstimateDocument) => ({ document, number: "1", constructionName: "c", objectName: "o", basis: "b" });
const rowsOf = (document: EstimateDocument) => buildLocalEstimateFormRows(input(document));
const num = (text: string | undefined): number => Number((text ?? "").replace(",", "."));

describe("колонка 5: расход на единицу расценки; колонка 7 — на позицию", () => {
  const document = build([BILL_DRAINAGE]);
  const line = document.sections[0]?.lines[0];
  // Только ресурсные строки: строки элементов (ОТ, ЭМ, М) и позиции несут в колонке 7 свои суммы часов и объёмов.
  const resourceRows = buildLocalEstimateForm(input(document))
    .filter((row) => row.kind === "resource")
    .map((row) => row.cells);

  it("расход на позицию = расход на единицу × объём в единицах расценки (колонка 5 × объём позиции = колонка 7)", () => {
    expect(resourceRows.length).toBeGreaterThan(5);
    for (const row of resourceRows) {
      expect(num(row[4]) * (line?.quantity ?? 0), row[1]).toBeCloseTo(num(row[6]), 3);
    }
  });

  it("у ресурса нормы расход на единицу совпадает с нормой", () => {
    const sand = resourceRows.find((row) => row[1] === "02.3.01.02-1118");
    expect(num(sand?.[4])).toBe(220);
  });
});

describe("колонки 8 и 9: цена в базисном уровне и индекс", () => {
  it("у ресурса с ценой зоны — базисная цена ФСБЦ и отношение цен; у труда пусто", () => {
    const rows = rowsOf(build([BILL_DRAINAGE]));
    const machine = rows.find((row) => row[1] === "91.05.05-015");
    const labour = rows.find((row) => row[1] === "2-100-03");

    expect(machine?.[7]).not.toBe("");
    expect(num(machine?.[8])).toBeCloseTo(num(machine?.[9]) / num(machine?.[7]), 1);
    expect(labour?.[7]).toBe("");
    expect(labour?.[8]).toBe("");
  });

  it("ресурс без текущей цены идёт в базисном уровне: базисная цена = цена, индекс 1", () => {
    const rows = rowsOf(build([BILL_DRAINAGE], { current: new Map() }));
    const sand = rows.find((row) => row[1] === "02.3.01.02-1118");

    expect(sand?.[7]).toBe(sand?.[9]);
    expect(sand?.[8]).toBe("1");
  });
});

describe("колонки 6 и 11: коэффициенты", () => {
  const PREMISES: CustomerConditions = {
    confirmed: { conditionIds: ["T3-1.1"], p58: false, phase: "RECONSTRUCTION" },
    rejected: [],
    label: "как у заказчика",
    enabled: true,
    forceUnconfirmed: false,
  };

  it("коэффициент к труду 1,2: колонка 6 = 1,20, колонка 5 — норма, колонка 7 — с коэффициентом", () => {
    const document = build([{ ...BILL_GRADING, customerConditions: PREMISES }]);
    const row = rowsOf(document).find((candidate) => candidate[1] === "1-100-30");

    expect(row?.[5]).toBe("1,20");
    expect(num(row?.[4])).toBeCloseTo(86.5, 4);
    expect(num(row?.[6])).toBeCloseTo(0.8 * 86.5 * 1.2, 3);
  });

  it("без коэффициентов колонка 6 пуста", () => {
    const row = rowsOf(build([BILL_GRADING])).find((candidate) => candidate[1] === "1-100-30");
    expect(row?.[5]).toBe("");
    expect(row?.[10]).toBe("");
  });

  it("повышенная оплата труда: колонка 11 — множитель, колонка 10 — ставка без него; колонки 7 × 10 × 11 = 12", () => {
    const document = build([BILL_GRADING]);
    const line = document.sections[0]?.lines[0] as NonNullable<(typeof document.sections)[0]["lines"][0]>;
    const labour = line.resources.find((resource) => resource.kind === "LABOUR");
    const factor = 1.25;
    const patched: EstimateDocument = {
      ...document,
      sections: [
        {
          ...(document.sections[0] as (typeof document.sections)[0]),
          lines: [
            {
              ...line,
              coefficients: { labour: 1, machines: 1, wage: factor, conditionIds: [], adjustmentIds: [] },
              resources: line.resources.map((resource) =>
                resource === labour
                  ? { ...resource, unitPrice: Math.round(resource.unitPrice * factor * 100) / 100, total: Math.round(resource.total * factor * 100) / 100 }
                  : resource,
              ),
            },
          ],
        },
      ],
    };
    const row = rowsOf(patched).find((candidate) => candidate[1] === "1-100-30");

    expect(row?.[10]).toBe("1,25");
    expect(num(row?.[9])).toBeCloseTo(labour?.unitPrice ?? 0, 1);
    expect(num(row?.[6]) * num(row?.[9]) * num(row?.[10])).toBeCloseTo(num(row?.[11]), 0);
  });
});

describe("шапка: «ресурсы без текущей цены — в базисном уровне 2022» только когда такие ресурсы остались", () => {
  const headerOf = (document: EstimateDocument): string =>
    toLocalEstimateFormCsv(input(document))
      .replace(CSV_BOM, "")
      .split("\r\n")
      .find((row) => row.startsWith("Обоснование принятых текущих цен")) ?? "";

  it("цены зоны есть у всех ресурсов — оговорки нет", () => {
    const priced = build([BILL_DRAINAGE]);
    const document: EstimateDocument = {
      ...priced,
      sections: priced.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => ({
          ...line,
          resources: line.resources.map((resource) => (resource.source === "BASE_2022" ? { ...resource, source: "CURRENT_ZONE" as const } : resource)),
        })),
      })),
    };
    expect(hasBaseLevelResources(document)).toBe(false);
    expect(headerOf(document)).not.toContain("Ресурсы без текущей цены");
  });

  it("часть ресурсов без текущей цены — оговорка есть", () => {
    const document = build([BILL_DRAINAGE]);
    expect(hasBaseLevelResources(document)).toBe(true);
    expect(headerOf(document)).toContain("Ресурсы без текущей цены — в базисном уровне 01.01.2022");
  });
});
