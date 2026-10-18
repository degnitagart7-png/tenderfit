import { describe, expect, it } from "vitest";

import {
  checkContractAgainstLsr,
  contractBill,
  expandRefs,
  parseContractEstimates,
  parseRefs,
  referencesLsr,
} from "@/domain/estimate/contractEstimate";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { buildLsrSet } from "@/domain/estimate/customerLsrSet";
import { classifyDocument, classifyHeading, LEVEL_RANK } from "@/domain/estimate/volumeSource";
import {
  CONTRACT_ESTIMATE_TEXT,
  CONTRACT_NAME,
  DOCUMENTS_1118,
  NMCK_CONTRACT_ESTIMATE_12_TEXT,
  NMCK_NAME,
} from "@/test/t1118Fixtures";

/** «Смета контракта» по приказу 841/пр: «ЛС 02-02-07 Поз.: 3-3.2» — свод ЛСР, а не ведомость объёмов. */

describe("ссылки «Поз.:»", () => {
  it("список, диапазон и диапазон с подпозициями", () => {
    expect(parseRefs("1, 1.1")).toEqual([{ from: "1", to: "1" }, { from: "1.1", to: "1.1" }]);
    expect(parseRefs("3-3.2")).toEqual([{ from: "3", to: "3.2" }]);
    expect(parseRefs("13–15")).toEqual([{ from: "13", to: "15" }]);
  });

  it("диапазон раскрывается в позиции ЛСР, включая подпозиции; конец-позиция тянет свои подпозиции", () => {
    const labels = ["1", "2", "3", "3.1", "3.2", "4", "5", "5.1"];
    expect(expandRefs(parseRefs("3-3.2"), labels).found.sort()).toEqual(["3", "3.1", "3.2"]);
    expect(expandRefs(parseRefs("4-5"), labels).found.sort()).toEqual(["4", "5", "5.1"]);
    expect(expandRefs(parseRefs("6"), labels)).toEqual({ found: [], missing: ["6"] });
  });

  it("строка со ссылкой узнаётся", () => {
    expect(referencesLsr("3\tЛС 02-02-07 Поз.: 3-3.2\tМонтаж водонагревателей")).toBe(true);
    expect(referencesLsr("3 Монтаж водонагревателей шт 1")).toBe(false);
  });
});

describe("классификация: смета контракта — не ведомость и не ЛСР", () => {
  it("заголовки «Смета контракта», «Проект сметы контракта», «Приложение № 1.1 … Смета контракта»", () => {
    expect(classifyHeading("Смета контракта")).toBe("CONTRACT_ESTIMATE");
    expect(classifyHeading("Проект сметы контракта")).toBe("CONTRACT_ESTIMATE");
    expect(classifyHeading("Приложение №1.1. - Смета контракта (Ремонтные работы)")).toBe("CONTRACT_ESTIMATE");
    // Локальная смета остаётся локальной.
    expect(classifyHeading("Локальный сметный расчёт № 02-02-07")).toBe("CUSTOMER_ESTIMATE");
  });

  it("имя файла — смета контракта; уровень ниже ЛСР и выше ТЗ", () => {
    const cls = classifyDocument("Приложение №3.1 Проект сметы контракта.xlsx", "текст");
    expect(cls.level).toBe("CONTRACT_ESTIMATE");
    expect(LEVEL_RANK.CONTRACT_ESTIMATE).toBeLessThan(LEVEL_RANK.CUSTOMER_ESTIMATE);
    expect(LEVEL_RANK.CONTRACT_ESTIMATE).toBeGreaterThan(LEVEL_RANK.SPEC);
    expect(LEVEL_RANK.BILL).toBeGreaterThan(LEVEL_RANK.CUSTOMER_ESTIMATE);
  });

  it("ЛСР по имени файла по-прежнему смета заказчика", () => {
    expect(classifyDocument("ЛСР 02-02-07.xlsx", "").level).toBe("CUSTOMER_ESTIMATE");
  });
});

describe("parseContractEstimates", () => {
  it("таблица Word (табуляция): строки, ссылки, разделы", () => {
    const { rows } = parseContractEstimates([{ name: CONTRACT_NAME, text: CONTRACT_ESTIMATE_TEXT }]);

    expect(rows).toHaveLength(15);
    const first = rows[0];
    expect(first).toMatchObject({ number: 1, estimateRef: "02-02-08", positionsText: "1-1.2", unit: "шт", quantity: 1 });
    expect(first?.name).toBe("Смена задвижек диаметром: 100 мм. Применительно 80мм");
    expect(first?.section).toContain("Раздел 1");
    expect(first?.total).toBeNull();
  });

  it("лист xlsx (CSV) с ценами: количество, цена и стоимость читаются, копии подписей справа — нет", () => {
    const { rows } = parseContractEstimates([{ name: NMCK_NAME, text: NMCK_CONTRACT_ESTIMATE_12_TEXT }]);

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ estimateRef: "02-02-12", positionsText: "2-2.4", unit: "м", quantity: 15, unitPrice: 2903.55, total: 43553.3 });
  });

  it("то же приложение в двух документах берётся один раз, остаётся копия с ценами", () => {
    const parsed = parseContractEstimates(DOCUMENTS_1118);

    expect(parsed.rows).toHaveLength(15);
    expect(parsed.duplicates).toBe(2);
    expect(parsed.rows.filter((row) => row.estimateRef === "02-02-12").every((row) => row.total !== null)).toBe(true);
  });
});

describe("сверка сметы контракта с ЛСР", () => {
  const set = buildLsrSet(parseCustomerLsr(DOCUMENTS_1118).estimates);
  const { rows } = parseContractEstimates(DOCUMENTS_1118);

  it("все позиции сметы контракта покрыты позициями ЛСР", () => {
    const check = checkContractAgainstLsr(rows, set.entries);

    expect(check.total).toBe(15);
    expect(check.covered).toBe(15);
    expect(check.messages[0]).toBe("Смета контракта: все 15 позиций покрыты позициями ЛСР");
    const three = check.rows.find((entry) => entry.row.estimateRef === "02-02-08" && entry.row.number === 3);
    expect([...(three?.positions ?? [])].sort()).toEqual(["3", "3.1", "3.2", "3.3"]);
  });

  it("ссылка на позицию, которой в ЛСР нет, называется", () => {
    const broken = rows.map((row) => (row.number === 4 && row.estimateRef === "02-02-08" ? { ...row, refs: [{ from: "4", to: "40" }], positionsText: "4-40" } : row));
    const check = checkContractAgainstLsr(broken, set.entries);

    expect(check.covered).toBe(14);
    expect(check.messages.some((message) => message.startsWith("Позиций из ссылки нет в ЛСР") && message.includes("40"))).toBe(true);
  });

  it("ЛСР с таким номером нет — строка не покрыта", () => {
    const orphan = rows.map((row) => ({ ...row, estimateRef: "02-02-99" }));
    const check = checkContractAgainstLsr(orphan, set.entries);

    expect(check.covered).toBe(0);
    expect(check.messages.some((message) => message.startsWith("Нет ЛСР для строк контракта"))).toBe(true);
  });

  it("объём в смете контракта и в ЛСР: «1 шт» против «100 шт» ловится, «8 шт» против «0,08 × 100 шт» — нет", () => {
    const rowsOk = checkContractAgainstLsr(rows, set.entries);
    const four = rowsOk.rows.find((check) => check.row.estimateRef === "02-02-08" && check.row.number === 4);
    expect(four?.volumeNote).toBeNull();

    const wrong = rows.map((row) => (row.estimateRef === "02-02-08" && row.number === 4 ? { ...row, quantity: 800 } : row));
    const checked = checkContractAgainstLsr(wrong, set.entries).rows.find((check) => check.row.number === 4 && check.row.estimateRef === "02-02-08");
    expect(checked?.volumeNote).toContain("800 шт");
  });

  it("позиция ЛСР, которой нет в контракте, называется", () => {
    const fewer = rows.filter((row) => !(row.estimateRef === "02-02-08" && row.number === 13));
    const check = checkContractAgainstLsr(fewer, set.entries);

    expect(check.uncoveredPositions.length).toBeGreaterThan(0);
    expect(check.messages.some((message) => message.includes("в смету контракта не вошли"))).toBe(true);
  });
});

describe("contractBill: смета контракта как источник, когда нет ни ВОР, ни ЛСР", () => {
  it("все строки таблицы в ведомости, уровень CONTRACT_ESTIMATE; нет «27 из 53»", () => {
    const parsed = parseContractEstimates([{ name: CONTRACT_NAME, text: CONTRACT_ESTIMATE_TEXT }]);
    const { sections, rejected } = contractBill(parsed.rows);

    const items = sections.flatMap((section) => section.items);
    expect(items).toHaveLength(15);
    expect(rejected).toEqual([]);
    expect(items.every((item) => item.sourceLevel === "CONTRACT_ESTIMATE")).toBe(true);
    expect(items[0]).toMatchObject({ workName: "Смена задвижек диаметром: 100 мм. Применительно 80мм", quantity: 1, quantityUnit: "шт" });
  });

  it("цена контракта, если она в строке есть, остаётся запасной", () => {
    const parsed = parseContractEstimates([{ name: NMCK_NAME, text: NMCK_CONTRACT_ESTIMATE_12_TEXT }]);
    const items = contractBill(parsed.rows).sections.flatMap((section) => section.items);

    expect(items[1]?.customerPrice?.total).toBe(43_553.3);
    expect(items[1]?.customerPrice?.origin).toBe("LINE");
  });
});
