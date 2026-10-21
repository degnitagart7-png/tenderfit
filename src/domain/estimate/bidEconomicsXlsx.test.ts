import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { auditBidInput } from "@/domain/estimate/bidAuditBase";
import { computeBidEconomics, evaluateMyPrice, type BidEconomicsInput } from "@/domain/estimate/bidEconomics";
import {
  BID_SHEET_NAME,
  bidWorkbookFileName,
  buildBidSheetRows,
  buildBidWorkbook,
  type BidSheetRow,
} from "@/domain/estimate/bidEconomicsXlsx";
import { DEFAULT_COST_PROFILE } from "@/domain/estimate/companyCostProfile";
import type { EstimateDocument } from "@/domain/estimate/types";
import { reportWithFindings } from "@/test/auditReports";

/*
  Книга «Расчёт цены участия»: один лист; вводные, структура себестоимости, границы, таблица цен (НМЦК, −5…−30 % и «Моя цена»),
  антидемпинговое правило, пометки. Строки проверяются как матрица (чистая функция), книга — чтением настоящего файла.
*/

function estimate(withGroups = true): EstimateDocument {
  return {
    title: "Тест",
    parameters: { vatPercent: 20 },
    sections: [{ title: "Раздел", lines: withGroups ? [{ labourCost: 600_000, machineCost: 400_000, materialCost: 1_500_000 }] : [{}] }],
    totals: {
      directCost: 3_000_000,
      wageFund: 800_000,
      overheadCost: 600_000,
      profitCost: 400_000,
      workCost: 4_000_000,
      winterSurcharge: 0,
      temporaryStructures: 0,
      beforeVat: 4_000_000,
      vat: 800_000,
      total: 4_800_000,
    },
  } as unknown as EstimateDocument;
}

function input(overrides: Partial<BidEconomicsInput> = {}): BidEconomicsInput {
  return {
    document: estimate(),
    nmc: 5_400_000,
    billItems: 10,
    droppedPositions: 0,
    assumedPercent: 0,
    unpricedResources: 0,
    company: { taxSystem: "OSNO", minMarginPercent: 10 },
    law: "FZ_44",
    ...overrides,
  };
}

const GENERATED = new Date("2026-10-21T09:00:00Z");
const find = (rows: readonly BidSheetRow[], first: string): BidSheetRow | undefined => rows.find((row) => row.cells[0] === first);
const flat = (rows: readonly BidSheetRow[]): string => rows.map((row) => row.cells.filter((cell) => cell !== null).join(" ")).join("\n");

describe("buildBidSheetRows: состав листа", () => {
  const economics = computeBidEconomics(input({ costProfile: { ...DEFAULT_COST_PROFILE, materialDiscountPercent: 10 } }));
  const myPrice = evaluateMyPrice(economics, { reductionPercent: 30 });
  const rows = buildBidSheetRows({ economics, myPrice, subject: "Ремонт школы", generatedAt: GENERATED });

  it("шапка: название, объект, дата и основа", () => {
    expect(rows[0]).toMatchObject({ kind: "title", cells: ["Расчёт цены участия"] });
    expect(rows[1]!.cells[0]).toBe("Ремонт школы");
    expect(String(rows[2]!.cells[0])).toContain("2026-10-21");
    expect(String(rows[2]!.cells[0])).toContain("наша смета по ведомости");
  });

  it("разделы идут по порядку: вводные, структура, границы, таблица цен, антидемпинг, пометки", () => {
    const sections = rows.filter((row) => row.kind === "section").map((row) => row.cells[0]);
    expect(sections).toEqual([
      "Вводные данные",
      "Структура себестоимости, ₽ без НДС",
      "Границы цены",
      "Таблица цен",
      "Антидемпинговая мера",
      "Допущения и пометки",
    ]);
  });

  it("вводные: НМЦК, НДС, налоги, маржа, закон и все поля профиля затрат", () => {
    expect(find(rows, "НМЦК, ₽")!.cells[1]).toBe(5_400_000);
    expect(find(rows, "НМЦК указана с НДС")!.cells[1]).toBe("да");
    expect(find(rows, "Закон закупки")!.cells[1]).toBe("44-ФЗ");
    expect(String(find(rows, "Налоги")!.cells[1])).toContain("ОСНО");
    const profileRows = rows.filter((row) => String(row.cells[0]).startsWith("Профиль затрат:"));
    expect(profileRows).toHaveLength(6);
    expect(profileRows.find((row) => String(row.cells[0]).includes("Скидка на материалы"))!.cells[1]).toBe(10);
  });

  it("структура себестоимости: «как по смете» и с поправками, итог совпадает с расчётом; нулевые статьи не печатаются", () => {
    const total = rows.find((row) => row.kind === "total" && row.cells[0] === "Себестоимость")!;
    expect(total.cells).toEqual(["Себестоимость", 3_600_000, 3_450_000]);
    expect(find(rows, "Оплата труда рабочих")!.cells).toEqual(["Оплата труда рабочих", 600_000, 600_000]);
    expect(find(rows, "Материалы")!.cells).toEqual(["Материалы", 1_500_000, 1_350_000]);
    expect(find(rows, "Субподряд")).toBeUndefined();
  });

  it("границы цены совпадают с расчётом", () => {
    expect(find(rows, "Безубыточная цена (прибыль после налогов = 0), ₽")!.cells[1]).toBe(economics.breakEvenPrice);
    const minRow = rows.find((row) => String(row.cells[0]).startsWith("Минимальная цена с маржой"))!;
    expect(minRow.cells[1]).toBe(economics.minAcceptablePrice);
    expect(find(rows, "Допустимое снижение от НМЦК, %")!.cells[1]).toBe(economics.maxReductionPercent);
  });

  it("таблица цен: НМЦК, −5 … −30 % и отдельной строкой «Моя цена»", () => {
    const start = rows.findIndex((row) => row.kind === "header" && row.cells[0] === "Цена");
    const table = rows.slice(start + 1, start + 9);
    expect(table.map((row) => row.cells[0])).toEqual(["НМЦК", "НМЦК −5 %", "НМЦК −10 %", "НМЦК −15 %", "НМЦК −20 %", "НМЦК −25 %", "НМЦК −30 %", "Моя цена"]);
    expect(table[0]!.cells[2]).toBe(5_400_000);
    expect(table[6]!.cells[2]).toBe(3_780_000);
    // При 44-ФЗ строки со снижением от 25 % помечены.
    expect(table.map((row) => row.cells[9])).toEqual(["", "", "", "", "", "да", "да", "да"]);
    const mine = table[7]!;
    expect(mine.kind).toBe("total");
    expect(mine.cells[2]).toBe(myPrice!.price);
    expect(mine.cells[6]).toBe(myPrice!.profit);
    expect(mine.cells[8]).toBe("убыток");
  });

  it("антидемпинг: текст правила для названной цены, с НМЦК выше 15 млн или до", () => {
    const section = rows.findIndex((row) => row.cells[0] === "Антидемпинговая мера");
    const text = String(rows[section + 1]!.cells[0]);
    expect(text).toContain("44-ФЗ, ст. 37");
    expect(text).toContain("1,5 раза");
    expect(text).toContain("не выше 15 млн");
  });

  it("без «Моей цены» последней строкой таблицы остаётся НМЦК −30 %", () => {
    const noMine = buildBidSheetRows({ economics, subject: "Объект", generatedAt: GENERATED });
    expect(noMine.some((row) => row.cells[0] === "Моя цена")).toBe(false);
    expect(noMine.some((row) => row.cells[0] === "НМЦК −30 %")).toBe(true);
  });

  it("пометки: надёжность расчёта, пояснения и оговорка об информационном характере", () => {
    const text = flat(rows);
    expect(text).toContain("Надёжность расчёта:");
    expect(text).toContain("Расчёт информационный");
  });

  it("цена выше НМЦК: в файле строка о том, что заявка не принимается", () => {
    const above = evaluateMyPrice(economics, { price: 6_000_000 });
    expect(flat(buildBidSheetRows({ economics, myPrice: above, subject: "О", generatedAt: GENERATED }))).toContain("выше НМЦК");
  });
});

describe("buildBidSheetRows: крайние случаи", () => {
  it("закон не указан: правило условное, «Закон закупки — не указан»", () => {
    const economics = computeBidEconomics(input({ law: undefined }));
    const rows = buildBidSheetRows({ economics, myPrice: evaluateMyPrice(economics, { reductionPercent: 30 }), subject: "О", generatedAt: GENERATED });
    expect(find(rows, "Закон закупки")!.cells[1]).toBe("не указан");
    expect(flat(rows)).toContain("Если закупка по 44-ФЗ");
  });

  it("223-ФЗ: сказано, что статья 37 не применяется", () => {
    const economics = computeBidEconomics(input({ law: "FZ_223" }));
    const rows = buildBidSheetRows({ economics, subject: "О", generatedAt: GENERATED });
    expect(flat(rows)).toContain("223-ФЗ: мер ст. 37 44-ФЗ закон не устанавливает");
  });

  it("НМЦК не объявлена: границы есть, таблицы цен нет, строка «Моя цена» в рублях печатается", () => {
    const economics = computeBidEconomics(input({ nmc: null }));
    const mine = evaluateMyPrice(economics, { price: 4_800_000 });
    const rows = buildBidSheetRows({ economics, myPrice: mine, subject: "О", generatedAt: GENERATED });
    expect(rows.some((row) => row.cells[0] === "НМЦК −5 %")).toBe(false);
    expect(rows.some((row) => row.cells[0] === "Моя цена")).toBe(true);
    expect(find(rows, "НМЦК, ₽")!.cells[1]).toBeNull();
  });

  it("смета без групп затрат (строки без полей): не падает, всё прямое — в «прочих»", () => {
    const economics = computeBidEconomics(input({ document: estimate(false) }));
    const rows = buildBidSheetRows({ economics, subject: "О", generatedAt: GENERATED });
    expect(find(rows, "Прочие прямые затраты (цены заказчика, услуги, свои цены)")!.cells[1]).toBe(3_000_000);
    expect(find(rows, "Оплата труда рабочих")).toBeUndefined();
  });

  it("пустой расчёт: шапка и объяснение, без таблиц", () => {
    const economics = computeBidEconomics(input({ document: undefined }));
    const rows = buildBidSheetRows({ economics, subject: "О", generatedAt: GENERATED });
    expect(rows.some((row) => row.kind === "section")).toBe(false);
    expect(flat(rows)).toContain("Смета не посчитана");
  });

  it("основа — проверка сметы заказчика: основа названа в шапке", () => {
    const economics = computeBidEconomics(auditBidInput(reportWithFindings(), { taxSystem: "OSNO", minMarginPercent: 10 }));
    const rows = buildBidSheetRows({ economics, subject: "О", generatedAt: GENERATED });
    expect(String(rows[2]!.cells[0])).toContain("смета заказчика, пересчитанная по ценам зоны и квартала");
  });
});

describe("buildBidWorkbook: настоящая книга", () => {
  it("один лист «Экономика участия»: числа — числами, формат денег и процентов, объединённые пояснения", async () => {
    const economics = computeBidEconomics(input());
    const myPrice = evaluateMyPrice(economics, { reductionPercent: 10 });
    const bytes = await buildBidWorkbook({ economics, myPrice, subject: "Ремонт школы", generatedAt: GENERATED });
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([BID_SHEET_NAME]);
    const sheet = workbook.getWorksheet(BID_SHEET_NAME)!;

    expect(sheet.getCell("A1").value).toBe("Расчёт цены участия");
    const rows = buildBidSheetRows({ economics, myPrice, subject: "Ремонт школы", generatedAt: GENERATED });
    const nmcRow = rows.findIndex((row) => row.cells[0] === "НМЦК, ₽") + 1;
    expect(sheet.getCell(`B${nmcRow}`).value).toBe(5_400_000);
    expect(sheet.getCell(`B${nmcRow}`).numFmt).toBe("#,##0.00");
    const myRow = rows.findIndex((row) => row.cells[0] === "Моя цена") + 1;
    expect(sheet.getCell(`A${myRow}`).value).toBe("Моя цена");
    expect(sheet.getCell(`C${myRow}`).value).toBe(myPrice!.price);
    expect(sheet.getCell(`I${myRow}`).value).toBe("маржа ниже цели");
    const marginRow = rows.findIndex((row) => String(row.cells[0]).startsWith("Минимальная маржа")) + 1;
    expect(sheet.getCell(`B${marginRow}`).numFmt).toContain("%");
  });

  it("пустой расчёт и смета без групп тоже собираются в книгу", async () => {
    const empty = computeBidEconomics(input({ document: undefined }));
    expect((await buildBidWorkbook({ economics: empty, subject: "О", generatedAt: GENERATED })).byteLength).toBeGreaterThan(1000);
    const bare = computeBidEconomics(input({ document: estimate(false) }));
    expect((await buildBidWorkbook({ economics: bare, subject: "О", generatedAt: GENERATED })).byteLength).toBeGreaterThan(1000);
  });
});

describe("buildBidWorkbook: ноль без знака", () => {
  it("«Моя цена» ровно по НМЦК или с копеечной разницей — в книге 0, а не −0,0 %", async () => {
    const economics = computeBidEconomics(input());
    const mine = { ...evaluateMyPrice(economics, { reductionPercent: 0 })!, reductionPercent: -0.004 };
    const bytes = await buildBidWorkbook({ economics, myPrice: mine, subject: "О", generatedAt: GENERATED });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    const rows = buildBidSheetRows({ economics, myPrice: mine, subject: "О", generatedAt: GENERATED });
    const myRow = rows.findIndex((row) => row.cells[0] === "Моя цена") + 1;
    expect(workbook.getWorksheet(BID_SHEET_NAME)!.getCell(`B${myRow}`).value).toBe(0);
  });
});

describe("bidWorkbookFileName", () => {
  it("объект и день; запрещённые в Windows символы убраны", () => {
    expect(bidWorkbookFileName('Школа: "№5"/ремонт', GENERATED)).toBe("Расчёт цены участия Школа №5ремонт от 2026-10-21.xlsx");
    expect(bidWorkbookFileName("", GENERATED)).toBe("Расчёт цены участия от 2026-10-21.xlsx");
  });
});
