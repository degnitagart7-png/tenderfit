import { describe, expect, it } from "vitest";

import { buildEstimate, computeEstimateLine, computeTotals } from "@/domain/estimate/calculate";
import {
  classifyPosition,
  conditionsOfPhase,
  detectConditionHints,
  describeWorkConditions,
  normColumn,
  resolveLineCoefficients,
  workConditionsSentence,
} from "@/domain/estimate/workConditions";
import type { NormRecord, WorkConditionsApplication } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  Условия производства работ (421/пр, приложение 10): к чему применяется коэффициент, как они
  складываются, к каким позициям и книгам не применяются. Значения — из приложения 10 (таблица 5 —
  капитальный ремонт), правила — из п. 52, 56, 58, 59 Методики.
*/

const priceBook = makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE));

const repair = (conditionIds: readonly string[], newConstructionNorms = false): WorkConditionsApplication => ({
  phase: "CAPITAL_REPAIR",
  conditionIds,
  newConstructionNorms,
});

const withCollection = (norm: NormRecord, collectionCode: string, patch: Partial<NormRecord> = {}): NormRecord => ({
  ...norm,
  collectionCode,
  ...patch,
});

function line(norm: NormRecord, application: WorkConditionsApplication | undefined, name = "Разработка грунта") {
  const item = makeBillItem({ workName: name, quantity: 1000, unitDivisor: 1000 });
  const result = computeEstimateLine(item, { norm, reasons: [] }, priceBook, makeParameters(application === undefined ? {} : { workConditions: application }));
  if (result.line === null) throw new Error("строка не посчитана");
  return result.line;
}

describe("колонки коэффициентов: по книге и сборнику", () => {
  it("ГЭСН 46 стоит в третьей колонке с ГЭСНр; ГЭСНмр коэффициентов не имеет", () => {
    expect(normColumn("ГЭСН", "01")).toBe("gesn");
    expect(normColumn("ГЭСН", "46")).toBe("gesnr");
    expect(normColumn("ГЭСНр", "69")).toBe("gesnr");
    expect(normColumn("ГЭСНм", "01")).toBe("gesnm");
    expect(normColumn("ГЭСНп", "01")).toBe("gesnp");
    expect(normColumn("ГЭСНмр", "01")).toBeNull();
  });

  it("позиции: разборка, кровля, территория, наружные работы", () => {
    expect(classifyPosition("Разборка кирпичных стен", "08").demolition).toBe(true);
    expect(classifyPosition("Демонтаж оконных блоков", "46").demolition).toBe(true);
    expect(classifyPosition("Устройство кровли из профнастила", "12")).toMatchObject({ roof: true, exterior: true, demolition: false });
    expect(classifyPosition("Устройство покрытий из асфальтобетона", "27").publicArea).toBe(true);
    expect(classifyPosition("Окраска стен", "15")).toMatchObject({ roof: false, exterior: false });
  });
});

describe("ремонт в эксплуатируемом здании: к чему применяется и у каких позиций", () => {
  const base = line(NORM_DRAGLINE_15, undefined);

  it("без выбора условий расчёт не меняется: строка без поля коэффициентов и с прежними суммами", () => {
    expect(base.coefficients).toBeUndefined();
    expect(line(NORM_DRAGLINE_15, repair([]))).toEqual(base);
    expect(line(NORM_DRAGLINE_15, undefined)).toEqual(base);
  });

  it("«в жилых помещениях без расселения» (таблица 5, п. 8): ×1,50 к труду, часам машин и машинистов; материалы без изменений", () => {
    const k = line(NORM_DRAGLINE_15, repair(["T5-8"]));
    expect(k.coefficients).toEqual({ labour: 1.5, machines: 1.5, wage: 1, conditionIds: ["T5-8"], adjustmentIds: [] });
    expect(k.labourHours).toBeCloseTo(base.labourHours * 1.5, 3);
    expect(k.machineHours).toBeCloseTo(base.machineHours * 1.5, 3);
    expect(k.machinistHours).toBeCloseTo(base.machinistHours * 1.5, 3);
    expect(k.labourCost).toBeCloseTo(base.labourCost * 1.5, 1);
    expect(k.materialCost).toBe(base.materialCost);
    // НР и СП считаются от ФОТ, а он вырос вместе с трудом и машинистами.
    expect(k.wageFund).toBeGreaterThan(base.wageFund);
    expect(k.overheadCost).toBeGreaterThan(base.overheadCost);
    // Ставки не менялись: коэффициент — расход, а не оплата.
    expect(k.labourRate).toBe(base.labourRate);
  });

  it("несколько условий одной таблицы складываются по дробным частям: 1,20 + 1,20 → 1,40, а не 1,44 (п. 52)", () => {
    const k = line(NORM_DRAGLINE_15, repair(["T5-1.1", "T5-4"]));
    expect(k.coefficients?.labour).toBe(1.4);
    expect(k.coefficients?.machines).toBe(1.4);
  });

  it("подпункты одного пункта взаимоисключающи: 1.1 и 1.2 дают наибольшее (1,35), не сумму", () => {
    const k = line(NORM_DRAGLINE_15, repair(["T5-1.1", "T5-1.2"]));
    expect(k.coefficients?.labour).toBe(1.35);
    expect(k.coefficients?.conditionIds).toEqual(["T5-1.2"]);
  });

  it("колонка ГЭСНр и ГЭСН 81-02-46: п. 1.1 там прочерк (к этим нормам не применяется), п. 1.2 — 1,15", () => {
    const rep = line(withCollection(NORM_DRAGLINE_15, "46"), repair(["T5-1.1"]));
    expect(rep.coefficients).toBeUndefined();
    const rep2 = line(withCollection(NORM_DRAGLINE_15, "46"), repair(["T5-1.2"]));
    expect(rep2.coefficients?.labour).toBe(1.15);
  });

  it("кровля средней сложности (п. 9.2) — только к позиции кровли, остальным — общее п. 9.1", () => {
    const application = repair(["T5-9.1", "T5-9.2"]);
    const roof = line(withCollection(NORM_MANUAL_GRADING, "12"), application, "Устройство кровель из рулонных материалов");
    const wall = line(NORM_MANUAL_GRADING, application, "Штукатурка стен");
    expect(roof.coefficients?.labour).toBe(1.25);
    expect(roof.coefficients?.conditionIds).toEqual(["T5-9.2"]);
    expect(wall.coefficients?.labour).toBe(1.15);
    expect(wall.coefficients?.conditionIds).toEqual(["T5-9.1"]);
  });

  it("п. 52: стеснённые условия не распространяются на работы в помещениях — при выбранных «жилых без расселения» их получают только наружные позиции", () => {
    const application = repair(["T5-8", "T5-9.1"]);
    const interior = line(NORM_MANUAL_GRADING, application, "Окраска стен");
    const roof = line(withCollection(NORM_MANUAL_GRADING, "12"), application, "Устройство кровли");
    expect(interior.coefficients?.labour).toBe(1.5);
    expect(roof.coefficients?.labour).toBe(1.65);
  });

  it("повышенная оплата труда (таблица 6, п. 1.1): ставка ×1,10, часы не меняются; совместно с коэффициентом производительности", () => {
    const k = line(NORM_DRAGLINE_15, repair(["T6-1.1"]));
    expect(k.coefficients).toMatchObject({ labour: 1, machines: 1, wage: 1.1 });
    expect(k.labourHours).toBe(base.labourHours);
    expect(k.labourRate).toBeCloseTo(base.labourRate * 1.1, 1);
    expect(k.labourCost).toBeCloseTo(base.labourCost * 1.1, 1);
    const both = line(NORM_DRAGLINE_15, repair(["T5-8", "T6-1.1"]));
    expect(both.coefficients).toMatchObject({ labour: 1.5, wage: 1.1 });
  });

  it("условие чужого вида работ игнорируется: «ремонт» не принимает таблицы реконструкции", () => {
    expect(line(NORM_DRAGLINE_15, repair(["T3-1.1"])).coefficients).toBeUndefined();
  });
});

describe("демонтаж и разборка; п. 58 Методики", () => {
  it("п. 58 (1,15 к труду, 1,25 к машинам) — к обычной позиции ГЭСН; к разборке, ГЭСН 46 и ГЭСНм не применяется (п. 59)", () => {
    const application = repair([], true);
    const normal = line(NORM_DRAGLINE_15, application, "Разработка грунта");
    expect(normal.coefficients).toEqual({ labour: 1.15, machines: 1.25, wage: 1, conditionIds: [], adjustmentIds: ["P58"] });
    expect(line(NORM_DRAGLINE_15, application, "Разборка кирпичных стен").coefficients).toBeUndefined();
    expect(line(withCollection(NORM_DRAGLINE_15, "46"), application, "Разработка грунта").coefficients).toBeUndefined();
    expect(line({ ...NORM_DRAGLINE_15, baseType: "ГЭСНм" }, application, "Монтаж").coefficients).toBeUndefined();
  });

  it("п. 58 и условия приложения 10 перемножаются (п. 56, 61): 1,50 × 1,15 и 1,50 × 1,25", () => {
    const k = line(NORM_DRAGLINE_15, repair(["T5-8"], true), "Разработка грунта");
    expect(k.coefficients?.labour).toBeCloseTo(1.725, 7);
    expect(k.coefficients?.machines).toBeCloseTo(1.875, 7);
  });

  it("для сноса в приложении 10 условий нет: список пуст", () => {
    expect(conditionsOfPhase("DEMOLITION")).toEqual([]);
    expect(line(NORM_DRAGLINE_15, { phase: "DEMOLITION", conditionIds: ["T5-8"], newConstructionNorms: true }, "Разборка стен").coefficients).toBeUndefined();
  });
});

describe("документ: что применено к каким позициям", () => {
  it("описывает условие, число позиций и источник; фраза для результата и Word", () => {
    const section = makeBillSection("Раздел", [
      makeBillItem({ id: "a", workName: "Разработка грунта" }),
      makeBillItem({ id: "b", workName: "Разборка стен", normCode: "01-01-111-01" }),
    ]);
    const resolve = makeResolver([NORM_DRAGLINE_15, NORM_MANUAL_GRADING]);
    const doc = buildEstimate({
      title: "Ремонт",
      sections: [section],
      priceBook,
      parameters: makeParameters({ workConditions: repair(["T5-8"], true) }),
      resolveNorm: resolve,
      sources: [],
      generatedAt: "2026-10-08T00:00:00.000Z",
      disclaimer: "x",
    });
    const items = doc.appliedNormatives ?? [];
    const condition = items.find((item) => item.code === "WORK_CONDITION");
    expect(condition).toMatchObject({ applied: true, source: "приложение 10 к 421/пр, таблица 5, п. 8" });
    expect(condition?.value).toContain("применён к 2 из 2 позиций");
    // П. 58 — только к позиции, которая не разборка.
    expect(items.find((item) => item.code === "WORK_ADJUSTMENT")?.value).toContain("применён к 1 из 2 позиций");
    expect(workConditionsSentence(items)).toMatch(/^Применены коэффициенты условий работ: .*приложение 10 к 421\/пр, таблица 5, п\. 8/u);
    expect(doc.sections[0]?.lines[1]?.coefficients).toMatchObject({ labour: 1.5 });
  });

  it("условие, не подошедшее ни к одной позиции, не выдаётся за применённое", () => {
    const section = makeBillSection("Раздел", [makeBillItem({ id: "a" })]);
    const doc = buildEstimate({
      title: "Ремонт",
      sections: [section],
      priceBook,
      parameters: makeParameters({ workConditions: repair(["T5-9.2"]) }),
      resolveNorm: makeResolver([NORM_DRAGLINE_15]),
      sources: [],
      generatedAt: "2026-10-08T00:00:00.000Z",
      disclaimer: "x",
    });
    const item = (doc.appliedNormatives ?? []).find((entry) => entry.code === "WORK_CONDITION");
    expect(item?.applied).toBe(false);
    expect(workConditionsSentence(doc.appliedNormatives)).toBeNull();
  });

  it("регресс: без условий документ тот же — итоги, строки, нет appliedNormatives", () => {
    const section = makeBillSection("Раздел", [makeBillItem({ id: "a" })]);
    const request = {
      title: "Ремонт",
      sections: [section],
      priceBook,
      resolveNorm: makeResolver([NORM_DRAGLINE_15]),
      sources: [],
      generatedAt: "2026-10-08T00:00:00.000Z",
      disclaimer: "x",
    };
    const plain = buildEstimate({ ...request, parameters: makeParameters() });
    const empty = buildEstimate({ ...request, parameters: makeParameters({ workConditions: repair([]) }) });
    expect(empty.totals).toEqual(plain.totals);
    expect(plain.appliedNormatives).toBeUndefined();
    expect(computeTotals(plain.sections, makeParameters()).workCost).toBe(plain.totals.workCost);
  });
});

describe("подсказки по тексту документации", () => {
  it("называет условия, но ничего не отмечает: стеснённые условия, без выселения, ЛЭП", () => {
    const hints = detectConditionHints(
      "Работы выполняются в эксплуатируемом здании без выселения жильцов в стесненных условиях, вблизи линий под напряжением.",
      "CAPITAL_REPAIR",
    );
    const ids = hints.map((hint) => hint.conditionId);
    expect(ids).toEqual(expect.arrayContaining(["T5-1.1", "T5-8", "T5-9.1", "T5-4"]));
    expect(hints.find((hint) => hint.conditionId === "T5-8")?.quote).toContain("без выселения");
  });

  it("в тексте нет — подсказки нет; для сноса подсказок нет вовсе", () => {
    expect(detectConditionHints("Окраска стен в помещениях.", "CAPITAL_REPAIR")).toEqual([]);
    expect(detectConditionHints("в эксплуатируемом здании", "DEMOLITION")).toEqual([]);
  });

  it("describeWorkConditions без выбора условий ничего не возвращает", () => {
    expect(describeWorkConditions(undefined, [])).toEqual([]);
    expect(resolveLineCoefficients(undefined, { baseType: "ГЭСН", collectionCode: "01", name: "x" })).toBeNull();
  });
});
