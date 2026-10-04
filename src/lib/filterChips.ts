import type { TenderFilters } from "@/domain/filtering";
import { defaultFilters } from "@/domain/filtering";
import { scopeShortLabels } from "@/domain/searchRanking";
import {
  closingSoonChipLabel,
  dataSourceLabels,
  pipelineLabels,
  searchControlLabels,
  sortFieldLabels,
  verdictLabels,
} from "@/lib/labels";
import { formatCurrency, formatDateTime, pluralRu } from "@/utils/format";

/**
 * Активные ограничения выдачи в виде снимаемых чипов.
 *
 * Панель фильтров свёрнута по умолчанию, но применённые условия обязаны быть
 * видны: иначе список молча урезан и пользователь не понимает, почему выдача
 * короче, чем счётчик в шапке. Отдельно выводим множественные значения
 * (ключевые слова, регионы, ИНН), которые подставляет профиль поиска и которые
 * в полях панели не отображаются вовсе.
 */
export interface FilterChip {
  id: string;
  label: string;
  /** Чем заменить поле при снятии чипа. */
  reset: Partial<TenderFilters>;
}

export function activeFilterChips(filters: TenderFilters): FilterChip[] {
  const chips: FilterChip[] = [];

  if (filters.search.trim() !== "") {
    chips.push({
      id: "search",
      label: `Поиск: ${filters.search.trim()}`,
      reset: { search: "", page: 1 },
    });
  }
  if (filters.searchKeywords.length > 0) {
    chips.push({
      id: "searchKeywords",
      // «Ещё» говорит о добавке к строке поиска. Когда строки нет, добавлять не
      // к чему: ключевые слова — единственное условие, и называть их надо так.
      label:
        filters.search.trim() === ""
          ? `Ключевые слова: ${filters.searchKeywords.join(", ")}`
          : `+ ещё ${pluralRu(filters.searchKeywords.length, ["ключевое слово", "ключевых слова", "ключевых слов"])}: ${filters.searchKeywords.join(", ")}`,
      reset: { searchKeywords: [], page: 1 },
    });
  }
  if (filters.excludeKeywords.length > 0) {
    chips.push({
      id: "excludeKeywords",
      label: `Исключить: ${filters.excludeKeywords.join(", ")}`,
      reset: { excludeKeywords: [], page: 1 },
    });
  }
  if (filters.exactMatch) {
    chips.push({
      id: "exactMatch",
      label: searchControlLabels.exact,
      reset: { exactMatch: false, page: 1 },
    });
  }
  if (filters.scopes.length > 0) {
    chips.push({
      id: "scopes",
      label: `${searchControlLabels.scopes}: ${filters.scopes
        .map((scope) => scopeShortLabels[scope])
        .join(", ")}`,
      reset: { scopes: [], page: 1 },
    });
  }
  if (filters.region !== "") {
    chips.push({
      id: "region",
      label: `Регион: ${filters.region}`,
      reset: { region: "", page: 1 },
    });
  }
  if (filters.regions.length > 0) {
    chips.push({
      id: "regions",
      label: `+ ещё ${pluralRu(filters.regions.length, ["регион", "региона", "регионов"])}: ${filters.regions.join(", ")}`,
      reset: { regions: [], page: 1 },
    });
  }
  if (filters.customerInn !== "") {
    chips.push({
      id: "customerInn",
      label: `ИНН заказчика: ${filters.customerInn}`,
      reset: { customerInn: "", page: 1 },
    });
  }
  if (filters.customerInns.length > 0) {
    chips.push({
      id: "customerInns",
      label: `+ ещё ИНН: ${filters.customerInns.join(", ")}`,
      reset: { customerInns: [], page: 1 },
    });
  }
  for (const source of filters.sources) {
    chips.push({
      id: `source-${source}`,
      label: `Источник: ${dataSourceLabels[source]}`,
      reset: {
        sources: filters.sources.filter((s) => s !== source),
        page: 1,
      },
    });
  }
  if (filters.minPrice !== null) {
    chips.push({
      id: "minPrice",
      label: `НМЦК от ${formatCurrency(filters.minPrice)}`,
      reset: { minPrice: null, page: 1 },
    });
  }
  if (filters.maxPrice !== null) {
    chips.push({
      id: "maxPrice",
      label: `НМЦК до ${formatCurrency(filters.maxPrice)}`,
      reset: { maxPrice: null, page: 1 },
    });
  }
  // Чип появляется только при выключенном переключателе: включённое состояние —
  // умолчание, а не ограничение. Зато выключенное обязано быть на виду —
  // иначе часть найденных закупок пропадает молча.
  if (!filters.includeNoPrice) {
    chips.push({
      id: "includeNoPrice",
      label: "Закупки без НМЦ скрыты",
      reset: { includeNoPrice: true, page: 1 },
    });
  }
  if (!filters.includeForeignCurrency) {
    chips.push({
      id: "includeForeignCurrency",
      label: "Закупки в валюте скрыты",
      reset: { includeForeignCurrency: true, page: 1 },
    });
  }
  if (filters.verdict !== "ALL") {
    chips.push({
      id: "verdict",
      label: `Вердикт: ${verdictLabels[filters.verdict]}`,
      reset: { verdict: defaultFilters.verdict, page: 1 },
    });
  }
  if (filters.pipelineStatus !== "ALL") {
    chips.push({
      id: "pipelineStatus",
      label: `Статус: ${pipelineLabels[filters.pipelineStatus]}`,
      reset: { pipelineStatus: defaultFilters.pipelineStatus, page: 1 },
    });
  }
  if (filters.closingSoonOnly) {
    chips.push({
      id: "closingSoonOnly",
      label: closingSoonChipLabel,
      reset: { closingSoonOnly: false, page: 1 },
    });
  }
  if (filters.hasHardBlockers !== null) {
    chips.push({
      id: "hasHardBlockers",
      label: `Стоп-факторы: ${filters.hasHardBlockers ? "есть" : "нет"}`,
      reset: { hasHardBlockers: null, page: 1 },
    });
  }
  if (filters.hasAdvance !== null) {
    chips.push({
      id: "hasAdvance",
      label: `Аванс: ${filters.hasAdvance ? "есть" : "нет"}`,
      reset: { hasAdvance: null, page: 1 },
    });
  }
  if (filters.hasSecurity !== null) {
    chips.push({
      id: "hasSecurity",
      label: `Обеспечение: ${filters.hasSecurity ? "есть" : "нет"}`,
      reset: { hasSecurity: null, page: 1 },
    });
  }
  /*
    Порядок выдачи — тоже ограничение, которое обязано быть видимым.

    Клик по заголовку колонки перебивает порядок по умолчанию («свежие и
    подходящие сверху»), а обратного клика в таблице нет: второй клик меняет
    направление, а не возвращает умолчание. Без чипа пользователь остался бы
    в порядке «по цене» навсегда и не понял бы, почему новые закупки не сверху.

    Умолчание чипом не показывается — это не ограничение, а исходное состояние.
  */
  if (filters.sortField !== defaultFilters.sortField) {
    chips.push({
      id: "sortField",
      label: `Порядок: ${sortFieldLabels[filters.sortField]}`,
      reset: {
        sortField: defaultFilters.sortField,
        sortDir: defaultFilters.sortDir,
        page: 1,
      },
    });
  }

  /*
    Партия платного поиска приходит ссылкой с карточки «Лучшее из нового», а не
    из панели фильтров: без чипа список из двух десятков строк выглядел бы всей
    выдачей, и причину его короткости было бы не увидеть и не снять.
  */
  if (filters.batchStamp !== null) {
    chips.push({
      id: "batch",
      label: `Партия: ${formatDateTime(filters.batchStamp)}`,
      reset: { batchStamp: null, page: 1 },
    });
  }

  return chips;
}
