import { describe, expect, it } from "vitest";
import type { Tender } from "@/domain/entities";
import {
  conditionFlags,
  deadlineCountdown,
  moneyTerms,
} from "@/domain/tenderFacts";
import { demoTenders } from "@/mocks/tenders";

const NOW = new Date("2026-10-05T12:00:00Z");
const hoursFromNow = (h: number) =>
  new Date(NOW.getTime() + h * 3600_000).toISOString();

function tender(
  patch: {
    financial?: Partial<Tender["financial"]>;
    rest?: Partial<Tender>;
  } = {},
): Tender {
  const base = demoTenders[0]!;
  return {
    ...base,
    documents: [],
    onlyForSmp: false,
    nationalRegime: false,
    ...patch.rest,
    financial: {
      ...base.financial,
      currency: "RUB",
      advancePercent: null,
      advanceAmount: null,
      bidSecurityAmount: null,
      bidSecurityPercent: null,
      contractSecurityAmount: null,
      contractSecurityPercent: null,
      treasurySupport: false,
      ...patch.financial,
    },
  };
}

describe("deadlineCountdown", () => {
  it("меньше суток — часы и красный тон", () => {
    expect(deadlineCountdown(hoursFromNow(5.5), NOW)).toEqual({
      text: "ещё 5 часов",
      tone: "danger",
    });
    expect(deadlineCountdown(hoursFromNow(0.2), NOW)?.text).toBe("ещё 1 час");
  });

  it("до трёх дней — золотой тон, дальше нейтральный", () => {
    expect(deadlineCountdown(hoursFromNow(50), NOW)).toEqual({
      text: "ещё 2 дня",
      tone: "warning",
    });
    expect(deadlineCountdown(hoursFromNow(24 * 11 + 3), NOW)).toEqual({
      text: "ещё 11 дней",
      tone: "neutral",
    });
  });

  it("истёкший срок и неразобранная дата", () => {
    expect(deadlineCountdown(hoursFromNow(-1), NOW)?.tone).toBe("closed");
    expect(deadlineCountdown("", NOW)).toBeNull();
  });
});

describe("moneyTerms", () => {
  it("неизвестные условия не печатаются", () => {
    expect(moneyTerms(tender())).toEqual([]);
  });

  it("процент предпочтительнее суммы, сумма — компактно в рублях", () => {
    expect(
      moneyTerms(
        tender({
          financial: {
            bidSecurityPercent: 1,
            bidSecurityAmount: 25_000,
            contractSecurityAmount: 5_999_732.02,
            advancePercent: 30,
          },
        }),
      ),
    ).toEqual([
      { label: "Заявка", value: "1%", quote: null },
      { label: "Контракт", value: "6 млн ₽", quote: null },
      { label: "Аванс", value: "30%", quote: null },
    ]);
  });

  it("сумма в иностранной валюте не превращается в рубли", () => {
    expect(
      moneyTerms(
        tender({ financial: { currency: "USD", bidSecurityAmount: 1000 } }),
      ),
    ).toEqual([]);
  });
});

describe("moneyTerms: условия из документации", () => {
  const doc = (required: boolean, quote: string) => ({
    required,
    percent: null,
    amount: null,
    quote,
    strong: true,
  });

  it("явный отказ в документации печатается как «нет» с цитатой", () => {
    const t = tender({
      rest: {
        documentTerms: {
          advance: doc(false, "Выплата аванса не предусмотрена"),
        },
      },
    });
    expect(moneyTerms(t)).toEqual([
      {
        label: "Аванс",
        value: "нет",
        quote: "Выплата аванса не предусмотрена",
      },
    ]);
  });

  it("значение из документации несёт цитату", () => {
    const t = tender({
      financial: { contractSecurityPercent: 5 },
      rest: {
        documentTerms: {
          contractSecurity: doc(
            true,
            "Размер обеспечения исполнения контракта 5.00%",
          ),
        },
      },
    });
    expect(moneyTerms(t)).toEqual([
      {
        label: "Контракт",
        value: "5%",
        quote: "Размер обеспечения исполнения контракта 5.00%",
      },
    ]);
  });
});

describe("conditionFlags", () => {
  it("без ограничений и документов — пусто", () => {
    expect(conditionFlags(tender())).toEqual([]);
  });

  it("СМП и нацрежим помечены ограничивающими, документы считаются", () => {
    const flags = conditionFlags(
      tender({
        rest: {
          onlyForSmp: true,
          nationalRegime: true,
          documents: demoTenders.flatMap((t) => t.documents).slice(0, 3),
        },
        financial: { treasurySupport: true },
      }),
    );
    expect(flags.map((f) => [f.label, f.restrictive])).toEqual([
      ["Только СМП", true],
      ["Нацрежим", true],
      ["Казначейство", false],
      [expect.stringMatching(/^\d+ документ/), false],
    ]);
  });
});
