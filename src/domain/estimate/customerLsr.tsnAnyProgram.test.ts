import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";

/**
 * Форма № 4б ТСН-2001 Москвы, выгруженная НЕ из Smeta.RU.
 *
 * Фикстура — первая ЛСР из архива смет закупки 32616405004 (КДЦ «Арктика», Москва), как её прочитал
 * разборщик вложений (CSV листа Excel). До 20.10.2026 разбор ТСН включался только для выгрузок Smeta.RU,
 * и такая смета падала в «не распознана: нет строки нумерации граф 1–12».
 */
const text = readFileSync(join(__dirname, "__fixtures__/tsn/arktika-lsr-02-01-01.txt"), "utf8");

describe("ТСН-2001 (Форма № 4б) из любой программы", () => {
  it("смета читается: позиции, база ТСН-2001 Москвы и итог как в шапке", () => {
    const parsed = parseCustomerLsr([{ name: "2026-07-03_Сметы__2_.zip", text } as never]);
    expect(parsed.notRecognized).toEqual([]);
    expect(parsed.estimates).toHaveLength(1);
    const [estimate] = parsed.estimates;
    expect(estimate?.positions).toHaveLength(6);
    expect(estimate?.base).toBe("TSN_2001_MOSCOW");
    // Шапка сметы: «Сметная стоимость … 987.39 тыс. руб.» в текущем уровне цен.
    expect(estimate?.total).toBeCloseTo(987_390.32, 1);
    expect(estimate?.positionsTotal).toBeGreaterThan(0);
  });

  it("объём с формулой подсчёта в ячейке («32⏎1*16*2») читается как число из первой строки", () => {
    const parsed = parseCustomerLsr([{ name: "2026-07-03_Сметы__2_.zip", text } as never]);
    const positions = parsed.estimates[0]?.positions ?? [];
    expect(positions.every((position) => position.quantity !== null)).toBe(true);
    expect(positions[0]?.quantity).toBe(32);
    expect(positions.find((position) => position.quantity === 145.8)).toBeDefined();
  });

  it("«0,049⏎(2*1,96+1*0,98) / 100» — это 0,049, а не 49: формула решает, чем была запятая", () => {
    const row = '296,4.8-159-1,"Прокладка металлического короба",100 м,"0,049\n(2*1,96+1*0,98) / 100","2,448.57",,,,,,';
    const withRow = text.replace(/\n,,ЗП,/, `\n${row}\n,,ЗП,`);
    const parsed = parseCustomerLsr([{ name: "2026-07-03_Сметы__2_.zip", text: withRow } as never]);
    const quantities = (parsed.estimates[0]?.positions ?? []).map((position) => position.quantity);
    expect(quantities).toContain(0.049);
    expect(quantities).not.toContain(49);
  });
});

