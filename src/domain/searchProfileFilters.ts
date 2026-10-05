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
 * Что профиль запрашивает у выдачи: только слова и законы.
 *
 * Первый слой выдачи — найти всё по словам, по всей России. Регион, заказчики и
 * цена профиля отбором не служат: их учитывает оценка «подходит / не подходит»
 * и показывает причину. Отбор по ним лента выполняет только по явной просьбе
 * (`filtersFromSearchProfile`).
 */
export function searchWordsFromProfile(profile: SearchProfile): Partial<TenderFilters> {
  return {
    search: "",
    searchKeywords: [...profile.keywords],
    laws: profile.laws,
    page: 1,
  };
}

/**
 * Ограничения профиля сверх слов, в виде фильтров ленты: регион, заказчики, цена.
 *
 * Нужны, чтобы сказать, какие из найденных по словам закупок профиль исключает.
 */
export function limitsFromProfile(profile: SearchProfile): Partial<TenderFilters> {
  const { region, regions, customerInn, customerInns, minPrice, maxPrice } =
    filtersFromSearchProfile(profile);
  return { region, regions, customerInn, customerInns, minPrice, maxPrice };
}

const money = (value: number): string => new Intl.NumberFormat("ru-RU").format(value).replace(/ /g, " ");

/**
 * Что профиль ограничивает сверх слов: регион, заказчиков, цену.
 *
 * Лента говорит об этом человеку и предлагает применить: молча урезать выдачу
 * нельзя, а молча не учитывать настройку — тоже.
 */
export function profileNarrowing(profile: SearchProfile): string[] {
  const lines: string[] = [];
  if (profile.regions.length > 0) lines.push(`регион: ${profile.regions.join(", ")}`);
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
