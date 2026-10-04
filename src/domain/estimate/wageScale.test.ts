import { describe, expect, it } from "vitest";
import type { WageAnchor } from "@/domain/estimate/types";
import {
  buildWageScale,
  describeWageOrigin,
  describeWageScale,
  formatRank,
  resolveWage,
  resolveWageByRank,
} from "@/domain/estimate/wageScale";
import {
  AMUR_INTEGER_ANCHORS,
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
} from "@/test/estimateFixtures";

/**
 * Тарифная шкала оплаты труда.
 *
 * Это единственный модуль расчёта, который достраивает данные: реестр ставок
 * рабочих покрывает разряды 1,0–3,4, а нормы требуют 3,8; 4,2; 6,0 и выше.
 * Поэтому тесты проверяют не «работает ли интерполяция», а воспроизводит ли она
 * значения, которые реально опубликованы в открытых данных.
 */

function scale(anchors: readonly WageAnchor[] = AMUR_WAGE_ANCHORS) {
  return buildWageScale(anchors, AMUR_ZONE);
}

describe("buildWageScale", () => {
  it("схлопывает повторяющиеся разряды двух источников", () => {
    // 25 разрядов реестра плюс 10 точек из ФСЦСР, из них 2,0 и 3,0 повторяются.
    const built = scale();
    expect(AMUR_WAGE_ANCHORS.length).toBe(35);
    expect(built.anchors.length).toBe(33);
    expect(built.anchors.filter((anchor) => anchor.rank === 2).length).toBe(1);
  });

  it("при расхождении источников берёт большую ставку", () => {
    // Занижать оплату труда нельзя: она входит в фонд оплаты труда, а через
    // него — в накладные расходы и сметную прибыль.
    const built = scale([
      { rank: 3, salary: 600, source: "Реестр" },
      { rank: 3, salary: 653.14, source: "ФСЦСР" },
    ]);
    expect(built.anchors[0]?.salary).toBe(653.14);
    expect(built.anchors[0]?.source).toBe("ФСЦСР");
  });

  it("отбрасывает невозможные ставки", () => {
    const built = scale([
      { rank: 1, salary: 548.86, source: "Реестр" },
      { rank: 2, salary: 0, source: "Пустая строка выгрузки" },
      { rank: 3, salary: -653.14, source: "Ошибка знака" },
      { rank: Number.NaN, salary: 700, source: "Битый разряд" },
      { rank: 4, salary: Number.NaN, source: "Битая ставка" },
    ]);
    expect(built.anchors.map((anchor) => anchor.rank)).toEqual([1]);
  });

  it("сортирует разряды по возрастанию независимо от порядка входа", () => {
    const shuffled = [...AMUR_WAGE_ANCHORS].sort(() => -1);
    const built = scale(shuffled);
    const ranks = built.anchors.map((anchor) => anchor.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(built.minRank).toBe(1);
    expect(built.maxRank).toBe(9);
    expect(built.baseSalary).toBe(548.86);
  });

  it("даёт пустую шкалу, если опорных точек нет", () => {
    const built = scale([]);
    expect(built.anchors).toEqual([]);
    expect(built.baseSalary).toBe(0);
    expect(resolveWage(built, "1-100-38")).toBeNull();
    expect(describeWageScale(built)).toContain("не загружена");
  });

  it("хранит реквизиты зоны и периода", () => {
    const built = scale();
    expect(built.region).toBe("Амурская область");
    expect(built.zone).toBe("Амурская область (1 зона)");
    expect(built.period).toBe("3 квартал 2026 г.");
  });
});

describe("resolveWage: точные значения из открытых данных", () => {
  it("возвращает ставку реестра без пересчёта", () => {
    const cases: Array<[string, number, number]> = [
      ["1-100-10", 1, 548.86],
      ["1-100-19", 1.9, 593.32],
      ["1-100-30", 3, 653.14],
      ["1-100-34", 3.4, 686.08],
      ["1-100-80", 8, 1125.16],
    ];
    for (const [code, rank, salary] of cases) {
      const resolved = resolveWage(scale(), code);
      expect(resolved?.rank, code).toBe(rank);
      expect(resolved?.salary, code).toBe(salary);
      expect(resolved?.origin, code).toBe("ANCHOR");
    }
  });

  it("возвращает ставку машинистов из ФСЦСР", () => {
    // 987,95 ₽ — оплата труда машинистов бульдозера 121 кВт за маш.-ч,
    // разряд 6, звено 1 человек.
    const resolved = resolveWage(scale(), "4-100-060");
    expect(resolved?.salary).toBe(987.95);
    expect(resolved?.origin).toBe("ANCHOR");
  });

  it("находит разряд 4 по коду рабочего с префиксом 2", () => {
    // Код «2-100-04» означает «Рабочий 4 разряда», а не разряд 0,4.
    // Если прочитать его как десятые доли, ставка окажется ниже первого
    // разряда шкалы и оплата труда будет занижена примерно на 29 %.
    const resolved = resolveWage(scale(), "2-100-04");
    expect(resolved?.rank).toBe(4);
    expect(resolved?.salary).toBe(735.47);
    expect(resolved?.origin).toBe("ANCHOR");
  });

  it("возвращает null для кодов, которые не про оплату труда", () => {
    const built = scale();
    expect(resolveWage(built, "1")).toBeNull();
    expect(resolveWage(built, "2")).toBeNull();
    expect(resolveWage(built, "91.01.01-035")).toBeNull();
    expect(resolveWage(built, "01.7.12.05-0131")).toBeNull();
  });
});

describe("resolveWage: интерполяция между разрядами", () => {
  it("даёт ставку разряда 3,8, нужную уже первой норме ГЭСН", () => {
    // Норма 01-01-001-01 содержит «1-100-38». В реестре такого кода нет:
    // реестр кончается разрядом 3,4.
    const resolved = resolveWage(scale(), "1-100-38");
    expect(resolved?.rank).toBe(3.8);
    expect(resolved?.salary).toBe(719.01);
    expect(resolved?.origin).toBe("INTERPOLATED");
  });

  it("воспроизводит опубликованные дробные разряды до копейки", () => {
    // Проверка самой модели: шкала только из целых разрядов обязана дать те же
    // значения, которые независимо опубликованы в двух открытых источниках.
    const integerOnly = scale(AMUR_INTEGER_ANCHORS);
    const cases: Array<[number, number]> = [
      [3.4, 686.08], // из реестра ставок рабочих
      [6.5, 1020.88], // из ФСЦСР, разряд машиниста 6,5
      [8.7, 1178.95], // из ФСЦСР, разряд машиниста 8,7
    ];
    for (const [rank, salary] of cases) {
      const resolved = resolveWageByRank(integerOnly, "1-100-00", rank);
      expect(resolved?.salary, `разряд ${String(rank)}`).toBe(salary);
      expect(resolved?.origin, `разряд ${String(rank)}`).toBe("INTERPOLATED");
    }
  });

  it("не выдаёт интерполяцию за точное значение на целом разряде", () => {
    const integerOnly = scale(AMUR_INTEGER_ANCHORS);
    expect(resolveWage(integerOnly, "1-100-50")?.origin).toBe("ANCHOR");
    expect(resolveWage(integerOnly, "1-100-50")?.salary).toBe(845.24);
  });
});

describe("resolveWage: продолжение шкалы за известные разряды", () => {
  it("помечает разряд выше известного максимума", () => {
    // Перепись пяти книг норм дала коды «1-100-73», «1-100-75» и «1-100-80».
    // По зоне, где шкала кончается раньше, их придётся достраивать.
    const narrow = scale(AMUR_INTEGER_ANCHORS.filter((anchor) => anchor.rank <= 6));
    const resolved = resolveWage(narrow, "1-100-80");
    expect(resolved?.origin).toBe("EXTRAPOLATED");
    expect(resolved?.salary).toBeGreaterThan(987.95);
    expect(narrow.maxRank).toBe(6);
  });

  it("помечает разряд ниже первого", () => {
    const resolved = resolveWage(scale(), "1-100-05");
    expect(resolved?.rank).toBe(0.5);
    expect(resolved?.origin).toBe("EXTRAPOLATED");
    expect(resolved?.salary).toBeLessThan(548.86);
    expect(resolved?.salary).toBeGreaterThan(0);
  });

  it("не уходит в отрицательную ставку", () => {
    const resolved = resolveWageByRank(scale(), "1-100-00", -5);
    expect(resolved?.origin).toBe("EXTRAPOLATED");
    expect(resolved?.salary).toBeGreaterThanOrEqual(0);
  });
});

describe("описания для пользователя", () => {
  it("показывает покрытие шкалы одной фразой", () => {
    const text = describeWageScale(scale());
    expect(text).toContain("Амурская область (1 зона)");
    expect(text).toContain("3 квартал 2026 г.");
    expect(text).toContain("разряды от 1,0 до 9,0");
    expect(text).toContain("опорных точек 33");
    expect(text).toContain("548,86 ₽/чел.-ч");
  });

  it("пишет разряд через запятую, как в выгрузке", () => {
    expect(formatRank(3.8)).toBe("3,8");
    expect(formatRank(4)).toBe("4,0");
    expect(formatRank(8.7)).toBe("8,7");
  });

  it("различает три способа получить ставку", () => {
    const anchor = describeWageOrigin("ANCHOR");
    const interpolated = describeWageOrigin("INTERPOLATED");
    const extrapolated = describeWageOrigin("EXTRAPOLATED");
    expect(new Set([anchor, interpolated, extrapolated]).size).toBe(3);
    expect(extrapolated).toContain("приближение");
  });
});
