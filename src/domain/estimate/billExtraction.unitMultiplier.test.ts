import { describe, expect, it } from "vitest";

import { emptyExtractionStats, extractBillItems, type BillExtractionRow } from "@/domain/estimate/billExtraction";
import { recoverUnitMultiplier } from "@/domain/estimate/billQuoteMatch";
import { deriveUnitDivisor } from "@/domain/estimate/units";

/**
 * Множитель единицы («100 м2 | 0,899») — часть единицы. Модель его теряет: unit = «м2», quantity = 0,899, и после перевода под норму
 * «100 м2» выходит 0,00899 — в сто раз меньше (закупка 0302100011026000027). Строка документа множитель хранит, и код его возвращает.
 */

const SOURCE = [
  "Ведомость объёмов работ",
  "Оклейка стен моющимися обоями: на … 100 м2 0,899",
  "Окраска … 100 м2 0,4792",
  "Устройство подвесных потолков … 100 м2 0,28",
  "Устройство оснований полов из фанеры … 100 м2 0,583",
].join("\n");

const LINES = SOURCE.split("\n").slice(1);

function modelRow(line: string, quantity: string, unit = "м2"): BillExtractionRow {
  return { workName: line.split(" … ")[0] ?? line, quantity, unit, evidenceQuote: line };
}

function run(rows: readonly BillExtractionRow[], sourceText: string) {
  const stats = emptyExtractionStats();
  const result = extractBillItems({ rows, sourceText, documentName: "Ведомость.pdf", idPrefix: "d1c1", stats });
  return { ...result, stats };
}

describe("множитель единицы, потерянный моделью (путь модели)", () => {
  const quantities = ["0,899", "0,4792", "0,28", "0,583"];

  it("четыре строки закупки 0302100011026000027: «м2» + 0,899 → «100 м2», объём 89,9 м2, под норму «100 м2» — 0,899", () => {
    const { items, rejected, stats } = run(
      LINES.map((line, index) => modelRow(line, quantities[index] as string)),
      SOURCE,
    );
    expect(rejected).toEqual([]);
    expect(items).toHaveLength(4);
    const expected = [89.9, 47.92, 28, 58.3];
    items.forEach((item, index) => {
      expect(item.quantityUnit).toBe("м2");
      expect(item.quantity).toBeCloseTo(expected[index] as number, 6);
      // Перевод под норму «100 м2»: напечатанное число, а не одна сотая от него.
      expect((item.quantity / (deriveUnitDivisor(item.quantityUnit, "100 м2") as number))).toBeCloseTo(Number(quantities[index]?.replace(",", ".")), 6);
    });
    expect(stats.unitMultiplierRecovered).toBe(4);
  });

  it("множитель после числа («0,899 | 100 м2») тоже берётся", () => {
    const text = "Обои моющиеся | 0,899 | 100 м2";
    const { items, stats } = run([{ workName: "Обои моющиеся", quantity: "0,899", unit: "м2", evidenceQuote: text }], text);
    expect(items[0]?.quantity).toBeCloseTo(89.9, 6);
    expect(stats.unitMultiplierRecovered).toBe(1);
  });

  it("1000 м3, 10 м3, 100 м, 100 шт и 10 компл: множитель той же единицы возвращается", () => {
    const cases: readonly { readonly unit: string; readonly line: string; readonly quantity: string; readonly expected: number; readonly parsed: string }[] = [
      { unit: "м3", line: "Разработка грунта экскаватором 1000 м3 12,5", quantity: "12,5", expected: 12500, parsed: "м3" },
      { unit: "м3", line: "Бетонирование фундаментов 10 м3 3,4", quantity: "3,4", expected: 34, parsed: "м3" },
      { unit: "м", line: "Прокладка кабеля по стене 100 м 2,5", quantity: "2,5", expected: 250, parsed: "м" },
      { unit: "шт", line: "Установка светильников 100 шт 0,6", quantity: "0,6", expected: 60, parsed: "шт" },
      { unit: "компл", line: "Установка дверных блоков 10 компл 4", quantity: "4", expected: 40, parsed: "компл" },
    ];
    for (const entry of cases) {
      const { items, stats } = run([{ workName: entry.line.split(" ").slice(0, 2).join(" "), quantity: entry.quantity, unit: entry.unit, evidenceQuote: entry.line }], entry.line);
      expect(items[0]?.quantityUnit, entry.line).toBe(entry.parsed);
      expect(items[0]?.quantity, entry.line).toBeCloseTo(entry.expected, 6);
      expect(stats.unitMultiplierRecovered, entry.line).toBe(1);
    }
  });

  it("модель вернула единицу с множителем сама — ничего не меняется и в счётчик не идёт", () => {
    const { items, stats } = run([modelRow(LINES[0] as string, "0,899", "100 м2")], SOURCE);
    expect(items[0]?.quantity).toBeCloseTo(89.9, 6);
    expect(stats.unitMultiplierRecovered).toBe(0);
  });

  it("модель сама умножила (89,9 м2) — число из строки подтверждается пересчётом, множитель второй раз не применяется", () => {
    const { items, stats } = run([modelRow(LINES[0] as string, "89,9")], SOURCE);
    expect(items[0]?.quantity).toBeCloseTo(89.9, 6);
    expect(stats.unitMultiplierRecovered).toBe(0);
  });

  it("негативный: «100 м2» стоит в другом месте строки, не рядом с объёмом — множитель не берётся", () => {
    const line = "Устройство покрытия на площади 100 м2 в здании школы | м2 | 25";
    const { items, stats } = run([{ workName: "Устройство покрытия", quantity: "25", unit: "м2", evidenceQuote: line }], line);
    expect(items[0]?.quantity).toBe(25);
    expect(items[0]?.quantityUnit).toBe("м2");
    expect(stats.unitMultiplierRecovered).toBe(0);
  });

  it("негативный: вплотную к объёму стоит сама основная единица — множитель из начала строки не берётся", () => {
    const line = "Окраска стен на 100 м2 поверхности, м2 | 0,899";
    const { items, stats } = run([{ workName: "Окраска стен", quantity: "0,899", unit: "м2", evidenceQuote: line }], line);
    expect(items[0]?.quantity).toBe(0.899);
    expect(stats.unitMultiplierRecovered).toBe(0);
  });

  it("негативный: множитель другой величины («100 шт» при «м2») не подходит", () => {
    const line = "Окраска стен, 100 шт креплений | 0,899";
    const { items } = run([{ workName: "Окраска стен", quantity: "0,899", unit: "м2", evidenceQuote: line }], line);
    expect(items[0]?.quantity).toBe(0.899);
  });
});

describe("recoverUnitMultiplier", () => {
  const m2 = { unit: "м2", multiplier: 1 };

  it("возвращает единицу с множителем, когда она вплотную к числу", () => {
    expect(recoverUnitMultiplier(["Окраска … 100 м2 0,4792"], 0.4792, m2)).toEqual({ unit: "м2", multiplier: 100 });
  });

  it("не трогает единицу, у которой множитель уже есть", () => {
    expect(recoverUnitMultiplier(["Окраска … 100 м2 0,4792"], 0.4792, { unit: "м2", multiplier: 100 })).toBeNull();
  });

  it("число, которого в строке нет, множитель не получает", () => {
    expect(recoverUnitMultiplier(["Окраска … 100 м2 0,4792"], 7, m2)).toBeNull();
  });
});
