import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { SearchProfile, Tender } from "@/domain/entities";
import { UNKNOWN_REGION } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import { summarizeSearchMatch } from "@/domain/searchMatching";
import { demoTenders } from "@/mocks/tenders";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { pipelineRepository } from "@/repositories/pipelineRepository";
import { SearchEmptyExplanation } from "@/components/dashboard/SearchEmptyExplanation";
import { pluralRu } from "@/utils/format";

const NOW = new Date("2026-09-21T12:00:00+03:00");

/** «20 закупок», «1 закупка» — та же форма, что рисует компонент. */
const tendersWord = (n: number) =>
  `${n} ${pluralRu(n, ["закупка", "закупки", "закупок"])}`;

function buildRows(): TenderRow[] {
  return demoTenders.map((tender) => ({
    tender,
    analysis: analyzeTender(tender, demoCompanyProfile),
    pipelineStatus: pipelineRepository.getStatus(tender.id),
  }));
}

function profile(patch: Partial<SearchProfile>): SearchProfile {
  return {
    id: "sp-test",
    name: "Тестовый профиль",
    laws: ["FZ_44", "FZ_223", "PP_RF_615", "COMMERCIAL"],
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

/**
 * Текст блока целиком, с схлопнутыми пробелами: подписи собраны из нескольких
 * JSX-узлов, поэтому искать их нужно по textContent, а не по отдельным нодам.
 */
function textOf(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

function renderSummary(rows: TenderRow[], profiles: SearchProfile[]) {
  const { container } = render(
    <SearchEmptyExplanation summary={summarizeSearchMatch(rows, profiles, NOW)} />,
  );
  return textOf(container);
}

describe("SearchEmptyExplanation", () => {
  const rows = buildRows();

  it("называет критерий и число отклонённых им закупок", () => {
    const text = renderSummary(rows, [profile({ keywords: ["томограф"] })]);
    expect(text).toContain("ни одно ключевое слово профиля не встретилось в предмете");
    expect(text).toContain(tendersWord(rows.length));
  });

  it("объясняет, что запрошенного региона в базе нет вовсе", () => {
    const text = renderSummary(rows, [profile({ regions: ["Республика Бурятия"] })]);
    expect(text).toContain("Профиль ограничивает регионы: Республика Бурятия");
    expect(text).toContain("Из этих регионов в базе пока нет ни одной закупки");
    expect(text).toContain("Регионы, которые в базе есть:");
    expect(text).toContain("Москва");
  });

  it("называет запрошенный регион, который в базе есть, с количеством", () => {
    const moscow = rows.filter((r) => r.tender.region === "Москва").length;
    const text = renderSummary(rows, [profile({ regions: ["Москва"] })]);
    expect(text).toContain(`Из этих регионов в базе: Москва (${moscow})`);
    expect(text).toContain("регион закупки не совпадает с указанными в профиле");
  });

  it("показывает закупки с неопределённым регионом как оговорку, а не как потерю", () => {
    const unknown: Tender = { ...rows[0]!.tender, region: UNKNOWN_REGION };
    const withUnknown: TenderRow[] = [...rows, { ...rows[0]!, tender: unknown }];
    const text = renderSummary(withUnknown, [profile({ regions: ["Республика Бурятия"] })]);
    expect(text).toContain(`с регионом «${UNKNOWN_REGION}»`);
    expect(text).toContain("они проходят фильтр по региону");
    // Все закупки с известным и чужим регионом отклонены, одна неизвестная — прошла.
    expect(text).toContain(tendersWord(rows.length));
  });

  it("без ограничения по региону не выдумывает разговор про регионы", () => {
    const text = renderSummary(rows, [profile({ keywords: ["томограф"] })]);
    expect(text).not.toContain("Профиль ограничивает регионы");
    expect(text).not.toContain("Регионы, которые в базе есть");
  });

  it("при пустой базе не рисует ничего", () => {
    const { container } = render(
      <SearchEmptyExplanation
        summary={summarizeSearchMatch([], [profile({ regions: ["Москва"] })], NOW)}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
