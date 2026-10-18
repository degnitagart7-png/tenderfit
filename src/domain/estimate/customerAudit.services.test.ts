import { describe, expect, it } from "vitest";

import { servicesFromRecords, type LoadPrice, type TransportSeries } from "@/domain/estimate/autoServices";
import { auditCustomerLsr, OUR_PRICE_SOURCE_LABEL, type AuditReport } from "@/domain/estimate/customerAudit";
import { parseCustomerLsr, type CustomerLsr } from "@/domain/estimate/customerLsr";
import { lsrHead, lsrRow, lsrTotals, money } from "@/domain/estimate/customerLsr.builders";
import { makeBook } from "@/test/auditPriceBook";

/*
  Аудит сметы заказчика: строки перевозки и погрузки (шифры «02-15-1-01-0047», «49-1») сверяются с
  нашими сметными ценами услуг ФГИС ЦС, а не уходят в «цена заказчика, не с чем сравнить».
  Строки — из сметы закупки 0134600012126000001: 505,94 т, перевозка 619,94 ₽/т, погрузка 94,64 ₽/т.
*/

const TRANSPORT_NAME =
  "Перевозка грузов I класса автомобилями-самосвалами грузоподъемностью до 15 т по дорогам с усовершенствованным дорожным покрытием на расстояние 47 км";
const LOAD_NAME = "Погрузка в автотранспортное средство: мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3";

const LOADING_SUM = Math.round(505.94 * 94.64 * 100) / 100;
const TRANSPORT_SUM = Math.round(505.94 * 619.94 * 100) / 100;

function position(n: number, code: string, name: string, price: number, sum: number): string[] {
  return [
    lsrRow({ 1: String(n), 2: code, 3: name, 4: "1т груза", 5: "505.94", 6: "1", 7: "505.94", 10: money(price), 12: money(sum) }),
    lsrRow({ 3: "Всего по позиции", 12: money(sum) }),
  ];
}

function smeta(total = LOADING_SUM + TRANSPORT_SUM): string {
  return [
    ...lsrHead({ name: "Снос (вырезка: перевозка и погрузка)" }),
    "Раздел 1. Прочие работы",
    ...position(6, "49-1", LOAD_NAME, 94.64, LOADING_SUM),
    ...position(7, "02-15-1-01-0047", TRANSPORT_NAME, 619.94, TRANSPORT_SUM),
    ...lsrTotals({ sectionTotal: total, total }),
  ].join("\n");
}

function parse(text: string): CustomerLsr {
  const { estimates } = parseCustomerLsr([{ name: "смета.xlsx", text }]);
  expect(estimates).toHaveLength(1);
  return estimates[0] as CustomerLsr;
}

function transport(price: number, max = 100): TransportSeries {
  return {
    prefix: "02-15-1-01",
    vehicle: "02",
    capacity: 15,
    capacityUnit: "т",
    cls: 1,
    road: "01",
    vehicleName: "Автомобили-самосвалы",
    roadName: null,
    prices: Array.from({ length: max }, (_, index) => (index + 1 === 47 ? price : null)),
  };
}
const LOADS = (price: number): LoadPrice[] => [
  { code: "49-1", group: 49, groupName: "Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3", operation: "LOAD", price },
];

const OURS = servicesFromRecords([transport(619.94)], LOADS(94.64));
const lsr = parse(smeta());

function audit(services: Parameters<typeof auditCustomerLsr>[1]["services"]): AuditReport {
  return auditCustomerLsr(lsr, { priceBook: makeBook(), services });
}

describe("аудит: перевозка и погрузка против сметных цен ФГИС ЦС", () => {
  it("смета заказчика разобрана: две позиции с шифрами услуг, цена и сумма в строке позиции", () => {
    expect(lsr.positions.map((item) => item.code)).toEqual(["49-1", "02-15-1-01-0047"]);
    expect(lsr.positions[1]).toMatchObject({ ownUnitPrice: 619.94, ownTotal: TRANSPORT_SUM, quantity: 505.94 });
  });

  it("цены совпали с нашими: строки проверены (покрытие 100 %), в «не проверено» и CUSTOMER_PRICE их нет, разницы нет", () => {
    const report = audit(OURS);

    expect(report.unchecked).toEqual([]);
    expect(report.findings.filter((finding) => finding.type === "CUSTOMER_PRICE_NO_COMPARE")).toEqual([]);
    expect(report.coverage).toBe(1);
    expect(report.checkedDirect).toBeCloseTo(LOADING_SUM + TRANSPORT_SUM, 2);
    expect(Math.abs(report.diff)).toBeLessThan(0.5);
    expect(report.verdict).toBe("MATCH");
  });

  it("наша цена перевозки выше: находка RESOURCE_PRICE с источником «сметная цена услуги ФГИС ЦС», без пометки «по КП»", () => {
    const report = audit(servicesFromRecords([transport(700)], LOADS(94.64)));
    const finding = report.findings.find((entry) => entry.type === "RESOURCE_PRICE");

    expect(finding).toMatchObject({ subject: "02-15-1-01-0047", customerValue: 619.94, ourValue: 700, quantity: 505.94, ourSource: "SERVICE" });
    expect(finding?.impact).toBeCloseTo((700 - 619.94) * 505.94, 2);
    expect(finding?.message).toContain(OUR_PRICE_SOURCE_LABEL.SERVICE);
    expect(finding?.message).not.toContain("по КП");
    expect(report.verdict).toBe("UNDERSTATED");
    expect(report.impacts.MATERIALS.amount).toBeGreaterThan(0);
  });

  it("зона собрана без таблиц перевозки (null) — как раньше: цена заказчика, не проверено", () => {
    const report = audit(null);

    expect(report.unchecked.map((item) => item.kind)).toEqual(["CUSTOMER_PRICE", "CUSTOMER_PRICE"]);
    expect(report.coverage).toBe(0);
    expect(report.findings.filter((finding) => finding.type === "CUSTOMER_PRICE_NO_COMPARE")).toHaveLength(2);
  });

  it("километр за пределом таблицы — нашей цены нет, строка остаётся непроверенной", () => {
    const report = audit(servicesFromRecords([transport(619.94, 40)], LOADS(94.64)));

    expect(report.unchecked.map((item) => item.code)).toEqual(["02-15-1-01-0047"]);
    expect(report.checkedDirect).toBeCloseTo(LOADING_SUM, 2);
  });
});
