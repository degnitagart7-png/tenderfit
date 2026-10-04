import { describe, expect, it } from "vitest";
import type { Tender } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import { demoTenders } from "@/mocks/tenders";
import {
  isInWork,
  summarizeBudget,
  todayRank,
  urgencyFactor,
} from "@/domain/todayBoard";

const NOW = new Date("2026-09-26T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** ISO-срок через `days` суток от NOW; отрицательное — срок уже прошёл. */
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

/** Цена 0 — принятый в домене способ сказать «НМЦ не опубликована». */
function row(spec: {
  days: number;
  fit: number;
  price?: number;
  currency?: string;
}): TenderRow {
  const base = demoTenders[0] as Tender;
  return {
    tender: {
      ...base,
      deadlines: { ...base.deadlines, submissionEnd: inDays(spec.days) },
      financial: {
        ...base.financial,
        price: spec.price === undefined ? 1_000_000 : spec.price,
        currency: spec.currency ?? "RUB",
      },
    },
    /*
      Разбор здесь урезан до одного поля намеренно: проверяемые функции читают
      только `fitScore`, а полный TenderAnalysis в фикстуре создавал бы
      впечатление, что остальные поля на результат влияют.
    */
    analysis: { fitScore: spec.fit } as unknown as TenderRow["analysis"],
    pipelineStatus: "NEW",
  };
}

describe("isInWork", () => {
  it("в работе — взятые человеком статусы, но не «Новые»", () => {
    expect(isInWork("INTERESTING")).toBe(true);
    expect(isInWork("PREPARING_APPLICATION")).toBe(true);
    expect(isInWork("SUBMITTED")).toBe(true);
    // Лента приносит «Новые» сама — это не работа пользователя.
    expect(isInWork("NEW")).toBe(false);
  });

  it("завершённые закупки работой не считаются", () => {
    expect(isInWork("WON")).toBe(false);
    expect(isInWork("LOST")).toBe(false);
    expect(isInWork("SKIPPED")).toBe(false);
  });
});

describe("urgencyFactor", () => {
  it("за горизонтом срочности срок на порядок не влияет", () => {
    expect(urgencyFactor(inDays(60), NOW)).toBe(0);
    expect(urgencyFactor(inDays(30), NOW)).toBe(0);
  });

  it("чем ближе подача, тем выше срочность", () => {
    const soon = urgencyFactor(inDays(2), NOW);
    const later = urgencyFactor(inDays(20), NOW);
    expect(soon).toBeGreaterThan(later);
    expect(soon).toBeLessThanOrEqual(1);
  });

  it("истёкший срок даёт максимум — такие строки отсекаются выше по потоку", () => {
    expect(urgencyFactor(inDays(-1), NOW)).toBe(1);
  });
});

describe("todayRank", () => {
  it("при равном сроке выше тот, кто лучше подходит", () => {
    expect(todayRank(row({ days: 10, fit: 70 }), NOW)).toBeGreaterThan(
      todayRank(row({ days: 10, fit: 40 }), NOW),
    );
  });

  it("близкий срок поднимает закупку при сопоставимом соответствии", () => {
    expect(todayRank(row({ days: 1, fit: 60 }), NOW)).toBeGreaterThan(
      todayRank(row({ days: 25, fit: 60 }), NOW),
    );
  });

  it("горящий срок не поднимает заведомо неподходящую закупку выше подходящей", () => {
    // Ровно та ошибка, ради которой срок взят множителем, а не слагаемым.
    expect(todayRank(row({ days: 0.5, fit: 20 }), NOW)).toBeLessThan(
      todayRank(row({ days: 7, fit: 70 }), NOW),
    );
  });
});

describe("summarizeBudget", () => {
  it("складывает только рублёвые опубликованные цены", () => {
    const res = summarizeBudget([
      row({ days: 5, fit: 60, price: 1_000_000 }),
      row({ days: 5, fit: 60, price: 500_000 }),
    ]);
    expect(res).toEqual({ total: 1_500_000, counted: 2, skipped: 0 });
  });

  it("валюта и отсутствующая цена в сумму не идут, но считаются отдельно", () => {
    const res = summarizeBudget([
      row({ days: 5, fit: 60, price: 1_000_000 }),
      // Пересчёт по выдуманному курсу дал бы на экране число из ниоткуда.
      row({ days: 5, fit: 60, price: 4_000_000, currency: "USD" }),
      row({ days: 5, fit: 60, price: 0 }),
    ]);
    expect(res).toEqual({ total: 1_000_000, counted: 1, skipped: 2 });
  });

  it("пустая подборка даёт нули, а не NaN", () => {
    expect(summarizeBudget([])).toEqual({ total: 0, counted: 0, skipped: 0 });
  });
});
