import {
  PIPELINE_STATUSES,
  TENDER_DATA_SOURCES,
  TENDER_LAWS,
  TENDER_VERDICTS,
  type PipelineStatus,
  type TenderDataSource,
  type TenderLaw,
  type TenderVerdict,
} from "@/domain/enums";
import {
  defaultFilters,
  type SortField,
  type TenderFilters,
} from "@/domain/filtering";
import { ALL_SCOPES, type SearchScope } from "@/domain/textSearch";

/**
 * Фильтры таблицы закупок в адресной строке и обратно.
 *
 * Ссылка на выдачу должна быть воспроизводимой: обновление страницы, отправка
 * ссылки коллеге и возврат кнопкой «назад» дают тот же список. В URL попадают
 * только поля, отличающиеся от значений по умолчанию, поэтому чистая выдача —
 * это просто /tenders без параметров.
 *
 * Функции чистые: строка ↔ фильтры, без обращения к window и роутеру.
 */

const SORT_FIELDS: readonly SortField[] = [
  "relevance",
  "freshness",
  "fitScore",
  "price",
  "submissionEnd",
  "subject",
  "analyzedAt",
] as const;

/**
 * Значение параметра, выключающего показ закупки.
 *
 * Строка, а не «0»/«1»: адрес остаётся читаемым (`?noprice=hide`), а любое
 * постороннее значение трактуется как «показывать». Молча прятать найденные
 * закупки из-за опечатки в ссылке нельзя.
 */
const HIDE = "hide";

function joinList(values: string[]): string {
  return values.join(",");
}

function splitList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function pickEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T[] {
  return splitList(raw).filter((v): v is T => allowed.includes(v as T));
}

function pickNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pickInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function pickTri(raw: string | null): boolean | null {
  if (raw === "yes") return true;
  if (raw === "no") return false;
  return null;
}

/**
 * Метка партии прогона из адреса.
 *
 * Принимается только строка, разбираемая как дата: мусор в ссылке не должен
 * молча сужать выдачу до нуля — без метки показывается всё.
 */
function pickStamp(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  return Number.isNaN(new Date(raw).getTime()) ? null : raw;
}

/** Собирает параметры URL из фильтров: только то, что отличается от умолчаний. */
export function filtersToSearchParams(filters: TenderFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.searchKeywords.length > 0) params.set("q2", joinList(filters.searchKeywords));
  if (filters.excludeKeywords.length > 0) {
    params.set("x", joinList(filters.excludeKeywords));
  }
  if (filters.exactMatch) params.set("exact", "1");
  if (filters.scopes.length > 0) params.set("scope", joinList(filters.scopes));
  if (filters.laws.length > 0) params.set("law", joinList(filters.laws));
  if (filters.region) params.set("reg", filters.region);
  if (filters.regions.length > 0) params.set("reg2", joinList(filters.regions));
  if (filters.customerInn) params.set("inn", filters.customerInn);
  if (filters.customerInns.length > 0) params.set("inn2", joinList(filters.customerInns));
  if (filters.sources.length > 0) params.set("src", joinList(filters.sources));
  if (filters.minPrice !== null) params.set("pmin", String(filters.minPrice));
  if (filters.maxPrice !== null) params.set("pmax", String(filters.maxPrice));
  // Записываем только выключенное: умолчание — показывать всё, и чистая выдача
  // обязана оставаться короткой ссылкой без параметров.
  if (!filters.includeNoPrice) params.set("noprice", HIDE);
  if (!filters.includeForeignCurrency) params.set("fx", HIDE);
  if (filters.verdict !== "ALL") params.set("verdict", filters.verdict);
  if (filters.closingSoonOnly) params.set("soon", "1");
  if (filters.hideClosed) params.set("closed", "hide");
  if (filters.hasHardBlockers !== null) {
    params.set("blk", filters.hasHardBlockers ? "yes" : "no");
  }
  if (filters.hasAdvance !== null) params.set("adv", filters.hasAdvance ? "yes" : "no");
  if (filters.hasSecurity !== null) params.set("sec", filters.hasSecurity ? "yes" : "no");
  if (filters.pipelineStatus !== "ALL") params.set("pipe", filters.pipelineStatus);
  if (filters.batchStamp !== null) params.set("batch", filters.batchStamp);
  if (filters.sortField !== defaultFilters.sortField) params.set("sort", filters.sortField);
  if (filters.sortDir !== defaultFilters.sortDir) params.set("dir", filters.sortDir);
  if (filters.page !== defaultFilters.page) params.set("page", String(filters.page));
  if (filters.pageSize !== defaultFilters.pageSize) params.set("size", String(filters.pageSize));
  return params;
}

/** Разбирает параметры URL в фильтры; мусор и неизвестные ключи отбрасывает. */
export function filtersFromSearchParams(params: URLSearchParams): TenderFilters {
  const laws = pickEnum<TenderLaw>(params.get("law"), TENDER_LAWS);
  const sources = pickEnum<TenderDataSource>(params.get("src"), TENDER_DATA_SOURCES);
  const verdicts = pickEnum<TenderVerdict>(params.get("verdict"), TENDER_VERDICTS);
  const pipes = pickEnum<PipelineStatus>(params.get("pipe"), PIPELINE_STATUSES);
  const sortRaw = params.get("sort");
  const sortField = SORT_FIELDS.includes(sortRaw as SortField)
    ? (sortRaw as SortField)
    : defaultFilters.sortField;
  const dirRaw = params.get("dir");

  return {
    ...defaultFilters,
    search: params.get("q") ?? "",
    searchKeywords: splitList(params.get("q2")),
    excludeKeywords: splitList(params.get("x")),
    exactMatch: params.get("exact") === "1",
    scopes: pickEnum<SearchScope>(params.get("scope"), ALL_SCOPES),
    laws,
    region: params.get("reg") ?? "",
    regions: splitList(params.get("reg2")),
    customerInn: (params.get("inn") ?? "").replace(/\D/g, "").slice(0, 12),
    customerInns: splitList(params.get("inn2"))
      .map((v) => v.replace(/\D/g, "").slice(0, 12))
      .filter(Boolean),
    sources,
    minPrice: pickNumber(params.get("pmin")),
    maxPrice: pickNumber(params.get("pmax")),
    // Любое значение кроме «hide» трактуется как «показывать»: ссылка с
    // опечаткой не должна молча прятать закупки.
    includeNoPrice: params.get("noprice") !== HIDE,
    includeForeignCurrency: params.get("fx") !== HIDE,
    verdict: verdicts[0] ?? "ALL",
    closingSoonOnly: params.get("soon") === "1",
    hideClosed: params.get("closed") === "hide",
    hasHardBlockers: pickTri(params.get("blk")),
    hasAdvance: pickTri(params.get("adv")),
    hasSecurity: pickTri(params.get("sec")),
    pipelineStatus: pipes[0] ?? "ALL",
    batchStamp: pickStamp(params.get("batch")),
    sortField,
    sortDir: dirRaw === "asc" ? "asc" : dirRaw === "desc" ? "desc" : defaultFilters.sortDir,
    page: pickInt(params.get("page"), 1, 10_000, defaultFilters.page),
    pageSize: pickInt(params.get("size"), 10, 100, defaultFilters.pageSize),
  };
}

/**
 * Сколько ограничений сейчас действует (закон не считаем: у него свой
 * переключатель со счётчиками). Число показываем на кнопке «Фильтры», чтобы
 * свёрнутая панель не притворялась пустой.
 */
export function countActiveFilters(filters: TenderFilters): number {
  let count = 0;
  if (filters.search.trim() !== "") count += 1;
  if (filters.searchKeywords.length > 0) count += 1;
  if (filters.excludeKeywords.length > 0) count += 1;
  if (filters.exactMatch) count += 1;
  if (filters.scopes.length > 0) count += 1;
  if (filters.region !== "" || filters.regions.length > 0) count += 1;
  if (filters.customerInn !== "" || filters.customerInns.length > 0) count += 1;
  if (filters.sources.length > 0) count += 1;
  if (filters.minPrice !== null) count += 1;
  if (filters.maxPrice !== null) count += 1;
  // Переключатели цены считаем, только когда они выключены: включённое —
  // умолчание, а не ограничение выдачи.
  if (!filters.includeNoPrice) count += 1;
  if (!filters.includeForeignCurrency) count += 1;
  if (filters.verdict !== "ALL") count += 1;
  if (filters.closingSoonOnly) count += 1;
  if (filters.hideClosed) count += 1;
  if (filters.hasHardBlockers !== null) count += 1;
  if (filters.hasAdvance !== null) count += 1;
  if (filters.hasSecurity !== null) count += 1;
  if (filters.pipelineStatus !== "ALL") count += 1;
  if (filters.batchStamp !== null) count += 1;
  return count;
}

/** Параметры адреса, которые задают только вид выдачи, а не отбор. */
const VIEW_ONLY_PARAMS = new Set(["sort", "dir", "page", "size"]);

/**
 * В адресе нет условий отбора — только порядок, страница или размер страницы.
 *
 * Такой адрес лента получает, когда человек переключил порядок: профиль поиска
 * при этом обязан применяться. Раньше любой параметр отключал профиль, и
 * «Порядок: свежие сверху» показывал всю базу вместо закупок профиля
 * (замечание 05.10.2026).
 */
export function hasOnlyViewParams(params: URLSearchParams): boolean {
  for (const key of params.keys()) {
    if (!VIEW_ONLY_PARAMS.has(key)) return false;
  }
  return true;
}
