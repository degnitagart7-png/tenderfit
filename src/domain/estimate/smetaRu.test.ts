import { describe, expect, it } from "vitest";

import { detectCustomerMethod } from "@/domain/estimate/bimMethod";
import { methodOf, parseCustomerEstimates } from "@/domain/estimate/customerEstimate";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { detectSmetaRu, isSmetaRuServiceSheet, isSmetaRuText, methodOfHeader, normBaseOf } from "@/domain/estimate/smetaRu";
import {
  BASE_INDEX_PDF_NAME,
  BASE_INDEX_PDF_TEXT,
  RIM_DEMOLITION_NAME,
  RIM_DEMOLITION_TEXT,
  RIM_SUPPLY_NAME,
  RIM_SUPPLY_TEXT,
  TSN_2001_NAME,
  TSN_2001_TEXT,
} from "@/test/smetaRuFixtures";

/*
  Smeta.RU: программа, метод и база называются в шапке. Приказ 421/пр в перечне редакций нормативов печатают и ресурсно-индексная,
  и базисно-индексная смета, поэтому метод определяется по фразе «Составлен … методом», а не по «421/пр».
*/

describe("detectSmetaRu: признаки программы", () => {
  it("строка «Smeta.RU (495) 974-1589» и «Программа: «Smeta.RU» версия 12» — выгрузка", () => {
    expect(isSmetaRuText(RIM_DEMOLITION_TEXT)).toBe(true);
    expect(detectSmetaRu(RIM_DEMOLITION_TEXT)).toEqual({ program: "SMETA_RU", version: 12, method: "RESOURCE_INDEX", base: null });
    expect(detectSmetaRu(RIM_SUPPLY_TEXT)).toMatchObject({ program: "SMETA_RU", method: "RESOURCE_INDEX" });
  });

  it("упоминание программы в тексте договора — не выгрузка", () => {
    const contract = "Сметная документация представляется в электронном виде (программа Smeta.ru в формате смет АРПС 1.10.).";
    expect(isSmetaRuText(contract)).toBe(false);
    expect(detectSmetaRu(contract)).toBeNull();
    expect(detectSmetaRu("Локальный сметный расчет\nГранд-Смета 2025\nСоставлен ресурсно-индексным методом")).toBeNull();
  });

  it("строка программы глубоко в документе (после шапки) шапкой не считается", () => {
    expect(isSmetaRuText(`${"x".repeat(9_000)}\nSmeta.RU  (495) 974-1589`)).toBe(false);
  });

  it("служебные листы программы опознаются по имени", () => {
    for (const name of ["Source", "SourceObSm", "SmtRes", "EtalonRes", "SrcPoprs", "SrcKA", "source"]) expect(isSmetaRuServiceSheet(name), name).toBe(true);
    expect(isSmetaRuServiceSheet("Смета по ФСНБ 421+557прРИМ")).toBe(false);
    expect(isSmetaRuServiceSheet(null)).toBe(false);
  });
});

describe("метод и база: базисно-индексная Smeta.RU не принимается за ресурсно-индексную", () => {
  it("PDF закупки 0373100037626000119: «Составлен Базисно-индексным методом», приказ 421/пр в перечне — метод базисно-индексный", () => {
    expect(BASE_INDEX_PDF_TEXT).toContain("421/пр");
    expect(methodOfHeader(BASE_INDEX_PDF_TEXT)).toBe("BASE_INDEX");
    expect(detectSmetaRu(BASE_INDEX_PDF_TEXT)).toEqual({ program: "SMETA_RU", version: 12, method: "BASE_INDEX", base: null });
    // По одному «421/пр» отрезок был бы ресурсным (RESOURCE_2022): метод шапки главнее.
    expect(methodOf(BASE_INDEX_PDF_TEXT)).toBe("BASE_2001");
    expect(detectCustomerMethod([{ name: BASE_INDEX_PDF_NAME, text: BASE_INDEX_PDF_TEXT }])).toMatchObject({ method: "BASE_INDEX" });
  });

  it("без фразы метода «421/пр» по-прежнему даёт ресурсный метод, а ресурсная смета Smeta.RU остаётся ресурсной", () => {
    expect(methodOf("Приказ Минстроя России от 04.08.2020 г. № 421/пр, в текущем уровне цен")).toBe("RESOURCE_2022");
    const [estimate] = parseCustomerEstimates([{ name: RIM_SUPPLY_NAME, text: RIM_SUPPLY_TEXT }]);
    expect(estimate?.method).toBe("RESOURCE_2022");
    expect(detectCustomerMethod([{ name: RIM_SUPPLY_NAME, text: RIM_SUPPLY_TEXT }], [], { rimLsrCount: 1 })).toMatchObject({ method: "RESOURCE_INDEX" });
  });

  it("явная фраза шапки читается и в CSV («Составлен,,Ресурсно-индексным,методом»), и в тексте PDF", () => {
    expect(methodOfHeader("Составлен,,,,Ресурсно-индексным,методом,,")).toBe("RESOURCE_INDEX");
    expect(methodOfHeader("Составлен | Базисно-индексным | методом")).toBe("BASE_INDEX");
    expect(methodOfHeader("Составлен   базисно - индексным   методом")).toBe("BASE_INDEX");
    expect(methodOfHeader("расценки ТСН")).toBeNull();
  });

  it("ТСН-2001 Москвы: база названа, метод не называется (шапка формы 4б его не печатает), смета не ресурсная", () => {
    expect(detectSmetaRu(TSN_2001_TEXT)).toMatchObject({ program: "SMETA_RU", method: null, base: "TSN_2001_MOSCOW" });
    expect(normBaseOf("Составлен(а) по ТСН-2001 с учетом Дополнения №: 81")).toBe("TSN_2001_MOSCOW");
    expect(normBaseOf("Смета по ТСН-2001.16, Санкт-Петербург")).toBeNull();
    expect(normBaseOf("ТСН-2001 Московской области")).toBeNull();
    expect(normBaseOf("Составлен(а) в текущем уровне цен")).toBeNull();
    expect(methodOf("Составлен(а) по ТСН-2001, 421/пр, в текущем уровне цен")).toBe("BASE_2001");
  });

  it("ТСН из Smeta.RU разбирается построчно, а не как «не форма 421/пр»", () => {
    const parsed = parseCustomerLsr([{ name: TSN_2001_NAME, text: TSN_2001_TEXT }]);
    expect(parsed.estimates).toHaveLength(2);
    expect(parsed.notRecognized).toEqual([]);
    expect(parsed.estimates.every((estimate) => estimate.base === "TSN_2001_MOSCOW" && estimate.program === "SMETA_RU")).toBe(true);
  });

  it("PDF-текст базисно-индексной сметы построчно не читается (нет строки нумерации граф), и это не ошибка", () => {
    const parsed = parseCustomerLsr([{ name: BASE_INDEX_PDF_NAME, text: BASE_INDEX_PDF_TEXT }]);
    expect(parsed.estimates).toEqual([]);
  });

  it("ресурсная смета Smeta.RU и смета с базисным уровнем в одном документе не путаются: у каждого отрезка свой метод", () => {
    const parsed = parseCustomerLsr([
      { name: RIM_DEMOLITION_NAME, text: RIM_DEMOLITION_TEXT },
      { name: TSN_2001_NAME, text: TSN_2001_TEXT },
    ]);
    expect(parsed.estimates.map((estimate) => [estimate.method ?? null, estimate.base ?? null])).toEqual([
      ["RESOURCE_INDEX", null],
      [null, "TSN_2001_MOSCOW"],
      [null, "TSN_2001_MOSCOW"],
    ]);
  });
});
