import { describe, expect, it } from "vitest";
import type { CompanyProfile, SearchProfile } from "@/domain/entities";
import {
  defaultFilters,
  searchRows,
  sortSearched,
  type SearchedRow,
  type TenderRow,
} from "@/domain/filtering";
import {
  hiddenReasonsText,
  nonContractReason,
  profileIsContractor,
  tenderNature,
  worksIntent,
  type NonContractNature,
  type ProcurementNature,
} from "@/domain/procurementNature";
import { limitsFromProfile, searchWordsFromProfile } from "@/domain/searchProfileFilters";
import { analyzeTender } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { dbRowToTender } from "@/services/tenderApiService";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import type { TenderRow as TenderRowDB } from "@/types/database";
import fixture from "@/domain/__fixtures__/feed/stroyka-buryatia-mo-2026-10-14.json";

/*
  Регрессия ленты владельца, замер 14.10.2026: профиль «Строительство и ремонт»
  (Бурятия + Московская область) нашёл 173 закупки из 1693, показал 115, и 76 из
  них (66 %) — «Приобретение в муниципальную собственность … жилого помещения …
  у Застройщика» (долевое строительство). Подрядчик в них участвовать не может,
  а Fit Score у них 83 — выше настоящих работ (82), поэтому три первые страницы
  занимали квартиры. Фикстура — те самые 173 найденные строки из базы
  (публичные данные закупок).

  Шаги ленты повторяют TendersView: слова профиля → searchRows → ограничения
  профиля → «не подряд» → «Не подходит» → сортировка по Fit Score.
*/

const NOW = new Date("2026-10-14T00:00:00+03:00");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Профиль поиска владельца в том виде, в каком он лежит в базе. */
const searchProfile: SearchProfile = {
  id: "sp-stroyka",
  name: "Строительство и ремонт",
  laws: [],
  keywords: ["Строительные работы", "Капитальное строительство", "Строительство"],
  stopWords: [],
  okpd2Codes: [],
  regions: ["Республика Бурятия", "Московская область"],
  customerInns: [],
  minPrice: null,
  maxPrice: null,
  onlyOpenForSubmission: false,
  enabled: true,
};

/** Синтетический подрядчик: строительство и ремонт, Бурятия + Московская область. */
const contractorProfile: CompanyProfile = {
  ...demoCompanyProfile,
  legalName: "ООО «Тестовый подрядчик»",
  activityDescription:
    "Строительство и капитальный ремонт зданий и сооружений, текущий ремонт помещений, благоустройство территорий, газоснабжение.",
  capabilities: {
    ...demoCompanyProfile.capabilities,
    products: [],
    works: ["строительно-монтажные работы", "капитальный ремонт", "текущий ремонт", "благоустройство"],
    services: [],
    keywords: ["строительство", "ремонт", "капитальный ремонт", "благоустройство"],
    synonyms: [],
    stopWords: [],
    okpd2Codes: ["41.20", "43.99", "42.11"],
  },
  restrictions: {
    ...demoCompanyProfile.restrictions,
    minPrice: 10_000,
    maxPrice: 50_000_000_000,
    workRegions: ["Республика Бурятия", "Московская область"],
    customerBlacklist: [],
    custom: [],
  },
  preferences: {
    ...demoCompanyProfile.preferences,
    priorityRegions: ["Республика Бурятия", "Московская область"],
    preferredMinPrice: 10_000,
    preferredMaxPrice: 50_000_000_000,
    notes: [],
  },
  licenses: [],
};

interface Feed {
  rows: TenderRow[];
  found: SearchedRow[];
  shown: SearchedRow[];
  hidden: { limits: number; fit: number; nature: Map<string, NonContractNature> };
}

function buildFeed(profile: CompanyProfile = contractorProfile): Feed {
  const rows: TenderRow[] = (fixture as unknown as TenderRowDB[]).map((db) => {
    const tender = dbRowToTender(db);
    return { tender, analysis: analyzeTender(tender, profile), pipelineStatus: "NEW" as const };
  });
  const filters = { ...defaultFilters, ...searchWordsFromProfile(searchProfile) };
  const found = searchRows(rows, filters);
  const limitIds = new Set(
    searchRows(rows, { ...filters, ...limitsFromProfile(searchProfile) }).map((h) => h.row.tender.id),
  );
  const words = [filters.search, ...filters.searchKeywords].filter((w) => w.trim() !== "");
  const contractor = profileIsContractor(profile);

  const hidden = { limits: 0, fit: 0, nature: new Map<string, NonContractNature>() };
  const shown: SearchedRow[] = [];
  for (const hit of found) {
    const id = hit.row.tender.id;
    if (!limitIds.has(id)) {
      hidden.limits += 1;
      continue;
    }
    const reason = nonContractReason(hit.row.tender, { words, contractor });
    if (reason !== null) {
      hidden.nature.set(id, reason);
    } else if (hit.row.analysis.verdict === "NOT_RECOMMENDED") {
      hidden.fit += 1;
    } else shown.push(hit);
  }
  return { rows, found, shown: sortSearched(shown, "fitScore", "desc", undefined, {
      now: NOW,
      preferWorks: worksIntent(words, contractor),
    }), hidden };
}

function natureOf(hit: SearchedRow): ProcurementNature {
  return tenderNature(hit.row.tender);
}

describe("лента «Строительство и ремонт» (Бурятия + МО), замер 14.10.2026", () => {
  const feed = buildFeed();

  it("фикстура — все 173 найденные строки, и профиль находит их все", () => {
    expect(feed.rows).toHaveLength(173);
    expect(feed.found.length).toBe(173);
  });

  it("в показанном нет покупки квартир и мониторинга цен", () => {
    const bad = feed.shown.filter((h) => ["REAL_ESTATE", "PRICE_MONITORING"].includes(natureOf(h)));
    expect(bad.map((h) => h.row.tender.subject)).toEqual([]);
  });

  it("покупка квартир не пропала молча: она посчитана в скрытых", () => {
    const flats = feed.found.filter((h) => natureOf(h) === "REAL_ESTATE");
    // Замер: 76 из 115 показанных, остальные 97 и есть квартиры + мониторинг цен.
    expect(flats.length).toBeGreaterThanOrEqual(70);
    const hiddenFlats = [...feed.hidden.nature.values()].filter((n) => n === "REAL_ESTATE").length;
    expect(hiddenFlats).toBe(flats.length);
    const monitoring = feed.found.filter((h) => natureOf(h) === "PRICE_MONITORING");
    expect(monitoring.length).toBeGreaterThan(0);
    expect([...feed.hidden.nature.values()].filter((n) => n === "PRICE_MONITORING").length).toBe(
      monitoring.length,
    );
    expect(
      hiddenReasonsText({
        limits: feed.hidden.limits,
        fit: feed.hidden.fit,
        nature: { REAL_ESTATE: hiddenFlats, PRICE_MONITORING: monitoring.length },
      }),
    ).toContain("не подряд: покупка квартир и помещений, мониторинг цен");
  });

  it("первые 10 — подряд, и до конца подачи не меньше двух суток", () => {
    const top = feed.shown.slice(0, 10);
    expect(top).toHaveLength(10);
    for (const hit of top) {
      expect(natureOf(hit), hit.row.tender.subject).toBe("WORKS");
      const left = new Date(hit.row.tender.deadlines.submissionEnd).getTime() - NOW.getTime();
      expect(left, hit.row.tender.subject).toBeGreaterThanOrEqual(2 * DAY_MS);
    }
  });

  it("постоянное предложение (срок дальше года, цены нет) не возглавляет ленту", () => {
    const index = feed.shown.findIndex((h) => h.row.tender.subject.includes("Т2 МОБАЙЛ"));
    expect(index).toBeGreaterThan(10);
  });

  it("закрывающиеся в ближайшие двое суток и закрытые идут после остальных", () => {
    const ends = feed.shown.map((h) => new Date(h.row.tender.deadlines.submissionEnd).getTime() - NOW.getTime());
    const tier = (ms: number): number => (Number.isNaN(ms) ? 0 : ms <= 0 ? 2 : ms < 2 * DAY_MS ? 1 : 0);
    const tiers = ends.map(tier);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
  });
});

describe("человек сам просит квартиры или мониторинг цен", () => {
  const flat = buildFeed().found.find((h) => natureOf(h) === "REAL_ESTATE")!.row.tender;
  const monitoring = buildFeed().found.find((h) => natureOf(h) === "PRICE_MONITORING")!.row.tender;

  it("по умолчанию для подрядчика прячутся", () => {
    expect(nonContractReason(flat, { words: ["Строительство"], contractor: true })).toBe("REAL_ESTATE");
    expect(nonContractReason(monitoring, { words: ["Строительство"], contractor: true })).toBe("PRICE_MONITORING");
  });

  it("слова «квартиры» и «мониторинг цен» в запросе возвращают их", () => {
    expect(nonContractReason(flat, { words: ["квартиры"], contractor: true })).toBeNull();
    expect(nonContractReason(flat, { words: ["долевое строительство"], contractor: true })).toBeNull();
    expect(nonContractReason(monitoring, { words: ["мониторинг цен"], contractor: true })).toBeNull();
  });

  it("запрос не про подряд и компания не подрядчик — ничего не прячем", () => {
    expect(nonContractReason(flat, { words: ["вентиль"], contractor: false })).toBeNull();
    expect(nonContractReason(monitoring, { words: [], contractor: false })).toBeNull();
  });

  it("компания-подрядчик прячет и без запроса", () => {
    expect(nonContractReason(flat, { words: [], contractor: true })).toBe("REAL_ESTATE");
  });
});
