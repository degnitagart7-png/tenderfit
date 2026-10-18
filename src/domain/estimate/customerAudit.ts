import { priceByServiceCode, type ZoneAutoServices } from "@/domain/estimate/autoServices";
import type { EstimatePriceBook } from "@/domain/estimate/calculate";
import { parseUnit } from "@/domain/estimate/billExtraction";
import { bookOf, resourceCodeOf, type CustomerLsr, type CustomerPosition, type CustomerResource } from "@/domain/estimate/customerLsr";
import type { NorthZone } from "@/domain/estimate/overheadNormatives";
import { quarterIn, zoneNumberIn } from "@/domain/estimate/priceLevel";
import { classifyResourceCode } from "@/domain/estimate/resourceKinds";
import { resolveWage } from "@/domain/estimate/wageScale";
import { evaluateCustomerConditions, hasConfirmedConditions } from "@/domain/estimate/customerCoefficients";
import { checkCustomerCoefficients, checkCustomerLimitedCosts } from "@/domain/estimate/customerNormatives";
import type { BimAuditDetails } from "@/domain/estimate/bimAuditTypes";

/**
 * Аудит локальной сметы заказчика: где он ошибся и на сколько это двигает НМЦК.
 *
 * Принцип. Объёмы и расход ресурсов заказчика НЕ трогаем: его же количества
 * переоцениваются нашими ценами. Тогда разница — ровно цены, индексы, нормативы
 * и арифметика, а не выбор расценки (с ним спорить нечем, и это не ошибка
 * заказчика, а предмет сметчика). Ни модели, ни сети: сравнение — арифметика
 * над разобранной сметой (`customerLsr.ts`) и ценовой книгой зоны.
 *
 * Как складывается разница. Для каждой позиции цепочка идёт от того, что напечатал
 * заказчик, к тому, что вышло у нас, шагами, суммы которых сходятся с разницей до
 * копейки:
 *  1. арифметика — итог позиции из его же цифр (Σ ресурсов, ФОТ × %, прямые + НР +
 *     СП) против напечатанного «Всего по позиции»;
 *  2. цены ресурсов — (наша цена − его цена) × его количество, по группам: труд,
 *     машины, материалы; труд тянет за собой НР и СП по его процентам;
 *  3. нормативы — (наш % − его %) × ФОТ после пересчёта труда.
 * Отдельно, на смете: НДС (ставка заказчика против нашей). Всё, что не удалось
 * переоценить (нет нашей цены, цена заказчика по КП, другая единица), называется и
 * считается в долю непроверенного, а не прячется в ноль: вывод без покрытия — это
 * догадка, и при покрытии ниже 70 % он идёт с оговоркой.
 *
 * Про НДС. Позиции и находки — как в смете, без НДС. Итог, его разница и группы
 * «откуда разница» приведены к итогу сметы: если итог заказчика с НДС, они тоже с
 * НДС (по нашей ставке), чтобы части складывались в целое.
 *
 * Модуль чистый: деньги внутри не округляются.
 */

export interface AuditContext {
  /** Цены зоны: текущие цены ресурсов, тарифная шкала (со специалистами), нормативы НР/СП. */
  readonly priceBook: EstimatePriceBook;
  /**
   * Все цены сплит-формы зоны (`loadZoneAuditPrices`): в основной книге остались только
   * ресурсы из норм, а кабель отдельной позицией в нормах не участвует. Цена ищется сначала в
   * книге, затем здесь. Нет (старая сборка зоны) — аудит работает только по книге.
   */
  readonly auditPrices?: ReadonlyMap<string, { readonly price: number; readonly unit: string; readonly indexed: boolean }> | null;
  /**
   * Сметные цены перевозки и погрузочно-разгрузочных работ зоны (ФГИС ЦС, `loadZoneAutoServices`).
   * Строки сметы заказчика с шифром услуги («02-15-1-01-0047», «49-1») сверяются с ними, а не
   * считаются «ценой заказчика, не с чем сравнить». Нет (старая сборка зоны) — как раньше.
   */
  readonly services?: ZoneAutoServices | null;
  /** Наша ставка НДС, %. По умолчанию 22 (с 01.01.2026). */
  readonly vatPercent?: number;
  /** Зона Севера, по которой собрана карта нормативов в `priceBook.overheadRates`. */
  readonly northZone?: NorthZone;
  /** Субъект РФ сметы (по ценовой зоне аудита): для сверки зимнего удорожания по температурной зоне. */
  readonly subject?: string | null;
}

export const DEFAULT_VAT_PERCENT = 22;
/** Покрытие, ниже которого вывод идёт с оговоркой. */
export const MIN_RELIABLE_COVERAGE = 0.7;
/** Расхождение процента НР/СП, с которого оно считается находкой, п.п. */
export const RATE_TOLERANCE = 0.5;
/** Разница цен ресурса, с которой строка считается отличающейся (доля). */
const PRICE_NOISE = 0.005;

export type AuditFindingType =
  | "RESOURCE_PRICE"
  | "OUR_PRICE_MISSING"
  | "CUSTOMER_PRICE_NO_COMPARE"
  | "UNIT_MISMATCH"
  | "ARITHMETIC"
  | "OVERHEAD_RATE"
  | "PROFIT_RATE"
  | "RATE_NOT_CHECKED"
  | "COEFFICIENTS"
  /** Зимнее удорожание и временные здания заказчика против приказов 325/пр и 332/пр. */
  | "LIMITED_COSTS"
  | "OUTDATED_PRICE_LEVEL"
  | "VAT_RATE"
  | "ZONE_MISMATCH"
  | "SECTIONS_SUM"
  | "BASE_PRICE"
  /** БИМ: индекс заказчика отличается от письма Минстроя для его субъекта, объекта и квартала. */
  | "INDEX_VALUE"
  /** БИМ: смета в ценах одного квартала, а индексы взяты из письма другого. */
  | "INDEX_QUARTER"
  /** БИМ: индексы не сверены (нет письма квартала, объект не определён) — справка без вывода. */
  | "INDEX_NOT_CHECKED"
  /** БИМ: базисная цена расценки отличается от ФЕР-2020 (или совпала — итоговая справка). */
  | "FER_PRICE"
  /** БИМ: базисные цены не проверены (ТЕР без открытой базы, корпоративные расценки, расценки нет в ФЕР-2020) или НР/СП не проверены. */
  | "BASE_NOT_CHECKED";

export type AuditSeverity = "WARNING" | "INFO";

export type ImpactGroup = "LABOUR" | "MACHINES" | "MATERIALS" | "OVERHEAD" | "PROFIT" | "ARITHMETIC" | "VAT";

export interface AuditFinding {
  readonly type: AuditFindingType;
  readonly severity: AuditSeverity;
  /** Номер позиции; null — находка по всей смете. */
  readonly positionNumber: number | null;
  readonly message: string;
  /** Влияние на итог, ₽ (в тех же терминах, что итог сметы); null — без суммы. */
  readonly impact: number | null;
  /** Для арифметики — сумма расхождения, ₽. */
  readonly discrepancy?: number;
  /** Код ресурса или указатель норматива — по ним группируется список находок. */
  readonly subject?: string;
  readonly customerValue?: number;
  readonly ourValue?: number;
  readonly quantity?: number;
  /** Откуда наша цена ресурса: измеренная цена зоны или цена по индексу сплит-формы. */
  readonly ourSource?: OurPriceSource;
}

export type OurPriceSource = "CURRENT_ZONE" | "INDEXED" | "SERVICE";

export const OUR_PRICE_SOURCE_LABEL: Readonly<Record<OurPriceSource, string>> = {
  CURRENT_ZONE: "текущая цена зоны",
  INDEXED: "по индексу сплит-формы",
  SERVICE: "сметная цена услуги ФГИС ЦС",
};

export interface AuditPosition {
  readonly number: number;
  readonly code: string;
  readonly name: string;
  readonly section: string | null;
  /** Итог позиции у заказчика («Всего по позиции»). */
  readonly customerTotal: number;
  /** Итог по его объёмам и нашим ценам и нормативам. */
  readonly ourTotal: number;
  readonly diff: number;
  readonly flags: readonly AuditFindingType[];
  /** Доля прямых затрат позиции, которую удалось переоценить. */
  readonly checkedShare: number;
}

export interface ImpactSummary {
  /** Сумма влияния, ₽ (со знаком: плюс — у нас дороже). */
  readonly amount: number;
  /** Сколько строк (ресурсов, позиций, находок) дало влияние. */
  readonly count: number;
  /** Для арифметики: сумма расхождений по модулю. */
  readonly discrepancy?: number;
}

export interface UncheckedItem {
  readonly kind:
    | "OUR_PRICE_MISSING"
    | "CUSTOMER_PRICE"
    | "UNIT_MISMATCH"
    | "NO_RESOURCES"
    /** БИМ: ТЕР региона — открытой базы нет. */
    | "TER_NO_BASE"
    /** БИМ: расценка не из ФЕР и не из ТЕР (корпоративная КОЕР, КССЦ). */
    | "OTHER_BASE"
    /** БИМ: шифра нет в ФЕР-2020. */
    | "RATE_NOT_FOUND"
    /** БИМ: поправочные коэффициенты позиции не разобраны. */
    | "COEFFICIENTS_UNPARSED";
  readonly code: string;
  readonly name: string;
  readonly positions: number;
  /** Стоимость у заказчика, которая осталась без проверки, ₽. */
  readonly amount: number;
}

export type AuditVerdict = "UNDERSTATED" | "OVERSTATED" | "MATCH";

export interface AuditReport {
  readonly documentName: string;
  readonly estimateName: string | null;
  /** «ВСЕГО по смете» заказчика; без итога в тексте — сумма позиций (`totalMissing`). */
  readonly customerTotal: number;
  readonly totalMissing: boolean;
  /** Его объёмы × наши цены + наши НР/СП + НДС по нашей ставке. */
  readonly repricedTotal: number;
  readonly diff: number;
  /** Разница от итога заказчика, %; null — итог нулевой. */
  readonly diffPercent: number | null;
  readonly vat: {
    /** Итог заказчика с НДС, и разница показана с НДС. */
    readonly included: boolean;
    readonly customerPercent: number | null;
    readonly inferred: boolean;
    readonly ourPercent: number;
  };
  readonly impacts: Readonly<Record<ImpactGroup, ImpactSummary>>;
  /** Доля прямых затрат заказчика, которую удалось переоценить. */
  readonly coverage: number;
  readonly checkedDirect: number;
  readonly totalDirect: number;
  readonly positions: readonly AuditPosition[];
  /** 10 позиций с наибольшей разницей по модулю. */
  readonly top: readonly AuditPosition[];
  readonly findings: readonly AuditFinding[];
  readonly unchecked: readonly UncheckedItem[];
  readonly verdict: AuditVerdict;
  /** «НМЦК занижена на X ₽ (Y %)» — с оговоркой о покрытии, если оно мало. */
  readonly conclusion: string;
  readonly zone: string;
  readonly period: string;
  readonly priceQuarter: { readonly quarter: number; readonly year: number } | null;
  /** Метод сметы заказчика. Нет поля — ресурсно-индексный (форма 421/пр), как у отчётов, собранных до БИМ. */
  readonly method?: "RESOURCE_INDEX" | "BASE_INDEX";
  /** Сведения аудита БИМ-сметы: чем проверены базисные цены и индексы. */
  readonly bim?: BimAuditDetails;
}

/* ------------------------------ Помощники ------------------------------ */

const rubFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
export const rub = (value: number): string => `${rubFormat.format(Math.round(Math.abs(value)))} ₽`;

/** Допуск сверки: 0,1 % значения, но не меньше 0,02 ₽ (округления строки) плюс запас на число слагаемых. */
export function tolerance(value: number, terms = 1): number {
  return Math.max(0.02, Math.abs(value) * 0.001) + 0.005 * terms;
}

/** Единицы совпадают: «100 шт» и «100 шт.», «м3» и «м³». */
export function sameUnit(left: string, right: string): boolean {
  const a = parseUnit(left);
  const b = parseUnit(right);
  if (a !== null && b !== null) return a.unit === b.unit && a.multiplier === b.multiplier;
  const flat = (text: string): string => text.toLowerCase().replace(/[\s.]/g, "").replace(/³/g, "3").replace(/²/g, "2");
  return flat(left) === flat(right);
}

/** Указатель без хвоста-уточнения: «Пр/812-090.0-1» → «Пр/812-090.0». */
function refBase(ref: string): { base: string; suffixed: boolean } {
  const match = /^(Пр\/(?:812|774)-\d+\.\d+)(-\d+)?$/.exec(ref);
  if (match === null) return { base: ref, suffixed: false };
  return { base: match[1] as string, suffixed: match[2] !== undefined };
}

function sourceOf(price: { readonly source: string }): OurPriceSource {
  return price.source === "BASE_2022_INDEXED" ? "INDEXED" : "CURRENT_ZONE";
}

function fromAuditPrices(code: string, ctx: AuditContext): OurPrice | null {
  const found = ctx.auditPrices?.get(code);
  if (found === undefined) return null;
  return { price: found.price, unit: found.unit === "" ? null : found.unit, approximate: false, source: found.indexed ? "INDEXED" : "CURRENT_ZONE" };
}

interface OurPrice {
  readonly price: number;
  /** Единица справочника, если она известна: для сверки с единицей заказчика. */
  readonly unit: string | null;
  readonly approximate: boolean;
  /** Источник цены; у труда не заполняется: ставка зоны из реестра. */
  readonly source?: OurPriceSource;
}

/**
 * Наша цена ресурса за единицу. Труд — по шкале зоны (рабочие, специалисты);
 * часы машинистов «4-100-*» — по официальной ставке среднего разряда; машины и
 * материалы — текущая цена зоны.
 *
 * Цена машины — «сметная цена» ФГИС ЦС как она опубликована: БЕЗ оплаты труда машинистов
 * (та вынесена в отдельную колонку и в смете по форме 421/пр идёт строками «ОТм» 4-100-*).
 * Значит, цену зоны можно сравнивать с графой «цена» строки машины заказчика как есть — и с
 * строками машинистов в позиции, и без них. Полную стоимость маш.-ч (с оплатой звена) считает
 * только расчёт сметы (`resolvePrice`), аудиту она не нужна.
 */
function ourPrice(resource: CustomerResource, ctx: AuditContext): OurPrice | null {
  const { priceBook } = ctx;
  const kind = classifyResourceCode(resource.code);

  // Перевозка и погрузка: шифр услуги, цена за тонну — из таблиц зоны. Нет цены (километры за
  // пределом таблицы, нет таблицы) — null, и строка остаётся непроверенной, как раньше.
  if (kind === "UNKNOWN" && ctx.services !== undefined && ctx.services !== null) {
    const service = priceByServiceCode(ctx.services, resource.code);
    if (service.ok) return { price: service.price.price, unit: "т", approximate: false, source: "SERVICE" };
  }

  if (kind === "LABOUR") {
    const wage = resolveWage(priceBook.wageScale, resource.code);
    return wage === null ? null : { price: wage.salary, unit: "чел.-ч", approximate: wage.origin === "EXTRAPOLATED" };
  }
  if (kind === "MACHINIST_HOURS") {
    const rank = /^4-100-(\d{2,3})$/.exec(resource.code)?.[1];
    if (rank !== undefined) {
      const value = Number.parseInt(rank, 10) / 10;
      const official = priceBook.wageScale.machinists?.find((anchor) => Math.abs(anchor.rank - value) < 1e-6);
      if (official !== undefined) return { price: official.salary, unit: "чел.-ч", approximate: false };
    }
    const wage = resolveWage(priceBook.wageScale, resource.code);
    return wage === null ? null : { price: wage.salary, unit: "чел.-ч", approximate: wage.origin === "EXTRAPOLATED" };
  }
  if (kind === "MACHINE") {
    const current = priceBook.current.get(resource.code);
    if (current !== undefined) {
      return { price: current.price, unit: current.unit, approximate: false, source: sourceOf(current) };
    }
    return fromAuditPrices(resource.code, ctx);
  }
  if (kind === "MATERIAL") {
    const current = priceBook.current.get(resource.code);
    if (current !== undefined) return { price: current.price, unit: current.unit, approximate: false, source: sourceOf(current) };
    return fromAuditPrices(resource.code, ctx);
  }
  return null;
}

type DirectGroup = "LABOUR" | "MACHINES" | "MATERIALS";

function groupOf(code: string): DirectGroup {
  const kind = classifyResourceCode(code);
  if (kind === "LABOUR" || kind === "MACHINIST_HOURS") return "LABOUR";
  if (kind === "MACHINE") return "MACHINES";
  return "MATERIALS";
}

/* ------------------------------ Аудит позиции ------------------------------ */

interface PositionOutcome {
  readonly position: AuditPosition;
  readonly findings: AuditFinding[];
  /** Влияния позиции по группам, ₽ без НДС. */
  readonly impacts: Record<ImpactGroup, { amount: number; rows: number }>;
  readonly checkedDirect: number;
  readonly totalDirect: number;
  readonly unchecked: UncheckedItem[];
  /** Базис заказчика против базиса ФСБЦ-2022: сколько сверено и сколько совпало. */
  readonly baseCompared: number;
  readonly baseMatched: number;
}

export function emptyImpacts(): Record<ImpactGroup, { amount: number; rows: number }> {
  return {
    LABOUR: { amount: 0, rows: 0 },
    MACHINES: { amount: 0, rows: 0 },
    MATERIALS: { amount: 0, rows: 0 },
    OVERHEAD: { amount: 0, rows: 0 },
    PROFIT: { amount: 0, rows: 0 },
    ARITHMETIC: { amount: 0, rows: 0 },
    VAT: { amount: 0, rows: 0 },
  };
}

function label(position: CustomerPosition): string {
  return `поз. ${String(position.number)} ${position.code === "" ? position.name.slice(0, 40) : position.code}`;
}

/**
 * Позиция-поставка: сама позиция — материал или оборудование («ФСБЦ-21.1.07.05-0116 Кабель…»,
 * голый код «04.3.02.13-0022», «ТЦ_…» по предложению заказчика), и ресурсных строк под ней нет:
 * цена, базис и индекс стоят в строке позиции. Для проверки она — один ресурс: код без «ФСБЦ-»,
 * количество — объём позиции, цена — графа 10. Так деньги, которые в электромонтажных сметах
 * самые большие (кабель), не выпадают из проверки. НР и СП у такой позиции обычно нет — и не
 * выдумываются.
 *
 * ТЦ_… считается ценой заказчика; сравнивается, только когда внутри есть полный код ФСБЦ
 * («ТЦ_06.2.01.02-0012_…»): группа «06.2.01.02» без номера — не код ресурса.
 */
function supplyResources(position: CustomerPosition): CustomerResource[] {
  // Расценка ГЭСН и позиции чужих баз (ФЕР, ТЕР, ТСН) без ресурсов — не поставки: их состав нам неизвестен.
  // Остальное с ценой в строке — материал, оборудование или цена по КП («1-75/20.02.2026», «Кабель АПвПу…»).
  if (position.book.startsWith("GESN") || position.book === "OTHER_BASE") return [];
  const total = position.ownTotal ?? position.total;
  if (total === null && position.ownUnitPrice === null) return [];
  const raw = position.code === "" ? position.name.slice(0, 60) : position.code;
  const { code, customerPrice } = position.code === "" ? { code: raw, customerPrice: true } : resourceCodeOf(position.code);
  return [
    {
      code,
      rawCode: raw,
      customerPrice,
      name: position.name,
      unit: position.unit,
      qtyPerUnit: null,
      qtyTotal: position.quantity,
      baseUnitPrice: position.ownBasePrice,
      index: position.ownIndex,
      currentUnitPrice: position.ownUnitPrice,
      priceCoefficient: position.ownPriceCoefficient,
      currentTotal: total,
      unaccounted: false,
      extra: false,
    },
  ];
}

/** Во сколько раз цена за «1000 м» больше цены за «м»: множители единиц у заказчика и у нас. */
function unitScale(customerUnit: string, ourUnit: string | null): number | null {
  if (ourUnit === null || customerUnit === "") return 1;
  const a = parseUnit(customerUnit);
  const b = parseUnit(ourUnit);
  if (a === null || b === null || a.unit !== b.unit) return sameUnit(customerUnit, ourUnit) ? 1 : null;
  return a.multiplier / b.multiplier;
}

function auditPosition(position: CustomerPosition, ctx: AuditContext): PositionOutcome {
  const findings: AuditFinding[] = [];
  const impacts = emptyImpacts();
  const unchecked: UncheckedItem[] = [];
  const resources = position.resources.length > 0 ? position.resources : supplyResources(position);
  const priced = resources.filter((resource) => !resource.unaccounted);
  const add = (finding: Omit<AuditFinding, "positionNumber" | "impact"> & { impact?: number | null }): void => {
    findings.push({ ...finding, positionNumber: position.number, impact: finding.impact ?? null });
  };

  if (position.hasCoefficients) {
    add({
      type: "COEFFICIENTS",
      severity: "INFO",
      message:
        `${label(position)}: к затратам применены коэффициенты: ${position.coefficients ?? ""}` +
        (() => {
          const check = checkCustomerCoefficients(position.coefficients ?? "", bookOf(position.code));
          return check === "" ? "" : `. ${check}`;
        })(),
    });
  }

  /*
    Коэффициенты и множители заказчика по пояснениям под позицией и по графе 6 строк НР и СП: подтверждённые приложением 10
    к 421/пр, п. 58, 812/пр п. 25 и 774/пр п. 16 называются справкой, остальные — находкой с суммой, на которую они меняют
    его прямые затраты или начисления. Расчёт применяет подтверждённые (`customerCoefficients.ts`); сумма в итог аудита не входит.
  */
  const customerConditions = evaluateCustomerConditions(position);
  if (customerConditions !== null) {
    if (hasConfirmedConditions(customerConditions)) {
      add({
        type: "COEFFICIENTS",
        severity: "INFO",
        message: `${label(position)}: коэффициенты заказчика подтверждены — ${customerConditions.label.replace(/^как у заказчика: /u, "")}`,
      });
    }
    for (const claim of customerConditions.rejected) {
      const amount = claim.amount === null ? "" : `; у заказчика это ${claim.amount < 0 ? "уменьшает" : "увеличивает"} затраты позиции на ${String(Math.round(Math.abs(claim.amount)))} ₽`;
      add({
        type: "COEFFICIENTS",
        severity: "WARNING",
        message: `${label(position)}: коэффициент заказчика не подтверждается приложением 10 и приказами 812/пр, 774/пр — ${claim.text}: ${claim.reason.split(". По приложению")[0] as string}${amount}`,
        impact: claim.amount,
      });
    }
  }

  const rowsTotal = priced.reduce((sum, resource) => sum + (resource.currentTotal ?? 0), 0);
  const wageRowsTotal = priced
    .filter((resource) => groupOf(resource.code) === "LABOUR")
    .reduce((sum, resource) => sum + (resource.currentTotal ?? 0), 0);
  const customerTotal = position.total ?? position.ownTotal ?? 0;

  // Позиция без ресурсов (цена заказчика прямо в строке): переоценить нечем.
  if (priced.length === 0) {
    const amount = customerTotal;
    unchecked.push({
      kind: "NO_RESOURCES",
      code: position.code,
      name: position.name,
      positions: 1,
      amount,
    });
    return {
      position: {
        number: position.number,
        code: position.code,
        name: position.name,
        section: position.section,
        customerTotal,
        ourTotal: customerTotal,
        diff: 0,
        flags: findings.map((finding) => finding.type),
        checkedShare: 0,
      },
      findings,
      impacts,
      checkedDirect: 0,
      totalDirect: amount,
      unchecked,
      baseCompared: 0,
      baseMatched: 0,
    };
  }

  /* ---- Арифметика позиции (шаги 1) ---- */
  let arithmeticEffect = 0;
  const flagArithmetic = (text: string, discrepancy: number): void => {
    add({ type: "ARITHMETIC", severity: "WARNING", message: `${label(position)}: ${text}`, impact: null, discrepancy });
    impacts.ARITHMETIC.rows += 1;
  };

  for (const resource of priced) {
    const { qtyTotal, currentUnitPrice, currentTotal } = resource;
    // У процентной добавки «количество» — процент, а «цена» — база: произведение не стоимость.
    if (resource.unit === "%") continue;
    if (qtyTotal !== null && currentUnitPrice !== null && currentTotal !== null && qtyTotal > 0) {
      const expected = qtyTotal * currentUnitPrice * (resource.priceCoefficient !== null && resource.priceCoefficient > 0 ? resource.priceCoefficient : 1);
      const slack = tolerance(expected) + 0.005 * qtyTotal;
      if (Math.abs(expected - currentTotal) > slack) {
        flagArithmetic(
          `${resource.code}: ${String(qtyTotal)} × ${String(currentUnitPrice)} = ${expected.toFixed(2)} ₽, а в смете ${currentTotal.toFixed(2)} ₽`,
          Math.abs(expected - currentTotal),
        );
      }
    }
    if (resource.baseUnitPrice !== null && resource.index !== null && currentUnitPrice !== null && resource.baseUnitPrice > 0) {
      const expected = resource.baseUnitPrice * resource.index;
      // Индекс в смете округлён до сотых, поэтому допуск — до 0,5 % цены.
      if (Math.abs(expected - currentUnitPrice) > Math.max(0.02, Math.abs(expected) * 0.005)) {
        flagArithmetic(
          `${resource.code}: базис ${String(resource.baseUnitPrice)} × индекс ${String(resource.index)} = ${expected.toFixed(2)} ₽, а цена в смете ${String(currentUnitPrice)} ₽`,
          Math.abs(expected - currentUnitPrice),
        );
      }
    }
  }

  // «Итого прямые затраты» не включает строки-дополнения («22.1»): их сумма идёт в «Всего по позиции» отдельно.
  const directRows = priced.filter((resource) => !resource.extra).reduce((sum, resource) => sum + (resource.currentTotal ?? 0), 0);
  if (position.directTotal !== null && Math.abs(directRows - position.directTotal) > tolerance(position.directTotal, priced.length)) {
    flagArithmetic(
      `сумма ресурсов ${directRows.toFixed(2)} ₽ не равна «Итого прямые затраты» ${position.directTotal.toFixed(2)} ₽`,
      Math.abs(directRows - position.directTotal),
    );
  }

  // База начислений — напечатанный ФОТ (нет — сумма строк труда): проверяем, как заказчик
  // применил свои проценты к своей базе, а не угадываем, что входит в ФОТ у его программы.
  const wageFund = position.wageFund ?? wageRowsTotal;
  const rateAmount = (rate: CustomerPosition["overhead"], name: string): number => {
    if (rate === null || rate.percent === null) return rate?.amount ?? 0;
    const expected = (wageFund * rate.percent) / 100;
    if (rate.amount !== null && Math.abs(expected - rate.amount) > tolerance(expected)) {
      flagArithmetic(
        `${name}: ФОТ ${wageFund.toFixed(2)} × ${String(rate.percent)} % = ${expected.toFixed(2)} ₽, а в смете ${rate.amount.toFixed(2)} ₽`,
        Math.abs(expected - rate.amount),
      );
    }
    return expected;
  };
  const overheadRecomputed = rateAmount(position.overhead, "НР");
  const profitRecomputed = rateAmount(position.profit, "СП");

  const stated = position.total;
  const extrasTotal = rowsTotal - directRows;
  const statedComponents =
    (position.directTotal ?? directRows) + extrasTotal + (position.overhead?.amount ?? 0) + (position.profit?.amount ?? 0);
  if (stated !== null && Math.abs(statedComponents - stated) > tolerance(stated, 3)) {
    flagArithmetic(
      `прямые затраты + НР + СП = ${statedComponents.toFixed(2)} ₽, а «Всего по позиции» ${stated.toFixed(2)} ₽`,
      Math.abs(statedComponents - stated),
    );
  }
  // Итог позиции из его же цифр против напечатанного — шаг «арифметика».
  const recomputed = rowsTotal + overheadRecomputed + profitRecomputed;
  if (stated !== null) arithmeticEffect = recomputed - stated;

  /* ---- Цены ресурсов (шаг 2) ---- */
  let checkedDirect = 0;
  const groupImpact: Record<DirectGroup, number> = { LABOUR: 0, MACHINES: 0, MATERIALS: 0 };
  let wageImpact = 0;
  let baseCompared = 0;
  let baseMatched = 0;

  for (const resource of priced) {
    const total = resource.currentTotal ?? 0;
    const group = groupOf(resource.code);
    const quantity = resource.qtyTotal;
    const customerPrice = resource.currentUnitPrice;

    // Процентная добавка («2 % ненормируемых материалов») — норматив, а не цена ресурса.
    if (resource.unit === "%") continue;

    // Базис заказчика (графа 8) против базиса ФСБЦ-2022: совпал базис — расхождение цен целиком
    // в индексе (его можно проверить по сплит-форме), не совпал — заказчик взял другой базис.
    // Только материалы: базис машины в смете — без оплаты машинистов, когда она вынесена в «ОТм»
    // (у 91.06.06-048 37,32 против 336,09 в ФСБЦ), и сверка машин была бы сплошным шумом.
    if (resource.baseUnitPrice !== null && resource.baseUnitPrice > 0 && classifyResourceCode(resource.code) === "MATERIAL") {
      const federal = ctx.priceBook.base.get(resource.code);
      const baseScale = federal === undefined ? null : unitScale(resource.unit, federal.unit);
      if (federal !== undefined && federal.price > 0 && baseScale !== null) {
        const federalPrice = federal.price * baseScale;
        baseCompared += 1;
        if (Math.abs(federalPrice - resource.baseUnitPrice) <= Math.max(0.02, federalPrice * 0.005)) {
          baseMatched += 1;
        } else {
          add({
            type: "BASE_PRICE",
            severity: "INFO",
            message: `${label(position)}: ${resource.code} — базис заказчика ${resource.baseUnitPrice.toFixed(2)} ₽, по ФСБЦ-2022 ${federalPrice.toFixed(2)} ₽`,
            subject: resource.code,
            customerValue: resource.baseUnitPrice,
            ourValue: federalPrice,
          });
        }
      }
    }

    const ours = ourPrice(resource, ctx);
    // У перевозки и погрузки «цена заказчика» — не КП, а цена по таблице, которую мы теперь знаем.
    const note = resource.customerPrice && ours?.source !== "SERVICE" ? " (цена заказчика по КП или конъюнктурному анализу)" : "";
    if (resource.customerPrice && ours === null) {
      unchecked.push({ kind: "CUSTOMER_PRICE", code: resource.rawCode, name: resource.name, positions: 1, amount: total });
      add({
        type: "CUSTOMER_PRICE_NO_COMPARE",
        severity: "INFO",
        message: `${label(position)}: ${resource.rawCode} — цена заказчика по КП, не с чем сравнить`,
        subject: resource.rawCode,
      });
      continue;
    }
    if (ours === null) {
      unchecked.push({ kind: "OUR_PRICE_MISSING", code: resource.code, name: resource.name, positions: 1, amount: total });
      add({
        type: "OUR_PRICE_MISSING",
        severity: "INFO",
        message: `${label(position)}: нашей цены на ${resource.code} нет — ресурс не проверен`,
        subject: resource.code,
      });
      continue;
    }
    if (quantity === null || customerPrice === null || quantity <= 0) {
      unchecked.push({ kind: "NO_RESOURCES", code: resource.code, name: resource.name, positions: 1, amount: total });
      continue;
    }
    // Цена за «1000 м» и за «м» отличается в тысячу раз: приводим нашу цену к единице заказчика.
    const scale = unitScale(resource.unit, ours.unit);
    if (ours.unit !== null && resource.unit !== "" && scale === null) {
      unchecked.push({ kind: "UNIT_MISMATCH", code: resource.code, name: resource.name, positions: 1, amount: total });
      add({
        type: "UNIT_MISMATCH",
        severity: "INFO",
        message: `${label(position)}: ${resource.code} — единицы различаются (у заказчика «${resource.unit}», у нас «${ours.unit}»), цена не сравнивалась`,
        subject: resource.code,
      });
      continue;
    }

    const ourUnitPrice = ours.price * (scale ?? 1);
    checkedDirect += total;
    // Коэффициент к цене (графа 11) умножает и его цену, и нашу: влияние считается с ним.
    const priceFactor = resource.priceCoefficient !== null && resource.priceCoefficient > 0 ? resource.priceCoefficient : 1;
    const delta = (ourUnitPrice - customerPrice) * quantity * priceFactor;
    groupImpact[group] += delta;
    if (group === "LABOUR") wageImpact += delta;
    const relative = customerPrice > 0 ? Math.abs(ourUnitPrice - customerPrice) / customerPrice : 1;
    if (relative > PRICE_NOISE && Math.abs(delta) >= 0.01) {
      impacts[group].rows += 1;
      add({
        type: "RESOURCE_PRICE",
        severity: "WARNING",
        message: `${label(position)}: ${resource.code} — цена заказчика ${customerPrice.toFixed(2)} ₽, наша ${ourUnitPrice.toFixed(2)} ₽${ours.source === undefined ? "" : ` (${OUR_PRICE_SOURCE_LABEL[ours.source]})`}, количество ${String(quantity)}${note}`,
        impact: delta,
        subject: resource.code,
        customerValue: customerPrice,
        ourValue: ourUnitPrice,
        quantity,
        ...(ours.source === undefined ? {} : { ourSource: ours.source }),
      });
    }
  }

  /* ---- Нормативы НР и СП (шаг 3) ---- */
  const wageOur = wageFund + wageImpact;
  let overheadDelta = 0;
  let profitDelta = 0;
  let rateKnockOn = 0;
  const rates = [
    { rate: position.overhead, name: "НР", type: "OVERHEAD_RATE" as const, group: "OVERHEAD" as const },
    { rate: position.profit, name: "СП", type: "PROFIT_RATE" as const, group: "PROFIT" as const },
  ];
  for (const { rate, name, type, group } of rates) {
    if (rate === null || rate.percent === null) continue;
    // Пересчёт труда тянет за собой начисление по проценту заказчика — это следствие цен труда.
    rateKnockOn += (wageImpact * rate.percent) / 100;

    if (rate.ref === null) {
      add({
        type: "RATE_NOT_CHECKED",
        severity: "INFO",
        message: `${label(position)}: у ${name} нет указателя приказа — норматив не проверен`,
        subject: name,
      });
      continue;
    }
    const { base, suffixed } = refBase(rate.ref);
    const normative = ctx.priceBook.overheadRates.get(base);
    if (normative === undefined || rate.basePercent === null) {
      add({
        type: "RATE_NOT_CHECKED",
        severity: "INFO",
        message: `${label(position)}: указателя ${rate.ref} нет в нашем справочнике ${name} — норматив не проверен`,
        subject: base,
      });
      continue;
    }
    if (Math.abs(normative.percent - rate.basePercent) <= RATE_TOLERANCE) continue;

    // Коэффициент заказчика (графа 6) сохраняется: сравниваются нормативы, а не применённые проценты.
    const coefficient = rate.basePercent > 0 && rate.percent !== null ? rate.percent / rate.basePercent : 1;
    const ourApplied = normative.percent * coefficient;
    const delta = (wageOur * (ourApplied - rate.percent)) / 100;
    if (group === "OVERHEAD") overheadDelta += delta;
    else profitDelta += delta;
    impacts[group].rows += 1;
    add({
      type,
      severity: suffixed ? "INFO" : "WARNING",
      message:
        `${label(position)}: ${name} ${rate.ref} — у заказчика ${String(rate.basePercent)} %, по приказу ${String(normative.percent)} %` +
        (suffixed ? "; у указателя есть уточнение (-1) — возможно, применён понижающий коэффициент, проверьте" : ""),
      impact: delta,
      subject: base,
      customerValue: rate.basePercent,
      ourValue: normative.percent,
    });
  }

  // Итог по нашим ценам и нормативам.
  const ourRate = (rate: CustomerPosition["overhead"], delta: number): number =>
    rate === null ? 0 : rate.percent === null ? (rate.amount ?? 0) : (wageOur * rate.percent) / 100 + delta;
  const ourOverhead = ourRate(position.overhead, overheadDelta);
  const ourProfit = ourRate(position.profit, profitDelta);
  const directOur = rowsTotal + groupImpact.LABOUR + groupImpact.MACHINES + groupImpact.MATERIALS;
  const ourTotal = directOur + ourOverhead + ourProfit;
  const customerBase = stated ?? recomputed;
  const diff = ourTotal - customerBase;

  // Группы: труд — вместе с начислениями НР и СП на него.
  impacts.LABOUR.amount = groupImpact.LABOUR + rateKnockOn;
  impacts.MACHINES.amount = groupImpact.MACHINES;
  impacts.MATERIALS.amount = groupImpact.MATERIALS;
  impacts.OVERHEAD.amount = overheadDelta;
  impacts.PROFIT.amount = profitDelta;
  impacts.ARITHMETIC.amount = arithmeticEffect;

  const flags = [...new Set(findings.filter((finding) => finding.severity === "WARNING").map((finding) => finding.type))];
  const directBase = rowsTotal > 0 ? rowsTotal : (position.directTotal ?? 0);
  return {
    position: {
      number: position.number,
      code: position.code,
      name: position.name,
      section: position.section,
      customerTotal: customerBase,
      ourTotal,
      diff,
      flags,
      checkedShare: directBase > 0 ? Math.min(1, checkedDirect / directBase) : 0,
    },
    findings,
    impacts,
    checkedDirect,
    totalDirect: directBase,
    unchecked,
    baseCompared,
    baseMatched,
  };
}

/* ------------------------------ Аудит сметы ------------------------------ */

export function emptySummary(): Record<ImpactGroup, { amount: number; count: number; discrepancy: number }> {
  return {
    LABOUR: { amount: 0, count: 0, discrepancy: 0 },
    MACHINES: { amount: 0, count: 0, discrepancy: 0 },
    MATERIALS: { amount: 0, count: 0, discrepancy: 0 },
    OVERHEAD: { amount: 0, count: 0, discrepancy: 0 },
    PROFIT: { amount: 0, count: 0, discrepancy: 0 },
    ARITHMETIC: { amount: 0, count: 0, discrepancy: 0 },
    VAT: { amount: 0, count: 0, discrepancy: 0 },
  };
}

export function describeConclusion(diff: number, percent: number | null, coverage: number): { verdict: AuditVerdict; text: string } {
  const significant = Math.abs(diff) >= 1 && (percent === null || Math.abs(percent) >= 0.05);
  let verdict: AuditVerdict = "MATCH";
  let text = "НМЦК сходится с пересчётом по нашим ценам";
  if (significant) {
    const share = percent === null ? "" : ` (${Math.abs(percent).toFixed(1).replace(".", ",")} %)`;
    if (diff > 0) {
      verdict = "UNDERSTATED";
      text = `НМЦК занижена на ${rub(diff)}${share}`;
    } else {
      verdict = "OVERSTATED";
      text = `НМЦК завышена на ${rub(diff)}${share}`;
    }
  }
  if (coverage < MIN_RELIABLE_COVERAGE) {
    text += `; проверено ${String(Math.round(coverage * 100))} % сметы — вывод неполный`;
  }
  return { verdict, text };
}

/**
 * Итог заказчика и его база без НДС.
 *
 * У программ два порядка. «ВСЕГО по смете» уже с НДС (итог ≈ Σ разделов × (1 + ставка));
 * либо «ВСЕГО по смете» — без НДС, а НДС идёт строкой ниже и итогом «с учётом концовок»
 * (тогда НМЦК — база + НДС). Различает их сверка итога с суммой разделов. Ставки нет
 * вовсе — сравнивается как есть, без НДС.
 */
function customerAmounts(lsr: CustomerLsr): { total: number; base: number; withVat: boolean } {
  const vat = lsr.vatPercent;
  if (lsr.total === null) return { total: lsr.positionsTotal, base: lsr.positionsTotal, withVat: false };
  if (vat === null) return { total: lsr.total, base: lsr.total, withVat: false };

  const vatIncluded =
    lsr.sectionsTotal > 0
      ? Math.abs(lsr.total - lsr.sectionsTotal * (1 + vat / 100)) <= Math.max(1, Math.abs(lsr.total) * 0.001)
      : true;
  if (vatIncluded) {
    const base =
      lsr.vatAmount !== null && lsr.vatAmount > 0 && lsr.vatAmount < lsr.total
        ? lsr.total - lsr.vatAmount
        : lsr.total / (1 + vat / 100);
    return { total: lsr.total, base, withVat: true };
  }
  // НДС стоит за итогом. База НДС у программы может быть шире «ВСЕГО по смете» (концовки,
  // добавленные после итога): по сумме НДС и ставке восстанавливается настоящая база.
  if (lsr.vatAmount !== null && lsr.vatAmount > 0) {
    const base = lsr.vatAmount / (vat / 100);
    return { total: base + lsr.vatAmount, base: Math.max(base, lsr.total), withVat: true };
  }
  return { total: lsr.total * (1 + vat / 100), base: lsr.total, withVat: true };
}

export function auditCustomerLsr(lsr: CustomerLsr, ctx: AuditContext): AuditReport {
  const ourVat = ctx.vatPercent ?? DEFAULT_VAT_PERCENT;
  const customerVat = lsr.vatPercent;
  const amounts = customerAmounts(lsr);
  const withVat = amounts.withVat;
  const scale = withVat ? 1 + ourVat / 100 : 1;

  const outcomes = lsr.positions.map((position) => auditPosition(position, ctx));
  const positions = outcomes.map((outcome) => outcome.position);
  const findings: AuditFinding[] = outcomes.flatMap((outcome) => outcome.findings);

  const totalMissing = lsr.total === null;
  const customerTotal = amounts.total;
  const customerBase = amounts.base;

  const priceDiffExVat = outcomes.reduce((sum, outcome) => sum + outcome.position.diff, 0);
  const repricedBase = customerBase + priceDiffExVat;
  const repricedTotal = withVat ? repricedBase * scale : repricedBase;

  // Группы по смете. Суммы позиций уже без НДС — приводятся к итогу.
  const summary = emptySummary();
  for (const outcome of outcomes) {
    for (const group of Object.keys(summary) as ImpactGroup[]) {
      const entry = outcome.impacts[group];
      summary[group].amount += entry.amount * scale;
      summary[group].count += entry.rows;
    }
  }
  for (const finding of findings) {
    if (finding.type === "ARITHMETIC" && finding.discrepancy !== undefined) summary.ARITHMETIC.discrepancy += finding.discrepancy;
  }

  // НДС: ставка заказчика против нашей, на его базу.
  if (withVat && customerVat !== null && Math.abs(customerVat - ourVat) > 1e-9) {
    const effect = ((ourVat - customerVat) / 100) * customerBase;
    summary.VAT.amount = effect;
    summary.VAT.count = 1;
    findings.push({
      type: "VAT_RATE",
      severity: "WARNING",
      positionNumber: null,
      message:
        `НДС ${String(customerVat)} % вместо ${String(ourVat)} %` +
        (lsr.vatInferred ? " (ставка выведена по итогу сметы)" : "") +
        `: разница ${rub(effect)} на базе ${rub(customerBase)}`,
      impact: effect,
      customerValue: customerVat,
      ourValue: ourVat,
    });
  }
  const diff = repricedTotal - customerTotal;

  // Уровень цен и зона.
  const ourQuarter = quarterIn(ctx.priceBook.period);
  if (
    lsr.priceQuarter !== null &&
    ourQuarter !== null &&
    (lsr.priceQuarter.year < ourQuarter.year ||
      (lsr.priceQuarter.year === ourQuarter.year && lsr.priceQuarter.quarter < ourQuarter.quarter))
  ) {
    findings.push({
      type: "OUTDATED_PRICE_LEVEL",
      severity: "WARNING",
      positionNumber: null,
      message:
        `Смета составлена в ценах ${String(lsr.priceQuarter.quarter)} кв. ${String(lsr.priceQuarter.year)}, наши — ${ctx.priceBook.period}: ` +
        "устарела на " +
        quartersWord((ourQuarter.year - lsr.priceQuarter.year) * 4 + ourQuarter.quarter - lsr.priceQuarter.quarter),
      impact: null,
    });
  }
  const ourZone = zoneNumberIn(ctx.priceBook.priceZone);
  if (lsr.priceLevel.zone !== null && ourZone !== null && lsr.priceLevel.zone !== ourZone) {
    findings.push({
      type: "ZONE_MISMATCH",
      severity: "WARNING",
      positionNumber: null,
      message: `Смета заказчика названа по ${String(lsr.priceLevel.zone)} ценовой зоне, а сравнение идёт по ${ctx.priceBook.priceZone}`,
      impact: null,
    });
  }

  // Σ позиций против итога разделов: заказчик мог не включить часть позиций в раздел.
  if (lsr.sectionsTotal > 0 && Math.abs(lsr.positionsTotal - lsr.sectionsTotal) > tolerance(lsr.sectionsTotal, positions.length)) {
    findings.push({
      type: "SECTIONS_SUM",
      severity: "INFO",
      positionNumber: null,
      message:
        `Сумма «Всего по позиции» ${lsr.positionsTotal.toFixed(2)} ₽ не равна сумме итогов разделов ${lsr.sectionsTotal.toFixed(2)} ₽ ` +
        `(разница ${(lsr.positionsTotal - lsr.sectionsTotal).toFixed(2)} ₽)`,
      impact: null,
      discrepancy: Math.abs(lsr.positionsTotal - lsr.sectionsTotal),
    });
  }

  // Зимнее удорожание и временные здания заказчика — против приказов 325/пр и 332/пр (справка со ссылкой на пункт).
  if (lsr.limitedCosts !== undefined) {
    for (const found of checkCustomerLimitedCosts({
      winter: lsr.limitedCosts.winter,
      temporary: lsr.limitedCosts.temporary,
      text: `${lsr.estimateName ?? ""} ${lsr.documentName}`,
      base: customerBase,
      subject: ctx.subject ?? null,
    })) {
      findings.push({
        type: "LIMITED_COSTS",
        severity: found.severity,
        positionNumber: null,
        message: found.message,
        impact: null,
      });
    }
  }

  // Базис заказчика против ФСБЦ-2022 — одной строкой на смету; расходящиеся ресурсы названы выше поштучно.
  const baseCompared = outcomes.reduce((sum, outcome) => sum + outcome.baseCompared, 0);
  const baseMatched = outcomes.reduce((sum, outcome) => sum + outcome.baseMatched, 0);
  if (baseCompared > 0) {
    findings.push({
      type: "BASE_PRICE",
      severity: "INFO",
      positionNumber: null,
      message:
        `Базис заказчика сверен с ФСБЦ-2022 у ${String(baseCompared)} ресурсов: совпал у ${String(baseMatched)}, ` +
        `расходится у ${String(baseCompared - baseMatched)}. Где базис совпал, разница цен — это индекс, его проверяет сплит-форма зоны.`,
      impact: null,
    });
  }

  // Что не проверено: склеено по коду.
  const merged = new Map<string, UncheckedItem>();
  for (const item of outcomes.flatMap((outcome) => outcome.unchecked)) {
    const key = `${item.kind}|${item.code}`;
    const existing = merged.get(key);
    merged.set(
      key,
      existing === undefined
        ? item
        : { ...existing, positions: existing.positions + item.positions, amount: existing.amount + item.amount },
    );
  }

  const checkedDirect = outcomes.reduce((sum, outcome) => sum + outcome.checkedDirect, 0);
  const totalDirect = outcomes.reduce((sum, outcome) => sum + outcome.totalDirect, 0);
  const coverage = totalDirect > 0 ? Math.min(1, checkedDirect / totalDirect) : 0;
  const diffPercent = customerTotal === 0 ? null : (diff * 100) / customerTotal;
  const conclusion = describeConclusion(diff, diffPercent, coverage);

  const top = [...positions].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10).filter((position) => Math.abs(position.diff) > 0);

  return {
    documentName: lsr.documentName,
    estimateName: lsr.estimateName,
    customerTotal,
    totalMissing,
    repricedTotal,
    diff,
    diffPercent,
    vat: { included: withVat, customerPercent: customerVat, inferred: lsr.vatInferred, ourPercent: ourVat },
    impacts: summary,
    coverage,
    checkedDirect,
    totalDirect,
    positions,
    top,
    findings,
    unchecked: [...merged.values()].sort((a, b) => b.amount - a.amount),
    verdict: conclusion.verdict,
    conclusion: conclusion.text,
    zone: ctx.priceBook.priceZone,
    period: ctx.priceBook.period,
    priceQuarter: lsr.priceQuarter,
  };
}

export function quartersWord(count: number): string {
  if (count === 1) return "квартал";
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "квартала" : "кварталов";
  return `${String(count)} ${word}`;
}
