import { describe, expect, it } from "vitest";

import type { SearchProfile } from "@/domain/entities";
import { mergeUserData, type UserDataSnapshot } from "@/domain/userDataMerge";

/**
 * Слияние данных аккаунта с данными этого устройства.
 *
 * Человек мог собрать профили, ещё не войдя, а потом войти на устройстве, где
 * аккаунт уже что-то хранит. Правило — ничего не терять: профили объединяются
 * по названию, а анкета компании берётся из аккаунта, если там она есть.
 */

function sp(name: string, keywords: string[] = ["слово"]): SearchProfile {
  return {
    id: `id-${name}`,
    name,
    laws: ["FZ_44"],
    keywords,
    stopWords: [],
    okpd2Codes: [],
    regions: [],
    customerInns: [],
    minPrice: null,
    maxPrice: null,
    onlyOpenForSubmission: true,
    enabled: true,
  };
}

const snap = (searchProfiles: SearchProfile[], companyProfile: unknown = null): UserDataSnapshot => ({
  searchProfiles,
  companyProfile,
});

describe("mergeUserData", () => {
  it("аккаунт пуст — берутся данные устройства, и их нужно отправить на сервер", () => {
    const result = mergeUserData(snap([sp("А")], { name: "ООО" }), snap([], null));

    expect(result.merged.searchProfiles.map((p) => p.name)).toEqual(["А"]);
    expect(result.merged.companyProfile).toEqual({ name: "ООО" });
    expect(result.pushToServer).toBe(true);
    expect(result.writeToDevice).toBe(false);
  });

  it("устройство пусто — берутся данные аккаунта, и их нужно записать на устройство", () => {
    const result = mergeUserData(snap([], null), snap([sp("Б")], { name: "ИП" }));

    expect(result.merged.searchProfiles.map((p) => p.name)).toEqual(["Б"]);
    expect(result.merged.companyProfile).toEqual({ name: "ИП" });
    expect(result.writeToDevice).toBe(true);
    expect(result.pushToServer).toBe(false);
  });

  it("профили объединяются по названию: ничего не теряется ни с одной стороны", () => {
    const result = mergeUserData(snap([sp("Локальный")]), snap([sp("Серверный")]));

    expect(result.merged.searchProfiles.map((p) => p.name).sort()).toEqual(["Локальный", "Серверный"]);
    expect(result.pushToServer).toBe(true);
    expect(result.writeToDevice).toBe(true);
  });

  it("одноимённый профиль — версия аккаунта, без дубля", () => {
    const result = mergeUserData(snap([sp("Юристы", ["локально"])]), snap([sp("юристы", ["на сервере"])]));

    expect(result.merged.searchProfiles).toHaveLength(1);
    expect(result.merged.searchProfiles[0]?.keywords).toEqual(["на сервере"]);
  });

  it("анкета компании: если есть и там и там, побеждает аккаунт", () => {
    const result = mergeUserData(snap([], { name: "Локальная" }), snap([], { name: "Серверная" }));

    expect(result.merged.companyProfile).toEqual({ name: "Серверная" });
  });

  it("одинаковые данные — ничего никуда писать не нужно", () => {
    const same = snap([sp("А")], { name: "ООО" });

    const result = mergeUserData(same, snap([sp("А")], { name: "ООО" }));

    expect(result.pushToServer).toBe(false);
    expect(result.writeToDevice).toBe(false);
  });

  it("у обоих пусто — писать нечего", () => {
    const result = mergeUserData(snap([], null), snap([], null));

    expect(result.pushToServer).toBe(false);
    expect(result.writeToDevice).toBe(false);
  });
});
