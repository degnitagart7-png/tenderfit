import { describe, expect, it } from "vitest";

import { computeEstimateSection } from "@/domain/estimate/calculate";
import { parseCustomerLsr, type CustomerPosition } from "@/domain/estimate/customerLsr";
import { lsrDocument, type PositionSpec } from "@/domain/estimate/customerLsr.builders";
import { hiddenRemainderOf, lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { roundTo } from "@/domain/estimate/resourceKinds";
import type { BillOfWorkItem, NormRecord, ResourcePrice } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import type { EstimateBase } from "@/repositories/estimateBaseRepository";
import { calculateBill } from "@/services/estimateService";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  CURRENT_PRICES,
  makeBillItem,
  makeBillSection,
  makeOverheadRates,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  Невидимый остаток позиции ЛСР и материалы нашей нормы (закупки 0891200000626010037 и 0134600008526000372).

  Случай 1 — ГЭСН22-01-011-02, укладка стальных труб 89 мм, 0,675 км: ОТ 112 125,15, ЭМ 34 763,22, ОТм 23 674,40, М 7 400,12, прямые
  177 962,89, НР 117 %, СП 74 %, всего 917 019,33. Труба — строка «22.1» под позицией: в «Итого прямые затраты» и в группу «М» она не входит,
  а в «Всего по позиции» входит, поэтому «остаток» (всего − прямые − НР − СП) = 479 679,30 — и состав позиции по строкам заказчика (с трубой)
  оценивает ту же трубу нашей ценой. Раньше трубу считали дважды: материалы 487 079,42 = 7 400,12 + 479 679,30, и остаток сверху.

  Случай 2 — ГЭСНп07-10-015-02 и ГЭСН16, 18: строки НР и СП в тексте есть, но разбор их не взял; «нет строки — ноль» превращало всю «НР + СП»
  в фантомный остаток (+247 тыс. ₽ на одной позиции).
*/

const WAGE_SCALE = buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE);
const QUANTITY = 0.675;

/* ------------------------- Цифры случая 1 ------------------------- */

const OT = 112_125.15;
const EM_WITHOUT_PAY = 34_763.22;
const OT_M = 23_674.4;
const M_PRINTED = 7_400.12;
const PIPE = 479_679.3;
const TOTAL = 917_019.33;

const LABOUR_RATE = 653.14;
/** Бортовой автомобиль: цена ФГИС ЦС 813,59 — без оплаты машинистов, оплата звена 735,47 ₽/ч отдельной колонкой. */
const TRUCK = { code: "91.14.02-001", price: 813.59, pay: 735.47 };
const TRAMBOVKA = { code: "91.08.09-024", price: 25.34 };
const SMALL = { code: "01.7.15.03-0042", price: 100 };
const PIPE_ROW = { code: "23.3.06.02-0001", price: 1000 };

/** Часы и количества на весь объём подобраны так, чтобы суммы совпали с напечатанными заказчиком. */
const labourHours = OT / LABOUR_RATE;
const truckHours = OT_M / TRUCK.pay;
const trambovkaHours = (EM_WITHOUT_PAY - truckHours * (TRUCK.price)) / TRAMBOVKA.price;
const smallQty = M_PRINTED / SMALL.price;
const pipeQty = PIPE / PIPE_ROW.price;
const perUnit = (total: number): number => roundTo(total / QUANTITY, 6);

function price(code: string, unitPrice: number, unit: string): ResourcePrice {
  return { code, name: `Ресурс ${code}`, unit, price: unitPrice, machinistSalary: null, machinistHours: null, source: "CURRENT_ZONE", period: AMUR_ZONE.period, zone: AMUR_ZONE.zone };
}

const NORM: NormRecord = {
  code: "22-01-011-02",
  tableCode: "22-01-011",
  fullName: "Укладка стальных водопроводных труб с гидравлическим испытанием диаметром: 89 мм",
  endName: "89 мм",
  unit: "км",
  collectionCode: "22",
  collectionName: "Водопровод",
  sectionName: "",
  subsectionName: "",
  baseType: "ГЭСН",
  content: [],
  resources: [
    { code: "1-100-30", kind: "LABOUR", name: "Средний разряд работы 3,0", quantity: perUnit(labourHours), unit: "чел.-ч", quantityNote: null, projectSpecific: false, technologyGroup: null },
    { code: TRUCK.code, kind: "MACHINE", name: "Автомобили бортовые", quantity: perUnit(truckHours), unit: "маш.-ч", quantityNote: null, projectSpecific: false, technologyGroup: null },
    { code: TRAMBOVKA.code, kind: "MACHINE", name: "Трамбовки", quantity: perUnit(trambovkaHours), unit: "маш.-ч", quantityNote: null, projectSpecific: false, technologyGroup: null },
    { code: SMALL.code, kind: "MATERIAL", name: "Электроды, кислород", quantity: perUnit(smallQty), unit: "шт", quantityNote: null, projectSpecific: false, technologyGroup: null },
    { code: PIPE_ROW.code, kind: "MATERIAL", name: "Трубы стальные 89 мм", quantity: perUnit(pipeQty), unit: "т", quantityNote: null, projectSpecific: false, technologyGroup: null },
  ],
  overheadRef: "Пр/812-022.0-1",
  profitRef: "Пр/774-022.0",
};

const RATES = makeOverheadRates([
  { ref: "Пр/812-022.0-1", percent: 117, workType: "Трубопроводы", source: "812/пр" },
  { ref: "Пр/774-022.0", percent: 74, workType: "Трубопроводы", source: "774/пр" },
]);

function baseOf(norms: readonly NormRecord[] = [NORM]): EstimateBase {
  const current = new Map<string, ResourcePrice>([...CURRENT_PRICES, price(SMALL.code, SMALL.price, "шт"), price(PIPE_ROW.code, PIPE_ROW.price, "т")].map((entry) => [entry.code, entry]));
  return {
    info: {
      indexDir: "x",
      builtAt: "2026-10-10T00:00:00.000Z",
      baseEdition: "01.01.2022",
      region: AMUR_ZONE.region,
      priceZone: AMUR_ZONE.zone,
      period: AMUR_ZONE.period,
      decree: "тест",
      counts: { norms: norms.length, basePrices: 0, currentPrices: current.size, wages: 0, zones: 1 },
      splitForm: null,
      notes: [],
    },
    priceBook: makePriceBook(WAGE_SCALE, { current, overheadRates: RATES }),
    searchIndex: createNormSearchIndex(norms),
    zones: [],
    sources: [],
    loadMs: 0,
  };
}

/** Позиция случая 1 в виде, в котором её печатает Гранд-Смета: труба — дополнение «22.1» за итогом прямых затрат. */
const PIPE_SPEC: PositionSpec = {
  n: 1,
  justification: "ГЭСН22-01-011-02",
  name: "Укладка стальных водопроводных труб с гидравлическим испытанием диаметром: 89 мм",
  unit: "км",
  qty: QUANTITY,
  resources: [
    { code: "1-100-30", name: "Средний разряд работы 3,0", unit: "чел.-ч", perUnit: perUnit(labourHours), qty: labourHours, price: LABOUR_RATE },
    { code: TRUCK.code, name: "Автомобили бортовые", unit: "маш.-ч", perUnit: perUnit(truckHours), qty: truckHours, price: TRUCK.price },
    { code: TRAMBOVKA.code, name: "Трамбовки", unit: "маш.-ч", perUnit: perUnit(trambovkaHours), qty: trambovkaHours, price: TRAMBOVKA.price },
    { code: "4-100-040", name: "Затраты труда машинистов", unit: "чел.-ч", perUnit: perUnit(truckHours), qty: truckHours, price: TRUCK.pay },
    { code: SMALL.code, name: "Электроды, кислород", unit: "шт", perUnit: perUnit(smallQty), qty: smallQty, price: SMALL.price },
    { code: PIPE_ROW.code, name: "Трубы стальные 89 мм", unit: "т", perUnit: perUnit(pipeQty), qty: pipeQty, price: PIPE_ROW.price, extra: "22.1" },
  ],
  overhead: { ref: "Пр/812-022.0-1", base: 117 },
  profit: { ref: "Пр/774-022.0", base: 74 },
  override: { total: TOTAL },
};

const RESOURCE_ROW = /^(?:Н|\d+\.\d+)?,(?:\d-\d{3}-\d{2,3}|91\.\d{2}\.\d{2}-\d{3}|\d{2}\.\d\.\d{2}\.\d{2}-\d{4}),/;

function billOf(text: string): { items: BillOfWorkItem[]; title: string } {
  const set = buildLsrSet(parseCustomerLsr([{ name: "смета.xlsx", text }]).estimates);
  const { section } = lsrBillSection(set.entries[0] as (typeof set.entries)[number], 1);
  // Как в `buildResourceFromDocuments`: шифр из подсказки становится кодом нормы, единица нормы совпадает с единицей позиции.
  const items = section.items.map((item) =>
    item.normCodeHint === null || item.normCodeHint === undefined ? item : { ...item, normCode: item.normCodeHint.code, normBaseType: item.normCodeHint.baseType ?? "ГЭСН" },
  );
  return { items, title: section.title };
}

function calculate(text: string, norms: readonly NormRecord[] = [NORM]) {
  const { items, title } = billOf(text);
  const base = baseOf(norms);
  const { document } = calculateBill({
    title: "Тест",
    sections: [makeBillSection(title, items)],
    base,
    priceBook: base.priceBook,
    parameters: makeParameters(),
    appliedNormatives: [],
    sources: [],
    generatedAt: "2026-10-10T00:00:00.000Z",
  });
  return { document, items };
}

/* ------------------------- Случай 1: труба посчитана нормой и стоит в остатке ------------------------- */

describe("случай 1 (ГЭСН22-01-011-02): материал заказчика вне «М» не считается дважды", () => {
  const text = lsrDocument({ positions: [PIPE_SPEC] });

  it("разбор: прямые 177 962,89, «М» 7 400,12, остаток 479 679,30 (= труба «22.1»), «М» передана строке остатка", () => {
    const set = buildLsrSet(parseCustomerLsr([{ name: "смета.xlsx", text }]).estimates);
    const position = set.entries[0]?.estimate.positions[0] as CustomerPosition;
    expect(position.directTotal).toBeCloseTo(177_962.89, 1);
    expect(position.groupTotals.materials).toBeCloseTo(M_PRINTED, 2);
    const status = hiddenRemainderOf(position);
    expect(status.kind).toBe("FOUND");
    if (status.kind === "FOUND") expect(status.remainder).toBeCloseTo(PIPE, 1);

    const { items } = billOf(text);
    const rest = items.find((item) => item.unaccountedOf !== undefined);
    expect(rest?.customerPrice?.total).toBeCloseTo(PIPE, 1);
    expect(rest?.customerPrintedMaterials).toBeCloseTo(M_PRINTED, 2);
    // Состав заказчика с трубой «22.1» и его «М» лежат в позиции: по ним расчёт видит, что норма оценила больше напечатанного.
    expect(items[0]?.customerResources?.some((resource) => resource.code === PIPE_ROW.code)).toBe(true);
    expect(items[0]?.customerMaterials).toBeCloseTo(M_PRINTED, 2);
  });

  it("в расчёте материалы нормы 487 079,42 уже включают трубу — остаток не добавляется, итог равен итогу заказчика", () => {
    const { document, items } = calculate(text);
    const [main] = document.sections[0]?.lines ?? [];

    expect(main?.materialCost).toBeCloseTo(M_PRINTED + PIPE, 1);
    expect(document.sections[0]?.lines).toHaveLength(1);
    expect(document.sections[0]?.workCost).toBeCloseTo(TOTAL, 0);
    expect(document.totals.workCost).toBeCloseTo(TOTAL, 0);

    const rest = items.find((item) => item.unaccountedOf !== undefined);
    const gap = document.gaps.find((entry) => entry.message.includes(rest?.workName ?? "—"));
    expect(gap?.message).toContain("уже в материалах нормы");
    expect(gap?.message).toContain("добавлено 0,00 ₽");
  });

  it("то же без ресурсных строк (в ЛСР только группы): «М» заказчика заменяет материалы нормы, остаток по его цене, итог равен итогу заказчика", () => {
    const groupsOnly = lsrDocument({ positions: [PIPE_SPEC] })
      .split("\n")
      .filter((row) => !RESOURCE_ROW.test(row))
      .join("\n");
    const { items } = billOf(groupsOnly);
    expect(items[0]?.customerResources).toBeUndefined();
    expect(items[0]?.customerMaterials).toBeCloseTo(M_PRINTED, 2);

    const { document } = calculate(groupsOnly);
    const [main, rest] = document.sections[0]?.lines ?? [];
    expect(main?.materialCost).toBeCloseTo(M_PRINTED, 2);
    expect(rest?.directCost).toBeCloseTo(PIPE, 1);
    expect(rest?.priceSource).toBe("CUSTOMER_PRICE");
    expect(document.sections[0]?.workCost).toBeCloseTo(TOTAL, 0);
  });

  it("наша труба дешевле заказчика: добавляется только разница", () => {
    // Заказчик оценил трубу на 30 000 ₽ дороже нашей цены: остаток 509 679,30, из них 479 679,30 покрыто материалами нормы.
    const dearer: PositionSpec = {
      ...PIPE_SPEC,
      resources: PIPE_SPEC.resources.map((resource) => (resource.code === PIPE_ROW.code ? { ...resource, price: PIPE_ROW.price + 30_000 / pipeQty } : resource)),
      override: { total: TOTAL + 30_000 },
    };
    const { document } = calculate(lsrDocument({ positions: [dearer] }));
    // Состав заказчика оценивается нашими ценами (труба — 479 679,30), остальное доплачивается по его остатку.
    const [main, rest] = document.sections[0]?.lines ?? [];
    expect(main?.materialCost).toBeCloseTo(M_PRINTED + PIPE, 1);
    expect(rest?.directCost).toBeCloseTo(30_000, 0);
    expect(rest?.priceNote).toContain("добавлено 30");
    expect(document.sections[0]?.workCost).toBeCloseTo(TOTAL + 30_000, 0);
  });
});

/* ------------------------- Зачёт остатка в материалах нормы (расчёт строки) ------------------------- */

describe("зачёт остатка в материалах нормы: computeEstimateSection", () => {
  const priceBook = makePriceBook(WAGE_SCALE, { current: baseOf().priceBook.current, overheadRates: RATES });
  const oursMaterials = M_PRINTED + PIPE;

  const main = (patch: Partial<BillOfWorkItem> = {}) =>
    makeBillItem({ id: "p", workName: "Укладка труб", quantity: QUANTITY, quantityUnit: "км", unitDivisor: 1, normCode: "22-01-011-02", normBaseType: "ГЭСН", ...patch });
  const rest = (patch: Partial<BillOfWorkItem> = {}) =>
    makeBillItem({
      id: "p-rest",
      workName: "Неучтённые в выгрузке ресурсы позиции 1",
      quantity: 1,
      quantityUnit: "усл. ед.",
      unitDivisor: 1,
      normCode: null,
      normBaseType: null,
      customerPriceOnly: true,
      unaccountedOf: "p",
      customerPrintedMaterials: M_PRINTED,
      customerPrice: { total: PIPE, unitPrice: PIPE, unit: "усл. ед.", origin: "POSITION_TOTAL", document: null },
      ...patch,
    });
  const run = (items: readonly BillOfWorkItem[]) => computeEstimateSection(makeBillSection("ЛСР", items), priceBook, makeParameters(), makeResolver([NORM]));

  it("остаток целиком покрыт материалами нормы — строки нет, в пометках названо, сколько покрыто и сколько добавлено", () => {
    const { section, gaps } = run([main(), rest()]);
    expect(section.lines).toHaveLength(1);
    expect(section.lines[0]?.materialCost).toBeCloseTo(oursMaterials, 1);
    const note = gaps.find((gap) => gap.message.includes("уже в материалах нормы"));
    expect(note?.message).toContain("остаток заказчика 479679,30 ₽");
    expect(note?.message).toContain("из них 479679,30 ₽ уже в материалах нормы");
    expect(note?.message).toContain("добавлено 0,00 ₽");
  });

  it("покрыта часть: строка остатка уменьшена, пояснение — в её priceNote", () => {
    const { section, gaps } = run([main(), rest({ customerPrice: { total: PIPE + 5_000, unitPrice: PIPE + 5_000, unit: "усл. ед.", origin: "POSITION_TOTAL", document: null } })]);
    expect(section.lines).toHaveLength(2);
    expect(section.lines[1]?.directCost).toBeCloseTo(5_000, 2);
    expect(section.lines[1]?.priceSource).toBe("CUSTOMER_PRICE");
    expect(section.lines[1]?.priceNote).toBe(
      "остаток заказчика 484679,30 ₽, из них 479679,30 ₽ уже в материалах нормы " +
        `(наши материалы ${oursMaterials.toFixed(2).replace(".", ",")} ₽ при «М» заказчика ${M_PRINTED.toFixed(2).replace(".", ",")} ₽) — добавлено 5000,00 ₽`,
    );
    expect(gaps.some((gap) => gap.kind === "CUSTOMER_PRICE" && gap.message.includes("добавлено 5000,00 ₽"))).toBe(true);
  });

  it("наши материалы не выше «М» заказчика — избытка нет, остаток идёт целиком и без пометки о зачёте", () => {
    const { section, gaps } = run([main(), rest({ customerPrintedMaterials: oursMaterials })]);
    expect(section.lines).toHaveLength(2);
    expect(section.lines[1]?.directCost).toBeCloseTo(PIPE, 2);
    expect(section.lines[1]?.priceNote).toBeUndefined();
    expect(gaps.some((gap) => gap.message.includes("уже в материалах нормы"))).toBe(false);
  });

  it("«М» заказчика неизвестна — остаток идёт целиком (как прежде)", () => {
    const { section } = run([main(), rest({ customerPrintedMaterials: undefined })]);
    expect(section.lines).toHaveLength(2);
    expect(section.lines[1]?.directCost).toBeCloseTo(PIPE, 2);
  });

  it("главной позиции в расчёте нет (норма не найдена, позиция по цене заказчика) — остаток идёт целиком", () => {
    const { section } = run([main({ normCode: "00-00-000-00", customerPrice: { total: 100, unitPrice: 100, unit: "км", origin: "POSITION_TOTAL", document: null } }), rest()]);
    expect(section.lines.map((line) => line.priceSource)).toEqual(["CUSTOMER_PRICE", "CUSTOMER_PRICE"]);
    expect(section.lines[1]?.directCost).toBeCloseTo(PIPE, 2);
  });

  it("исключение (отрицательный объём): знак минус сохраняется и у главной строки, и у остатка; зачёт идёт по модулю", () => {
    const { section } = run([main({ deduction: true }), rest({ deduction: true, customerPrice: { total: PIPE + 1_000, unitPrice: PIPE + 1_000, unit: "усл. ед.", origin: "POSITION_TOTAL", document: null } })]);
    expect(section.lines).toHaveLength(2);
    expect(section.lines[0]?.deduction).toBe(true);
    expect(section.lines[0]?.directCost).toBeLessThan(0);
    expect(section.lines[1]?.deduction).toBe(true);
    expect(section.lines[1]?.directCost).toBeCloseTo(-1_000, 2);
  });

  it("остаток без привязки к «М» (старая ведомость) считается как раньше", () => {
    const { section } = run([main(), rest({ customerPrintedMaterials: undefined, unaccountedOf: undefined })]);
    expect(section.lines).toHaveLength(2);
    expect(section.lines[1]?.directCost).toBeCloseTo(PIPE, 2);
  });
});

/* ------------------------- Случай 2: НР и СП не прочитаны ------------------------- */

describe("случай 2 (ГЭСНп07-10-015-02): строк НР и СП нет в разборе — остатка нет", () => {
  // Прямые 400 000, «НР + СП» 247 135 в «Всего по позиции» 647 135, но строк НР и СП в разборе нет.
  const spec: PositionSpec = {
    n: 1,
    justification: "ГЭСНп07-10-015-02",
    name: "Узел учета тепловой энергии",
    unit: "компл",
    qty: 1,
    resources: [{ code: "1-100-30", name: "Средний разряд работы 3,0", unit: "чел.-ч", perUnit: 400, qty: 400, price: 1000 }],
    override: { total: 647_135 },
  };

  it("позиция по расценке без строк НР и СП: статус «начисления неизвестны», строки остатка и «материала» нет", () => {
    const text = lsrDocument({ positions: [spec] });
    const set = buildLsrSet(parseCustomerLsr([{ name: "смета.xlsx", text }]).estimates);
    const position = set.entries[0]?.estimate.positions[0] as CustomerPosition;
    expect(position.overhead).toBeNull();
    expect(position.profit).toBeNull();
    expect(hiddenRemainderOf(position).kind).toBe("ACCRUALS_UNKNOWN");

    const { items } = billOf(text);
    expect(items.some((item) => item.unaccountedOf !== undefined)).toBe(false);
    expect(items[0]?.sourceQuote).toContain("Невидимый остаток не выделен");
    expect(items[0]?.customerPrice?.total).toBeCloseTo(647_135, 2);
  });

  it("то же для ГЭСН, ГЭСНм, ГЭСНр и ФЕР: расценка — значит начисления есть", () => {
    for (const justification of ["ГЭСН16-03-001-01", "ГЭСНм18-05-001-01", "ГЭСНр65-01-005-09", "ФЕР01-01-001-01"]) {
      const text = lsrDocument({ positions: [{ ...spec, justification }] });
      const set = buildLsrSet(parseCustomerLsr([{ name: "смета.xlsx", text }]).estimates);
      const position = set.entries[0]?.estimate.positions[0] as CustomerPosition;
      expect(hiddenRemainderOf(position).kind, justification).toBe("ACCRUALS_UNKNOWN");
    }
  });

  it("позиции, у которых начислений быть не должно (поставка ресурса, цена услуги перевозки), по-прежнему считают их нулём", () => {
    const supply = lsrDocument({ positions: [{ ...spec, justification: "ФСБЦ-01.7.15.03-0042", override: { total: 401_500 } }] });
    const supplyPosition = buildLsrSet(parseCustomerLsr([{ name: "смета.xlsx", text: supply }]).estimates).entries[0]?.estimate.positions[0] as CustomerPosition;
    expect(hiddenRemainderOf(supplyPosition)).toMatchObject({ kind: "FOUND", remainder: 1500 });

    const service = lsrDocument({ positions: [{ ...spec, justification: "49-1", name: "Погрузка в автотранспортное средство: гравий", override: { total: 401_500 } }] });
    const servicePosition = buildLsrSet(parseCustomerLsr([{ name: "смета.xlsx", text: service }]).estimates).entries[0]?.estimate.positions[0] as CustomerPosition;
    expect(hiddenRemainderOf(servicePosition)).toMatchObject({ kind: "FOUND", remainder: 1500 });
  });

  it("НР и СП напечатаны — остаток считается как раньше (позиция с настоящим материалом по проекту)", () => {
    const withRates: PositionSpec = { ...spec, overhead: { ref: "Пр/812-007.0-1", base: 100 }, profit: { ref: "Пр/774-007.0", base: 60 }, override: { total: 400_000 + 400_000 + 240_000 + 150_000 } };
    const position = buildLsrSet(parseCustomerLsr([{ name: "смета.xlsx", text: lsrDocument({ positions: [withRates] }) }]).estimates).entries[0]?.estimate.positions[0] as CustomerPosition;
    expect(hiddenRemainderOf(position)).toMatchObject({ kind: "FOUND", remainder: 150_000 });
  });
});
