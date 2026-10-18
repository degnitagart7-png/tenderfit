import { describe, expect, it } from "vitest";

import {
  formatLlmCostReport,
  median,
  parseReportDate,
  percentile,
  summarizeLlmUsage,
  workUnitStats,
} from "@/domain/llmCostReport";
import type { LlmPurpose, LlmUsageRow } from "@/repositories/llmUsageRepository";

/**
 * Свод расхода: среднее, медиана, p90 по закупке и итоги за период — на подменённых строках.
 */

function row(overrides: Partial<LlmUsageRow> & { cost_rub: number }): LlmUsageRow {
  return {
    created_at: "2026-10-10T10:00:00.000Z",
    purpose: "deep_analysis" as LlmPurpose,
    tender_id: "T1",
    job_id: "J1",
    prompt_tokens: 1000,
    completion_tokens: 100,
    input_chars: 100_000,
    ok: true,
    ...overrides,
  };
}

/** Десять анализов по закупкам: стоимость 1, 2, …, 10 ₽, у каждого один вызов. */
function tenAnalyses(): LlmUsageRow[] {
  return Array.from({ length: 10 }, (_, i) =>
    row({ tender_id: `T${i + 1}`, job_id: `J${i + 1}`, cost_rub: i + 1, input_chars: (i + 1) * 10_000 }),
  );
}

describe("median и percentile", () => {
  it("медиана: нечётное число — серединное, чётное — среднее двух", () => {
    expect(median([1, 2, 9])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("p90 — метод ближайшего ранга: из десяти значений девятое", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([], 90)).toBe(0);
  });
});

describe("workUnitStats: расход на одну закупку", () => {
  it("среднее, медиана, p90, максимум, средний объём текста", () => {
    const stats = workUnitStats(tenAnalyses(), "deep_analysis");
    expect(stats.count).toBe(10);
    expect(stats.avgRub).toBeCloseTo(5.5, 9);
    expect(stats.medianRub).toBeCloseTo(5.5, 9);
    expect(stats.p90Rub).toBe(9);
    expect(stats.maxRub).toBe(10);
    expect(stats.totalRub).toBeCloseTo(55, 9);
    expect(stats.avgInputChars).toBeCloseTo(55_000, 6);
  });

  it("вызовы одной закупки и задания суммируются: анализ — это все его фрагменты", () => {
    const rows = [
      row({ cost_rub: 1.5, input_chars: 100_000 }),
      row({ cost_rub: 2.5, input_chars: 100_000 }),
      row({ cost_rub: 1, input_chars: 50_000 }),
      row({ tender_id: "T2", job_id: "J2", cost_rub: 10, input_chars: 10_000 }),
    ];
    const stats = workUnitStats(rows, "deep_analysis");
    expect(stats.count).toBe(2);
    expect(stats.top[0]).toMatchObject({ tenderId: "T2", costRub: 10, calls: 1 });
    expect(stats.top[1]).toMatchObject({ tenderId: "T1", jobId: "J1", costRub: 5, calls: 3, inputChars: 250_000 });
    expect(stats.avgRub).toBe(7.5);
  });

  it("повторный анализ той же закупки (другое задание) — отдельный анализ", () => {
    const rows = [
      row({ cost_rub: 3, job_id: "J1" }),
      row({ cost_rub: 5, job_id: "J2" }),
    ];
    expect(workUnitStats(rows, "deep_analysis").count).toBe(2);
  });

  it("сбойные вызовы входят в сумму: токены по ним могли списаться", () => {
    const rows = [row({ cost_rub: 2 }), row({ cost_rub: 3, ok: false })];
    expect(workUnitStats(rows, "deep_analysis").totalRub).toBe(5);
  });

  it("топ — пять самых дорогих закупок по убыванию", () => {
    const stats = workUnitStats(tenAnalyses(), "deep_analysis");
    expect(stats.top.map((unit) => unit.tenderId)).toEqual(["T10", "T9", "T8", "T7", "T6"]);
  });

  it("считает только свой вид работы", () => {
    const rows = [...tenAnalyses(), row({ purpose: "estimate_bill", tender_id: "T1", job_id: "S1", cost_rub: 100 })];
    expect(workUnitStats(rows, "estimate_bill")).toMatchObject({ count: 1, avgRub: 100 });
    expect(workUnitStats(rows, "deep_analysis").count).toBe(10);
  });

  it("нет строк — нули, а не NaN", () => {
    const stats = workUnitStats([], "deep_analysis");
    expect(stats).toMatchObject({ count: 0, avgRub: 0, medianRub: 0, p90Rub: 0, maxRub: 0, avgInputChars: 0 });
    expect(stats.top).toEqual([]);
  });
});

describe("summarizeLlmUsage", () => {
  const since = new Date("2026-10-08T00:00:00.000Z");
  const until = new Date("2026-10-18T00:00:00.000Z");

  it("по видам работ: вызовы, сумма, токены, число ошибок", () => {
    const rows = [
      ...tenAnalyses(),
      row({ purpose: "rerank", tender_id: null, job_id: null, cost_rub: 0.5, prompt_tokens: 200, completion_tokens: 50 }),
      row({ purpose: "rerank", tender_id: null, job_id: null, cost_rub: 0.25, ok: false }),
    ];
    const summary = summarizeLlmUsage(rows, { since, until });

    const deep = summary.byPurpose.find((entry) => entry.purpose === "deep_analysis");
    expect(deep).toMatchObject({ calls: 10, failedCalls: 0, promptTokens: 10_000, completionTokens: 1_000 });
    expect(deep?.costRub).toBeCloseTo(55, 9);
    const rerank = summary.byPurpose.find((entry) => entry.purpose === "rerank");
    expect(rerank).toMatchObject({ calls: 2, failedCalls: 1 });
    expect(rerank?.costRub).toBeCloseTo(0.75, 9);
    // По убыванию расхода.
    expect(summary.byPurpose[0]?.purpose).toBe("deep_analysis");
  });

  it("итог за период и в среднем в день", () => {
    const summary = summarizeLlmUsage(tenAnalyses(), { since, until });
    expect(summary.totalRub).toBeCloseTo(55, 9);
    expect(summary.totalCalls).toBe(10);
    expect(summary.days).toBe(10);
    expect(summary.avgPerDayRub).toBeCloseTo(5.5, 9);
  });

  it("без границ период берётся из данных; неполные сутки округляются вверх", () => {
    const rows = [
      row({ cost_rub: 6, created_at: "2026-10-10T00:00:00.000Z" }),
      row({ cost_rub: 6, created_at: "2026-10-12T12:00:00.000Z", tender_id: "T2", job_id: "J2" }),
    ];
    const summary = summarizeLlmUsage(rows);
    expect(summary.days).toBe(3);
    expect(summary.avgPerDayRub).toBe(4);
  });

  it("пустой период: нули и одни сутки", () => {
    const summary = summarizeLlmUsage([]);
    expect(summary).toMatchObject({ totalRub: 0, totalCalls: 0, days: 1, avgPerDayRub: 0 });
    expect(summary.deepAnalysis.count).toBe(0);
  });
});

describe("formatLlmCostReport", () => {
  it("печатает виды работ, статистику по закупке, топ и итог", () => {
    const summary = summarizeLlmUsage(tenAnalyses(), {
      since: new Date("2026-10-08T00:00:00.000Z"),
      until: new Date("2026-10-18T00:00:00.000Z"),
    });
    const text = formatLlmCostReport(summary).replace(/ /g, " ");

    expect(text).toContain("глубокий анализ (deep_analysis)");
    expect(text).toContain("анализов: 10");
    expect(text).toContain("среднее:   5,50 ₽");
    expect(text).toContain("медиана:   5,50 ₽");
    expect(text).toContain("p90:       9,00 ₽");
    expect(text).toContain("максимум:  10,00 ₽");
    expect(text).toContain("T10");
    expect(text).toContain("Итого за период: 55,00 ₽");
    expect(text).toContain("В среднем в день: 5,50 ₽");
    expect(text).toContain("расчётов: нет данных за период");
  });
});

describe("parseReportDate", () => {
  it("--since — начало суток UTC, --until включает день целиком", () => {
    expect(parseReportDate("2026-10-08", false).toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(parseReportDate("2026-10-08", true).toISOString()).toBe("2026-10-09T00:00:00.000Z");
  });

  it("кривая дата — понятная ошибка", () => {
    expect(() => parseReportDate("08.10.2026", false)).toThrow(/YYYY-MM-DD/);
    expect(() => parseReportDate("2026-13-45", false)).toThrow(/Нет такой даты/);
  });
});
