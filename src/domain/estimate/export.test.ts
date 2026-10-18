import { describe, expect, it } from "vitest";

import {
  buildEstimate,
  type EstimatePriceBook,
} from "@/domain/estimate/calculate";
import {
  CSV_BOM,
  toBillOfWorkCsv,
  toLocalEstimateCsv,
} from "@/domain/estimate/export";
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
  makeBillItem,
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
    title: "Тестовый расчёт",
    sections,
    priceBook: makePriceBook(
      buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE),
      patch.priceBook,
    ),
    parameters: makeParameters(patch.parameters),
    resolveNorm: makeResolver(NORMS),
    sources: [],
    generatedAt: "2026-09-27T00:00:00.000Z",
    disclaimer: "Информационно-аналитическая справка, не является сметой",
  });
}

function rows(csv: string): string[] {
  return csv.replace(CSV_BOM, "").trimEnd().split("\r\n");
}

function cells(row: string): string[] {
  return row.split(";");
}

describe("toBillOfWorkCsv", () => {
  it("начинает файл с BOM, чтобы русский Excel не ломал кириллицу", () => {
    const csv = toBillOfWorkCsv(
      build([makeBillSection("Земляные работы", [BILL_GRADING])]),
    );

    expect(csv.startsWith(CSV_BOM)).toBe(true);
  });

  it("даёт по строке на каждую посчитанную позицию плюс заголовок", () => {
    const csv = toBillOfWorkCsv(
      build([
        makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE]),
      ]),
    );

    expect(rows(csv)).toHaveLength(3);
  });

  it("ставит в обоснование книгу и код нормы, потому что один код есть в четырёх книгах", () => {
    const csv = toBillOfWorkCsv(
      build([makeBillSection("Земляные работы", [BILL_DRAGLINE])]),
    );
    const line = cells(rows(csv)[1] ?? "");

    expect(line[1]).toBe(
      `${NORM_DRAGLINE_15.baseType} ${NORM_DRAGLINE_15.code}`,
    );
  });

  it("печатает объём в единицах нормы и отдельно объём по ведомости", () => {
    const csv = toBillOfWorkCsv(
      build([makeBillSection("Земляные работы", [BILL_DRAGLINE])]),
    );
    const line = cells(rows(csv)[1] ?? "");

    expect(line[3]).toBe(NORM_DRAGLINE_15.unit);
    expect(line[4]).toBe("1,2");
    expect(line[5]).toBe("1200");
    expect(line[6]).toBe("м3");
  });

  it("экранирует точку с запятой и кавычки в цитате-основании", () => {
    const item = makeBillItem({
      id: "item-quoted",
      sourceQuote: 'п. 3.2; работы «под ключ»; объём "1 200" м3',
    });
    const csv = toBillOfWorkCsv(
      build([makeBillSection("Земляные работы", [item])]),
    );
    const row = rows(csv)[1] ?? "";

    expect(row).toContain('"п. 3.2; работы «под ключ»; объём ""1 200"" м3"');
  });

  it("на пустом документе оставляет только заголовок", () => {
    const csv = toBillOfWorkCsv(build([makeBillSection("Пустой раздел", [])]));

    expect(rows(csv)).toHaveLength(1);
  });
});

describe("toLocalEstimateCsv", () => {
  it("открывает каждый раздел его наименованием", () => {
    const csv = toLocalEstimateCsv(
      build([makeBillSection("Земляные работы", [BILL_GRADING])]),
    );

    expect(csv).toContain("Раздел: Земляные работы");
  });

  it("печатает применённые нормативы НР и СП в самой строке", () => {
    const document = build([
      makeBillSection("Земляные работы", [BILL_GRADING]),
    ]);
    const line = document.sections[0]?.lines[0];
    const csv = toLocalEstimateCsv(document);

    expect(line).toBeDefined();
    expect(csv).toContain(
      `;${formatPercentForTest(line?.overheadPercent ?? 0)};`,
    );
  });

  it("считает сумму строк раздела равной подытогу раздела", () => {
    const document = build([
      makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE]),
    ]);
    const csv = toLocalEstimateCsv(document);

    expect(csv).toContain(`Итого по разделу «Земляные работы»`);
    expect(csv).toContain(
      formatMoneyForTest(document.sections[0]?.workCost ?? 0),
    );
  });

  it("заканчивается итогами документа, включая НДС", () => {
    const document = build([
      makeBillSection("Земляные работы", [BILL_DRAGLINE]),
    ]);
    const csv = toLocalEstimateCsv(document);

    expect(csv).toContain("Итого с НДС");
    expect(csv).toContain(formatMoneyForTest(document.totals.total));
  });

  it("переносит пометки позиции в отдельную колонку, а не теряет их", () => {
    const document = build([
      makeBillSection("Земляные работы", [BILL_DRAGLINE]),
    ]);
    const csv = toLocalEstimateCsv(document);

    expect(document.sections[0]?.lines[0]?.gaps.length).toBeGreaterThan(0);
    expect(csv).toContain("NO_CURRENT_PRICE");
  });
});

function formatMoneyForTest(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

function formatPercentForTest(value: number): string {
  return String(value).replace(".", ",");
}
