import { describe, expect, it } from "vitest";

import {
  isServiceItem,
  isServiceName,
  resolveServicePrice,
  serviceRowCodeOf,
  servicesFromRecords,
  type LoadPrice,
  type TransportSeries,
} from "@/domain/estimate/autoServices";
import { buildEstimate, computeEstimateSection, type EstimatePriceBook } from "@/domain/estimate/calculate";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { lsrDocument, type PositionSpec } from "@/domain/estimate/customerLsr.builders";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import type { BillOfWorkItem, NormRecord } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import { calculateBill, resolveNormFor } from "@/services/estimateService";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeSearchNorm,
} from "@/test/estimateFixtures";

/*
  Погрузка, разгрузка и перевозка с шифрами сметных цен («03-1», «42-1», «49-1», «02-15-1-01-0047», «ФСБЦ-…_02-15») — услуги, а не
  расценки ГЭСН. Закупка 32616401076 (Тюмень): «03-1 Погрузка в автотранспортное средство: изделия из сборного железобетона», 75,8 т,
  у заказчика 30 714,92 ₽; поиск по наименованию нашёл ГЭСН 29-02-113-01 и дал 184 790 ₽ на каждую из двух строк (погрузка и разгрузка).
*/

const WAGE_SCALE = buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);

const LOAD_NAME = "Погрузка в автотранспортное средство: изделия из сборного железобетона";
const UNLOAD_NAME = "Разгрузка из автотранспортного средства: изделия из сборного железобетона";
const TRANSPORT_NAME =
  "Перевозка грузов I класса автомобилями-самосвалами грузоподъемностью до 15 т по дорогам с усовершенствованным дорожным покрытием на расстояние 47 км";

/** Расценка ГЭСН, на которую «Погрузка…» попадала по наименованию. */
const WRONG_NORM: NormRecord = makeSearchNorm({
  code: "29-02-113-01",
  fullName: LOAD_NAME,
  endName: "изделия из сборного железобетона",
  unit: "т",
  collectionCode: "29",
  collectionName: "Здания и сооружения",
  baseType: "ГЭСН",
});

const service = (id: string, patch: Partial<BillOfWorkItem>): BillOfWorkItem =>
  makeBillItem({
    id,
    workName: LOAD_NAME,
    quantity: 75.8,
    quantityUnit: "т",
    unitDivisor: 1,
    normCode: null,
    normBaseType: null,
    customerPrice: { total: 30_714.92, unitPrice: 30_714.92 / 75.8, unit: "т", origin: "POSITION_TOTAL", document: "смета" },
    ...patch,
  });

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
  { code: "03-1", group: 3, groupName: "Изделия из сборного железобетона", operation: "LOAD", price: 405.2 },
  { code: "03-2", group: 3, groupName: "Изделия из сборного железобетона", operation: "UNLOAD", price: 301.1 },
  { code: "42-1", group: 42, groupName: "Гравий (выгрузка учитывает перемещение транспортерами)", operation: "LOAD", price: 94.64 },
];
const SERVICES = servicesFromRecords([transportSeries()], LOADS);
const NO_SERVICES = servicesFromRecords([], []);

const priceBook = (services: EstimatePriceBook["services"]) => makePriceBook(WAGE_SCALE, { services });

/* ------------------------- Распознавание ------------------------- */

describe("распознавание строки-услуги", () => {
  it("шифры погрузки, перевозки, ФССЦпг и материал с хвостом класса груза — услуга; расценка и ресурс — нет", () => {
    expect(serviceRowCodeOf("03-1")).toEqual({ service: true, code: "03-1" });
    expect(serviceRowCodeOf("42-2")).toEqual({ service: true, code: "42-2" });
    expect(serviceRowCodeOf("02-15-1-01-0047")).toEqual({ service: true, code: "02-15-1-01-0047" });
    expect(serviceRowCodeOf("03-1\nпримечание")).toEqual({ service: true, code: "03-1" });
    expect(serviceRowCodeOf("ФССЦпг-01-01-01-045")).toEqual({ service: true, code: null });
    expect(serviceRowCodeOf("ФСБЦ-02.2.04.03-0013_02-15")).toEqual({ service: true, code: null });
    expect(serviceRowCodeOf("ГЭСН29-02-113-01")).toEqual({ service: false, code: null });
    expect(serviceRowCodeOf("ФСБЦ-02.2.04.03-0013")).toEqual({ service: false, code: null });
    expect(serviceRowCodeOf("1-100-23")).toEqual({ service: false, code: null });
    expect(serviceRowCodeOf("")).toEqual({ service: false, code: null });
  });

  it("наименование: «Погрузка», «Разгрузка», «Перевозка грузов»; «Перевозка рабочих» — не услуга", () => {
    expect(isServiceName(LOAD_NAME)).toBe(true);
    expect(isServiceName(UNLOAD_NAME)).toBe(true);
    expect(isServiceName(TRANSPORT_NAME)).toBe(true);
    expect(isServiceName("Перевозка рабочих к месту работ")).toBe(false);
    expect(isServiceName("Монтаж погрузчика")).toBe(false);
    expect(isServiceItem({ workName: "Устройство основания" })).toBe(false);
    expect(isServiceItem({ workName: "Что-то", serviceCode: "03-1" })).toBe(true);
    expect(isServiceItem({ workName: "Что-то", serviceRow: true })).toBe(true);
  });
});

/* ------------------------- Ведомость из ЛСР ------------------------- */

const row = (n: number, justification: string, name: string, total: number, qty = 75.8, unit = "т"): PositionSpec => ({ n, justification, name, unit, qty, resources: [], override: { total } });

const TEXT = lsrDocument({
  positions: [
    row(1, "03-1", LOAD_NAME, 30_714.92),
    row(2, "03-2", UNLOAD_NAME, 30_714.92),
    row(3, "42-1", "Погрузка в автотранспортное средство: гравий", 3_800, 40),
    row(4, "02-15-1-01-0047", TRANSPORT_NAME, 31_364.24, 50.6),
    row(5, "ФСБЦ-02.2.04.03-0013_02-15", "Смесь песчано-гравийная, перевозка 15 км", 12_000, 20, "м3"),
    // Контроль: работа по расценке ГЭСН с «Погрузкой» в наименовании остаётся работой по расценке.
    row(6, "ГЭСН01-01-005-02", "Погрузка вручную строительного мусора", 5_000, 10),
  ],
});
const SET = buildLsrSet(parseCustomerLsr([{ name: "смета.xlsx", text: TEXT }]).estimates);
const BILL = lsrBillSection(SET.entries[0] as (typeof SET.entries)[number], 1);
const itemAt = (label: string) => BILL.section.items.find((item) => item.positionNumber === label) as BillOfWorkItem;

describe("ведомость из ЛСР заказчика: строки перевозки и погрузки", () => {
  it("все шесть позиций в ведомости, остатков нет: у услуги «Всего по позиции» — сама цена", () => {
    expect(BILL.skipped).toEqual([]);
    expect(BILL.section.items.map((item) => item.positionNumber)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(BILL.section.items.some((item) => item.unaccountedOf !== undefined)).toBe(false);
  });

  it("«03-1», «03-2», «42-1» и «02-15-1-01-0047»: признак услуги и шифр для таблиц зоны", () => {
    expect(itemAt("1")).toMatchObject({ serviceRow: true, serviceCode: "03-1", quantity: 75.8, quantityUnit: "т" });
    expect(itemAt("1").customerPrice?.total).toBeCloseTo(30_714.92, 2);
    expect(itemAt("2")).toMatchObject({ serviceRow: true, serviceCode: "03-2" });
    expect(itemAt("3")).toMatchObject({ serviceRow: true, serviceCode: "42-1" });
    expect(itemAt("4")).toMatchObject({ serviceRow: true, serviceCode: "02-15-1-01-0047" });
  });

  it("«ФСБЦ-…_02-15» — перевозка материала: услуга без шифра для таблиц (цену даёт наименование или цена заказчика)", () => {
    const item = itemAt("5");
    expect(item.serviceRow).toBe(true);
    expect(item.serviceCode).toBeUndefined();
    expect(item.resourceCode).toBeNull();
  });

  it("позиция по расценке ГЭСН с «Погрузкой» в наименовании услугой не считается и несёт шифр расценки", () => {
    const item = itemAt("6");
    expect(item.serviceRow).toBeUndefined();
    expect(item.normCodeHint).toMatchObject({ baseType: "ГЭСН", code: "01-01-005-02" });
  });
});

/* ------------------------- Расчёт ------------------------- */

describe("расчёт: услуга к расценке по наименованию не подбирается никогда", () => {
  /** Подборщик, который нашёл бы «ГЭСН 29-02-113-01» для чего угодно: услуга до него дойти не должна. */
  const calls: string[] = [];
  const resolver = (item: BillOfWorkItem) => {
    calls.push(item.id);
    return { norm: WRONG_NORM, reasons: ["по наименованию"] };
  };
  const run = (items: readonly BillOfWorkItem[], services: EstimatePriceBook["services"]) => {
    calls.length = 0;
    return computeEstimateSection(makeBillSection("ЛСР", items), priceBook(services), makeParameters(), resolver);
  };

  it("шифр «03-1» есть в таблице зоны — цена ФГИС ЦС по шифру, а не 184 790 ₽ по норме 29-02-113-01", () => {
    const { section, gaps } = run([service("load", { serviceCode: "03-1", serviceRow: true }), service("unload", { workName: UNLOAD_NAME, serviceCode: "03-2", serviceRow: true })], SERVICES);
    expect(calls).toEqual([]);
    expect(section.lines.map((line) => line.priceSource)).toEqual(["FGIS_SERVICE", "FGIS_SERVICE"]);
    expect(section.lines[0]?.directCost).toBeCloseTo(75.8 * 405.2, 2);
    expect(section.lines[1]?.directCost).toBeCloseTo(75.8 * 301.1, 2);
    expect(gaps).toEqual([]);
  });

  it("шифра в таблице нет (наши таблицы без группы) — цена заказчика с пометкой, норма не подбирается", () => {
    const { section, gaps } = run([service("load", { serviceCode: "03-1", serviceRow: true }), service("unload", { workName: UNLOAD_NAME, serviceCode: "03-2", serviceRow: true })], SERVICES_WITHOUT_03());
    expect(calls).toEqual([]);
    expect(section.lines.map((line) => line.priceSource)).toEqual(["CUSTOMER_PRICE", "CUSTOMER_PRICE"]);
    expect(section.directCost).toBeCloseTo(2 * 30_714.92, 2);
    expect(gaps.map((gap) => gap.kind)).toEqual(["CUSTOMER_PRICE", "CUSTOMER_PRICE"]);
    expect(gaps[0]?.message).toContain("нашей цены услуги 03-1 нет");
  });

  it("зона собрана без таблиц (старая сборка) — цена заказчика, норма по наименованию не подбирается", () => {
    for (const services of [null, undefined, NO_SERVICES]) {
      const { section } = run([service("load", { serviceRow: true, serviceCode: "03-1" })], services);
      expect(calls).toEqual([]);
      expect(section.lines[0]).toMatchObject({ priceSource: "CUSTOMER_PRICE", directCost: 30_714.92 });
    }
  });

  it("признак услуги не проставлен, шифра нет, но наименование «Погрузка…»: то же самое", () => {
    const { section } = run([service("load", {})], NO_SERVICES);
    expect(calls).toEqual([]);
    expect(section.lines[0]?.priceSource).toBe("CUSTOMER_PRICE");
    expect(section.lines[0]?.directCost).toBeCloseTo(30_714.92, 2);
  });

  it("цены заказчика нет и таблиц нет — «норма не найдена», а не чужая расценка", () => {
    const { section, gaps } = run([service("load", { serviceRow: true, customerPrice: null })], NO_SERVICES);
    expect(calls).toEqual([]);
    expect(section.lines).toEqual([]);
    expect(gaps.map((gap) => gap.kind)).toEqual(["NO_NORM"]);
  });

  it("«ФСБЦ-…_02-15»: шифра нет, наименование разбирается однозначно — цена перевозки по таблице; не разбирается — цена заказчика", () => {
    const parsed = run([service("t", { workName: TRANSPORT_NAME, quantity: 50.6, serviceRow: true })], SERVICES);
    expect(calls).toEqual([]);
    expect(parsed.section.lines[0]).toMatchObject({ priceSource: "FGIS_SERVICE", normCode: "02-15-1-01-0047" });

    const named = run([service("m", { workName: "Смесь песчано-гравийная, перевозка 15 км", quantity: 20, quantityUnit: "м3", serviceRow: true, customerPrice: { total: 12_000, unitPrice: 600, unit: "м3", origin: "POSITION_TOTAL", document: "смета" } })], SERVICES);
    expect(calls).toEqual([]);
    expect(named.section.lines[0]).toMatchObject({ priceSource: "CUSTOMER_PRICE", directCost: 12_000 });
  });

  it("шифр погрузки не нашёлся в таблице, но наименование читается однозначно — цена по наименованию", () => {
    const { section } = run([service("g", { workName: "Погрузка в автотранспортное средство: гравий", quantity: 40, serviceCode: "99-1", serviceRow: true })], SERVICES);
    expect(calls).toEqual([]);
    expect(section.lines[0]).toMatchObject({ priceSource: "FGIS_SERVICE", normCode: "42-1" });
    expect(section.lines[0]?.directCost).toBeCloseTo(40 * 94.64, 2);
  });

  it("явный шифр расценки в строке перекрывает признак услуги: норма подбирается", () => {
    const { section } = run(
      [
        service("hinted", { workName: "Погрузка вручную строительного мусора", normCodeHint: { baseType: "ГЭСН", code: "29-02-113-01", raw: "ГЭСН29-02-113-01" }, serviceRow: true, quantity: 10 }),
        service("coded", { normCode: "29-02-113-01", normBaseType: "ГЭСН", serviceRow: true }),
      ],
      SERVICES,
    );
    expect(calls).toEqual(["hinted", "coded"]);
    expect(section.lines.every((line) => line.priceSource === undefined)).toBe(true);
  });

  it("код услуги без таблицы и неподходящая единица (м3) — цена заказчика с причиной", () => {
    const decision = resolveServicePrice(SERVICES, { serviceCode: "03-1", workName: LOAD_NAME, quantityUnit: "м3", quantity: 5 });
    expect(decision?.ok).toBe(false);
  });
});

function SERVICES_WITHOUT_03() {
  return servicesFromRecords([transportSeries()], LOADS.filter((entry) => !entry.code.startsWith("03-")));
}

/* ------------------------- Подбор нормы и весь путь расчёта ------------------------- */

describe("подбор нормы по наименованию: услуга исключена", () => {
  const base = { searchIndex: createNormSearchIndex([WRONG_NORM]) };

  it("наименование ушло бы в 29-02-113-01 — для строки-услуги подбор возвращает «нормы нет»", () => {
    const plain = makeBillItem({ id: "p", workName: LOAD_NAME, quantity: 75.8, quantityUnit: "т", unitDivisor: 1, normCode: null, normBaseType: null });
    expect(resolveNormFor({ ...plain, normCodeHint: { baseType: "ГЭСН", code: "29-02-113-01", raw: "ГЭСН29-02-113-01" } }, base)?.norm.code).toBe("29-02-113-01");
    expect(resolveNormFor(plain, base)).toBeNull();
    expect(resolveNormFor({ ...plain, workName: "Ничего похожего", serviceRow: true }, base)).toBeNull();
  });
});

describe("весь путь: ЛСР → ведомость → расчёт", () => {
  const baseOf = (): EstimateBase => ({
    info: {
      indexDir: "x",
      builtAt: "2026-10-10T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: AMUR_ZONE.region,
      priceZone: AMUR_ZONE.zone,
      period: AMUR_ZONE.period,
      decree: "тест",
      counts: { norms: 1, basePrices: 0, currentPrices: 0, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    priceBook: makePriceBook(WAGE_SCALE),
    searchIndex: createNormSearchIndex([WRONG_NORM]),
    zones: [],
    sources: [],
    loadMs: 0,
  });

  it("погрузка и разгрузка железобетона — по 30 714,92 ₽ заказчика (не 184 790 ₽ по норме); перевозка и гравий — по цене заказчика", () => {
    const base = baseOf();
    const items = BILL.section.items.filter((item) => ["1", "2", "3", "5"].includes(item.positionNumber ?? ""));
    const { document } = calculateBill({
      title: "Тест",
      sections: [makeBillSection(BILL.section.title, items)],
      base,
      priceBook: base.priceBook,
      parameters: makeParameters(),
      appliedNormatives: [],
      sources: [],
      generatedAt: "2026-10-10T00:00:00.000Z",
    });
    const lines = document.sections[0]?.lines ?? [];
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.priceSource === "CUSTOMER_PRICE")).toBe(true);
    expect(lines[0]?.directCost).toBeCloseTo(30_714.92, 2);
    expect(lines[1]?.directCost).toBeCloseTo(30_714.92, 2);
    expect(lines.map((line) => line.normCode).includes("29-02-113-01")).toBe(false);
    expect(document.totals.workCost).toBeCloseTo(2 * 30_714.92 + 3_800 + 12_000, 2);
    expect(document.gaps.filter((gap) => gap.kind === "CUSTOMER_PRICE")).toHaveLength(4);
  });

  it("buildEstimate без таблиц зоны тоже не подбирает норму услуге", () => {
    const document = buildEstimate({
      title: "Тест",
      sections: [makeBillSection("ЛСР", [service("load", { serviceRow: true, serviceCode: "03-1" })])],
      priceBook: makePriceBook(WAGE_SCALE),
      parameters: makeParameters(),
      resolveNorm: () => ({ norm: WRONG_NORM, reasons: [] }),
      sources: [],
      generatedAt: "2026-10-10T00:00:00.000Z",
      disclaimer: "тест",
    });
    expect(document.sections[0]?.lines[0]?.priceSource).toBe("CUSTOMER_PRICE");
  });
});
