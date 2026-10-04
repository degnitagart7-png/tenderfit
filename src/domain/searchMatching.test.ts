import { describe, expect, it } from "vitest";
import type { SearchProfile, Tender } from "@/domain/entities";
import { UNKNOWN_REGION } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import {
  explainSearchProfileMatch,
  filterRowsByProfiles,
  matchesSearchProfile,
  summarizeSearchMatch,
} from "@/domain/searchMatching";
import { demoTenders } from "@/mocks/tenders";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { pipelineRepository } from "@/repositories/pipelineRepository";

const NOW = new Date("2026-09-21T12:00:00+03:00");

const t01 = demoTenders.find((t) => t.id === "t-01")!;
const t07 = demoTenders.find((t) => t.id === "t-07")!;

function profile(patch: Partial<SearchProfile>): SearchProfile {
  return {
    id: "sp-test",
    name: "Тестовый профиль",
    laws: ["FZ_44", "FZ_223", "PP_RF_615"],
    keywords: [],
    stopWords: [],
    okpd2Codes: [],
    regions: [],
    customerInns: [],
    minPrice: null,
    maxPrice: null,
    onlyOpenForSubmission: false,
    enabled: true,
    ...patch,
  };
}

function buildRows(): TenderRow[] {
  return demoTenders.map((tender) => ({
    tender,
    analysis: analyzeTender(tender, demoCompanyProfile),
    pipelineStatus: pipelineRepository.getStatus(tender.id),
  }));
}

describe("matchesSearchProfile", () => {
  it("пустой профиль без ограничений подходит любой закупке", () => {
    expect(matchesSearchProfile(t01, profile({}), NOW)).toBe(true);
  });

  it("ключевое слово из предмета даёт совпадение (регистронезависимо)", () => {
    expect(matchesSearchProfile(t01, profile({ keywords: ["КОМПЬЮТЕР"] }), NOW)).toBe(
      true,
    );
  });

  it("постороннее ключевое слово отсекает закупку", () => {
    expect(matchesSearchProfile(t01, profile({ keywords: ["томограф"] }), NOW)).toBe(
      false,
    );
  });

  it("стоп-слово из предмета исключает закупку даже при совпадении ключевого", () => {
    const p = profile({ keywords: ["компьютер"], stopWords: ["системных"] });
    expect(t01.subject.toLowerCase()).toContain("системных");
    expect(matchesSearchProfile(t01, p, NOW)).toBe(false);
  });

  it("закон вне списка профиля отсекает закупку", () => {
    const notT01Law = t01.law === "FZ_44" ? "FZ_223" : "FZ_44";
    expect(matchesSearchProfile(t01, profile({ laws: [notT01Law] }), NOW)).toBe(false);
  });

  it("пустой список регионов означает все регионы", () => {
    expect(matchesSearchProfile(t07, profile({ regions: [] }), NOW)).toBe(true);
  });

  it("регион вне списка отсекает закупку", () => {
    expect(
      matchesSearchProfile(t01, profile({ regions: ["Новосибирская область"] }), NOW),
    ).toBe(false);
  });

  it("ИНН заказчика из профиля даёт совпадение", () => {
    const inn = t01.customerInn!;
    expect(matchesSearchProfile(t01, profile({ customerInns: [inn] }), NOW)).toBe(true);
  });

  it("посторонний ИНН заказчика отсекает закупку", () => {
    expect(
      matchesSearchProfile(t01, profile({ customerInns: ["7708503727"] }), NOW),
    ).toBe(false);
  });

  it("пустой список ИНН заказчика означает всех заказчиков", () => {
    expect(matchesSearchProfile(t07, profile({ customerInns: [] }), NOW)).toBe(true);
  });

  it("закупка без ИНН заказчика отсекается, если в профиле заданы ИНН", () => {
    const withoutInn = { ...t01, customerInn: null };
    expect(
      matchesSearchProfile(withoutInn, profile({ customerInns: ["0000000001"] }), NOW),
    ).toBe(false);
  });

  it("границы цены включительные", () => {
    const price = t01.financial.price;
    expect(matchesSearchProfile(t01, profile({ minPrice: price, maxPrice: price }), NOW)).toBe(
      true,
    );
    expect(matchesSearchProfile(t01, profile({ maxPrice: price - 1 }), NOW)).toBe(false);
    expect(matchesSearchProfile(t01, profile({ minPrice: price + 1 }), NOW)).toBe(false);
  });

  it("неопубликованная цена не отсекает закупку границами профиля", () => {
    // Коммерческие торги Сбербанк-АСТ публикуются без цены: нуль означает
    // «не указана», а не «дешевле минимума».
    const withoutPrice: Tender = { ...t01, financial: { ...t01.financial, price: 0 } };
    expect(
      matchesSearchProfile(
        withoutPrice,
        profile({ minPrice: 30_000, maxPrice: 5_000_000 }),
        NOW,
      ),
    ).toBe(true);
  });

  it("onlyOpenForSubmission отсекает закупку с истёкшим сроком подачи", () => {
    const afterDeadline = new Date(
      new Date(t01.deadlines.submissionEnd).getTime() + 86_400_000,
    );
    expect(
      matchesSearchProfile(t01, profile({ onlyOpenForSubmission: true }), afterDeadline),
    ).toBe(false);
    expect(
      matchesSearchProfile(t01, profile({ onlyOpenForSubmission: true }), NOW),
    ).toBe(true);
  });
});

describe("filterRowsByProfiles", () => {
  const rows = buildRows();

  it("пустой список профилей возвращает все строки", () => {
    expect(filterRowsByProfiles(rows, [], NOW)).toHaveLength(rows.length);
  });

  it("профиль с ключевым словом оставляет только подходящие закупки", () => {
    const filtered = filterRowsByProfiles(rows, [profile({ keywords: ["ноутбук"] })], NOW);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(rows.length);
    for (const r of filtered) {
      expect(r.tender.subject.toLowerCase()).toContain("ноутбук");
    }
  });

  it("несколько профилей объединяются (ИЛИ)", () => {
    const byLaptop = filterRowsByProfiles(rows, [profile({ keywords: ["ноутбук"] })], NOW);
    const byServer = filterRowsByProfiles(rows, [profile({ keywords: ["сервер"] })], NOW);
    const union = filterRowsByProfiles(
      rows,
      [profile({ id: "a", keywords: ["ноутбук"] }), profile({ id: "b", keywords: ["сервер"] })],
      NOW,
    );
    const unionIds = new Set(union.map((r) => r.tender.id));
    for (const r of [...byLaptop, ...byServer]) {
      expect(unionIds.has(r.tender.id)).toBe(true);
    }
    expect(union.length).toBeGreaterThanOrEqual(
      Math.max(byLaptop.length, byServer.length),
    );
  });

  it("профиль с ИНН заказчика оставляет только его закупки", () => {
    const inn = rows[0]!.tender.customerInn!;
    const filtered = filterRowsByProfiles(rows, [profile({ customerInns: [inn] })], NOW);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.tender.customerInn).toBe(inn);
  });
});

describe("неопределённый регион", () => {
  /**
   * В живой выдаче ЕИС регионального поля нет: на 22.09.2026 «Не указан» у 109
   * закупок из 151. Фильтр, который трактует неизвестность как несовпадение,
   * молча выбрасывает 72% базы — именно так дашборд показывал «найдено 0 из 151».
   */
  const unknownRegion: Tender = { ...t01, region: UNKNOWN_REGION };

  it("закупка с неизвестным регионом проходит фильтр по региону", () => {
    expect(
      matchesSearchProfile(unknownRegion, profile({ regions: ["Республика Бурятия"] }), NOW),
    ).toBe(true);
  });

  it("проход с неизвестным регионом помечен, а не выдан за совпадение", () => {
    const explanation = explainSearchProfileMatch(
      unknownRegion,
      profile({ regions: ["Республика Бурятия"] }),
      NOW,
    );
    expect(explanation).toEqual({
      matched: true,
      rejectedBy: null,
      regionUnknown: true,
    });
  });

  it("известный и другой регион по-прежнему отсекает", () => {
    const explanation = explainSearchProfileMatch(
      t01,
      profile({ regions: ["Республика Бурятия"] }),
      NOW,
    );
    expect(explanation.matched).toBe(false);
    expect(explanation.rejectedBy).toBe("region");
  });

  it("без ограничения по региону пометка не ставится", () => {
    expect(
      explainSearchProfileMatch(unknownRegion, profile({ regions: [] }), NOW)
        .regionUnknown,
    ).toBe(false);
  });

  it("неизвестный регион не освобождает от остальных критериев", () => {
    expect(
      matchesSearchProfile(
        unknownRegion,
        profile({ regions: ["Республика Бурятия"], keywords: ["томограф"] }),
        NOW,
      ),
    ).toBe(false);
  });

  it("пустая строка региона считается неопределённой", () => {
    const blank: Tender = { ...t01, region: "  " };
    expect(
      explainSearchProfileMatch(blank, profile({ regions: ["Москва"] }), NOW),
    ).toEqual({ matched: true, rejectedBy: null, regionUnknown: true });
  });
});

describe("explainSearchProfileMatch называет критерий отклонения", () => {
  it("закон, цена, ключевое слово, стоп-слово и срок — каждый своим именем", () => {
    const cases: [SearchProfile, string][] = [
      [profile({ laws: [t01.law === "FZ_44" ? "FZ_223" : "FZ_44"] }), "law"],
      [profile({ maxPrice: t01.financial.price - 1 }), "price"],
      [profile({ minPrice: t01.financial.price + 1 }), "price"],
      [profile({ keywords: ["томограф"] }), "keyword"],
      [profile({ stopWords: ["системных"] }), "stopWord"],
      [profile({ customerInns: ["7708503727"] }), "customerInn"],
    ];
    for (const [p, expected] of cases) {
      expect(explainSearchProfileMatch(t01, p, NOW).rejectedBy).toBe(expected);
    }
  });

  it("истёкший срок подачи — критерий deadline", () => {
    const afterDeadline = new Date(
      new Date(t01.deadlines.submissionEnd).getTime() + 86_400_000,
    );
    expect(
      explainSearchProfileMatch(t01, profile({ onlyOpenForSubmission: true }), afterDeadline)
        .rejectedBy,
    ).toBe("deadline");
  });

  it("первым возвращается тот критерий, который сработал раньше", () => {
    const p = profile({
      laws: [t01.law === "FZ_44" ? "FZ_223" : "FZ_44"],
      keywords: ["томограф"],
    });
    expect(explainSearchProfileMatch(t01, p, NOW).rejectedBy).toBe("law");
  });
});

describe("summarizeSearchMatch", () => {
  const rows = buildRows();
  const withUnknownRegion: TenderRow[] = [
    ...rows,
    { ...rows[0]!, tender: { ...rows[0]!.tender, region: UNKNOWN_REGION } },
  ];

  it("без профилей всё считается совпадением", () => {
    const summary = summarizeSearchMatch(rows, [], NOW);
    expect(summary.matched).toBe(rows.length);
    expect(summary.total).toBe(rows.length);
    expect(summary.rejected).toEqual([]);
  });

  it("раскладывает отклонения по критериям и считает совпадения", () => {
    const summary = summarizeSearchMatch(
      rows,
      [profile({ keywords: ["ноутбук"] })],
      NOW,
    );
    const byKeyword = summary.rejected.find((r) => r.criterion === "keyword");
    expect(summary.matched).toBeGreaterThan(0);
    expect(byKeyword).toBeDefined();
    expect(summary.matched + summary.rejected.reduce((a, r) => a + r.count, 0)).toBe(
      rows.length,
    );
  });

  it("считает закупки с неопределённым регионом в базе и в совпадениях", () => {
    const summary = summarizeSearchMatch(
      withUnknownRegion,
      [profile({ regions: ["Республика Бурятия"] })],
      NOW,
    );
    expect(summary.unknownRegionInBase).toBe(1);
    expect(summary.requestedRegions).toEqual(["Республика Бурятия"]);
    // Единственная закупка, прошедшая фильтр по региону, — та, у которой он не определён.
    expect(summary.matched).toBe(1);
    expect(summary.matchedRegionUnknown).toBe(1);
    const byRegion = summary.rejected.find((r) => r.criterion === "region");
    expect(byRegion?.count).toBe(rows.length);
  });

  it("даёт гистограмму регионов базы, чтобы было видно, чего в ней нет", () => {
    const summary = summarizeSearchMatch(rows, [profile({})], NOW);
    const moscow = summary.regionsInBase.find((r) => r.region === "Москва");
    expect(moscow).toBeDefined();
    expect(moscow?.count).toBe(rows.filter((r) => r.tender.region === "Москва").length);
    expect(summary.regionsInBase.some((r) => r.region === UNKNOWN_REGION)).toBe(false);
    const counts = summary.regionsInBase.map((r) => r.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("регионы нескольких профилей объединяются без повторов", () => {
    const summary = summarizeSearchMatch(
      rows,
      [
        profile({ id: "a", regions: ["Москва"] }),
        profile({ id: "b", regions: ["Москва", "Приморский край"] }),
      ],
      NOW,
    );
    expect(summary.requestedRegions).toEqual(["Москва", "Приморский край"]);
  });
});
