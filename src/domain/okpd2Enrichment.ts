import type { TenderDataSource, TenderLaw } from "@/types/database";

/**
 * Что делать с кодами ОКПД2 в этом прогоне.
 *
 * Плановый прогон пересоздаёт строки источника целиком, поэтому код, добытый из
 * карточки в прошлый раз, пропал бы вместе со строкой, и каждый прогон ходил бы
 * в ЕИС за теми же кодами заново. Планировщик сначала берёт уже известное из
 * базы и только потом тратит запросы на новое, не выходя за бюджет: сто
 * пятьдесят карточек подряд — это минуты и лишняя нагрузка на чужой сайт.
 *
 * Чистая функция: ни сети, ни базы. Что именно вызвать и куда записать — дело
 * скрипта прогона.
 */

/** Только то, что планировщику нужно знать о закупке. */
export interface EnrichCandidate {
  regNumber: string;
  dataSource: TenderDataSource;
  law: TenderLaw;
  okpd2Codes: readonly string[];
  eisUrl: string;
}

export interface Okpd2Plan {
  /** Коды, известные из прошлого прогона: подставить без обращения к карточке. */
  carry: Map<string, string[]>;
  /** Номера закупок, за кодом которых идём в карточку, в порядке выдачи. */
  fetch: string[];
  /** Сколько закупок без кода осталось за бюджетом: ими займётся следующий прогон. */
  deferred: number;
}

/** Сколько карточек за прогон по умолчанию: хватает на новые закупки, не растягивая прогон. */
export const DEFAULT_OKPD2_BUDGET = 60;

export function planOkpd2Enrichment(input: {
  tenders: readonly EnrichCandidate[];
  existing: ReadonlyMap<string, readonly string[]>;
  sources: readonly TenderDataSource[];
  budget: number;
}): Okpd2Plan {
  const carry = new Map<string, string[]>();
  const fetch: string[] = [];
  let deferred = 0;

  for (const tender of input.tenders) {
    if (!input.sources.includes(tender.dataSource)) continue;
    if (tender.okpd2Codes.length > 0) continue;

    const known = input.existing.get(tender.regNumber);
    if (known !== undefined && known.length > 0) {
      carry.set(tender.regNumber, [...known]);
      continue;
    }

    if (fetch.length < input.budget) fetch.push(tender.regNumber);
    else deferred += 1;
  }

  return { carry, fetch, deferred };
}
