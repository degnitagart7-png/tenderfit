import { describe, expect, it } from "vitest";

import { chapterAmount, parseCustomerSsr, periodFromText } from "@/domain/estimate/customerSsr";
import { NOT_SSR, SSR_377_COMMA_CSV, SSR_377_CSV, SSR_377_FLAT, SSR_BAD, SSR_THOUSANDS } from "@/domain/estimate/customerSsr.fixtures";

/*
  Фикстуры СКОНСТРУИРОВАНЫ по форме приложения 6 к 421/пр и цифрам закупки 377 (реального текста ССРСС в репозитории нет;
  подробно — в customerSsr.fixtures.ts). Проверяется разбор: главы, итоги, резерв, индекс, НДС, всего.
*/

const parse = (text: string, name = "НМЦК_Возрождения 46 - ССРСС.xlsx") => parseCustomerSsr([{ name, text }]);

describe("разбор ССР заказчика: лист xlsx (CSV, ';')", () => {
  const [ssr] = parse(SSR_377_CSV);

  it("найден один расчёт, единица — рубли, лист назван", () => {
    expect(parse(SSR_377_CSV)).toHaveLength(1);
    expect(ssr?.unitMultiplier).toBe(1);
    expect(ssr?.estimateName).toBe("ССРСС");
  });

  it("главы с итогами и строками: глава 2 — 1 623 390, глава 9 — 2 330 (графа «всего» — последнее число)", () => {
    expect(ssr?.chapters.map((chapter) => chapter.number)).toEqual([1, 2, 8, 9]);
    expect(chapterAmount(ssr!, 2)).toBe(1_623_390);
    expect(chapterAmount(ssr!, 9)).toBe(2_330);
    expect(ssr?.chapters.find((chapter) => chapter.number === 2)?.title).toBe("Основные объекты строительства");
    expect(ssr?.chapters.find((chapter) => chapter.number === 2)?.lines).toHaveLength(1);
    expect(ssr?.chapters.find((chapter) => chapter.number === 2)?.lines[0]?.name).toContain("Ремонт теплоизоляции фасада");
    expect(chapterAmount(ssr!, 8)).toBeNull();
  });

  it("итоги по главам 1-7, 1-8, 1-9, 1-12", () => {
    expect(ssr?.groups.map((group) => [group.id, group.stated])).toEqual([
      ["1-7", 1_623_390],
      ["1-8", 1_623_390],
      ["1-9", 1_625_720],
      ["1-12", 1_625_720],
    ]);
  });

  it("непредвиденные 2 % и 32 514,40; итог с ними 1 658 234,40", () => {
    expect(ssr?.reserve).toMatchObject({ percent: 2, amount: 32_514.4 });
    expect(ssr?.reserve?.quote).toContain("непроизводственного назначения - 2%");
    expect(ssr?.afterReserve?.amount).toBe(1_658_234.4);
  });

  it("индекс прогнозной инфляции И = 1,0045, период октябрь-ноябрь 2026, сумма 7 462,05", () => {
    expect(ssr?.inflation).toMatchObject({ index: 1.0045, amount: 7_462.05, periodText: "октябрь-ноябрь 2026", period: { start: "2026-10", end: "2026-11" } });
  });

  it("НДС 22 % — 366 453,22; всего по расчёту — 2 032 149,67", () => {
    expect(ssr?.vat).toMatchObject({ percent: 22, amount: 366_453.22 });
    expect(ssr?.total).toMatchObject({ amount: 2_032_149.67, withVat: null });
  });
});

describe("тот же расчёт плоским текстом (PDF, doc): суммы с пробелами и запятой", () => {
  it("значения те же, что из CSV", () => {
    const [flat] = parse(SSR_377_FLAT, "ССРСС.pdf");
    const [csv] = parse(SSR_377_CSV);
    expect(flat?.chapters.map((chapter) => [chapter.number, chapter.stated])).toEqual([[1, 0], [2, 1_623_390], [9, 2_330]]);
    expect(flat?.groups.map((group) => group.stated)).toEqual([1_623_390, 1_625_720, 1_625_720]);
    expect(flat?.reserve).toMatchObject({ percent: 2, amount: 32_514.4 });
    expect(flat?.inflation).toMatchObject({ index: csv?.inflation?.index, amount: 7_462.05, period: { start: "2026-10", end: "2026-11" } });
    expect(flat?.vat).toMatchObject({ percent: 22, amount: 366_453.22 });
    expect(flat?.total?.amount).toBe(2_032_149.67);
  });
});

describe("лист xlsx в формате разбора вложений: «,»-CSV, числа с разрядами в кавычках", () => {
  it("значения те же: «1,623,390.00» — 1 623 390; «И=1,0045» внутри кавычек — индекс, а не два числа", () => {
    const [ssr] = parse(SSR_377_COMMA_CSV, "ССРСС.xls");
    expect(ssr?.chapters.map((chapter) => [chapter.number, chapter.stated, chapter.lines.length])).toEqual([[2, 1_623_390, 1]]);
    expect(ssr?.groups.map((group) => [group.id, group.stated])).toEqual([["1-12", 1_623_390]]);
    expect(ssr?.reserve).toMatchObject({ percent: 2, amount: 32_467.8 });
    expect(ssr?.afterReserve?.amount).toBe(1_655_857.8);
    expect(ssr?.inflation).toMatchObject({ index: 1.0045, amount: 7_451.36, period: { start: "2026-10", end: "2026-11" } });
    expect(ssr?.vat).toMatchObject({ percent: 22, amount: 365_928.02 });
    expect(ssr?.total?.amount).toBe(2_029_237.18);
  });
});

describe("единицы и ошибочные расчёты", () => {
  it("«тыс. руб.» в шапке — суммы умножаются на 1000", () => {
    const [ssr] = parse(SSR_THOUSANDS, "ССР.xlsx");
    expect(ssr?.unitMultiplier).toBe(1000);
    expect(chapterAmount(ssr!, 2)).toBe(12_000_000);
    expect(ssr?.reserve?.amount).toBe(240_000);
    expect(ssr?.total?.amount).toBe(14_932_800);
    expect(ssr?.inflation).toBeNull();
  });

  it("ошибочный ССР читается как есть: резерв 3 %, индекс 1,09, НДС 20 %, глава 10", () => {
    const [ssr] = parse(SSR_BAD);
    expect(ssr?.reserve).toMatchObject({ percent: 3, amount: 36_300 });
    expect(ssr?.inflation).toMatchObject({ index: 1.09, amount: 124_767 });
    expect(ssr?.vat).toMatchObject({ percent: 20, amount: 302_213.4 });
    expect(chapterAmount(ssr!, 10)).toBe(50_000);
    const chapter2 = ssr?.chapters.find((chapter) => chapter.number === 2);
    expect(chapter2?.stated).toBe(1_010_000);
    expect(chapter2?.linesTotal).toBe(1_000_000);
  });
});

describe("строки-расшифровки не входят в сумму строк главы", () => {
  it("«в том числе …» и «справочно …» под позицией не складываются с ней", () => {
    const text = SSR_377_CSV.replace(
      "1;ЛС 02-01-01;Ремонт теплоизоляции фасада;1623390;0;0;0;1623390",
      "1;ЛС 02-01-01;Ремонт теплоизоляции фасада;1623390;0;0;0;1623390\n;;в том числе возвратные суммы;100000;0;0;0;100000\n;;Справочно: материалы заказчика;50000;0;0;0;50000",
    );
    const chapter = parse(text)[0]?.chapters.find((item) => item.number === 2);
    expect(chapter?.lines).toHaveLength(1);
    expect(chapter?.linesTotal).toBe(1_623_390);
  });
});

describe("что не является ССР", () => {
  it("локальная смета с «Итого по разделу» — не ССР", () => {
    expect(parse(NOT_SSR, "ЛСР.xlsx")).toEqual([]);
  });

  it("пустой документ и документ без глав", () => {
    expect(parse("")).toEqual([]);
    expect(parse("Обоснование НМЦК: проектно-сметный метод, сводный сметный расчет утверждён")).toEqual([]);
  });

  it("один ССР в двух документах (xlsx и pdf) считается один раз", () => {
    const both = parseCustomerSsr([
      { name: "ССРСС.xlsx", text: SSR_377_CSV },
      { name: "ССРСС.pdf", text: SSR_377_CSV.replace("=== ССРСС ===\n", "") },
    ]);
    expect(both).toHaveLength(1);
  });

  it("два разных листа в одном документе — два расчёта", () => {
    const two = parseCustomerSsr([{ name: "ССРСС.xlsx", text: `${SSR_377_CSV}\n${SSR_THOUSANDS}` }]);
    expect(two).toHaveLength(2);
  });
});

describe("срок работ в строке индекса", () => {
  it("«октябрь-ноябрь 2026 г»", () => {
    expect(periodFromText("Индекс на период производства работ (октябрь-ноябрь 2026 г) И=1,0045")?.period).toEqual({ start: "2026-10", end: "2026-11" });
  });

  it("«с октября 2026 по ноябрь 2027» — через границу года", () => {
    expect(periodFromText("Индекс инфляции с октября 2026 по ноябрь 2027, И=1,08")?.period).toEqual({ start: "2026-10", end: "2027-11" });
  });

  it("один месяц и отсутствие срока", () => {
    expect(periodFromText("Индекс на ноябрь 2026 г")?.period).toEqual({ start: "2026-11", end: "2026-11" });
    expect(periodFromText("Индекс прогнозной инфляции И=1,0045")).toBeNull();
  });
});
