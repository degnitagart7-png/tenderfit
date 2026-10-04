import { describe, expect, it } from "vitest";
import type { SearchProfile } from "@/domain/entities";
import {
  autoAppliedProfile,
  filtersFromSearchProfile,
} from "@/domain/searchProfileFilters";

function profile(overrides: Partial<SearchProfile> = {}): SearchProfile {
  return {
    id: "sp-1",
    name: "Вентиляция",
    laws: [],
    keywords: [],
    stopWords: [],
    okpd2Codes: [],
    regions: [],
    customerInns: [],
    minPrice: null,
    maxPrice: null,
    onlyOpenForSubmission: true,
    enabled: true,
    ...overrides,
  };
}

describe("filtersFromSearchProfile", () => {
  /*
    Все слова профиля — «любое из», строка поиска остаётся пустой.

    Раньше первое слово уходило в строку поиска, остальные — в дополнительные.
    Пока строка и дополнительные означали одно и то же («любое слово»), это
    было незаметно. Когда слова строки стали складываться по «и», первое слово
    профиля превратилось в обязательное, а остальные — в «хотя бы одно из»:
    профиль «Юридические услуги, юристы» перестал находить что-либо, а строка
    поиска оказалась занята чужим текстом, поверх которого человеку приходилось
    печатать своё.
  */
  it("все слова профиля идут в ключевые, строка поиска остаётся пустой", () => {
    const f = filtersFromSearchProfile(
      profile({ keywords: ["вентиляция", "кондиционирование", "воздуховод"] }),
    );
    expect(f.search).toBe("");
    expect(f.searchKeywords).toEqual(["вентиляция", "кондиционирование", "воздуховод"]);
  });

  it("многословное ключевое слово переносится целиком", () => {
    const f = filtersFromSearchProfile(profile({ keywords: ["Юридические услуги", "юристы"] }));
    expect(f.searchKeywords).toEqual(["Юридические услуги", "юристы"]);
  });

  it("первый регион идёт в выпадающий список, остальные — дополнительными", () => {
    const f = filtersFromSearchProfile(profile({ regions: ["Москва", "Тверская область"] }));
    expect(f.region).toBe("Москва");
    expect(f.regions).toEqual(["Тверская область"]);
  });

  it("пустой профиль не подставляет мусор в поля", () => {
    const f = filtersFromSearchProfile(profile());
    expect(f.search).toBe("");
    expect(f.region).toBe("");
    expect(f.customerInn).toBe("");
    expect(f.searchKeywords).toEqual([]);
  });

  it("ценовые границы переносятся как есть, включая отсутствие границы", () => {
    const f = filtersFromSearchProfile(profile({ minPrice: 100_000, maxPrice: null }));
    expect(f.minPrice).toBe(100_000);
    expect(f.maxPrice).toBeNull();
  });

  it("выдача возвращается на первую страницу", () => {
    expect(filtersFromSearchProfile(profile({ keywords: ["вентиляция"] })).page).toBe(1);
  });
});

describe("autoAppliedProfile", () => {
  it("берёт первый включённый — тот же, что тратит бюджет на кнопке поиска", () => {
    const chosen = autoAppliedProfile([
      profile({ id: "off", enabled: false, keywords: ["выключенный"] }),
      profile({ id: "on", keywords: ["вентиляция"] }),
      profile({ id: "second", keywords: ["второй"] }),
    ]);
    expect(chosen?.id).toBe("on");
  });

  it("профиль без единого ограничения не применяется", () => {
    // Иначе на выдачу вешается чип, который ничего не меняет.
    expect(autoAppliedProfile([profile()])).toBeNull();
  });

  it("ограничением считается не только слово, но и регион или цена", () => {
    expect(autoAppliedProfile([profile({ regions: ["Москва"] })])?.id).toBe("sp-1");
    expect(autoAppliedProfile([profile({ maxPrice: 5_000_000 })])?.id).toBe("sp-1");
  });

  it("без профилей возвращает null", () => {
    expect(autoAppliedProfile([])).toBeNull();
    expect(autoAppliedProfile([profile({ enabled: false, keywords: ["x"] })])).toBeNull();
  });
});
