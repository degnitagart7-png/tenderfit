import { describe, expect, it } from "vitest";

import { servicesFromRecords, type LoadPrice, type TransportSeries } from "@/domain/estimate/autoServices";
import { computeAssurance } from "@/domain/estimate/assurance";
import { buildEstimate, computeEstimateLine, type EstimatePriceBook } from "@/domain/estimate/calculate";
import { auditEstimateArithmetic, parseEstimateDocument } from "@/domain/estimate/schema";
import type { BillOfWorkItem, NormRecord, ResourcePrice, SplitAllPrice } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import { AMUR_WAGE_ANCHORS, AMUR_ZONE, makeBillItem, makeBillSection, makeParameters, makePriceBook } from "@/test/estimateFixtures";

/*
  Расчёт перевозки и погрузки по ценам ФГИС ЦС и поиск цены ресурса по ступеням «книга зоны →
  все цены сплит-формы → база 2022». Числа — из закупки 0134600012126000001 (зона 246): перевозка
  505,94 т на 47 км по 619,94 ₽/т, погрузка мусора 94,64 ₽/т, ПГС 34,7 м3 по индексу 1 682,96 ₽.
*/

const wageScale = buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);

function transportSeries(): TransportSeries {
  return {
    prefix: "02-15-1-01",
    vehicle: "02",
    capacity: 15,
    capacityUnit: "т",
    cls: 1,
    road: "01",
    vehicleName: "Автомобили-самосвалы",
    roadName: "усовершенствованное дорожное покрытие",
    prices: Array.from({ length: 60 }, (_, index) => (index + 1 === 47 ? 619.94 : null)),
  };
}

const LOADS: LoadPrice[] = [
  { code: "49-1", group: 49, groupName: "Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3", operation: "LOAD", price: 94.64 },
  { code: "47-1", group: 47, groupName: "Мусор строительный с погрузкой вручную", operation: "LOAD", price: 1391.69 },
  { code: "48-1", group: 48, groupName: "Мусор строительный с погрузкой транспортерами", operation: "LOAD", price: 378.79 },
  { code: "42-1", group: 42, groupName: "Гравий (выгрузка учитывает перемещение транспортерами)", operation: "LOAD", price: 94.64 },
];

const SERVICES = servicesFromRecords([transportSeries()], LOADS);

const TRANSPORT_NAME =
  "Перевозка грузов I класса автомобилями-самосвалами грузоподъемностью до 15 т по дорогам с усовершенствованным дорожным покрытием на расстояние 47 км";

function serviceItem(patch: Partial<BillOfWorkItem>): BillOfWorkItem {
  return makeBillItem({
    id: "service",
    workName: TRANSPORT_NAME,
    quantity: 505.94,
    quantityUnit: "т",
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    ...patch,
  });
}

function book(patch: Partial<EstimatePriceBook> = {}): EstimatePriceBook {
  return makePriceBook(wageScale, { services: SERVICES, ...patch });
}

function estimate(items: readonly BillOfWorkItem[], priceBook: EstimatePriceBook = book()) {
  return buildEstimate({
    title: "Тест",
    sections: [makeBillSection("Смета", items)],
    priceBook,
    parameters: makeParameters(),
    resolveNorm: () => null,
    sources: [],
    generatedAt: "2026-10-08T00:00:00.000Z",
    disclaimer: "тест",
  });
}

const lineOf = (document: ReturnType<typeof estimate>) => document.sections[0]!.lines[0]!;

describe("перевозка и погрузка по ценам ФГИС ЦС", () => {
  it("перевозка по шифру: 505,94 т × 619,94 = 313 652,44, НР и СП не начисляются", () => {
    const document = estimate([serviceItem({ serviceCode: "02-15-1-01-0047" })]);
    const line = lineOf(document);

    expect(line.directCost).toBe(313652.44);
    expect(line).toMatchObject({
      normCode: "02-15-1-01-0047",
      normBaseType: "ФГИС ЦС перевозка",
      normUnit: "т",
      quantity: 505.94,
      overheadCost: 0,
      profitCost: 0,
      wageFund: 0,
      overheadSource: "NONE",
      profitSource: "NONE",
      priceSource: "FGIS_SERVICE",
    });
    expect(line.priceNote).toBe("ФГИС ЦС, сметные цены на перевозку, Амурская область (1 зона), 3 квартал 2026 г., код 02-15-1-01-0047");
    expect(line.resources).toHaveLength(1);
    expect(line.resources[0]).toMatchObject({ code: "02-15-1-01-0047", unit: "т", quantity: 505.94, unitPrice: 619.94, total: 313652.44, source: "FGIS_SERVICE" });
    expect(document.gaps).toEqual([]);
    expect(document.totals.workCost).toBe(313652.44);
  });

  it("погрузка по шифру: 505,94 × 94,64 = 47 882,16 и 55,52 × 94,64 = 5 254,41", () => {
    const document = estimate([
      serviceItem({ id: "debris", workName: "Погрузка в автотранспортное средство: мусор строительный с погрузкой экскаваторами", serviceCode: "49-1" }),
      serviceItem({ id: "gravel", workName: "Погрузка в автотранспортное средство: гравий", quantity: 55.52, serviceCode: "42-1" }),
    ]);
    const [debris, gravel] = document.sections[0]!.lines;

    expect(debris).toMatchObject({ directCost: 47882.16, normBaseType: "ФГИС ЦС ПРР", normCode: "49-1" });
    expect(debris?.priceNote).toBe("ФГИС ЦС, сметные цены на погрузочно-разгрузочные работы, Амурская область (1 зона), 3 квартал 2026 г., код 49-1");
    expect(gravel?.directCost).toBe(5254.41);
    expect(document.gaps).toEqual([]);
  });

  it("без шифра — по наименованию: однозначный разбор даёт ту же цену", () => {
    const transport = lineOf(estimate([serviceItem({})]));
    expect(transport).toMatchObject({ directCost: 313652.44, normCode: "02-15-1-01-0047", priceSource: "FGIS_SERVICE" });

    const loading = lineOf(
      estimate([serviceItem({ workName: "Погрузка в автотранспортное средство: мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 M3" })]),
    );
    expect(loading).toMatchObject({ directCost: 47882.16, normCode: "49-1" });
  });

  it("цена заказчика не нужна: строка не «по цене заказчика», и в допущения она не попадает", () => {
    const withCustomer = serviceItem({
      serviceCode: "02-15-1-01-0047",
      customerPrice: { total: 1, unitPrice: 0.002, unit: "т", origin: "LINE", document: "смета" },
    });
    const document = estimate([withCustomer]);

    expect(lineOf(document).priceSource).toBe("FGIS_SERVICE");
    expect(document.totals.customerPriced).toBeUndefined();
    expect(computeAssurance(document).assumptions).toEqual([]);
    expect(computeAssurance(document).assumedPercent).toBe(0);
  });

  it("наименование неоднозначно («мусор строительный» без способа) — наша цена не берётся, остаётся цена заказчика", () => {
    const item = serviceItem({
      workName: "Погрузка в автотранспортное средство: мусор строительный",
      customerPrice: { total: 47882.16, unitPrice: 94.64, unit: "т", origin: "LINE", document: "смета" },
    });
    const document = estimate([item]);

    expect(lineOf(document)).toMatchObject({ priceSource: "CUSTOMER_PRICE", directCost: 47882.16 });
  });

  it("неоднозначное наименование без цены заказчика — позиция выпадает с NO_NORM, цена не выдумывается", () => {
    const document = estimate([serviceItem({ workName: "Погрузка в автотранспортное средство: мусор строительный" })]);

    expect(document.sections[0]!.lines).toEqual([]);
    expect(document.gaps.map((gap) => gap.kind)).toEqual(["NO_NORM"]);
  });

  it("шифр назван, а километры вне таблицы — цена заказчика с причиной «нашей цены услуги нет»", () => {
    const item = serviceItem({
      serviceCode: "02-15-1-01-0099",
      customerPrice: { total: 100_000, unitPrice: 197.65, unit: "т", origin: "LINE", document: "смета" },
    });
    const document = estimate([item]);

    expect(lineOf(document).priceSource).toBe("CUSTOMER_PRICE");
    const gap = document.gaps.find((entry) => entry.kind === "CUSTOMER_PRICE");
    expect(gap?.message).toContain("нашей цены услуги 02-15-1-01-0099 нет");
    expect(gap?.message).toContain("больше таблицы перевозки зоны (60 км)");
  });

  it("объём не в тоннах — цена за тонну не применяется", () => {
    const document = estimate([
      serviceItem({
        serviceCode: "02-15-1-01-0047",
        quantityUnit: "м3",
        customerPrice: { total: 1000, unitPrice: 10, unit: "м3", origin: "LINE", document: "смета" },
      }),
    ]);

    expect(lineOf(document).priceSource).toBe("CUSTOMER_PRICE");
  });

  it("зона собрана без таблиц (старая сборка): всё как прежде — цена заказчика", () => {
    const item = serviceItem({
      serviceCode: "02-15-1-01-0047",
      customerPrice: { total: 313652.44, unitPrice: 619.94, unit: "т", origin: "LINE", document: "смета" },
    });

    expect(lineOf(estimate([item], book({ services: null }))).priceSource).toBe("CUSTOMER_PRICE");
    expect(lineOf(estimate([item], book({ services: undefined }))).priceSource).toBe("CUSTOMER_PRICE");
  });

  it("явный шифр расценки ГЭСН в строке важнее услуги: норма подбирается по-прежнему", () => {
    const norm: NormRecord = {
      code: "46-06-009-03",
      tableCode: "46-06-009",
      fullName: "Разборка зданий",
      endName: "",
      unit: "т",
      collectionCode: "46",
      collectionName: "",
      sectionName: "",
      subsectionName: "",
      baseType: "ГЭСН",
      content: [],
      resources: [],
      overheadRef: null,
      profitRef: null,
    };
    const item = serviceItem({ normCode: "46-06-009-03", normBaseType: "ГЭСН", serviceCode: "02-15-1-01-0047" });
    const document = buildEstimate({
      title: "Тест",
      sections: [makeBillSection("Смета", [item])],
      priceBook: book(),
      parameters: makeParameters(),
      resolveNorm: () => ({ norm, reasons: [] }),
      sources: [],
      generatedAt: "2026-10-08T00:00:00.000Z",
      disclaimer: "тест",
    });

    expect(lineOf(document).normBaseType).toBe("ГЭСН");
    expect(lineOf(document).priceSource).toBeUndefined();
  });

  it("документ проходит схему и арифметическую сверку; пометка источника сохраняется", () => {
    const document = estimate([
      serviceItem({ id: "t", serviceCode: "02-15-1-01-0047" }),
      serviceItem({ id: "l", workName: "Погрузка", serviceCode: "49-1" }),
    ]);

    expect(auditEstimateArithmetic(parseEstimateDocument(JSON.parse(JSON.stringify(document)) as unknown))).toEqual([]);
    const parsed = parseEstimateDocument(JSON.parse(JSON.stringify(document)) as unknown);
    expect(parsed.sections[0]!.lines.map((line) => line.priceSource)).toEqual(["FGIS_SERVICE", "FGIS_SERVICE"]);
    expect(parsed.sections[0]!.lines[0]!.priceNote).toContain("код 02-15-1-01-0047");
  });
});

/* ------------------------------ Цена материала без текущей цены зоны ------------------------------ */

const GRAVEL_CODE = "02.2.04.03-0013";
const GRAVEL_BASE: ResourcePrice = {
  code: GRAVEL_CODE,
  name: "Смесь песчано-гравийная обогащенная с содержанием гравия 35-50 %",
  unit: "м3",
  price: 1912.45,
  machinistSalary: null,
  machinistHours: null,
  source: "BASE_2022",
  period: null,
  zone: null,
};
const SPLIT_ALL = new Map<string, SplitAllPrice>([[GRAVEL_CODE, { price: 1682.96, unit: "м3", indexed: true }]]);

function supply(patch: Partial<BillOfWorkItem> = {}): BillOfWorkItem {
  return makeBillItem({
    id: "gravel",
    workName: "Смесь песчано-гравийная обогащенная с содержанием гравия 35-50 %",
    quantity: 34.7,
    quantityUnit: "м3",
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    resourceCode: GRAVEL_CODE,
    ...patch,
  });
}

function supplyBook(patch: Partial<EstimatePriceBook> = {}): EstimatePriceBook {
  return makePriceBook(wageScale, { base: new Map([[GRAVEL_CODE, GRAVEL_BASE]]), ...patch });
}

describe("цена материала: книга зоны → все цены сплит-формы → база 2022", () => {
  it("ПГС, которой нет в книге зоны, считается по индексу сплит-формы: 34,7 × 1 682,96 = 58 398,71", () => {
    const document = estimate([supply()], supplyBook({ splitAll: SPLIT_ALL }));
    const line = lineOf(document);

    expect(line.directCost).toBe(58398.71);
    expect(line.resources[0]).toMatchObject({ unitPrice: 1682.96, source: "SPLIT_INDEXED", total: 58398.71, name: GRAVEL_BASE.name });
    expect(document.gaps.map((gap) => gap.kind)).toEqual(["INDEXED_PRICE"]);
    expect(document.gaps[0]!.message).toContain("по индексу сплит-формы");
    expect(document.gaps[0]!.message).not.toContain("база");
  });

  it("в Надёжности цена по индексу — не допущение «база 2022», а отдельная строка", () => {
    const assurance = computeAssurance(estimate([supply()], supplyBook({ splitAll: SPLIT_ALL })));

    expect(assurance.assumptions.map((assumption) => assumption.kind)).not.toContain("BASE_PRICE");
    expect(assurance.assumedCost).toBe(0);
    expect(assurance.indexedPrices).toMatchObject({ cost: 58398.71, percent: 100 });
    expect(assurance.indexedPrices?.message).toContain("по индексу сплит-формы");
  });

  it("сплит-формы нет (зона собрана раньше) — как прежде: база 2022 без пересчёта, допущение BASE_PRICE", () => {
    const document = estimate([supply()], supplyBook({ splitAll: null }));
    const line = lineOf(document);

    expect(line.resources[0]).toMatchObject({ unitPrice: 1912.45, source: "BASE_2022" });
    expect(document.gaps.map((gap) => gap.kind)).toEqual(["NO_CURRENT_PRICE"]);
    const assurance = computeAssurance(document);
    expect(assurance.assumptions.map((assumption) => assumption.kind)).toEqual(["BASE_PRICE"]);
    expect(assurance.indexedPrices).toBeUndefined();
  });

  it("цена сплит-формы не по индексу (измерена по зоне) — текущая цена зоны, без пометки", () => {
    const measured = new Map<string, SplitAllPrice>([[GRAVEL_CODE, { price: 1700, unit: "м3", indexed: false }]]);
    const document = estimate([supply()], supplyBook({ splitAll: measured }));

    expect(lineOf(document).resources[0]).toMatchObject({ unitPrice: 1700, source: "CURRENT_ZONE" });
    expect(document.gaps).toEqual([]);
  });

  it("книга зоны важнее сплит-формы: есть текущая цена — берётся она", () => {
    const current: ResourcePrice = { ...GRAVEL_BASE, price: 1800, source: "CURRENT_ZONE", period: "3 квартал 2026 г.", zone: AMUR_ZONE.zone };
    const document = estimate([supply()], supplyBook({ splitAll: SPLIT_ALL, current: new Map([[GRAVEL_CODE, current]]) }));

    expect(lineOf(document).resources[0]).toMatchObject({ unitPrice: 1800, source: "CURRENT_ZONE" });
    expect(document.gaps).toEqual([]);
  });

  it("цена книги, полученная индексом к группе (источник BASE_2022_INDEXED в сплит-форме), подписана «по индексу сплит-формы»", () => {
    const indexed: ResourcePrice = { ...GRAVEL_BASE, price: 1682.96, source: "BASE_2022_INDEXED", period: "3 квартал 2026 г.", zone: AMUR_ZONE.zone };
    const document = estimate([supply()], supplyBook({ current: new Map([[GRAVEL_CODE, indexed]]) }));

    expect(lineOf(document).resources[0]).toMatchObject({ unitPrice: 1682.96, source: "SPLIT_INDEXED" });
    // Пометки нет: цена книги зоны — обычный путь, не фолбэк.
    expect(document.gaps).toEqual([]);
    expect(computeAssurance(document).assumedCost).toBe(0);
  });

  it("нулевая цена сплит-формы не цена: идём дальше, в базу", () => {
    const zero = new Map<string, SplitAllPrice>([[GRAVEL_CODE, { price: 0, unit: "м3", indexed: true }]]);
    const document = estimate([supply()], supplyBook({ splitAll: zero }));

    expect(lineOf(document).resources[0]).toMatchObject({ unitPrice: 1912.45, source: "BASE_2022" });
  });

  it("единица поставки берётся и из сплит-формы: расхождение с ведомостью называется, как раньше", () => {
    const document = estimate([supply({ quantityUnit: "т" })], supplyBook({ splitAll: SPLIT_ALL }));

    expect(document.gaps.map((gap) => gap.kind)).toContain("UNIT_MISMATCH");
  });
});

describe("машина из «всех цен сплит-формы»: так же, как в аудите", () => {
  const MACHINE = "91.99.99-001";
  const machineSplit = new Map<string, SplitAllPrice>([[MACHINE, { price: 2000, unit: "маш.-ч", indexed: false }]]);
  const machineBase: ResourcePrice = {
    code: MACHINE,
    name: "Машина тестовая",
    unit: "маш.-ч",
    price: 1500,
    machinistSalary: null,
    machinistHours: null,
    source: "BASE_2022",
    period: null,
    zone: null,
  };

  function normWith(resources: NormRecord["resources"]): NormRecord {
    return {
      code: "99-99-999-01",
      tableCode: "99-99-999",
      fullName: "Тестовая работа",
      endName: "",
      unit: "100 м3",
      collectionCode: "99",
      collectionName: "",
      sectionName: "",
      subsectionName: "",
      baseType: "ГЭСН",
      content: [],
      resources,
      overheadRef: null,
      profitRef: null,
    };
  }
  const machineRow = { code: MACHINE, kind: "MACHINE", name: "", quantity: 2, unit: "маш.-ч", quantityNote: null, projectSpecific: false, technologyGroup: null } as const;
  const operatorRow = { code: "2", kind: "MACHINIST_HOURS", name: "", quantity: 2, unit: "чел.-ч", quantityNote: null, projectSpecific: false, technologyGroup: null } as const;
  const item = makeBillItem({ quantity: 100, quantityUnit: "м3", unitDivisor: 100, normCode: "99-99-999-01" });

  it("в норме есть строка машинистов: цена из «всех цен» не берётся (оплаты звена не выделить), идёт база 2022", () => {
    const priceBook = makePriceBook(wageScale, { splitAll: machineSplit, base: new Map([[MACHINE, machineBase]]) });
    const { line } = computeEstimateLine(item, { norm: normWith([machineRow, operatorRow]), reasons: [] }, priceBook, makeParameters());

    expect(line?.resources.find((resource) => resource.code === MACHINE)).toMatchObject({ unitPrice: 1500, source: "BASE_2022" });
  });

  it("строки машинистов в норме нет: цена машины берётся из «всех цен»", () => {
    const priceBook = makePriceBook(wageScale, { splitAll: machineSplit, base: new Map([[MACHINE, machineBase]]) });
    const { line } = computeEstimateLine(item, { norm: normWith([machineRow]), reasons: [] }, priceBook, makeParameters());

    expect(line?.resources.find((resource) => resource.code === MACHINE)).toMatchObject({ unitPrice: 2000, source: "CURRENT_ZONE" });
  });

  it("машина — поставка (ресурс в ведомости) — берётся из «всех цен»", () => {
    const priceBook = makePriceBook(wageScale, { splitAll: machineSplit, base: new Map([[MACHINE, machineBase]]) });
    const document = estimate([supply({ resourceCode: MACHINE, quantity: 3, quantityUnit: "маш.-ч" })], priceBook);

    expect(lineOf(document).resources[0]).toMatchObject({ unitPrice: 2000, total: 6000 });
  });
});
