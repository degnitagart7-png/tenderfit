import { describe, expect, it } from "vitest";

import {
  buildEstimate,
  type EstimatePriceBook,
} from "@/domain/estimate/calculate";
import {
  asNumber,
  buildEstimateWorkbook,
  estimateFileName,
  toBillMatrix,
  toSheetMatrix,
} from "@/domain/estimate/exportXlsx";
import type {
  BillOfWorkSection,
  EstimateDocument,
  EstimateParameters,
} from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_DRAGLINE,
  BILL_GRADING,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

const NORMS = [NORM_MANUAL_GRADING, NORM_DRAGLINE_15];

function build(
  sections: readonly BillOfWorkSection[],
  patch: {
    priceBook?: Partial<EstimatePriceBook>;
    parameters?: Partial<EstimateParameters>;
  } = {},
): EstimateDocument {
  return buildEstimate({
    title: "Реконструкция запорных колодцев",
    sections,
    priceBook: makePriceBook(
      buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE),
      patch.priceBook,
    ),
    parameters: makeParameters(patch.parameters),
    resolveNorm: makeResolver(NORMS),
    sources: [],
    generatedAt: "2026-09-28T00:00:00.000Z",
    disclaimer: "Информационно-аналитическая справка, не является сметой",
  });
}

const DOCUMENT = build([
  makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE]),
]);

const INPUT = {
  document: DOCUMENT,
  number: "02-01-01",
  constructionName: "Сети водоснабжения",
  objectName: "Запорные колодцы",
  basis: "Ведомость объёмов работ",
};

describe("asNumber", () => {
  it.each([
    ["1240.50", 1240.5],
    ["1240,50", 1240.5],
    ["1 240,50", 1240.5],
    ["0,00", 0],
  ])("читает число из ячейки «%s»", (raw, expected) => {
    expect(asNumber(raw)).toBe(expected);
  });

  it("проценты и единицы числами не считает", () => {
    expect(asNumber("103 %")).toBeNull();
    expect(asNumber("м3")).toBeNull();
    expect(asNumber("")).toBeNull();
    expect(asNumber("Итого прямые затраты")).toBeNull();
  });
});

describe("toSheetMatrix", () => {
  it("держит двенадцать колонок в каждой строке", () => {
    const widths = new Set(
      toSheetMatrix([["a"], ["b", "c"]]).map((row) => row.length),
    );

    expect([...widths]).toEqual([12]);
  });

  it("суммы приходят числами, а подписи остаются строками", () => {
    const [row] = toSheetMatrix([
      ["", "", "Итого прямые затраты", "", "", "", "", "", "", "", "", "1240,50"],
    ]);

    expect(row?.[2]).toBe("Итого прямые затраты");
    expect(row?.[11]).toBe(1240.5);
  });
});

describe("toBillMatrix", () => {
  it("начинается с заголовка ведомости", () => {
    expect(toBillMatrix(DOCUMENT)[0]).toEqual([
      "№",
      "Обоснование",
      "Наименование работ",
      "Ед. изм.",
      "Количество",
      "Документ-основание",
      "Цитата",
    ]);
  });

  it("даёт строку на каждую позицию и заголовок раздела", () => {
    const rows = toBillMatrix(DOCUMENT);
    const positions = DOCUMENT.sections.reduce(
      (sum, section) => sum + section.lines.length,
      0,
    );

    expect(rows).toHaveLength(1 + DOCUMENT.sections.length + positions);
  });

  it("количество остаётся числом, а не текстом", () => {
    const row = toBillMatrix(DOCUMENT)[2];

    expect(typeof row?.[4]).toBe("number");
  });
});

describe("estimateFileName", () => {
  it("называет файл номером и датой", () => {
    expect(
      estimateFileName("32616404800", new Date("2026-09-28T10:00:00Z"), "xlsx"),
    ).toBe("Смета 32616404800 от 2026-09-28.xlsx");
  });

  it("выбрасывает запрещённые в имени файла знаки", () => {
    expect(
      estimateFileName('AA/01:"*?', new Date("2026-09-28T10:00:00Z"), "csv"),
    ).not.toMatch(/[\\/:"*?<>|]/);
  });
});

describe("buildEstimateWorkbook", () => {
  /** XLSX — это zip: подпись PK и заметный размер годятся как признак книги. */
  function looksLikeXlsx(bytes: Uint8Array): boolean {
    return bytes.byteLength > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  }

  it("собирает настоящую книгу Excel", async () => {
    expect(looksLikeXlsx(await buildEstimateWorkbook(INPUT))).toBe(true);
  });

  it("в книге два листа: форма и ведомость", async () => {
    const bytes = await buildEstimateWorkbook(INPUT);
    const module_ = await import("xlsx");
    const XLSX =
      (module_ as unknown as { default?: typeof module_ }).default ?? module_;
    const workbook = XLSX.read(bytes, { type: "array" });

    expect(workbook.SheetNames).toEqual([
      "ЛСР по форме 421пр",
      "Ведомость объёмов",
    ]);
  });

  it("сумма по смете лежит в книге числом", async () => {
    const bytes = await buildEstimateWorkbook(INPUT);
    const module_ = await import("xlsx");
    const XLSX =
      (module_ as unknown as { default?: typeof module_ }).default ?? module_;
    const workbook = XLSX.read(bytes, { type: "array" });
    const sheet = workbook.Sheets["ЛСР по форме 421пр"];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet!, { header: 1 });

    const total = rows.find((row) => row[2] === "Всего по смете");
    expect(typeof total?.[11]).toBe("number");
    expect(total?.[11]).toBeCloseTo(DOCUMENT.totals.workCost, 2);
  });
});
