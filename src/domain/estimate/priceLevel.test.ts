import { describe, expect, it } from "vitest";

import {
  declaredPriceLevel,
  priceLevelMismatch,
  quarterIn,
  zoneNumberIn,
} from "@/domain/estimate/priceLevel";

/**
 * Уровень цен, объявленный самим документом.
 *
 * Зачем это читать. Расчёт берёт зону и квартал из собранного индекса — другой
 * у него нет, — и до сих пор делал это молча. На смете 02-01-02-КМ1 индекс нёс
 * «Амурская область (1 зона), 3 квартал 2026», а сметчик считал по 2 зоне за
 * 1 квартал 2026. Обе сметы внутренне верны, сравнивать их бессмысленно:
 * расходятся цены каждого ресурса. В шапке выгруженной книги это было
 * написано честно, но написано после того, как расчёт уже прошёл.
 *
 * Цена вопроса — не проценты. Между ценовыми зонами одного субъекта разница
 * идёт на десятки процентов, между кварталами — на индекс инфляции. Смета,
 * посчитанная не в том уровне, выглядит как посчитанная.
 */
describe("zoneNumberIn", () => {
  it("читает номер зоны из шапки сметы", () => {
    expect(zoneNumberIn("Амурская область (2 зона)")).toBe(2);
  });

  it("читает номер без скобок", () => {
    expect(zoneNumberIn("Ценовая зона: Амурская область, 2 зона")).toBe(2);
  });

  it("зона, записанная словом, тоже считается", () => {
    expect(zoneNumberIn("Амурская область (1-я зона)")).toBe(1);
  });

  it("зоны в тексте нет", () => {
    expect(zoneNumberIn("Локальный сметный расчёт на конструкции металлические")).toBeNull();
  });

  it("слово «зона» без номера ничего не значит", () => {
    expect(zoneNumberIn("зона производства работ ограждается")).toBeNull();
  });
});

describe("quarterIn", () => {
  it("арабская запись квартала", () => {
    expect(quarterIn("цены на 1 квартал 2026 года")).toEqual({ quarter: 1, year: 2026 });
  });

  it("римская запись квартала", () => {
    expect(quarterIn("III квартал 2026 г.")).toEqual({ quarter: 3, year: 2026 });
  });

  it("сокращение «кв.»", () => {
    expect(quarterIn("4 кв. 2025")).toEqual({ quarter: 4, year: 2025 });
  });

  it("квартала в тексте нет", () => {
    expect(quarterIn("уровень цен 01.01.2022")).toBeNull();
  });

  it("пятого квартала не бывает", () => {
    expect(quarterIn("5 квартал 2026")).toBeNull();
  });
});

describe("declaredPriceLevel", () => {
  it("берёт зону и квартал из шапки", () => {
    const level = declaredPriceLevel(
      "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЁТ № 02-01-02-КМ1\n" +
        "Амурская область (2 зона), цены на 1 квартал 2026 года",
    );

    expect(level).toEqual({ zone: 2, quarter: 1, year: 2026 });
  });

  it("документ молчит об уровне цен", () => {
    expect(declaredPriceLevel("Ведомость объёмов работ")).toEqual({
      zone: null,
      quarter: null,
      year: null,
    });
  });
});

describe("priceLevelMismatch", () => {
  const INDEX = { priceZone: "Амурская область (1 зона)", period: "3 квартал 2026 г." };

  it("зона документа другая — расчёт так считать не должен", () => {
    const message = priceLevelMismatch(
      "Амурская область (2 зона), цены на 3 квартал 2026 года",
      INDEX,
    );

    expect(message).toContain("2 зона");
    expect(message).toContain("Амурская область (1 зона)");
  });

  it("квартал документа другой — тоже расхождение", () => {
    const message = priceLevelMismatch(
      "Амурская область (1 зона), цены на 1 квартал 2026 года",
      INDEX,
    );

    expect(message).toContain("1 квартал 2026");
    expect(message).toContain("3 квартал 2026");
  });

  it("уровень совпал — считать можно", () => {
    expect(
      priceLevelMismatch("Амурская область (1 зона), III квартал 2026 г.", INDEX),
    ).toBeNull();
  });

  it("документ об уровне цен молчит — это не расхождение", () => {
    expect(priceLevelMismatch("Ведомость объёмов работ", INDEX)).toBeNull();
  });

  it("год другой при том же квартале — расхождение", () => {
    const message = priceLevelMismatch("Амурская область (1 зона), 3 квартал 2025", INDEX);

    expect(message).toContain("2025");
  });
});
