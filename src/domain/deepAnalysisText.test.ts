import { describe, expect, it } from "vitest";

import { ESTIMATE_FULL_READ_CHARS, isEstimateDocument, textForDeepAnalysis } from "@/domain/deepAnalysisText";

/** Глубокий анализ: договор и ТЗ целиком, большая смета — шапка и итоги. */

function bigEstimate(): string {
  const head = "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ № 02-01\nОбъект: школа\nУровень цен: 3 кв. 2026\n";
  const rows = Array.from({ length: 4000 }, (_, i) => `${String(i + 1)},ФЕР15-04-005-03,Окраска стен,100 м2,1.2,,,,,,,`).join("\n");
  return `${head}${rows}\nИтого по разделу 1 Отделка,,,,1 200 000\n${rows}\nИтого по смете,,,,2 400 000\nНДС 20%,,,,480 000\nВСЕГО по смете,,,,2 880 000\n`;
}

describe("textForDeepAnalysis", () => {
  it("договор и небольшая смета читаются целиком", () => {
    const contract = "Проект контракта. ".repeat(10_000);
    expect(textForDeepAnalysis("Проект_договора.doc", contract)).toMatchObject({ condensed: false, text: contract });
    const small = "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ\n" + "строка\n".repeat(100);
    expect(textForDeepAnalysis("Смета.xlsx", small).condensed).toBe(false);
  });

  it("большая смета — шапка, итоги разделов и итог сметы, с пометкой", () => {
    const text = bigEstimate();
    expect(text.length).toBeGreaterThan(ESTIMATE_FULL_READ_CHARS);
    const result = textForDeepAnalysis("Смета_2.xlsx", text);

    expect(result.condensed).toBe(true);
    expect(result.text.length).toBeLessThan(50_000);
    expect(result.text).toContain("Уровень цен: 3 кв. 2026");
    expect(result.text).toContain("Итого по разделу 1 Отделка");
    expect(result.text).toContain("ВСЕГО по смете");
    expect(result.text).toMatch(/^\[Смета сокращена/);
  });

  it("смета узнаётся по имени или по заголовку; ТЗ — нет", () => {
    expect(isEstimateDocument("Приложение 3.xlsx", "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ № 1")).toBe(true);
    expect(isEstimateDocument("ЛСР_кровля.pdf", "")).toBe(true);
    expect(isEstimateDocument("ТЗ.docx", "Техническое задание на капитальный ремонт")).toBe(false);
  });
});
