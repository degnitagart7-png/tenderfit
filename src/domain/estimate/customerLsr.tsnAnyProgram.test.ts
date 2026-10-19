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
});
