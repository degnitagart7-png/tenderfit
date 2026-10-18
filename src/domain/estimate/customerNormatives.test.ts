import { describe, expect, it } from "vitest";

import { checkCustomerCoefficients, checkCustomerLimitedCosts, coefficientValues } from "@/domain/estimate/customerNormatives";

/*
  Сверка начислений заказчика с таблицами приказов: коэффициенты условий работ (421/пр, приложение 10),
  зимнее (325/пр) и временные здания (332/пр). Это справка со ссылкой на пункт, не пересчёт.
*/

describe("коэффициенты заказчика и приложение 10", () => {
  it("числа-коэффициенты из текста обоснования", () => {
    expect(coefficientValues("ОЗП=1,15; ЭМ=1,25; ЗПМ=1,25")).toEqual([1.15, 1.25]);
    expect(coefficientValues("Стеснённые условия")).toEqual([]);
  });

  it("«заказчик взял 1,15» — это пункты приложения 10 и п. 58; допустимо при условии, названном в проекте", () => {
    const text = checkCustomerCoefficients("ОЗП=1,15", "GESN");
    expect(text).toContain("По приложению 10 к 421/пр");
    expect(text).toContain("1,15 — приложение 10 к 421/пр, таблица 5, п. 3; 9.1");
    expect(text).toContain("допустимо, если условие названо в проекте");
    expect(text).toContain("п. 58 Методики");
  });

  it("1,5 для ГЭСН — таблица 5, п. 8 (жилые помещения без расселения)", () => {
    expect(checkCustomerCoefficients("К=1,5", "GESN")).toContain("таблица 5, п. 8");
  });

  it("сумма двух условий по п. 52: 1,40 = 1,20 + 1,20 (таблица 5, п. 1.1 и п. 4)", () => {
    expect(checkCustomerCoefficients("ОЗП=1,4", "GESN")).toContain("сумма двух условий по п. 52");
  });

  it("значения, которого в таблицах нет, прямо названо: основание проверьте по проекту", () => {
    expect(checkCustomerCoefficients("ОЗП=1,77", "GESN")).toContain("такого значения в приложении 10 нет");
  });

  it("книга без колонки (ГЭСНмр, ФЕР) — справки нет", () => {
    expect(checkCustomerCoefficients("ОЗП=1,15", "GESNMR")).toBe("");
    expect(checkCustomerCoefficients("ОЗП=1,15", "OTHER_BASE")).toBe("");
  });
});

describe("зимнее и временные здания заказчика", () => {
  const base = 10_000_000;

  it("«временные 3 % при нормативе 0,9 % для капремонта жилого дома» — завышено, с суммой", () => {
    const found = checkCustomerLimitedCosts({
      winter: null,
      temporary: { percent: 3, quote: "Временные здания и сооружения 3 %" },
      text: "Капитальный ремонт многоквартирного дома по ул. Мира",
      base,
      subject: null,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("завышено на 2,1 п.п.");
    expect(found[0]?.message).toContain("332/пр, приложение 2, п. 1.1");
    expect(found[0]?.amount).toBe(210000);
  });

  it("совпадение с нормативом (кровля 0,4 %) — справка «совпадает»", () => {
    const found = checkCustomerLimitedCosts({
      winter: null,
      temporary: { percent: 0.4, quote: "Временные здания и сооружения 0,4 %" },
      text: "Капитальный ремонт кровли здания",
      base,
      subject: null,
    });
    expect(found[0]?.message).toContain("совпадает с нормативом");
  });

  it("снос: норматива в процентах нет (п. 29) — заказчик начислил, проверьте расчёт", () => {
    const found = checkCustomerLimitedCosts({
      winter: null,
      temporary: { percent: 2, quote: "Временные здания и сооружения 2 %" },
      text: "Снос (демонтаж) объекта капитального строительства",
      base,
      subject: null,
    });
    expect(found[0]?.message).toContain("при сносе норматива в процентах нет");
    expect(found[0]?.message).toContain("п. 29");
  });

  it("зимнее при сносе в Иркутской области: норматив 6,77 % (п. 88, V зона); заказчик 3 % — меньше", () => {
    const found = checkCustomerLimitedCosts({
      winter: { percent: 3, quote: "Зимнее удорожание 3 %" },
      temporary: null,
      text: "Снос (демонтаж) объекта капитального строительства, Иркутская область, Иркутский район",
      base,
      subject: "Иркутская область",
    });
    expect(found[0]?.message).toContain("6,77 %");
    expect(found[0]?.message).toContain("меньше на 3,77 п.п.");
    expect(found[0]?.message).toContain("приложение 1, п. 88");
    expect(found[0]?.amount).toBe(-377000);
  });

  it("вид работ не определён — только справка, без вывода «завышено»", () => {
    const found = checkCustomerLimitedCosts({
      winter: { percent: 2, quote: "Зимнее удорожание 2 %" },
      temporary: { percent: 1.5, quote: "Временные здания и сооружения 1,5 %" },
      text: "Смета на выполнение работ",
      base,
      subject: "Иркутская область",
    });
    expect(found.map((item) => item.severity)).toEqual(["INFO", "INFO"]);
    expect(found.some((item) => item.message.includes("сверка не сделана"))).toBe(true);
  });
});
