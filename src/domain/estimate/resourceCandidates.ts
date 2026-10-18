import type { EstimatePriceBook } from "@/domain/estimate/calculate";
import { stem, uniqueTokens } from "@/domain/estimate/normalize";
import { classifyResourceCode } from "@/domain/estimate/resourceKinds";
import type { BillOfWorkItem, MaterialRow, ResourcePrice } from "@/domain/estimate/types";
import { deriveSupplyDivisor, parseUnit } from "@/domain/estimate/units";

/**
 * Ресурсы справочника цен как кандидаты на роль материала строки ведомости.
 *
 * Зачем. Строка «Трубы стальные электросварные прямошовные … наружный диаметр 89 мм, толщина стенки 5 мм, м, 681,75» — не работа, а
 * поставка, и считается по цене ресурса ФСБЦ (`computeResourceLine`). Шифра ресурса в ведомости нет, его надо найти по наименованию
 * в справочнике цен: у книги цен зоны есть код, наименование, единица и цена каждого ресурса (`EstimatePriceBook.current`, `.base`).
 *
 * Как ищется. Тем же приёмом, что и подбор норм (`matchNorms.ts`): наименование и название ресурса разбираются на основы слов
 * (`normalize.ts`), вес основы — обратная частота в справочнике (редкое слово «электросварные» весит больше, чем «стальные»), покрытие
 * — доля веса слов строки, нашедшихся в названии ресурса. Числа — тоже слова: «89» и «5» отличают трубу диаметром 89 мм от соседних
 * диаметров. Поиск возвращает только то, что есть в справочнике: придумать код нельзя по построению.
 *
 * Кандидаты отсеиваются по единице: цена ресурса за «т» не годится для объёма в «м» (пересчёт возможен лишь через массу метра, которой
 * в ведомости обычно нет — тогда ресурс не предлагается). Годятся единицы той же величины с точным соотношением: «м» ↔ «1000 м» ↔ «км»,
 * «кг» ↔ «т», «100 шт» ↔ «шт» (`deriveSupplyDivisor`). Машины и труд в кандидаты не входят: это поставка материала.
 *
 * Без ИИ (`pickByName`) ресурс берётся только при высоком покрытии, всех числах строки в названии ресурса и явном лидере — иначе строка
 * остаётся без цены. Порог консервативный: неверный ресурс — неверные деньги, а строка «нет цены — проверьте» видна человеку.
 *
 * Модуль чистый: ни сети, ни диска.
 */

/** Сколько ресурсов-кандидатов уходит модели на одну строку. */
export const MAX_RESOURCE_CANDIDATES = 15;
/** Предел кандидатов в запросе к ручке: больше сборщик не отдаёт, а ручка не принимает. */
export const MAX_REQUEST_RESOURCES = 20;
/** Префикс ответа модели для ресурса: «РЕСУРС|23.3.06.04-0026». Норма — «книга|шифр», например «ГЭСН|15-01-070-01». */
export const RESOURCE_PICK_PREFIX = "РЕСУРС";

/** Ключ ресурса, которым отвечает модель. */
export function resourceKey(code: string): string {
  return `${RESOURCE_PICK_PREFIX}|${code}`;
}

/** Ответ модели — ресурс, а не норма. */
export function isResourcePick(pick: string | null): boolean {
  return pick !== null && pick.startsWith(`${RESOURCE_PICK_PREFIX}|`);
}

/** Один ресурс справочника цен, пригодный для покупки. */
export interface ResourceEntry {
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  /** Цена за единицу, ₽ без НДС: текущая цена зоны, а когда её нет — база 2022. Больше нуля. */
  readonly price: number;
  readonly priceLevel: "CURRENT" | "BASE_2022";
}

/** Кандидат так, как его видит модель. */
export interface ResourcePickCandidate {
  /** «РЕСУРС|шифр» — то, что модель вернёт в ответе. */
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly price: number;
}

/** Откуда берутся ресурсы: книга цен без файлов сплит-формы (у них нет наименований). */
export type ResourcePriceSource = Pick<EstimatePriceBook, "current" | "base">;

export interface ResourceSearchIndex {
  readonly size: number;
  readonly entries: readonly ResourceEntry[];
  readonly byCode: ReadonlyMap<string, ResourceEntry>;
  /** Основы слов названия каждого ресурса. */
  readonly stemsByPosition: readonly (readonly string[])[];
  /** Основа → позиции ресурсов. */
  readonly postings: ReadonlyMap<string, number[]>;
  /** В скольких названиях встречается основа — для весов. */
  readonly documentFrequency: ReadonlyMap<string, number>;
}

const isPriced = (price: number): boolean => Number.isFinite(price) && price > 0;

/** Основы слов без повторов: то, по чему идёт сопоставление (как `uniqueStems` в `matchNorms.ts`). */
function uniqueStems(input: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of uniqueTokens(input)) {
    const base = stem(token);
    if (seen.has(base)) continue;
    seen.add(base);
    result.push(base);
  }
  return result;
}

/** Ресурсы справочника: материалы и изделия с наименованием и ценой (машины, труд и ресурсы без названия не берутся). */
export function resourceEntriesOf(book: ResourcePriceSource): ResourceEntry[] {
  const codes = new Set<string>([...book.base.keys(), ...book.current.keys()]);
  const entries: ResourceEntry[] = [];
  for (const code of codes) {
    if (classifyResourceCode(code) !== "MATERIAL") continue;
    const current: ResourcePrice | undefined = book.current.get(code);
    const base: ResourcePrice | undefined = book.base.get(code);
    const useCurrent = current !== undefined && isPriced(current.price);
    const priced = useCurrent ? current : base !== undefined && isPriced(base.price) ? base : undefined;
    if (priced === undefined) continue;
    const name = ((useCurrent ? current.name : "") || current?.name || base?.name || "").replace(/\s+/gu, " ").trim();
    const unit = (priced.unit || current?.unit || base?.unit || "").trim();
    if (name === "" || unit === "") continue;
    entries.push({ code, name, unit, price: priced.price, priceLevel: useCurrent ? "CURRENT" : "BASE_2022" });
  }
  return entries.sort((a, b) => a.code.localeCompare(b.code, "ru"));
}

/** Строит индекс по справочнику. Вызывается один раз на книгу цен (`resourceIndexOf`). */
export function createResourceIndex(book: ResourcePriceSource): ResourceSearchIndex {
  const entries = resourceEntriesOf(book);
  const byCode = new Map<string, ResourceEntry>();
  const postings = new Map<string, number[]>();
  const documentFrequency = new Map<string, number>();
  const stemsByPosition: string[][] = [];

  entries.forEach((entry, position) => {
    byCode.set(entry.code, entry);
    const stems = uniqueStems(entry.name);
    stemsByPosition.push(stems);
    for (const token of stems) {
      const bucket = postings.get(token);
      if (bucket === undefined) postings.set(token, [position]);
      else bucket.push(position);
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  });

  return { size: entries.length, entries, byCode, stemsByPosition, postings, documentFrequency };
}

/** Индекс по книге цен: строится один раз на книгу (карты `base` и `current` долгоживущие и не меняются). */
const INDEX_CACHE = new WeakMap<object, { readonly current: object; readonly index: ResourceSearchIndex }>();

export function resourceIndexOf(book: ResourcePriceSource): ResourceSearchIndex {
  const cached = INDEX_CACHE.get(book.base);
  if (cached !== undefined && cached.current === book.current) return cached.index;
  const index = createResourceIndex(book);
  INDEX_CACHE.set(book.base, { current: book.current, index });
  return index;
}

/** Вес основы: чем реже в справочнике, тем различительнее. */
function weightOf(index: ResourceSearchIndex, token: string): number {
  const frequency = index.documentFrequency.get(token) ?? 0;
  return frequency === 0 ? 0 : Math.log(1 + index.size / frequency);
}

/** Найденный ресурс и насколько он похож на строку. */
export interface ResourceMatch {
  readonly entry: ResourceEntry;
  /** Доля веса слов строки, нашедшихся в названии ресурса, 0–1 (слова, которых нет в справочнике вовсе, не входят). */
  readonly coverage: number;
  /** То же, но слово строки, которого нет ни в одном названии, входит в знаменатель весом самого редкого слова. */
  readonly strictCoverage: number;
  /** Доля веса слов названия ресурса, нашедшихся в строке: короткое точное название выше длинного с лишним. */
  readonly precision: number;
  /** Чем выше, тем ближе; смысла вне сравнения нет. */
  readonly score: number;
  /** Числа строки (диаметры, толщины, размеры), которых нет в названии ресурса. */
  readonly missingNumbers: readonly string[];
}

const NUMBER_STEM = /^\d+(?:[.,]\d+)?$/u;

/**
 * Ищет ресурсы по наименованию строки. Каждый результат — запись справочника.
 * Ранжирование: покрытие слов строки (главное), точность названия ресурса (малая добавка) и совпадение всех чисел.
 */
export function findResources(index: ResourceSearchIndex, request: { readonly name: string; readonly limit?: number }): ResourceMatch[] {
  const limit = request.limit ?? 30;
  const queryStems = uniqueStems(request.name);
  if (queryStems.length === 0 || index.size === 0) return [];

  const totalWeight = queryStems.reduce((sum, token) => sum + weightOf(index, token), 0);
  const unknown = queryStems.filter((token) => weightOf(index, token) === 0).length;
  const strictTotal = totalWeight + unknown * Math.log(1 + index.size);
  const numbers = queryStems.filter((token) => NUMBER_STEM.test(token));

  const raw = new Map<number, number>();
  for (const token of queryStems) {
    const positions = index.postings.get(token);
    if (positions === undefined) continue;
    const weight = weightOf(index, token);
    for (const position of positions) raw.set(position, (raw.get(position) ?? 0) + weight);
  }

  const matches: ResourceMatch[] = [];
  for (const [position, matched] of raw) {
    const entry = index.entries[position];
    const stems = index.stemsByPosition[position];
    if (entry === undefined || stems === undefined) continue;
    const coverage = totalWeight > 0 ? matched / totalWeight : 0;
    const entryWeight = stems.reduce((sum, token) => sum + weightOf(index, token), 0);
    const precision = entryWeight > 0 ? Math.min(matched / entryWeight, 1) : 0;
    const missingNumbers = numbers.filter((token) => !stems.includes(token));
    const score = coverage * 10 + precision * 3 - missingNumbers.length * 1.5;
    matches.push({ entry, coverage, strictCoverage: strictTotal > 0 ? matched / strictTotal : 0, precision, score: Math.round(score * 1000) / 1000, missingNumbers });
  }
  matches.sort((a, b) => b.score - a.score || a.entry.code.localeCompare(b.entry.code, "ru"));
  return matches.slice(0, limit);
}

/* ------------------------------ единицы ------------------------------ */

/**
 * Масса одного метра, кг, если документ её называет: «масса 1 м — 12,5 кг», «12,5 кг/м». Нет — null: плотность и массу метра трубы
 * придумывать нельзя, и труба с ценой за тонну при объёме в метрах без этого числа не переводится.
 */
export function massPerMetreKg(text: string): number | null {
  const flat = text.replace(/\s+/gu, " ");
  const patterns = [
    /масс[аы]?\s*(?:1|одного)\s*(?:п\.?\s*)?м(?:етра|\.)?\s*[-–—:=]?\s*(\d+(?:[.,]\d+)?)\s*(кг|т)(?![\p{L}])/iu,
    /(\d+(?:[.,]\d+)?)\s*(кг|т)\s*\/\s*(?:п\.?\s*)?м(?![\p{L}])/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(flat);
    if (match === null) continue;
    const value = Number((match[1] as string).replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) continue;
    return (match[2] as string).toLowerCase() === "т" ? value * 1000 : value;
  }
  return null;
}

/** Единицы строки и ресурса переводятся одна в другую: той же величины с точным соотношением или «м» → «т/кг» по названной массе метра. */
export function resourceUnitFits(billUnit: string, catalogUnit: string, kgPerMetre: number | null): boolean {
  if (deriveSupplyDivisor(billUnit, catalogUnit) !== null) return true;
  if (kgPerMetre === null || !(kgPerMetre > 0)) return false;
  const bill = parseUnit(billUnit);
  const catalog = parseUnit(catalogUnit);
  return bill?.unit === "м" && bill.multiplier === 1 && catalog !== null && (catalog.unit === "т" || catalog.unit === "кг");
}

/**
 * Пересчёт «метры → килограммы» нужен, когда ни одна единица строки не переводится в единицу ресурса напрямую, а масса метра в документе названа.
 * null — пересчёт не нужен (единица переводится сама) или невозможен.
 */
export function massConversionFor(
  units: readonly string[],
  entry: Pick<ResourceEntry, "unit">,
  kgPerMetre: number | null,
): { readonly kgPerMetre: number } | null {
  if (kgPerMetre === null || !(kgPerMetre > 0)) return null;
  if (units.some((unit) => deriveSupplyDivisor(unit, entry.unit) !== null)) return null;
  return units.some((unit) => resourceUnitFits(unit, entry.unit, kgPerMetre)) ? { kgPerMetre } : null;
}

/* ------------------------------ кандидаты ------------------------------ */

export interface ResourceSearchInput {
  readonly workName: string;
  /** Единица строки и единицы других её величин. Пусто — единицы не фильтруют. */
  readonly units: readonly string[];
  /** Масса метра из документа, кг; null — не названа. */
  readonly kgPerMetre?: number | null;
  readonly limit?: number;
}

/** Ресурсы-кандидаты под строку: по убыванию близости, только с переводимой единицей. */
export function collectResourceMatches(index: ResourceSearchIndex, input: ResourceSearchInput): ResourceMatch[] {
  const kgPerMetre = input.kgPerMetre ?? null;
  const fits = (entry: ResourceEntry): boolean =>
    input.units.length === 0 || input.units.some((unit) => resourceUnitFits(unit, entry.unit, kgPerMetre));
  return findResources(index, { name: input.workName, limit: 200 })
    .filter((match) => fits(match.entry))
    .slice(0, input.limit ?? MAX_RESOURCE_CANDIDATES);
}

export function resourceCandidateOf(entry: ResourceEntry): ResourcePickCandidate {
  return { key: resourceKey(entry.code), code: entry.code, name: entry.name, unit: entry.unit, price: Math.round(entry.price * 100) / 100 };
}

/* ------------------------------ запасной выбор без ИИ ------------------------------ */

/**
 * Порог выбора ресурса по наименованию без ИИ. Выбран консервативно, как `MIN_NAME_COVERAGE` у норм: шесть из семи слов строки должны
 * найтись в названии ресурса. Ниже строка остаётся «нет цены — проверьте», а решает человек или модель.
 */
export const FALLBACK_MIN_COVERAGE = 0.8;
export const FALLBACK_MIN_STRICT_COVERAGE = 0.7;
/** Лидер должен обгонять второго кандидата по `score` не меньше чем на столько раз: иначе таких ресурсов несколько, и выбирать нечем. */
export const FALLBACK_LEAD = 1.1;

/**
 * Ресурс по наименованию, без модели: только явный лидер с высоким покрытием слов и всеми числами строки в названии.
 * «Задвижка клиновая» подойдёт к десяткам ресурсов одинаково — лидера нет, и ресурс не выбирается.
 */
export function pickByName(matches: readonly ResourceMatch[]): ResourceMatch | null {
  const top = matches[0];
  if (top === undefined) return null;
  if (top.coverage < FALLBACK_MIN_COVERAGE || top.strictCoverage < FALLBACK_MIN_STRICT_COVERAGE) return null;
  if (top.missingNumbers.length > 0) return null;
  const second = matches.find((match) => match.entry.code !== top.entry.code);
  if (second !== undefined && !(top.score >= second.score * FALLBACK_LEAD)) return null;
  return top;
}

/* ------------------------------ проверка ответа модели ------------------------------ */

export type ResourcePickCheck =
  | { readonly status: "REJECTED"; readonly reason: string }
  | {
      readonly status: "ACCEPTED";
      readonly entry: ResourceEntry;
      /** Объём пересчитан из метров в килограммы по массе метра из документа; null — пересчёта нет. */
      readonly massConversion: { readonly kgPerMetre: number } | null;
    };

/**
 * Проверка ответа «РЕСУРС|шифр»: шифр среди отправленных кандидатов, ресурс есть в справочнике, единица переводится из единицы строки.
 * Модель не считает ни цен, ни объёмов, ни единиц: пересчёт «м» в «кг» делает код и только по массе метра, названной документом.
 */
export function checkResourcePick(
  pick: string,
  candidates: readonly Pick<ResourcePickCandidate, "key">[],
  index: ResourceSearchIndex,
  units: readonly string[],
  kgPerMetre: number | null,
): ResourcePickCheck {
  if (!candidates.some((candidate) => candidate.key === pick)) {
    return { status: "REJECTED", reason: `ресурс «${pick.slice(0, 40)}» вне списка кандидатов` };
  }
  const code = pick.slice(RESOURCE_PICK_PREFIX.length + 1);
  const entry = index.byCode.get(code);
  if (entry === undefined) return { status: "REJECTED", reason: `ресурса «${code}» нет в справочнике цен` };

  if (units.some((unit) => deriveSupplyDivisor(unit, entry.unit) !== null)) return { status: "ACCEPTED", entry, massConversion: null };
  const conversion = massConversionFor(units, entry, kgPerMetre);
  if (conversion !== null) return { status: "ACCEPTED", entry, massConversion: conversion };
  return {
    status: "REJECTED",
    reason: `единица ресурса «${entry.unit}» не переводится из единицы строки «${units.join("», «")}» (${code}); масса метра в документе не названа`,
  };
}

/* ------------------------------ запись в позицию ------------------------------ */

/** Покрытие слов, ниже которого выбор модели без названной уверенности подсвечивается (как `MIN_PICK_COVERAGE` у норм). */
const MIN_PICK_COVERAGE = 0.25;

const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

export function describeEntry(entry: ResourceEntry): string {
  return `ресурс ${entry.code} «${entry.name}», ${money.format(entry.price)} ₽ за ${entry.unit} (${entry.priceLevel === "CURRENT" ? "текущая цена зоны" : "база 2022"})`;
}

export interface ResourceApplyOptions {
  readonly source: "AI" | "NAME";
  /** Почему строка — материал (из `classifyBillRow`). */
  readonly kindReason: string;
  /** Обоснование модели; у запасного выбора пусто. */
  readonly reason: string;
  /** Уверенность модели; null — не назвала или выбор без модели. */
  readonly confidence: "high" | "low" | null;
  /** Покрытие слов строки названием ресурса; у выбора ИИ не обязательно. */
  readonly coverage: number | null;
  /** Пересчёт объёма по массе метра. */
  readonly massConversion?: { readonly kgPerMetre: number } | null;
}

/**
 * Запись принятого ресурса в позицию: `resourceCode` — дальше позиция считается как поставка (`computeResourceLine`: цена × объём, без НР и СП),
 * `materialRow` — пометка «материал подобран ИИ: …» с обоснованием. Объём в метрах при цене за тонну пересчитывается в килограммы только по
 * массе метра из документа и подсвечивается «проверьте».
 */
export function applyResourcePick(item: BillOfWorkItem, entry: ResourceEntry, options: ResourceApplyOptions): BillOfWorkItem {
  const converted = options.massConversion ?? null;
  // Модель не назвала уверенность: решают слова — совсем мало общих со строкой, и выбор подсвечивается.
  const lowCoverage = options.source === "AI" && options.confidence === null && options.coverage !== null && options.coverage < MIN_PICK_COVERAGE;
  const review = options.source === "NAME" || options.confidence === "low" || lowCoverage || converted !== null;
  const reason = options.reason.trim() === "" ? "причина не названа" : options.reason.replace(/[.\s]+$/u, "");
  const parts = [
    options.source === "AI" ? `материал подобран ИИ: ${reason}` : `материал подобран по наименованию без ИИ (слов строки в названии ресурса ${String(Math.round((options.coverage ?? 0) * 100))} %)`,
    describeEntry(entry),
    ...(converted === null ? [] : [`объём пересчитан из метров в килограммы по массе 1 м = ${money.format(converted.kgPerMetre)} кг, названной в документе`]),
    ...(options.confidence === "low" ? ["модель не уверена в выборе"] : []),
    ...(lowCoverage ? ["слов строки в названии ресурса почти нет"] : []),
    ...(options.source === "NAME" ? ["проверьте: ресурс выбран кодом, без модели"] : []),
  ];
  const materialRow: MaterialRow = {
    reason: options.kindReason,
    pick: options.source,
    review,
    coverage: options.coverage,
    note: parts.join("; "),
    pickReason: options.source === "AI" ? reason : "",
    confidence: options.confidence,
  };
  const base: BillOfWorkItem = { ...item, resourceCode: entry.code, materialRow };
  if (converted === null) return base;
  return {
    ...base,
    quantity: item.quantity * converted.kgPerMetre,
    quantityUnit: "кг",
    unitDivisor: 1,
    remark: [item.remark, `объём ${money.format(item.quantity)} м × ${money.format(converted.kgPerMetre)} кг/м`].filter((part): part is string => part != null && part !== "").join("; "),
  };
}

/**
 * Строка — материал, ресурс не подобран: цены нет, норма работы не ищется. Позиция входит в смету пробелом «нет цены — проверьте», а не
 * чужой расценкой.
 */
export function markMaterialUnpriced(item: BillOfWorkItem, kindReason: string, why: string): BillOfWorkItem {
  const materialRow: MaterialRow = {
    reason: kindReason,
    pick: null,
    review: true,
    coverage: null,
    note: `материал: ресурс в справочнике цен не подобран (${why}) — нет цены, проверьте`,
  };
  return { ...item, materialRow };
}
