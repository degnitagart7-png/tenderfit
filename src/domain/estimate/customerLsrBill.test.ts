import { describe, expect, it } from "vitest";

import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { lsrBillSection } from "@/domain/estimate/customerLsrBill";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import { DOCUMENTS_1118, TOTALS_EX_VAT } from "@/test/t1118Fixtures";

/** Ведомость из ЛСР заказчика строится кодом: шифры, объёмы, цены, поставки, оборудование, исключения. */

const set = buildLsrSet(parseCustomerLsr(DOCUMENTS_1118).estimates);
const bill = (number: string) => {
  const index = set.entries.findIndex((entry) => entry.number === number);
  return lsrBillSection(set.entries[index] as (typeof set.entries)[number], index + 1);
};

describe("lsrBillSection: ЛСР 02-02-08 (вентиляция, оборудование по ТЦ)", () => {
  const { section, skipped } = bill("02-02-08");
  const byLabel = (label: string) => section.items.find((item) => item.positionNumber === label);

  it("раздел — ЛСР с номером и названием; все 27 позиций и подпозиций в ведомости (и строки остатка к четырём из них)", () => {
    expect(section.title.startsWith("ЛСР 02-02-08. ")).toBe(true);
    expect(section.items.filter((item) => item.unaccountedOf === undefined)).toHaveLength(27);
    expect(section.items.filter((item) => item.unaccountedOf !== undefined).map((item) => item.positionNumber)).toEqual(["2*", "6*", "8*", "13*"]);
    expect(skipped).toEqual([]);
  });

  it("цены заказчика по позициям складываются в итог сметы без НДС: деньги не теряются", () => {
    const sum = section.items.reduce((total, item) => total + (item.customerPrice?.total ?? 0), 0);
    expect(sum).toBeCloseTo(TOTALS_EX_VAT["02-02-08"], 1);
  });

  it("шифр расценки берётся из обоснования, единица приводится: «100 шт» × 0,01 → 1 шт", () => {
    const valve = byLabel("1");
    expect(valve?.normCodeHint).toMatchObject({ baseType: "ГЭСНр", code: "65-01-005-09" });
    expect(valve?.quantity).toBeCloseTo(1, 9);
    expect(valve?.quantityUnit).toBe("шт");
    expect(valve?.sourceLevel).toBe("CUSTOMER_ESTIMATE");
  });

  it("«Применительно» в обосновании не портит шифр", () => {
    expect(byLabel("6")?.normCodeHint).toMatchObject({ baseType: "ГЭСНр", code: "65-02-014-01" });
  });

  it("оборудование по ТЦ — отдельная строка только по цене заказчика, без поиска нормы", () => {
    const pump = byLabel("3.2");
    expect(pump?.workName).toBe("Насос центробежный RV80-200/2");
    expect(pump?.customerPriceOnly).toBe(true);
    expect(pump?.normCodeHint).toBeNull();
    expect(pump?.resourceCode).toBeNull();
    expect(pump?.customerPrice?.total).toBeCloseTo(169_754.31, 2);
    expect(byLabel("1.1")?.customerPriceOnly).toBe(true);
  });

  it("поставка материала «3.3 ФСБЦ-…» — по справочнику цен, код ресурса прочитан из многострочной ячейки", () => {
    const flange = byLabel("3.3");
    expect(flange?.resourceCode).toBe("23.8.03.11-0008");
    expect(flange?.customerPriceOnly).toBeUndefined();
    expect(flange?.quantity).toBe(2);
  });

  it("подпозиция-расценка «3.1 ГЭСН…» — работа со своим шифром", () => {
    const pump = byLabel("3.1");
    expect(pump?.normCodeHint).toMatchObject({ baseType: "ГЭСН", code: "18-05-001-01" });
    expect(pump?.resourceCode).toBeNull();
  });

  it("условия и коэффициенты заказчика: в позиции и в цитате; подтверждённые помечены «применены», в объём не входят", () => {
    const insulation = byLabel("12");
    expect(insulation?.customerCoefficients).toContain("ОЗП=1,2");
    expect(insulation?.sourceQuote).toContain("применены, как у заказчика: приложение 10 к 421/пр, таблица 3, п. 1.1");
    expect(insulation?.customerConditions?.confirmed?.conditionIds).toEqual(["T3-1.1"]);
    expect(insulation?.quantity).toBeCloseTo(3.75, 9);
  });

  it("идентификаторы уникальны", () => {
    expect(new Set(section.items.map((item) => item.id)).size).toBe(section.items.length);
  });
});

describe("lsrBillSection: ЛСР 02-02-12 (исключения отрицательным объёмом)", () => {
  const { section } = bill("02-02-12");

  it("позиции с отрицательным объёмом остаются в ведомости как исключения", () => {
    const removed = section.items.filter((item) => item.deduction === true);
    expect(removed.map((item) => item.positionNumber)).toEqual(["2.1", "2.3"]);
    expect(removed[0]?.quantity).toBeCloseTo(24.45, 2);
    expect(removed[0]?.customerPrice?.total).toBeCloseTo(10_432.82, 2);
    expect(removed[0]?.resourceCode).toBe("12.1.01.05-0017");
  });

  it("итог по позициям с учётом знака — итог сметы заказчика без НДС", () => {
    const sum = section.items.reduce((total, item) => total + (item.deduction === true ? -1 : 1) * (item.customerPrice?.total ?? 0), 0);
    expect(sum).toBeCloseTo(TOTALS_EX_VAT["02-02-12"], 1);
  });
});

describe("lsrBillSection: ЛСР 02-02-05/13", () => {
  it("название раздела держит номер как в смете", () => {
    expect(bill("02-02-05/13").section.title.startsWith("ЛСР 02-02-05/13. ")).toBe(true);
  });
});
