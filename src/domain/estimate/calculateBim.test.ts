import { describe, expect, it } from "vitest";

import { bundledBimIndexBook } from "@/domain/estimate/bimIndices";
import { chooseMethod, describeEstimateMethod, detectCustomerMethod, terAsFerNote } from "@/domain/estimate/bimMethod";
import { buildBimEstimate, selectBimIndices, type BimEstimateRequest, type FerResolver } from "@/domain/estimate/calculateBim";
import { parseCustomerBim } from "@/domain/estimate/customerBim";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import type { FerLookup } from "@/domain/estimate/customerBimAudit";
import type { FerResourcePrice } from "@/lib/fsnb/ferXml";
import { ferLookupOf } from "@/repositories/bimRepository";
import { auditEstimateArithmetic, estimateDocumentSchema } from "@/domain/estimate/schema";
import type { BillOfWorkItem } from "@/domain/estimate/types";
import { BRICK, EARTH, MOUNT, OVERHEAD_RATES, makeFerBase } from "@/test/bimFixtures";
import { makeBillItem, makeParameters } from "@/test/estimateFixtures";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/*
  Наш расчёт БИМ на малой ведомости: цифры считаются в уме.
  Белгородская область, кирпичный многоквартирный дом, III кв. 2026, ФЕР: ОТ 47,58, ЭМ 15,15, материалы 9,58 (письмо 46728-ИФ/09).
*/

const book = bundledBimIndexBook();
const pick = (text: string, subject = "Белгородская область") => {
  const found = selectBimIndices(book, { subject, text });
  if (!found.ok) throw new Error(found.reason);
  return found.selection;
};

describe("индексы письма под закупку", () => {
  it("субъект, объект по наименованию и квартал: Белгородская область, кирпичный дом, III кв. 2026", () => {
    const selection = pick("Капитальный ремонт кирпичного многоквартирного дома");
    expect(selection).toMatchObject({
      subject: "Белгородская область",
      object: "Многоквартирные жилые дома: Кирпичные",
      objectDetected: true,
      quarter: { year: 2026, quarter: 3 },
      labour: 47.58,
      machines: 15.15,
      materials: 9.58,
      notes: [],
    });
    expect(selection.letter).toContain("46728-ИФ/09");
  });

  it("объект не определился — «Прочие объекты» с оговоркой, а не молчаливая подстановка", () => {
    const selection = pick("Выполнение работ по благоустройству территории");
    expect(selection).toMatchObject({ object: "Прочие объекты", objectDetected: false, labour: 47.58, machines: 14.92, materials: 10.4 });
    expect(selection.notes[0]).toContain("«Прочие объекты»");
  });

  it("жилой дом без материала стен: однозначно не назначается, кандидаты названы", () => {
    const selection = pick("Ремонт многоквартирного жилого дома");
    expect(selection.objectDetected).toBe(false);
    expect(selection.notes[0]).toContain("Многоквартирные жилые дома: Кирпичные");
  });

  it("название ценовой зоны: субъект и номер зоны берутся из неё", () => {
    const selection = pick("Строительство котельной", "Иркутская область (3 зона)");
    expect(selection).toMatchObject({ subject: "Иркутская область", zone: 3, object: "Котельные" });
  });

  it("несколько зон у субъекта, зона не названа — отказ с причиной, а не выбор первой", () => {
    const found = selectBimIndices(book, { subject: "Иркутская область", text: "Строительство котельной" });
    expect(found).toEqual({ ok: false, reason: expect.stringContaining("несколько ценовых зон") as string });
  });

  it("субъекта нет в справочнике и письма за другой квартал не подставляются", () => {
    expect(selectBimIndices(book, { subject: "Республика Нигде", text: "котельная" })).toMatchObject({ ok: false });
    const other = selectBimIndices(book, { subject: "Белгородская область", text: "котельная", quarter: { year: 2026, quarter: 2 } });
    expect(other).toEqual({ ok: false, reason: expect.stringContaining("писем за II кв. 2026 нет") as string });
  });
});

describe("метод заказчика", () => {
  const text = (value: string) => [{ name: "ТЗ.docx", text: value }];

  it("слова документации: базисно-индексный, ресурсно-индексный, шифры ФЕР и ТЕР", () => {
    expect(detectCustomerMethod(text("Смета составляется базисно-индексным методом")).method).toBe("BASE_INDEX");
    expect(detectCustomerMethod(text("Определение стоимости ресурсно-индексным методом")).method).toBe("RESOURCE_INDEX");
    expect(detectCustomerMethod(text("Расценки ФЕР 01-01-001-01, ФЕРм 08-02-001-01")).method).toBe("BASE_INDEX");
    expect(detectCustomerMethod(text("Расценки ТЕР 01-01-001-01, ТЕР 06-01-001-02, ФЕР 01-01-001-01")).customerBase).toBe("TER");
    expect(detectCustomerMethod(text("Объём работ определён по чертежам")).method).toBeNull();
  });

  it("названы оба метода: берётся тот, что назван чаще; расценки ФЕР при ресурсном методе метод не меняют", () => {
    expect(detectCustomerMethod(text("ресурсно-индексный метод; ресурсно-индексный; базисно-индексный")).method).toBe("RESOURCE_INDEX");
    expect(detectCustomerMethod(text("ресурсно-индексным методом, сметы в ФЕР-2001 не принимаются")).method).toBe("RESOURCE_INDEX");
  });

  it("смета заказчика на ФЕР/ТЕР важнее слов документации; БИМ-смета определяет базу", () => {
    const fixture = readFileSync(resolve("src/domain/estimate/__fixtures__/bim/grid-nnk-dop.txt"), "utf8");
    const estimates = parseCustomerBim([{ name: "ЛС.xlsx", text: fixture }]).estimates;
    const detection = detectCustomerMethod(text("ресурсно-индексный метод"), estimates);
    expect(detection).toMatchObject({ method: "BASE_INDEX", customerBase: "FER" });
    expect(detection.note).toContain("составлена на расценках ФЕР-2001");
  });

  it("выбор пользователя важнее документации, без выбора — заказчик, молчит заказчик — ресурсно-индексный", () => {
    const customer = detectCustomerMethod(text("базисно-индексный метод"));
    expect(chooseMethod("RESOURCE_INDEX", customer)).toMatchObject({ method: "RESOURCE_INDEX", basis: "USER" });
    expect(chooseMethod(null, customer)).toMatchObject({ method: "BASE_INDEX", basis: "CUSTOMER" });
    expect(chooseMethod(undefined, detectCustomerMethod(text("пусто")))).toMatchObject({ method: "RESOURCE_INDEX", basis: "DEFAULT" });
  });
});

describe("метод заказчика: ресурсно-индексная ЛСР формы 421/пр", () => {
  const RIM = readFileSync(resolve("src/domain/estimate/__fixtures__/t1118/lsr-02-02-08.txt"), "utf8");
  const BIM = readFileSync(resolve("src/domain/estimate/__fixtures__/bim/grid-nnk-dop.txt"), "utf8");
  const documents = (...texts: string[]) => texts.map((value, index) => ({ name: `doc${String(index)}.csv`, text: value }));

  it("ресурсная ЛСР 421/пр (шапка «ресурсно-индексным методом», ГЭСН): метод ресурсно-индексный, БИМ не определяется", () => {
    const docs = documents(RIM);
    const bim = parseCustomerBim(docs).estimates;
    const rimLsrCount = parseCustomerLsr(docs).estimates.length;
    expect(bim).toEqual([]);
    expect(rimLsrCount).toBe(1);
    expect(detectCustomerMethod(docs, bim, { rimLsrCount }).method).toBe("RESOURCE_INDEX");
  });

  it("в документах и ресурсная ЛСР, и БИМ-смета: противоречие решает ресурсный метод", () => {
    const docs = documents(RIM, BIM);
    const bim = parseCustomerBim(docs).estimates;
    expect(bim.length).toBeGreaterThan(0);
    const rimLsrCount = parseCustomerLsr(docs).estimates.length;
    expect(rimLsrCount).toBe(1);
    expect(detectCustomerMethod(docs, bim, { rimLsrCount }).method).toBe("RESOURCE_INDEX");
    // Без ресурсной ЛСР БИМ-смета определяет БИМ, как раньше.
    expect(detectCustomerMethod(documents(BIM), bim).method).toBe("BASE_INDEX");
  });

  it("шапка ЛСР важнее слов в тексте: «Составлен ресурсно-индексным методом» против упоминаний БИМ в договоре", () => {
    const text = (value: string) => [{ name: "ЛСР.pdf", text: value }];
    const mixed = "Составлен ресурсно-индексным методом. Договор: базисно-индексный метод оплаты, базисно-индексный метод пересчёта";
    expect(detectCustomerMethod(text(mixed)).method).toBe("RESOURCE_INDEX");
    const csv = "Составлен ,ресурсно-индексным,методом,,,\nв договоре: базисно-индексный, базисно-индексный, базисно-индексный";
    expect(detectCustomerMethod(text(csv)).method).toBe("RESOURCE_INDEX");
    const bimHeader = "Составлен базисно - индексным методом. ТЗ: ресурсно-индексный, ресурсно-индексный";
    expect(detectCustomerMethod(text(bimHeader)).method).toBe("BASE_INDEX");
    // Заголовка нет — как раньше, по числу слов.
    expect(detectCustomerMethod(text("базисно-индексный метод, ресурсно-индексный метод, ресурсно-индексный")).method).toBe("RESOURCE_INDEX");
  });
});

function request(items: readonly BillOfWorkItem[], patch: Partial<BimEstimateRequest> = {}): BimEstimateRequest {
  const base = makeFerBase();
  const resolveRate: FerResolver = (item) => {
    const rate = [EARTH, BRICK, MOUNT].find((candidate) => candidate.code === item.normCode && candidate.book === item.normBaseType);
    return rate === undefined ? null : { rate, reasons: [] };
  };
  return {
    title: "Капитальный ремонт",
    sections: [{ title: "Раздел", items }],
    resolveRate,
    fer: ferLookupOf(base),
    selection: pick("Капитальный ремонт кирпичного многоквартирного дома"),
    overheadRates: OVERHEAD_RATES,
    parameters: makeParameters(),
    sources: [],
    generatedAt: "2026-10-09T00:00:00.000Z",
    disclaimer: "оговорка",
    region: "Белгородская область",
    priceZone: "Белгородская область",
    baseEdition: "ФСНБ-2020",
    method: { basis: "CUSTOMER", note: "смета заказчика на ФЕР", customerBase: "FER" },
    ...patch,
  };
}

const item = (patch: Partial<BillOfWorkItem>): BillOfWorkItem => makeBillItem({ unitDivisor: 1, ...patch });

describe("расчёт БИМ: расценка ФЕР × индексы", () => {
  const earth = item({ id: "a", workName: "Разработка грунта", quantity: 2, quantityUnit: "1000 м3", normCode: EARTH.code, normBaseType: "ФЕР" });
  const document = buildBimEstimate(request([earth]));
  const line = document.sections[0]?.lines[0];

  it("позиция: ОЗП, ЭМ и материалы расценки умножены на индексы письма, цифры считаются в уме", () => {
    expect(document.method).toBe("BASE_INDEX");
    // ОЗП 1000 × 2 × 47,58; ЭМ 5000 × 2 × 15,15; М 200 × 2 × 9,58
    expect(line).toMatchObject({ normBaseType: "ФЕР", normCode: "01-01-001-01", quantity: 2, labourCost: 95160, machineCost: 151500, materialCost: 3832, directCost: 250492 });
    expect(line?.bim).toMatchObject({ rateCode: "ФЕР01-01-001-01", baseWage: 2000, baseMachines: 10000, baseMachinistWage: 1000, baseMaterials: 400, indexLabour: 47.58, indexMachines: 15.15, indexMaterials: 9.58 });
  });

  it("НР и СП — проценты приказов от ФОТ в текущих ценах: (ОЗП + ЗПМ) × индекс труда", () => {
    // ФОТ = 95 160 + 1000 × 47,58 = 142 740; НР 100 %, СП 50 %
    expect(line).toMatchObject({ wageFund: 142740, overheadPercent: 100, profitPercent: 50, overheadCost: 142740, profitCost: 71370, overheadRef: "Пр/812-001.1", overheadSource: "NORM_REF" });
  });

  it("ресурсные строки несут базисную цену, индекс и цену в текущем уровне: арифметика позиции проверяется схемой", () => {
    expect(line?.resources.map((resource) => [resource.code, resource.kind, resource.baseUnitPrice, resource.index, resource.source])).toEqual([
      ["ОЗП", "LABOUR", 1000, 47.58, "BIM_INDEXED"],
      ["ЭМ", "MACHINE", 5000, 15.15, "BIM_INDEXED"],
      ["МАТ", "MATERIAL", 200, 9.58, "BIM_INDEXED"],
    ]);
    const parsed = estimateDocumentSchema.parse(JSON.parse(JSON.stringify(document)));
    expect(auditEstimateArithmetic(parsed)).toEqual([]);
  });

  it("итоги документа и метка метода: индексы, письмо, объект, квартал", () => {
    expect(document.totals).toMatchObject({ directCost: 250492, overheadCost: 142740, profitCost: 71370, workCost: 464602 });
    expect(document.bim).toMatchObject({
      basis: "CUSTOMER",
      subject: "Белгородская область",
      quarter: "III кв. 2026",
      object: "Многоквартирные жилые дома: Кирпичные",
      objectDetected: true,
      customerBase: "FER",
      indexLabour: 47.58,
    });
    expect(document.period).toBe("III кв. 2026 (индексы Минстроя)");
    expect(document.gaps).toEqual([]);
    const method = describeEstimateMethod(document);
    expect(method.title).toBe("Метод: базисно-индексный (ФЕР-2001 × индексы) — как у заказчика (смета заказчика на ФЕР)");
    expect(method.lines[0]).toContain("ОЗП 47,58, ЭМ 15,15, материалы 9,58");
  });

  it("материалы вне цены расценки названы пробелом, а не посчитаны нулём молча", () => {
    const brick = item({ id: "b", workName: "Кладка", quantity: 10, quantityUnit: "м3", normCode: BRICK.code, normBaseType: "ФЕР" });
    const result = buildBimEstimate(request([brick]));
    expect(result.gaps.find((gap) => gap.kind === "QUANTITY_BY_PROJECT")?.message).toContain("Кирпич керамический");
    expect(result.sections[0]?.lines[0]?.bim?.materialsOutsidePrice).toEqual(["Кирпич керамический"]);
  });

  it("указателя НР нет в справочнике нормативов: резерв документа с пометкой NO_OVERHEAD_RATE", () => {
    const mount = item({ id: "m", workName: "Монтаж", quantity: 5, quantityUnit: "т", normCode: MOUNT.code, normBaseType: "ФЕРм" });
    const result = buildBimEstimate(request([mount]));
    const mounted = result.sections[0]?.lines[0];
    expect(mounted).toMatchObject({ overheadSource: "DEFAULT", overheadPercent: 105, profitPercent: 65 });
    expect(result.gaps.some((gap) => gap.kind === "NO_OVERHEAD_RATE" && gap.baseType === "ФЕРм")).toBe(true);
    expect(auditEstimateArithmetic(estimateDocumentSchema.parse(JSON.parse(JSON.stringify(result))))).toEqual([]);
  });

  it("объём делится на единицу расценки; единица не сошлась и делителя нет — позиция выпадает с причиной", () => {
    const thousand = item({ id: "t", workName: "Грунт", quantity: 2000, quantityUnit: "м3", unitDivisor: 1000, normCode: EARTH.code, normBaseType: "ФЕР" });
    expect(buildBimEstimate(request([thousand])).sections[0]?.lines[0]?.directCost).toBe(250492);
    const wrongUnit = item({ id: "w", workName: "Грунт", quantity: 3, quantityUnit: "т", normCode: EARTH.code, normBaseType: "ФЕР" });
    const dropped = buildBimEstimate(request([wrongUnit]));
    expect(dropped.sections[0]?.lines).toEqual([]);
    expect(dropped.gaps.some((gap) => gap.kind === "UNIT_MISMATCH")).toBe(true);
  });

  it("поставка по ФССЦ-2020: цена × индекс материалов, НР и СП нет; позиции без расценки — цена заказчика или выпадение", () => {
    const supply = item({ id: "s", workName: "Клапан", quantity: 4, quantityUnit: "шт", resourceCode: "18.1.02.01-0085" });
    const result = buildBimEstimate(request([supply]));
    // 100 × 4 × 9,58
    expect(result.sections[0]?.lines[0]).toMatchObject({ normBaseType: "ФССЦ", directCost: 3832, overheadCost: 0, profitCost: 0 });

    const unknown = item({ id: "u", workName: "Неизвестная работа", quantity: 1, quantityUnit: "шт" });
    const missing = buildBimEstimate(request([unknown]));
    expect(missing.sections[0]?.lines).toEqual([]);
    expect(missing.gaps.some((gap) => gap.kind === "NO_NORM")).toBe(true);

    const withCustomerPrice = item({ id: "c", workName: "Неизвестная работа", quantity: 1, quantityUnit: "шт", customerPrice: { total: 1000, unitPrice: 1000, unit: "шт", origin: "LINE", document: "ЛС.xlsx" } });
    const priced = buildBimEstimate(request([withCustomerPrice]));
    expect(priced.sections[0]?.lines[0]).toMatchObject({ priceSource: "CUSTOMER_PRICE", directCost: 1000 });
    expect(priced.totals.customerPricedCount).toBe(1);
  });

  it("ТЕР региона: посчитано по ФЕР, и это написано дословно", () => {
    const result = buildBimEstimate(request([earth], { method: { basis: "CUSTOMER", note: "смета на ТЕР", customerBase: "TER" } }));
    expect(result.gaps.find((gap) => gap.kind === "BIM_TER_AS_FER")?.message).toBe(
      "ТЕР Белгородская область недоступны в открытых данных — посчитано по ФЕР с индексами к ФЕР; возможна разница",
    );
    expect(terAsFerNote(null)).toBe("ТЕР региона недоступны в открытых данных — посчитано по ФЕР с индексами к ФЕР; возможна разница");
    expect(describeEstimateMethod(result).lines.at(-1)).toContain("ТЕР Белгородская область недоступны");
  });

  it("объект не определён — пробел BIM_NO_INDEX и допущение; условия работ в БИМ не применяются и это сказано", () => {
    const selection = pick("Благоустройство территории");
    const parameters = makeParameters({ workConditions: { phase: "CAPITAL_REPAIR", conditionIds: ["T5-8"], newConstructionNorms: false } });
    const result = buildBimEstimate(request([earth], { selection, parameters }));
    expect(result.gaps.find((gap) => gap.kind === "BIM_NO_INDEX")?.message).toContain("Прочие объекты");
    expect(result.gaps.some((gap) => gap.kind === "NORMATIVE_NOT_APPLIED" && gap.message.includes("не применяются"))).toBe(true);
    expect(result.bim?.objectDetected).toBe(false);
  });

  it("лимитированные затраты и НДС — те же, что у ресурсного метода: ССР и итоги строятся поверх документа", () => {
    const parameters = makeParameters({ vatPercent: 22, limited: { winterSurchargePercent: 2, temporaryStructuresPercent: 1, source: "тест" } });
    const result = buildBimEstimate(request([earth], { parameters }));
    const work = 464602;
    expect(result.totals.temporaryStructures).toBeCloseTo(work * 0.01, 2);
    expect(result.totals.winterSurcharge).toBeCloseTo((work + work * 0.01) * 0.02, 2);
    expect(result.totals.vat).toBeCloseTo(result.totals.beforeVat * 0.22, 2);
    expect(auditEstimateArithmetic(estimateDocumentSchema.parse(JSON.parse(JSON.stringify(result))))).toEqual([]);
  });
});

describe("поставка в БИМ: единицы цены и ведомости, предохранитель суммы", () => {
  const supplyBook = (unit: string, cost: number): FerLookup => ({
    rate: () => null,
    transport: () => null,
    material: (code) => (code === "21.1.07.02-0099" ? ({ code, name: "Кабель силовой ААБл 3х185-10000", unit, cost } as FerResourcePrice) : null),
  });
  const supply = (priceUnit: string, cost: number, quantity: number, billUnit: string, patch: Partial<BillOfWorkItem> = {}) =>
    buildBimEstimate({
      ...request([item({ id: "k", workName: "Кабель силовой ААБл 3х185-10000", quantity, quantityUnit: billUnit, resourceCode: "21.1.07.02-0099", ...patch })]),
      fer: supplyBook(priceUnit, cost),
    });
  const first = (document: ReturnType<typeof supply>) => document.sections[0]?.lines[0];
  const customer = (total: number): BillOfWorkItem["customerPrice"] => ({ total, unitPrice: total, unit: "шт", origin: "POSITION_TOTAL", document: "ЛС.xlsx" });

  it("цена за «1000 м», объём в метрах: 1229 м — это 1,229 единицы цены, а не 1229", () => {
    const document = supply("1000 м", 100_000, 1229, "м");
    // 100 000 × 1,229 × 9,58, а не × 1229
    expect(first(document)).toMatchObject({ quantity: 1.229, billQuantity: 1229, billUnit: "м", normUnit: "1000 м", directCost: 1_177_382 });
    expect(first(document)?.resources[0]).toMatchObject({ quantity: 1.229, unit: "1000 м", baseUnitPrice: 100_000 });
    expect(document.gaps).toEqual([]);
    expect(auditEstimateArithmetic(estimateDocumentSchema.parse(JSON.parse(JSON.stringify(document))))).toEqual([]);
  });

  it("цена за «100 м»: 250 м — 2,5 единицы; единица ведомости с множителем («1000 м», 1,229) тоже сходится", () => {
    expect(first(supply("100 м", 5000, 250, "м"))).toMatchObject({ quantity: 2.5, directCost: 119_750 });
    expect(first(supply("1000 м", 100_000, 1.229, "1000 м"))).toMatchObject({ quantity: 1.229, directCost: 1_177_382 });
    expect(first(supply("м", 1000, 3, "м"))).toMatchObject({ quantity: 3, directCost: 28_740 });
  });

  it("«т» и «кг»: перевод точный в обе стороны, а не умножение цены за тонну на килограммы", () => {
    expect(first(supply("т", 20_000, 3500, "кг"))).toMatchObject({ quantity: 3.5, directCost: 670_600 });
    expect(first(supply("кг", 20, 2, "т"))).toMatchObject({ quantity: 2000, directCost: 383_200 });
    expect(first(supply("т", 20_000, 3.5, "тонна"))).toMatchObject({ quantity: 3.5 });
  });

  it("«м3» в ведомости и «м2» в справочнике: не переводится — пробел UNIT_MISMATCH, а не молчаливое умножение", () => {
    const dropped = supply("м2", 1000, 3, "м3");
    expect(dropped.sections[0]?.lines).toEqual([]);
    expect(dropped.gaps.find((gap) => gap.kind === "UNIT_MISMATCH")?.message).toContain("не переводится");
    // Цена заказчика есть — позиция входит по ней, пометка остаётся.
    const priced = supply("м2", 1000, 3, "м3", { customerPrice: customer(5000) });
    expect(first(priced)).toMatchObject({ priceSource: "CUSTOMER_PRICE", directCost: 5000 });
    expect(priced.gaps.some((gap) => gap.kind === "CUSTOMER_PRICE")).toBe(true);
  });

  it("предохранитель: наша сумма больше суммы заказчика более чем в сто раз — позиция не считается; в пределах — считается", () => {
    // 100 × 1000 × 9,58 = 958 000 ₽ против 1000 ₽ заказчика
    const absurd = supply("шт", 100, 1000, "шт", { customerPrice: customer(1000) });
    expect(first(absurd)).toMatchObject({ priceSource: "CUSTOMER_PRICE", directCost: 1000 });
    const noCustomer = supply("шт", 100, 1000, "шт");
    expect(first(noCustomer)).toMatchObject({ directCost: 958_000 });
    const near = supply("шт", 100, 1000, "шт", { customerPrice: customer(20_000) });
    expect(first(near)).toMatchObject({ directCost: 958_000 });
  });
});

describe("метод заказчика: обоснование НМЦК метод не определяет", () => {
  it("«базисно-индексным методом» только в обосновании НМЦК — метод не выбран (ресурсно-индексный по умолчанию)", () => {
    const docs = [
      { name: "Приложение №5- Обоснование НМЦК.docx", text: "Обоснование начальной (максимальной) цены: расчёт, составленный по ТЕР Иркутской области базисно-индексным методом" },
      { name: "Ведомость объемов.xlsx", text: "1,Демонтаж радиаторов,шт,12" },
    ];
    expect(detectCustomerMethod(docs).method).toBeNull();
    expect(chooseMethod(null, detectCustomerMethod(docs)).method).toBe("RESOURCE_INDEX");
  });

  it("требование в ТЗ — по-прежнему базисно-индексный", () => {
    const docs = [{ name: "Техническое задание.docx", text: "Смета составляется базисно-индексным методом" }];
    expect(detectCustomerMethod(docs).method).toBe("BASE_INDEX");
  });
});
