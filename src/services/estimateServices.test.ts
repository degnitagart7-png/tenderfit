import { describe, expect, it } from "vitest";

import { servicesFromRecords, type LoadPrice, type TransportSeries } from "@/domain/estimate/autoServices";
import type { BillExtractionRow } from "@/domain/estimate/billExtraction";
import { computeAssurance } from "@/domain/estimate/assurance";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import type { NormRecord, SplitAllPrice } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import type { BillRowsFetcher } from "@/services/billOfWorkExtraction";
import { buildEstimateFromDocuments, type ZoneExtras } from "@/services/estimateService";
import { AMUR_WAGE_ANCHORS, AMUR_ZONE, BASE_PRICES, makeParameters, makePriceBook, makeSearchNorm } from "@/test/estimateFixtures";
import { SMETA_001_OCR, SMETA_NAME, SMETA_ROWS } from "@/test/volumeSourceFixtures";

/**
 * Закупка 0134600012126000001 на фикстурах прошлых тестов (`volumeSourceFixtures.ts`) и подставных
 * ценах зоны: те же числа, что на реальной базе зоны 246 (`estimateZone246.test.ts`), но без чтения
 * индекса с диска, чтобы проверка работала на любой машине.
 */

const DEMOLITION: NormRecord = makeSearchNorm({
  code: "46-06-009-03",
  fullName: "Разборка зданий методом обрушения: деревянных жилых домов и прочих отапливаемых зданий",
  endName: "деревянных жилых домов и прочих отапливаемых зданий",
  unit: "100 м3 строительного объема",
  collectionCode: "46",
  collectionName: "Работы при реконструкции зданий и сооружений",
  baseType: "ГЭСН",
});
const GRADING: NormRecord = makeSearchNorm({
  code: "01-02-027-02",
  fullName: "Планировка площадей: механизированным способом, группа грунтов 2",
  endName: "механизированным способом, группа грунтов 2",
  unit: "1000 м2",
  collectionCode: "01",
  collectionName: "Земляные работы",
  baseType: "ГЭСН",
});

const GRAVEL = "02.2.04.03-0013";
const GRAVEL_BASE = {
  code: GRAVEL,
  name: "Смесь песчано-гравийная обогащенная с содержанием гравия 35-50 %",
  unit: "м3",
  price: 1912.45,
  machinistSalary: null,
  machinistHours: null,
  source: "BASE_2022" as const,
  period: null,
  zone: null,
};

function makeBase(): EstimateBase {
  return {
    info: {
      indexDir: "data/fsnb/index",
      builtAt: "2026-10-08T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: "Иркутская область",
      priceZone: "Иркутская область (1 зона)",
      period: AMUR_ZONE.period,
      decree: "Приказ Минстроя России от 30.12.2021 № 1046/пр",
      counts: { norms: 2, basePrices: 0, currentPrices: 0, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE), {
      region: "Иркутская область",
      priceZone: "Иркутская область (1 зона)",
      base: new Map([...BASE_PRICES, GRAVEL_BASE].map((price) => [price.code, price])),
    }),
    searchIndex: createNormSearchIndex([DEMOLITION, GRADING]),
    zones: [],
    sources: [],
    loadMs: 0,
  };
}

const transport: TransportSeries = {
  prefix: "02-15-1-01",
  vehicle: "02",
  capacity: 15,
  capacityUnit: "т",
  cls: 1,
  road: "01",
  vehicleName: "Автомобили-самосвалы",
  roadName: null,
  prices: Array.from({ length: 100 }, (_, index) => (index + 1 === 47 ? 619.94 : null)),
};
const loads: LoadPrice[] = [
  { code: "49-1", group: 49, groupName: "Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3", operation: "LOAD", price: 94.64 },
  { code: "42-1", group: 42, groupName: "Гравий (выгрузка учитывает перемещение транспортерами)", operation: "LOAD", price: 94.64 },
];
const EXTRAS: ZoneExtras = {
  splitAll: new Map<string, SplitAllPrice>([[GRAVEL, { price: 1682.96, unit: "м3", indexed: true }]]),
  services: servicesFromRecords([transport], loads),
};

interface Doc {
  readonly name: string;
  readonly text: string;
  readonly rows: readonly BillExtractionRow[];
}

function fetcherFor(docs: readonly Doc[]): BillRowsFetcher {
  return async ({ documentName }) => ({
    rows: [...(docs.find((doc) => doc.name === documentName)?.rows ?? [])],
    hasBill: true,
    tokens: 0,
    malformed: 0,
    truncated: false,
  });
}

async function estimate(docs: readonly Doc[], extras: ZoneExtras | null = EXTRAS) {
  return buildEstimateFromDocuments(
    {
      regNumber: "0134600012126000001",
      subject: "Снос дома",
      documents: docs.map(({ name, text }) => ({ name, text })),
      parameters: makeParameters({ vatPercent: 22 }),
      now: new Date("2026-10-08T00:00:00.000Z"),
    },
    { base: makeBase(), fetcher: fetcherFor(docs), ...(extras === null ? {} : { loadZoneExtras: async () => extras }) },
  );
}

const SMETA: Doc = { name: SMETA_NAME, text: SMETA_001_OCR, rows: SMETA_ROWS };
const lines = (result: Awaited<ReturnType<typeof estimate>>) => result.document.sections.flatMap((section) => section.lines);
const cost = (line: { directCost: number; overheadCost: number; profitCost: number } | undefined) =>
  line === undefined ? undefined : Math.round((line.directCost + line.overheadCost + line.profitCost) * 100) / 100;

describe("закупка 001: перевозка, погрузка и ПГС нашими ценами", () => {
  it("шифры из обоснования строк сметы доходят до расчёта: 02-15-1-01-0047, 49-1, 42-1", async () => {
    const result = await estimate([SMETA]);

    const codes = lines(result)
      .filter((line) => line.priceSource === "FGIS_SERVICE")
      .map((line) => line.normCode)
      .sort();
    expect(codes).toEqual(["02-15-1-01-0047", "42-1", "49-1"]);
  });

  it("перевозка 313 652,44, погрузка мусора 47 882,16, погрузка гравия 5 254,41", async () => {
    const result = await estimate([SMETA]);
    const byCode = (code: string) => lines(result).find((line) => line.normCode === code);

    expect(cost(byCode("02-15-1-01-0047"))).toBe(313652.44);
    expect(cost(byCode("49-1"))).toBe(47882.16);
    expect(cost(byCode("42-1"))).toBe(5254.41);
  });

  it("ПГС — по индексу сплит-формы: 34,7 × 1 682,96 = 58 398,71", async () => {
    const result = await estimate([SMETA]);
    const gravel = lines(result).find((line) => line.normCode === GRAVEL);

    expect(cost(gravel)).toBe(58398.71);
    expect(gravel?.resources[0]).toMatchObject({ source: "SPLIT_INDEXED", unitPrice: 1682.96 });
  });

  it("по цене заказчика — только то, что нашими данными не посчитать: размещение и перевозка ПГС без километража", async () => {
    const result = await estimate([SMETA]);
    const byCustomer = lines(result).filter((line) => line.priceSource === "CUSTOMER_PRICE");

    expect(byCustomer.map((line) => cost(line))).toEqual([16378.96, 420775.12]);
    expect(result.document.totals.customerPricedCount).toBe(2);
    const assurance = computeAssurance(result.document);
    expect(assurance.assumptions.map((assumption) => assumption.kind)).toEqual(["CUSTOMER_PRICE"]);
    expect(assurance.indexedPrices?.cost).toBe(58398.71);
  });

  it("зона без таблиц и сплит-формы (старая сборка): прежний результат — пять позиций по цене заказчика", async () => {
    const result = await estimate([SMETA], { splitAll: null, services: null });

    expect(result.document.totals.customerPricedCount).toBe(5);
    expect(result.document.totals.customerPriced).toBe(803943.09);
    expect(lines(result).filter((line) => line.priceSource === "FGIS_SERVICE")).toEqual([]);
  });

  it("при подставленной базе без loadZoneExtras файлы зоны не читаются: тест не зависит от диска", async () => {
    const result = await estimate([SMETA], null);

    expect(result.document.totals.customerPricedCount).toBe(5);
  });
});

describe("позиция ведомости без шифра", () => {
  const BILL: Doc = {
    name: "Ведомость объемов работ.xlsx",
    text: [
      "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
      "1 Погрузка в автотранспортное средство: мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3 | т | 500",
      "2 Перевозка грузов I класса автомобилями-самосвалами грузоподъемностью до 15 т по дорогам с усовершенствованным покрытием на расстояние 47 км | т | 500",
    ].join("\n"),
    rows: [
      {
        workName: "Погрузка в автотранспортное средство: мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3",
        quantity: "500",
        unit: "т",
        evidenceQuote: "1 Погрузка в автотранспортное средство: мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3 | т | 500",
      },
      {
        workName: "Перевозка грузов I класса автомобилями-самосвалами грузоподъемностью до 15 т по дорогам с усовершенствованным покрытием на расстояние 47 км",
        quantity: "500",
        unit: "т",
        evidenceQuote:
          "2 Перевозка грузов I класса автомобилями-самосвалами грузоподъемностью до 15 т по дорогам с усовершенствованным покрытием на расстояние 47 км | т | 500",
      },
    ],
  };

  it("считается по наименованию: однозначный разбор даёт цену, объём берётся из ведомости (500 т, не 505,94)", async () => {
    const result = await estimate([BILL]);
    const priced = lines(result).filter((line) => line.priceSource === "FGIS_SERVICE");

    expect(priced.map((line) => [line.normCode, cost(line)])).toEqual([
      ["49-1", 47320],
      ["02-15-1-01-0047", 309970],
    ]);
  });

  it("а расплывчатая строка («Перевозка мусора») без шифра и без расстояния выпадает как раньше, цена не выдумывается", async () => {
    const vague: Doc = {
      ...BILL,
      text: "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ\n1 Перевозка мусора | т | 500",
      rows: [{ workName: "Перевозка мусора", quantity: "500", unit: "т", evidenceQuote: "1 Перевозка мусора | т | 500" }],
    };
    const result = await estimate([vague]);

    expect(lines(result)).toEqual([]);
    expect(result.document.gaps.map((gap) => gap.kind)).toEqual(["NO_NORM"]);
  });
});

describe("шифр услуги из сметы заказчика для позиции ведомости", () => {
  const BILL: Doc = {
    name: "Ведомость объемов работ.xlsx",
    text: "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ\n1 Перевозка грузов I класса автомобилями-самосвалами | т | 505,94",
    rows: [
      {
        workName: "Перевозка грузов I класса автомобилями-самосвалами",
        quantity: "505,94",
        unit: "т",
        evidenceQuote: "1 Перевозка грузов I класса автомобилями-самосвалами | т | 505,94",
      },
    ],
  };

  it("наименование без расстояния нашей цены не даёт, но сопоставленная (по объёму и наименованию) строка сметы называет шифр — цена по шифру", async () => {
    const result = await estimate([BILL, SMETA]);
    const priced = lines(result).find((line) => line.priceSource === "FGIS_SERVICE");

    expect(priced).toMatchObject({ normCode: "02-15-1-01-0047", billQuantity: 505.94 });
    expect(cost(priced)).toBe(313652.44);
  });

  it("без сметы заказчика та же строка выпадает: шифра взять неоткуда", async () => {
    const result = await estimate([BILL]);

    expect(lines(result)).toEqual([]);
  });
});

