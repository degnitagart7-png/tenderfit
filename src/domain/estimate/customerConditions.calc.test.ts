import { describe, expect, it } from "vitest";

import { computeAssurance } from "@/domain/estimate/assurance";
import { applyBillEdits, clearEdit, describeBillEdits, recordEdit, type BillEdit } from "@/domain/estimate/billEdits";
import { buildEstimate } from "@/domain/estimate/calculate";
import type { BillOfWorkItem, CustomerConditions, EstimateDocument, WorkConditionsApplication } from "@/domain/estimate/types";
import { resolveItemCoefficients } from "@/domain/estimate/workConditions";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_GRADING,
  NORM_MANUAL_GRADING,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  Коэффициенты заказчика в расчёте: подтверждённые применяются как у заказчика, неподтверждённые — нет,
  снимаются общим переключателем и правкой строки, не применяются дважды с условиями, выбранными человеком.
  Норма — планировка вручную: один ресурс, труд 86,5 чел.-ч на 1000 м2, 800 м2 → 69,2 чел.-ч.
*/

const PRICE_BOOK = makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE));
const RESOLVE = makeResolver([NORM_MANUAL_GRADING]);

const PREMISES: CustomerConditions = {
  confirmed: { conditionIds: ["T3-1.1"], p58: false, phase: "RECONSTRUCTION" },
  rejected: [],
  label: "как у заказчика: приложение 10 к 421/пр, таблица 3, п. 1.1 (К = 1,2)",
  enabled: true,
  forceUnconfirmed: false,
};

const withConditions = (conditions: CustomerConditions | undefined, parameters = makeParameters()) => {
  const item: BillOfWorkItem = { ...BILL_GRADING, ...(conditions === undefined ? {} : { customerConditions: conditions }) };
  const document = buildEstimate({
    title: "Тест",
    sections: [makeBillSection("ЛСР", [item])],
    priceBook: PRICE_BOOK,
    parameters,
    resolveNorm: RESOLVE,
    sources: [],
    generatedAt: "2026-10-09T00:00:00.000Z",
    disclaimer: "тест",
  });
  return { document, line: document.sections[0]?.lines[0] };
};

const withGlobal = (application: WorkConditionsApplication) => makeParameters({ workConditions: application });

describe("подтверждённый коэффициент применён", () => {
  it("труд ×1,2 как у заказчика: часы, оплата и накладные растут; в строке — пометка «как у заказчика»", () => {
    const base = withConditions(undefined).line;
    const applied = withConditions(PREMISES).line;

    expect(base?.labourHours).toBeCloseTo(69.2, 6);
    expect(applied?.labourHours).toBeCloseTo(83.04, 6);
    expect(applied?.labourCost).toBeCloseTo((base?.labourCost ?? 0) * 1.2, 2);
    expect(applied?.overheadCost).toBeGreaterThan(base?.overheadCost ?? 0);
    expect(applied?.coefficients?.conditionIds).toEqual(["T3-1.1"]);
    expect(applied?.coefficients?.customer).toMatchObject({ applied: ["T3-1.1"], duplicates: [], skipped: [], manual: false });
    expect(applied?.coefficients?.customer?.label).toContain("как у заказчика");
  });

  it("п. 58: 1,15 к труду, 1,25 к машинам — вид работ берётся «капремонт», если человек его не выбирал", () => {
    const factors = resolveItemCoefficients(
      undefined,
      { ...PREMISES, confirmed: { conditionIds: [], p58: true, phase: "CAPITAL_REPAIR" } },
      { baseType: "ГЭСН", collectionCode: "15", name: "Облицовка откосов" },
    );

    expect(factors).toMatchObject({ labour: 1.15, machines: 1.25, adjustmentIds: ["P58"] });
  });

  it("в сводке нормативов появляется «Коэффициенты заказчика»: сколько позиций получили", () => {
    const { document } = withConditions(PREMISES);
    const customer = document.appliedNormatives?.find((item) => item.code === "CUSTOMER_COEFFICIENTS");

    expect(customer?.applied).toBe(true);
    expect(customer?.value).toContain("применены к 1 из 1 позиций");
  });

  it("подтверждённое допущением не считается", () => {
    const { document } = withConditions(PREMISES);

    expect(computeAssurance(document).assumptions.some((item) => item.kind === "CUSTOMER_COEFFICIENT_MANUAL")).toBe(false);
  });

  it("позиция, к которой условие не подходит (ГЭСНр: в таблице прочерк), называется пропущенной, коэффициента нет", () => {
    const factors = resolveItemCoefficients(undefined, PREMISES, { baseType: "ГЭСНр", collectionCode: "56", name: "Демонтаж" });

    expect(factors?.customer?.skipped).toEqual(["T3-1.1"]);
    expect(factors?.labour).toBe(1);
  });
});

describe("неподтверждённый коэффициент не применён", () => {
  const rejectedOnly: CustomerConditions = {
    confirmed: null,
    rejected: [{ text: "ОЗП=0,3; ТЗ=0,3", reason: "ссылка «648/пр» не относится к приложению 10", amount: -648, labour: 0.3, machines: null }],
    label: "",
    enabled: true,
    forceUnconfirmed: false,
  };

  it("расход нормы без изменений, пометок о применении нет", () => {
    const { line } = withConditions(rejectedOnly);

    expect(line?.labourHours).toBeCloseTo(69.2, 6);
    expect(line?.coefficients).toBeUndefined();
  });

  it("человек включил значения заказчика вручную: применены и названы допущением", () => {
    const { line, document } = withConditions({ ...rejectedOnly, forceUnconfirmed: true });

    expect(line?.labourHours).toBeCloseTo(69.2 * 0.3, 6);
    expect(line?.coefficients?.customer?.manual).toBe(true);
    expect(line?.coefficients?.adjustmentIds).toContain("CUSTOMER_MANUAL");
    const assumption = computeAssurance(document).assumptions.find((item) => item.kind === "CUSTOMER_COEFFICIENT_MANUAL");
    expect(assumption?.cost).toBeGreaterThan(0);
  });
});

describe("отключение", () => {
  it("глобально: у всех позиций enabled = false — расчёт по нормам без коэффициентов заказчика", () => {
    const { line } = withConditions({ ...PREMISES, enabled: false });

    expect(line?.labourHours).toBeCloseTo(69.2, 6);
    expect(line?.coefficients).toBeUndefined();
  });

  it("по одной позиции: правка coefficients снимает, а повторная — возвращает; запись правки заменяется, а не копится", () => {
    const sections = [makeBillSection("ЛСР", [{ ...BILL_GRADING, customerConditions: PREMISES }])];
    const anchor = { itemId: BILL_GRADING.id, workName: BILL_GRADING.workName, quantity: 800, unit: "м2", positionNumber: null, normCode: "01-01-111-01", section: null };
    const off: BillEdit = { kind: "coefficients", anchor, apply: false };

    const disabled = applyBillEdits(sections, [off]).sections[0]?.items[0];
    expect(disabled?.customerConditions?.enabled).toBe(false);
    expect(withConditions(disabled?.customerConditions).line?.labourHours).toBeCloseTo(69.2, 6);

    const edits = recordEdit(recordEdit([], off), { ...off, apply: true });
    expect(edits).toHaveLength(1);
    const back = applyBillEdits(sections, edits).sections[0]?.items[0];
    expect(back?.customerConditions?.enabled).toBe(true);
    // У позиции с подтверждённым значением включение не тянет неподтверждённые.
    expect(back?.customerConditions?.forceUnconfirmed).toBe(false);

    expect(clearEdit(edits, BILL_GRADING.id, "coefficients")).toEqual([]);
  });

  it("позиция без коэффициентов заказчика: правка не находит строку; описана словами", () => {
    const sections = [makeBillSection("ЛСР", [BILL_GRADING])];
    const anchor = { itemId: BILL_GRADING.id, workName: BILL_GRADING.workName, quantity: 800, unit: "м2", positionNumber: null, normCode: null, section: null };
    const edit: BillEdit = { kind: "coefficients", anchor, apply: false };

    expect(applyBillEdits(sections, [edit]).unmatched).toEqual([edit]);
    expect(describeBillEdits({ baseSections: sections, edits: [edit] })[0]?.notes).toEqual(["коэффициенты заказчика сняты"]);
  });

  it("у позиции только с неподтверждёнными значениями включение применяет их вручную", () => {
    const rejected: CustomerConditions = { confirmed: null, rejected: [{ text: "ОЗП=1,3", reason: "нет ссылки", amount: 100, labour: 1.3, machines: null }], label: "", enabled: true, forceUnconfirmed: false };
    const sections = [makeBillSection("ЛСР", [{ ...BILL_GRADING, customerConditions: rejected }])];
    const anchor = { itemId: BILL_GRADING.id, workName: BILL_GRADING.workName, quantity: 800, unit: "м2", positionNumber: null, normCode: null, section: null };

    const item = applyBillEdits(sections, [{ kind: "coefficients", anchor, apply: true }]).sections[0]?.items[0];
    expect(item?.customerConditions?.forceUnconfirmed).toBe(true);
  });
});

describe("нет двойного применения", () => {
  const phaseApp: WorkConditionsApplication = { phase: "RECONSTRUCTION", conditionIds: ["T3-1.1"], newConstructionNorms: false };

  it("то же условие выбрано человеком глобально: коэффициент один раз, у строки — «второй раз не применялось»", () => {
    const globalOnly = withConditions(undefined, withGlobal(phaseApp)).line;
    const both = withConditions(PREMISES, withGlobal(phaseApp)).line;

    expect(globalOnly?.labourHours).toBeCloseTo(83.04, 6);
    expect(both?.labourHours).toBeCloseTo(83.04, 6);
    expect(both?.coefficients?.customer).toMatchObject({ applied: [], duplicates: ["T3-1.1"] });
  });

  it("п. 58 выбран человеком и подтверждён у заказчика: ×1,15 один раз", () => {
    const app: WorkConditionsApplication = { phase: "CAPITAL_REPAIR", conditionIds: [], newConstructionNorms: true };
    const customer: CustomerConditions = { ...PREMISES, confirmed: { conditionIds: [], p58: true, phase: "CAPITAL_REPAIR" } };
    const factors = resolveItemCoefficients(app, customer, { baseType: "ГЭСН", collectionCode: "15", name: "Облицовка" });

    expect(factors?.labour).toBe(1.15);
    expect(factors?.customer?.duplicates).toEqual(["P58"]);
  });

  it("условие заказчика другой группы складывается с выбранным человеком по п. 52, а не умножается", () => {
    // T3-1.2 (1,35) и T3-1.1 (1,2) — подпункты одного пункта: берётся одно, большее.
    const factors = resolveItemCoefficients(
      { phase: "RECONSTRUCTION", conditionIds: ["T3-1.2"], newConstructionNorms: false },
      PREMISES,
      { baseType: "ГЭСН", collectionCode: "01", name: "Планировка" },
    );

    expect(factors?.labour).toBe(1.35);
  });

  it("человек выбрал другой вид работ: условие заказчика другой таблицы не применяется и называется пропущенным", () => {
    const factors = resolveItemCoefficients(
      { phase: "CONSTRUCTION", conditionIds: [], newConstructionNorms: false },
      PREMISES,
      { baseType: "ГЭСН", collectionCode: "01", name: "Планировка" },
    );

    expect(factors?.customer?.skipped).toEqual(["T3-1.1"]);
    expect(factors?.labour).toBe(1);
  });
});

describe("п. 58 и «Установка и разборка лесов»", () => {
  it("полный цикл временной конструкции — не разборка по п. 59: условие применимо; настоящий демонтаж — нет", () => {
    const app: WorkConditionsApplication = { phase: "CAPITAL_REPAIR", conditionIds: [], newConstructionNorms: true };

    expect(resolveItemCoefficients(app, undefined, { baseType: "ГЭСН", collectionCode: "08", name: "Установка и разборка наружных инвентарных лесов высотой до 16 м" })?.labour).toBe(1.15);
    expect(resolveItemCoefficients(app, undefined, { baseType: "ГЭСН", collectionCode: "08", name: "Разборка облицовки стен" })).toBeNull();
  });
});

describe("документ без коэффициентов заказчика не меняется", () => {
  it("нет customerConditions — строка и сводка прежние", () => {
    const { document, line } = withConditions(undefined);

    expect(line?.coefficients).toBeUndefined();
    expect((document as EstimateDocument).appliedNormatives?.some((item) => item.code === "CUSTOMER_COEFFICIENTS") ?? false).toBe(false);
  });
});
