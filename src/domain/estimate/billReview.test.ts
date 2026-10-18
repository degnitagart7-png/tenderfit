import { describe, expect, it } from "vitest";

import { REVIEW_NAME_COVERAGE, REVIEW_NAME_STRICT_COVERAGE, needsReview } from "@/domain/estimate/matchNorms";
import { countToReview, linePriceSource, matchBadge, priceSourceLabel } from "@/domain/estimate/billReview";
import type { EstimateLine } from "@/domain/estimate/types";
import { buildEditResult, modelCalls } from "@/test/billEditFixtures";

/*
  Что таблица «Ведомость и нормы» говорит о подборе: по шифру, по наименованию с процентом и
  «проверьте» для слабых подборов. Пороги «проверьте» — из matchNorms, те же, что у расчёта.
*/

const lineOf = (over: Partial<EstimateLine> = {}): EstimateLine =>
  ({
    itemId: "x",
    normCode: "01-01-001-01",
    normBaseType: "ГЭСН",
    normName: "n",
    normUnit: "1000 м3",
    resources: [],
    gaps: [],
    directCost: 1,
    overheadCost: 0,
    profitCost: 0,
    ...over,
  }) as unknown as EstimateLine;

describe("порог «проверьте»", () => {
  it("слабый подбор: покрытие < 0,7 или строгое покрытие < 0,55", () => {
    expect(REVIEW_NAME_COVERAGE).toBe(0.7);
    expect(REVIEW_NAME_STRICT_COVERAGE).toBe(0.55);
    expect(needsReview({ coverage: 0.69, strictCoverage: 1 })).toBe(true);
    expect(needsReview({ coverage: 1, strictCoverage: 0.54 })).toBe(true);
    expect(needsReview({ coverage: 0.7, strictCoverage: 0.55 })).toBe(false);
  });
});

describe("сведения о подборе по настоящему расчёту", () => {
  it("подбор по наименованию: покрытие и альтернативы; ловушка с опалубкой и слабый подбор помечены «проверьте»", async () => {
    const before = modelCalls.count;
    const result = await buildEditResult();
    expect(modelCalls.count).toBe(before + 1);

    const rows = new Map(result.bill.rows.map((row) => [row.itemId, row]));
    const names = new Map(result.bill.sections.flatMap((section) => section.items).map((item) => [item.workName, item.id]));
    const walls = rows.get(names.get("Демонтаж наружных стен") ?? "");
    const weak = rows.get(names.get("Разработка грунта и планировка откосов") ?? "");
    const clean = rows.get(names.get("Планировка вручную дна и откосов выемок каналов") ?? "");

    // «Демонтаж наружных стен» → опалубка: покрытие полное, но в норме есть «опалубки», которой в работе нет.
    expect(walls?.basis).toBe("NAME");
    expect(walls?.coverage).toBe(1);
    expect(walls?.review).toBe(true);
    expect(walls?.reviewReason).toBe("в норме есть «опалубки», в работе — нет");
    // Нужная норма — первой среди вариантов: она из сборника ГЭСН 46 (разборка), поиск по слову «демонтаж» её не находил.
    expect(walls?.alternatives[0]?.code).toBe("46-04-010-01");
    expect(walls?.alternatives.every((item) => item.unitOk)).toBe(true);

    expect(weak?.basis).toBe("NAME");
    expect(weak?.coverage).toBeLessThan(REVIEW_NAME_COVERAGE);
    expect(weak?.review).toBe(true);

    expect(clean?.review).toBe(false);
    expect(clean?.reviewReason).toBeNull();
  });

  it("варианты из сборника ГЭСН 46 добавляются только для демонтажа, разборки и сноса", async () => {
    const result = await buildEditResult();
    const rows = new Map(result.bill.rows.map((row) => [row.itemId, row]));
    const names = new Map(result.bill.sections.flatMap((section) => section.items).map((item) => [item.workName, item.id]));

    const grading = rows.get(names.get("Планировка вручную дна и откосов выемок каналов") ?? "");
    expect(grading?.alternatives.some((item) => item.code.startsWith("46-"))).toBe(false);
    const walls = rows.get(names.get("Демонтаж наружных стен") ?? "");
    expect(walls?.alternatives.length).toBeLessThanOrEqual(5);
    expect(new Set(walls?.alternatives.map((item) => `${item.baseType}|${item.code}`)).size).toBe(walls?.alternatives.length);
  });

  it("позиция без нормы выпадает из таблицы; счётчик «проверить» считает опалубку и слабый подбор", async () => {
    const result = await buildEditResult();
    const lines = result.document.sections.flatMap((section) => section.lines);
    const rows = new Map(result.bill.rows.map((row) => [row.itemId, row]));

    expect(lines).toHaveLength(4);
    expect(result.document.gaps.some((gap) => gap.kind === "NO_NORM" && gap.message.includes("Монтаж ограждения"))).toBe(true);
    expect(countToReview(lines, rows)).toBe(2);
  });
});

describe("подписи", () => {
  it("уверенность: по шифру из документа, по наименованию с процентом, выбрано вами", () => {
    const base = { itemId: "x", alternatives: [], strictCoverage: 1 };
    expect(matchBadge({ ...base, basis: "CODE", coverage: 1, review: false }, lineOf())).toMatchObject({
      text: "по шифру из документа",
      tone: "olive",
      review: false,
    });
    expect(matchBadge({ ...base, basis: "NAME", coverage: 0.82, review: false }, lineOf())).toMatchObject({
      text: "по наименованию, 82 %",
      tone: "olive",
    });
    expect(matchBadge({ ...base, basis: "NAME", coverage: 0.58, review: true }, lineOf())).toMatchObject({
      text: "по наименованию, 58 % · проверьте",
      tone: "mustard",
      review: true,
    });
    expect(matchBadge({ ...base, basis: "MANUAL", coverage: null, review: false }, lineOf())).toMatchObject({
      text: "выбрано вами",
      tone: "accent",
    });
  });

  it("нормы нет и цена заказчика — «проверьте»; своя цена и услуга ФГИС — нет", () => {
    expect(matchBadge(undefined, lineOf({ priceSource: "CUSTOMER_PRICE" })).review).toBe(true);
    expect(matchBadge(undefined, lineOf({ priceSource: "OWN_PRICE" })).review).toBe(false);
    expect(matchBadge(undefined, lineOf({ priceSource: "FGIS_SERVICE" })).review).toBe(false);
  });

  it("источник цены: наша норма, по индексу, ФГИС перевозка, цена заказчика, своя цена", () => {
    const resource = (source: string) => ({ source }) as unknown as EstimateLine["resources"][number];
    expect(priceSourceLabel(lineOf())).toBe("наша норма");
    expect(priceSourceLabel(lineOf({ resources: [resource("SPLIT_INDEXED")] }))).toBe("по индексу");
    expect(priceSourceLabel(lineOf({ priceSource: "FGIS_SERVICE", normBaseType: "ФГИС ЦС перевозка" }))).toBe("ФГИС перевозка");
    expect(priceSourceLabel(lineOf({ priceSource: "FGIS_SERVICE", normBaseType: "ФГИС ЦС ПРР" }))).toBe("ФГИС погрузка");
    expect(priceSourceLabel(lineOf({ priceSource: "CUSTOMER_PRICE" }))).toBe("цена заказчика");
    expect(priceSourceLabel(lineOf({ priceSource: "OWN_PRICE" }))).toBe("своя цена");
    expect(linePriceSource(lineOf({ resources: [resource("CURRENT_ZONE")] }))).toBe("NORM");
    // Базисно-индексный метод: строка с разложением на базисные суммы и индексы — «ФЕР × индекс».
    const bimLine = lineOf({ bim: { rateCode: "ФЕР01-01-001-01", baseWage: 1, baseMachines: 1, baseMachinistWage: 0, baseMaterials: 1, indexLabour: 2, indexMachines: 2, indexMaterials: 2, materialsOutsidePrice: [] } });
    expect(linePriceSource(bimLine)).toBe("BIM");
    expect(priceSourceLabel(bimLine)).toBe("ФЕР × индекс");
  });
});
