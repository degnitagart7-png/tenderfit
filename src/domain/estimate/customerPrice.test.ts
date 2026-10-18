import { describe, expect, it } from "vitest";

import {
  declaresCurrentPrices,
  numbersOf,
  positionTotalAfter,
  priceFromLine,
} from "@/domain/estimate/customerPrice";
import { SMETA_001_OCR } from "@/test/volumeSourceFixtures";

describe("declaresCurrentPrices", () => {
  it("«Составлен(а) в текущем уровне цен» — текущий уровень", () => {
    expect(declaresCurrentPrices("Составлен(а) в текущем уровне цен lil квартал 2026 года")).toBe(true);
    expect(declaresCurrentPrices(SMETA_001_OCR)).toBe(true);
  });

  it("базисный и базовый уровень — не текущий, хоть в одной смете документа", () => {
    expect(declaresCurrentPrices("Составлен(а) в базисном уровне цен 2001 г.")).toBe(false);
    expect(declaresCurrentPrices("Составлен(а) в базовом уровне цен 2000г.")).toBe(false);
    expect(
      declaresCurrentPrices(
        "Составлен(а) в текущем уровне цен 2026\n...\nСоставлен(а) в базисном уровне цен 2001",
      ),
    ).toBe(false);
  });

  it("слова в заголовках граф таблицы декларацией не считаются", () => {
    expect(declaresCurrentPrices("на единицу измерения в базисном уровне цен | в текущем уровне цен")).toBe(false);
  });
});

describe("numbersOf", () => {
  it("разряды через пробел, запятая и точка как десятичные", () => {
    expect(numbersOf("1 740,33 76 768,41 295.01 1912,45 0,91")).toEqual([1740.33, 76768.41, 295.01, 1912.45, 0.91]);
  });
});

describe("priceFromLine: сумма обязана равняться объёму × цене", () => {
  it("строка размещения: 505,94 × 831,67 = 420 775,12", () => {
    const pool = numbersOf("505,94 1 505,94 831,67 420 775,12");

    expect(priceFromLine(505.94, pool)).toEqual({ unitPrice: 831.67, total: 420775.12 });
  });

  it("OCR-ошибка в итоге строки «Всего по позиции 220 775,12» победить не может: сверка идёт со строкой", () => {
    const pool = numbersOf("505,94 1 505,94 831,67 420 775,12");

    expect(priceFromLine(505.94, pool)?.total).not.toBe(220775.12);
  });

  it("точка вместо запятой: 55,52 × 295.01 = 16 378,96", () => {
    expect(priceFromLine(55.52, numbersOf("55,52 295.01 16 378,96"))?.total).toBe(16378.96);
  });

  it("коэффициент 1 и повтор объёма ценой и суммой не считаются", () => {
    expect(priceFromLine(34.7, numbersOf("34,7 1 34,7"))).toBeNull();
  });

  it("сумма не сходится ни с какой ценой — пары нет", () => {
    expect(priceFromLine(347, numbersOf("347 34,7 1912,45 0,91 1 740,33 60 389,45"))).toBeNull();
  });
});

describe("positionTotalAfter: «Всего по позиции» работы", () => {
  const at = (needle: string) => {
    const start = SMETA_001_OCR.indexOf(needle);
    return SMETA_001_OCR.indexOf("\n", start) + 1;
  };

  it("разборка здания: последнее число строки — сумма в текущем уровне", () => {
    expect(positionTotalAfter(SMETA_001_OCR, at("1 F9CH46-06-909-03"))).toBe(309564.33);
  });

  it("планировка: «3828,62 1 331,21» — сумма 1 331,21", () => {
    expect(positionTotalAfter(SMETA_001_OCR, at("3 F3CH01-02-027-02"))).toBe(1331.21);
  });

  it("поиск обрывается на строке следующей позиции", () => {
    // Под позицией 4 «Всего по позиции» стоит после позиции 4.1 и относится к обеим.
    expect(positionTotalAfter(SMETA_001_OCR, at("4 ФСБЦ-02.2.04.03-0013 Смесь"))).toBeNull();
  });

  it("строки «Всего по позиции» нет — null", () => {
    expect(positionTotalAfter("1 ГЭСН01-01-001-01 Работа 1000 м3 2\nИтого прямые затраты 100", 0)).toBeNull();
  });
});
