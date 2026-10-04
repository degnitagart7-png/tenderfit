import type { SearchProfile, Tender } from "@/domain/entities";
import { isPriceKnown, isRegionKnown } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";

/**
 * Чистые функции сопоставления закупки с профилем поиска.
 * Правила: закон из списка профиля; регион — если список регионов непустой;
 * ИНН заказчика — если список customerInns непустой;
 * цена в границах [minPrice, maxPrice] (null = граница не задана),
 * незапубликованная цена границам не препятствует;
 * ключевые слова — хотя бы одно вхождение в предмет (регистронезависимо),
 * пустой список слов = подходит; стоп-слова — ни одного вхождения в предмет;
 * onlyOpenForSubmission — срок подачи ещё не истёк относительно `now`.
 * Время передаётся параметром: одинаковый вход → одинаковый выход.
 *
 * Регион закупки может быть не определён (`UNKNOWN_REGION`) — в живой выдаче
 * ЕИС регионального поля нет, и на 22.09.2026 так у 109 закупок из 151.
 * Неопределённый регион не означает «другой регион», поэтому он не отсекает
 * закупку, а помечается в `regionUnknown`: иначе фильтр по региону молча
 * выбрасывал бы большинство базы.
 */

/** Критерий профиля поиска, по которому закупка может быть отклонена. */
export type SearchCriterion =
  | "law"
  | "region"
  | "customerInn"
  | "price"
  | "stopWord"
  | "keyword"
  | "deadline";

/** Порядок проверки критериев: он же порядок «насколько близко было совпадение». */
const CRITERION_ORDER: SearchCriterion[] = [
  "law",
  "region",
  "customerInn",
  "price",
  "stopWord",
  "keyword",
  "deadline",
];

export interface SearchMatchExplanation {
  matched: boolean;
  /** Критерий, отклонивший закупку; null, если она подходит. */
  rejectedBy: SearchCriterion | null;
  /**
   * Профиль ограничивает регион, а у закупки он не определён. Закупка всё
   * равно считается подходящей, но результат честнее показывать с оговоркой.
   */
  regionUnknown: boolean;
}

/** Почему закупка подходит профилю или какой именно критерий её отклонил. */
export function explainSearchProfileMatch(
  tender: Tender,
  profile: SearchProfile,
  now: Date,
): SearchMatchExplanation {
  const reject = (rejectedBy: SearchCriterion): SearchMatchExplanation => ({
    matched: false,
    rejectedBy,
    regionUnknown: false,
  });

  if (!profile.laws.includes(tender.law)) return reject("law");

  // Регион не определён — это не несовпадение, а неизвестность: пропускаем
  // дальше и помечаем, чтобы интерфейс мог сказать «регион не определён».
  const regionUnknown =
    profile.regions.length > 0 && !isRegionKnown(tender.region);
  if (
    profile.regions.length > 0 &&
    !regionUnknown &&
    !profile.regions.includes(tender.region)
  ) {
    return reject("region");
  }

  if (
    profile.customerInns.length > 0 &&
    (!tender.customerInn || !profile.customerInns.includes(tender.customerInn))
  ) {
    return reject("customerInn");
  }

  const price = tender.financial.price;
  if (isPriceKnown(price)) {
    if (profile.minPrice != null && price < profile.minPrice) return reject("price");
    if (profile.maxPrice != null && price > profile.maxPrice) return reject("price");
  }

  const subject = tender.subject.toLowerCase();

  if (profile.stopWords.some((w) => subject.includes(w.toLowerCase()))) {
    return reject("stopWord");
  }

  if (
    profile.keywords.length > 0 &&
    !profile.keywords.some((w) => subject.includes(w.toLowerCase()))
  ) {
    return reject("keyword");
  }

  if (
    profile.onlyOpenForSubmission &&
    new Date(tender.deadlines.submissionEnd).getTime() <= now.getTime()
  ) {
    return reject("deadline");
  }

  return { matched: true, rejectedBy: null, regionUnknown };
}

export function matchesSearchProfile(
  tender: Tender,
  profile: SearchProfile,
  now: Date,
): boolean {
  return explainSearchProfileMatch(tender, profile, now).matched;
}

/**
 * Отбор строк по списку профилей: закупка попадает в результат, если
 * соответствует хотя бы одному профилю. Пустой список профилей = без отбора.
 */
export function filterRowsByProfiles(
  rows: TenderRow[],
  profiles: SearchProfile[],
  now: Date,
): TenderRow[] {
  if (profiles.length === 0) return rows;
  return rows.filter((r) =>
    profiles.some((p) => matchesSearchProfile(r.tender, p, now)),
  );
}

/** Регион и его доля в базе — чтобы показать, что в базе действительно есть. */
export interface RegionPresence {
  region: string;
  count: number;
}

/** Отклонения по критериям: сколько закупок не прошло каждый критерий. */
export interface CriterionRejection {
  criterion: SearchCriterion;
  count: number;
}

/**
 * Сводка сопоставления: не только «сколько нашлось», но и почему не нашлось
 * остальное. Пустой результат без объяснения — это тупик для пользователя,
 * поэтому правила проекта требуют показывать причину, а не прятать закупки.
 */
export interface SearchMatchSummary {
  total: number;
  matched: number;
  /** Из совпавших — сколько с неопределённым регионом. */
  matchedRegionUnknown: number;
  /**
   * Отклонения по критериям. Если профилей несколько, закупка приписывается
   * тому критерию, на котором её отклонил профиль, прошедший дальше всех
   * по порядку проверки, — это ближайшая к совпадению причина.
   */
  rejected: CriterionRejection[];
  /** Регионы, которые требуют включённые профили (пусто — фильтр не задан). */
  requestedRegions: string[];
  /** Регионы, реально представленные в базе, по убыванию количества. */
  regionsInBase: RegionPresence[];
  /** Сколько закупок в базе с неопределённым регионом. */
  unknownRegionInBase: number;
}

export function summarizeSearchMatch(
  rows: TenderRow[],
  profiles: SearchProfile[],
  now: Date,
): SearchMatchSummary {
  const rejections = new Map<SearchCriterion, number>();
  let matched = 0;
  let matchedRegionUnknown = 0;

  for (const row of rows) {
    if (profiles.length === 0) {
      matched += 1;
      continue;
    }

    let best: SearchMatchExplanation | null = null;
    let bestRank = -1;
    for (const profile of profiles) {
      const explanation = explainSearchProfileMatch(row.tender, profile, now);
      if (explanation.matched) {
        best = explanation;
        break;
      }
      const rank = explanation.rejectedBy
        ? CRITERION_ORDER.indexOf(explanation.rejectedBy)
        : -1;
      if (rank > bestRank) {
        bestRank = rank;
        best = explanation;
      }
    }

    if (best?.matched) {
      matched += 1;
      if (best.regionUnknown) matchedRegionUnknown += 1;
      continue;
    }
    if (best?.rejectedBy) {
      rejections.set(best.rejectedBy, (rejections.get(best.rejectedBy) ?? 0) + 1);
    }
  }

  const presence = new Map<string, number>();
  let unknownRegionInBase = 0;
  for (const row of rows) {
    const region = row.tender.region;
    if (!isRegionKnown(region)) {
      unknownRegionInBase += 1;
      continue;
    }
    presence.set(region, (presence.get(region) ?? 0) + 1);
  }

  return {
    total: rows.length,
    matched,
    matchedRegionUnknown,
    rejected: CRITERION_ORDER.filter((c) => (rejections.get(c) ?? 0) > 0).map(
      (criterion) => ({ criterion, count: rejections.get(criterion) ?? 0 }),
    ),
    requestedRegions: Array.from(
      new Set(profiles.flatMap((p) => p.regions).map((r) => r.trim()).filter(Boolean)),
    ),
    regionsInBase: Array.from(presence.entries())
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => b.count - a.count || a.region.localeCompare(b.region, "ru")),
    unknownRegionInBase,
  };
}
