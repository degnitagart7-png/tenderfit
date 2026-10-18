import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { correctedRatePointers } from "@/domain/estimate/overheadNormatives";

/*
  Указатели НР/СП сборника 10 «Оборудование связи»: в выгрузке ФСНБ у всех норм стоит пункт 52 (аэродромные системы), по 812/пр
  оборудование связи — пункт 51 по отделам сборника. Заказчик закупки 1118 берёт 51.1 и 51.2, и он прав по тексту приказа.
*/

const text = readFileSync(resolve("data/fsnb/normatives/sources/812-pr-nakladnye-rashody.txt"), "utf8").replace(/\s+/gu, " ");
const norm = (tableCode: string, patch: Record<string, unknown> = {}) => ({
  baseType: "ГЭСНм",
  tableCode,
  overheadRef: "Пр/812-052.0",
  profitRef: "Пр/774-052.0",
  ...patch,
});

describe("пункт 51 и 52 приказа 812/пр в сохранённом тексте", () => {
  it("52 — средства посадки самолётов; 51 — оборудование связи «за исключением пункта 52» с отделами сборника 10", () => {
    expect(text).toContain("52 Устройство средств посадки самолетов и систем управления воздушным движением на аэродромах 96 97 101");
    expect(text).toContain("51 Оборудование связи (за исключением пункта 52): 51.1 прокладка и монтаж сетей связи 90 91 95");
    expect(text).toContain("отделы с 1 по 3, отдел 6 разделы 2, 3");
    expect(text).toContain("51.2 монтаж радиотелевизионного и электронного оборудования 95 96 100");
    expect(text).toContain("отделы 4 и 5");
    expect(text).toContain("51.4 устройство сигнализации, централизации, блокировки и связи на железных дорогах 94 95 99");
  });
});

describe("correctedRatePointers", () => {
  it("10-01-053-01 (кабели станционные, отдел 1) — 51.1 вместо 52; СП тоже", () => {
    expect(correctedRatePointers(norm("10-01-053"))).toEqual({ overheadRef: "Пр/812-051.1", profitRef: "Пр/774-051.1" });
  });

  it("отдел 4 (радиотрансляционные узлы) — 51.2; отдел 7 — 51.4; отдел 9 — 51.1", () => {
    expect(correctedRatePointers(norm("10-04-101")).overheadRef).toBe("Пр/812-051.2");
    expect(correctedRatePointers(norm("10-07-001")).profitRef).toBe("Пр/774-051.4");
    expect(correctedRatePointers(norm("10-09-001")).overheadRef).toBe("Пр/812-051.1");
  });

  it("отдел 6 (разделы по 51.1 и 51.3) и неизвестные отделы остаются с указателем выгрузки", () => {
    expect(correctedRatePointers(norm("10-06-001")).overheadRef).toBe("Пр/812-052.0");
    expect(correctedRatePointers(norm("10-11-001")).overheadRef).toBe("Пр/812-052.0");
  });

  it("другие книги и сборники, а также нормы с иным указателем не трогаются", () => {
    expect(correctedRatePointers(norm("10-01-053", { baseType: "ГЭСН" })).overheadRef).toBe("Пр/812-052.0");
    expect(correctedRatePointers(norm("11-05-001", { overheadRef: "Пр/812-053.0", profitRef: "Пр/774-053.0" })).overheadRef).toBe("Пр/812-053.0");
    expect(correctedRatePointers(norm("12-11-004", { overheadRef: "Пр/812-054.0" })).overheadRef).toBe("Пр/812-054.0");
  });
});
