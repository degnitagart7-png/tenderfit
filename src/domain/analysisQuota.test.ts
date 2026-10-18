import { describe, expect, it } from "vitest";
import { DAILY_ANALYSIS_LIMIT, GLOBAL_DAILY_ANALYSIS_LIMIT, analysisQuota, moscowDayStart, userAnalysisQuota } from "./analysisQuota";

describe("moscowDayStart", () => {
  it("днём по UTC возвращает московскую полночь того же дня", () => {
    // 12:00 UTC = 15:00 по Москве: эти сутки начались накануне в 21:00 UTC.
    expect(moscowDayStart(new Date("2026-09-22T12:00:00.000Z")).toISOString()).toBe(
      "2026-09-21T21:00:00.000Z",
    );
  });

  it("после 21:00 UTC сутки уже следующие по Москве", () => {
    // 22:30 UTC 22 сентября = 01:30 23 сентября по Москве.
    expect(moscowDayStart(new Date("2026-09-22T22:30:00.000Z")).toISOString()).toBe(
      "2026-09-22T21:00:00.000Z",
    );
  });

  it("ровно в московскую полночь начинает новые сутки", () => {
    expect(moscowDayStart(new Date("2026-09-22T21:00:00.000Z")).toISOString()).toBe(
      "2026-09-22T21:00:00.000Z",
    );
  });

  it("начало суток не позже самого момента", () => {
    const now = new Date("2026-09-22T05:00:00.000Z");
    expect(moscowDayStart(now).getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

describe("analysisQuota", () => {
  it("в начале дня доступны все 15 разборов", () => {
    expect(analysisQuota(0)).toEqual({ allowed: true, remaining: 15, reason: null });
  });

  it("последний доступный разбор пропускает", () => {
    expect(analysisQuota(DAILY_ANALYSIS_LIMIT - 1)).toEqual({
      allowed: true,
      remaining: 1,
      reason: null,
    });
  });

  it("на исчерпанном лимите отказывает и объясняет, когда можно снова", () => {
    const quota = analysisQuota(DAILY_ANALYSIS_LIMIT);

    expect(quota.allowed).toBe(false);
    expect(quota.remaining).toBe(0);
    expect(quota.reason).toContain("15");
    expect(quota.reason).toContain("Москве");
  });

  it("остаток не уходит в минус, даже если задач поставили больше лимита", () => {
    expect(analysisQuota(45).remaining).toBe(0);
  });

  it("отрицательный счётчик не даёт лимита больше заданного", () => {
    expect(analysisQuota(-5).remaining).toBe(DAILY_ANALYSIS_LIMIT);
  });

  it("лимит задаётся параметром: правило не зашито в текст", () => {
    expect(analysisQuota(2, 2).allowed).toBe(false);
    expect(analysisQuota(1, 2)).toEqual({ allowed: true, remaining: 1, reason: null });
  });
});

describe("userAnalysisQuota: 15 в сутки на человека (с 18.10.2026)", () => {
  it("свой лимит не зависит от чужих разборов", () => {
    expect(userAnalysisQuota({ userUsed: 3, globalUsed: 150 })).toEqual({ allowed: true, remaining: 12, reason: null });
  });
  it("свои 15 исчерпаны — отказ с понятной причиной", () => {
    const quota = userAnalysisQuota({ userUsed: 15, globalUsed: 40 });
    expect(quota.allowed).toBe(false);
    expect(quota.reason).toContain("Ваш суточный лимит");
  });
  it("общий аварийный потолок перекрывает свой лимит", () => {
    const quota = userAnalysisQuota({ userUsed: 0, globalUsed: GLOBAL_DAILY_ANALYSIS_LIMIT });
    expect(quota.allowed).toBe(false);
    expect(quota.reason).toContain("общий суточный лимит");
  });
  it("без пользователя (служебный ключ) — только общий потолок", () => {
    expect(userAnalysisQuota({ userUsed: null, globalUsed: 25 })).toMatchObject({ allowed: true, remaining: GLOBAL_DAILY_ANALYSIS_LIMIT - 25 });
  });
  it("остаток не больше общего", () => {
    expect(userAnalysisQuota({ userUsed: 0, globalUsed: GLOBAL_DAILY_ANALYSIS_LIMIT - 5 }).remaining).toBe(5);
  });
});
