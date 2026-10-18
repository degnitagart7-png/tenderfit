import { describe, expect, it } from "vitest";
import type { SearchProfile } from "@/domain/entities";
import {
  autoAppliedProfile,
  filtersFromSearchProfile,
  limitsFromProfile,
  profileNarrowing,
  searchWordsFromProfile,
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

/*
  Регион профиля — выбор человека, и лента его соблюдает: показывает закупки
  выбранных регионов, а регион виден чипом и снимается одним нажатием. Цену и
  заказчиков по-прежнему учитывает оценка «подходит / не подходит». Раньше регион
  тоже уходил в оценку, и по Калмыкии лента выдавала всю Россию, где закупок
  региона не было видно (замечание 05.10.2026).
*/
describe("searchWordsFromProfile", () => {
  const p = profile({
    keywords: ["строительство", "ремонт"],
    laws: ["FZ_44", "FZ_223"],
    regions: ["Москва", "Московская область"],
    customerInns: ["7708503727"],
    minPrice: 100_000,
    maxPrice: 5_000_000,
  });

  it("берёт слова, законы и регионы, строка поиска остаётся человеку", () => {
    expect(searchWordsFromProfile(p)).toEqual({
      search: "",
      searchKeywords: ["строительство", "ремонт"],
      laws: ["FZ_44", "FZ_223"],
      region: "Москва",
      regions: ["Московская область"],
      page: 1,
    });
  });

  it("регион из старого профиля приводится к каноническому названию", () => {
    expect(searchWordsFromProfile(profile({ regions: ["Калмыкия"] }))).toMatchObject({
      region: "Республика Калмыкия",
      regions: [],
    });
  });

  it("без регионов — вся Россия", () => {
    expect(searchWordsFromProfile(profile({ keywords: ["x"] }))).toMatchObject({ region: "", regions: [] });
  });

  it("заказчиков и цену не трогает: их учитывает оценка, а не отбор", () => {
    const filters = searchWordsFromProfile(p);

    expect(filters).not.toHaveProperty("customerInn");
    expect(filters).not.toHaveProperty("minPrice");
    expect(filters).not.toHaveProperty("maxPrice");
  });
});

describe("limitsFromProfile", () => {
  it("отдаёт только заказчиков и цену — без слов, законов и регионов", () => {
    const limits = limitsFromProfile(
      profile({
        keywords: ["строительство"],
        laws: ["FZ_44"],
        regions: ["Москва", "Московская область"],
        customerInns: ["7708503727"],
        minPrice: 10,
        maxPrice: 20,
      }),
    );

    expect(limits).toEqual({
      customerInn: "7708503727",
      customerInns: [],
      minPrice: 10,
      maxPrice: 20,
    });
    expect(limits).not.toHaveProperty("searchKeywords");
    expect(limits).not.toHaveProperty("laws");
    expect(limits).not.toHaveProperty("region");
  });
});

describe("profileNarrowing", () => {
  it("называет, что профиль ограничивает сверх слов и регионов", () => {
    const lines = profileNarrowing(
      profile({ regions: ["Москва", "Московская область"], maxPrice: 5_000_000, customerInns: ["7708503727"] }),
    );

    expect(lines).toEqual([
      "цена до 5 000 000 ₽",
      "заказчиков: 1",
    ]);
  });

  it("обе границы цены называются вместе", () => {
    expect(profileNarrowing(profile({ minPrice: 30_000, maxPrice: 5_000_000 }))).toEqual([
      "цена от 30 000 до 5 000 000 ₽",
    ]);
  });

  it("профиль только со словами ничего не ограничивает", () => {
    expect(profileNarrowing(profile({ keywords: ["x"] }))).toEqual([]);
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

  it("профиль без слов не применяется: искать нечего, а регион и цена отбором не служат", () => {
    expect(autoAppliedProfile([profile()])).toBeNull();
    expect(autoAppliedProfile([profile({ regions: ["Москва"] })])).toBeNull();
    expect(autoAppliedProfile([profile({ maxPrice: 5_000_000 })])).toBeNull();
  });

  it("пустой профиль в начале списка не мешает: берётся первый включённый со словами", () => {
    const chosen = autoAppliedProfile([
      profile({ id: "empty" }),
      profile({ id: "stroy", keywords: ["ремонт"], regions: ["Республика Бурятия"] }),
    ]);

    expect(chosen?.id).toBe("stroy");
  });

  it("с хотя бы одним словом применяется", () => {
    expect(autoAppliedProfile([profile({ keywords: ["вентиляция"] })])?.id).toBe("sp-1");
  });

  it("без профилей возвращает null", () => {
    expect(autoAppliedProfile([])).toBeNull();
    expect(autoAppliedProfile([profile({ enabled: false, keywords: ["x"] })])).toBeNull();
  });
});
