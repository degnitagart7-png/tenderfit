import { describe, expect, it } from "vitest";

import { estimateOptionsSchema, hasEstimateOptions, NO_ESTIMATE_OPTIONS, normalizeEstimateOptions } from "@/domain/estimate/estimateOptions";

/** Переключатели «Добавлять вывоз мусора» и «Добавлять работы по технологии»: включены по умолчанию, хранится только снятое. */

describe("опции строк сверх ведомости", () => {
  it("по умолчанию оба поля не заданы: добавление включено, на воркер ничего не едет", () => {
    expect(NO_ESTIMATE_OPTIONS.generateDebris).toBeUndefined();
    expect(NO_ESTIMATE_OPTIONS.generateImplied).toBeUndefined();
    expect(hasEstimateOptions(NO_ESTIMATE_OPTIONS)).toBe(false);
    expect(normalizeEstimateOptions(undefined)).toEqual(NO_ESTIMATE_OPTIONS);
    expect(normalizeEstimateOptions({})).toEqual(NO_ESTIMATE_OPTIONS);
  });

  it("false сохраняется и включает передачу настроек воркеру; true — значение по умолчанию, не хранится", () => {
    const off = normalizeEstimateOptions({ generateDebris: false, generateImplied: false });
    expect(off).toMatchObject({ generateDebris: false, generateImplied: false });
    expect(hasEstimateOptions(off)).toBe(true);
    expect(hasEstimateOptions({ ...NO_ESTIMATE_OPTIONS, generateImplied: false })).toBe(true);
    expect(hasEstimateOptions({ ...NO_ESTIMATE_OPTIONS, generateDebris: false })).toBe(true);

    const on = normalizeEstimateOptions({ generateDebris: true, generateImplied: true });
    expect("generateDebris" in on).toBe(false);
    expect("generateImplied" in on).toBe(false);
  });

  it("схема принимает булево; чужой тип отбрасывается по полю, остальные настройки живут", () => {
    expect(estimateOptionsSchema.safeParse({ generateDebris: false }).success).toBe(true);
    expect(estimateOptionsSchema.safeParse({ generateDebris: "нет" }).success).toBe(false);
    const partial = normalizeEstimateOptions({ generateDebris: "нет", generateImplied: false, winterWork: "YES" });
    expect(partial).toMatchObject({ generateImplied: false, winterWork: "YES" });
    expect("generateDebris" in partial).toBe(false);
  });
});
