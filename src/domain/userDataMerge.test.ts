import { describe, expect, it } from "vitest";

import type { SearchProfile } from "@/domain/entities";
import { mergeUserData, type AppState, type UserDataSnapshot } from "@/domain/userDataMerge";

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

describe("mergeUserData: остальные данные аккаунта", () => {
  const withState = (appState: AppState, companyProfile: unknown = null): UserDataSnapshot => ({
    searchProfiles: [],
    companyProfile,
    appState,
  });

  it("онбординг пройден хоть где-то — пройден везде", () => {
    const result = mergeUserData(withState({}), withState({ onboardingDone: true }));

    expect(result.merged.appState?.onboardingDone).toBe(true);
    expect(result.writeToDevice).toBe(true);
    expect(result.pushToServer).toBe(false);
  });

  it("воронка закупок: объединяется по закупке, побеждает более свежий статус", () => {
    const result = mergeUserData(
      withState({
        pipeline: {
          t1: { tenderId: "t1", status: "APPLIED", updatedAt: "2026-10-05T10:00:00Z", note: null },
          t2: { tenderId: "t2", status: "NEW", updatedAt: "2026-10-01T10:00:00Z", note: null },
        },
      }),
      withState({
        pipeline: {
          t1: { tenderId: "t1", status: "REVIEW", updatedAt: "2026-10-04T10:00:00Z", note: null },
          t3: { tenderId: "t3", status: "WON", updatedAt: "2026-10-02T10:00:00Z", note: null },
        },
      }),
    );

    const pipeline = result.merged.appState?.pipeline as Record<string, { status: string }>;
    expect(Object.keys(pipeline).sort()).toEqual(["t1", "t2", "t3"]);
    expect(pipeline["t1"]?.status).toBe("APPLIED");
    expect(result.pushToServer).toBe(true);
    expect(result.writeToDevice).toBe(true);
  });

  it("списки (решения, импорт, отзывы) объединяются по id без дублей", () => {
    const result = mergeUserData(
      withState({ manualReviews: [{ id: "a" }, { id: "b" }] }),
      withState({ manualReviews: [{ id: "b" }, { id: "c" }] }),
    );

    expect((result.merged.appState?.manualReviews as Array<{ id: string }>).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("настройки уведомлений: побеждает аккаунт", () => {
    const result = mergeUserData(withState({ digestSettings: { sendTime: "09:00" } }), withState({ digestSettings: { sendTime: "08:00" } }));

    expect(result.merged.appState?.digestSettings).toEqual({ sendTime: "08:00" });
  });

  it("одинаковые данные в другом порядке ключей — писать нечего", () => {
    const item = (id: string) => ({ tenderId: id, status: "NEW", updatedAt: "2026-10-01T00:00:00Z", note: null });
    const result = mergeUserData(
      withState({ onboardingDone: true, pipeline: { b: item("b"), a: item("a") } }),
      withState({ pipeline: { a: item("a"), b: item("b") }, onboardingDone: true }),
    );

    expect(result.pushToServer).toBe(false);
    expect(result.writeToDevice).toBe(false);
  });
});

