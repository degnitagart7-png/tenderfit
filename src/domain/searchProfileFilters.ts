import type { SearchProfile } from "@/domain/entities";
import type { TenderFilters } from "@/domain/filtering";

/**
 * Перевод профиля поиска в фильтры ленты.
 *
 * Нужен, потому что профиль «Что ищем» раньше не влиял на ленту вовсе: он
 * задавал только слова для платного прогона Контур.Закупок и срабатывал в
 * выдаче, лишь когда человек выбирал его руками в выпадающем списке. Замер
 * 28.09.2026: профиль «Только вентиляция, Москва» не изменил ни одной строки
 * из 173 — человек настроил, чего ищет, и не получил этого.
 *
 * Функция чистая и возвращает только изменяемые поля: порядок сортировки,
 * размер страницы и переключатели цены остаются за пользователем.
 */
export function filtersFromSearchProfile(
  profile: SearchProfile,
): Partial<TenderFilters> {
  const [firstRegion, ...restRegions] = profile.regions;
  const [firstInn, ...restInns] = profile.customerInns ?? [];
  return {
    /*
      Строка поиска пуста намеренно: она принадлежит человеку. Слова профиля
      идут целиком в ключевые — «любое из», каждое со своими словами «и» внутри.
      Первое слово в строке поиска означало бы, что оно обязательно, а
      остальные — лишь «хотя бы одно».
    */
    search: "",
    searchKeywords: [...profile.keywords],
    laws: profile.laws,
    region: firstRegion ?? "",
    regions: restRegions,
    customerInn: firstInn ?? "",
    customerInns: restInns,
    minPrice: profile.minPrice,
    maxPrice: profile.maxPrice,
    page: 1,
  };
}

/**
 * Профиль, который лента применяет сама при первом открытии.
 *
 * Берётся первый включённый — тот же, что тратит бюджет на кнопке поиска
 * (`konturPressPlan`). Две разные выборки означали бы, что кнопка ищет одно,
 * а лента показывает другое.
 *
 * Профиль без единого ограничения не возвращается: применять «ничего» значит
 * повесить на выдачу чип, который ничего не меняет.
 */
export function autoAppliedProfile(
  profiles: readonly SearchProfile[],
): SearchProfile | null {
  const enabled = profiles.filter((p) => p.enabled);
  const first = enabled[0];
  if (!first) return null;
  const constrains =
    first.keywords.length > 0 ||
    first.regions.length > 0 ||
    first.laws.length > 0 ||
    (first.customerInns ?? []).length > 0 ||
    first.minPrice !== null ||
    first.maxPrice !== null;
  return constrains ? first : null;
}
