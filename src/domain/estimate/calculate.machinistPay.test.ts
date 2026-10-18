import { describe, expect, it } from "vitest";

import { buildEstimate, computeEstimateLine, computeResourceLine, type EstimatePriceBook } from "@/domain/estimate/calculate";
import { buildLocalEstimateFormRows } from "@/domain/estimate/exportForm";
import type { EstimateParameters, NormRecord, ResourcePrice, SplitAllPrice } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAGLINE_15,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  Оплата труда машинистов в цене маш.-ч.

  «Сметная цена, руб./маш.-ч» из опубликованных ФГИС ЦС текущих цен (ФСЦСР) и из сплит-формы — БЕЗ оплаты машинистов: она вынесена
  в отдельную колонку. Проверено на файле data/fsnb/raw/zones/266/427/fscsr.xlsx, лист «Машины и механизмы»: у 91.14.02-001
  «Автомобили бортовые до 5 т» цена 800,01 при оплате машинистов 912,83 (оплата больше цены — внутри неё её быть не может); в сплит-форме
  у той же машины базис 477,92 и текущая 800,01. База ФСБЦ-2022, наоборот, цену включает: 814,35 − 336,43 = 477,92. Расчёт обязан
  складывать «цена + ОТм» для текущей цены зоны, иначе прямые затраты теряют ОТм — около пятой части затрат на земляных работах и
  демонтаже, — хотя НР и СП от неё начислены.
*/

const CODE = "91.14.02-001";
const WAGE_SCALE = buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);

/** Норма из одной машины: 1 маш.-ч на единицу, без строк машинистов — как норма, где звено в цене. */
const NORM_ONE_MACHINE: NormRecord = {
  ...NORM_DRAGLINE_15,
  code: "01-01-999-01",
  resources: [
    {
      code: CODE,
      kind: "MACHINE",
      name: "Автомобили бортовые, грузоподъемность до 5 т",
      quantity: 1,
      unit: "маш.-ч",
      quantityNote: null,
      projectSpecific: false,
      technologyGroup: null,
    },
  ],
};

/** Та же норма со строками машинистов: split-форма для такой машины не берётся. */
const NORM_WITH_OPERATORS: NormRecord = {
  ...NORM_ONE_MACHINE,
  resources: [
    { code: "2", kind: "MACHINIST_HOURS", name: "", quantity: 1, unit: "чел.-ч", quantityNote: null, projectSpecific: false, technologyGroup: null },
    ...NORM_ONE_MACHINE.resources,
  ],
};

const ITEM = makeBillItem({ id: "m", workName: "Работа автомобиля", quantity: 1000, quantityUnit: "м3", unitDivisor: 1000, normCode: "01-01-999-01" });

const INDICES = {
  period: "III квартал 2026 г.",
  labour: 1.09,
  machinistLabour: 1.12,
  machines: 1.15,
  materials: 1.22,
  source: "Значения заданы для теста",
} as const;

function zonePrice(price: number, machinistSalary: number | null, patch: Partial<ResourcePrice> = {}): ResourcePrice {
  return {
    code: CODE,
    name: "Автомобили бортовые, грузоподъемность до 5 т",
    unit: "маш.-ч",
    price,
    machinistSalary,
    machinistHours: 1,
    source: "CURRENT_ZONE",
    period: "3 квартал 2026 г.",
    zone: AMUR_ZONE.zone,
    ...patch,
  };
}

/** Машина в базе ФСБЦ-2022: полная цена 814,35 с оплатой звена 336,43 («без зарплаты» 477,92). */
const BASE_MACHINE: ResourcePrice = zonePrice(814.35, 336.43, { source: "BASE_2022", period: null, zone: null });

function book(patch: Partial<EstimatePriceBook> = {}): EstimatePriceBook {
  return makePriceBook(WAGE_SCALE, { current: new Map(), base: new Map(), ...patch });
}

function compute(norm: NormRecord, priceBook: EstimatePriceBook, parameters: EstimateParameters = makeParameters()) {
  const outcome = computeEstimateLine(ITEM, { norm, reasons: [] }, priceBook, parameters);
  if (outcome.line === null) throw new Error("строка не посчитана");
  return { line: outcome.line, gaps: outcome.gaps };
}

describe("текущая цена зоны: «цена» без оплаты машинистов, полная стоимость маш.-ч = цена + ОТм", () => {
  const priceBook = book({ current: new Map([[CODE, zonePrice(800.01, 912.83)]]) });

  it("800,01 + 912,83 за 1 маш.-ч: стоимость машины 1 712,84, оплата машинистов 912,83, ФОТ включает её", () => {
    const { line, gaps } = compute(NORM_ONE_MACHINE, priceBook);

    expect(line.machineHours).toBe(1);
    expect(line.machineCost).toBe(1712.84);
    expect(line.machinistSalaryCost).toBe(912.83);
    expect(line.wageFund).toBe(912.83);
    expect(line.labourCost).toBe(0);
    expect(line.directCost).toBe(1712.84);
    expect(gaps).toEqual([]);

    const machine = line.resources[0];
    expect(machine).toMatchObject({ source: "CURRENT_ZONE", unitPrice: 1712.84, total: 1712.84, machinistPay: 912.83, machinistPayTotal: 912.83 });
  });

  it("НР и СП считаются от ФОТ с оплатой машинистов — и она теперь же в прямых затратах: машины не теряют ОТм", () => {
    const { line } = compute(NORM_ONE_MACHINE, priceBook);

    // ФОТ 912,83 — ровно оплата машинистов; прямые затраты больше ФОТ на цену машины без оплаты.
    expect(line.directCost - line.wageFund).toBeCloseTo(800.01, 2);
    expect(line.overheadCost).toBeGreaterThan(0);
    expect(line.overheadCost).toBeCloseTo((line.wageFund * line.overheadPercent) / 100, 1);
  });

  it("объём 2,5 маш.-ч: оплата растёт вместе с объёмом, а не прибавляется один раз", () => {
    const item = makeBillItem({ id: "m", workName: "Работа автомобиля", quantity: 2500, quantityUnit: "м3", unitDivisor: 1000, normCode: "01-01-999-01" });
    const outcome = computeEstimateLine(item, { norm: NORM_ONE_MACHINE, reasons: [] }, priceBook, makeParameters());

    expect(outcome.line?.machineHours).toBe(2.5);
    expect(outcome.line?.machineCost).toBe(4282.1);
    expect(outcome.line?.machinistSalaryCost).toBe(2282.08);
  });

  it("повышенная оплата труда (таблица 6, п. 1.1, ×1,10) повышает только оплату машинистов внутри цены", () => {
    const parameters = makeParameters({ workConditions: { phase: "CAPITAL_REPAIR", conditionIds: ["T6-1.1"], newConstructionNorms: false } });
    const { line } = compute(NORM_ONE_MACHINE, priceBook, parameters);

    expect(line.coefficients).toMatchObject({ wage: 1.1 });
    // 912,83 × 1,10 = 1 004,11; цена без оплаты не меняется: 800,01 + 1 004,11.
    expect(line.machinistSalaryCost).toBe(1004.11);
    expect(line.machineCost).toBe(1804.12);
    expect(line.wageFund).toBe(1004.11);
    expect(line.resources[0]?.machinistPay).toBeCloseTo(1004.113, 3);
  });

  it("у машины без звена (оплата 0) цена остаётся ценой: прибавлять нечего, ОТм нет", () => {
    const { line, gaps } = compute(NORM_ONE_MACHINE, book({ current: new Map([[CODE, zonePrice(25.34, 0, { machinistHours: 0 })]]) }));

    expect(line.machineCost).toBe(25.34);
    expect(line.machinistSalaryCost).toBe(0);
    expect(line.resources[0]?.machinistPay).toBeUndefined();
    expect(gaps).toEqual([]);
  });

  it("позиция-поставка машины — покупка по цене справочника: оплата звена не прибавляется (как и раньше)", () => {
    const supply = makeBillItem({ id: "s", workName: "Автомобиль", quantity: 1, quantityUnit: "маш.-ч", unitDivisor: 1, normCode: null, normBaseType: null, resourceCode: CODE });
    const outcome = computeResourceLine(supply, book({ current: new Map([[CODE, zonePrice(800.01, 912.83)]]) }), makeParameters());

    expect(outcome.line?.directCost).toBe(800.01);
  });
});

describe("текущая цена машины без оплаты звена в выгрузке (null): берётся из базы 2022 индексом труда машинистов", () => {
  it("база 336,43 × 1,12 = 376,80 прибавляется к цене", () => {
    const priceBook = book({ current: new Map([[CODE, zonePrice(800.01, null)]]), base: new Map([[CODE, BASE_MACHINE]]) });
    const { line, gaps } = compute(NORM_ONE_MACHINE, priceBook, makeParameters({ indices: INDICES }));

    expect(line.machinistSalaryCost).toBe(376.8);
    expect(line.machineCost).toBe(1176.81);
    expect(gaps).toEqual([]);
  });

  it("нет индекса — пометка MACHINIST_PAY_UNKNOWN, оплаты в стоимости нет, число не придумано", () => {
    const priceBook = book({ current: new Map([[CODE, zonePrice(800.01, null)]]), base: new Map([[CODE, BASE_MACHINE]]) });
    const { line, gaps } = compute(NORM_ONE_MACHINE, priceBook);

    expect(line.machineCost).toBe(800.01);
    expect(line.machinistSalaryCost).toBe(0);
    expect(gaps.filter((gap) => gap.kind === "MACHINIST_PAY_UNKNOWN")).toHaveLength(1);
  });
});

describe("«все цены сплит-формы»: цена машины без оплаты машинистов, ОТм берётся из базы 2022 по индексу", () => {
  const split: ReadonlyMap<string, SplitAllPrice> = new Map([[CODE, { price: 800.01, unit: "маш.-ч", indexed: false }]]);

  it("машина вне нормы со строками машинистов: база 336,43 × индекс труда машинистов 1,12 = 376,80 к цене 800,01", () => {
    const priceBook = book({ base: new Map([[CODE, BASE_MACHINE]]), splitAll: split });
    const { line, gaps } = compute(NORM_ONE_MACHINE, priceBook, makeParameters({ indices: INDICES }));

    expect(line.machineCost).toBe(1176.81);
    expect(line.machinistSalaryCost).toBe(376.8);
    expect(line.wageFund).toBe(376.8);
    expect(line.resources[0]).toMatchObject({ source: "CURRENT_ZONE", unitPrice: 1176.81, machinistPay: 376.8 });
    expect(gaps).toEqual([]);
  });

  it("то же по индексированной цене сплит-формы: источник SPLIT_INDEXED, оплата добавлена, пометка INDEXED_PRICE сохранена", () => {
    const indexed: ReadonlyMap<string, SplitAllPrice> = new Map([[CODE, { price: 800.01, unit: "маш.-ч", indexed: true }]]);
    const priceBook = book({ base: new Map([[CODE, BASE_MACHINE]]), splitAll: indexed });
    const { line, gaps } = compute(NORM_ONE_MACHINE, priceBook, makeParameters({ indices: INDICES }));

    expect(line.resources[0]).toMatchObject({ source: "SPLIT_INDEXED", unitPrice: 1176.81 });
    expect(line.machinistSalaryCost).toBe(376.8);
    expect(gaps.map((gap) => gap.kind)).toEqual(["INDEXED_PRICE"]);
  });

  it("индексов нет — пометка MACHINIST_PAY_UNKNOWN: ОТм в стоимость не включена, цена остаётся без оплаты", () => {
    const priceBook = book({ base: new Map([[CODE, BASE_MACHINE]]), splitAll: split });
    const { line, gaps } = compute(NORM_ONE_MACHINE, priceBook);

    expect(line.machineCost).toBe(800.01);
    expect(line.machinistSalaryCost).toBe(0);
    const gap = gaps.find((candidate) => candidate.kind === "MACHINIST_PAY_UNKNOWN");
    expect(gap?.message).toContain(CODE);
    expect(gap?.message).toContain("не включена");
    expect(gap?.code).toBe("01-01-999-01");
    expect(gap?.baseType).toBe("ГЭСН");
  });

  it("машины нет в базе — оплату взять неоткуда: пометка, а не нулевая оплата молча", () => {
    const priceBook = book({ splitAll: split });
    const { line, gaps } = compute(NORM_ONE_MACHINE, priceBook, makeParameters({ indices: INDICES }));

    expect(line.machineCost).toBe(800.01);
    expect(gaps.filter((gap) => gap.kind === "MACHINIST_PAY_UNKNOWN")).toHaveLength(1);
  });

  it("в базе звено нулевое (машина без машинистов): оплаты нет и пометка не нужна", () => {
    const noCrew = { ...BASE_MACHINE, machinistSalary: 0 };
    const priceBook = book({ base: new Map([[CODE, noCrew]]), splitAll: split });
    const { line, gaps } = compute(NORM_ONE_MACHINE, priceBook, makeParameters({ indices: INDICES }));

    expect(line.machineCost).toBe(800.01);
    expect(gaps).toEqual([]);
  });

  it("машина в норме со строками машинистов цену из «всех цен» не берёт: цена по базе 2022 уже с оплатой звена", () => {
    const priceBook = book({ base: new Map([[CODE, BASE_MACHINE]]), splitAll: split });
    const { line } = compute(NORM_WITH_OPERATORS, priceBook, makeParameters({ indices: INDICES }));

    // (814,35 − 336,43) × 1,15 + 336,43 × 1,12 = 549,61 + 376,80
    expect(line.resources.find((resource) => resource.code === CODE)).toMatchObject({ source: "BASE_2022_INDEXED", unitPrice: 926.41 });
    expect(line.machinistSalaryCost).toBe(376.8);
  });
});

describe("форма 421/пр: ЭМ без оплаты машинистов, ОТм отдельной строкой, итог = ОТ + ЭМ + ОТм + М", () => {
  const priceBook = book({ current: new Map([[CODE, zonePrice(800.01, 912.83)]]), base: new Map([[CODE, BASE_MACHINE]]) });
  const document = buildEstimate({
    title: "Тест",
    sections: [makeBillSection("Раздел", [ITEM])],
    priceBook,
    parameters: makeParameters(),
    resolveNorm: makeResolver([NORM_ONE_MACHINE]),
    sources: [],
    generatedAt: "2026-10-10T00:00:00.000Z",
    disclaimer: "тест",
  });
  const rows = buildLocalEstimateFormRows({ document, number: "1", constructionName: "c", objectName: "o", basis: "b" });
  const num = (text: string | undefined): number => Number((text ?? "").replace(/\s/g, "").replace(",", "."));

  it("строка ЭМ печатает цену 800,01 без оплаты, строка ОТм — 912,83; их сумма — стоимость машин в расчёте", () => {
    const machine = rows.find((row) => row[1] === CODE);
    const operator = rows.find((row) => row[1] === "4-100");

    expect(num(machine?.[9])).toBe(800.01);
    expect(num(machine?.[11])).toBe(800.01);
    expect(operator?.[2]).toContain("Оплата труда машинистов");
    expect(num(operator?.[11])).toBe(912.83);
    expect(num(machine?.[11]) + num(operator?.[11])).toBeCloseTo(document.sections[0]?.lines[0]?.machineCost ?? 0, 2);
  });

  it("базисная цена и индекс строки ЭМ — тоже без оплаты: 814,35 − 336,43 = 477,92 (базис сплит-формы), индекс 800,01 / 477,92", () => {
    const machine = rows.find((row) => row[1] === CODE);

    expect(num(machine?.[7])).toBe(477.92);
    expect(num(machine?.[8])).toBeCloseTo(800.01 / 477.92, 2);
  });

  it("«Итого прямые затраты» позиции = ЭМ + ОТм: 800,01 + 912,83 = 1 712,84", () => {
    // Форма как у ГРАНД: сумма прямых затрат стоит в своей строке «Итого прямые затраты», а не в строке расценки.
    const direct = rows.find((row) => row[2] === "Итого прямые затраты");

    expect(num(direct?.[11])).toBe(1712.84);
  });
});
