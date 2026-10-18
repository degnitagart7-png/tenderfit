import { describe, expect, it } from "vitest";

import { DEFAULT_SSR_OPTIONS, NO_ESTIMATE_OPTIONS, hasEstimateOptions, resolveSsrPeriod } from "@/domain/estimate/estimateOptions";
import { extractSsrTerm } from "@/domain/estimate/ssrTerm";

describe("срок работ из текста документации", () => {
  it("закупка 377: «с момента заключения Контракта по 30 ноября 2026 г.» — одна граница, окончание", () => {
    const hint = extractSsrTerm("1.5. Срок выполнения работы: с момента заключения Контракта по 30 ноября 2026 г. (включительно).");
    expect(hint).toMatchObject({ start: null, end: "2026-11-30", months: null });
    expect(hint?.quote).toContain("по 30 ноября 2026");
  });

  it("две даты цифрами — как в блоке зимнего удорожания", () => {
    expect(extractSsrTerm("Срок выполнения работ: с 01.09.2026 по 30.11.2026")).toMatchObject({ start: "2026-09-01", end: "2026-11-30" });
  });

  it("«в течение 60 календарных дней с даты заключения контракта» — два месяца", () => {
    expect(extractSsrTerm("Срок выполнения работ: в течение 60 (шестидесяти) календарных дней с даты заключения контракта")).toMatchObject({
      start: null,
      end: null,
      months: 2,
    });
  });

  it("«в течение 4 месяцев» — четыре месяца", () => {
    expect(extractSsrTerm("Работы должны быть выполнены в течение 4 месяцев с даты заключения контракта")).toMatchObject({ months: 4 });
  });

  it("в тексте нет срока — подсказки нет; дата без слова о сроке подсказкой не становится", () => {
    expect(extractSsrTerm("Заказчик: Администрация города. Дата публикации 01.10.2026.")).toBeNull();
    expect(extractSsrTerm("")).toBeNull();
  });
});

describe("срок работ из выбора пользователя", () => {
  it("по умолчанию сроков нет", () => {
    expect(resolveSsrPeriod(NO_ESTIMATE_OPTIONS)).toBeNull();
  });

  it("даты блока зимнего удорожания берутся для ССР, когда заданы обе", () => {
    expect(resolveSsrPeriod({ ...NO_ESTIMATE_OPTIONS, workPeriod: { start: "2026-10-01", end: "2026-11-30" } })).toEqual({ kind: "DATES", start: "2026-10-01", end: "2026-11-30" });
    expect(resolveSsrPeriod({ ...NO_ESTIMATE_OPTIONS, workPeriod: { start: "2026-10-01", end: null } })).toBeNull();
  });

  it("режимы: до даты, в месяцах, неполные значения не применяются", () => {
    const base = { ...NO_ESTIMATE_OPTIONS };
    expect(resolveSsrPeriod({ ...base, ssr: { ...DEFAULT_SSR_OPTIONS, periodMode: "UNTIL", until: "2026-11-30" } })).toEqual({ kind: "UNTIL", end: "2026-11-30" });
    expect(resolveSsrPeriod({ ...base, ssr: { ...DEFAULT_SSR_OPTIONS, periodMode: "MONTHS", months: 2 } })).toEqual({ kind: "MONTHS", months: 2 });
    expect(resolveSsrPeriod({ ...base, ssr: { ...DEFAULT_SSR_OPTIONS, periodMode: "MONTHS", months: null } })).toBeNull();
    expect(resolveSsrPeriod({ ...base, ssr: { ...DEFAULT_SSR_OPTIONS, periodMode: "UNTIL", until: null } })).toBeNull();
    expect(resolveSsrPeriod({ ...base, ssr: { ...DEFAULT_SSR_OPTIONS, periodMode: "DATES" } })).toBeNull();
  });

  it("условия ССР не считаются начислениями сверх норм: смета без выбора считается как прежде", () => {
    expect(hasEstimateOptions({ ...NO_ESTIMATE_OPTIONS, ssr: { ...DEFAULT_SSR_OPTIONS, purpose: "PRODUCTION", periodMode: "MONTHS", months: 3 } })).toBe(false);
  });
});
