import { beforeEach, describe, expect, it } from "vitest";

import { emptyCompanyProfile } from "@/domain/emptyCompanyProfile";
import { cardVerdictRepository, profileFingerprint } from "@/repositories/cardVerdictRepository";

/**
 * Карточка закупки считает оценку по документации, списки — по реквизитам. Итог
 * карточки запоминается, чтобы одна закупка не была «98 · Подходит» на доске и
 * «96 · Проверить» в карточке (проверка 24.10.2026).
 */
describe("итог карточки для списков", () => {
  beforeEach(() => localStorage.clear());

  const key = profileFingerprint(emptyCompanyProfile);

  it("запоминается и читается по тому же профилю", () => {
    cardVerdictRepository.save("32616457847", { verdict: "MANUAL_REVIEW", fitScore: 96, profileKey: key });
    expect(cardVerdictRepository.get("32616457847", key)).toEqual({ verdict: "MANUAL_REVIEW", fitScore: 96, profileKey: key });
    expect(cardVerdictRepository.allFor(key).get("32616457847")?.fitScore).toBe(96);
  });

  it("после правки профиля старый итог не берётся", () => {
    cardVerdictRepository.save("1", { verdict: "RECOMMENDED", fitScore: 90, profileKey: key });
    const edited = profileFingerprint({
      ...emptyCompanyProfile,
      restrictions: { ...emptyCompanyProfile.restrictions, workRegions: ["Москва"] },
    });
    expect(edited).not.toBe(key);
    expect(cardVerdictRepository.get("1", edited)).toBeNull();
  });
});
