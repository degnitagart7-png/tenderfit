import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
import type { Workbook, Worksheet } from "exceljs";
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

  /** Читает книгу обратно тем же exceljs: то, что увидит Excel, а не то, что мы думали записать. */
  async function readBack(bytes: Uint8Array): Promise<Workbook> {
    const module_ = await import("exceljs");
    const ExcelJS = (module_ as unknown as { default?: typeof module_ }).default ?? module_;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    return workbook;
  }

  /** Номер строки листа, в которой в колонке `column` стоит `text`. */
  function rowOf(sheet: Worksheet, text: string, column: number, from = 1): number {
    for (let number = from; number <= sheet.rowCount; number += 1) {
      const value = sheet.getRow(number).getCell(column).value;
      if (typeof value === "string" && value.trim() === text) return number;
    }
    throw new Error(`на листе нет строки «${text}»`);
  }

  it("собирает настоящую книгу Excel", async () => {
    expect(looksLikeXlsx(await buildEstimateWorkbook(INPUT))).toBe(true);
  });

  it("в книге три листа: форма «ЛСР», ведомость и пояснения", async () => {
    const workbook = await readBack(await buildEstimateWorkbook(INPUT));

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["ЛСР", "Ведомость объёмов", "Пояснения"]);
  });

  it("сумма по смете лежит в книге числом с денежным форматом", async () => {
    const workbook = await readBack(await buildEstimateWorkbook(INPUT));
    const sheet = workbook.getWorksheet("ЛСР") as Worksheet;
    const row = rowOf(sheet, "Всего", 3);
    const cell = sheet.getRow(row).getCell(12);

    expect(typeof cell.value).toBe("number");
    expect(cell.value as number).toBeCloseTo(DOCUMENT.totals.workCost, 2);
    expect(cell.numFmt).toBe("#,##0.00");
    expect(sheet.getRow(rowOf(sheet, "ВСЕГО по смете", 3)).getCell(12).value).toBeCloseTo(DOCUMENT.totals.total, 2);
  });

  it("шапка таблицы: «Количество» над колонками 5–7, «Сметная стоимость, руб.» над 8–12, одиночные подписи сливаются по вертикали", async () => {
    const workbook = await readBack(await buildEstimateWorkbook(INPUT));
    const sheet = workbook.getWorksheet("ЛСР") as Worksheet;
    const head = rowOf(sheet, "Количество", 5);

    expect(sheet.getCell(head, 5).isMerged).toBe(true);
    expect(sheet.getCell(head, 7).master.address).toBe(sheet.getCell(head, 5).address);
    expect(sheet.getCell(head, 8).value).toBe("Сметная стоимость, руб.");
    expect(sheet.getCell(head, 12).master.address).toBe(sheet.getCell(head, 8).address);
    // «№ п/п» занимает обе строки шапки.
    expect(sheet.getCell(head + 1, 1).master.address).toBe(sheet.getCell(head, 1).address);
    expect(sheet.getCell(head, 3).value).toBe("Наименование работ и затрат");
    expect(sheet.getCell(head + 1, 3).master.address).toBe(sheet.getCell(head, 3).address);
    // Строка с номерами колонок 1…12 идёт сразу за шапкой, числами.
    expect([1, 6, 12].map((column) => sheet.getCell(head + 2, column).value)).toEqual([1, 6, 12]);
    expect(sheet.getCell(head, 1).font?.bold).toBe(true);
    expect(sheet.getCell(head, 5).alignment?.horizontal).toBe("center");
  });

  it("печать: A4 альбомная, по ширине страницы, шапка таблицы повторяется, внизу номер страницы", async () => {
    const workbook = await readBack(await buildEstimateWorkbook(INPUT));
    const sheet = workbook.getWorksheet("ЛСР") as Worksheet;
    const head = rowOf(sheet, "Количество", 5);

    expect(sheet.pageSetup.orientation).toBe("landscape");
    expect(sheet.pageSetup.paperSize).toBe(9);
    expect(sheet.pageSetup.fitToPage).toBe(true);
    expect(sheet.pageSetup.fitToWidth).toBe(1);
    expect(sheet.pageSetup.fitToHeight).toBe(0);
    expect(sheet.pageSetup.printTitlesRow).toBe(`${String(head)}:${String(head + 2)}`);
    expect(sheet.headerFooter.oddFooter).toContain("Страница &P из &N");
  });

  it("оформление: Arial 9; позиция жирная, ресурсы мелким серым, число — вправо, наименование — с переносом", async () => {
    const workbook = await readBack(await buildEstimateWorkbook(INPUT));
    const sheet = workbook.getWorksheet("ЛСР") as Worksheet;
    const position = rowOf(sheet, DOCUMENT.sections[0]?.lines[0]?.normName ?? "", 3);
    const resource = rowOf(sheet, "ЭМ", 3, position) + 1;
    const total = rowOf(sheet, "Всего по позиции", 3, position);

    expect(sheet.getCell(position, 3).font).toMatchObject({ name: "Arial", size: 9, bold: true });
    expect(sheet.getCell(position, 3).alignment).toMatchObject({ wrapText: true, vertical: "top" });
    expect(sheet.getCell(position, 2).value).toBe(`${NORM_MANUAL_GRADING.baseType}${NORM_MANUAL_GRADING.code}`);
    expect(typeof sheet.getCell(position, 5).value).toBe("number");
    expect(sheet.getCell(resource, 3).font).toMatchObject({ size: 8 });
    expect(sheet.getCell(resource, 3).font?.color?.argb).toBe("FF595959");
    expect(sheet.getCell(total, 3).font?.bold).toBe(true);
    expect(sheet.getCell(total, 12).alignment?.horizontal).toBe("right");
    expect(sheet.getCell(position, 3).border?.top?.style).toBe("thin");
  });

  it("шапка листа: приложение справа, реквизиты слева на полтаблицы, заголовок по центру", async () => {
    const workbook = await readBack(await buildEstimateWorkbook(INPUT));
    const sheet = workbook.getWorksheet("ЛСР") as Worksheet;

    expect(sheet.getCell("G1").value).toBe("Приложение № 3");
    expect(sheet.getCell("G1").alignment?.horizontal).toBe("right");
    expect(sheet.getCell("A3").value).toBe("Наименование программного продукта");
    expect(sheet.getCell("A3").isMerged).toBe(true);
    expect(sheet.getCell("F3").master.address).toBe("A3");
    expect(sheet.getCell("L3").master.address).toBe("G3");
    const title = rowOf(sheet, "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-01-01", 1);
    expect(sheet.getCell(title, 1).font).toMatchObject({ bold: true, size: 12 });
    expect(sheet.getCell(title, 1).alignment?.horizontal).toBe("center");
  });

  it("пояснения и оговорка — на отдельном листе, а лист «ЛСР» заканчивается подписями", async () => {
    const workbook = await readBack(await buildEstimateWorkbook(INPUT));
    const form = workbook.getWorksheet("ЛСР") as Worksheet;
    const notes = workbook.getWorksheet("Пояснения") as Worksheet;
    const formText: string[] = [];
    form.eachRow((row) => row.eachCell((cell) => void formText.push(String(cell.value))));
    const notesText: string[] = [];
    notes.eachRow((row) => row.eachCell((cell) => void notesText.push(String(cell.value))));

    expect(formText.some((text) => text.includes("Не заполнено в форме"))).toBe(false);
    expect(formText.some((text) => text.includes(DOCUMENT.disclaimer))).toBe(false);
    expect(notesText).toContain("Не заполнено в форме");
    expect(notesText).toContain(DOCUMENT.disclaimer);
    expect(String(form.getRow(form.rowCount).getCell(1).value)).toContain("Проверил");
  });

  it("ведомость объёмов: заголовок закреплён, количество — число", async () => {
    const workbook = await readBack(await buildEstimateWorkbook(INPUT));
    const bill = workbook.getWorksheet("Ведомость объёмов") as Worksheet;

    expect(bill.getCell("A1").value).toBe("№");
    expect(bill.getCell("A1").font?.bold).toBe(true);
    expect(typeof bill.getCell("E3").value).toBe("number");
    expect(bill.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("настоящая смета: книга собирается, условие работ — курсивом, «Итоги по смете» жирным", async () => {
    const real = JSON.parse(
      readFileSync(join(__dirname, "__fixtures__", "lsr", "resource-index-buryatia.json"), "utf8"),
    ) as EstimateDocument;
    const workbook = await readBack(await buildEstimateWorkbook({ ...INPUT, document: real }));
    const sheet = workbook.getWorksheet("ЛСР") as Worksheet;
    const condition = rowOf(sheet, "421/пр_2020_п.58", 2);

    expect(sheet.getCell(condition, 2).font?.italic).toBe(true);
    expect(sheet.getCell(rowOf(sheet, "Итоги по смете:", 3), 3).font?.bold).toBe(true);
    expect(sheet.getCell(rowOf(sheet, "ВСЕГО по смете", 3), 12).value).toBeCloseTo(real.totals.total, 2);
    // Рамки — по всей таблице до блока итогов, а в блоке итогов их нет.
    expect(sheet.getCell(condition, 12).border?.bottom?.style).toBe("thin");
    expect(sheet.getCell(rowOf(sheet, "Итоги по смете:", 3), 12).border?.bottom).toBeUndefined();
  });
});
