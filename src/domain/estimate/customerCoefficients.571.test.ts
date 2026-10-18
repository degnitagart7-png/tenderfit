import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildEstimate } from "@/domain/estimate/calculate";
import { evaluateCustomerConditions, summarizeCustomerConditions } from "@/domain/estimate/customerCoefficients";
import { parseCustomerLsr, type CustomerPosition } from "@/domain/estimate/customerLsr";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import { EQUIPMENT_DEMOLITION, WORK_CONDITIONS } from "@/domain/estimate/normatives";
import type { BillOfWorkItem, CustomerConditions } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAINAGE_100,
  NORM_MANUAL_GRADING,
  BILL_GRADING,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";
import { LSR_05_13_TEXT } from "@/test/t1118Fixtures";

/*
  Новые официальные источники коэффициентов заказчика:
  — Методика применения сметных норм 571/пр (п. 83, таблица 2 — ГЭСН; п. 84, таблица 3 — ГЭСНм): к труду, машинам и машинистам,
    материалы не учитываются; числа сверены по официальному PDF (571-pr-tablicy-2-3-verified.txt);
  — приложение 8 к 557/пр — новая редакция приложения 10 к 421/пр: «Приказ от 07.07.2022 № 557/пр прил.8 табл.1 п.5».
*/

const SOURCES = resolve("data/fsnb/normatives/sources");
const squash = (text: string): string => text.replace(/\s+/gu, " ");
const VERIFIED = squash(readFileSync(resolve(SOURCES, "571-pr-tablicy-2-3-verified.txt"), "utf8"));
const OCR_571 = squash(readFileSync(resolve(SOURCES, "571-pr-metodika-primeneniya-smetnyh-norm-official-ocr.txt"), "utf8"));
const TEXT_648 = squash(readFileSync(resolve(SOURCES, "648-pr-metodika-fer-official.txt"), "utf8"));
const comma = (value: number): string => String(value).replace(".", ",");

describe("справочник 571/пр: таблицы 2 и 3 сверены по официальному PDF", () => {
  const entries = EQUIPMENT_DEMOLITION.equipmentDemolition;

  it("таблица 2 (ГЭСН): 0,8 / 0,8 / 0,4 / 0,7 / 0,6; таблица 3 (ГЭСНм): 0,7 / 0,6 / 0,5 / 0,3; труд, машины, машинисты — значение, материалы — 0", () => {
    const table = (number: number) => entries.filter((entry) => entry.table === number).sort((a, b) => a.row - b.row);
    expect(table(2).map((entry) => entry.labour)).toEqual([0.8, 0.8, 0.4, 0.7, 0.6]);
    expect(table(3).map((entry) => entry.labour)).toEqual([0.7, 0.6, 0.5, 0.3]);
    expect(entries).toHaveLength(9);
    for (const entry of entries) {
      expect(entry, entry.id).toMatchObject({ sourceId: "571-pr", order: "571/пр", materials: 0, valueVerified: true, textVerified: true });
      expect(entry.machines, entry.id).toBe(entry.labour);
      expect(entry.books, entry.id).toEqual(entry.table === 2 ? ["GESN"] : ["GESNM"]);
    }
  });

  it("каждая строка дословно есть в файле сверки: «№ | подпись | значение»", () => {
    for (const entry of entries) expect(VERIFIED, entry.id).toContain(`${String(entry.row)} | ${entry.title} | ${comma(entry.labour)}`);
  });

  it("фрагменты порядка применения есть в OCR официального текста; подписи 648/пр п. 145 — в тексте 648/пр", () => {
    for (const entry of entries) {
      for (const fragment of entry.fragments) expect(OCR_571, entry.id).toContain(squash(fragment));
      for (const alias of entry.aliases ?? []) {
        expect(alias.order).toBe("648/пр");
        for (const fragment of alias.fragments) expect(TEXT_648, `${entry.id} ← ${alias.point}`).toContain(squash(fragment));
      }
    }
  });

  it("648/пр отдельной записью не стоит: строка таблицы 3 п. 145 — алиас той же строки 571/пр", () => {
    expect(entries.some((entry) => entry.sourceId === "648-pr")).toBe(false);
    const aliased = entries.filter((entry) => (entry.aliases ?? []).length > 0);
    expect(aliased.map((entry) => entry.id)).toEqual(["M571-P84-T3-R1", "M571-P84-T3-R2", "M571-P84-T3-R3", "M571-P84-T3-R4"]);
  });
});

/* --------------------------------- Разбор ссылок заказчика --------------------------------- */

function synthetic(patch: Partial<CustomerPosition> & { notes: CustomerPosition["notes"] }): CustomerPosition {
  return {
    number: 6,
    label: "6",
    code: "ГЭСН22-01-011-02",
    rawJustification: "ГЭСН22-01-011-02",
    book: "GESN",
    coefficients: null,
    hasCoefficients: false,
    name: "Демонтаж трубопроводов ГВС и ХВС в земле",
    unit: "км",
    quantity: 0.57,
    section: null,
    ownUnitPrice: null,
    ownTotal: null,
    ownBasePrice: null,
    ownIndex: null,
    ownPriceCoefficient: null,
    resources: [],
    groupTotals: { labour: 56_810.08, machines: 17_613.37, machinistLabour: 11_995.03, materials: 0 },
    directTotal: 86_418.48,
    wageFund: 68_805.11,
    overhead: null,
    profit: null,
    perUnit: null,
    total: 150_000,
    truncated: false,
    ...patch,
  };
}

const TEXT_T2_R5 = "Сети инженерно-технического обеспечения ОЗП=0,6; ЭМ=0,6 к расх.; ЗПМ=0,6; МАТ=0 к расх.; ТЗ=0,6; ТЗМ=0,6";
const REF_T2_R5 = "571/пр_2022_п.83_т.2_стр.5_ стб.3";

describe("ссылки на 571/пр: подтверждаются по таблице, строке и значению", () => {
  it("«571/пр_2022_п.83_т.2_стр.5_ стб.3», 0,6 на труд, машины и машинистов и 0 на материалы — применяется автоматически", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: [{ ref: REF_T2_R5, text: TEXT_T2_R5 }] }));

    expect(conditions?.rejected).toEqual([]);
    expect(conditions?.special).toMatchObject({ id: "M571-P83-T2-R5", labour: 0.6, machines: 0.6, materials: 0, valueVerified: true });
    expect(conditions?.label).toContain("571/пр п. 83, таблица 2, строка 5");
    expect(conditions?.label).toContain("× 0,6");
    expect(conditions?.enabled).toBe(true);
    expect(conditions?.forceUnconfirmed).toBe(false);
  });

  it("все пять строк таблицы 2 и все четыре строки таблицы 3 находятся по своему номеру", () => {
    const t2 = [0.8, 0.8, 0.4, 0.7, 0.6];
    t2.forEach((value, index) => {
      const row = index + 1;
      const text = `ОЗП=${comma(value)}; ЭМ=${comma(value)} к расх.; ЗПМ=${comma(value)}; МАТ=0 к расх.; ТЗ=${comma(value)}; ТЗМ=${comma(value)}`;
      const conditions = evaluateCustomerConditions(synthetic({ notes: [{ ref: `571/пр_2022_п.83_т.2_стр.${String(row)}_стб.3`, text }] }));
      expect(conditions?.special, `т.2 стр.${String(row)}`).toMatchObject({ id: `M571-P83-T2-R${String(row)}`, labour: value });
    });
    const t3 = [0.7, 0.6, 0.5, 0.3];
    t3.forEach((value, index) => {
      const row = index + 1;
      const text = `ОЗП=${comma(value)}; ЭМ=${comma(value)} к расх.; ЗПМ=${comma(value)}; МАТ=0 к расх.; ТЗ=${comma(value)}; ТЗМ=${comma(value)}`;
      const conditions = evaluateCustomerConditions(
        synthetic({ book: "GESNM", code: "ГЭСНм11-05-001-01", rawJustification: "ГЭСНм11-05-001-01", notes: [{ ref: `571/пр_2022_п.84_т.3_стр.${String(row)}_стб.3`, text }] }),
      );
      expect(conditions?.special, `т.3 стр.${String(row)}`).toMatchObject({ id: `M571-P84-T3-R${String(row)}`, labour: value });
    });
  });

  it("свободные формы: «Методика 571/пр п.83 табл.2 п.5» и «571/пр п. 84 таблица 3 строка 4»", () => {
    const free = evaluateCustomerConditions(synthetic({ notes: [{ ref: "Методика 571/пр п.83 табл.2 п.5", text: "ОЗП=0,6; ЭМ=0,6; МАТ=0" }] }));
    expect(free?.special).toMatchObject({ id: "M571-P83-T2-R5" });

    const verbose = evaluateCustomerConditions(
      synthetic({ book: "GESNM", code: "ГЭСНм11-05-001-01", rawJustification: "ГЭСНм11-05-001-01", notes: [{ ref: "", text: "Демонтаж по 571/пр п. 84 таблица 3 строка 4: ОЗП=0,3; ЭМ=0,3" }] }),
    );
    expect(verbose?.special).toMatchObject({ id: "M571-P84-T3-R4", labour: 0.3 });
  });

  it("только ссылка без напечатанных значений тоже подтверждается: значения берутся из таблицы", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: [{ ref: REF_T2_R5, text: "Сети инженерно-технического обеспечения" }] }));

    expect(conditions?.special).toMatchObject({ id: "M571-P83-T2-R5", labour: 0.6, materials: 0 });
  });

  it("значение не из таблицы (0,5 вместо 0,6) — находка, а не применение", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: [{ ref: REF_T2_R5, text: "ОЗП=0,5; ЭМ=0,5; МАТ=0" }] }));

    expect(conditions?.special).toBeUndefined();
    expect(conditions?.rejected).toHaveLength(1);
    expect(conditions?.rejected[0]?.reason).toContain("не совпадают со строкой 5 таблицы 2");
    expect(conditions?.rejected[0]?.labour).toBe(0.5);
    // Уменьшение у заказчика: сумма отрицательная.
    expect(conditions?.rejected[0]?.amount ?? 0).toBeLessThan(0);
  });

  it("коэффициент к материалам (МАТ=1) — находка: материалы 571/пр не учитывает", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: [{ ref: REF_T2_R5, text: "ОЗП=0,6; ЭМ=0,6; МАТ=1" }] }));

    expect(conditions?.special).toBeUndefined();
    expect(conditions?.rejected[0]?.reason).toContain("материалы не учитываются");
  });

  it("таблица 2 — только к ГЭСН, таблица 3 — только к ГЭСНм: у другой книги — находка", () => {
    const t3OnGesn = evaluateCustomerConditions(synthetic({ notes: [{ ref: "571/пр_2022_п.84_т.3_стр.4_стб.3", text: "ОЗП=0,3; ЭМ=0,3; МАТ=0" }] }));
    expect(t3OnGesn?.special).toBeUndefined();
    expect(t3OnGesn?.rejected[0]?.reason).toContain("ГЭСНм");

    const t2OnGesnm = evaluateCustomerConditions(
      synthetic({ book: "GESNM", code: "ГЭСНм11-05-001-01", rawJustification: "ГЭСНм11-05-001-01", notes: [{ ref: REF_T2_R5, text: TEXT_T2_R5 }] }),
    );
    expect(t2OnGesnm?.special).toBeUndefined();
    expect(t2OnGesnm?.rejected[0]?.reason).toContain("ГЭСН");
  });

  it("несуществующая строка, пункт не от таблицы, ссылка без таблицы — находки с причиной", () => {
    const noRow = evaluateCustomerConditions(synthetic({ notes: [{ ref: "571/пр_2022_п.83_т.2_стр.7_стб.3", text: "ОЗП=0,6; ЭМ=0,6" }] }));
    expect(noRow?.special).toBeUndefined();
    expect(noRow?.rejected[0]?.reason).toContain("нет таблицы 2, строки 7");

    const wrongPoint = evaluateCustomerConditions(synthetic({ notes: [{ ref: "571/пр_2022_п.83_т.3_стр.4_стб.3", text: "ОЗП=0,3; ЭМ=0,3" }] }));
    expect(wrongPoint?.special).toBeUndefined();
    expect(wrongPoint?.rejected[0]?.reason).toContain("п. 83 (таблица 2) и п. 84 (таблица 3)");

    const bare = evaluateCustomerConditions(synthetic({ notes: [{ ref: "571/пр_2022", text: "ОЗП=0,6; ЭМ=0,6" }] }));
    expect(bare?.special).toBeUndefined();
    expect(bare?.rejected[0]?.reason).toContain("нет таблицы и строки");
  });

  it("«Прил. … демонтаж … К=0,6» без ссылки на 571/пр — находка с суммой: значение есть в таблицах, но строка не названа", () => {
    const conditions = evaluateCustomerConditions(synthetic({ notes: [{ ref: "", text: "Прил. Демонтаж сетей К=0,6" }] }));

    expect(conditions?.special).toBeUndefined();
    expect(conditions?.rejected).toHaveLength(1);
    expect(conditions?.rejected[0]?.reason).toContain("571/пр");
    expect(conditions?.rejected[0]?.reason).toContain("п. 83, таблица 2, строка 5");
    expect(conditions?.rejected[0]?.reason).toContain("п. 84, таблица 3, строка 2");
    expect(conditions?.rejected[0]?.amount ?? 0).toBeLessThan(0);
  });

  it("второй коэффициент разборки у той же позиции второй раз не применяется", () => {
    const conditions = evaluateCustomerConditions(
      synthetic({
        notes: [
          { ref: REF_T2_R5, text: TEXT_T2_R5 },
          { ref: "571/пр_2022_п.83_т.2_стр.3_стб.3", text: "ОЗП=0,4; ЭМ=0,4; МАТ=0" },
        ],
      }),
    );

    expect(conditions?.special).toMatchObject({ id: "M571-P83-T2-R5" });
    expect(conditions?.rejected[0]?.reason).toContain("второй раз не применяется");
  });

  it("ссылка на 648/пр п. 145 т. 3 — та же строка таблицы 3 571/пр: применяется, значение подтверждено 571/пр, ссылка заказчика названа", () => {
    const conditions = evaluateCustomerConditions(
      synthetic({
        book: "GESNM",
        code: "ГЭСНм11-05-001-01",
        rawJustification: "ГЭСНм11-05-001-01",
        name: "Механизм исполнительный",
        notes: [{ ref: "648/пр_2022_п.145_т.3_стр.4_стб.3", text: "Демонтаж оборудования, не пригодного для дальнейшего использования (предназначено в лом), без разборки и резки ОЗП=0,3; ЭМ=0,3 к расх.; ЗПМ=0,3; МАТ=0 к расх.; ТЗ=0,3; ТЗМ=0,3" }],
      }),
    );

    expect(conditions?.rejected).toEqual([]);
    expect(conditions?.special).toMatchObject({ id: "M571-P84-T3-R4", labour: 0.3, machines: 0.3, materials: 0, valueVerified: true });
    expect(conditions?.label).toContain("571/пр п. 84, таблица 3, строка 4");
    expect(conditions?.label).toContain("648/пр п. 145, таблица 3, строка 4");
  });

  it("648/пр п. 145 с таблицей 2 или несуществующей строкой не подтверждается: для 648/пр алиасы есть только у таблицы 3", () => {
    const conditions = evaluateCustomerConditions(
      synthetic({ book: "GESNM", code: "ГЭСНм11-05-001-01", rawJustification: "ГЭСНм11-05-001-01", notes: [{ ref: "648/пр_2022_п.145_т.2_стр.5_стб.3", text: "ОЗП=0,6; ЭМ=0,6" }] }),
    );

    expect(conditions?.special).toBeUndefined();
    expect(conditions?.rejected[0]?.reason).toContain("648/пр п. 145");
  });

  it("сводка по ведомости: подтверждённое называется, находок нет, пометки «значение принято по смете» нет", () => {
    const set = buildLsrSet(parseCustomerLsr([{ name: "ЛСР.xlsx", text: LSR_05_13_TEXT }]).estimates);
    const bill = set.entries.map((entry, index) => lsrBillSection(entry, index + 1).section.items).flat();
    const summary = summarizeCustomerConditions(bill);

    expect(summary.confirmed).toBeGreaterThan(0);
    expect(summary.notes.some((note) => note.includes("571/пр п. 84, таблица 3, строка 4"))).toBe(true);
    expect(summary.notes.some((note) => note.includes("значение принято по смете заказчика"))).toBe(false);
  });
});

/* ----------------- Через разбор ЛСР: закупка 0891200000626010037, поз. 6 (0,57 км) ----------------- */

const HEADER_LINES = LSR_05_13_TEXT.split("\n").slice(0, 40);

function lsrWith(rows: readonly string[]): string {
  const numbering = HEADER_LINES.findIndex((line) => line.startsWith("1,2,3,"));
  expect(numbering).toBeGreaterThan(0);
  const footer = [',,Всего,,,,,,,,,,,,,"100,000.00"', ',,ВСЕГО по смете,,,,,,,,,,,,,"120,000.00"'];
  return [...HEADER_LINES.slice(0, numbering + 1), "Раздел 1. Тест", ...rows, ...footer].join("\n");
}

const POSITION_6 = [
  '6,"ГЭСН22-01-011-02","Демонтаж трубопроводов ГВС и ХВС в земле",,,,,км,0.57,1,0.57,,,,,',
  `,${REF_T2_R5},"${TEXT_T2_R5}",,,,,,,,,,,,,`,
  ',1,ОТ(ЗТ),,,,,чел.-ч,,,200,,,,,"56,810.08"',
  ",2,ЭМ,,,,,,,,,,,,,\"17,613.37\"",
  ",,ОТм(ЗТм),,,,,чел.-ч,,,30,,,,,\"11,995.03\"",
  ",4,М,,,,,,,,,,,,,0.00",
  ',,Итого прямые затраты,,,,,,,,,,,,,"86,418.48"',
  ',,ФОТ,,,,,,,,,,,,,"68,805.11"',
  ',,Всего по позиции,,,,,,,,,,,"100,000.00",,"100,000.00"',
];

describe("ЛСР закупки 0891200000626010037, поз. 6: разбор → ведомость → расчёт", () => {
  const wage = buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);
  const book = makePriceBook(wage);
  const calc = (item: BillOfWorkItem, norm = NORM_DRAINAGE_100) =>
    buildEstimate({
      title: "Тест",
      sections: [makeBillSection("ЛСР", [item])],
      priceBook: book,
      parameters: makeParameters(),
      resolveNorm: makeResolver([norm]),
      sources: [],
      generatedAt: "2026-10-10T00:00:00.000Z",
      disclaimer: "тест",
    }).sections[0]?.lines[0];

  /** Норма дренажа вместо ГЭСН22-01-011-02 (её состава в тестовых данных нет): труд, машины, материалы; позиция 570 м = 0,57 км. */
  const standIn = (patch: Partial<BillOfWorkItem> = {}): BillOfWorkItem =>
    makeBillItem({ id: "pos6", workName: item.workName, quantity: 570, quantityUnit: "м", unitDivisor: 1000, normCode: "01-01-129-11", normBaseType: "ГЭСН", ...patch });

  const parsed = buildLsrSet(parseCustomerLsr([{ name: "ЛСР.xlsx", text: lsrWith(POSITION_6) }]).estimates);
  const item = parsed.entries.map((entry, index) => lsrBillSection(entry, index + 1).section.items).flat()[0] as BillOfWorkItem;

  it("пояснение «571/пр_2022_п.83_т.2_стр.5_ стб.3» разобрано и подтверждено у позиции ведомости", () => {
    expect(item).toBeDefined();
    expect(item.customerConditions?.special).toMatchObject({ id: "M571-P83-T2-R5", labour: 0.6, machines: 0.6, materials: 0, valueVerified: true });
    expect(item.customerConditions?.rejected).toEqual([]);
    expect(item.sourceQuote).toContain("применены");
    expect(item.sourceQuote).toContain("571/пр п. 83, таблица 2, строка 5");
  });

  it("цифры позиции 6: 0,6 × 94 683,45 = 56 810,07 (у заказчика ОТ 56 810,08); ОТм и ЭМ у заказчика уже с коэффициентом", () => {
    const special = item.customerConditions?.special;
    expect(special).toBeDefined();
    expect(Math.round(94_683.45 * (special?.labour ?? 1) * 100) / 100).toBe(56_810.07);
    expect(Math.abs(Math.round(94_683.45 * (special?.labour ?? 1) * 100) / 100 - 56_810.08)).toBeLessThan(0.011);
    // Прямые затраты заказчика = ОТ + ЭМ + ОТм + М (М = 0).
    expect(56_810.08 + 17_613.37 + 11_995.03 + 0).toBeCloseTo(86_418.48, 2);
  });

  it("в расчёте: труд, машины и машинисты × 0,6, материалы — 0", () => {
    const plain = calc(standIn());
    const applied = calc(standIn({ customerConditions: item.customerConditions as CustomerConditions }));

    expect(plain?.materialCost).toBeGreaterThan(0);
    expect(plain?.labourCost).toBeGreaterThan(0);
    expect(applied?.labourHours).toBeCloseTo((plain?.labourHours ?? 0) * 0.6, 3);
    expect(applied?.labourCost).toBeCloseTo((plain?.labourCost ?? 0) * 0.6, 1);
    expect(applied?.machineHours).toBeCloseTo((plain?.machineHours ?? 0) * 0.6, 3);
    expect(applied?.machineCost).toBeCloseTo((plain?.machineCost ?? 0) * 0.6, 1);
    expect(applied?.machinistSalaryCost).toBeCloseTo((plain?.machinistSalaryCost ?? 0) * 0.6, 1);
    expect(applied?.materialCost).toBe(0);
    expect(applied?.coefficients?.customer?.applied).toContain("M571-P83-T2-R5");
    expect(applied?.coefficients?.materials).toBe(0);
    expect(applied?.directCost).toBeCloseTo((applied?.labourCost ?? 0) + (applied?.machineCost ?? 0), 2);
  });

  it("снятие применения (enabled = false) возвращает расход нормы", () => {
    const plain = calc(standIn());
    const off = calc(standIn({ customerConditions: { ...(item.customerConditions as CustomerConditions), enabled: false } }));

    expect(off?.labourCost).toBeCloseTo(plain?.labourCost ?? 0, 2);
    expect(off?.materialCost).toBeCloseTo(plain?.materialCost ?? 0, 2);
  });

  it("умножается на коэффициенты условий работ: 0,6 с T1-5 (1,15) — труд × 0,69", () => {
    const withCondition: CustomerConditions = {
      ...(item.customerConditions as CustomerConditions),
      confirmed: { conditionIds: ["T1-5"], p58: false, phase: "CONSTRUCTION" },
    };
    const plain = calc(BILL_GRADING, NORM_MANUAL_GRADING);
    const both = calc({ ...BILL_GRADING, customerConditions: withCondition }, NORM_MANUAL_GRADING);

    expect(both?.labourHours).toBeCloseTo((plain?.labourHours ?? 0) * 0.6 * 1.15, 3);
  });
});

/* ------------------- 557/пр прил. 8 как новая редакция прил. 10 к 421/пр ------------------- */

describe("справочник приложения 10: тексты и значения, на которые ссылается 557/пр прил. 8", () => {
  it("T1-4 — 1,2, T1-5 — 1,15, тексты как в приложении 8 к 557/пр", () => {
    const find = (id: string) => WORK_CONDITIONS.conditions.find((condition) => condition.id === id);
    expect(find("T1-5")).toMatchObject({ table: 1, item: "5", text: "Производство работ осуществляется в стесненных условиях населенных пунктов", coefficients: { gesn: 1.15, gesnm: 1.15, gesnr: 1.15 } });
    expect(find("T1-4")?.text).toContain("в охранной зоне действующей воздушной линии электропередачи");
    expect(find("T1-4")?.coefficients).toMatchObject({ gesn: 1.2, gesnm: 1.2, gesnr: 1.2 });
  });
});

const TEXT_T1_4 =
  "Производство работ осуществляется в охранной зоне действующей воздушной линии электропередачи, вблизи объектов, находящихся под напряжением, внутри объектов капитального строительства, внутренняя проводка в которых не обесточена, если это приведет к ограничению действий рабочих в соответствии с требованиями техники безопасности";
const NOTE_T1_4 = { ref: "Приказ от 07.07.2022 № 557/пр прил.8 табл.1 п.4", text: `${TEXT_T1_4} ОЗП=1,2; ЭМ=1,2 к расх.; ЗПМ=1,2; ТЗ=1,2; ТЗМ=1,2` };
const NOTE_T1_5 = {
  ref: "Приказ от 07.07.2022 № 557/пр прил.8 табл.1 п.5",
  text: "Производство работ осуществляется в стесненных условиях населенных пунктов ОЗП=1,15; ЭМ=1,15 к расх.; ЗПМ=1,15; ТЗ=1,15; ТЗМ=1,15",
};
const GESN_01_02_057_02 = { code: "ГЭСН01-02-057-02", rawJustification: "ГЭСН01-02-057-02", name: "Разработка грунта вручную в траншеях" } as const;

describe("ссылка «Приказ от 07.07.2022 № 557/пр прил.8 табл.N п.M» — то же, что приложение 10 к 421/пр, таблица N, п. M", () => {
  it("T1-5: «стеснённые условия населённых пунктов» подтверждена, ссылка заказчика названа в подписи", () => {
    const conditions = evaluateCustomerConditions(synthetic({ ...GESN_01_02_057_02, notes: [NOTE_T1_5] }));

    expect(conditions?.rejected).toEqual([]);
    expect(conditions?.confirmed).toMatchObject({ conditionIds: ["T1-5"], p58: false, phase: "CONSTRUCTION" });
    expect(conditions?.label).toContain("приложение 10 к 421/пр, таблица 1, п. 5 (К = 1,15)");
    expect(conditions?.label).toContain("557/пр прил. 8");
  });

  it("два условия на одной позиции (закупка 32616408487, ГЭСН01-02-057-02): T1-4 и T1-5 подтверждены оба", () => {
    const conditions = evaluateCustomerConditions(synthetic({ ...GESN_01_02_057_02, notes: [NOTE_T1_4, NOTE_T1_5] }));

    expect(conditions?.rejected).toEqual([]);
    expect(conditions?.confirmed?.conditionIds).toEqual(["T1-4", "T1-5"]);
  });

  it("тот же результат, что у родной ссылки «421/пр_2020_прил.10_т.1_п.5»", () => {
    const viaAmending = evaluateCustomerConditions(synthetic({ ...GESN_01_02_057_02, notes: [NOTE_T1_5] }));
    const native = evaluateCustomerConditions(synthetic({ ...GESN_01_02_057_02, notes: [{ ref: "421/пр_2020_прил.10_т.1_п.5_гр.3", text: NOTE_T1_5.text }] }));

    expect(viaAmending?.confirmed).toEqual(native?.confirmed);
  });

  it("сметы коэффициентов: производительность складывается по п. 52 — труд и машины × (1 + 0,2 + 0,15) = 1,35", () => {
    const conditions = evaluateCustomerConditions(synthetic({ ...GESN_01_02_057_02, notes: [NOTE_T1_4, NOTE_T1_5] })) as CustomerConditions;
    const book = makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE));
    const calc = (item: BillOfWorkItem) =>
      buildEstimate({
        title: "Тест",
        sections: [makeBillSection("ЛСР", [item])],
        priceBook: book,
        parameters: makeParameters(),
        resolveNorm: makeResolver([NORM_MANUAL_GRADING]),
        sources: [],
        generatedAt: "2026-10-10T00:00:00.000Z",
        disclaimer: "тест",
      }).sections[0]?.lines[0];
    const plain = calc(BILL_GRADING);
    const applied = calc({ ...BILL_GRADING, customerConditions: conditions });

    expect(applied?.labourHours).toBeCloseTo((plain?.labourHours ?? 0) * 1.35, 3);
    expect(applied?.labourCost).toBeCloseTo((plain?.labourCost ?? 0) * 1.35, 1);
    expect(applied?.coefficients?.conditionIds).toEqual(["T1-4", "T1-5"]);
    expect(applied?.coefficients?.customer?.applied).toEqual(["T1-4", "T1-5"]);
  });

  it("значение в смете не из таблицы (1,3 вместо 1,15) — не подтверждается", () => {
    const conditions = evaluateCustomerConditions(
      synthetic({ ...GESN_01_02_057_02, notes: [{ ref: NOTE_T1_5.ref, text: "Производство работ осуществляется в стесненных условиях населенных пунктов ОЗП=1,3; ЭМ=1,3" }] }),
    );

    expect(conditions?.confirmed).toBeNull();
    expect(conditions?.rejected[0]?.reason).toContain("а таблица 1, п. 5 даёт 1,15");
  });

  it("текст пункта в смете не тот, что в таблице — не подтверждается (ссылка косвенная, текст сверяется)", () => {
    const conditions = evaluateCustomerConditions(
      synthetic({ ...GESN_01_02_057_02, notes: [{ ref: NOTE_T1_5.ref, text: "Работа в подвале, трудно доступное место ОЗП=1,15; ЭМ=1,15" }] }),
    );

    expect(conditions?.confirmed).toBeNull();
    expect(conditions?.rejected[0]?.reason).toContain("текст пункта в смете не совпадает");
  });

  it("многоточие в тексте заказчика — пропуск, а не расхождение", () => {
    const conditions = evaluateCustomerConditions(
      synthetic({ ...GESN_01_02_057_02, notes: [{ ref: NOTE_T1_4.ref, text: "Производство работ осуществляется в охранной зоне действующей воздушной линии электропередачи… ОЗП=1,2; ЭМ=1,2 к расх.; ЗПМ=1,2; ТЗ=1,2; ТЗМ=1,2" }] }),
    );

    expect(conditions?.confirmed?.conditionIds).toEqual(["T1-4"]);
  });

  it("несуществующий пункт приложения 8 — не подтверждается, причина называет 557/пр", () => {
    const conditions = evaluateCustomerConditions(synthetic({ ...GESN_01_02_057_02, notes: [{ ref: "Приказ от 07.07.2022 № 557/пр прил.8 табл.1 п.77", text: "Условие ОЗП=1,2" }] }));

    expect(conditions?.confirmed).toBeNull();
    expect(conditions?.rejected[0]?.reason).toContain("557/пр");
  });

  it("другое приложение 557/пр (прил. 5) приложением 10 не считается", () => {
    const conditions = evaluateCustomerConditions(synthetic({ ...GESN_01_02_057_02, notes: [{ ref: "Приказ от 07.07.2022 № 557/пр прил.5 табл.1 п.5", text: "ОЗП=1,15; ЭМ=1,15" }] }));

    expect(conditions?.confirmed).toBeNull();
    expect(conditions?.rejected).toHaveLength(1);
  });

  it("из разбора ЛСР: две строки ссылки «Приказ от … № 557/пр прил.8 …» под позицией дают T1-4 и T1-5", () => {
    const rows = [
      '1,"ГЭСН01-02-057-02","Разработка грунта вручную в траншеях",,,,,100 м3,1,1,1,,,,,',
      `,"${NOTE_T1_4.ref}","${NOTE_T1_4.text}",,,,,,,,,,,,,`,
      `,"${NOTE_T1_5.ref}","${NOTE_T1_5.text}",,,,,,,,,,,,,`,
      ',1,ОТ(ЗТ),,,,,чел.-ч,,,200,,,,,"10,000.00"',
      ',2,ЭМ,,,,,,,,,,,,,"2,000.00"',
      ",,ОТм(ЗТм),,,,,чел.-ч,,,0,,,,,0.00",
      ",4,М,,,,,,,,,,,,,0.00",
      ',,Итого прямые затраты,,,,,,,,,,,,,"12,000.00"',
      ',,Всего по позиции,,,,,,,,,,,"12,000.00",,"12,000.00"',
    ];
    const set = buildLsrSet(parseCustomerLsr([{ name: "ЛСР.xlsx", text: lsrWith(rows) }]).estimates);
    const bill = set.entries.map((entry, index) => lsrBillSection(entry, index + 1).section.items).flat();

    expect(bill).toHaveLength(1);
    expect(bill[0]?.customerConditions?.confirmed?.conditionIds).toEqual(["T1-4", "T1-5"]);
    expect(bill[0]?.customerConditions?.rejected).toEqual([]);
  });
});

describe("makeBillItem: ведомость без коэффициентов заказчика не меняется", () => {
  it("позиция без пояснений не получает customerConditions", () => {
    expect(evaluateCustomerConditions(synthetic({ notes: [] }))).toBeNull();
    expect(makeBillItem().customerConditions).toBeUndefined();
  });
});
