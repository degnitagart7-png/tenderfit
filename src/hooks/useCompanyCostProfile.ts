"use client";

import { useCallback, useEffect, useState } from "react";

import type { CompanyProfile } from "@/domain/entities";
import { DEFAULT_COST_PROFILE, normalizeCostProfile, type CompanyCostProfile } from "@/domain/estimate/companyCostProfile";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { accountSync } from "@/services/accountSync";

/**
 * Профиль компании для расчёта цены участия: налоговая система, минимальная маржа и профиль затрат.
 *
 * Читается из хранилища после монтирования (на сервере хранилища нет). Правка профиля затрат сохраняется в профиль компании
 * и уходит в аккаунт, если человек вошёл, — так поправка, сделанная в блоке «Экономика участия», видна и в настройках, и на
 * другом устройстве. Пока профиль не загружен, `company` — null, а профиль затрат — нейтральный.
 */
export interface CompanyCostProfileState {
  readonly company: Pick<CompanyProfile, "taxSystem"> & { readonly minMarginPercent: number } | null;
  readonly costProfile: CompanyCostProfile;
  readonly setCostProfile: (next: CompanyCostProfile) => void;
}

/**
 * Сохраняет профиль затрат в профиль компании и отправляет его в аккаунт (если человек вошёл). Для мест, где профиль компании
 * уже в руках (карточка закупки получает его пропсом) и отдельный хук не нужен. Хранилище недоступно — null, поправка
 * живёт только в открытом блоке.
 */
export function persistCostProfile(next: CompanyCostProfile): CompanyProfile | null {
  try {
    const saved = companyProfileRepository.saveCostProfile(normalizeCostProfile(next));
    void accountSync.pushIfSignedIn();
    return saved;
  } catch {
    return null;
  }
}

export function useCompanyCostProfile(): CompanyCostProfileState {
  const [profile, setProfile] = useState<CompanyProfile | null>(null);

  useEffect(() => {
    try {
      setProfile(companyProfileRepository.get());
    } catch {
      setProfile(null);
    }
  }, []);

  const setCostProfile = useCallback((next: CompanyCostProfile) => {
    const normalized = normalizeCostProfile(next);
    const saved = persistCostProfile(normalized);
    // Хранилище недоступно (приватное окно): поправка живёт до закрытия вкладки, расчёт её уже учёл.
    if (saved !== null) setProfile(saved);
    else setProfile((current) => (current === null ? current : { ...current, costProfile: normalized }));
  }, []);

  return {
    company: profile === null ? null : { taxSystem: profile.taxSystem, minMarginPercent: profile.restrictions.minMarginPercent },
    costProfile: profile?.costProfile ?? DEFAULT_COST_PROFILE,
    setCostProfile,
  };
}
