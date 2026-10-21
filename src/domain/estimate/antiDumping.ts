import type { TenderLaw } from "@/domain/enums";

/**
 * Антидемпинговая мера: что меняется, когда цену снижают сильно.
 *
 * Допущения о законе (сверены с тем, что уже стоит в `bidEconomics.ts`, пометка `ANTI_DUMPING_44`, и в
 * подсказке таблицы цен; закон мог измениться — в каждом тексте стоит «сверьте с актуальной редакцией»):
 * - 44-ФЗ, ст. 37: цена, сниженная на 25 % и более от НМЦК, — повод для меры. Контракт заключается после
 *   предоставления обеспечения исполнения в 1,5 раза больше установленного в извещении (но не меньше аванса);
 * - при НМЦК до 15 млн ₽ вместо повышенного обеспечения можно подтвердить добросовестность — исполненными
 *   ранее контрактами; при НМЦК выше 15 млн ₽ этой альтернативы нет;
 * - 223-ФЗ мер ст. 37 не знает: антидемпинговые требования, если они есть, заказчик пишет в положении о закупке.
 *
 * Закон закупки не всегда известен (на экране «Смета» закупки нет): тогда правило показывается условно —
 * «если закупка по 44-ФЗ».
 *
 * Модуль чистый.
 */

/** 44-ФЗ, ст. 37: антидемпинговая мера действует при снижении НМЦК на 25 % и более. */
export const ANTI_DUMPING_REDUCTION_PERCENT = 25;
/** Порог НМЦК, ₽: до него вместо повышенного обеспечения можно подтвердить добросовестность. */
export const ANTI_DUMPING_NMC_THRESHOLD = 15_000_000;
/** Во сколько раз растёт обеспечение исполнения контракта. */
export const ANTI_DUMPING_SECURITY_MULTIPLIER = 1.5;

export interface AntiDumpingNote {
  /** Закон закупки; null — не известен, правило условное. */
  readonly law: TenderLaw | null;
  /** Правило показано условно: закон не известен («если закупка по 44-ФЗ»). */
  readonly conditional: boolean;
  /** Во сколько раз растёт обеспечение исполнения контракта. */
  readonly securityMultiplier: number;
  /** Можно ли вместо повышенного обеспечения подтвердить добросовестность (НМЦК не выше 15 млн ₽); null — НМЦК не известна. */
  readonly goodFaithAlternative: boolean | null;
  /** Готовый абзац для экрана, Excel и Word. */
  readonly text: string;
}

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** Снижение достаточное для меры: от 25 % включительно. Дробные значения сравниваются как есть: 24,99 % — ещё не мера. */
export function isAntiDumpingReduction(reductionPercent: number): boolean {
  return reductionPercent >= ANTI_DUMPING_REDUCTION_PERCENT - 1e-9;
}

/**
 * Правило для данной закупки и данного снижения. null — мера не применима: снижение меньше порога или закупка по 223-ФЗ.
 * Для 223-ФЗ отдельной строки не возвращается: говорить нечего, кроме «смотрите положение о закупке» — это уже общая оговорка.
 */
export function antiDumpingNote(params: {
  readonly law: TenderLaw | null | undefined;
  readonly nmc: number | null;
  readonly reductionPercent: number | null;
}): AntiDumpingNote | null {
  const { nmc, reductionPercent } = params;
  const law = params.law ?? null;
  if (law === "FZ_223") return null;
  if (reductionPercent === null || !isAntiDumpingReduction(reductionPercent)) return null;

  const conditional = law === null;
  const goodFaith = nmc === null ? null : nmc <= ANTI_DUMPING_NMC_THRESHOLD;
  const lead = conditional ? "Если закупка по 44-ФЗ (ст. 37): " : "44-ФЗ, ст. 37: ";
  const security = `при снижении цены на 25 % и более от НМЦК обеспечение исполнения контракта увеличивается в ${String(ANTI_DUMPING_SECURITY_MULTIPLIER).replace(".", ",")} раза (не меньше аванса)`;
  const alternative =
    goodFaith === null
      ? "; при НМЦК до 15 млн ₽ вместо этого можно подтвердить добросовестность исполненными контрактами"
      : goodFaith
        ? `; НМЦК ${RUB.format(Math.round(nmc ?? 0))} ₽ не выше 15 млн ₽, поэтому вместо повышенного обеспечения можно подтвердить добросовестность исполненными контрактами`
        : `; НМЦК ${RUB.format(Math.round(nmc ?? 0))} ₽ выше 15 млн ₽, поэтому повышенное обеспечение обязательно — подтвердить добросовестность вместо него нельзя`;
  return {
    law,
    conditional,
    securityMultiplier: ANTI_DUMPING_SECURITY_MULTIPLIER,
    goodFaithAlternative: goodFaith,
    text: `${lead}${security}${alternative}. Учтите эти деньги при выборе цены и сверьте условия с актуальной редакцией закона.`,
  };
}
