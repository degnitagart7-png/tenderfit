import type { CompanyProfile } from "@/domain/entities";
import { effectiveSroLimit, isSroActive } from "@/domain/scoring/admission";

/**
 * Проверка профиля компании на внутренние противоречия.
 *
 * Профиль собирает человек, и поля в нём независимы: лимит цены живёт в
 * ограничениях, допуск СРО — в членствах, стоп-слова — в возможностях. Из-за
 * этого профиль может противоречить сам себе, и тогда отбор выглядит сломанным
 * при здоровых данных: закупки отсеиваются правилом, которое владелец профиля
 * не собирался включать. Функция чистая, сеть и хранилище не трогает.
 */

export type ProfileIssueKind =
  /** Лимит цены в ограничениях ниже лимита действующего допуска СРО. */
  | "priceLimitBelowSro"
  /** Стоп-слово совпадает с собственным ключевым словом, товаром или работой. */
  | "stopWordContradictsCapabilities"
  /** Не заполнено ни одно поле, по которому сопоставляется предмет закупки. */
  | "noCapabilities"
  /** География работы пуста: региональные проверки не срабатывают. */
  | "noWorkRegions";

export interface ProfileIssue {
  kind: ProfileIssueKind;
  /** Короткая формулировка: что не так. */
  title: string;
  /** Чем это мешает отбору и что сделать. */
  detail: string;
  /** warning — отбор реально теряет закупки, hint — так тоже можно. */
  severity: "warning" | "hint";
  /** Значения профиля, к которым относится замечание. */
  values: string[];
}

/** Сколько баллов соответствия предмету снимает одно совпавшее стоп-слово. */
const STOP_WORD_PENALTY = 25;

/** Минимальная длина слова, чтобы искать его как подстроку в стоп-слове. */
const MIN_SUBSTRING_WORD = 4;

const money = (value: number): string => `${value.toLocaleString("ru-RU")} ₽`;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, "е");
}

/**
 * Наибольший лимит договора по действующим допускам СРО.
 * null — допусков нет, они не действуют или хотя бы один снял ограничение.
 */
function effectiveSroCeiling(profile: CompanyProfile, now: Date): number | null {
  const limits = profile.sroMemberships
    .filter((membership) => isSroActive(membership, now))
    .map((membership) => effectiveSroLimit(membership));
  if (limits.length === 0) return null;
  if (limits.some((limit) => limit === null)) return null;
  const numeric = limits.filter((limit): limit is number => limit !== null);
  return Math.max(...numeric);
}

/** Все слова профиля, по которым `computeSubjectFit` ищет соответствие предмету. */
function capabilityWords(profile: CompanyProfile): string[] {
  const cap = profile.capabilities;
  return [
    ...cap.keywords,
    ...cap.products,
    ...cap.works,
    ...cap.services,
    ...cap.brandsAndModels,
    ...cap.synonyms,
  ];
}

/**
 * Стоп-слова, которые компания исключает, хотя сама же ими и занимается.
 * Совпадением считается и обратное вхождение: «строительство» в стоп-словах
 * бьёт по работе «строительство объектов капитального строительства».
 */
function contradictingStopWords(profile: CompanyProfile): string[] {
  const own = capabilityWords(profile)
    .map(normalize)
    .filter((word) => word.length > 0);
  const seen = new Set<string>();
  const conflicts: string[] = [];

  for (const raw of profile.capabilities.stopWords) {
    const stop = normalize(raw);
    if (stop.length === 0 || seen.has(stop)) continue;
    const hits = own.some(
      (word) =>
        word.includes(stop) ||
        (word.length >= MIN_SUBSTRING_WORD && stop.includes(word)),
    );
    if (hits) {
      seen.add(stop);
      conflicts.push(raw.trim());
    }
  }
  return conflicts;
}

/**
 * Замечания к профилю: противоречия между его собственными полями.
 * Пустой список — профиль согласован, искать причину пустой выдачи нужно не в нём.
 */
export function auditCompanyProfile(
  profile: CompanyProfile,
  now: Date = new Date(),
): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const restrictions = profile.restrictions;

  const ceiling = effectiveSroCeiling(profile, now);
  if (ceiling !== null && restrictions.maxPrice < ceiling) {
    issues.push({
      kind: "priceLimitBelowSro",
      title: "Лимит цены ниже допуска СРО",
      detail: `Действующий допуск СРО разрешает договоры до ${money(ceiling)}, а в ограничениях профиля стоит ${money(restrictions.maxPrice)}. Закупки дороже ${money(restrictions.maxPrice)} получают критический блокер «Цена вне диапазона профиля» и не доходят до рекомендаций, хотя работать по ним компания может. Поднимите лимит до суммы допуска; если он задан намеренно — оставьте как есть.`,
      severity: "warning",
      values: [money(ceiling), money(restrictions.maxPrice)],
    });
  }

  const conflicts = contradictingStopWords(profile);
  if (conflicts.length > 0) {
    issues.push({
      kind: "stopWordContradictsCapabilities",
      title: "Стоп-слово против собственной деятельности",
      detail: `Профиль исключает закупки со словами: ${conflicts.join(", ")}. Они же заявлены как то, чем компания занимается. Каждое совпадение снимает ${STOP_WORD_PENALTY} баллов с соответствия предмету, поэтому свои закупки отбираются хуже посторонних. Уберите эти слова из стоп-списка.`,
      severity: "warning",
      values: conflicts,
    });
  }

  if (capabilityWords(profile).every((word) => word.trim().length === 0)) {
    issues.push({
      kind: "noCapabilities",
      title: "Не заполнено, чем компания занимается",
      detail:
        "Ключевые слова, товары, работы, услуги и синонимы пусты. Соответствие предмету закупки считается по ним, поэтому у любой закупки оно будет низким и рекомендации не появится ни по одной. Перечислите несколько формулировок из ваших договоров.",
      severity: "warning",
      values: [],
    });
  }

  if (restrictions.workRegions.every((region) => region.trim().length === 0)) {
    issues.push({
      kind: "noWorkRegions",
      title: "География работы не задана",
      detail:
        "Список регионов в ограничениях пуст, поэтому проверка «регион вне географии работы» и вопрос о неопределённом регионе не срабатывают: в отбор попадают закупки со всей России. Заполните список, если компания работает не везде.",
      severity: "hint",
      values: [],
    });
  }

  return issues;
}
