import type {
  PipelineStatus,
  Tender,
  TenderAnalysis,
  TenderDataSource,
  TenderLaw,
  TenderVerdict,
} from "@/domain/entities";
import { isClosingWithinDays } from "@/domain/scoring";
import {
  freshnessContextOf,
  freshnessLayer,
  isInBatch,
  layerRank,
  type FreshnessContext,
} from "@/domain/lastSearch";
import {
  passesPriceBounds,
  passesPriceVisibility,
  type PriceVisibility,
} from "@/domain/priceVisibility";
import {
  combineRelevanceAndFit,
  scoreRelevance,
  type Relevance,
} from "@/domain/searchRanking";
import {
  buildSearchIndex,
  matchIndex,
  parseExcluded,
  parseSearchInput,
  type MatchOptions,
  type MatchResult,
  type ParsedQuery,
  type SearchScope,
} from "@/domain/textSearch";

/** Строка таблицы закупок: закупка + её анализ + статус воронки. */
export interface TenderRow {
  tender: Tender;
  analysis: TenderAnalysis;
  pipelineStatus: PipelineStatus;
}

export type SortField =
  | "relevance"
  | "freshness"
  | "fitScore"
  | "price"
  | "submissionEnd"
  | "subject"
  | "analyzedAt";

export interface TenderFilters {
  search: string;
  /** Дополнительные ключевые слова (OR с основным search). */
  searchKeywords: string[];
  /**
   * Слова-исключения. Вычитаются из выдачи, даже если основное слово найдено:
   * «вентиль -аренда» убирает всё, где встречается аренда.
   */
  excludeKeywords: string[];
  /** Искать дословную подстроку, а не основу слова. */
  exactMatch: boolean;
  /**
   * В каких областях искать. Пустой список — все области сразу; именно так
   * устроен поиск Контур.Закупок до включения «Искать и по документам».
   */
  scopes: SearchScope[];
  laws: TenderLaw[];
  region: string;
  /** Дополнительные регионы (OR с основным region). */
  regions: string[];
  /** Точный ИНН заказчика; пустая строка = не фильтровать. */
  customerInn: string;
  /** Дополнительные ИНН заказчиков (OR с основным customerInn). */
  customerInns: string[];
  /** Площадки-источники (перечень — каталог `sources.ts`); пусто = все. */
  sources: TenderDataSource[];
  minPrice: number | null;
  maxPrice: number | null;
  /** Показывать закупки без опубликованной НМЦ. */
  includeNoPrice: boolean;
  /** Показывать закупки, объявленные не в рублях. */
  includeForeignCurrency: boolean;
  verdict: TenderVerdict | "ALL";
  /**
   * Только закупки, у которых подача закрывается в ближайшие
   * `URGENT_DEADLINE_DAYS` дней. Тот же интервал, что в блоке «Срочно» на
   * экране «Сегодня»: «срочно» обязано означать одно и то же на всех экранах.
   * Истёкшие не попадают — их отсекает блокер «Срок подачи истёк».
   */
  closingSoonOnly: boolean;
  hasHardBlockers: boolean | null;
  hasAdvance: boolean | null;
  hasSecurity: boolean | null;
  pipelineStatus: PipelineStatus | "ALL";
  /**
   * Метка записи (`synced_at`) партии одного прогона Контур.Закупок; null —
   * без ограничения.
   *
   * Фильтр приходит ссылкой с карточки «Лучшее из нового» на дашборде и
   * отвечает на вопрос «показать всё, что нашёл платный поиск»: без него ссылка
   * открывала бы всю ленту источника за все прогоны, и число на кнопке
   * расходилось бы с выдачей. В панели фильтров управления им нет — снятие
   * только чипом.
   */
  batchStamp: string | null;
  /**
   * Поле сортировки ленты.
   *
   * По умолчанию «freshness»: сначала слои свежести (партия платного поиска,
   * затем добавленные на этой неделе, затем остальные и в конце закупки с
   * истёкшим сроком), а внутри слоя — Fit Score по убыванию. Так ответ на
   * вопрос «что нашлось и что из этого мне подходит» читается сверху вниз без
   * дополнительных действий.
   */
  sortField: SortField;
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
}

export const defaultFilters: TenderFilters = {
  search: "",
  searchKeywords: [],
  excludeKeywords: [],
  exactMatch: false,
  scopes: [],
  laws: [],
  region: "",
  regions: [],
  customerInn: "",
  customerInns: [],
  sources: [],
  minPrice: null,
  maxPrice: null,
  // Оба переключателя включены: прятать найденные закупки — осознанное
  // действие пользователя, а не наше решение за него.
  includeNoPrice: true,
  includeForeignCurrency: true,
  verdict: "ALL",
  closingSoonOnly: false,
  hasHardBlockers: null,
  hasAdvance: null,
  hasSecurity: null,
  pipelineStatus: "ALL",
  batchStamp: null,
  sortField: "freshness",
  sortDir: "desc",
  page: 1,
  pageSize: 10,
};

/* ============================== Текстовый поиск ============================== */

/** Совпадение без запроса: подходит всё, объяснять нечего. */
const EMPTY_MATCH: MatchResult = {
  matched: true,
  scopes: [],
  matchedTerms: [],
  matchedCodes: [],
  phraseMatched: false,
  excludedHit: false,
};

/** Запрос-пустышка для подсчёта релевантности, когда строка поиска пуста. */
const EMPTY_QUERY: ParsedQuery = {
  terms: [],
  anyGroups: [],
  excluded: [],
  codes: [],
  phrase: null,
};

/** Разобранный запрос вместе с настройками сопоставления. */
export interface TextQuery {
  query: ParsedQuery;
  options: MatchOptions;
}

/** Объединяет списки слов без дубликатов, сохраняя порядок. */
function mergeWords(base: string[], extra: readonly string[]): string[] {
  const seen = new Set(base);
  const result = [...base];
  for (const word of extra) {
    if (!seen.has(word)) {
      seen.add(word);
      result.push(word);
    }
  }
  return result;
}

/**
 * Собирает запрос из всех полей поиска.
 *
 * Возвращает null, когда искать нечего: пустая строка, пустые дополнительные
 * слова и пустые исключения не должны ни отфильтровать выдачу, ни заставить
 * `matchIndex` считать совпадением каждую закупку.
 *
 * Дополнительные ключевые слова разбираются тем же парсером, что и основная
 * строка: профиль поиска может принести туда код ОКПД2 («30.01.24.190»), и он
 * обязан попасть в `codes`, а не в слова — иначе точка разобьёт код на три
 * бессмысленных токена.
 */
export function buildTextQuery(filters: TenderFilters): TextQuery | null {
  const parsed = parseSearchInput(filters.search ?? "");
  /*
    Ключевые слова профиля — группы, а не слова.

    Каждое — отдельное ключевое слово: «Юридические услуги» — одна группа из
    двух слов, «юристы» — другая. Внутри группы слова складываются по «и»,
    между группами — по «или». Пока их сливали в плоский список, «услуги»
    становилось самостоятельным ключевым словом и возвращало всю ленту.
  */
  for (const keyword of filters.searchKeywords ?? []) {
    const extra = parseSearchInput(keyword);
    if (extra.terms.length > 0) parsed.anyGroups.push(extra.terms);
    parsed.codes = mergeWords(parsed.codes, extra.codes);
    parsed.excluded = mergeWords(parsed.excluded, extra.excluded);
    if (parsed.phrase === null && extra.phrase !== null) {
      parsed.phrase = extra.phrase;
    }
  }

  const excludeWords = parseExcluded(
    (filters.excludeKeywords ?? []).join(" "),
  );
  if (excludeWords.length > 0) {
    parsed.excluded = mergeWords(parsed.excluded, excludeWords);
  }

  const hasQuery =
    parsed.terms.length > 0 ||
    parsed.anyGroups.length > 0 ||
    parsed.codes.length > 0 ||
    parsed.phrase !== null ||
    parsed.excluded.length > 0;
  if (!hasQuery) return null;

  const scopes = filters.scopes ?? [];
  return {
    query: parsed,
    options: {
      exact: filters.exactMatch === true,
      // Пустой список областей означает «все»: `matchIndex` трактует его так же,
      // поэтому передавать undefined и [] одинаково безопасно.
      ...(scopes.length > 0 ? { scopes } : {}),
    },
  };
}

/** Переключатели цены из фильтров ленты. */
function priceVisibilityOf(filters: TenderFilters): PriceVisibility {
  // «?? true» — наборы фильтров, сохранённые в localStorage до появления
  // переключателей, обязаны вести себя как включённые, а не скрывать закупки.
  return {
    includeUnknown: filters.includeNoPrice ?? true,
    includeForeignCurrency: filters.includeForeignCurrency ?? true,
  };
}

/**
 * Строка выдачи вместе с тем, почему она в ней оказалась.
 *
 * Сопоставление считается один раз на строку и переиспользуется: ленте нужны и
 * сам факт совпадения (фильтр), и его области (сортировка по релевантности,
 * пометка «только в документации»), и балл (порядок в выдаче).
 */
export interface SearchedRow {
  row: TenderRow;
  match: MatchResult;
  relevance: Relevance;
  /** Итоговый балл: релевантность и Fit Score в согласованной пропорции. */
  combined: number;
}

/**
 * Применяет фильтры и возвращает строки вместе с объяснением совпадения.
 *
 * Порядок результата — исходный порядок `rows`: сортировка делается отдельно
 * (`sortSearched`), чтобы смена порядка не пересчитывала поиск.
 */
export function searchRows(
  rows: TenderRow[],
  filters: TenderFilters,
): SearchedRow[] {
  const textQuery = buildTextQuery(filters);
  const visibility = priceVisibilityOf(filters);
  const allRegions = [
    ...(filters.region ? [filters.region.trim().toLowerCase()] : []),
    ...(filters.regions ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean),
  ];
  // «?? ""» — защита от наборов фильтров, сохранённых в localStorage
  // до появления поля customerInn.
  const customerInn = (filters.customerInn ?? "").trim();
  const allCustomerInns = [
    ...(customerInn ? [customerInn] : []),
    ...(filters.customerInns ?? [])
      .map((inn) => inn.trim())
      .filter(Boolean),
  ];
  // «?? []» — та же защита от старых наборов фильтров в localStorage.
  const allSources = filters.sources ?? [];
  const laws = filters.laws ?? [];
  const batchStamp = filters.batchStamp ?? null;

  const hits: SearchedRow[] = [];
  for (const row of rows) {
    const { tender, analysis } = row;

    // Текстовый поиск: основа, префикс основы, дословная фраза, коды ОКПД2 и
    // исключения — всё это считает textSearch, а не подстрока в трёх полях.
    const match =
      textQuery === null
        ? EMPTY_MATCH
        : matchIndex(buildSearchIndex(tender), textQuery.query, textQuery.options);
    if (!match.matched) continue;

    if (laws.length > 0 && !laws.includes(tender.law)) continue;
    // Регион: хотя бы один из списка должен совпадать (подстрока).
    if (allRegions.length > 0) {
      const tenderRegion = tender.region.toLowerCase();
      if (!allRegions.some((r) => tenderRegion.includes(r))) continue;
    }
    // ИНН заказчика: точное совпадение хотя бы с одним из списка.
    if (
      allCustomerInns.length > 0 &&
      (!tender.customerInn || !allCustomerInns.includes(tender.customerInn))
    ) {
      continue;
    }
    // Площадка-источник: пусто — показываем все, иначе только выбранные.
    if (allSources.length > 0 && !allSources.includes(tender.dataSource)) {
      continue;
    }
    // Партия прогона: ссылка «Все N» из блока последнего поиска обязана открыть
    // ровно строки этого прогона, а не всю ленту источника за все прогоны.
    if (batchStamp !== null && !isInBatch(row, batchStamp)) {
      continue;
    }
    if (!passesPriceVisibility(tender, visibility)) continue;
    if (
      !passesPriceBounds(
        tender.financial.price,
        filters.minPrice,
        filters.maxPrice,
      )
    ) {
      continue;
    }
    if (filters.verdict !== "ALL" && analysis.verdict !== filters.verdict) {
      continue;
    }
    if (
      filters.closingSoonOnly &&
      !isClosingWithinDays(tender.deadlines.submissionEnd)
    ) {
      continue;
    }
    if (filters.hasHardBlockers === true && analysis.hardBlockers.length === 0) {
      continue;
    }
    if (filters.hasHardBlockers === false && analysis.hardBlockers.length > 0) {
      continue;
    }
    const hasAdvance = (tender.financial.advancePercent ?? 0) > 0;
    if (filters.hasAdvance === true && !hasAdvance) continue;
    if (filters.hasAdvance === false && hasAdvance) continue;

    const hasSecurity =
      (tender.financial.contractSecurityAmount ?? 0) > 0 ||
      (tender.financial.bidSecurityAmount ?? 0) > 0;
    if (filters.hasSecurity === true && !hasSecurity) continue;
    if (filters.hasSecurity === false && hasSecurity) continue;

    if (
      filters.pipelineStatus !== "ALL" &&
      row.pipelineStatus !== filters.pipelineStatus
    ) {
      continue;
    }

    const relevance = scoreRelevance({ match, query: textQuery?.query ?? EMPTY_QUERY });
    hits.push({
      row,
      match,
      relevance,
      combined: combineRelevanceAndFit(relevance.score, analysis.fitScore),
    });
  }
  return hits;
}

/** Применяет фильтры (без сортировки и пагинации) — чистая функция. */
export function filterRows(
  rows: TenderRow[],
  filters: TenderFilters,
): TenderRow[] {
  return searchRows(rows, filters).map((hit) => hit.row);
}

/**
 * Сколько закупок каждого закона осталось бы при текущих фильтрах.
 *
 * Счётчики рисуются рядом с переключателем закона, чтобы выбор был виден до
 * клика. Сам закон в расчёте не участвует: иначе на «44-ФЗ» переключатель
 * показывал бы «223-ФЗ (0)» — ровно в тот момент, когда подсказка и нужна.
 *
 * Законы без единой закупки возвращают 0, а не отсутствуют в объекте: UI рисует
 * счётчик напрямую и не должен помнить про «?? 0».
 */
export type LawCounts = { ALL: number } & Record<TenderLaw, number>;

export function countRowsByLaw(rows: TenderRow[], filters: TenderFilters): LawCounts {
  const counts: LawCounts = {
    ALL: 0,
    FZ_44: 0,
    FZ_223: 0,
    PP_RF_615: 0,
    COMMERCIAL: 0,
  };
  for (const row of filterRows(rows, { ...filters, laws: [] })) {
    counts.ALL += 1;
    counts[row.tender.law] += 1;
  }
  return counts;
}

/**
 * Значение строки для сравнения по полю сортировки.
 *
 * Общая для `sortRows` и `sortSearched`: если порядок по цене в двух местах
 * считать по-разному, лента и счётчики разъедутся.
 */
function sortKey(row: TenderRow, field: SortField): number | string {
  switch (field) {
    case "price":
      return row.tender.financial.price;
    case "submissionEnd":
      return new Date(row.tender.deadlines.submissionEnd).getTime();
    case "subject":
      return row.tender.subject.toLowerCase();
    case "analyzedAt":
      return new Date(row.analysis.analyzedAt).getTime();
    case "relevance":
      // Релевантность доступна только в `sortSearched` — там есть результат
      // сопоставления. Без запроса она равна нулю у всех строк, и порядок
      // полностью определяется Fit Score, поэтому вырождение корректно.
      return row.analysis.fitScore;
    default:
      return row.analysis.fitScore;
  }
}

function compareBySign(
  av: number | string,
  bv: number | string,
  sign: number,
): number {
  if (av < bv) return -1 * sign;
  if (av > bv) return 1 * sign;
  return 0;
}

/**
 * Метка срока подачи для сравнения.
 *
 * Неразобранную или пустую дату уводим в конец: у ЕИС часть строк приходит без
 * срока, и придуманное значение (ноль или «сейчас») подняло бы их наверх —
 * закупка без срока выглядела бы самой горящей.
 */
function deadlineKey(submissionEnd: string): number {
  const time = new Date(submissionEnd).getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * Сравнение строк по свежести, а внутри слоя — по пригодности.
 *
 * Порядок задуман как ответ на вопрос «что смотреть первым»: результат
 * последнего поиска, затем самое подходящее по Fit Score, затем самое горящее
 * по сроку. Предмет закупки разрушает последнее равенство — без него строки с
 * одинаковыми числами менялись бы местами при каждом перерисовывании.
 *
 * `flip` равен -1 для asc: направление переворачивает весь порядок целиком, а
 * не отдельные его части. Иначе «по возрастанию» означало бы «слои наоборот,
 * но Fit Score всё равно вниз» — порядок, который невозможно ни прочитать, ни
 * объяснить.
 */
function compareFreshness(
  a: TenderRow,
  b: TenderRow,
  context: FreshnessContext,
  flip: number,
): number {
  const layers =
    layerRank(freshnessLayer(a, context)) - layerRank(freshnessLayer(b, context));
  if (layers !== 0) return layers * flip;

  const fit = b.analysis.fitScore - a.analysis.fitScore;
  if (fit !== 0) return fit * flip;

  const ends =
    deadlineKey(a.tender.deadlines.submissionEnd) -
    deadlineKey(b.tender.deadlines.submissionEnd);
  if (ends !== 0) return ends * flip;

  return compareBySign(
    a.tender.subject.toLowerCase(),
    b.tender.subject.toLowerCase(),
    flip,
  );
}

/**
 * Сортировка строк — чистая функция.
 *
 * `freshness` принимает контекст снаружи: лента и разделители групп обязаны
 * видеть одну и ту же партию последнего прогона. Без контекста он выводится из
 * переданных строк — так функцию можно вызывать и по отдельности.
 */
export function sortRows(
  rows: TenderRow[],
  field: SortField,
  dir: "asc" | "desc",
  freshness?: FreshnessContext,
): TenderRow[] {
  const copy = [...rows];
  if (field === "freshness") {
    const context = freshness ?? freshnessContextOf(rows);
    const flip = dir === "asc" ? -1 : 1;
    copy.sort((a, b) => compareFreshness(a, b, context, flip));
    return copy;
  }
  const sign = dir === "asc" ? 1 : -1;
  copy.sort((a, b) => compareBySign(sortKey(a, field), sortKey(b, field), sign));
  return copy;
}

/**
 * Сортировка выдачи поиска.
 *
 * Отдельная функция нужна ради поля «relevance»: балл релевантности живёт в
 * `SearchedRow`, а не в закупке, поэтому `sortRows` его физически не видит.
 * Остальные поля считаются через тот же `sortKey`, что и обычная сортировка.
 *
 * Равенство баллов разрушается Fit Score — иначе две закупки с одинаковым
 * совпадением слов менялись бы местами при каждом перерисовывании.
 */
export function sortSearched(
  hits: SearchedRow[],
  field: SortField,
  dir: "asc" | "desc",
  freshness?: FreshnessContext,
): SearchedRow[] {
  const copy = [...hits];
  if (field === "freshness") {
    const context = freshness ?? freshnessContextOf(hits.map((hit) => hit.row));
    const flip = dir === "asc" ? -1 : 1;
    copy.sort((a, b) => compareFreshness(a.row, b.row, context, flip));
    return copy;
  }
  const sign = dir === "asc" ? 1 : -1;
  copy.sort((a, b) => {
    if (field === "relevance") {
      const primary = compareBySign(a.combined, b.combined, sign);
      if (primary !== 0) return primary;
      return compareBySign(
        a.row.analysis.fitScore,
        b.row.analysis.fitScore,
        sign,
      );
    }
    return compareBySign(
      sortKey(a.row, field),
      sortKey(b.row, field),
      sign,
    );
  });
  return copy;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
): Paginated<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}
