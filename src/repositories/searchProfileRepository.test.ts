import { beforeEach, describe, expect, it } from "vitest";

import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { autoAppliedProfile } from "@/domain/searchProfileFilters";
import { STORAGE_KEYS } from "@/lib/storage";

/**
 * Лента не должна фильтроваться профилем, которого человек не создавал.
 *
 * Репозиторий отдавал три готовых профиля — «Компьютеры и оргтехника
 * (Москва)», «Строительство и ремонт», «РЖД», — и все включёнными. Лента
 * применяла первый из них сама, и человек, впервые открывший «Закупки», видел
 * 1 закупку из 198: остальные 197 убрал чужой набор ключевых слов, регионов и
 * цен.
 *
 * Снаружи это выглядит поломкой поиска, а не настройкой: чипы с условиями
 * человек читает как своё прошлое действие, которого не было.
 */
describe("профили поиска по умолчанию", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("пока человек не создал ни одного профиля, их нет", () => {
    expect(searchProfileRepository.getAll()).toEqual([]);
  });

  it("лента ничего не применяет сама", () => {
    expect(autoAppliedProfile(searchProfileRepository.getAll())).toBeNull();
  });

  it("созданный профиль сохраняется и читается", () => {
    searchProfileRepository.upsert({
      id: "sp-1",
      name: "Мосты",
      laws: ["FZ_44"],
      keywords: ["мост"],
      stopWords: [],
      okpd2Codes: [],
      regions: [],
      customerInns: [],
      minPrice: null,
      maxPrice: null,
      onlyOpenForSubmission: true,
      enabled: true,
    });

    const all = searchProfileRepository.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe("Мосты");
  });

  it("свой профиль лента применяет — это уже сказанное человеком", () => {
    searchProfileRepository.upsert({
      id: "sp-1",
      name: "Мосты",
      laws: ["FZ_44"],
      keywords: ["мост"],
      stopWords: [],
      okpd2Codes: [],
      regions: [],
      customerInns: [],
      minPrice: null,
      maxPrice: null,
      onlyOpenForSubmission: true,
      enabled: true,
    });

    expect(autoAppliedProfile(searchProfileRepository.getAll())?.name).toBe("Мосты");
  });

  it("запись без customerInns не роняет чтение", () => {
    window.localStorage.setItem(
      STORAGE_KEYS.searchProfiles,
      JSON.stringify([{ id: "sp-old", name: "Старый", keywords: [], enabled: true }]),
    );

    expect(searchProfileRepository.getAll()[0]?.customerInns).toEqual([]);
  });
});
