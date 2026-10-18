import type { ContractFacts } from "@/domain/analysisConsolidation";
import type { DocumentTerms } from "@/domain/documentTerms";
import type { CustomerLsr } from "@/domain/estimate/customerLsr";

/**
 * Блок «Деньги» в глубоком анализе: что закупка значит для кошелька подрядчика.
 *
 * Зачем. Выводы анализа называли риски договора словами, а подрядчик решает
 * участие в рублях: сколько денег заморозится в обеспечениях и на какой срок,
 * сколько останется после снижения цены на аукционе, придётся ли работать
 * зимой по летней смете, когда придут деньги (замечание владельца 13.10.2026).
 * Всё считает код — по НМЦК, условиям договора из сводки анализа
 * (`analysisConsolidation.ts`), условиям, прочитанным из документов
 * (`documentTerms.ts`), и смете заказчика формы 421/пр (сметная прибыль и
 * накладные по позициям). Чего нет в данных, того нет и в блоке.
 */

export interface SecurityLine {
  kind: "bid" | "contract" | "warranty";
  label: string;
  percent: number | null;
  amount: number | null;
  /** На какое время деньги выбывают. */
  period: string;
}

export interface PriceScenario {
  /** Снижение от НМЦК, доля: 0.1 — 10 %. */
  reduction: number;
  price: number;
  /** Что остаётся от сметной прибыли и накладных после снижения, доля от стоимости по смете. */
  profitLeft: number;
  overheadLeft: number;
  note: string;
}

export interface MarginOutlook {
  /** Сметная прибыль по позициям сметы заказчика, ₽ без НДС. */
  profit: number;
  /** Накладные расходы по позициям, ₽ без НДС. */
  overhead: number;
  /** Стоимость по смете без НДС — база долей. */
  base: number;
  scenarios: PriceScenario[];
}

export interface WinterOutlook {
  /** Месяцы работ, попадающие на зиму (ноябрь–март), — «ноябрь, декабрь». */
  months: string[];
  /** Зимнее удорожание в смете заказчика: процент и строка, или null — не начислено. */
  included: { percent: number; quote: string } | null;
}

export interface MoneyOutlook {
  securities: SecurityLine[];
  /** Сколько может быть заморожено одновременно: обеспечение контракта и гарантии пересекаются на приёмке. */
  frozenPeak: number | null;
  advancePercent: number | null;
  paymentDays: number | null;
  margin: MarginOutlook | null;
  winter: WinterOutlook | null;
}

export interface MoneyOutlookInput {
  price: number | null;
  facts: ContractFacts | null;
  terms: DocumentTerms | null;
  estimates: readonly CustomerLsr[];
  /** Окончание подачи: если дата начала работ неизвестна, работы считаются от неё. */
  submissionEnd: string | null;
}

export const PRICE_REDUCTIONS: readonly number[] = [0.05, 0.1, 0.15, 0.25];

const MONTHS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];
const WINTER_MONTHS = new Set([10, 11, 0, 1, 2]);

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function securityLine(
  kind: SecurityLine["kind"],
  label: string,
  period: string,
  price: number | null,
  percent: number | null,
  amount: number | null,
): SecurityLine | null {
  const pct = positive(percent);
  const sum = positive(amount) ?? (pct !== null && price !== null ? (price * pct) / 100 : null);
  if (pct === null && sum === null) return null;
  return { kind, label, percent: pct, amount: sum, period };
}

function parseDate(value: string | null): Date | null {
  if (value === null || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function winterMonths(start: Date, end: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  for (let guard = 0; cursor <= last && guard < 36; guard += 1) {
    const month = cursor.getUTCMonth();
    if (WINTER_MONTHS.has(month)) out.push(MONTHS[month]!);
    cursor.setUTCMonth(month + 1);
  }
  return [...new Set(out)];
}

function scenarioNote(profitLeft: number, overheadLeft: number): string {
  const pct = (share: number): string => `${(share * 100).toFixed(1).replace(".", ",")} %`;
  if (profitLeft >= 0) return `остаётся сметной прибыли около ${pct(profitLeft)}`;
  if (overheadLeft >= 0) return `сметная прибыль съедена, снижение уходит в накладные (их остаётся ${pct(overheadLeft)})`;
  return "ниже прямых затрат по смете заказчика — работа в убыток, если ваши затраты не ниже сметных";
}

export function computeMoneyOutlook(input: MoneyOutlookInput): MoneyOutlook {
  const price = positive(input.price);
  const facts = input.facts;
  const terms = input.terms;

  const securities: SecurityLine[] = [];
  const bidRequired = terms?.bidSecurity?.required !== false;
  const contractRequired = terms?.contractSecurity?.required !== false;
  if (bidRequired) {
    const line = securityLine(
      "bid",
      "Обеспечение заявки",
      "с подачи заявки до подписания контракта",
      price,
      facts?.bid_security_percent ?? terms?.bidSecurity?.percent ?? null,
      terms?.bidSecurity?.amount ?? null,
    );
    if (line !== null) securities.push(line);
  }
  if (contractRequired) {
    const line = securityLine(
      "contract",
      "Обеспечение исполнения контракта",
      "с подписания контракта до приёмки работ",
      price,
      facts?.contract_security_percent ?? terms?.contractSecurity?.percent ?? null,
      terms?.contractSecurity?.amount ?? null,
    );
    if (line !== null) securities.push(line);
  }
  const warrantyPeriod =
    facts?.warranty_months !== null && facts?.warranty_months !== undefined
      ? `на срок гарантии — ${String(facts.warranty_months)} мес. после приёмки`
      : "на срок гарантии после приёмки";
  const warranty = securityLine(
    "warranty",
    "Обеспечение гарантийных обязательств",
    warrantyPeriod,
    price,
    facts?.warranty_security_percent ?? null,
    null,
  );
  if (warranty !== null) securities.push(warranty);

  const amountOf = (kind: SecurityLine["kind"]): number =>
    securities.find((s) => s.kind === kind)?.amount ?? 0;
  const peak = Math.max(amountOf("bid"), amountOf("contract") + amountOf("warranty"));

  let margin: MarginOutlook | null = null;
  let profit = 0;
  let overhead = 0;
  let base = 0;
  for (const estimate of input.estimates) {
    base += estimate.positionsTotal;
    for (const position of estimate.positions) {
      profit += position.profit?.amount ?? 0;
      overhead += position.overhead?.amount ?? 0;
    }
  }
  if (price !== null && base > 0 && profit > 0) {
    const profitShare = profit / base;
    const overheadShare = overhead / base;
    margin = {
      profit,
      overhead,
      base,
      scenarios: PRICE_REDUCTIONS.map((reduction) => {
        const profitLeft = profitShare - reduction;
        const overheadLeft = profitShare + overheadShare - reduction;
        return {
          reduction,
          price: price * (1 - reduction),
          profitLeft,
          overheadLeft,
          note: scenarioNote(profitLeft, overheadLeft),
        };
      }),
    };
  }

  let winter: WinterOutlook | null = null;
  const end = parseDate(facts?.work_end ?? null);
  const start = parseDate(facts?.work_start ?? null) ?? parseDate(input.submissionEnd);
  if (end !== null && start !== null && end >= start) {
    const months = winterMonths(start, end);
    if (months.length > 0) {
      const line = input.estimates.map((e) => e.limitedCosts?.winter ?? null).find((w) => w !== null) ?? null;
      winter = { months, included: line === null ? null : { percent: line.percent, quote: line.quote } };
    }
  }

  return {
    securities,
    frozenPeak: peak > 0 ? peak : null,
    advancePercent: terms?.advance?.required === false ? 0 : (facts?.advance_percent ?? terms?.advance?.percent ?? null),
    paymentDays: positive(facts?.payment_days ?? null),
    margin,
    winter,
  };
}

/** Есть ли что показать: пустой блок «Деньги» хуже, чем никакого. */
export function hasMoneyOutlook(outlook: MoneyOutlook): boolean {
  return (
    outlook.securities.length > 0 ||
    outlook.margin !== null ||
    outlook.winter !== null ||
    outlook.advancePercent !== null ||
    outlook.paymentDays !== null
  );
}
