import type { TaxSystem } from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";
import type { SsrResult } from "@/domain/estimate/ssr";
import type { EstimateDocument } from "@/domain/estimate/types";
import type { VatBasis } from "@/domain/estimate/vatStatus";
import {
  ANTI_DUMPING_REDUCTION_PERCENT,
  antiDumpingNote,
  type AntiDumpingNote,
} from "@/domain/estimate/antiDumping";
import {
  DEFAULT_COST_PROFILE,
  isDefaultCostProfile,
  normalizeCostProfile,
  type CompanyCostProfile,
} from "@/domain/estimate/companyCostProfile";

export { ANTI_DUMPING_REDUCTION_PERCENT };

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
 * Профиль затрат компании (`companyCostProfile.ts`). Сметная себестоимость — это затраты «как по нормам»; у компании
 * есть скидки поставщиков, свой труд и техника, часть работ уходит субподряду. Поправки применяются к группам затрат
 * сметы (труд, машины, материалы, накладные), и только к ним: позиции по ценам заказчика и услуги группами не
 * разложены и остаются «прочими». Без профиля (или с нейтральным) себестоимость — ровно сметная, как раньше.
 *
 * Основа расчёта — не обязательно наша смета. Аудит сметы заказчика (`mode: "audit"`) даёт пересчёт его сметы по ценам зоны
 * (`BidCostBase`, `bidAuditBase.ts`): та же экономика считается по нему, а НМЦК — итог сметы заказчика. Если у отчёта аудита нет
 * разбивки по группам (сметы БИМ, отчёты, посчитанные раньше), вся сумма идёт в «прочие» и принимается за себестоимость целиком
 * (сметная прибыль не выделена) — оценка осторожная, она занижает допустимое снижение.
 *
 * «Моя цена» (`evaluateMyPrice`) — те же деньги для одной цены, названной человеком. Функция берёт готовый `BidEconomics` и
 * не пересчитывает основу: все допущения уже в нём.
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
  /** Профиль затрат компании, который лёг в расчёт (нейтральный, если не задан). */
  readonly costProfile: CompanyCostProfile;
  /** Профиль даёт поправки к сметной себестоимости (не нейтральный). */
  readonly costProfileApplied: boolean;
  /**
   * НМЦК объявлена с НДС. Так бывает у подавляющего большинства закупок, но
   * извещение часто молчит, поэтому по умолчанию это допущение, а не факт.
   */
  readonly nmcIncludesVat: boolean;
  /** Ставка НДС, %, — из документа сметы. */
  readonly vatPercent: number;
}

/** Статьи себестоимости, ₽. */
export interface BidCostStructure {
  readonly labour: number;
  readonly machines: number;
  readonly materials: number;
  /** Работы субподряда по цене субподрядчика. */
  readonly subcontract: number;
  readonly other: number;
  readonly overhead: number;
  readonly limited: number;
  readonly nonDeductibleVat: number;
}

/**
 * Основа расчёта по группам затрат, ₽ без НДС. Своя у сметы (`costBaseOfDocument`) и у пересчёта сметы заказчика
 * (`bidAuditBase.ts`): остальной код одинаков.
 */
export interface BidCostBase {
  readonly labour: number;
  readonly machines: number;
  readonly materials: number;
  /** Прямые затраты вне групп: позиции по ценам заказчика, услуги, «свои цены». Поправкам профиля не подлежат. */
  readonly other: number;
  readonly overhead: number;
  readonly profit: number;
  /** Зимнее удорожание и временные здания. */
  readonly limited: number;
  /** Итог без НДС, с которым сравнивается НМЦК. */
  readonly beforeVat: number;
  readonly vatPercent: number;
  /** Откуда основа: смета, пересчёт сметы заказчика с группами, пересчёт без групп (одной суммой). */
  readonly origin: "ESTIMATE" | "AUDIT" | "AUDIT_LUMP";
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Основа из сметного документа: группы — суммы по строкам, «прочие» — остаток прямых затрат. */
export function costBaseOfDocument(document: EstimateDocument): BidCostBase {
  let labour = 0;
  let machines = 0;
  let materials = 0;
  for (const section of document.sections) {
    for (const line of section.lines) {
      labour += numberOr0(line.labourCost);
      machines += numberOr0(line.machineCost);
      materials += numberOr0(line.materialCost);
    }
  }
  const { totals } = document;
  return {
    labour,
    machines,
    materials,
    other: Math.max(0, totals.directCost - labour - machines - materials),
    overhead: totals.overheadCost,
    profit: totals.profitCost,
    limited: totals.winterSurcharge + totals.temporaryStructures,
    beforeVat: totals.beforeVat,
    vatPercent: document.parameters.vatPercent,
    origin: "ESTIMATE",
  };
}

export interface BidEconomicsInput {
  /** Наш расчёт по нормам и текущим ценам Минстроя. Нет — основа задана `costBase` (аудит сметы заказчика). */
  readonly document?: EstimateDocument;
  /** Основа по группам затрат вместо документа: пересчёт сметы заказчика. */
  readonly costBase?: BidCostBase;
  /**
   * Профиль затрат компании: поправки к группам затрат. Нет — себестоимость сметная. Доля накладных из профиля
   * действует, если не задан `overheadRealization`.
   */
  readonly costProfile?: CompanyCostProfile | null;
  /**
   * Доля затрат, которую не удалось переоценить, %: у аудита это то, что остаётся по цене заказчика (нет нашей цены).
   * Снижает надёжность расчёта и добавляет пометку. Нет — пометки нет.
   */
  readonly unverifiedPercent?: number;
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
    /** Себестоимость исполнения: прямые затраты, накладные и лимитированные — с поправками профиля затрат. */
    readonly cost: number;
    /** Та же себестоимость без поправок профиля — «как по смете»: для сравнения со своей. */
    readonly costByEstimate: number;
    /** Из чего сложена себестоимость `cost`, ₽ (с индексом инфляции, если он применён): части складываются в неё. */
    readonly costStructure: BidCostStructure;
    /** То же «как по смете», без поправок профиля: складывается в `costByEstimate`. */
    readonly costStructureByEstimate: BidCostStructure;
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

  /** Закон закупки; null — не известен (антидемпинговое правило тогда условное). */
  readonly law: TenderLaw | null;
  /** Откуда основа расчёта (смета, пересчёт сметы заказчика). */
  readonly baseOrigin: BidCostBase["origin"];
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

/** Допуск «рядом с расчётом»: ±5 %. */
const NEAR_TOLERANCE = 0.05;

/** Себестоимость по группам: поправки профиля применены. Одна функция для расчёта и для сравнения «как по смете». */
function costOf(
  base: BidCostBase,
  profile: CompanyCostProfile,
  overheadRealization: number,
  context: { readonly vatPayer: boolean; readonly vatRate: number; readonly inflationIndex: number },
): BidCostStructure & { readonly total: number } {
  const own = 1 - profile.subcontractSharePercent / 100;
  const subPrice = profile.subcontractPricePercent / 100;
  const normativeDirect = base.labour + base.machines + base.materials;
  const materials = own * base.materials * (1 - profile.materialDiscountPercent / 100);
  const parts = {
    labour: own * base.labour * (profile.labourFactorPercent / 100),
    machines: own * base.machines * (profile.machinesFactorPercent / 100),
    materials,
    subcontract: (1 - own) * normativeDirect * subPrice,
    other: base.other,
    overhead: base.overhead * overheadRealization,
    limited: base.limited,
    // НДС в ценах материалов остаётся затратой тем, кто его не возмещает (не плательщик НДС).
    nonDeductibleVat: context.vatPayer ? 0 : materials * context.vatRate,
  };
  // Инфляция — сквозная статья (см. шапку): затраты исполняются в том же прогнозном уровне цен, что и цена.
  const index = context.inflationIndex;
  const scaled = {
    labour: parts.labour * index,
    machines: parts.machines * index,
    materials: parts.materials * index,
    subcontract: parts.subcontract * index,
    other: parts.other * index,
    overhead: parts.overhead * index,
    limited: parts.limited * index,
    nonDeductibleVat: parts.nonDeductibleVat * index,
  };
  return { ...scaled, total: Object.values(scaled).reduce((sum, value) => sum + value, 0) };
}

function roundedStructure(structure: BidCostStructure): BidCostStructure {
  return {
    labour: money(structure.labour),
    machines: money(structure.machines),
    materials: money(structure.materials),
    subcontract: money(structure.subcontract),
    other: money(structure.other),
    overhead: money(structure.overhead),
    limited: money(structure.limited),
    nonDeductibleVat: money(structure.nonDeductibleVat),
  };
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
  const { company } = input;
  const costBase: BidCostBase | null =
    input.costBase ?? (input.document === undefined ? null : costBaseOfDocument(input.document));
  const base: BidCostBase = costBase ?? {
    labour: 0,
    machines: 0,
    materials: 0,
    other: 0,
    overhead: 0,
    profit: 0,
    limited: 0,
    beforeVat: 0,
    vatPercent: 0,
    origin: "ESTIMATE",
  };
  const vatPercent = base.vatPercent;
  const nmcIncludesVat = input.nmcIncludesVat ?? true;
  const costProfile = normalizeCostProfile(input.costProfile ?? DEFAULT_COST_PROFILE);
  const costProfileApplied = !isDefaultCostProfile(costProfile);
  const overheadRealization = Math.min(
    1.5,
    Math.max(0, input.overheadRealization ?? costProfile.overheadRealizationPercent / 100),
  );
  const assumptions: BidEconomicsAssumptions = {
    overheadRealization,
    costProfile,
    costProfileApplied,
    nmcIncludesVat,
    vatPercent,
  };

  const kind = taxKind(company.taxSystem);
  const vatPayer = company.taxSystem === "OSNO";
  const vatRate = vatPercent / 100;

  const ssr = input.ssr !== undefined && input.ssr !== null && input.ssr.status === "COMPUTED" ? input.ssr : null;
  // Инфляция — сквозная статья, как НДС: затраты исполняются в том же прогнозном уровне цен, что и цена.
  const inflationIndex = ssr !== null && ssr.nmc.inflation.applied ? ssr.nmc.inflation.index : 1;

  // Резерв на непредвиденные в себестоимость не входит: это деньги заказчика на риск, а не затраты подрядчика.
  const context = { vatPayer, vatRate, inflationIndex };
  const structure = costOf(base, costProfile, overheadRealization, context);
  const cost = structure.total;
  // «Как по смете»: без поправок профиля, накладные — целиком (доля накладных — тоже поправка профиля, если её не задали явно).
  const byEstimate = costProfileApplied
    ? costOf(base, DEFAULT_COST_PROFILE, Math.min(1.5, Math.max(0, input.overheadRealization ?? 1)), context)
    : structure;
  const costByEstimate = byEstimate.total;
  const limitedCosts = base.limited;
  const nonDeductibleVat = structure.nonDeductibleVat / inflationIndex;
  // С чем сравнивается НМЦК: цена контракта по ССР (резерв, инфляция) или итог сметы.
  const comparedBeforeVat = ssr === null ? base.beforeVat : ssr.nmc.beforeVat;

  const basis = {
    directCost: money(base.labour + base.machines + base.materials + base.other),
    overhead: money(base.overhead),
    estimatedProfit: money(base.profit),
    limitedCosts: money(limitedCosts),
    materials: money(base.materials),
    estimateBeforeVat: money(base.beforeVat),
    cost: money(cost),
    costByEstimate: money(costByEstimate),
    costStructure: roundedStructure(structure),
    costStructureByEstimate: roundedStructure(byEstimate),
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
  if (cost <= 0 || base.beforeVat <= 0) {
    return {
      status: "EMPTY",
      assumptions,
      taxKind: kind,
      minMarginPercent: minMargin,
      basis,
      ssr: ssrBasis,
      law: input.law ?? null,
      baseOrigin: base.origin,
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
  const upper = Math.max(nmc ?? 0, comparedBeforeVat * (1 + vatRate), base.beforeVat * (1 + vatRate)) * 3;
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

  if (base.origin === "AUDIT") {
    flags.push({
      code: "BASE_CUSTOMER_AUDIT",
      severity: "INFO",
      message:
        "Основа расчёта — смета заказчика, пересчитанная по ценам зоны и квартала: его объёмы и расход ресурсов, наши цены и нормативы. НМЦК здесь — итог его сметы.",
    });
  } else if (base.origin === "AUDIT_LUMP") {
    flags.push({
      code: "COST_BASE_LUMP",
      severity: "MEDIUM",
      message:
        "У этой проверки нет разбивки пересчёта по труду, машинам и материалам (смета БИМ или проверка, посчитанная раньше): вся сумма без НДС принята за себестоимость, сметная прибыль не выделена. Оценка осторожная — допустимое снижение занижено; поправки профиля затрат не применены.",
    });
  }
  if (costProfileApplied && costByEstimate > 0 && base.origin !== "AUDIT_LUMP") {
    const delta = ((cost - costByEstimate) / costByEstimate) * 100;
    flags.push({
      code: "COST_PROFILE_APPLIED",
      severity: "INFO",
      message: `Себестоимость посчитана с поправками вашего профиля затрат: ${formatRub(cost)} против ${formatRub(costByEstimate)} «как по смете» (${delta < 0 ? "−" : "+"}${Math.abs(delta).toFixed(1).replace(".", ",")} %). Проверьте, что скидки и ставки в профиле актуальны для этого объекта.`,
    });
  }
  if ((input.unverifiedPercent ?? 0) >= 30) {
    flags.push({
      code: "UNVERIFIED_SHARE",
      severity: "MEDIUM",
      message: `${String(Math.round(input.unverifiedPercent ?? 0))} % затрат не удалось переоценить нашими ценами — они взяты как у заказчика. Расчёт ориентировочный.`,
    });
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
  if ((input.unverifiedPercent ?? 0) > 0) {
    const penalty = Math.round(Math.min(40, (input.unverifiedPercent ?? 0) * 0.4));
    if (penalty > 0) {
      score -= penalty;
      reasons.push(`Не переоценено нашими ценами: ${String(Math.round(input.unverifiedPercent ?? 0))} % затрат (−${String(penalty)})`);
    }
  }
  if (base.origin === "AUDIT_LUMP") {
    score -= 10;
    reasons.push("Нет разбивки затрат по группам (−10)");
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
    law: input.law ?? null,
    baseOrigin: base.origin,
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

/* ====================== «Моя цена» ====================== */

/** Деньги и вывод для одной цены, которую назвал человек. */
export interface MyPriceResult extends PriceOutcome {
  /** Цена, % от НМЦК; null — НМЦК не известна. */
  readonly percentOfNmc: number | null;
  /** Снижение от НМЦК, %; отрицательное — цена выше НМЦК; null — НМЦК не известна. */
  readonly reductionPercent: number | null;
  readonly verdict: PriceVerdict;
  /** На сколько процентов могут вырасти затраты до нулевой прибыли (как в таблице цен). */
  readonly safetyMarginPercent: number;
  /** Антидемпинговая мера при этом снижении; null — меры нет (снижение меньше 25 %, 223-ФЗ). */
  readonly antiDumping: AntiDumpingNote | null;
  /** Цена выше НМЦК: по 44-ФЗ такая заявка отклоняется. */
  readonly aboveNmc: boolean;
}

/** Модель затрат и налогов из готового расчёта: все допущения уже в нём. */
function modelOf(economics: BidEconomics): CostModel {
  return {
    vatRate: economics.assumptions.vatPercent / 100,
    vatPayer: economics.taxKind === "OSNO",
    nmcIncludesVat: economics.assumptions.nmcIncludesVat,
    kind: economics.taxKind,
    cost: economics.basis.cost,
  };
}

/**
 * Что останется компании при названной цене. Цена — в тех же терминах, что НМЦК (с НДС, если НМЦК с НДС): либо ₽,
 * либо снижение от НМЦК в процентах (нужна НМЦК). null — расчёта нет, цена не названа или не положительна.
 */
export function evaluateMyPrice(
  economics: BidEconomics,
  input: { readonly price?: number | null; readonly reductionPercent?: number | null },
): MyPriceResult | null {
  if (economics.status !== "COMPUTED") return null;
  const nmc = economics.nmc;
  let price: number | null = null;
  if (typeof input.price === "number" && Number.isFinite(input.price) && input.price > 0) {
    price = input.price;
  } else if (
    nmc !== null &&
    typeof input.reductionPercent === "number" &&
    Number.isFinite(input.reductionPercent) &&
    input.reductionPercent < 100
  ) {
    price = (nmc * (100 - input.reductionPercent)) / 100;
  }
  if (price === null || price <= 0) return null;

  const model = modelOf(economics);
  const outcome = outcomeAt(model, price, 0);
  const reduction = nmc === null ? null : (1 - price / nmc) * 100;
  const verdict: PriceVerdict =
    outcome.profit < 0 ? "LOSS" : outcome.marginPercent < economics.minMarginPercent ? "BELOW_TARGET_MARGIN" : "OK";
  return {
    ...outcome,
    percentOfNmc: nmc === null ? null : pct((price / nmc) * 100),
    reductionPercent: reduction === null ? null : pct(reduction),
    verdict,
    safetyMarginPercent: solveSafetyMargin(model, price),
    antiDumping: antiDumpingNote({ law: economics.law, nmc, reductionPercent: reduction }),
    aboveNmc: nmc !== null && price > nmc + 0.005,
  };
}

/** Быстрые кнопки «Моей цены» и шаги таблицы Excel: снижение от НМЦК, %. */
export const QUICK_REDUCTION_PERCENT: readonly number[] = [5, 10, 15, 20, 25];
export const LADDER_REDUCTION_PERCENT: readonly number[] = [0, 5, 10, 15, 20, 25, 30];

export interface PriceLadderRow {
  readonly reductionPercent: number;
  readonly result: MyPriceResult;
}

/** Цены от НМЦК до −30 % с шагом 5: каждая со своими деньгами и выводом. Нет НМЦК — пусто. */
export function buildPriceLadder(economics: BidEconomics, steps: readonly number[] = LADDER_REDUCTION_PERCENT): PriceLadderRow[] {
  if (economics.status !== "COMPUTED" || economics.nmc === null) return [];
  const rows: PriceLadderRow[] = [];
  for (const reductionPercent of steps) {
    const result = evaluateMyPrice(economics, { reductionPercent });
    if (result !== null) rows.push({ reductionPercent, result });
  }
  return rows;
}

/** Заголовок блока: три числа одной строкой. Нет расчёта — null. */
export function bidHeadline(economics: BidEconomics): {
  readonly breakEven: string;
  readonly minPrice: string;
  readonly reduction: string | null;
  readonly text: string;
} | null {
  if (economics.status !== "COMPUTED" || economics.breakEvenPrice === null || economics.minAcceptablePrice === null) return null;
  const margin = String(economics.minMarginPercent).replace(".", ",");
  const breakEven = `Безубыточная цена ${formatRub(economics.breakEvenPrice)}`;
  const minPrice = `Минимальная цена с маржой ${margin} % — ${formatRub(economics.minAcceptablePrice)}`;
  const reduction =
    economics.maxReductionPercent === null
      ? null
      : economics.maxReductionPercent <= 0
        ? "Снижать от НМЦК нельзя"
        : `Можно снижать до ${economics.maxReductionPercent.toFixed(1).replace(".", ",")} % от НМЦК`;
  return { breakEven, minPrice, reduction, text: [breakEven, minPrice, reduction].filter((part) => part !== null).join(" · ") };
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
