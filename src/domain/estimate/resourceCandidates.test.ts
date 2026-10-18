import { describe, expect, it } from "vitest";

import {
  applyResourcePick,
  checkResourcePick,
  collectResourceMatches,
  createResourceIndex,
  FALLBACK_MIN_COVERAGE,
  findResources,
  isResourcePick,
  markMaterialUnpriced,
  massConversionFor,
  massPerMetreKg,
  pickByName,
  resourceCandidateOf,
  resourceIndexOf,
  resourceUnitFits,
} from "@/domain/estimate/resourceCandidates";
import { RES, VOR_RESOURCES, vorBook } from "@/domain/estimate/resourceCandidates.fixtures";
import type { BillOfWorkItem } from "@/domain/estimate/types";

const index = createResourceIndex(vorBook());

const PIPE = "Трубы стальные электросварные прямошовные из стали марок Ст2, 10, наружный диаметр 89 мм, толщина стенки 5 мм";
const SAND = "Песок природный для строительных работ II класс, средний";

function item(patch: Partial<BillOfWorkItem> = {}): BillOfWorkItem {
  return { id: "i1", workName: PIPE, quantity: 681.75, quantityUnit: "м", unitDivisor: 1, normCode: null, normBaseType: null, resourceCode: null, sourceQuote: null, sourceDocument: null, ...patch };
}

describe("индекс ресурсов", () => {
  it("берёт материалы с названием и ценой; машины в индекс не входят, текущая цена зоны важнее базы", () => {
    expect(index.size).toBe(VOR_RESOURCES.length - 1);
    expect(index.byCode.has("91.05.05-015")).toBe(false);
    expect(index.byCode.get(RES.pipe89)).toMatchObject({ unit: "м", price: 703.4, priceLevel: "CURRENT" });
    expect(index.byCode.get(RES.sand)).toMatchObject({ unit: "м3", price: 612, priceLevel: "BASE_2022" });
  });

  it("ресурс без цены или без названия в индекс не попадает", () => {
    const book = vorBook();
    const zero = { ...(VOR_RESOURCES[0] as (typeof VOR_RESOURCES)[number]), code: "02.3.01.02-9999", price: 0 };
    const nameless = { ...(VOR_RESOURCES[0] as (typeof VOR_RESOURCES)[number]), code: "02.3.01.02-9998", name: "" };
    book.base.set(zero.code, zero);
    book.base.set(nameless.code, nameless);
    const built = createResourceIndex(book);
    expect(built.byCode.has(zero.code)).toBe(false);
    expect(built.byCode.has(nameless.code)).toBe(false);
  });

  it("индекс строится один раз на книгу цен", () => {
    const book = vorBook();
    expect(resourceIndexOf(book)).toBe(resourceIndexOf(book));
  });
});

describe("findResources: слова и числа названия", () => {
  it("труба диаметром 89 мм находит трубу 89, а труба 108 и бесшовная идут ниже", () => {
    const found = findResources(index, { name: PIPE });
    expect(found[0]?.entry.code).toBe(RES.pipe89);
    const codes = found.map((match) => match.entry.code);
    expect(codes.indexOf(RES.pipe89)).toBeLessThan(codes.indexOf(RES.pipe108));
  });

  it("число, которого нет в названии ресурса, называется: у трубы 108 нет «89» и «10»", () => {
    const found = findResources(index, { name: PIPE });
    const decoy = found.find((match) => match.entry.code === RES.pipe108);
    expect(decoy?.missingNumbers).toContain("89");
  });

  it("запрос из слов, которых в справочнике нет, ничего не находит", () => {
    expect(findResources(index, { name: "Квантовый компенсатор гиперпространства" })).toEqual([]);
  });
});

describe("кандидаты: единицы", () => {
  it("труба в метрах: кандидаты в метрах; та же труба с ценой за тонну не предлагается", () => {
    const codes = collectResourceMatches(index, { workName: PIPE, units: ["м"] }).map((match) => match.entry.code);
    expect(codes).toContain(RES.pipe89);
    expect(codes).not.toContain(RES.pipe89PerTonne);
  });

  it("масса метра названа — труба с ценой за тонну предлагается", () => {
    const codes = collectResourceMatches(index, { workName: PIPE, units: ["м"], kgPerMetre: 10.36 }).map((match) => match.entry.code);
    expect(codes).toContain(RES.pipe89PerTonne);
  });

  it("песок в м3: кубометры, а «кварцевый песок за тонну» не предлагается", () => {
    const codes = collectResourceMatches(index, { workName: SAND, units: ["м3"] }).map((match) => match.entry.code);
    expect(codes[0]).toBe(RES.sand);
    expect(codes).not.toContain("02.3.01.02-0030");
  });

  it("не больше пятнадцати кандидатов; ключ для модели — «РЕСУРС|шифр»", () => {
    expect(collectResourceMatches(index, { workName: PIPE, units: ["м"] }).length).toBeLessThanOrEqual(15);
    expect(resourceCandidateOf(index.byCode.get(RES.gate50)!).key).toBe(`РЕСУРС|${RES.gate50}`);
    expect(isResourcePick(`РЕСУРС|${RES.gate50}`)).toBe(true);
    expect(isResourcePick("ГЭСНм|12-12-001-09")).toBe(false);
    expect(isResourcePick(null)).toBe(false);
  });
});

describe("resourceUnitFits и масса метра", () => {
  it("«м» ↔ «1000 м» ↔ «км», «кг» ↔ «т», «шт» ↔ «100 шт» переводятся; «м» ↔ «т», «м3» ↔ «м2» — нет", () => {
    expect(resourceUnitFits("м", "1000 м", null)).toBe(true);
    expect(resourceUnitFits("км", "м", null)).toBe(true);
    expect(resourceUnitFits("кг", "т", null)).toBe(true);
    expect(resourceUnitFits("шт", "100 шт", null)).toBe(true);
    expect(resourceUnitFits("м", "т", null)).toBe(false);
    expect(resourceUnitFits("м3", "м2", null)).toBe(false);
  });

  it("«м» → «т/кг» только по названной массе метра", () => {
    expect(resourceUnitFits("м", "т", 10.36)).toBe(true);
    expect(resourceUnitFits("м", "кг", 10.36)).toBe(true);
    expect(resourceUnitFits("м2", "т", 10.36)).toBe(false);
  });

  it("массу метра читает из текста документа; плотность не выдумывает", () => {
    expect(massPerMetreKg("масса 1 м — 10,36 кг")).toBeCloseTo(10.36, 6);
    expect(massPerMetreKg("Трубы, 10,36 кг/м")).toBeCloseTo(10.36, 6);
    expect(massPerMetreKg("масса 1 м: 0,01 т")).toBeCloseTo(10, 6);
    expect(massPerMetreKg(PIPE)).toBeNull();
  });

  it("пересчёт по массе нужен только когда единица сама не переводится", () => {
    expect(massConversionFor(["м"], { unit: "т" }, 10.36)).toEqual({ kgPerMetre: 10.36 });
    expect(massConversionFor(["м"], { unit: "м" }, 10.36)).toBeNull();
    expect(massConversionFor(["м"], { unit: "т" }, null)).toBeNull();
  });
});

describe("pickByName: выбор без ИИ — только явный лидер с высоким покрытием", () => {
  const matches = (name: string, units: string[]) => collectResourceMatches(index, { workName: name, units });

  it("«Штуцер стальной приварной, диаметр 50 мм» — единственный полный ответ: берётся, двойник диаметром 32 мм — нет", () => {
    const picked = pickByName(matches("Штуцер стальной приварной, диаметр 50 мм", ["шт"]));
    expect(picked?.entry.code).toBe(RES.nipple50);
    expect(picked?.coverage).toBeGreaterThanOrEqual(FALLBACK_MIN_COVERAGE);
  });

  it("«Задвижка клиновая с выдвижным шпинделем 30с41нж» — две одинаково подходящие (Ду 50 и Ду 80): лидера нет, ресурс не выбирается", () => {
    expect(pickByName(matches("Задвижка клиновая с выдвижным шпинделем 30с41нж", ["шт"]))).toBeNull();
  });

  it("труба с «Ст2, 10» в строке: число «10» в названии ресурса нет — ресурс не выбирается", () => {
    const pipe = matches(PIPE, ["м"]);
    expect(pipe[0]?.entry.code).toBe(RES.pipe89);
    expect(pickByName(pipe)).toBeNull();
  });

  it("песок с «II класс» в строке: слов строки в названии ресурса мало — ресурс не выбирается", () => {
    expect(pickByName(matches(SAND, ["м3"]))).toBeNull();
  });

  it("нет кандидатов — null", () => {
    expect(pickByName([])).toBeNull();
  });
});

describe("checkResourcePick: проверка ответа модели", () => {
  const candidates = collectResourceMatches(index, { workName: PIPE, units: ["м"] }).map((match) => resourceCandidateOf(match.entry));

  it("кандидат из списка с переводимой единицей принимается", () => {
    const check = checkResourcePick(`РЕСУРС|${RES.pipe89}`, candidates, index, ["м"], null);
    expect(check).toMatchObject({ status: "ACCEPTED", massConversion: null });
  });

  it("шифр вне списка кандидатов отклоняется, даже если он есть в справочнике", () => {
    const check = checkResourcePick(`РЕСУРС|${RES.gate50}`, candidates, index, ["м"], null);
    expect(check).toMatchObject({ status: "REJECTED" });
    expect((check as { reason: string }).reason).toContain("вне списка кандидатов");
  });

  it("выдуманный шифр отклоняется", () => {
    expect(checkResourcePick("РЕСУРС|00.0.00.00-0000", candidates, index, ["м"], null).status).toBe("REJECTED");
  });

  it("труба с ценой за тонну при объёме в метрах отклоняется, если массы метра нет (даже если модель получила её в списке)", () => {
    const withTonne = [...candidates, resourceCandidateOf(index.byCode.get(RES.pipe89PerTonne)!)];
    const check = checkResourcePick(`РЕСУРС|${RES.pipe89PerTonne}`, withTonne, index, ["м"], null);
    expect(check.status).toBe("REJECTED");
    expect((check as { reason: string }).reason).toContain("масса метра в документе не названа");
  });

  it("масса метра названа — труба за тонну принимается с пересчётом по массе", () => {
    const withTonne = [...candidates, resourceCandidateOf(index.byCode.get(RES.pipe89PerTonne)!)];
    const check = checkResourcePick(`РЕСУРС|${RES.pipe89PerTonne}`, withTonne, index, ["м"], 10.36);
    expect(check).toMatchObject({ status: "ACCEPTED", massConversion: { kgPerMetre: 10.36 } });
  });
});

describe("запись в позицию", () => {
  const pipe = index.byCode.get(RES.pipe89)!;

  it("выбор ИИ: resourceCode и пометка «материал подобран ИИ: …», позиция остаётся в метрах", () => {
    const applied = applyResourcePick(item(), pipe, { source: "AI", kindReason: "подстрока 11.1", reason: "диаметр и толщина стенки совпали.", confidence: "high", coverage: null });
    expect(applied).toMatchObject({ resourceCode: RES.pipe89, quantity: 681.75, quantityUnit: "м" });
    expect(applied.materialRow).toMatchObject({ pick: "AI", review: false, reason: "подстрока 11.1" });
    expect(applied.materialRow?.note).toContain("материал подобран ИИ: диаметр и толщина стенки совпали");
    expect(applied.materialRow?.note).toContain(`ресурс ${RES.pipe89}`);
  });

  it("низкая уверенность модели — «проверьте»", () => {
    const applied = applyResourcePick(item(), pipe, { source: "AI", kindReason: "x", reason: "похоже", confidence: "low", coverage: null });
    expect(applied.materialRow?.review).toBe(true);
    expect(applied.materialRow?.note).toContain("модель не уверена");
  });

  it("уверенность не названа, а слов строки в названии почти нет — «проверьте»", () => {
    const applied = applyResourcePick(item(), pipe, { source: "AI", kindReason: "x", reason: "?", confidence: null, coverage: 0.1 });
    expect(applied.materialRow?.review).toBe(true);
  });

  it("пересчёт по массе метра: объём в килограммах, пометка и «проверьте»", () => {
    const tonne = index.byCode.get(RES.pipe89PerTonne)!;
    const applied = applyResourcePick(item({ quantity: 100 }), tonne, { source: "AI", kindReason: "x", reason: "труба", confidence: "high", coverage: null, massConversion: { kgPerMetre: 10.36 } });
    expect(applied).toMatchObject({ quantityUnit: "кг", resourceCode: RES.pipe89PerTonne });
    expect(applied.quantity).toBeCloseTo(1036, 6);
    expect(applied.materialRow?.review).toBe(true);
    expect(applied.materialRow?.note).toContain("по массе 1 м");
  });

  it("выбор без ИИ всегда «проверьте» и называет, что ресурс выбран кодом", () => {
    const applied = applyResourcePick(item(), pipe, { source: "NAME", kindReason: "x", reason: "", confidence: null, coverage: 0.9 });
    expect(applied.materialRow).toMatchObject({ pick: "NAME", review: true, coverage: 0.9 });
    expect(applied.materialRow?.note).toContain("без ИИ");
  });

  it("материал без ресурса: ресурса нет, пометка называет причину и просит проверить", () => {
    const marked = markMaterialUnpriced(item(), "подстрока 11.1", "модель не нашла подходящего ресурса");
    expect(marked.resourceCode).toBeNull();
    expect(marked.materialRow).toMatchObject({ pick: null, review: true });
    expect(marked.materialRow?.note).toContain("нет цены, проверьте");
  });
});
