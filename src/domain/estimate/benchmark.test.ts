import { describe, expect, it } from "vitest";

import {
  aggregateTenders,
  bucketOfDelta,
  compareTender,
  machinesView,
  summarizeCoefficients,
  topByDelta,
  truncateName,
  type BenchmarkCustomer,
  type BenchmarkOurs,
  type BenchmarkRow,
} from "@/domain/estimate/benchmark";
import { lsrDocument, type PositionSpec } from "@/domain/estimate/customerLsr.builders";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import type { EstimateDocument, EstimateLine } from "@/domain/estimate/types";
import { DOCUMENTS_1118 } from "@/test/t1118Fixtures";

/*
  Бенчмарк сравнивает наш расчёт с ЛСР заказчика. Тесты не трогают базу норм: смета заказчика строится из текста
  конструктором (`customerLsr.builders.ts`), а наши строки — руками, с известными числами.
*/

/**
 * Работа с известными числами. Заказчик: ОТ 10 000, машины 2 000 + ОТм 800 (ЭМ в смете 2 800), материалы 500,
 * прямые 13 300, ФОТ 10 800, НР 100 % = 10 800, СП 60 % = 6 480, всего 30 580.
 */
function work(n: number, overrides: Partial<PositionSpec> = {}): PositionSpec {
  return {
    n,
    justification: "ГЭСН01-01-001-01",
    name: `Тестовая работа ${String(n)}`,
    unit: "м2",
    qty: 10,
    resources: [
      { code: "1-100-23", unit: "чел.-ч", perUnit: 2, qty: 20, price: 500 },
      { code: "4-100-040", unit: "чел.-ч", perUnit: 0.2, qty: 2, price: 400 },
      { code: "91.05.05-015", unit: "маш.-ч", perUnit: 0.2, qty: 2, price: 1000 },
      { code: "01.7.15.03-0042", unit: "кг", perUnit: 0.5, qty: 5, price: 100 },
    ],
    overhead: { ref: "Пр/812-001.1", base: 100 },
    profit: { ref: "Пр/774-001.1", base: 60 },
    ...overrides,
  };
}

function lsrSetOf(positions: readonly PositionSpec[], name = "02-02-01 Тестовые работы") {
  const text = lsrDocument({ positions, name });
  return buildLsrSet(parseCustomerLsr([{ name: "ЛСР.xlsx", text }]).estimates);
}

/** Наша строка, совпадающая с работой `work` до копейки; поля можно перебить. */
function line(itemId: string, overrides: Partial<EstimateLine> = {}): EstimateLine {
  return {
    itemId,
    normCode: "01-01-001-01",
    normBaseType: "ГЭСН",
    normName: "Тестовая норма",
    normUnit: "м2",
    quantity: 10,
    billQuantity: 10,
    billUnit: "м2",
    sourceQuote: null,
    sourceDocument: null,
    labourHours: 20,
    specialistHours: 0,
    labourRate: 500,
    labourCost: 10_000,
    machinistHours: 2,
    machinistSalaryCost: 800,
    machineHours: 2,
    machineCost: 2_800,
    materialCost: 500,
    directCost: 13_300,
    wageFund: 10_800,
    overheadCost: 10_800,
    profitCost: 6_480,
    overheadPercent: 100,
    profitPercent: 60,
    overheadRef: "Пр/812-001.1",
    profitRef: "Пр/774-001.1",
    overheadSource: "NORM_REF",
    profitSource: "NORM_REF",
    resources: [],
    gaps: [],
    ...overrides,
  };
}

/** Документ с одним разделом: нужны только строки и итоги. */
function documentOf(lines: readonly EstimateLine[]): EstimateDocument {
  const direct = lines.reduce((sum, item) => sum + item.directCost, 0);
  const overhead = lines.reduce((sum, item) => sum + item.overheadCost, 0);
  const profit = lines.reduce((sum, item) => sum + item.profitCost, 0);
  const work = direct + overhead + profit;
  return {
    sections: [{ title: "Раздел", lines, directCost: direct, overheadCost: overhead, profitCost: profit, workCost: work }],
    totals: { directCost: direct, wageFund: 0, overheadCost: overhead, profitCost: profit, workCost: work, winterSurcharge: 0, temporaryStructures: 0, beforeVat: work, vat: work * 0.22, total: work * 1.22 },
    gaps: [],
  } as unknown as EstimateDocument;
}

describe("compareTender: совпадающая смета", () => {
  const set = lsrSetOf([work(1), work(2)]);
  const result = compareTender({ lsrSet: set, document: documentOf([line("l1-1"), line("l1-2")]) });

  it("обе позиции найдены, разница нулевая, все в первой корзине", () => {
    expect(result.rows).toHaveLength(2);
    expect(result.aggregate.counts).toMatchObject({ customer: 2, matched: 2, onlyCustomer: 0, onlyOurs: 0, skipped: 0, priced: 0 });
    expect(result.aggregate.buckets.LT_1.count).toBe(2);
    expect(result.rows.every((row) => row.delta?.total === 0 && row.delta.other === 0 && row.delta.componentsComparable)).toBe(true);
    expect(result.aggregate.attribution).toEqual({ total: 0, labour: 0, machines: 0, machinist: 0, materials: 0, overhead: 0, profit: 0, other: 0, unmatched: 0 });
  });

  it("позиция несёт цифры обеих сторон и наименование, шифр, единицу и объём", () => {
    const row = result.rows[0] as BenchmarkRow;
    expect(row).toMatchObject({ lsrIndex: 1, label: "1", code: "ГЭСН01-01-001-01", unit: "м2", quantity: 10, subPosition: false });
    expect(row.customer).toMatchObject({ labour: 10_000, machines: 2_800, machinistLabour: 800, materials: 500, direct: 13_300, overheadAmount: 10_800, overheadPercent: 100, profitAmount: 6_480, profitPercent: 60, total: 30_580 });
    expect(row.ours).toMatchObject({ labour: 10_000, machinesInclMachinist: 2_800, machinesExclMachinist: 2_000, machinistPay: 800, materials: 500, direct: 13_300, total: 30_580, residual: null });
    expect(row.ours?.flags).toMatchObject({ priceSource: null, customerPrice: false, residualHidden: false, deduction: false, gapKinds: [], coefficients: null });
  });

  it("итоги сметы: наш итог против «ВСЕГО по смете» без НДС и против суммы позиций", () => {
    const lsr = result.lsrs[0];
    expect(lsr?.oursTotal).toBe(61_160);
    expect(lsr?.customerPositionsTotal).toBe(61_160);
    expect(lsr?.deltaVsPositions).toBe(0);
    expect(result.aggregate.rowsDeltaPercent).toBe(0);
    expect(result.aggregate.document.beforeVat).toBe(61_160);
  });

  it("ЭМ заказчика сошёлся с нашим ЭМ с ОТм, а арифметика сметы подтверждает, что ОТм в ЭМ входит", () => {
    expect(result.rows[0]?.machines).toMatchObject({
      declared: "INCLUDES_OTM",
      matched: "INCLUDES_OTM",
      used: "INCLUDES_OTM",
      usedBy: "ARITHMETIC",
      customerMachinesExclMachinist: 2_000,
      customerMachinist: 800,
    });
    expect(result.aggregate.machinist.matched.INCLUDES_OTM).toBe(2);
  });
});

describe("compareTender: разложение разницы в рублях", () => {
  it("труд дороже на 10 %: разница уходит в оплату труда и НР со СП, а «остальное» — ноль", () => {
    const set = lsrSetOf([work(1)]);
    // ОТ 11 000 (+1 000); ФОТ = 11 000 + 800 = 11 800: НР 11 800 (+1 000), СП 7 080 (+600).
    const ours = line("l1-1", { labourCost: 11_000, directCost: 14_300, wageFund: 11_800, overheadCost: 11_800, profitCost: 7_080 });
    const { rows, aggregate } = compareTender({ lsrSet: set, document: documentOf([ours]) });
    expect(rows[0]?.delta).toMatchObject({ total: 2_600, labour: 1_000, machines: 0, machinist: 0, materials: 0, overhead: 1_000, profit: 600, other: 0, direct: 1_000, componentsComparable: true });
    expect(rows[0]?.delta?.totalPercent).toBeCloseTo(8.5, 1);
    expect(rows[0]?.bucket).toBe("FROM_5_TO_20");
    expect(aggregate.attribution).toMatchObject({ total: 2_600, labour: 1_000, overhead: 1_000, profit: 600, other: 0, unmatched: 0 });
  });

  it("материалы и машины раскладываются порознь: машины сравниваются без ОТм", () => {
    const set = lsrSetOf([work(1)]);
    // Машины 2 000 → 2 500 при тех же 800 ОТм (machineCost 3 300), материалы 500 → 400.
    const ours = line("l1-1", { machineCost: 3_300, materialCost: 400, directCost: 13_700 });
    const { rows } = compareTender({ lsrSet: set, document: documentOf([ours]) });
    expect(rows[0]?.delta).toMatchObject({ labour: 0, machines: 500, machinist: 0, materials: -100, overhead: 0, profit: 0, other: 0, total: 400 });
    // Обе трактовки видны: А — ЭМ заказчика 2 800 против нашего 3 300, Б — тот же 2 800 против 2 500.
    expect(rows[0]?.machines?.includesOtm).toEqual({ customer: 2_800, ours: 3_300, delta: 500 });
    expect(rows[0]?.machines?.excludesOtm).toEqual({ customer: 2_800, ours: 2_500, delta: -300 });
    expect(rows[0]?.machines?.matched).toBe("NONE");
  });

  it("сумма составляющих и остатка равна общей разнице, а невидимый остаток позиции идёт в «остальное»", () => {
    // Заказчик добавил к позиции 5 000 ₽ сверх видимых составляющих: расчёт кладёт их отдельной строкой «-rest».
    const set = lsrSetOf([work(1, { override: { total: 35_580 } })]);
    const bill = lsrBillSection(set.entries[0]!, 1);
    expect(bill.section.items.map((item) => item.id)).toEqual(["l1-1", "l1-1-rest"]);
    const rest = line("l1-1-rest", { priceSource: "CUSTOMER_PRICE", directCost: 4_000, materialCost: 4_000, labourCost: 0, machineCost: 0, machinistSalaryCost: 0, overheadCost: 0, profitCost: 0, overheadPercent: 0, profitPercent: 0 });
    const { rows, aggregate } = compareTender({ lsrSet: set, document: documentOf([line("l1-1"), rest]) });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ours).toMatchObject({ residual: 4_000, total: 34_580 });
    expect(rows[0]?.ours?.flags.residualHidden).toBe(true);
    expect(rows[0]?.delta).toMatchObject({ total: -1_000, other: -1_000, labour: 0, materials: 0 });
    const { attribution } = aggregate;
    const parts = attribution.labour + attribution.machines + attribution.machinist + attribution.materials + attribution.overhead + attribution.profit + attribution.other + attribution.unmatched;
    expect(parts).toBeCloseTo(attribution.total, 2);
  });
});

describe("compareTender: заказчик печатает ЭМ без ОТм и прибавляет ОТм сверх", () => {
  /*
    Как на закупке 0302300048726001118: прямые затраты заказчика = ОТ + ЭМ + ОТм + М, а его ЭМ равен нашему machineCost
    целиком. Конструктор печатает ЭМ с ОТм, поэтому графа правится: ЭМ 2 800 → 2 000, прямые остаются 13 300.
    Это картина СТАРОГО расчёта: он брал цену ФГИС ЦС за полную и не прибавлял к ней оплату звена (см. следующий блок
    про расчёт после исправления); тест держит разбор таких документов — сметы в хранилище бывают посчитаны до него.
  */
  const text = lsrDocument({ positions: [work(1)], name: "02-02-01 Тест" }).replace(/(ЭМ[^\n]*?)2,800\.00/, "$12,000.00");
  const set = buildLsrSet(parseCustomerLsr([{ name: "ЛСР.xlsx", text }]).estimates);
  // Наш machineCost равен ЭМ заказчика (2 000), оплата машинистов (800) в нём не содержится; прямые затраты у нас без ОТм.
  const ours = line("l1-1", { machineCost: 2_000, directCost: 12_500 });
  const { rows, aggregate } = compareTender({ lsrSet: set, document: documentOf([ours]) });

  it("арифметика заказчика: ЭМ без ОТм; цифры сошлись с нашим machineCost целиком", () => {
    expect(rows[0]?.customer).toMatchObject({ machines: 2_000, machinistLabour: 800, direct: 13_300 });
    expect(rows[0]?.machines).toMatchObject({ declared: "EXCLUDES_OTM", matched: "INCLUDES_OTM", used: "EXCLUDES_OTM", usedBy: "ARITHMETIC", oursIncludesPay: false });
  });

  it("нехватка прямых затрат записана в ОТм, а не в ЭМ: машины сходятся", () => {
    expect(rows[0]?.machines).toMatchObject({ oursMachinesExclMachinist: 2_000, oursMachinist: 0, customerMachinesExclMachinist: 2_000, customerMachinist: 800 });
    expect(rows[0]?.delta).toMatchObject({ direct: -800, machines: 0, machinist: -800, labour: 0, materials: 0, overhead: 0, profit: 0, other: 0, total: -800 });
    expect(aggregate.machinist.oursWithoutPay).toEqual({ positions: 1, customerMachinist: 800 });
    expect(aggregate.machinist.crossTab.EXCLUDES_OTM.INCLUDES_OTM).toBe(1);
  });
});

describe("compareTender: ЭМ заказчика без ОТм сходится с нашим расчётом, где machineCost включает ОТм", () => {
  /*
    После исправления цены ФГИС ЦС: наша стоимость маш.-ч — цена без оплаты (2 000) плюс оплата звена (800), то есть
    machineCost 2 800 и machinistSalaryCost 800; прямые затраты 13 300 = ОТ 10 000 + ЭМ 2 000 + ОТм 800 + М 500 — как у заказчика
    по форме 421/пр. Его ЭМ (2 000) равен нашему `machineCost − machinistSalaryCost`, ОТм равна нашей, разницы нет.
  */
  const text = lsrDocument({ positions: [work(1)], name: "02-02-01 Тест" }).replace(/(ЭМ[^\n]*?)2,800\.00/, "$12,000.00");
  const set = buildLsrSet(parseCustomerLsr([{ name: "ЛСР.xlsx", text }]).estimates);
  const ours = line("l1-1", { machineCost: 2_800, machinistSalaryCost: 800, directCost: 13_300 });
  const { rows, aggregate } = compareTender({ lsrSet: set, document: documentOf([ours]) });

  it("ЭМ сошёлся с «machineCost − ОТм», оплата звена у нас есть, разницы ни по ЭМ, ни по ОТм нет", () => {
    expect(rows[0]?.machines).toMatchObject({ declared: "EXCLUDES_OTM", matched: "EXCLUDES_OTM", used: "EXCLUDES_OTM", usedBy: "ARITHMETIC", oursIncludesPay: true });
    expect(rows[0]?.machines).toMatchObject({ oursMachinesExclMachinist: 2_000, oursMachinist: 800, customerMachinesExclMachinist: 2_000, customerMachinist: 800 });
    expect(rows[0]?.delta).toMatchObject({ direct: 0, machines: 0, machinist: 0, labour: 0, materials: 0, total: 0 });
    expect(aggregate.machinist.oursWithoutPay).toEqual({ positions: 0, customerMachinist: 0 });
  });
});

describe("compareTender: НР и СП", () => {
  it("расходящийся процент попадает в список с парой «шифр — процент заказчика — наш процент»", () => {
    const set = lsrSetOf([work(1), work(2)]);
    // НР у нас 90 % вместо 100 %: сумма 9 720 вместо 10 800.
    const ours = line("l1-1", { overheadPercent: 90, overheadCost: 9_720 });
    const { rows, aggregate } = compareTender({ lsrSet: set, document: documentOf([ours, line("l1-2")]) });
    expect(rows[0]?.overheadRate).toMatchObject({ customerPercent: 100, ourPercent: 90, mismatch: true, amountDelta: -1_080 });
    expect(rows[0]?.profitRate?.mismatch).toBe(false);
    expect(rows[1]?.overheadRate?.mismatch).toBe(false);
    expect(aggregate.rateMismatches).toMatchObject({ overheadPositions: 1, profitPositions: 0, eitherPositions: 1 });
    expect(aggregate.rateMismatches.groups).toEqual([{ code: "ГЭСН01-01-001-01", kind: "overhead", customerPercent: 100, ourPercent: 90, positions: 1, amountDelta: -1_080 }]);
    expect(rows[0]?.delta).toMatchObject({ overhead: -1_080, other: 0 });
  });

  it("множитель заказчика к нормативу виден: применённый процент сравнивается с применённым, база — с базой", () => {
    const set = lsrSetOf([work(1, { overhead: { ref: "Пр/812-001.1", base: 100, percent: 90 } })]);
    const ours = line("l1-1", {
      overheadPercent: 90,
      overheadCost: 9_720,
      rateMultipliers: { overhead: 0.9, profit: 1, baseOverheadPercent: 100, baseProfitPercent: 60, applied: ["NR-P25"], skipped: [], manual: false, label: "" },
    });
    const { rows } = compareTender({ lsrSet: set, document: documentOf([ours]) });
    expect(rows[0]?.overheadRate).toMatchObject({ customerPercent: 90, customerBasePercent: 100, ourPercent: 90, ourBasePercent: 100, mismatch: false });
    expect(rows[0]?.ours?.flags.coefficients).toBe("НР ×0,9, СП ×1 (NR-P25)");
  });
});

describe("compareTender: позиции только с одной стороны и строки по цене", () => {
  it("позиция без нашей строки — «только у заказчика»; строка без позиции — «только у нас»; обе уходят в «unmatched»", () => {
    const set = lsrSetOf([work(1), work(2)]);
    const extra = line("l1-99", { directCost: 1_000, overheadCost: 0, profitCost: 0 });
    const { rows, aggregate, lsrs } = compareTender({ lsrSet: set, document: documentOf([line("l1-1"), extra]) });
    expect(rows.map((row) => row.bucket)).toEqual(["LT_1", "ONLY_CUSTOMER", "ONLY_OURS"]);
    expect(rows[1]?.ours).toBeNull();
    expect(rows[1]?.delta).toMatchObject({ total: -30_580, totalPercent: -100 });
    expect(rows[2]?.customer).toBeNull();
    expect(rows[2]?.label).toBe("l1-99");
    expect(aggregate.counts).toMatchObject({ customer: 2, matched: 1, onlyCustomer: 1, onlyOurs: 1 });
    expect(aggregate.attribution.unmatched).toBe(-29_580);
    expect(aggregate.buckets.ONLY_CUSTOMER).toEqual({ count: 1, absDelta: 30_580 });
    expect(lsrs[0]).toMatchObject({ positions: 2, matched: 1, onlyCustomer: 1, onlyOurs: 1 });
  });

  it("строка по цене заказчика: разбивки нет (поля null), позиция не раскладывается, вся разница — «остальное»", () => {
    const set = lsrSetOf([work(1)]);
    const priced = line("l1-1", { priceSource: "CUSTOMER_PRICE", labourCost: 0, machineCost: 0, machinistSalaryCost: 0, materialCost: 0, directCost: 30_000, overheadCost: 0, profitCost: 0, overheadPercent: 0, profitPercent: 0, gaps: [{ kind: "CUSTOMER_PRICE", message: "", code: null, baseType: null }] });
    const { rows, aggregate } = compareTender({ lsrSet: set, document: documentOf([priced]) });
    const row = rows[0] as BenchmarkRow;
    expect(row.ours).toMatchObject({ labour: null, machinesInclMachinist: null, machinistPay: null, materials: null, direct: 30_000 });
    expect(row.ours?.flags).toMatchObject({ priceSource: "CUSTOMER_PRICE", customerPrice: true, gapKinds: ["CUSTOMER_PRICE"] });
    expect(row.machines).toBeNull();
    expect(row.overheadRate).toBeNull();
    expect(row.delta).toMatchObject({ total: -580, labour: null, other: -580, componentsComparable: false });
    expect(aggregate.counts.priced).toBe(1);
    expect(aggregate.attribution).toMatchObject({ labour: 0, other: -580, total: -580 });
  });

  it("исключение (отрицательный объём): суммы со знаком минус с обеих сторон, разница нулевая", () => {
    const set = lsrSetOf([work(1, { qty: -10, resources: [{ code: "01.7.15.03-0042", unit: "кг", perUnit: 0.5, qty: -5, price: 100 }], overhead: undefined, profit: undefined })]);
    const negative = line("l1-1", { deduction: true, labourCost: 0, machineCost: 0, machinistSalaryCost: 0, materialCost: -500, directCost: -500, overheadCost: 0, profitCost: 0, overheadPercent: 0, profitPercent: 0, overheadRef: null, profitRef: null });
    const { rows } = compareTender({ lsrSet: set, document: documentOf([negative]) });
    expect(rows[0]?.customer?.total).toBe(-500);
    expect(rows[0]?.ours?.flags.deduction).toBe(true);
    expect(rows[0]?.delta?.total).toBe(0);
    expect(rows[0]?.bucket).toBe("LT_1");
  });
});

describe("compareTender: реальная смета закупки 0302300048726001118", () => {
  /*
    Нашу строку берём равной цене заказчика (`priceSource` задан, расчёт по норме не нужен): это проверяет
    не арифметику, а то, что все позиции, подпозиции, повторы меток и строки остатка нашли друг друга.
  */
  const set = buildLsrSet(parseCustomerLsr(DOCUMENTS_1118).estimates);
  const lines: EstimateLine[] = [];
  for (const [index, entry] of set.entries.entries()) {
    for (const item of lsrBillSection(entry, index + 1).section.items) {
      const price = item.customerPrice?.total ?? 0;
      lines.push(
        line(item.id, {
          priceSource: "CUSTOMER_PRICE",
          directCost: item.deduction === true ? -price : price,
          labourCost: 0,
          machineCost: 0,
          machinistSalaryCost: 0,
          materialCost: 0,
          overheadCost: 0,
          profitCost: 0,
          overheadPercent: 0,
          profitPercent: 0,
        }),
      );
    }
  }
  const result = compareTender({ lsrSet: set, document: documentOf(lines) });

  it("каждая позиция каждой сметы найдена, лишних и потерянных строк нет", () => {
    expect(result.lsrs).toHaveLength(3);
    expect(result.aggregate.counts.onlyCustomer).toBe(0);
    expect(result.aggregate.counts.onlyOurs).toBe(0);
    expect(result.aggregate.counts.matched).toBe(result.aggregate.counts.customer);
  });

  it("итог по сметам совпадает с итогом заказчика без НДС: строки остатка слиты с позициями", () => {
    for (const lsr of result.lsrs) {
      expect(lsr.customerTotalExVat).not.toBeNull();
      expect(Math.abs(lsr.deltaVsTotal ?? Number.NaN)).toBeLessThan(0.05);
    }
    expect(Math.abs(result.aggregate.deltaPercent ?? Number.NaN)).toBeLessThan(0.01);
    expect(result.rows.some((row) => row.ours?.flags.residualHidden === true)).toBe(true);
  });
});

describe("machinesView: две трактовки ЭМ заказчика", () => {
  const customer = (overrides: Partial<BenchmarkCustomer>): BenchmarkCustomer => ({
    labour: 1_000,
    machines: 500,
    machinistLabour: 100,
    materials: 200,
    direct: 1_700,
    overheadAmount: null,
    overheadPercent: null,
    overheadBasePercent: null,
    overheadRef: null,
    profitAmount: null,
    profitPercent: null,
    profitBasePercent: null,
    profitRef: null,
    total: 1_700,
    ...overrides,
  });
  const ours = (including: number, pay: number): BenchmarkOurs =>
    ({ machinesInclMachinist: including, machinesExclMachinist: including - pay, machinistPay: pay }) as BenchmarkOurs;

  it("ЭМ включает ОТм: прямые = ОТ + ЭМ + М, сошлось с нашим ЭМ с ОТм", () => {
    const view = machinesView(customer({}), ours(500, 100));
    expect(view).toMatchObject({ declared: "INCLUDES_OTM", matched: "INCLUDES_OTM", used: "INCLUDES_OTM", usedBy: "ARITHMETIC", customerMachinesExclMachinist: 400, customerMachinist: 100 });
  });

  it("ЭМ не включает ОТм: прямые = ОТ + ЭМ + ОТм + М, сошлось с нашим ЭМ без ОТм", () => {
    const view = machinesView(customer({ direct: 1_800 }), ours(600, 100));
    expect(view).toMatchObject({ declared: "EXCLUDES_OTM", matched: "EXCLUDES_OTM", used: "EXCLUDES_OTM", usedBy: "ARITHMETIC", customerMachinesExclMachinist: 500, customerMachinist: 100 });
  });

  it("арифметика не сошлась (прямые затраты неизвестны): берётся совпадение с нашими цифрами, иначе трактовка Гранд-Сметы", () => {
    // Прямые затраты — нет: view не строится вовсе (нет таблицы ресурсов).
    expect(machinesView(customer({ direct: null }), ours(500, 100))).toBeNull();
    // Прямые затраты не сходятся ни с одной трактовкой: решает совпадение.
    expect(machinesView(customer({ direct: 9_999 }), ours(600, 100))).toMatchObject({ declared: "UNDETERMINED", matched: "EXCLUDES_OTM", used: "EXCLUDES_OTM", usedBy: "MATCH" });
    // Не сошлось ни то ни другое: по умолчанию ЭМ с ОТм.
    expect(machinesView(customer({ direct: 9_999 }), ours(900, 100))).toMatchObject({ declared: "UNDETERMINED", matched: "NONE", used: "INCLUDES_OTM", usedBy: "DEFAULT" });
  });

  it("машинистов нет ни у кого: различать нечего", () => {
    const view = machinesView(customer({ machinistLabour: null, direct: 1_700 }), ours(500, 0));
    expect(view).toMatchObject({ declared: "NOT_APPLICABLE", matched: "NOT_APPLICABLE", customerMachinist: 0, customerMachinesExclMachinist: 500 });
  });

  it("у нашей строки по цене разбивки нет — трактовок нет", () => {
    expect(machinesView(customer({}), { machinesInclMachinist: null, machinesExclMachinist: null, machinistPay: null } as BenchmarkOurs)).toBeNull();
  });
});

describe("мелкие функции", () => {
  it("корзины по |Δ%|: границы 1, 5 и 20 входят в верхнюю корзину; база ноль — худшая корзина при ненулевой разнице", () => {
    expect(bucketOfDelta(0.99, 100)).toBe("LT_1");
    expect(bucketOfDelta(-1, 100)).toBe("FROM_1_TO_5");
    expect(bucketOfDelta(4.99, 100)).toBe("FROM_1_TO_5");
    expect(bucketOfDelta(5, 100)).toBe("FROM_5_TO_20");
    expect(bucketOfDelta(-19.9, 100)).toBe("FROM_5_TO_20");
    expect(bucketOfDelta(20, 100)).toBe("GE_20");
    expect(bucketOfDelta(5, 0)).toBe("GE_20");
    expect(bucketOfDelta(0, 0)).toBe("LT_1");
    // У исключения база отрицательная: процент считается от модуля.
    expect(bucketOfDelta(-1, -500)).toBe("LT_1");
    expect(bucketOfDelta(100, -500)).toBe("GE_20");
  });

  it("наименование схлопывает пробелы и обрезается до 120 знаков с многоточием", () => {
    expect(truncateName("  Смена \n  кранов ")).toBe("Смена кранов");
    const long = truncateName("а".repeat(300));
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(truncateName("а".repeat(120))).toHaveLength(120);
  });

  it("коэффициенты строки: только отличные от единицы; нет коэффициентов — null", () => {
    expect(summarizeCoefficients(line("x"))).toBeNull();
    const text = summarizeCoefficients(
      line("x", { coefficients: { labour: 1.2, machines: 1.2, wage: 1, conditionIds: ["T3-1.1"], adjustmentIds: [], materials: 0, customer: { applied: ["P58"], duplicates: [], skipped: [], manual: false, label: "" } } }),
    );
    expect(text).toBe("труд ×1,2; машины ×1,2; материалы ×0; условия T3-1.1; как у заказчика: P58");
  });

  it("топ позиций — по |Δ| в рублях, без позиций без разницы в рублях", () => {
    const row = (total: number | null): BenchmarkRow => ({ delta: total === null ? null : { total } }) as BenchmarkRow;
    const top = topByDelta([row(10), row(-300), row(null), row(200)], 2);
    expect(top.map((item) => item.delta?.total)).toEqual([-300, 200]);
  });
});

describe("aggregateTenders: сводка по многим закупкам", () => {
  const exact = compareTender({ lsrSet: lsrSetOf([work(1)]), document: documentOf([line("l1-1")]) });
  const worse = compareTender({
    lsrSet: lsrSetOf([work(1), work(2)]),
    document: documentOf([line("l1-1", { overheadPercent: 90, overheadCost: 9_720 }), line("l1-2", { materialCost: 1_500, directCost: 14_300 })]),
  });
  const cross = aggregateTenders(
    [
      { tenderId: "A", comparison: exact },
      { tenderId: "B", comparison: worse },
    ],
    { topN: 2 },
  );

  it("считает закупки, сметы и позиции; итоги складываются", () => {
    expect(cross.tenders).toBe(2);
    expect(cross.lsrs).toBe(2);
    expect(cross.counts).toMatchObject({ customer: 3, matched: 3 });
    expect(cross.customerPositionsTotal).toBe(91_740);
    expect(cross.oursRowsTotal).toBe(91_740 - 1_080 + 1_000);
    expect(cross.documentBeforeVat).toBe(cross.oursRowsTotal);
  });

  it("корзины, рубли по составляющим и расходящиеся проценты сводятся по всем закупкам", () => {
    expect(cross.buckets.LT_1.count).toBe(1);
    expect(cross.buckets.FROM_1_TO_5.count).toBe(2);
    expect(cross.attribution).toMatchObject({ materials: 1_000, overhead: -1_080, total: -80, other: 0 });
    expect(cross.rateMismatches).toMatchObject({ overheadPositions: 1, eitherPositions: 1 });
  });

  it("топ — с номером закупки, по убыванию |Δ|", () => {
    expect(cross.top).toHaveLength(2);
    expect(cross.top.map((row) => [row.tenderId, row.label])).toEqual([
      ["B", "1"],
      ["B", "2"],
    ]);
  });

  it("закупки без итога заказчика не искажают общий процент", () => {
    const none = aggregateTenders([]);
    expect(none).toMatchObject({ tenders: 0, customerTotalExVat: null, deltaPercent: null });
  });
});
