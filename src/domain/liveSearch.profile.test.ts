import { describe, expect, it } from "vitest";

import type { CompanyProfile, SearchProfile } from "@/domain/entities";
import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import {
  MAX_PROFILE_KEYWORDS,
  buildLiveProfile,
  buildProfileSearchRequest,
  normalizeLiveOkpd2,
  normalizeLiveSynonyms,
} from "@/domain/liveSearch";

/**
 * Кнопка «Найти новые закупки» ищет по профилю человека, а не общим обходом.
 *
 * Профиль ниже повторяет тестировщика 23.10.2026: профиль поиска «ремонт
 * помещений» по Бурятии, в профиле компании коды 41, 42, 43 и описание
 * деятельности. Общий обход их не видел: коды не участвовали, а регион
 * подменялся темами всех посетителей (Москва, Подмосковье).
 */
const searchProfile: SearchProfile = {
  id: "sp-1",
  name: "ремонт помещений",
  laws: ["FZ_44", "FZ_223", "COMMERCIAL"],
  keywords: ["ремонт", "строитель", "реконструкция", "модернизация", "монтаж"],
  stopWords: [],
  okpd2Codes: [],
  regions: ["Республика Бурятия"],
  customerInns: [],
  minPrice: null,
  maxPrice: null,
  onlyOpenForSubmission: true,
  enabled: true,
};

const company: CompanyProfile = {
  ...emptyCompanyProfile,
  activityDescription: "ремонт помещений, строительство, монтаж сетей",
  capabilities: { ...emptyCompanyProfile.capabilities, okpd2Codes: ["41", "42", "43"] },
  restrictions: { ...emptyCompanyProfile.restrictions, workRegions: ["Республика Бурятия"] },
};

describe("выжимка профиля для поиска на площадках", () => {
  it("берёт слова профиля поиска, затем виды работ компании, регион и коды ОКПД2", () => {
    const request = buildProfileSearchRequest([searchProfile], company);
    expect(request).toEqual({
      query: "ремонт",
      keywords: ["строитель", "реконструкция", "модернизация", "монтаж", "ремонт помещений", "строительство"],
      regions: ["Республика Бурятия"],
      okpd2: ["41", "42", "43"],
    });
  });

  it("слов не больше предела, выключенный профиль не участвует", () => {
    const many: SearchProfile = { ...searchProfile, keywords: Array.from({ length: 12 }, (_, i) => `слово${String(i)}`) };
    const off: SearchProfile = { ...searchProfile, id: "sp-2", keywords: ["юристы"], regions: ["Москва"], enabled: false };
    const request = buildProfileSearchRequest([many, off], null);
    expect(request?.keywords).toHaveLength(MAX_PROFILE_KEYWORDS);
    expect(request?.keywords).not.toContain("юристы");
    expect(request?.regions).toEqual(["Республика Бурятия"]);
  });

  it("пустой профиль — null: остаётся общий обход", () => {
    expect(buildProfileSearchRequest([], emptyCompanyProfile)).toBeNull();
  });

  it("коды ОКПД2 чистятся: мусор, повторы и хвостовые точки — мимо", () => {
    expect(normalizeLiveOkpd2(["41", " 43.21. ", "41", "стройка", "4", 42, "43.21.10.120"])).toEqual([
      "41",
      "43.21",
      "43.21.10.120",
    ]);
    expect(normalizeLiveOkpd2("41")).toEqual([]);
  });

  it("поиск по профилю пропускает больше слов, чем близких слов живого поиска", () => {
    const words = ["строитель", "реконструкция", "модернизация", "монтаж", "фасады"];
    expect(normalizeLiveSynonyms("ремонт", words)).toHaveLength(3);
    expect(normalizeLiveSynonyms("ремонт", words, MAX_PROFILE_KEYWORDS)).toEqual(words);
  });

  it("профиль прогона несёт коды ОКПД2 отдельно от слов", () => {
    const profile = buildLiveProfile("ремонт", ["Республика Бурятия"], ["монтаж"], ["41", "43"]);
    expect(profile.keywords).toEqual(["ремонт", "монтаж"]);
    expect(profile.okpd2Codes).toEqual(["41", "43"]);
  });
});
