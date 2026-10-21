import { describe, expect, it } from "vitest";

import {
  clampCostField,
  COST_PROFILE_FIELDS,
  costFieldSpec,
  DEFAULT_COST_PROFILE,
  DEFAULT_MIN_MARGIN_PERCENT,
  effectiveMinMargin,
  isDefaultCostProfile,
  normalizeCostProfile,
  validateCostProfile,
} from "@/domain/estimate/companyCostProfile";

/*
  Профиль затрат — шесть чисел с границами. Главное свойство: что бы ни лежало в хранилище (старая схема, строки, NaN,
  выход за границы), расчёт получает осмысленный профиль, а нейтральный профиль ничего не меняет.
*/

describe("normalizeCostProfile", () => {
  it("пусто и не объект — нейтральный профиль", () => {
    expect(normalizeCostProfile(undefined)).toEqual(DEFAULT_COST_PROFILE);
    expect(normalizeCostProfile(null)).toEqual(DEFAULT_COST_PROFILE);
    expect(normalizeCostProfile("100")).toEqual(DEFAULT_COST_PROFILE);
    expect(normalizeCostProfile([])).toEqual(DEFAULT_COST_PROFILE);
  });

  it("негодные значения заменяются значением по умолчанию, годные остаются", () => {
    const result = normalizeCostProfile({ labourFactorPercent: "много", materialDiscountPercent: 12, machinesFactorPercent: Number.NaN });
    expect(result.labourFactorPercent).toBe(100);
    expect(result.materialDiscountPercent).toBe(12);
    expect(result.machinesFactorPercent).toBe(100);
  });

  it("выход за границы — ближайшая граница", () => {
    const result = normalizeCostProfile({
      overheadRealizationPercent: 900,
      materialDiscountPercent: -99,
      labourFactorPercent: 0,
      subcontractSharePercent: 140,
      subcontractPricePercent: 1,
    });
    expect(result.overheadRealizationPercent).toBe(150);
    expect(result.materialDiscountPercent).toBe(-20);
    expect(result.labourFactorPercent).toBe(30);
    expect(result.subcontractSharePercent).toBe(100);
    expect(result.subcontractPricePercent).toBe(50);
  });

  it("у каждого поля есть пояснение в одну строку и осмысленные границы", () => {
    expect(COST_PROFILE_FIELDS).toHaveLength(6);
    for (const spec of COST_PROFILE_FIELDS) {
      expect(spec.hint.length).toBeGreaterThan(20);
      expect(spec.hint).not.toContain("\n");
      expect(spec.min).toBeLessThan(spec.max);
      expect(spec.default).toBeGreaterThanOrEqual(spec.min);
      expect(spec.default).toBeLessThanOrEqual(spec.max);
      expect(costFieldSpec(spec.key)).toBe(spec);
    }
  });
});

describe("clampCostField / validateCostProfile", () => {
  it("округляет до сотых", () => {
    expect(clampCostField("materialDiscountPercent", 7.12345)).toBe(7.12);
  });

  it("validate: в границах — пусто; вне границ и не число — сообщение у поля", () => {
    expect(validateCostProfile(DEFAULT_COST_PROFILE)).toEqual({});
    const errors = validateCostProfile({ ...DEFAULT_COST_PROFILE, labourFactorPercent: 500, materialDiscountPercent: Number.NaN });
    expect(errors.labourFactorPercent).toBe("От 30 до 250 %");
    expect(errors.materialDiscountPercent).toBe("Введите число");
    expect(errors.machinesFactorPercent).toBeUndefined();
  });
});

describe("isDefaultCostProfile", () => {
  it("нейтральный профиль — по умолчанию", () => {
    expect(isDefaultCostProfile(DEFAULT_COST_PROFILE)).toBe(true);
  });

  it("цена субподряда без доли субподряда ни на что не влияет", () => {
    expect(isDefaultCostProfile({ ...DEFAULT_COST_PROFILE, subcontractPricePercent: 200 })).toBe(true);
    expect(isDefaultCostProfile({ ...DEFAULT_COST_PROFILE, subcontractSharePercent: 10, subcontractPricePercent: 200 })).toBe(false);
  });

  it("любая поправка делает профиль не нейтральным", () => {
    expect(isDefaultCostProfile({ ...DEFAULT_COST_PROFILE, materialDiscountPercent: 5 })).toBe(false);
  });
});

describe("effectiveMinMargin", () => {
  it("ноль и мусор — маржа по умолчанию, заданное остаётся", () => {
    expect(effectiveMinMargin(0)).toBe(DEFAULT_MIN_MARGIN_PERCENT);
    expect(effectiveMinMargin(-3)).toBe(DEFAULT_MIN_MARGIN_PERCENT);
    expect(effectiveMinMargin(Number.NaN)).toBe(DEFAULT_MIN_MARGIN_PERCENT);
    expect(effectiveMinMargin(15)).toBe(15);
  });
});
