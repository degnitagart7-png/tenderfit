import { describe, expect, it } from "vitest";
import {
  innSchema,
  isValidInn,
  tenderAnalysisSchema,
} from "@/domain/schemas";
import { demoTenders } from "@/mocks/tenders";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";

/**
 * Тесты Zod-схем и валидации ИНН (обязательное покрытие по правилам тестирования).
 * Контрольные литералы ИНН проверены по эталонному алгоритму контрольных чисел.
 */

describe("isValidInn — 10 знаков (юрлицо)", () => {
  it("принимает ИНН с верным контрольным числом", () => {
    expect(isValidInn("7707083893")).toBe(true);
    expect(isValidInn("7736050003")).toBe(true);
  });

  it("игнорирует пробелы при проверке", () => {
    expect(isValidInn("7707 083 893")).toBe(true);
  });

  it("отклоняет неверное контрольное число", () => {
    expect(isValidInn("7707083894")).toBe(false);
  });
});

describe("isValidInn — 12 знаков (ИП/физлицо)", () => {
  it("принимает ИНН с верными контрольными числами", () => {
    expect(isValidInn("500100732259")).toBe(true);
  });

  it("отклоняет неверное второе контрольное число", () => {
    expect(isValidInn("500100732258")).toBe(false);
  });
});

describe("isValidInn — некорректный вход", () => {
  it("неверная длина отклоняется", () => {
    expect(isValidInn("770708389")).toBe(false);
    expect(isValidInn("77070838931234")).toBe(false);
    expect(isValidInn("")).toBe(false);
  });
});

describe("innSchema", () => {
  it("принимает корректный ИНН", () => {
    expect(innSchema.safeParse("7707083893").success).toBe(true);
  });

  it("отклоняет некорректный ИНН с сообщением «Некорректный ИНН»", () => {
    const res = innSchema.safeParse("1234567890");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toBe("Некорректный ИНН");
    }
  });
});

describe("tenderAnalysisSchema", () => {
  it("результат анализа демо-закупки проходит валидацию", () => {
    const analysis = analyzeTender(demoTenders[0]!, demoCompanyProfile);
    expect(() => tenderAnalysisSchema.parse(analysis)).not.toThrow();
  });

  it("все демо-закупки валидируются схемой", () => {
    for (const tender of demoTenders) {
      const analysis = analyzeTender(tender, demoCompanyProfile);
      expect(tenderAnalysisSchema.safeParse(analysis).success).toBe(true);
    }
  });

  it("отклоняет fitScore вне диапазона 0..100", () => {
    const analysis = analyzeTender(demoTenders[0]!, demoCompanyProfile);
    expect(
      tenderAnalysisSchema.safeParse({ ...analysis, fitScore: 150 }).success,
    ).toBe(false);
  });

  it("отклоняет неизвестный вердикт", () => {
    const analysis = analyzeTender(demoTenders[0]!, demoCompanyProfile);
    expect(
      tenderAnalysisSchema.safeParse({ ...analysis, verdict: "MAYBE" }).success,
    ).toBe(false);
  });

  it("отклоняет пустой summary", () => {
    const analysis = analyzeTender(demoTenders[0]!, demoCompanyProfile);
    expect(
      tenderAnalysisSchema.safeParse({ ...analysis, summary: "" }).success,
    ).toBe(false);
  });
});
