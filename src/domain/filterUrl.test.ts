import { describe, expect, it } from "vitest";
import { defaultFilters, type TenderFilters } from "@/domain/filtering";
import {
  countActiveFilters,
  filtersFromSearchParams,
  filtersToSearchParams,
} from "@/domain/filterUrl";

function roundTrip(filters: TenderFilters): TenderFilters {
  return filtersFromSearchParams(filtersToSearchParams(filters));
}

describe("filtersToSearchParams / filtersFromSearchParams", () => {
  it("фильтры по умолчанию не дают параметров", () => {
    expect(filtersToSearchParams(defaultFilters).toString()).toBe("");
  });

  it("полный набор ограничений переживает путь туда и обратно", () => {
    const filters: TenderFilters = {
      ...defaultFilters,
      search: "ноутбук",
      searchKeywords: ["принтер", "МФУ"],
      laws: ["FZ_223", "COMMERCIAL"],
      region: "Москва",
      regions: ["Санкт-Петербург"],
      customerInn: "7708503727",
      customerInns: ["7812345678"],
      sources: ["SBER_AST"],
      minPrice: 30000,
      maxPrice: 5000000,
      verdict: "RECOMMENDED",
      closingSoonOnly: true,
      hasHardBlockers: false,
      hasAdvance: true,
      hasSecurity: null,
      pipelineStatus: "INTERESTING",
      sortField: "price",
      sortDir: "asc",
      page: 3,
      pageSize: 25,
    };
    expect(roundTrip(filters)).toEqual(filters);
  });

  it("множественные значения из профиля поиска попадают в URL списком", () => {
    const params = filtersToSearchParams({
      ...defaultFilters,
      searchKeywords: ["принтер", "МФУ"],
      regions: ["Москва", "Тверская область"],
    });
    expect(params.get("q2")).toBe("принтер,МФУ");
    expect(params.get("reg2")).toBe("Москва,Тверская область");
  });

  it("мусор в адресе отбрасывается, а не ломает выдачу", () => {
    const params = new URLSearchParams(
      "law=FOO,FZ_44&verdict=NOPE&pipe=UNKNOWN&src=HACK&pmin=-5&page=0&page=abc&dir=up&size=9999&inn=ab77cd08",
    );
    const parsed = filtersFromSearchParams(params);
    expect(parsed.laws).toEqual(["FZ_44"]);
    expect(parsed.verdict).toBe("ALL");
    expect(parsed.pipelineStatus).toBe("ALL");
    expect(parsed.sources).toEqual([]);
    expect(parsed.minPrice).toBeNull();
    expect(parsed.page).toBe(1);
    expect(parsed.sortDir).toBe(defaultFilters.sortDir);
    expect(parsed.pageSize).toBeLessThanOrEqual(100);
    expect(parsed.customerInn).toBe("7708");
  });

  it("параметры поиска переживают путь туда и обратно", () => {
    const filters: TenderFilters = {
      ...defaultFilters,
      search: "вентиль",
      excludeKeywords: ["аренда", "б/у"],
      exactMatch: true,
      scopes: ["subject", "documents"],
      sortField: "relevance",
    };
    expect(roundTrip(filters)).toEqual(filters);
  });

  it("переключатели цены записываются только когда выключены", () => {
    // Умолчание — показывать всё, поэтому чистая ссылка остаётся без параметров.
    expect(filtersToSearchParams(defaultFilters).get("noprice")).toBeNull();
    expect(filtersToSearchParams(defaultFilters).get("fx")).toBeNull();

    const params = filtersToSearchParams({
      ...defaultFilters,
      includeNoPrice: false,
      includeForeignCurrency: false,
    });
    expect(params.get("noprice")).toBe("hide");
    expect(params.get("fx")).toBe("hide");
    expect(
      filtersFromSearchParams(params).includeNoPrice,
    ).toBe(false);
    expect(
      filtersFromSearchParams(params).includeForeignCurrency,
    ).toBe(false);
  });

  it("мусор в параметрах поиска не прячет закупки", () => {
    // Опечатка в ссылке не должна молча сужать выдачу: неизвестная область
    // отбрасывается (значит «все»), неизвестное значение переключателя цены
    // трактуется как «показывать».
    const parsed = filtersFromSearchParams(
      new URLSearchParams("scope=HACK,subject&noprice=yes&fx=0&exact=true"),
    );
    expect(parsed.scopes).toEqual(["subject"]);
    expect(parsed.includeNoPrice).toBe(true);
    expect(parsed.includeForeignCurrency).toBe(true);
    expect(parsed.exactMatch).toBe(false);
  });

  it("список исключений попадает в URL отдельным параметром", () => {
    const params = filtersToSearchParams({
      ...defaultFilters,
      search: "вентиль",
      excludeKeywords: ["аренда", "б/у"],
    });
    expect(params.get("q")).toBe("вентиль");
    expect(params.get("x")).toBe("аренда,б/у");
  });
});

describe("countActiveFilters", () => {
  it("закон не считается ограничением панели: у него свой переключатель", () => {
    expect(countActiveFilters({ ...defaultFilters, laws: ["FZ_44"] })).toBe(0);
  });

  it("каждое действующее ограничение даёт единицу", () => {
    const filters: TenderFilters = {
      ...defaultFilters,
      search: "ноутбук",
      region: "Москва",
      minPrice: 1,
      closingSoonOnly: true,
    };
    expect(countActiveFilters(filters)).toBe(4);
  });

  it("скрытые множественные значения тоже видны в счётчике", () => {
    expect(
      countActiveFilters({ ...defaultFilters, searchKeywords: ["принтер"] }),
    ).toBe(1);
  });

  it("параметры поиска считаются ограничениями", () => {
    expect(countActiveFilters({ ...defaultFilters, excludeKeywords: ["аренда"] })).toBe(1);
    expect(countActiveFilters({ ...defaultFilters, exactMatch: true })).toBe(1);
    expect(countActiveFilters({ ...defaultFilters, scopes: ["subject"] })).toBe(1);
  });

  it("выключенный переключатель цены — ограничение, включённый — нет", () => {
    expect(countActiveFilters(defaultFilters)).toBe(0);
    expect(countActiveFilters({ ...defaultFilters, includeNoPrice: false })).toBe(1);
    expect(
      countActiveFilters({ ...defaultFilters, includeForeignCurrency: false }),
    ).toBe(1);
  });
});

describe("параметр партии прогона", () => {
  const STAMP = "2026-09-25T14:52:03.000Z";

  it("метка партии переживает путь туда и обратно", () => {
    const filters: TenderFilters = { ...defaultFilters, batchStamp: STAMP };

    expect(filtersToSearchParams(filters).get("batch")).toBe(STAMP);
    expect(roundTrip(filters)).toEqual(filters);
  });

  it("без метки параметра в адресе нет", () => {
    expect(filtersToSearchParams(defaultFilters).has("batch")).toBe(false);
    expect(filtersFromSearchParams(new URLSearchParams("")).batchStamp).toBeNull();
  });

  it("метка партии считается действующим ограничением", () => {
    expect(countActiveFilters({ ...defaultFilters, batchStamp: STAMP })).toBe(1);
  });
});
