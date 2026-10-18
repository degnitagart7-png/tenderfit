import { describe, expect, it } from "vitest";

import { auditCustomerLsr } from "@/domain/estimate/customerAudit";
import { parseCustomerLsr, type CustomerLsr } from "@/domain/estimate/customerLsr";
import { REAL_A_WITH_TOTALS } from "@/domain/estimate/customerLsr.fixtures";
import { makeBook } from "@/test/auditPriceBook";

/*
  Аудит сметы заказчика: зимнее удорожание, временные здания и коэффициенты условий работ сверяются
  с приказами 325/пр, 332/пр и 421/пр — справкой со ссылкой на пункт (INFO).
*/

function parse(text: string): CustomerLsr {
  const { estimates } = parseCustomerLsr([{ name: "смета.xlsx", text }]);
  expect(estimates).toHaveLength(1);
  return estimates[0] as CustomerLsr;
}

const A = parse(REAL_A_WITH_TOTALS);

describe("итоги заказчика: проценты зимнего и временных зданий", () => {
  it("без таких строк в смете поля нет и находок нет", () => {
    expect(A.limitedCosts).toBeUndefined();
    const report = auditCustomerLsr(A, { priceBook: makeBook() });
    expect(report.findings.some((finding) => finding.type === "LIMITED_COSTS")).toBe(false);
  });

  it("строки «Зимнее удорожание 3 %» и «Временные здания и сооружения 2,5 %» читаются из текста сметы", () => {
    const withLines = parse(`${REAL_A_WITH_TOTALS}\nЗимнее удорожание, 3 % 1 234,00\nВременные здания и сооружения, 2,5 % 987,00`);
    expect(withLines.limitedCosts?.winter?.percent).toBe(3);
    expect(withLines.limitedCosts?.temporary?.percent).toBe(2.5);
  });
});

describe("аудит: находки LIMITED_COSTS", () => {
  const lsr = (patch: Partial<CustomerLsr>): CustomerLsr => ({ ...A, ...patch });

  it("«временные 3 % при нормативе 0,9 % для капремонта жилого дома» — INFO со ссылкой на приказ и суммой", () => {
    const report = auditCustomerLsr(
      lsr({
        estimateName: "Капитальный ремонт многоквартирного дома",
        limitedCosts: { winter: null, temporary: { percent: 3, quote: "Временные здания и сооружения 3 %" } },
      }),
      { priceBook: makeBook() },
    );
    const found = report.findings.find((finding) => finding.type === "LIMITED_COSTS");
    expect(found?.severity).toBe("INFO");
    expect(found?.message).toContain("завышено");
    expect(found?.message).toContain("332/пр, приложение 2, п. 1.1");
  });

  it("снос в Иркутской области: зимнее заказчика сверяется с п. 88 приложения 1 и V температурной зоной", () => {
    const report = auditCustomerLsr(
      lsr({
        estimateName: "Снос (демонтаж) объекта капитального строительства",
        limitedCosts: { winter: { percent: 6.77, quote: "Зимнее удорожание 6,77 %" }, temporary: null },
      }),
      { priceBook: makeBook(), subject: "Иркутская область" },
    );
    const found = report.findings.find((finding) => finding.type === "LIMITED_COSTS");
    expect(found?.message).toContain("совпадает");
    expect(found?.message).toContain("приложение 1, п. 88");
  });
});

describe("аудит: коэффициенты позиции сверяются с приложением 10", () => {
  it("коэффициент в обосновании → в сообщении таблицы и пункты приложения 10 к 421/пр", () => {
    const first = A.positions[0]!;
    const withCoefficients: CustomerLsr = {
      ...A,
      positions: [{ ...first, hasCoefficients: true, coefficients: "ОЗП=1,15; ЭМ=1,25" }, ...A.positions.slice(1)],
    };
    const report = auditCustomerLsr(withCoefficients, { priceBook: makeBook() });
    const found = report.findings.find((finding) => finding.type === "COEFFICIENTS");
    expect(found?.severity).toBe("INFO");
    expect(found?.message).toContain("к затратам применены коэффициенты: ОЗП=1,15; ЭМ=1,25");
    expect(found?.message).toContain("По приложению 10 к 421/пр");
  });
});
