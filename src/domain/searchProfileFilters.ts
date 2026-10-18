import type { SearchProfile } from "@/domain/entities";
import type { TenderFilters } from "@/domain/filtering";
import { canonicalRegionNames } from "@/domain/regionCodes";

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
  const [firstRegion, ...restRegions] = canonicalRegionNames(profile.regions);
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
 * Что профиль запрашивает у выдачи: слова, законы и регионы.
 *
 * Регион — выбор человека, и лента его соблюдает: показывает закупки только
 * выбранных регионов (замечание 05.10.2026 — по Калмыкии лента выдавала всю
 * Россию с оценками, и закупок региона не было видно). Регион виден чипом и
 * снимается одним нажатием. Заказчики и цена отбором не служат: их учитывает
 * оценка «подходит / не подходит» и показывает причину.
 */
export function searchWordsFromProfile(profile: SearchProfile): Partial<TenderFilters> {
  const [firstRegion, ...restRegions] = canonicalRegionNames(profile.regions);
  return {
    search: "",
    searchKeywords: [...profile.keywords],
    laws: profile.laws,
    region: firstRegion ?? "",
    regions: restRegions,
    page: 1,
  };
}

/**
 * Ограничения профиля сверх слов и регионов, в виде фильтров ленты: заказчики
 * и цена.
 *
 * Нужны, чтобы сказать, какие из найденных закупок профиль исключает. Регионов
 * здесь нет: они применяются фильтром сразу, и снятый человеком чип региона не
 * должен возвращаться скрытием «вне условий профиля».
 */
export function limitsFromProfile(profile: SearchProfile): Partial<TenderFilters> {
  const { customerInn, customerInns, minPrice, maxPrice } = filtersFromSearchProfile(profile);
  return { customerInn, customerInns, minPrice, maxPrice };
}

const money = (value: number): string => new Intl.NumberFormat("ru-RU").format(value).replace(/ /g, " ");

/**
 * Что профиль ограничивает сверх слов и регионов: заказчиков, цену.
 *
 * Лента говорит об этом человеку и предлагает применить: молча урезать выдачу
 * нельзя, а молча не учитывать настройку — тоже.
 */
export function profileNarrowing(profile: SearchProfile): string[] {
  const lines: string[] = [];
  if (profile.minPrice !== null && profile.maxPrice !== null) {
    lines.push(`цена от ${money(profile.minPrice)} до ${money(profile.maxPrice)} ₽`);
  } else if (profile.minPrice !== null) {
    lines.push(`цена от ${money(profile.minPrice)} ₽`);
  } else if (profile.maxPrice !== null) {
    lines.push(`цена до ${money(profile.maxPrice)} ₽`);
  }
  const inns = (profile.customerInns ?? []).length;
  if (inns > 0) lines.push(`заказчиков: ${String(inns)}`);
  return lines;
}

/**
 * Профиль, который лента применяет сама при первом открытии.
 *
 * Берётся первый включённый — тот же, что тратит бюджет на кнопке поиска.
 * Применяются только слова (см. `searchWordsFromProfile`), поэтому профиль без
 * слов не возвращается: искать нечего, а регион и цена отбором не служат.
 */
export function autoAppliedProfile(
  profiles: readonly SearchProfile[],
): SearchProfile | null {
  // Первый включённый профиль СО СЛОВАМИ. Раньше брался просто первый
  // включённый: пустой профиль в начале списка отключал применение вовсе, и
  // лента показывала всю базу вместо закупок регионов человека (05.10.2026).
  return profiles.find((p) => p.enabled && p.keywords.length > 0) ?? null;
}
