import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { computeEstimateSection } from "@/domain/estimate/calculate";
import { deriveGroupTotals, parseCustomerLsr, type CustomerLsr, type CustomerPosition } from "@/domain/estimate/customerLsr";
import {
  GRAND_LAYOUT,
  lsrDocument,
  lsrPosition,
  lsrRow,
  lsrHead,
  lsrTotals,
  type PositionSpec,
} from "@/domain/estimate/customerLsr.builders";
import { summarizeCustomerConditions } from "@/domain/estimate/customerCoefficients";
import { hiddenRemainderOf, lsrBillSection, materialRowsOf } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  NORM_DRAINAGE_100,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/*
  Четыре системных ошибки бенчмарка 22 закупок, которые лежат в разборе ЛСР и ведомости из неё:
  невидимый остаток из-за непрочитанных сумм НР и СП, выгрузка Гранд-Сметы без строк групп, материал «по проекту» по цене
  заказчика и позиция по ТЦ без единицы. Образец выгрузки без групп — закупка 0134300025826000377 (Иркутск, зона 3,
  III кв. 2026): строки позиции 9 в фикстуре дословно из документа; итоги позиции (прямые затраты, ФОТ, НР, СП, всего)
  досчитаны по этим строкам, а шапка сокращена до обязательных строк.
*/

const FIXTURE = readFileSync(path.resolve(__dirname, "__fixtures__/t0377/lsr-irkutsk-no-groups.txt"), "utf8");

function parseOne(text: string): CustomerLsr {
  const { estimates } = parseCustomerLsr([{ name: "смета.xlsx", text }]);
  expect(estimates).toHaveLength(1);
  return estimates[0] as CustomerLsr;
}

function billOf(text: string) {
  const set = buildLsrSet(parseCustomerLsr([{ name: "смета.xlsx", text }]).estimates);
  return lsrBillSection(set.entries[0] as (typeof set.entries)[number], 1);
}

/* ------------------------- Выгрузка без строк групп ------------------------- */

describe("выгрузка без групп «ОТ(ЗТ)», «ЭМ», «М»: итоги групп из строк ресурсов", () => {
  const lsr = parseOne(FIXTURE);
  const position = lsr.positions[0] as CustomerPosition;

  it("позиция 9: труд, машинист, машина и материал просуммированы по классу кода", () => {
    expect(position.groupTotals).toEqual({ labour: 293_474.98, machines: 329.89, machinistLabour: 437.64, materials: 37_133.77 });
    expect(position.groupTotalsDerived).toBe(true);
  });

  it("сумма групп сходится с «Итого прямые затраты» заказчика", () => {
    const g = position.groupTotals;
    expect((g.labour ?? 0) + (g.machines ?? 0) + (g.machinistLabour ?? 0) + (g.materials ?? 0)).toBeCloseTo(position.directTotal as number, 2);
  });

  it("объём и единица: 6,1 × «100 м2»", () => {
    expect(position.quantity).toBe(6.1);
    expect(position.unit).toBe("100 м2");
  });

  it("группы, напечатанные в смете, не пересчитываются: у позиции с группами признака нет", () => {
    const text = lsrDocument({
      positions: [
        {
          n: 1,
          justification: "ГЭСН08-07-001-02",
          name: "Работа",
          unit: "100 м2",
          qty: 1,
          resources: [{ code: "1-100-31", unit: "чел.-ч", perUnit: 10, qty: 10, price: 900 }],
        },
      ],
    });
    const printed = (parseOne(text).positions[0] as CustomerPosition).groupTotals;
    expect(printed.labour).toBe(9000);
    expect((parseOne(text).positions[0] as CustomerPosition).groupTotalsDerived).toBeUndefined();
  });

  it("строка ресурса без стоимости делает итоги неполными — их нет совсем, а не частичные", () => {
    const resource = (code: string, total: number | null) => ({
      code,
      rawCode: code,
      customerPrice: false,
      name: "",
      unit: "т",
      qtyPerUnit: 1,
      qtyTotal: total === null ? null : 1,
      baseUnitPrice: null,
      index: null,
      currentUnitPrice: null,
      priceCoefficient: null,
      currentTotal: total,
      unaccounted: false,
      extra: false,
    });
    expect(deriveGroupTotals([resource("01.7.16.02-0002", 100), resource("01.7.16.02-0003", null)])).toBeNull();
    expect(deriveGroupTotals([resource("01.7.16.02-0002", 100), resource("01.7.16.02-0003", 50)])?.materials).toBe(150);
  });

  it("строка «Н» (неучтённый ресурс) и дополнение «22.1» в итоги не входят", () => {
    const base = {
      rawCode: "",
      customerPrice: false,
      name: "",
      unit: "т",
      qtyPerUnit: 1,
      qtyTotal: 1,
      baseUnitPrice: null,
      index: null,
      currentUnitPrice: null,
      priceCoefficient: null,
    };
    const totals = deriveGroupTotals([
      { ...base, code: "01.7.16.02-0002", currentTotal: 100, unaccounted: false, extra: false },
      { ...base, code: "01.7.16.02-0003", currentTotal: null, unaccounted: true, extra: false },
      { ...base, code: "01.7.16.02-0004", currentTotal: 7, unaccounted: false, extra: true },
    ]);
    expect(totals?.materials).toBe(100);
  });
});

describe("выгрузка без групп: ведомость из ЛСР", () => {
  const { section } = billOf(FIXTURE);
  const item = section.items[0];

  it("позиция входит в ведомость с составом заказчика и объёмом 610 м2", () => {
    expect(section.items).toHaveLength(1);
    expect(item?.quantity).toBeCloseTo(610, 6);
    expect(item?.quantityUnit).toBe("м2");
    expect(item?.customerResources?.map((resource) => resource.code)).toEqual(["1-100-31", "91.14.02-001", "4-100-040", "01.7.16.02-0002"]);
  });

  it("строка коэффициентов «Прил.8.1 п.3.7 … ОЗП=1,2; МАТ=1,2; ТЗ=1,2» разобрана и осталась неподтверждённой находкой", () => {
    expect(item?.customerCoefficients).toContain("ОЗП=1,2; МАТ=1,2 к расх.; ТЗ=1,2");
    expect(item?.customerConditions?.confirmed).toBeNull();
    const [claim] = item?.customerConditions?.rejected ?? [];
    expect(claim?.reason).toContain("Прил.8.1 п.3.7");
    expect(claim?.labour).toBe(1.2);
    // 1,2 к ФОТ-части прямых затрат (ОТ + ЭМ + ОТм из выведенных итогов групп): без них сумма находки была бы нулевой.
    expect(claim?.amount).toBeCloseTo((293_474.98 + 329.89 + 437.64) * (1 - 1 / 1.2), 1);
    expect(item?.sourceQuote).toContain("в расчёт не включены");
  });

  it("в аудите коэффициент назван неподтверждённым, с суммой в прямых затратах заказчика", () => {
    const summary = summarizeCustomerConditions(section.items, "ЛСР 02-01-01");

    expect(summary).toMatchObject({ positions: 1, confirmed: 0, rejected: 1 });
    expect(summary.rejectedAmount).toBeCloseTo(49_040.42, 1);
    expect(summary.notes[0]).toContain("не подтверждается приложением 10");
    expect(summary.notes[0]).toContain("Прил.8.1 п.3.7");
  });
});

/* ------------------------- Материал «по проекту» у заказчика ------------------------- */

/** Позиция ГЭСН 12-01-033-02 «Монтаж кровли из профилированного листа»: лист — по ТЦ, групп в выгрузке нет. */
const ROOF: PositionSpec = {
  n: 1,
  justification: "ГЭСН12-01-033-02",
  name: "Монтаж кровли из профилированного листа",
  unit: "100 м2",
  qty: 2.5,
  resources: [
    { code: "1-100-28", name: "Средний разряд работы 2,8", unit: "чел.-ч", perUnit: 60, qty: 150, price: 800 },
    { code: "91.05.05-015", name: "Краны на автомобильном ходу", unit: "маш.-ч", perUnit: 1, qty: 2.5, price: 1500 },
    { code: "ТЦ_72_7201234567_10.10.2025_Профнастил С21", name: "Профилированный лист С21-1000-0,7", unit: "м2", perUnit: 105, qty: 262.5, price: 1900 },
  ],
  overhead: { ref: "Пр/812-012.0-1", base: 100 },
  profit: { ref: "Пр/774-012.0", base: 60 },
};

const GROUP_ROW_RE = /^,\d,(?:ОТ\(ЗТ\)|ЭМ|ОТм\(ЗТм\)|М),/;
const withoutGroupRows = (text: string): string =>
  text
    .split("\n")
    .filter((row) => !GROUP_ROW_RE.test(row))
    .join("\n");

describe("материал «по проекту» по цене заказчика", () => {
  const text = withoutGroupRows(lsrDocument({ positions: [ROOF] }));
  const { section } = billOf(text);
  const item = section.items[0];

  it("состав с ценой заказчика не годится как состав нормы, но сумма материалов выведена из ресурсов", () => {
    expect(item?.customerResources).toBeUndefined();
    expect(item?.customerMaterials).toBeCloseTo(262.5 * 1900, 2);
  });

  it("строка ресурса с ценой заказчика (код, наименование, стоимость на единицу объёма) лежит в позиции", () => {
    expect(item?.customerMaterialRows).toHaveLength(1);
    const [row] = item?.customerMaterialRows ?? [];
    expect(row).toMatchObject({ customerPrice: true, unit: "м2", extra: false, quantity: 262.5 });
    expect(row?.name).toBe("Профилированный лист С21-1000-0,7");
    // 498 750 ₽ на 250 м2.
    expect(row?.costPerUnit).toBeCloseTo(498_750 / 250, 6);
  });

  it("позиции без ценных строк материалов, а также труд и машины, в `customerMaterialRows` не входят", () => {
    const labourOnly = parseOne(lsrDocument({ positions: [{ ...ROOF, resources: (ROOF.resources as PositionSpec["resources"]).slice(0, 2) }] })).positions[0] as CustomerPosition;
    expect(materialRowsOf(labourOnly, 250)).toBeUndefined();
  });

  describe("в расчёте", () => {
    const priceBook = makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE));
    const parameters = makeParameters();
    const drainage = (patch: Partial<Parameters<typeof makeBillItem>[0]> = {}) =>
      makeBillItem({
        id: "drain",
        workName: "Устройство закрытого дренажа из полиэтиленовых труб диаметром 100 мм",
        quantity: 2000,
        quantityUnit: "м",
        unitDivisor: 1000,
        normCode: "01-01-129-11",
        normBaseType: "ГЭСН",
        ...patch,
      });
    const calc = (patch: Partial<Parameters<typeof makeBillItem>[0]> = {}) =>
      computeEstimateSection(makeBillSection("Дренаж", [drainage(patch)]), priceBook, parameters, makeResolver([NORM_DRAINAGE_100]));
    const row = (code: string, costPerUnit: number) => ({ code, name: "Труба дренажная", unit: "м", customerPrice: true, extra: false, costPerUnit, quantity: 2050 });

    it("ресурс нормы без марки (24.3.03.06) берётся по строке заказчика с тем же кодом; пробел по нему снят, соседний остался", () => {
      const base = calc();
      const priced = calc({ customerMaterialRows: [row("24.3.03.06", 120)] });
      const line = priced.section.lines[0];
      const material = line?.resources.find((resource) => resource.code === "24.3.03.06");

      expect(material).toMatchObject({ source: "CUSTOMER_SUM", kind: "MATERIAL", total: 240_000 });
      expect((line?.directCost ?? 0) - (base.section.lines[0]?.directCost ?? 0)).toBeCloseTo(240_000, 2);
      expect(priced.gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("24.3.03.06"))).toBe(false);
      expect(priced.gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("24.3.03.05"))).toBe(true);
      const customerGap = priced.gaps.find((gap) => gap.kind === "CUSTOMER_PRICE");
      expect(customerGap?.message).toContain("принят по цене заказчика");
      expect(customerGap?.message).toContain("24.3.03.06");
    });

    it("материал заказчика, которого нет в норме, закрывает ресурс по проекту", () => {
      const priced = calc({ customerMaterialRows: [row("ТЦ_72_труба", 50)] });
      const line = priced.section.lines[0];
      const material = line?.resources.find((resource) => resource.source === "CUSTOMER_SUM");

      expect(material?.total).toBe(100_000);
      expect(priced.gaps.find((gap) => gap.kind === "CUSTOMER_PRICE")?.message).toContain("ТЦ_72_труба");
      // Отдан первому ресурсу по проекту (24.3.03.05, расход «П»): пробел по нему снят, по второму остался.
      expect(priced.gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("24.3.03.05"))).toBe(false);
      expect(priced.gaps.some((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" && gap.message.includes("24.3.03.06"))).toBe(true);
    });

    it("материалов заказчика больше, чем ресурсов по проекту в норме, — лишний назван «материалом, которого нет в норме»", () => {
      const priced = calc({ customerMaterialRows: [row("ТЦ_a", 10), row("ТЦ_b", 20), row("ТЦ_c", 30)] });
      const messages = priced.gaps.filter((gap) => gap.kind === "CUSTOMER_PRICE").map((gap) => gap.message);

      expect(messages).toHaveLength(3);
      expect(messages.filter((message) => message.includes("которого нет в норме"))).toHaveLength(1);
      expect(priced.section.lines[0]?.resources.filter((resource) => resource.source === "CUSTOMER_SUM")).toHaveLength(3);
    });

    it("стоимость масштабируется с объёмом позиции: объём правят — цена заказчика за единицу остаётся", () => {
      const half = calc({ quantity: 1000, customerMaterialRows: [row("24.3.03.06", 120)] });
      expect(half.section.lines[0]?.resources.find((resource) => resource.source === "CUSTOMER_SUM")?.total).toBe(120_000);
    });

    it("материалы ушли в сумму заказчика (`customerMaterials` разошлась с нормой) — отдельные строки не добавляются: нет двойного счёта", () => {
      const priced = calc({ customerMaterials: 900_000, customerMaterialRows: [row("24.3.03.06", 120)] });
      const sums = priced.section.lines[0]?.resources.filter((resource) => resource.source === "CUSTOMER_SUM") ?? [];
      expect(sums).toHaveLength(1);
      expect(sums[0]?.total).toBe(900_000);
    });

    it("позиция без ресурса по проекту строки заказчика не использует", () => {
      const grading = makeBillItem({ customerMaterialRows: [row("24.3.03.06", 120)] });
      const { section } = computeEstimateSection(makeBillSection("Планировка", [grading]), priceBook, parameters, makeResolver([]));
      expect(section.lines.every((line) => line.resources.every((resource) => resource.source !== "CUSTOMER_SUM"))).toBe(true);
    });
  });
});

/* ------------------------- Невидимый остаток ------------------------- */

/** Строки позиции, у которых НР и СП напечатаны процентом, а суммы нет; ФОТ можно убрать. */
function positionRowsWithoutAccrualAmounts(spec: PositionSpec, options: { dropWageFund: boolean }): string[] {
  const rows = lsrPosition(spec);
  const result: string[] = [];
  for (const row of rows) {
    if (options.dropWageFund && /^,,ФОТ,/.test(row)) continue;
    // Строки НР и СП: «,Пр/812-…,НР …,,,,,%,154,,154,,,,,<сумма>» — сумму (последняя графа) убираем.
    const rate = /^,(Пр\/(?:812|774)[^,]*),("?(?:НР|СП)[^,]*"?),,,,,%,([\d.]+),,([\d.]+),/.exec(row);
    if (rate !== null) {
      result.push(lsrRow({ 2: rate[1] as string, 3: rate[2] as string, 4: "%", 5: rate[3] as string, 7: rate[4] as string }, GRAND_LAYOUT));
      continue;
    }
    result.push(row);
  }
  return result;
}

function documentOfRows(positionRows: readonly string[], sectionTotal: number): string {
  return [...lsrHead(), "Раздел 1. Тестовые работы", ...positionRows, ...lsrTotals({ sectionTotal, total: sectionTotal })].join("\n");
}

/** Позиция ГЭСН27-03-004-01 по Камчатке: у заказчика 90 003 677,64 при прямых затратах 6 599 244,33, НР 154 %, СП 134 %. */
const KAMCHATKA: PositionSpec = {
  n: 1,
  justification: "ГЭСН27-03-004-01",
  name: "Устройство покрытия",
  unit: "1000 м2",
  qty: 1,
  resources: [{ code: "1-100-30", name: "Средний разряд работы 3,0", unit: "чел.-ч", perUnit: 2000, qty: 2000, price: 1150 }],
  overhead: { ref: "Пр/812-027.0-1", base: 154 },
  profit: { ref: "Пр/774-027.0", base: 134 },
  override: { direct: 6_599_244.33, total: 90_003_677.64 },
};

describe("невидимый остаток: НР и СП без прочитанных сумм не превращаются в «материал по проекту»", () => {
  it("Камчатка: проценты НР 154 % и СП 134 % есть, сумм и ФОТ нет — остатка и строки «неучтённые ресурсы» нет", () => {
    const text = documentOfRows(positionRowsWithoutAccrualAmounts(KAMCHATKA, { dropWageFund: true }), 90_003_677.64);
    const lsr = parseOne(text);
    const position = lsr.positions[0] as CustomerPosition;
    expect(position.overhead).toMatchObject({ percent: 154, amount: null });
    expect(position.profit).toMatchObject({ percent: 134, amount: null });
    expect(position.wageFund).toBeNull();

    expect(hiddenRemainderOf(position).kind).toBe("ACCRUALS_UNKNOWN");
    const { section } = billOf(text);
    expect(section.items).toHaveLength(1);
    expect(section.items.some((item) => item.unaccountedOf !== undefined)).toBe(false);
    expect(section.items[0]?.sourceQuote).toContain("Невидимый остаток не выделен");
    // Цена заказчика позиции — вся «Всего по позиции»: деньги не теряются, если нашей нормы не найдётся.
    expect(section.items[0]?.customerPrice?.total).toBeCloseTo(90_003_677.64, 2);
  });

  it("Забайкалье: ГЭСН22-01-011-02, фантом 479 679 ₽ — суммы НР и СП не прочитаны, остатка нет", () => {
    const spec: PositionSpec = {
      n: 1,
      justification: "ГЭСН22-01-011-02",
      name: "Устройство основания",
      unit: "100 м",
      qty: 1,
      resources: [{ code: "1-100-26", name: "Средний разряд работы 2,6", unit: "чел.-ч", perUnit: 400, qty: 400, price: 700 }],
      overhead: { ref: "Пр/812-022.0-1", base: 107 },
      profit: { ref: "Пр/774-022.0", base: 70 },
      // Прямые 612 345,67 + НР и СП 479 679 = всего 1 092 024,67.
      override: { direct: 612_345.67, total: 1_092_024.67 },
    };
    const text = documentOfRows(positionRowsWithoutAccrualAmounts(spec, { dropWageFund: true }), 1_092_024.67);
    const { section } = billOf(text);
    expect(section.items.filter((item) => item.unaccountedOf !== undefined)).toHaveLength(0);
  });

  it("ФОТ прочитан — сумма НР и СП выводится как ФОТ × процент, и остаток считается по настоящей видимой части", () => {
    // ФОТ 2 300 000: НР 154 % = 3 542 000, СП 134 % = 3 082 000; видимая часть 13 223 244,33.
    const spec = (total: number): PositionSpec => ({ ...KAMCHATKA, override: { direct: 6_599_244.33, fot: 2_300_000, total } });
    const noRest = billOf(documentOfRows(positionRowsWithoutAccrualAmounts(spec(13_223_244.33), { dropWageFund: false }), 13_223_244.33));
    expect(noRest.section.items.filter((item) => item.unaccountedOf !== undefined)).toHaveLength(0);

    // Настоящий остаток 180 000 ₽ (материал по проекту по КП) выделяется — как и раньше.
    const total = 13_223_244.33 + 180_000;
    const withRest = billOf(documentOfRows(positionRowsWithoutAccrualAmounts(spec(total), { dropWageFund: false }), total));
    const rest = withRest.section.items.find((item) => item.unaccountedOf !== undefined);
    expect(rest?.customerPrice?.total).toBeCloseTo(180_000, 2);
    // Цена заказчика самой позиции — только видимая часть: остаток идёт отдельной строкой.
    expect(withRest.section.items[0]?.customerPrice?.total).toBeCloseTo(13_223_244.33, 2);
  });

  it("остаток больше прямых затрат в 10 раз — ошибка разбора, а не материал: строки нет, причина названа", () => {
    // Те же НР и СП из ФОТ, но «Всего по позиции» 90 млн: остаток 76,8 млн при прямых 6,6 млн (в 11,6 раза).
    const spec: PositionSpec = { ...KAMCHATKA, override: { direct: 6_599_244.33, fot: 2_300_000, total: 90_003_677.64 } };
    const text = documentOfRows(positionRowsWithoutAccrualAmounts(spec, { dropWageFund: false }), 90_003_677.64);
    const position = parseOne(text).positions[0] as CustomerPosition;
    const status = hiddenRemainderOf(position);

    expect(status.kind).toBe("IMPLAUSIBLE");
    expect(billOf(text).section.items.filter((item) => item.unaccountedOf !== undefined)).toHaveLength(0);
    expect(billOf(text).section.items[0]?.sourceQuote).toContain("более чем в 10 раз");
  });

  it("позиция с копеечными прямыми затратами может иметь остаток в тысячи: нижняя граница допуска", () => {
    // Прямые 100 ₽, ФОТ 50 ₽: НР 77, СП 67; «Всего» 3 244 = 244 видимых + 3 000 остатка (в 30 раз больше прямых, но меньше 5 000 ₽).
    const spec: PositionSpec = { ...KAMCHATKA, override: { direct: 100, fot: 50, overheadAmount: 77, profitAmount: 67, total: 3_244 } };
    const small = parseOne(lsrDocument({ positions: [spec] })).positions[0] as CustomerPosition;
    expect(hiddenRemainderOf(small)).toMatchObject({ kind: "FOUND", remainder: 3000 });
    // Остаток 20 000 ₽ при прямых затратах 100 ₽ — уже ошибка разбора: больше и 10 × 100, и нижней границы 5 000 ₽.
    const big = parseOne(lsrDocument({ positions: [{ ...spec, override: { ...spec.override, total: 20_244 } }] })).positions[0] as CustomerPosition;
    expect(hiddenRemainderOf(big).kind).toBe("IMPLAUSIBLE");
  });

  it("остаток противоположного знака (видимая часть больше итога) для положительной позиции — не остаток", () => {
    const text = lsrDocument({ positions: [{ ...KAMCHATKA, override: { direct: 1000, fot: 500, overheadAmount: 770, profitAmount: 670, total: 2000 } }] });
    const position = parseOne(text).positions[0] as CustomerPosition;
    // Видимая часть 1000 + 770 + 670 = 2440 > 2000.
    expect(hiddenRemainderOf(position)).toMatchObject({ kind: "IMPLAUSIBLE" });
  });

  it("нет строк НР и СП вовсе у позиции по расценке — их не прочитали, а не «они нулевые»: остатка нет (закупка 0134600008526000372)", () => {
    const spec: PositionSpec = {
      n: 1,
      justification: "ГЭСНм10-01-001-01",
      name: "Монтаж без прочитанных начислений",
      unit: "шт",
      qty: 1,
      resources: [{ code: "1-100-30", name: "Средний разряд работы 3,0", unit: "чел.-ч", perUnit: 10, qty: 10, price: 1000 }],
      override: { total: 12_000 },
    };
    const text = lsrDocument({ positions: [spec] });
    const position = parseOne(text).positions[0] as CustomerPosition;
    expect(hiddenRemainderOf(position).kind).toBe("ACCRUALS_UNKNOWN");
    expect(billOf(text).section.items.some((item) => item.unaccountedOf !== undefined)).toBe(false);
  });

  it("нет строк НР и СП у позиции, у которой начислений быть не должно (поставка ресурса), — нули: остаток считается", () => {
    const spec: PositionSpec = {
      n: 1,
      justification: "ФСБЦ-01.7.15.03-0042",
      name: "Болты",
      unit: "кг",
      qty: 1,
      resources: [{ code: "1-100-30", name: "Средний разряд работы 3,0", unit: "чел.-ч", perUnit: 10, qty: 10, price: 1000 }],
      override: { total: 12_000 },
    };
    const position = parseOne(lsrDocument({ positions: [spec] })).positions[0] as CustomerPosition;
    expect(hiddenRemainderOf(position)).toMatchObject({ kind: "FOUND", remainder: 2000 });
  });
});

/* ------------------------- Позиция по ТЦ без единицы ------------------------- */

describe("позиция по ТЦ, КП, прайсу без единицы измерения не выпадает из ведомости", () => {
  const TC: PositionSpec = {
    n: 1,
    justification: "ТЦ_72_7202112366_10.10.2025_95.2КАп.95.2",
    name: "Консервация трансформатора",
    unit: "",
    qty: 2,
    resources: [],
    override: { total: 3_766_666.66 },
  };

  it("«ТЦ_72_…», объём 2, единицы нет: строка по цене заказчика, единица «шт» названа в цитате, пропуска нет", () => {
    const { section, skipped } = billOf(lsrDocument({ positions: [TC] }));

    expect(skipped).toEqual([]);
    expect(section.items).toHaveLength(1);
    const [item] = section.items;
    expect(item).toMatchObject({ customerPriceOnly: true, quantity: 2, quantityUnit: "шт", positionNumber: "1" });
    expect(item?.customerPrice?.total).toBeCloseTo(3_766_666.66, 2);
    expect(item?.customerPrice?.unitPrice).toBeCloseTo(1_883_333.33, 2);
    expect(item?.sourceQuote).toContain("единица в смете не указана, принята «шт»");
  });

  it("в расчёте такая позиция входит по цене заказчика с пометкой, а не теряется (−7 млн ₽ на закупке 32616401076)", () => {
    const { section } = billOf(lsrDocument({ positions: [TC] }));
    const priceBook = makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE));
    const calculated = computeEstimateSection(makeBillSection("ЛСР", section.items), priceBook, makeParameters(), makeResolver([]));

    expect(calculated.section.lines).toHaveLength(1);
    expect(calculated.section.directCost).toBeCloseTo(3_766_666.66, 2);
    expect(calculated.section.lines[0]?.priceSource).toBe("CUSTOMER_PRICE");
    expect(calculated.gaps.map((gap) => gap.kind)).toEqual(["CUSTOMER_PRICE"]);
  });

  it("по наименованию «Комплект …» единица — «компл»", () => {
    const { section } = billOf(lsrDocument({ positions: [{ ...TC, name: "Комплект запасных частей" }] }));
    expect(section.items[0]?.quantityUnit).toBe("компл");
  });

  it("расценка ГЭСН без единицы по-прежнему не входит и называется пропущенной: единицу выдумывать нельзя", () => {
    const { section, skipped } = billOf(
      lsrDocument({
        positions: [
          {
            n: 1,
            justification: "ГЭСН08-07-001-02",
            name: "Работа без единицы",
            unit: "",
            qty: 2,
            resources: [{ code: "1-100-31", unit: "чел.-ч", perUnit: 10, qty: 20, price: 900 }],
          },
        ],
      }),
    );
    expect(section.items).toHaveLength(0);
    expect(skipped[0]?.reason).toBe("UNKNOWN_UNIT");
  });
});
