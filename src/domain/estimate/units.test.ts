import { describe, expect, it } from "vitest";

import {
  baseUnitOf,
  deriveSupplyDivisor,
  deriveUnitDivisor,
  foldLookalikes,
  isMoneyUnit,
  isWholeWorkUnit,
  parseUnit,
  parseUnitPair,
} from "@/domain/estimate/units";

/**
 * Единицы после OCR. Все написания взяты из живой сметы заказчика закупки
 * 0134600012126000001: на них выбыли разборка здания, планировка, вывоз и
 * размещение мусора.
 */
describe("parseUnit: искажения распознавания", () => {
  it.each([
    ["100 m3", "м3", 100],
    ["100 м3", "м3", 100],
    ["1000 м2", "м2", 1000],
    ["m3", "м3", 1],
    ["M3", "м3", 1],
    ["m2", "м2", 1],
    ["T", "т", 1],
    ["t", "т", 1],
    ["Tн", "т", 1],
  ])("латиница на месте кириллицы: «%s» → %s × %d", (raw, unit, multiplier) => {
    expect(parseUnit(raw)).toEqual({ unit, multiplier });
  });

  it.each([["мз"], ["мЗ"], ["МЗ"], ["м з"], ["м З"]])("тройка, прочитанная как «з»: «%s» → м3", (raw) => {
    expect(parseUnit(raw)).toEqual({ unit: "м3", multiplier: 1 });
  });

  it.each([["1тгруза"], ["1т груза"], ["1 т груза"], ["т груза"], ["1 Т ГРУЗА"]])(
    "«%s» — тонна, хвост «груза» не единица",
    (raw) => {
      expect(parseUnit(raw)).toEqual({ unit: "т", multiplier: 1 });
    },
  );

  it("описательный хвост нормы ФСНБ отбрасывается: «100 м3 строительного объема»", () => {
    expect(parseUnit("100 м3 строительного объема")).toEqual({ unit: "м3", multiplier: 100 });
    expect(parseUnit("10 м3 строительного объёма")).toEqual({ unit: "м3", multiplier: 10 });
    expect(parseUnit("100 м2 горизонтальной проекции")).toEqual({ unit: "м2", multiplier: 100 });
  });

  it.each([
    ["маш.-ч", "маш.-ч"],
    ["маш.ч", "маш.-ч"],
    ["маш-ч", "маш.-ч"],
    ["маш. - ч", "маш.-ч"],
    ["маш.-4", "маш.-ч"],
    ["чел.-ч", "чел.-ч"],
    ["чел.ч", "чел.-ч"],
    ["чел-ч", "чел.-ч"],
    ["чел.-4", "чел.-ч"],
  ])("часы с искажениями: «%s» → %s", (raw, unit) => {
    expect(parseUnit(raw)).toEqual({ unit, multiplier: 1 });
  });

  it("«комп.» — это «компл.»: OCR съедает «л»", () => {
    expect(parseUnit("комп.")).toEqual({ unit: "компл", multiplier: 1 });
    expect(parseUnit("компл.")).toEqual({ unit: "компл", multiplier: 1 });
  });

  it("похожее не угадывается: «тыс.», «пачка», «м3.5»", () => {
    expect(parseUnit("тыс.")).toBeNull();
    expect(parseUnit("пачка")).toBeNull();
    expect(parseUnit("на бригаду")).toBeNull();
  });

  it("«мз» узнаётся только как вся единица, а не внутри слова", () => {
    expect(parseUnit("музей")).toBeNull();
    expect(parseUnit("рамз")).toBeNull();
  });
});

describe("isWholeWorkUnit", () => {
  it.each([["Условная единица"], ["усл. ед."], ["усл.ед."], ["Усл. ед"], ["объект"], ["Условных единиц"]])(
    "«%s» — вся работа целиком",
    (raw) => {
      expect(isWholeWorkUnit(raw)).toBe(true);
    },
  );

  it("обычные единицы работой целиком не считаются", () => {
    expect(isWholeWorkUnit("шт")).toBe(false);
    expect(isWholeWorkUnit("компл.")).toBe(false);
    expect(isWholeWorkUnit("м3")).toBe(false);
  });
});

describe("parseUnitPair", () => {
  it("«м3/т» — две единицы", () => {
    expect(parseUnitPair("м3/т")).toEqual([
      { unit: "м3", multiplier: 1 },
      { unit: "т", multiplier: 1 },
    ]);
  });

  it("латиница и пробелы: «M3/t», «м3 / т»", () => {
    expect(parseUnitPair("M3/t")?.map((u) => u.unit)).toEqual(["м3", "т"]);
    expect(parseUnitPair("м3 / т")?.map((u) => u.unit)).toEqual(["м3", "т"]);
  });

  it("три единицы: «м2/м3/т»", () => {
    expect(parseUnitPair("м2/м3/т")?.map((u) => u.unit)).toEqual(["м2", "м3", "т"]);
  });

  it("«м/т» — потерянная тройка: в таблицах «объём/вес» это м3/т", () => {
    expect(parseUnitPair("м/т")?.map((u) => u.unit)).toEqual(["м3", "т"]);
  });

  it("одна единица или незнакомая часть — не пара", () => {
    expect(parseUnitPair("м3")).toBeNull();
    expect(parseUnitPair("м3/пачка")).toBeNull();
    expect(parseUnitPair("м3/")).toBeNull();
  });
});

describe("деривативы единиц", () => {
  it("делитель под норму с описательным хвостом", () => {
    expect(deriveUnitDivisor("м3", "100 м3 строительного объема")).toBe(100);
    expect(deriveUnitDivisor("м2", "1000 м2")).toBe(1000);
    expect(deriveUnitDivisor("т", "т")).toBe(1);
    expect(deriveUnitDivisor("т", "1000 м3")).toBeNull();
  });

  it("основная единица без множителя", () => {
    expect(baseUnitOf("100 m3")).toBe("м3");
    expect(baseUnitOf("пачка")).toBeNull();
  });

  it("латинские двойники сворачиваются только в нижнем регистре", () => {
    expect(foldLookalikes("m3")).toBe("м3");
  });

  it("денежные единицы остаются денежными", () => {
    expect(isMoneyUnit("тыс. руб.")).toBe(true);
    expect(isMoneyUnit("т")).toBe(false);
  });
});

describe("deriveSupplyDivisor: объём поставки в единицу цены", () => {
  it("масштаб единицы цены и точный перевод внутри величины", () => {
    expect(deriveSupplyDivisor("м", "1000 м")).toBe(1000);
    expect(deriveSupplyDivisor("м", "100 м")).toBe(100);
    expect(deriveSupplyDivisor("кг", "т")).toBe(1000);
    expect(deriveSupplyDivisor("т", "кг")).toBe(0.001);
    expect(deriveSupplyDivisor("м", "км")).toBe(1000);
    expect(deriveSupplyDivisor("1000 м", "м")).toBeCloseTo(0.001, 12);
    expect(deriveSupplyDivisor("шт", "100 шт")).toBe(100);
  });

  it("разные величины и неизвестные единицы не переводятся", () => {
    expect(deriveSupplyDivisor("м3", "м2")).toBeNull();
    expect(deriveSupplyDivisor("т", "м3")).toBeNull();
    expect(deriveSupplyDivisor("кг", "м")).toBeNull();
    expect(deriveSupplyDivisor("рулон", "т")).toBeNull();
    // Старый делитель норм не расширен: «т» и «кг» там по-прежнему разные единицы.
    expect(deriveUnitDivisor("кг", "т")).toBeNull();
  });
});
