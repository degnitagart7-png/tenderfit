import type { TaxSystem } from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";
import type { SsrResult } from "@/domain/estimate/ssr";
import type { EstimateDocument } from "@/domain/estimate/types";
import type { VatBasis } from "@/domain/estimate/vatStatus";

/**
 * Цена и экономика участия по индексной смете.
 *
 * Зачем. Расчёт сметы отвечает на вопрос «сколько это стоит по нормам и текущим
 * ценам Минстроя», но не на тот, ради которого человек его запускает: «какую цену
 * подавать и до какого снижения закупка остаётся выгодной». НМЦК в сметном коде не
 * встречалась вовсе. Здесь расчёт сметы сверяется с ценой заказчика и превращается
 * в границы: безубыточная цена, минимально допустимая цена и допустимое снижение.
 *
 * Граница между моделью и кодом. Модель извлекает объёмы из документации, поиск
 * подбирает нормы, расчёт считает смету — а эти формулы только складывают уже
 * посчитанное. Ни одной цифры здесь не называет языковая модель: деньги считает код,
 * и каждую можно перепроверить на калькуляторе.
 *
 * Чего здесь нет намеренно.
 * - Рекомендуемой цены «с учётом конкуренции»: для неё нужна история протоколов
 *   заказчика, которой в базе нет. Назвать такую цену значило бы выдумать её.
 * - Кассового разрыва и стоимости финансирования: они зависят от аванса и сроков
 *   оплаты договора, а не от сметы.
 * - Прогноза. Сценарии здесь — проверка на прочность («что, если затраты выше
 *   расчёта на 10 %»), а не предположение о том, как будет на самом деле.
 *
 * Сводный сметный расчёт (`ssr.ts`). НМЦК по 44-ФЗ складывается не из голой локальной сметы, а из
 * главы 2-9 ССР, резерва на непредвиденные работы и затраты, прогнозной инфляции и НДС. Поэтому, когда
 * передан `ssr`, НМЦК сравнивается с «нашей оценкой НМЦК» (цена контракта по 841/пр), а не со сметой.
 * Три решения о деньгах, принятых осознанно:
 * - Резерв на непредвиденные в себестоимость НЕ входит. Это деньги заказчика на риск, а не затраты
 *   подрядчика: расходы на непредвиденные работы появятся, только если они случатся, и тогда будут
 *   оплачены сверх. В цене (НМЦК) он есть, в затратах нет; флаг RESERVE_NOT_IN_COST называет его сумму.
 * - Прогнозная инфляция — сквозная статья, как НДС: цена в прогнозном уровне цен, но и затраты
 *   исполняются в нём же, поэтому себестоимость умножается на тот же индекс. Инфляция не добавляет к
 *   марже, как НДС не добавляет выручки плательщику НДС.
 * - НДС — по прежней логике (`nmcIncludesVat`, налоговый режим компании): выручка плательщика НДС без НДС.
 * Без `ssr` расчёт идёт как раньше, итоги не меняются.
 *
 * Модуль чистый: ни сети, ни хранилища, ни `Date.now()`.
 */

/** Допущения расчёта, которые видит пользователь рядом с каждым числом. */
export interface BidEconomicsAssumptions {
  /**
   * Какая доля накладных расходов сметы реально тратится. 1 — вся: осторожный
   * выбор, он завышает себестоимость и занижает допустимое снижение.
   */
  readonly overheadRealization: number;
  /**
   * НМЦК объявлена с НДС. Так бывает у подавляющего большинства закупок, но
   * извещение часто молчит, поэтому по умолчанию это допущение, а не факт.
   */
  readonly nmcIncludesVat: boolean;
  /** Ставка НДС, %, — из документа сметы. */
  readonly vatPercent: number;
}

export interface BidEconomicsInput {
  /** Наш расчёт по нормам и текущим ценам Минстроя. */
  readonly document: EstimateDocument;
  /** НМЦК, ₽, как объявлена. null и ноль — цена не объявлена (частый случай у 223-ФЗ). */
  readonly nmc: number | null;
  /** Позиций в ведомости всего: знаменатель доли непосчитанного. */
  readonly billItems: number;
  /** Позиций, не попавших в расчёт вовсе (норма не найдена, единица не сошлась). */
  readonly droppedPositions: number;
  /** Доля стоимости на допущениях, %. */
  readonly assumedPercent: number;
  /** Ресурсов с расходом, но без денег. */
  readonly unpricedResources: number;
  readonly company: {
    readonly taxSystem: TaxSystem;
    /** Минимально приемлемая маржа, % от выручки без НДС. */
    readonly minMarginPercent: number;
  };
  readonly nmcIncludesVat?: boolean;
  readonly overheadRealization?: number;
  /**
   * Закон закупки. Для 44-ФЗ таблица помечает строки, где работает антидемпинговая
   * мера (ст. 37): там цену снижают не только ради победы, но и ценой дополнительного
   * обеспечения. Нет — закон не известен, пометок нет.
   */
  readonly law?: TenderLaw;
  /**
   * На чём стоит «НМЦК с НДС / без НДС»: факт документации, закон или допущение.
   * От основания зависит серьёзность пометки об НДС. Нет — пометка как раньше.
   */
  readonly vatBasis?: VatBasis;
  /** Дословная цитата документации — для основания DOCUMENT. */
  readonly vatQuote?: string | null;
  /** В документах найдены оба варианта НДС: пометка просит проверить вручную. */
  readonly vatConflict?: boolean;
  /**
   * Сводный сметный расчёт и наша оценка НМЦК. Есть — НМЦК сравнивается с ценой контракта по 841/пр,
   * а себестоимость пересчитывается в прогнозный уровень цен (без резерва на непредвиденные).
   */
  readonly ssr?: SsrResult | null;
}

/** Рубли, округлённые до копеек. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Сколько знаков процента храним: два хватает, больше — ложная точность. */
function pct(value: number): number {
  return Math.round(value * 100) / 100;
}

export type TaxKind = "OSNO" | "USN_INCOME" | "USN_INCOME_EXPENSES" | "PATENT_AS_USN_INCOME";

/** Налоговые ставки. Страховые взносы и вычеты не учитываются: это осторожная оценка. */
const PROFIT_TAX_RATE = 0.2;
const USN_INCOME_RATE = 0.06;
const USN_INCOME_EXPENSES_RATE = 0.15;
const USN_MINIMUM_TAX_RATE = 0.01;

function taxKind(system: TaxSystem): TaxKind {
  if (system === "PATENT") return "PATENT_AS_USN_INCOME";
  return system;
}

/** Деньги при одной цене и одном допущении об отклонении затрат. */
export interface PriceOutcome {
  /** Цена контракта в тех же терминах, что и НМЦК (с НДС, если НМЦК с НДС). */
  readonly price: number;
  /** Выручка, которую компания оставляет себе, без НДС заказчика. */
  readonly revenue: number;
  readonly cost: number;
  readonly tax: number;
  readonly profit: number;
  /** Маржа, % от выручки. */
  readonly marginPercent: number;
}

export type PriceVerdict = "OK" | "BELOW_TARGET_MARGIN" | "LOSS";

export interface PriceRow extends PriceOutcome {
  /** Доля от НМЦК, %. */
  readonly percentOfNmc: number;
  readonly verdict: PriceVerdict;
  /**
   * На сколько процентов могут вырасти затраты при этой цене, пока прибыль после
   * налогов не станет нулевой. 0 — строка убыточна уже сейчас.
   */
  readonly safetyMarginPercent: number;
  /** 44-ФЗ, ст. 37: снижение от 25 % — действует антидемпинговая мера. */
  readonly antiDumping: boolean;
}

export interface StressCell extends PriceOutcome {
  /** Насколько фактические затраты выше расчёта, %. */
  readonly costOverrunPercent: number;
  readonly percentOfNmc: number;
}

export type ComparisonBand =
  /** НМЦК ниже расчётной себестоимости: закупка убыточна ещё до снижения. */
  | "BELOW_COST"
  /** Ниже расчёта по смете больше чем на 5 %. */
  | "BELOW_ESTIMATE"
  /** В пределах 5 % от расчёта. */
  | "NEAR_ESTIMATE"
  /** Выше расчёта больше чем на 5 %. */
  | "ABOVE_ESTIMATE"
  /** Часть работ не оценена: расчёт — нижняя граница, и вывод «выше» или «рядом» недоказуем. */
  | "INCOMPLETE"
  /** НМЦК не объявлена. */
  | "NO_NMC";

export type FlagSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";

export interface BidFlag {
  readonly code: string;
  readonly severity: FlagSeverity;
  readonly message: string;
}

export interface BidConfidence {
  /** 0–100. Надёжность расчёта (насколько полно он опирается на данные), а не вероятность выигрыша. */
  readonly score: number;
  readonly reasons: readonly string[];
}

/** Что из сводного расчёта легло в цену участия. */
export interface BidSsrBasis {
  /** Наша оценка НМЦК без НДС, ₽. */
  readonly nmcEstimateBeforeVat: number;
  readonly nmcEstimateWithVat: number;
  /** Резерв на непредвиденные в цене, ₽ без НДС и инфляции; в себестоимость не входит. */
  readonly reserve: number;
  readonly reservePercent: number;
  /** Индекс прогнозной инфляции; 1 — не применён. */
  readonly inflationIndex: number;
  readonly inflationApplied: boolean;
  /** Себестоимость умножена на индекс инфляции: это та же статья цены, что НДС. */
  readonly costInflated: boolean;
}

export type BidEconomicsStatus = "COMPUTED" | "EMPTY";

export interface BidEconomics {
  readonly status: BidEconomicsStatus;
  readonly assumptions: BidEconomicsAssumptions;
  readonly taxKind: TaxKind;
  readonly minMarginPercent: number;

  /** Составные части расчёта, ₽ без НДС. */
  readonly basis: {
    readonly directCost: number;
    readonly overhead: number;
    /** Сметная прибыль: нормативная, а не фактическая. */
    readonly estimatedProfit: number;
    readonly limitedCosts: number;
    readonly materials: number;
    /** Итог сметы без НДС. */
    readonly estimateBeforeVat: number;
    /** Себестоимость исполнения: прямые затраты, накладные и лимитированные. */
    readonly cost: number;
    /** НДС, который не принимается к вычету (плательщик УСН): на материалах. */
    readonly nonDeductibleVat: number;
    /**
     * С чем сравнивается НМЦК: наша оценка цены контракта по ССР (без НДС) или итог сметы. Равно
     * `estimateBeforeVat`, когда ССР не передан.
     */
    readonly comparedWithBeforeVat: number;
  };

  /** ССР в цене участия; null — ССР не передан, сравнение идёт со сметой. */
  readonly ssr: BidSsrBasis | null;

  readonly nmc: number | null;
  /** НМЦК без НДС, если известно, что она с НДС. */
  readonly nmcBeforeVat: number | null;
  /** НМЦК к расчёту по смете, раз. null — НМЦК нет. */
  readonly ratioToEstimate: number | null;
  readonly band: ComparisonBand;

  readonly coverage: {
    readonly billItems: number;
    readonly droppedPositions: number;
    /** Расчёт неполон: итог — нижняя граница. */
    readonly isLowerBound: boolean;
    readonly droppedShare: number;
  };

  /** Цена, при которой прибыль после налогов равна нулю. */
  readonly breakEvenPrice: number | null;
  /** Цена, ниже которой маржа падает под минимум компании. */
  readonly minAcceptablePrice: number | null;
  /** Допустимое снижение НМЦК, %. null — НМЦК нет, 0 — снижать нельзя. */
  readonly maxReductionPercent: number | null;
  /**
   * Запас прочности при НМЦК: на сколько процентов могут вырасти затраты, пока
   * прибыль после налогов не станет нулевой. 0 — при НМЦК уже убыток; null — НМЦК нет.
   * Не больше {@link SAFETY_MARGIN_CAP}: дальше считать нечего.
   */
  readonly safetyMarginPercent: number | null;

  readonly priceTable: readonly PriceRow[];
  readonly stress: readonly StressCell[];
  readonly flags: readonly BidFlag[];
  readonly confidence: BidConfidence;
}

/** Проценты от НМЦК, по которым печатается таблица. */
export const PRICE_GRID_PERCENT: readonly number[] = [100, 95, 90, 85, 80, 75, 70];
/** Перерасход затрат, на котором проверяется прочность цены. */
export const STRESS_OVERRUN_PERCENT: readonly number[] = [0, 10, 20];
/** Цены, на которых печатается проверка на прочность. */
export const STRESS_PRICE_PERCENT: readonly number[] = [100, 90, 80];

/** Верхняя граница поиска запаса прочности, %: при большем запасе цифра уже не помогает решению. */
export const SAFETY_MARGIN_CAP = 500;
/** 44-ФЗ, ст. 37: антидемпинговая мера действует при снижении НМЦК на 25 % и более. */
export const ANTI_DUMPING_REDUCTION_PERCENT = 25;

/** Допуск «рядом с расчётом»: ±5 %. */
const NEAR_TOLERANCE = 0.05;

function sumMaterials(document: EstimateDocument): number {
  let total = 0;
  for (const section of document.sections) {
    for (const line of section.lines) total += line.materialCost;
  }
  return total;
}

interface CostModel {
  readonly vatRate: number;
  readonly vatPayer: boolean;
  readonly nmcIncludesVat: boolean;
  readonly kind: TaxKind;
  /** Затраты при нулевом перерасходе, ₽. */
  readonly cost: number;
}

/** Налог на прибыль или доход, ₽. */
function taxOf(model: CostModel, revenue: number, cost: number): number {
  switch (model.kind) {
    case "OSNO":
      return Math.max(0, revenue - cost) * PROFIT_TAX_RATE;
    case "USN_INCOME":
    case "PATENT_AS_USN_INCOME":
      return revenue * USN_INCOME_RATE;
    case "USN_INCOME_EXPENSES":
      return Math.max(
        Math.max(0, revenue - cost) * USN_INCOME_EXPENSES_RATE,
        revenue * USN_MINIMUM_TAX_RATE,
      );
  }
}

/** Деньги при цене без округления: решатель цены сравнивает именно их. */
function rawOutcome(
  model: CostModel,
  price: number,
  overrunPercent: number,
): { revenue: number; cost: number; tax: number; profit: number } {
  // Плательщик НДС отдаёт его бюджету: выручка — цена без НДС. Остальным
  // цена достаётся целиком, но и НДС в ценах поставщиков им не вернуть.
  const revenue =
    model.vatPayer && model.nmcIncludesVat ? price / (1 + model.vatRate) : price;
  const cost = model.cost * (1 + overrunPercent / 100);
  const tax = taxOf(model, revenue, cost);
  return { revenue, cost, tax, profit: revenue - cost - tax };
}

function outcomeAt(
  model: CostModel,
  price: number,
  overrunPercent: number,
): PriceOutcome {
  const { revenue, cost, tax, profit } = rawOutcome(model, price, overrunPercent);
  return {
    price: money(price),
    revenue: money(revenue),
    cost: money(cost),
    tax: money(tax),
    profit: money(profit),
    marginPercent: revenue > 0 ? pct((profit / revenue) * 100) : -100,
  };
}

/**
 * Наименьшая цена, при которой условие выполнено. Прибыль и маржа растут с ценой
 * при любом налоговом режиме, поэтому делением отрезка пополам решение находится
 * без формул под каждый режим. null — условие недостижимо до верхней границы.
 */
function solvePrice(
  holds: (price: number) => boolean,
  upper: number,
): number | null {
  if (!holds(upper)) return null;
  let low = 0;
  let high = upper;
  for (let step = 0; step < 80; step += 1) {
    const middle = (low + high) / 2;
    if (holds(middle)) high = middle;
    else low = middle;
    if (high - low < 0.005) break;
  }
  return money(high);
}

/**
 * Запас прочности цены: на сколько процентов могут вырасти затраты, пока прибыль
 * после налогов не стала отрицательной. Прибыль убывает с затратами при любом
 * налоговом режиме, поэтому границу находит деление отрезка пополам по перерасходу,
 * без формул под каждый режим. Сравнение — до округления, как у решателя цены.
 */
function solveSafetyMargin(model: CostModel, price: number): number {
  if (rawOutcome(model, price, 0).profit < 0) return 0;
  if (rawOutcome(model, price, SAFETY_MARGIN_CAP).profit >= 0) return SAFETY_MARGIN_CAP;
  let low = 0;
  let high = SAFETY_MARGIN_CAP;
  for (let step = 0; step < 100; step += 1) {
    const middle = (low + high) / 2;
    if (rawOutcome(model, price, middle).profit >= 0) low = middle;
    else high = middle;
    if (high - low < 1e-7) break;
  }
  return pct(low);
}

export function computeBidEconomics(input: BidEconomicsInput): BidEconomics {
  const { document, company } = input;
  const totals = document.totals;
  const vatPercent = document.parameters.vatPercent;
  const nmcIncludesVat = input.nmcIncludesVat ?? true;
  const overheadRealization = Math.min(
    1.5,
    Math.max(0, input.overheadRealization ?? 1),
  );
  const assumptions: BidEconomicsAssumptions = {
    overheadRealization,
    nmcIncludesVat,
    vatPercent,
  };

  const kind = taxKind(company.taxSystem);
  const vatPayer = company.taxSystem === "OSNO";
  const vatRate = vatPercent / 100;

  const ssr = input.ssr !== undefined && input.ssr !== null && input.ssr.status === "COMPUTED" ? input.ssr : null;
  // Инфляция — сквозная статья, как НДС: затраты исполняются в том же прогнозном уровне цен, что и цена.
  const inflationIndex = ssr !== null && ssr.nmc.inflation.applied ? ssr.nmc.inflation.index : 1;

  const limitedCosts = totals.winterSurcharge + totals.temporaryStructures;
  const materials = sumMaterials(document);
  const nonDeductibleVat = vatPayer ? 0 : materials * vatRate;
  // Резерв на непредвиденные в себестоимость не входит: это деньги заказчика на риск, а не затраты подрядчика.
  const cost =
    (totals.directCost +
      totals.overheadCost * overheadRealization +
      limitedCosts +
      nonDeductibleVat) *
    inflationIndex;
  // С чем сравнивается НМЦК: цена контракта по ССР (резерв, инфляция) или итог сметы.
  const comparedBeforeVat = ssr === null ? totals.beforeVat : ssr.nmc.beforeVat;

  const basis = {
    directCost: money(totals.directCost),
    overhead: money(totals.overheadCost),
    estimatedProfit: money(totals.profitCost),
    limitedCosts: money(limitedCosts),
    materials: money(materials),
    estimateBeforeVat: money(totals.beforeVat),
    cost: money(cost),
    nonDeductibleVat: money(nonDeductibleVat),
    comparedWithBeforeVat: money(comparedBeforeVat),
  };
  const ssrBasis: BidSsrBasis | null =
    ssr === null
      ? null
      : {
          nmcEstimateBeforeVat: money(ssr.nmc.beforeVat),
          nmcEstimateWithVat: money(ssr.nmc.total),
          reserve: money(ssr.reserve.amounts.total),
          reservePercent: ssr.reserve.percent,
          inflationIndex,
          inflationApplied: ssr.nmc.inflation.applied,
          costInflated: inflationIndex !== 1,
        };

  const billItems = Math.max(0, input.billItems);
  const droppedPositions = Math.max(0, input.droppedPositions);
  const droppedShare =
    billItems > 0 ? Math.min(1, droppedPositions / billItems) : droppedPositions > 0 ? 1 : 0;
  const isLowerBound = droppedPositions > 0;
  const coverage = {
    billItems,
    droppedPositions,
    isLowerBound,
    droppedShare: pct(droppedShare),
  };

  const nmc = input.nmc !== null && input.nmc > 0 ? input.nmc : null;
  const nmcBeforeVat = nmc === null ? null : nmcIncludesVat ? nmc / (1 + vatRate) : nmc;

  const minMargin = Math.max(0, company.minMarginPercent);
  const flags: BidFlag[] = [];

  // Расчёта нет вовсе: ни одна позиция не посчитана. Говорить о цене нечего.
  if (cost <= 0 || totals.beforeVat <= 0) {
    return {
      status: "EMPTY",
      assumptions,
      taxKind: kind,
      minMarginPercent: minMargin,
      basis,
      ssr: ssrBasis,
      nmc,
      nmcBeforeVat: nmcBeforeVat === null ? null : money(nmcBeforeVat),
      ratioToEstimate: null,
      band: nmc === null ? "NO_NMC" : "INCOMPLETE",
      coverage,
      breakEvenPrice: null,
      minAcceptablePrice: null,
      maxReductionPercent: null,
      safetyMarginPercent: null,
      priceTable: [],
      stress: [],
      flags: [
        {
          code: "NO_ESTIMATE",
          severity: "HIGH",
          message:
            "Смета не посчитана: ни одной позиции ведомости не удалось оценить по нормам. Цену отсюда определить нельзя.",
        },
      ],
      confidence: { score: 0, reasons: ["Расчёт пуст"] },
    };
  }

  const model: CostModel = { vatRate, vatPayer, nmcIncludesVat, kind, cost };

  // Верхняя граница поиска: втрое выше любой цены, о которой имеет смысл говорить.
  const upper = Math.max(nmc ?? 0, comparedBeforeVat * (1 + vatRate), totals.beforeVat * (1 + vatRate)) * 3;
  // Сравнение до округления: округлённая маржа «10,00 %» при настоящих 9,995 %
  // занижала минимальную цену на сотни рублей.
  const breakEvenPrice = solvePrice((p) => rawOutcome(model, p, 0).profit >= 0, upper);
  const minAcceptablePrice = solvePrice((p) => {
    const raw = rawOutcome(model, p, 0);
    return raw.revenue > 0 && (raw.profit / raw.revenue) * 100 >= minMargin;
  }, upper);

  const ratioToEstimate =
    nmcBeforeVat === null ? null : pct(nmcBeforeVat / comparedBeforeVat);

  // «Ниже себестоимости» — по тому, что компания реально получит при НМЦК: у
  // плательщика НДС это цена без НДС, у остальных — цена целиком, но и затраты
  // у них выше на невозвратный НДС. Неполнота расчёта вывод только усиливает:
  // полная себестоимость ещё выше посчитанной.
  const atNmc = nmc === null ? null : outcomeAt(model, nmc, 0);

  let band: ComparisonBand;
  if (nmcBeforeVat === null || atNmc === null) {
    band = "NO_NMC";
  } else if (atNmc.revenue < cost) {
    band = "BELOW_COST";
  } else if (isLowerBound) {
    band = "INCOMPLETE";
  } else if (nmcBeforeVat < comparedBeforeVat * (1 - NEAR_TOLERANCE)) {
    band = "BELOW_ESTIMATE";
  } else if (nmcBeforeVat <= comparedBeforeVat * (1 + NEAR_TOLERANCE)) {
    band = "NEAR_ESTIMATE";
  } else {
    band = "ABOVE_ESTIMATE";
  }

  const maxReductionPercent =
    nmc === null || minAcceptablePrice === null
      ? null
      : minAcceptablePrice >= nmc
        ? 0
        : pct((1 - minAcceptablePrice / nmc) * 100);

  const isFz44 = input.law === "FZ_44";
  const safetyMarginPercent = nmc === null ? null : solveSafetyMargin(model, nmc);

  const priceTable: PriceRow[] =
    nmc === null
      ? []
      : PRICE_GRID_PERCENT.map((percentOfNmc) => {
          const outcome = outcomeAt(model, (nmc * percentOfNmc) / 100, 0);
          const verdict: PriceVerdict =
            outcome.profit < 0
              ? "LOSS"
              : outcome.marginPercent < minMargin
                ? "BELOW_TARGET_MARGIN"
                : "OK";
          return {
            ...outcome,
            percentOfNmc,
            verdict,
            safetyMarginPercent: solveSafetyMargin(model, (nmc * percentOfNmc) / 100),
            antiDumping:
              isFz44 && percentOfNmc <= 100 - ANTI_DUMPING_REDUCTION_PERCENT,
          };
        });

  const stress: StressCell[] =
    nmc === null
      ? []
      : STRESS_PRICE_PERCENT.flatMap((percentOfNmc) =>
          STRESS_OVERRUN_PERCENT.map((costOverrunPercent) => ({
            ...outcomeAt(model, (nmc * percentOfNmc) / 100, costOverrunPercent),
            costOverrunPercent,
            percentOfNmc,
          })),
        );

  // ---- Пометки ----
  if (nmc === null) {
    flags.push({
      code: "NO_NMC",
      severity: "INFO",
      message:
        "Начальная цена в закупке не объявлена: сравнивать расчёт не с чем. Ниже — границы, ниже которых цену подавать невыгодно.",
    });
  } else if (band === "BELOW_COST") {
    flags.push({
      code: "NMC_BELOW_COST",
      severity: "CRITICAL",
      message: `НМЦК ниже расчётной себестоимости: выручка при начальной цене — ${formatShare(atNmc?.revenue ?? 0, cost)} от затрат. Закупка убыточна ещё до снижения — если смета посчитана верно.`,
    });
  } else if (band === "BELOW_ESTIMATE") {
    flags.push({
      code: "NMC_BELOW_ESTIMATE",
      severity: "HIGH",
      message:
        ssrBasis === null
          ? `НМЦК на ${formatDeficit(ratioToEstimate ?? 1)} ниже расчёта по текущим ценам Минстроя. Вероятно, заказчик считал по устаревшим ценам или индексам.`
          : `НМЦК на ${formatDeficit(ratioToEstimate ?? 1)} ниже нашей оценки цены контракта (смета, резерв на непредвиденные, прогнозная инфляция, 841/пр). Вероятно, заказчик считал по устаревшим ценам или индексам.`,
    });
  } else if (band === "ABOVE_ESTIMATE") {
    flags.push({
      code: "NMC_ABOVE_ESTIMATE",
      severity: "INFO",
      message:
        ssrBasis === null
          ? `НМЦК выше расчёта по текущим ценам Минстроя на ${formatSurplus(ratioToEstimate ?? 1)}: есть запас на снижение.`
          : `НМЦК выше нашей оценки цены контракта на ${formatSurplus(ratioToEstimate ?? 1)}: есть запас на снижение.`,
    });
  }

  if (ssrBasis !== null && ssr !== null) {
    const reserveText = `${formatRub(ssrBasis.reserve)} (${String(ssrBasis.reservePercent).replace(".", ",")} % от итога глав)`;
    flags.push({
      code: "RESERVE_NOT_IN_COST",
      severity: "INFO",
      message:
        `В нашей оценке НМЦК заложен резерв на непредвиденные работы и затраты — ${reserveText}. Это деньги заказчика на риск, а не затраты подрядчика: в себестоимость они не входят. ` +
        `Подрядчик получает их, только если контракт позволяет оплатить непредвиденные работы (841/пр, приложение 4: резерв «если это предусмотрено контрактом»); без резерва цена контракта была бы ${formatRub(ssrBasis.nmcEstimateBeforeVat - ssrBasis.reserve * ssrBasis.inflationIndex)} без НДС.`,
    });
    if (ssrBasis.inflationApplied) {
      flags.push({
        code: "INFLATION_PASS_THROUGH",
        severity: "INFO",
        message: `Прогнозная инфляция (индекс ${ssrBasis.inflationIndex.toFixed(4).replace(".", ",")}) учтена и в цене контракта, и в себестоимости: работы исполняются в прогнозном уровне цен, поэтому она, как НДС, не прибавляет к марже.`,
      });
    }
  }

  if (isLowerBound) {
    flags.push({
      code: "INCOMPLETE_ESTIMATE",
      severity: droppedShare >= 0.2 ? "HIGH" : "MEDIUM",
      message:
        billItems > 0
          ? `Оценены не все работы: ${String(droppedPositions)} из ${String(billItems)} позиций не попали в расчёт. Итог — нижняя граница, настоящая стоимость выше.`
          : `Оценены не все работы: ${String(droppedPositions)} позиций не попали в расчёт. Итог — нижняя граница.`,
    });
  }

  if (input.assumedPercent >= 30) {
    flags.push({
      code: "ASSUMPTIONS_HIGH",
      severity: "MEDIUM",
      message: `${String(Math.round(input.assumedPercent))} % стоимости держится на допущениях (цены базы 2022 вместо текущих, резервные нормативы, цены заказчика вместо наших норм). Расчёт ориентировочный.`,
    });
  }

  if (
    nmc !== null &&
    minAcceptablePrice !== null &&
    minAcceptablePrice > nmc &&
    band !== "BELOW_COST"
  ) {
    flags.push({
      code: "MARGIN_UNREACHABLE",
      severity: "HIGH",
      message: `Даже без снижения маржа ниже вашего минимума ${String(minMargin)} %: нужна цена от ${formatRub(minAcceptablePrice)}, а НМЦК — ${formatRub(nmc)}.`,
    });
  }

  if (company.taxSystem === "PATENT") {
    flags.push({
      code: "TAX_REGIME_APPROXIMATE",
      severity: "MEDIUM",
      message:
        "Для патента налог на подрядные работы не рассчитывается: взята ставка УСН «доходы» 6 %. Уточните режим в профиле компании.",
    });
  }

  // Пометка — только когда экономика реально позволяет так снижаться. Таблица
  // всегда доходит до 70 % НМЦК, и по ней одной пометка висела бы на каждой закупке.
  if (
    isFz44 &&
    maxReductionPercent !== null &&
    maxReductionPercent >= ANTI_DUMPING_REDUCTION_PERCENT
  ) {
    flags.push({
      code: "ANTI_DUMPING_44",
      severity: "MEDIUM",
      message:
        "По 44-ФЗ (ст. 37) при снижении цены на 25 % и более от НМЦК обеспечение исполнения контракта увеличивается в 1,5 раза; при НМЦК до 15 млн ₽ вместо этого можно подтвердить добросовестность исполненными контрактами. Учитывайте это в цене и в деньгах на обеспечение; сверьте условия с актуальной редакцией закона.",
    });
  }

  if (nmc !== null) {
    flags.push(vatFlag(input, nmcIncludesVat, vatPercent));
  }

  // ---- Надёжность расчёта ----
  const reasons: string[] = [];
  let score = 100;
  if (droppedShare > 0) {
    const penalty = Math.round(Math.min(1, droppedShare) * 60);
    score -= penalty;
    reasons.push(
      `Не оценено ${String(droppedPositions)} поз. (−${String(penalty)})`,
    );
  }
  if (input.assumedPercent > 0) {
    const penalty = Math.round(Math.min(30, input.assumedPercent * 0.3));
    if (penalty > 0) {
      score -= penalty;
      reasons.push(`Допущения: ${String(Math.round(input.assumedPercent))} % стоимости (−${String(penalty)})`);
    }
  }
  if (input.unpricedResources > 0) {
    const penalty = Math.min(10, Math.ceil(input.unpricedResources / 5));
    score -= penalty;
    reasons.push(`Ресурсов без цены: ${String(input.unpricedResources)} (−${String(penalty)})`);
  }
  // Допущения сводного расчёта, которые двигают цену: срок работ (индекс), назначение объекта (размер резерва).
  for (const assumption of ssr?.assumptions ?? []) {
    if (!assumption.affectsPrice) continue;
    const penalty = assumption.code === "PURPOSE_DEFAULT" ? 2 : 3;
    score -= penalty;
    reasons.push(`${assumption.text} (−${String(penalty)})`);
  }
  score = Math.max(5, Math.min(100, score));
  if (reasons.length === 0) reasons.push("Все позиции оценены по текущим ценам");

  return {
    status: "COMPUTED",
    assumptions,
    taxKind: kind,
    minMarginPercent: minMargin,
    basis,
    ssr: ssrBasis,
    nmc,
    nmcBeforeVat: nmcBeforeVat === null ? null : money(nmcBeforeVat),
    ratioToEstimate,
    band,
    coverage,
    breakEvenPrice,
    minAcceptablePrice,
    maxReductionPercent,
    safetyMarginPercent,
    priceTable,
    stress,
    flags,
    confidence: { score, reasons },
  };
}

/**
 * Пометка об НДС. Её серьёзность зависит от того, откуда известно про НДС: цитата
 * из документации — справка, закон — справка с оговоркой, догадка — предупреждение,
 * потому что от неё сдвигаются все границы цены.
 */
function vatFlag(input: BidEconomicsInput, nmcIncludesVat: boolean, vatPercent: number): BidFlag {
  const basis = input.vatBasis;
  const asTaken = nmcIncludesVat ? `с НДС ${String(vatPercent)} %` : "без НДС";
  if (basis === undefined) {
    return {
      code: "VAT_ASSUMPTION",
      severity: "INFO",
      message: nmcIncludesVat
        ? `НМЦК принята с НДС ${String(vatPercent)} %. Если в извещении указано иное, границы сдвинутся.`
        : "НМЦК принята без НДС.",
    };
  }
  if (basis === "DOCUMENT") {
    const quote = input.vatQuote ?? null;
    return {
      code: "VAT_ASSUMPTION",
      severity: "INFO",
      message:
        quote === null || quote === ""
          ? `НМЦК принята ${asTaken} — так указано в документации.`
          : `НМЦК принята ${asTaken} — так указано в документации: «${quote}».`,
    };
  }
  if (input.vatConflict === true) {
    return {
      code: "VAT_ASSUMPTION",
      severity: "MEDIUM",
      message: `В документации встречаются оба варианта (с НДС и без): НМЦК принята ${asTaken}. Проверьте вручную — от этого зависят все границы цены.`,
    };
  }
  if (basis === "LAW_44") {
    return {
      code: "VAT_ASSUMPTION",
      severity: "INFO",
      message: `НМЦК принята ${asTaken}: по 44-ФЗ цена контракта включает налоги. В документации это прямо не указано — допущение.`,
    };
  }
  return {
    code: "VAT_ASSUMPTION",
    severity: "MEDIUM",
    message: `НДС в документации не определён: НМЦК принята ${asTaken}. Проверьте по извещению — от этого зависят все границы цены.`,
  };
}

/* ====================== Подписи для пользователя ====================== */

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

function formatRub(value: number): string {
  return `${RUB.format(Math.round(value))} ₽`;
}

function formatShare(part: number, whole: number): string {
  if (whole <= 0) return "0 %";
  return `${String(Math.round((part / whole) * 100))} %`;
}

/** На сколько процентов ниже расчёта; ratio — доля НМЦК от расчёта. */
function formatDeficit(ratio: number): string {
  return `${String(Math.round((1 - ratio) * 100))} %`;
}

function formatSurplus(ratio: number): string {
  return `${String(Math.round((ratio - 1) * 100))} %`;
}
