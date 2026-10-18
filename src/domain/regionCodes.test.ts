import { describe, expect, it } from "vitest";

import {
  canonicalRegionName,
  canonicalRegionNames,
  isSameRegion,
  kladrId,
  regionByCode,
  regionCodeOf,
  regionMatcher,
  REGIONS,
} from "@/domain/regionCodes";

/**
 * Регионы России и их коды.
 *
 * ЕИС умеет сужать выдачу по региону заказчика (проверено 05.10.2026: запрос
 * «строительство» с кодом 03 дал 365 закупок, из показанных 44 бурятских 42,
 * а без кода — ни одной). Параметр принимает код региона по КЛАДР
 * («03000000000»), а человек вводит название как придётся: «Бурятия»,
 * «Республика Бурятия», «респ. Бурятия».
 */

describe("regionCodeOf", () => {
  it.each([
    ["Республика Бурятия", "03"],
    ["Бурятия", "03"],
    ["респ. бурятия", "03"],
    ["  РЕСПУБЛИКА   БУРЯТИЯ ", "03"],
    ["Москва", "77"],
    ["город Москва", "77"],
    ["Московская область", "50"],
    ["Московская обл.", "50"],
    ["Санкт-Петербург", "78"],
    ["Ленинградская область", "47"],
    ["Свердловская область", "66"],
    ["Ханты-Мансийский автономный округ — Югра", "86"],
    ["ХМАО", "86"],
    ["Республика Крым", "91"],
    ["Чувашская Республика", "21"],
    ["Республика Саха (Якутия)", "14"],
    ["Якутия", "14"],
    ["Забайкальский край", "75"],
    ["Красноярский край", "24"],
  ])("«%s» → %s", (name, code) => {
    expect(regionCodeOf(name)?.code).toBe(code);
  });

  it("Москва и Московская область — разные регионы", () => {
    expect(regionCodeOf("Москва")?.code).not.toBe(regionCodeOf("Московская область")?.code);
  });

  it("Тюменская область и её округа не путаются", () => {
    expect(regionCodeOf("Тюменская область")?.code).toBe("72");
    expect(regionCodeOf("Ямало-Ненецкий автономный округ")?.code).toBe("89");
  });

  it("не регион — null: молча искать по чужому коду нельзя", () => {
    expect(regionCodeOf("")).toBeNull();
    expect(regionCodeOf("Нарния")).toBeNull();
    expect(regionCodeOf("вся Россия")).toBeNull();
  });

  it("возвращает каноническое название региона", () => {
    expect(regionCodeOf("Бурятия")?.name).toBe("Республика Бурятия");
  });
});

describe("kladrId", () => {
  it("код региона дополняется нулями до формата КЛАДР", () => {
    expect(kladrId("03")).toBe("03000000000");
    expect(kladrId("77")).toBe("77000000000");
  });
});

describe("regionByCode", () => {
  it("находит регион по коду", () => {
    expect(regionByCode("03")?.name).toBe("Республика Бурятия");
    expect(regionByCode("00")).toBeNull();
  });
});

describe("таблица", () => {
  it("коды уникальны, названия уникальны", () => {
    expect(new Set(REGIONS.map((r) => r.code)).size).toBe(REGIONS.length);
    expect(new Set(REGIONS.map((r) => r.name)).size).toBe(REGIONS.length);
  });

  it("каждый код — две цифры", () => {
    expect(REGIONS.every((r) => /^\d{2}$/.test(r.code))).toBe(true);
  });
});

describe("сравнение регионов", () => {
  it("короткое и полное название — один регион", () => {
    expect(isSameRegion("Калмыкия", "Республика Калмыкия")).toBe(true);
    expect(isSameRegion("Бурятия", "Республика Бурятия")).toBe(true);
  });

  it("тире, съеденное чисткой запроса, не мешает", () => {
    expect(isSameRegion("Кемеровская область Кузбасс", "Кемеровская область — Кузбасс")).toBe(true);
  });

  it("похожие регионы не путаются", () => {
    expect(isSameRegion("Москва", "Московская область")).toBe(false);
    expect(isSameRegion("Республика Алтай", "Алтайский край")).toBe(false);
  });

  it("неизвестный регион ни с чем не совпадает", () => {
    expect(isSameRegion("Республика Калмыкия", "Не указан")).toBe(false);
    expect(isSameRegion("", "Республика Калмыкия")).toBe(false);
  });

  it("regionMatcher проверяет по списку", () => {
    const match = regionMatcher(["Калмыкия", "Забайкальский край"]);
    expect(match("Республика Калмыкия")).toBe(true);
    expect(match("Забайкальский край")).toBe(true);
    expect(match("Республика Бурятия")).toBe(false);
  });
});

describe("каноническое название", () => {
  it("приводит набранное человеком к названию из справочника", () => {
    expect(canonicalRegionName("Калмыкия")).toBe("Республика Калмыкия");
    expect(canonicalRegionName("якутия")).toBe("Республика Саха (Якутия)");
  });

  it("неопознанное оставляет как есть", () => {
    expect(canonicalRegionName(" Атлантида ")).toBe("Атлантида");
  });

  it("список без пустых и повторов", () => {
    expect(canonicalRegionNames(["Калмыкия", "Республика Калмыкия", " "])).toEqual(["Республика Калмыкия"]);
  });
});
