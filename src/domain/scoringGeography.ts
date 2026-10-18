import type { CompanyProfile, SearchProfile } from "@/domain/entities";
import { isSameRegion } from "@/domain/regionCodes";

/**
 * Профиль компании для подбора: география работы дополнена регионами из
 * включённых профилей поиска («Что ищем»).
 *
 * Регион в «Что ищем» человек выбирает сам — это прямое «ищу здесь». Если в
 * «Профиле компании» география уже, критический блокер «Регион вне географии
 * работы» ставил таким закупкам «Не подходит» при соответствии 91 из 100:
 * на живой ленте 07.10.2026 так выглядели все закупки Иркутской области и
 * Забайкалья, хотя искали именно там.
 *
 * Пустая география означает «работаем везде» и не дополняется: иначе регионы
 * поиска превратились бы в ограничение, которого компания не ставила.
 */
export function withSearchRegions(
  profile: CompanyProfile,
  searchProfiles: readonly SearchProfile[],
): CompanyProfile {
  const geography = profile.restrictions.workRegions.filter(Boolean);
  if (geography.length === 0) return profile;

  const extra: string[] = [];
  for (const searchProfile of searchProfiles) {
    if (!searchProfile.enabled) continue;
    for (const region of searchProfile.regions) {
      if (!region) continue;
      const known = [...geography, ...extra].some((r) => isSameRegion(r, region));
      if (!known) extra.push(region);
    }
  }
  if (extra.length === 0) return profile;

  return {
    ...profile,
    restrictions: {
      ...profile.restrictions,
      workRegions: [...geography, ...extra],
    },
  };
}
