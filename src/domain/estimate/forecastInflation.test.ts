import { describe, expect, it } from "vitest";

import { computeForecastInflation, monthLabel, periodText } from "@/domain/estimate/forecastInflation";
import { annualDeflator, deflatorYears, forecastLetterLabel, FORECAST_DEFLATORS } from "@/domain/estimate/ssrNormatives";

/*
  Индекс прогнозной инфляции (841/пр, п. 22-23). Ожидаемые значения в тестах считаются здесь же независимым выражением из
  годовых дефляторов письма Минэкономразвития (112,0 / 109,0 / 104,6 / 104,5), а не берутся из реализации.
*/

const I26 = 1.12;
const I27 = 1.09;
const I28 = 1.046;
const compute = (period: Parameters<typeof computeForecastInflation>[0]["period"], priceDate: string | null = "2026-10-01") =>
  computeForecastInflation({ period, priceDate, today: "2026-10-09" });

describe("дефляторы письма", () => {
  it("годовые значения «Инвестиции в основной капитал»: 2025 — 109,3, 2026 — 112,0, 2027 — 109,0, 2028 — 104,6, 2029 — 104,5", () => {
    expect(annualDeflator(2025)).toBeCloseTo(1.093, 6);
    expect(annualDeflator(2026)).toBeCloseTo(1.12, 6);
    expect(annualDeflator(2027)).toBeCloseTo(1.09, 6);
    expect(annualDeflator(2028)).toBeCloseTo(1.046, 6);
    expect(annualDeflator(2029)).toBeCloseTo(1.045, 6);
    expect(annualDeflator(2030)).toBeNull();
    expect(deflatorYears()).toEqual({ first: 2025, last: 2029 });
  });

  it("письмо названо с датой и номером", () => {
    expect(forecastLetterLabel()).toBe("письмо Минэкономразвития России от 30.09.2026 № 36459-ПК/Д03и");
    expect(FORECAST_DEFLATORS.used).toBe("investments");
  });
});

describe("работы октябрь-ноябрь 2026 (закупка 0134300025826000377)", () => {
  it("индекс — среднее индексов на даты начала и окончания: (1 + 112,0 %^(1/12)) / 2 = 1,0047", () => {
    const result = compute({ kind: "DATES", start: "2026-10-01", end: "2026-11-30" });
    const expected = (1 + I26 ** (1 / 12)) / 2;
    expect(result.applied).toBe(true);
    expect(result.rawIndex).toBeCloseTo(expected, 9);
    expect(result.index).toBe(1.0047);
    expect(result.formula).toBe("(1,0000 + 1,0095) / 2 = 1,0047");
    expect(result.baseMonth).toBe("2026-10");
    expect(result.baseAssumed).toBe(false);
    expect(periodText(result)).toBe("октябрь 2026 — ноябрь 2026");
  });

  it("у заказчика И = 1,0045: расхождение 0,0002, то есть в пределах округления; он, вероятно, брал месячный рост около 0,9 % (≈ 11,4 % в год)", () => {
    const ours = compute({ kind: "DATES", start: "2026-10-01", end: "2026-11-30" }).index;
    expect(Math.abs(ours - 1.0045)).toBeLessThan(0.0005);
    // Месячный рост x, при котором среднее (1 + x) / 2 даёт 1,0045: x = 1,0090; в год это 1,0090^12.
    const impliedAnnual = 1.009 ** 12;
    expect(impliedAnnual).toBeGreaterThan(1.113);
    expect(impliedAnnual).toBeLessThan(1.115);
  });

  it("если НМЦК определена в сентябре, уровень отсчитывается от сентября: индекс выше, 1,0143", () => {
    const result = compute({ kind: "DATES", start: "2026-10-01", end: "2026-11-30" }, "2026-09-15");
    const expected = (I26 ** (1 / 12) + I26 ** (2 / 12)) / 2;
    expect(result.rawIndex).toBeCloseTo(expected, 9);
    expect(result.index).toBe(1.0143);
  });

  it("срок «в течение 2 месяцев с даты контракта» при НМЦК в октябре даёт тот же индекс", () => {
    const months = compute({ kind: "MONTHS", months: 2 });
    expect(months.index).toBe(1.0047);
    expect(months.endMonth).toBe("2026-11");
    expect(months.assumptions.join(" ")).toContain("дата контракта неизвестна");
  });

  it("срок «с даты контракта по 30.11.2026» — то же самое: начало в месяце НМЦК", () => {
    const until = compute({ kind: "UNTIL", end: "2026-11-30" });
    expect(until.index).toBe(1.0047);
    expect(until.startMonth).toBe("2026-10");
    expect(until.assumptions.join(" ")).toContain("начало работ принято в месяце определения НМЦК");
  });

  it("дата контракта известна — отсчёт срока в месяцах от неё", () => {
    const result = compute({ kind: "MONTHS", months: 3, contractDate: "2026-11-20" });
    expect(result.startMonth).toBe("2026-11");
    expect(result.endMonth).toBe("2027-01");
  });
});

describe("работы на два года: через границу года (841/пр, п. 23, формула 2)", () => {
  it("октябрь 2026 — сентябрь 2028: доли 3/24, 12/24, 9/24 и средние индексов по годам", () => {
    const result = compute({ kind: "DATES", start: "2026-10-01", end: "2028-09-30" });
    const dec26 = I26 ** (2 / 12);
    const dec27 = dec26 * I27;
    const k1 = (1 + dec26) / 2;
    const k2 = (dec26 * I27 ** (1 / 12) + dec27) / 2;
    const k3 = (dec27 * I28 ** (1 / 12) + dec27 * I28 ** (9 / 12)) / 2;
    const expected = (3 / 24) * k1 + (12 / 24) * k2 + (9 / 24) * k3;
    expect(result.parts.map((part) => [part.year, part.months])).toEqual([
      [2026, 3],
      [2027, 12],
      [2028, 9],
    ]);
    expect(result.rawIndex).toBeCloseTo(expected, 9);
    expect(result.index).toBe(Number(expected.toFixed(4)));
    expect(result.index).toBeGreaterThan(1.08);
    expect(result.index).toBeLessThan(1.09);
    expect(result.assumptions.join(" ")).toContain("пропорционально числу месяцев");
  });

  it("ноябрь 2026 — февраль 2027: две доли по два месяца", () => {
    const result = compute({ kind: "DATES", start: "2026-11-01", end: "2027-02-28" });
    const dec26 = I26 ** (2 / 12);
    const k1 = (I26 ** (1 / 12) + dec26) / 2;
    const k2 = (dec26 * I27 ** (1 / 12) + dec26 * I27 ** (2 / 12)) / 2;
    expect(result.parts.map((part) => part.share)).toEqual([0.5, 0.5]);
    expect(result.rawIndex).toBeCloseTo(0.5 * k1 + 0.5 * k2, 9);
  });

  it("весь 2027 год при НМЦК в декабре 2026: (109,0 %^(1/12) + 109,0 %) / 2", () => {
    const result = compute({ kind: "DATES", start: "2027-01-01", end: "2027-12-31" }, "2026-12-20");
    expect(result.rawIndex).toBeCloseTo((I27 ** (1 / 12) + I27) / 2, 9);
  });

  it("работы начинаются раньше месяца НМЦК — начало принято на месяц НМЦК, с оговоркой", () => {
    const result = compute({ kind: "DATES", start: "2026-08-01", end: "2026-11-30" });
    expect(result.startMonth).toBe("2026-10");
    expect(result.assumptions.join(" ")).toContain("работы начинаются раньше месяца НМЦК");
  });
});

describe("когда индекс не применяется", () => {
  it("без сроков — не применяется, индекс 1, причина названа", () => {
    const result = compute(null);
    expect(result.applied).toBe(false);
    expect(result.index).toBe(1);
    expect(result.reason).toContain("сроки работ неизвестны");
    expect(result.formula).toBeNull();
  });

  it("года нет в письме (2030) — индекс не продолжается предыдущим, а не рассчитывается", () => {
    const result = compute({ kind: "DATES", start: "2029-10-01", end: "2030-03-31" });
    expect(result.applied).toBe(false);
    expect(result.index).toBe(1);
    expect(result.reason).toContain("нет дефлятора на 2030");
  });

  it("окончание раньше начала, битые даты, нулевой срок", () => {
    expect(compute({ kind: "DATES", start: "2026-11-01", end: "2026-10-01" }).applied).toBe(false);
    expect(compute({ kind: "DATES", start: "не дата", end: "2026-10-01" }).applied).toBe(false);
    expect(compute({ kind: "MONTHS", months: 0 }).applied).toBe(false);
  });

  it("дата НМЦК неизвестна — основа месяц начала работ, допущение названо", () => {
    const result = compute({ kind: "DATES", start: "2026-10-01", end: "2026-11-30" }, null);
    expect(result.baseAssumed).toBe(true);
    expect(result.index).toBe(1.0047);
    expect(result.assumptions.join(" ")).toContain("дата определения НМЦК неизвестна");
  });
});

describe("подписи", () => {
  it("месяц словами", () => {
    expect(monthLabel("2026-11")).toBe("ноябрь 2026");
    expect(monthLabel("2026-11-30")).toBe("ноябрь 2026");
  });
});
