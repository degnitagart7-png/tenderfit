import type { CustomerPosition, CustomerRate } from "@/domain/estimate/customerLsr";
import { documentOrder, lsrBillSection } from "@/domain/estimate/customerLsrBill";
import type { LsrEntry, LsrSet } from "@/domain/estimate/customerLsrSet";
import type { EstimateDocument, EstimateGapKind, EstimateLine } from "@/domain/estimate/types";

/**
 * Бенчмарк точности: насколько наш расчёт воспроизводит локальные сметы самих заказчиков (ЛСР формы 421/пр).
 *
 * Зачем. Когда в документации есть ЛСР, ведомость объёмов строится из неё кодом, без модели, а цены, труд, машины
 * и начисления считает наш расчёт по ценам зоны и нормам ФСНБ. Объёмы и шифры у обеих сторон одни и те же, поэтому
 * расхождение итога — это ошибка именно расчёта: цены, нормы, начисления, коэффициенты. Модуль строит по каждой
 * позиции ЛСР сравнение «заказчик — мы» и раскладывает разницу в рублях по составляющим: оплата труда, эксплуатация
 * машин, оплата труда машинистов, материалы, НР, СП, остальное. Так видно, какая именно составляющая системно расходится.
 *
 * Модуль чистый: ни диска, ни сети, ни базы. Разобранную смету заказчика (`buildLsrSet`) и готовый документ
 * (`EstimateDocument`) ему приносит скрипт `scripts/estimate-benchmark.ts`.
 *
 * Как позиция ЛСР находит свою строку в нашей смете. Идентификатор строки — `l<номер сметы в наборе>-<метка позиции>`
 * (`customerLsrBill.ts`). Повторяющаяся метка получает суффикс, а позиция без объёма или единицы в ведомость не
 * попадает вовсе, поэтому идентификатор не собирается заново, а берётся из той же ведомости, которую строит расчёт
 * (`lsrBillSection`): позиции идут в том же порядке (`documentOrder`), и каждая берёт следующую строку ведомости с
 * её меткой. Нет такой строки — позиция «только у заказчика». Строка нашей сметы, которой не нашлось позиции, —
 * «только у нас». Невидимый остаток позиции («Всего по позиции» больше видимых составляющих) расчёт кладёт отдельной
 * строкой `<id>-rest`; здесь она сливается с позицией и входит в её итог, как «Всего по позиции» у заказчика.
 *
 * Что значит «заказчик ЭМ». В смете формы 421/пр графа «ЭМ» по Гранд-Смете включает оплату труда машинистов (ОТм
 * печатается следом как «в том числе»), но другие программы печатают ЭМ без неё и прибавляют ОТм к прямым затратам
 * отдельно. Модуль не угадывает, а считает обе трактовки: «ЭМ заказчика с ОТм» против нашего `machineCost` и «ЭМ
 * заказчика без ОТм» против `machineCost − machinistSalaryCost`; какая сошлась, записано в позиции
 * (`MachinesView.matched`). Для разложения рублей заказчик приводится к виду «ЭМ без ОТм + ОТм в прямых затратах» по
 * первому, что дало ответ: арифметика самой сметы заказчика (прямые затраты = ОТ + ЭМ + М или ОТ + ЭМ + ОТм + М),
 * затем совпадение с нашими цифрами, иначе — трактовка Гранд-Сметы (`MachinesView.used`, `usedBy`).
 *
 * Наша сторона. `machineCost` включает ОТм (это полная стоимость маш.-ч с оплатой машинистов — и у цены базы ФСБЦ, и у текущей
 * цены ФГИС ЦС, к которой `resolvePrice` прибавляет опубликованную отдельной колонкой оплату звена), а `machinistSalaryCost` —
 * её часть, нужная для ФОТ. Форма 421/пр печатает ЭМ без ОТм и прибавляет строки ОТм к прямым затратам (ОТ + ЭМ + ОТм + М): её ЭМ
 * должен сойтись с `machineCost − machinistSalaryCost` (трактовка «без ОТм»), а ОТм — с `machinistSalaryCost`. Сметы, посчитанные до
 * исправления (расчёт брал цену ФГИС ЦС за полную и не прибавлял оплату звена), показывают обратное: ЭМ заказчика без ОТм совпадает с
 * нашим `machineCost` целиком, и оплаты машинистов в наших прямых затратах нет. Тогда «ЭМ без ОТм» у нас — это весь `machineCost`, а
 * разницу в ОТм надо видеть как разницу ОТм, а не как «машины дешевле» (иначе недостающая ОТм записывалась бы на ЭМ). Такая позиция
 * помечена `MachinesView.oursIncludesPay = false`; на свежем расчёте она не должна встречаться, а если встретилась — это признак
 * старого документа или машины без оплаты звена (`MACHINIST_PAY_UNKNOWN`).
 *
 * Пропуски. Нет значения — `null`, а не ноль: «заказчик не напечатал НР» и «НР равен нулю» — разные вещи. Нулём
 * отсутствующее считается только внутри арифметики разницы, и только когда у позиции есть таблица ресурсов
 * (`directTotal` не `null`): там отсутствующая группа «М» действительно равна нулю.
 */

/** Сколько знаков наименования остаётся в строке сравнения. */
export const NAME_LIMIT = 120;

/** Допуск сравнения цифр машин: полрубля или процент (разные программы округляют по-своему). */
const MACHINES_TOLERANCE_RUB = 0.5;
const MACHINES_TOLERANCE_RATIO = 0.01;

/** Допуск арифметики сметы заказчика: рубль (то же, что у невидимого остатка позиции). */
const ARITHMETIC_TOLERANCE_RUB = 1;

/** Допуск сравнения процентов НР и СП, процентных пунктов: «90» и «90,0» — один норматив. */
const PERCENT_TOLERANCE = 0.01;

/** Сколько позиций с самой большой разницей остаётся в списке по умолчанию. */
export const DEFAULT_TOP = 50;

/* ------------------------------ Типы ------------------------------ */

/**
 * Корзина позиции по |Δ%| итога; позиции, найденные только с одной стороны, — в своих корзинах.
 * `NO_TOTAL` — позиция есть с обеих сторон, но заказчик «Всего по позиции» не напечатал (позиция оборвана): процент не определён.
 */
export type DeltaBucket = "LT_1" | "FROM_1_TO_5" | "FROM_5_TO_20" | "GE_20" | "ONLY_CUSTOMER" | "ONLY_OURS" | "NO_TOTAL";

export const DELTA_BUCKETS: readonly DeltaBucket[] = ["LT_1", "FROM_1_TO_5", "FROM_5_TO_20", "GE_20", "ONLY_CUSTOMER", "ONLY_OURS", "NO_TOTAL"];

/** Как графа «ЭМ» заказчика соотносится с ОТм. */
export type MachinistBasis = "INCLUDES_OTM" | "EXCLUDES_OTM";

/** Что говорит арифметика сметы заказчика: ЭМ включает ОТм, не включает, различать нечего или свести не удалось. */
export type MachinistDeclared = MachinistBasis | "NOT_APPLICABLE" | "UNDETERMINED";

/** С какой нашей цифрой сошлась графа «ЭМ» заказчика: с ЭМ с ОТм, без ОТм, с обеими, ни с одной или различать нечего. */
export type MachinistMatch = MachinistBasis | "BOTH" | "NONE" | "NOT_APPLICABLE";

/** Откуда взята трактовка, по которой заказчик приведён к виду «ЭМ без ОТм + ОТм». */
export type MachinistUsedBy = "ARITHMETIC" | "MATCH" | "DEFAULT";

export interface BenchmarkCustomer {
  /** ОТ(ЗТ). */
  readonly labour: number | null;
  /** «ЭМ» как напечатано в смете заказчика. */
  readonly machines: number | null;
  /** ОТм(ЗТм). */
  readonly machinistLabour: number | null;
  /** М. */
  readonly materials: number | null;
  /** «Итого прямые затраты». */
  readonly direct: number | null;
  readonly overheadAmount: number | null;
  readonly overheadPercent: number | null;
  readonly overheadBasePercent: number | null;
  readonly overheadRef: string | null;
  readonly profitAmount: number | null;
  readonly profitPercent: number | null;
  readonly profitBasePercent: number | null;
  readonly profitRef: string | null;
  /** «Всего по позиции». */
  readonly total: number | null;
}

/** Пометки нашей строки: чем она посчитана и что с ней случилось по пути. */
export interface BenchmarkFlags {
  readonly priceSource: "CUSTOMER_PRICE" | "FGIS_SERVICE" | "OWN_PRICE" | null;
  /** Строка посчитана по цене заказчика, а не по нашей норме. */
  readonly customerPrice: boolean;
  /** К позиции добавлена строка невидимого остатка («Всего по позиции» больше видимых составляющих). */
  readonly residualHidden: boolean;
  /** Строка вычитает (отрицательный объём в смете заказчика). */
  readonly deduction: boolean;
  readonly gapKinds: readonly EstimateGapKind[];
  /** Применённые коэффициенты одной строкой; null — не применялись. */
  readonly coefficients: string | null;
}

export interface BenchmarkOurs {
  readonly itemId: string;
  readonly normCode: string;
  readonly normBaseType: string;
  /** Оплата труда рабочих; null у строк по цене (там разбивки нет). */
  readonly labour: number | null;
  /** Эксплуатация машин, включая оплату труда машинистов (как `machineCost` строки). */
  readonly machinesInclMachinist: number | null;
  /** Эксплуатация машин без оплаты труда машинистов. */
  readonly machinesExclMachinist: number | null;
  /** Оплата труда машинистов. */
  readonly machinistPay: number | null;
  readonly materials: number | null;
  /** Прямые затраты строки, без невидимого остатка. */
  readonly direct: number;
  readonly overheadAmount: number;
  readonly overheadPercent: number;
  readonly overheadRef: string | null;
  readonly profitAmount: number;
  readonly profitPercent: number;
  readonly profitRef: string | null;
  /** Стоимость строки невидимого остатка; null — такой строки нет. */
  readonly residual: number | null;
  /** Итог без НДС: прямые + НР + СП + невидимый остаток. */
  readonly total: number;
  /** Объём, по которому посчитано: в единицах нормы и как в ведомости. */
  readonly volume: {
    readonly quantity: number;
    readonly unit: string;
    readonly billQuantity: number;
    readonly billUnit: string;
  };
  readonly flags: BenchmarkFlags;
}

/** Обе трактовки «ЭМ заказчика» и то, какая из них подошла. */
export interface MachinesView {
  readonly declared: MachinistDeclared;
  readonly matched: MachinistMatch;
  readonly used: MachinistBasis;
  readonly usedBy: MachinistUsedBy;
  /** Заказчик в виде «ЭМ без ОТм» и «ОТм в прямых затратах» по трактовке `used`: из них считается разложение. */
  readonly customerMachinesExclMachinist: number;
  readonly customerMachinist: number;
  /**
   * Входит ли оплата машинистов в наш `machineCost`. `false` — на этой позиции ЭМ заказчика без ОТм совпал с нашим
   * `machineCost` целиком (см. шапку файла): «ЭМ без ОТм» у нас — весь `machineCost`, ОТм в прямых затратах — ноль.
   */
  readonly oursIncludesPay: boolean;
  /** Наша сторона в том же виде, что и заказчик: «ЭМ без ОТм» и «ОТм в прямых затратах». */
  readonly oursMachinesExclMachinist: number;
  readonly oursMachinist: number;
  /** Трактовка А: ЭМ заказчика включает ОТм — сравнивается с нашим `machineCost`. */
  readonly includesOtm: { readonly customer: number; readonly ours: number; readonly delta: number };
  /** Трактовка Б: ЭМ заказчика без ОТм — сравнивается с `machineCost − machinistSalaryCost`. */
  readonly excludesOtm: { readonly customer: number; readonly ours: number; readonly delta: number };
}

/** Сравнение НР или СП одной позиции. */
export interface RateComparison {
  readonly customerPercent: number | null;
  readonly ourPercent: number;
  readonly customerBasePercent: number | null;
  /** Норматив по указателю до множителя заказчика; без множителя равен применённому проценту. */
  readonly ourBasePercent: number;
  readonly customerRef: string | null;
  readonly ourRef: string | null;
  /** Применённые проценты различаются больше чем на 0,01 п. п. */
  readonly mismatch: boolean;
  /** Сумма у нас минус сумма у заказчика, ₽. */
  readonly amountDelta: number;
}

export interface BenchmarkDelta {
  /** Наш итог минус итог заказчика, ₽. */
  readonly total: number;
  /** В процентах от итога заказчика; null — итог заказчика ноль, а у нас не ноль, или заказчик итог не напечатал. */
  readonly totalPercent: number | null;
  /** Прямые затраты: наши минус заказчика; null — разложить нечего. */
  readonly direct: number | null;
  /** Составляющие разницы; null у всех, когда позицию разложить нельзя (`componentsComparable`). */
  readonly labour: number | null;
  /** ЭМ без ОТм: сравниваются одинаковые величины. */
  readonly machines: number | null;
  readonly machinist: number | null;
  readonly materials: number | null;
  readonly overhead: number | null;
  readonly profit: number | null;
  /** Неразложенный остаток: итог минус составляющие (невидимый остаток, округление; у неразложимых позиций — вся разница). */
  readonly other: number;
  /**
   * Разложить можно, когда у заказчика есть таблица ресурсов, а наша строка посчитана по норме, а не по цене
   * (у строки по цене разбивки по составляющим нет).
   */
  readonly componentsComparable: boolean;
}

export interface BenchmarkRow {
  /** Номер сметы в наборе (с 1); null — строка не из ЛСР. */
  readonly lsrIndex: number | null;
  readonly lsrKey: string | null;
  readonly lsrNumber: string | null;
  /** Метка позиции («3», «3.1»); у строки «только у нас» — её идентификатор. */
  readonly label: string;
  readonly subPosition: boolean;
  /** Обоснование (шифр расценки) позиции заказчика; у строки «только у нас» — наш код нормы. */
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  /** Объём позиции заказчика (графа 7 или 5); у строки «только у нас» — объём ведомости. */
  readonly quantity: number | null;
  readonly customer: BenchmarkCustomer | null;
  readonly ours: BenchmarkOurs | null;
  readonly machines: MachinesView | null;
  readonly overheadRate: RateComparison | null;
  readonly profitRate: RateComparison | null;
  readonly delta: BenchmarkDelta | null;
  readonly bucket: DeltaBucket;
  /** Позиция заказчика, не попавшая в ведомость (нет объёма, единицы, наименования), с причиной. */
  readonly skipped: { readonly reason: string; readonly message: string } | null;
}

export interface LsrComparison {
  readonly index: number;
  readonly key: string;
  readonly number: string | null;
  readonly title: string | null;
  readonly documentName: string;
  /** «ВСЕГО по смете» без НДС; null — итога в смете нет. */
  readonly customerTotalExVat: number | null;
  /** Сумма «Всего по позиции» по позициям и подпозициям: то, с чем сопоставимы наши строки. */
  readonly customerPositionsTotal: number | null;
  /** Наш итог по строкам этой сметы, без НДС. */
  readonly oursTotal: number;
  readonly deltaVsTotal: number | null;
  readonly deltaPercentVsTotal: number | null;
  readonly deltaVsPositions: number | null;
  readonly deltaPercentVsPositions: number | null;
  readonly positions: number;
  readonly matched: number;
  readonly onlyCustomer: number;
  readonly onlyOurs: number;
}

/** Рубли разницы Σ(наши − заказчика) по составляющим. */
export interface Attribution {
  readonly total: number;
  readonly labour: number;
  readonly machines: number;
  readonly machinist: number;
  readonly materials: number;
  readonly overhead: number;
  readonly profit: number;
  /** Неразложенный остаток у позиций, найденных с обеих сторон (включая позиции, которые разложить нельзя). */
  readonly other: number;
  /** Позиции, найденные только с одной стороны: у заказчика — минус его итог, у нас — плюс наш. */
  readonly unmatched: number;
}

export interface BucketStat {
  readonly count: number;
  /** Сумма |Δ| по корзине, ₽. */
  readonly absDelta: number;
}

/** НР или СП с расходящимся процентом у одного шифра расценки. */
export interface RateMismatchGroup {
  readonly code: string;
  readonly kind: "overhead" | "profit";
  readonly customerPercent: number | null;
  readonly ourPercent: number;
  readonly positions: number;
  /** Σ (наша сумма − сумма заказчика) по этим позициям, ₽. */
  readonly amountDelta: number;
}

export interface RateMismatchSummary {
  readonly overheadPositions: number;
  readonly profitPositions: number;
  /** Позиции, где расходится НР или СП (каждая — один раз). */
  readonly eitherPositions: number;
  readonly groups: readonly RateMismatchGroup[];
}

export interface MachinistSummary {
  readonly declared: Readonly<Record<MachinistDeclared, number>>;
  readonly matched: Readonly<Record<MachinistMatch, number>>;
  readonly usedBy: Readonly<Record<MachinistUsedBy, number>>;
  /** Позиции по паре «что говорит арифметика сметы заказчика — с чем сошлась его графа ЭМ». */
  readonly crossTab: Readonly<Record<MachinistDeclared, Readonly<Record<MachinistMatch, number>>>>;
  /**
   * Позиции, где ЭМ заказчика без ОТм совпал с нашим `machineCost` целиком (`MachinesView.oursIncludesPay = false`): ОТм заказчика
   * приходится сверх нашего ЭМ. `customerMachinist` — сумма его ОТм по этим позициям, ₽: столько прямых затрат нам не хватает.
   */
  readonly oursWithoutPay: { readonly positions: number; readonly customerMachinist: number };
}

export interface PositionCounts {
  /** Позиций и подпозиций ЛСР. */
  readonly customer: number;
  readonly matched: number;
  readonly onlyCustomer: number;
  readonly onlyOurs: number;
  /** Из «только у заказчика»: позиции, не попавшие в ведомость. */
  readonly skipped: number;
  /** Позиции, посчитанные по цене, а не по норме (разложить нельзя). */
  readonly priced: number;
}

export interface DocumentTotalsView {
  readonly workCost: number;
  readonly beforeVat: number;
  readonly vat: number;
  readonly total: number;
}

export interface TenderAggregate {
  /** Σ «ВСЕГО по смете» без НДС по сметам, у которых он есть; null — ни у одной. */
  readonly customerTotalExVat: number | null;
  /** Не у всех смет итог найден: сумма неполная. */
  readonly customerTotalIncomplete: boolean;
  readonly customerPositionsTotal: number;
  /** Итоги нашего документа. */
  readonly document: DocumentTotalsView;
  /** Σ наших строк, найденных по сметам заказчика (сопоставима с `customerPositionsTotal`). */
  readonly oursRowsTotal: number;
  /** Наш итог до НДС против «ВСЕГО по смете» без НДС: главная цифра. */
  readonly deltaPercent: number | null;
  /** Наши строки против суммы позиций заказчика. */
  readonly rowsDeltaPercent: number | null;
  readonly counts: PositionCounts;
  readonly buckets: Readonly<Record<DeltaBucket, BucketStat>>;
  readonly attribution: Attribution;
  readonly machinist: MachinistSummary;
  readonly rateMismatches: RateMismatchSummary;
  /** Позиции с наибольшей |Δ| в рублях. */
  readonly top: readonly BenchmarkRow[];
}

export interface TenderComparison {
  readonly lsrs: readonly LsrComparison[];
  readonly rows: readonly BenchmarkRow[];
  readonly aggregate: TenderAggregate;
}

export interface CompareOptions {
  /** Сколько позиций с наибольшей разницей оставить (по умолчанию `DEFAULT_TOP`). */
  readonly topN?: number;
}

/* ------------------------------ Мелочи ------------------------------ */

const round2 = (value: number): number => Math.round(value * 100) / 100;
const orZero = (value: number | null): number => value ?? 0;

/** Наименование без переносов и лишних пробелов, не длиннее `NAME_LIMIT`. */
export function truncateName(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > NAME_LIMIT ? `${clean.slice(0, NAME_LIMIT - 1)}…` : clean;
}

/** Первая строка обоснования: в ячейке бывает «ГЭСН…\nприменительно\n…». */
function firstLine(raw: string): string {
  return (raw.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
}

/** Процент разницы от базы; база ноль: ноль, если и разница ноль, иначе процент не определён. */
function percentOf(delta: number, base: number | null): number | null {
  if (base === null) return null;
  if (base === 0) return delta === 0 ? 0 : null;
  return round2((delta / Math.abs(base)) * 100);
}

/** Корзина по |Δ%|: база ноль при ненулевой разнице — худшая корзина. */
export function bucketOfDelta(delta: number, base: number): DeltaBucket {
  if (base === 0) return delta === 0 ? "LT_1" : "GE_20";
  const absPercent = Math.abs(delta / base) * 100;
  if (absPercent < 1) return "LT_1";
  if (absPercent < 5) return "FROM_1_TO_5";
  if (absPercent < 20) return "FROM_5_TO_20";
  return "GE_20";
}

const emptyBuckets = (): Record<DeltaBucket, { count: number; absDelta: number }> => ({
  LT_1: { count: 0, absDelta: 0 },
  FROM_1_TO_5: { count: 0, absDelta: 0 },
  FROM_5_TO_20: { count: 0, absDelta: 0 },
  GE_20: { count: 0, absDelta: 0 },
  ONLY_CUSTOMER: { count: 0, absDelta: 0 },
  ONLY_OURS: { count: 0, absDelta: 0 },
  NO_TOTAL: { count: 0, absDelta: 0 },
});

/** Число для подписи коэффициента: без хвоста float. */
function factor(value: number): string {
  return String(Math.round(value * 10_000) / 10_000).replace(".", ",");
}

/**
 * Применённые коэффициенты строки одной фразой: только то, что отличается от единицы. null — к строке ничего не
 * применялось. Сюда входят коэффициенты условий работ (приложение 10 и п. 58), условия заказчика и множители к НР и СП.
 */
export function summarizeCoefficients(line: EstimateLine): string | null {
  const parts: string[] = [];
  const c = line.coefficients;
  if (c !== undefined) {
    if (c.labour !== 1) parts.push(`труд ×${factor(c.labour)}`);
    if (c.machines !== 1) parts.push(`машины ×${factor(c.machines)}`);
    if (c.wage !== 1) parts.push(`оплата труда ×${factor(c.wage)}`);
    if (c.materials !== undefined && c.materials !== 1) parts.push(`материалы ×${factor(c.materials)}`);
    if (c.conditionIds.length > 0) parts.push(`условия ${c.conditionIds.join(", ")}`);
    if (c.adjustmentIds.length > 0) parts.push(`поправки ${c.adjustmentIds.join(", ")}`);
    if (c.customer !== undefined && c.customer.applied.length > 0) parts.push(`как у заказчика: ${c.customer.applied.join(", ")}`);
  }
  const m = line.rateMultipliers;
  if (m !== undefined && (m.overhead !== 1 || m.profit !== 1 || m.applied.length > 0)) {
    parts.push(`НР ×${factor(m.overhead)}, СП ×${factor(m.profit)}${m.applied.length > 0 ? ` (${m.applied.join(", ")})` : ""}`);
  }
  return parts.length === 0 ? null : parts.join("; ");
}

/* ------------------------------ Стороны ------------------------------ */

const rateAmount = (rate: CustomerRate | null): number | null => (rate === null ? null : rate.amount);

function customerSide(position: CustomerPosition): BenchmarkCustomer {
  const g = position.groupTotals;
  return {
    labour: g.labour,
    machines: g.machines,
    machinistLabour: g.machinistLabour,
    materials: g.materials,
    direct: position.directTotal,
    overheadAmount: rateAmount(position.overhead),
    overheadPercent: position.overhead?.percent ?? null,
    overheadBasePercent: position.overhead?.basePercent ?? null,
    overheadRef: position.overhead?.ref ?? null,
    profitAmount: rateAmount(position.profit),
    profitPercent: position.profit?.percent ?? null,
    profitBasePercent: position.profit?.basePercent ?? null,
    profitRef: position.profit?.ref ?? null,
    total: position.total ?? position.ownTotal,
  };
}

const lineTotal = (line: EstimateLine): number => line.directCost + line.overheadCost + line.profitCost;

function ourSide(line: EstimateLine, rest: EstimateLine | null): BenchmarkOurs {
  // У строки по цене (заказчика, ФГИС ЦС, человека) состава нет: поля нулевые не потому, что затрат нет.
  const breakdown = line.priceSource === undefined;
  const residual = rest === null ? null : round2(lineTotal(rest));
  return {
    itemId: line.itemId,
    normCode: line.normCode,
    normBaseType: line.normBaseType,
    labour: breakdown ? line.labourCost : null,
    machinesInclMachinist: breakdown ? line.machineCost : null,
    machinesExclMachinist: breakdown ? round2(line.machineCost - line.machinistSalaryCost) : null,
    machinistPay: breakdown ? line.machinistSalaryCost : null,
    materials: breakdown ? line.materialCost : null,
    direct: line.directCost,
    overheadAmount: line.overheadCost,
    overheadPercent: line.overheadPercent,
    overheadRef: line.overheadRef,
    profitAmount: line.profitCost,
    profitPercent: line.profitPercent,
    profitRef: line.profitRef,
    residual,
    total: round2(lineTotal(line) + (residual ?? 0)),
    volume: { quantity: line.quantity, unit: line.normUnit, billQuantity: line.billQuantity, billUnit: line.billUnit },
    flags: {
      priceSource: line.priceSource ?? null,
      customerPrice: line.priceSource === "CUSTOMER_PRICE",
      residualHidden: rest !== null,
      deduction: line.deduction === true,
      gapKinds: [...new Set(line.gaps.map((gap) => gap.kind))],
      coefficients: summarizeCoefficients(line),
    },
  };
}

/* ------------------------------ ЭМ и ОТм ------------------------------ */

/**
 * Обе трактовки графы «ЭМ» заказчика. Нужны таблица ресурсов заказчика (`direct`) и наша строка по норме:
 * иначе сравнивать нечего — null.
 */
export function machinesView(customer: BenchmarkCustomer, ours: BenchmarkOurs): MachinesView | null {
  if (customer.direct === null) return null;
  if (ours.machinesInclMachinist === null || ours.machinesExclMachinist === null || ours.machinistPay === null) return null;

  const labour = orZero(customer.labour);
  const em = orZero(customer.machines);
  const otm = orZero(customer.machinistLabour);
  const materials = orZero(customer.materials);

  // Что говорит сама смета заказчика: прямые затраты — это ОТ + ЭМ + М или ОТ + ЭМ + ОТм + М.
  let declared: MachinistDeclared;
  if (Math.abs(otm) < 0.005) {
    declared = "NOT_APPLICABLE";
  } else {
    const includes = Math.abs(customer.direct - (labour + em + materials)) <= ARITHMETIC_TOLERANCE_RUB;
    const excludes = Math.abs(customer.direct - (labour + em + otm + materials)) <= ARITHMETIC_TOLERANCE_RUB;
    declared = includes && !excludes ? "INCLUDES_OTM" : excludes && !includes ? "EXCLUDES_OTM" : "UNDETERMINED";
  }

  // С какой нашей цифрой сошёлся ЭМ заказчика — так, как это делал разбор на закупке 001118.
  const tolerance = Math.max(MACHINES_TOLERANCE_RUB, MACHINES_TOLERANCE_RATIO * Math.abs(em));
  const matchesIncluding = Math.abs(em - ours.machinesInclMachinist) <= tolerance;
  const matchesExcluding = Math.abs(em - ours.machinesExclMachinist) <= tolerance;
  let matched: MachinistMatch;
  if (Math.abs(otm) < 0.005 && Math.abs(ours.machinistPay) < 0.005) matched = "NOT_APPLICABLE";
  else if (matchesIncluding && matchesExcluding) matched = "BOTH";
  else if (matchesIncluding) matched = "INCLUDES_OTM";
  else if (matchesExcluding) matched = "EXCLUDES_OTM";
  else matched = "NONE";

  let used: MachinistBasis;
  let usedBy: MachinistUsedBy;
  if (declared === "INCLUDES_OTM" || declared === "EXCLUDES_OTM") {
    used = declared;
    usedBy = "ARITHMETIC";
  } else if (matched === "INCLUDES_OTM" || matched === "EXCLUDES_OTM") {
    used = matched;
    usedBy = "MATCH";
  } else {
    used = "INCLUDES_OTM";
    usedBy = "DEFAULT";
  }

  // ЭМ заказчика без ОТм (по его арифметике) совпал с нашим machineCost целиком: оплаты машинистов в нём нет.
  const oursIncludesPay = !(used === "EXCLUDES_OTM" && matched === "INCLUDES_OTM");

  return {
    declared,
    matched,
    used,
    usedBy,
    customerMachinesExclMachinist: round2(used === "INCLUDES_OTM" ? em - otm : em),
    customerMachinist: round2(otm),
    oursIncludesPay,
    oursMachinesExclMachinist: round2(oursIncludesPay ? ours.machinesExclMachinist : ours.machinesInclMachinist),
    oursMachinist: round2(oursIncludesPay ? ours.machinistPay : 0),
    includesOtm: { customer: round2(em), ours: round2(ours.machinesInclMachinist), delta: round2(ours.machinesInclMachinist - em) },
    excludesOtm: { customer: round2(em), ours: round2(ours.machinesExclMachinist), delta: round2(ours.machinesExclMachinist - em) },
  };
}

/* ------------------------------ НР и СП ------------------------------ */

function rateComparison(
  customerPercent: number | null,
  customerBase: number | null,
  customerRef: string | null,
  customerAmount: number | null,
  ourPercent: number,
  ourBase: number,
  ourRef: string | null,
  ourAmount: number,
  comparable: boolean,
): RateComparison | null {
  if (!comparable) return null;
  return {
    customerPercent,
    ourPercent,
    customerBasePercent: customerBase,
    ourBasePercent: ourBase,
    customerRef,
    ourRef,
    // Заказчик начисления не напечатал — у него 0 %: у нас ненулевой процент это расхождение.
    mismatch: Math.abs(orZero(customerPercent) - ourPercent) > PERCENT_TOLERANCE,
    amountDelta: round2(ourAmount - orZero(customerAmount)),
  };
}

/* ------------------------------ Разница ------------------------------ */

function deltaOf(customer: BenchmarkCustomer, ours: BenchmarkOurs, machines: MachinesView | null): BenchmarkDelta | null {
  if (customer.total === null) {
    // Итога заказчика нет: рубли разницы не определены, позиция выпадает из корзин.
    return null;
  }
  const total = round2(ours.total - customer.total);
  if (customer.direct === null || machines === null || ours.labour === null || ours.materials === null) {
    return {
      total,
      totalPercent: percentOf(total, customer.total),
      direct: customer.direct === null ? null : round2(ours.direct - customer.direct),
      labour: null,
      machines: null,
      machinist: null,
      materials: null,
      overhead: null,
      profit: null,
      other: total,
      componentsComparable: false,
    };
  }
  const labour = round2(ours.labour - orZero(customer.labour));
  const machinesDelta = round2(machines.oursMachinesExclMachinist - machines.customerMachinesExclMachinist);
  const machinist = round2(machines.oursMachinist - machines.customerMachinist);
  const materials = round2(ours.materials - orZero(customer.materials));
  const overhead = round2(ours.overheadAmount - orZero(customer.overheadAmount));
  const profit = round2(ours.profitAmount - orZero(customer.profitAmount));
  const explained = labour + machinesDelta + machinist + materials + overhead + profit;
  return {
    total,
    totalPercent: percentOf(total, customer.total),
    direct: round2(ours.direct - orZero(customer.direct)),
    labour,
    machines: machinesDelta,
    machinist,
    materials,
    overhead,
    profit,
    other: round2(total - explained),
    componentsComparable: true,
  };
}

/* ------------------------------ Сопоставление ------------------------------ */

interface Pairing {
  readonly position: CustomerPosition;
  readonly itemId: string | null;
  readonly restId: string | null;
  readonly skipReason: { reason: string; message: string } | null;
}

/**
 * Позиции сметы и строки её ведомости: по порядку и метке (см. шапку файла). Позиция, которой в ведомости нет,
 * получает причину из `lsrBillSection`.
 */
function pairPositions(entry: LsrEntry, ordinal: number): Pairing[] {
  const bill = lsrBillSection(entry, ordinal);
  const items = bill.section.items;
  const main = items.filter((item) => item.unaccountedOf === undefined);
  const restOf = new Map<string, string>();
  for (const item of items) if (item.unaccountedOf !== undefined) restOf.set(item.unaccountedOf, item.id);
  const skippedBy = new Map(bill.skipped.map((skipped) => [skipped.label, skipped] as const));

  const pairs: Pairing[] = [];
  let cursor = 0;
  for (const position of documentOrder(entry)) {
    const label = position.label ?? String(position.number);
    const item = main[cursor];
    if (item !== undefined && item.positionNumber === label) {
      cursor += 1;
      pairs.push({ position, itemId: item.id, restId: restOf.get(item.id) ?? null, skipReason: null });
      continue;
    }
    const skipped = skippedBy.get(label);
    pairs.push({
      position,
      itemId: null,
      restId: null,
      skipReason: { reason: skipped?.reason ?? "NOT_IN_BILL", message: skipped?.message ?? "позиция не попала в ведомость" },
    });
  }
  return pairs;
}

function customerRowBase(entry: LsrEntry, index: number, position: CustomerPosition): Pick<
  BenchmarkRow,
  "lsrIndex" | "lsrKey" | "lsrNumber" | "label" | "subPosition" | "code" | "name" | "unit" | "quantity"
> {
  return {
    lsrIndex: index,
    lsrKey: entry.key,
    lsrNumber: entry.number,
    label: position.label ?? String(position.number),
    subPosition: position.sub === true,
    code: position.code !== "" ? position.code : firstLine(position.rawJustification),
    name: truncateName(position.name),
    unit: position.unit,
    quantity: position.quantity,
  };
}

/** Индекс сметы по идентификатору строки `l<n>-…`; null — строка не из ЛСР. */
function lsrIndexOfItem(itemId: string): number | null {
  const match = /^l(\d+)-/.exec(itemId);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

/**
 * Сравнение нашей сметы со сметами заказчика: строки по позициям, итоги по сметам и сводка по закупке.
 *
 * `lsrSet` должен быть тем же набором, из которого построена ведомость расчёта (`buildLsrSet(parseCustomerLsr(documents).estimates)`),
 * иначе идентификаторы строк не сойдутся.
 */
export function compareTender(input: { readonly lsrSet: LsrSet; readonly document: EstimateDocument }, options: CompareOptions = {}): TenderComparison {
  const lines = new Map<string, EstimateLine>();
  for (const section of input.document.sections) for (const line of section.lines) lines.set(line.itemId, line);
  const claimed = new Set<string>();

  const rows: BenchmarkRow[] = [];
  const lsrs: LsrComparison[] = [];

  for (const [index, entry] of input.lsrSet.entries.entries()) {
    const ordinal = index + 1;
    const first = rows.length;
    let positionsTotal: number | null = null;

    for (const pair of pairPositions(entry, ordinal)) {
      const position = pair.position;
      const customer = customerSide(position);
      if (customer.total !== null) positionsTotal = round2((positionsTotal ?? 0) + customer.total);
      const base = customerRowBase(entry, ordinal, position);

      const line = pair.itemId === null ? undefined : lines.get(pair.itemId);
      if (line === undefined) {
        rows.push({
          ...base,
          customer,
          ours: null,
          machines: null,
          overheadRate: null,
          profitRate: null,
          delta:
            customer.total === null
              ? null
              : { total: round2(-customer.total), totalPercent: customer.total === 0 ? 0 : -100, direct: null, labour: null, machines: null, machinist: null, materials: null, overhead: null, profit: null, other: round2(-customer.total), componentsComparable: false },
          bucket: "ONLY_CUSTOMER",
          skipped: pair.skipReason,
        });
        continue;
      }

      claimed.add(line.itemId);
      const restLine = pair.restId === null ? null : (lines.get(pair.restId) ?? null);
      if (restLine !== null) claimed.add(restLine.itemId);
      const ours = ourSide(line, restLine);
      const machines = machinesView(customer, ours);
      const delta = deltaOf(customer, ours, machines);
      const rated = customer.direct !== null && line.priceSource === undefined;
      rows.push({
        ...base,
        customer,
        ours,
        machines,
        overheadRate: rateComparison(
          customer.overheadPercent,
          customer.overheadBasePercent,
          customer.overheadRef,
          customer.overheadAmount,
          line.overheadPercent,
          line.rateMultipliers?.baseOverheadPercent ?? line.overheadPercent,
          line.overheadRef,
          line.overheadCost,
          rated,
        ),
        profitRate: rateComparison(
          customer.profitPercent,
          customer.profitBasePercent,
          customer.profitRef,
          customer.profitAmount,
          line.profitPercent,
          line.rateMultipliers?.baseProfitPercent ?? line.profitPercent,
          line.profitRef,
          line.profitCost,
          rated,
        ),
        delta,
        bucket: delta === null || customer.total === null ? "NO_TOTAL" : bucketOfDelta(delta.total, customer.total),
        skipped: null,
      });
    }

    // Наши строки этой сметы, которым не нашлось позиции (побочные строки расчёта).
    for (const [itemId, line] of lines) {
      if (claimed.has(itemId) || lsrIndexOfItem(itemId) !== ordinal) continue;
      claimed.add(itemId);
      rows.push(oursOnlyRow(line, ordinal, entry));
    }

    const mine = rows.slice(first);
    lsrs.push(lsrComparison(entry, ordinal, mine, positionsTotal));
  }

  // Строки не из ЛСР (ведомость модели, если она перебила смету): сравнивать их не с чем.
  for (const [itemId, line] of lines) {
    if (claimed.has(itemId)) continue;
    rows.push(oursOnlyRow(line, null, null));
  }

  const aggregate = aggregateRows(rows, lsrs, input.document, options.topN ?? DEFAULT_TOP);
  return { lsrs, rows, aggregate };
}

function oursOnlyRow(line: EstimateLine, ordinal: number | null, entry: LsrEntry | null): BenchmarkRow {
  const ours = ourSide(line, null);
  return {
    lsrIndex: ordinal,
    lsrKey: entry?.key ?? null,
    lsrNumber: entry?.number ?? null,
    label: line.itemId,
    subPosition: false,
    code: line.normCode,
    name: truncateName(line.normName),
    unit: line.billUnit,
    quantity: line.billQuantity,
    customer: null,
    ours,
    machines: null,
    overheadRate: null,
    profitRate: null,
    delta: { total: ours.total, totalPercent: null, direct: null, labour: null, machines: null, machinist: null, materials: null, overhead: null, profit: null, other: ours.total, componentsComparable: false },
    bucket: "ONLY_OURS",
    skipped: null,
  };
}

function lsrComparison(entry: LsrEntry, index: number, rows: readonly BenchmarkRow[], positionsTotal: number | null): LsrComparison {
  const oursTotal = round2(rows.reduce((sum, row) => sum + (row.ours?.total ?? 0), 0));
  const customerTotal = entry.totalExVat;
  const deltaVsTotal = customerTotal === null ? null : round2(oursTotal - customerTotal);
  const deltaVsPositions = positionsTotal === null ? null : round2(oursTotal - positionsTotal);
  return {
    index,
    key: entry.key,
    number: entry.number,
    title: entry.title,
    documentName: entry.documentName,
    customerTotalExVat: customerTotal,
    customerPositionsTotal: positionsTotal,
    oursTotal,
    deltaVsTotal,
    deltaPercentVsTotal: deltaVsTotal === null ? null : percentOf(deltaVsTotal, customerTotal),
    deltaVsPositions,
    deltaPercentVsPositions: deltaVsPositions === null ? null : percentOf(deltaVsPositions, positionsTotal),
    positions: rows.filter((row) => row.customer !== null).length,
    matched: rows.filter((row) => row.customer !== null && row.ours !== null).length,
    onlyCustomer: rows.filter((row) => row.bucket === "ONLY_CUSTOMER").length,
    onlyOurs: rows.filter((row) => row.bucket === "ONLY_OURS").length,
  };
}

/* ------------------------------ Сводки ------------------------------ */

const ZERO_ATTRIBUTION: Attribution = { total: 0, labour: 0, machines: 0, machinist: 0, materials: 0, overhead: 0, profit: 0, other: 0, unmatched: 0 };

/** Разница в рублях по составляющим. Неразложимая позиция целиком уходит в «other», односторонняя — в «unmatched». */
export function attributeRows(rows: readonly BenchmarkRow[]): Attribution {
  const sum = { ...ZERO_ATTRIBUTION } as { -readonly [K in keyof Attribution]: number };
  for (const row of rows) {
    const delta = row.delta;
    if (delta === null) continue;
    sum.total += delta.total;
    if (row.bucket === "ONLY_CUSTOMER" || row.bucket === "ONLY_OURS") {
      sum.unmatched += delta.total;
      continue;
    }
    sum.labour += orZero(delta.labour);
    sum.machines += orZero(delta.machines);
    sum.machinist += orZero(delta.machinist);
    sum.materials += orZero(delta.materials);
    sum.overhead += orZero(delta.overhead);
    sum.profit += orZero(delta.profit);
    sum.other += delta.other;
  }
  return {
    total: round2(sum.total),
    labour: round2(sum.labour),
    machines: round2(sum.machines),
    machinist: round2(sum.machinist),
    materials: round2(sum.materials),
    overhead: round2(sum.overhead),
    profit: round2(sum.profit),
    other: round2(sum.other),
    unmatched: round2(sum.unmatched),
  };
}

export function bucketRows(rows: readonly BenchmarkRow[]): Record<DeltaBucket, BucketStat> {
  const buckets = emptyBuckets();
  for (const row of rows) {
    const stat = buckets[row.bucket];
    stat.count += 1;
    stat.absDelta = round2(stat.absDelta + Math.abs(row.delta?.total ?? 0));
  }
  return buckets;
}

export function summarizeMachinist(rows: readonly BenchmarkRow[]): MachinistSummary {
  const declaredKeys: MachinistDeclared[] = ["INCLUDES_OTM", "EXCLUDES_OTM", "NOT_APPLICABLE", "UNDETERMINED"];
  const matchedKeys: MachinistMatch[] = ["INCLUDES_OTM", "EXCLUDES_OTM", "BOTH", "NONE", "NOT_APPLICABLE"];
  const declared: Record<MachinistDeclared, number> = { INCLUDES_OTM: 0, EXCLUDES_OTM: 0, NOT_APPLICABLE: 0, UNDETERMINED: 0 };
  const matched: Record<MachinistMatch, number> = { INCLUDES_OTM: 0, EXCLUDES_OTM: 0, BOTH: 0, NONE: 0, NOT_APPLICABLE: 0 };
  const usedBy: Record<MachinistUsedBy, number> = { ARITHMETIC: 0, MATCH: 0, DEFAULT: 0 };
  const crossTab = Object.fromEntries(declaredKeys.map((key) => [key, Object.fromEntries(matchedKeys.map((inner) => [inner, 0]))])) as Record<MachinistDeclared, Record<MachinistMatch, number>>;
  let withoutPay = 0;
  let withoutPayRubles = 0;
  for (const row of rows) {
    const view = row.machines;
    if (view === null) continue;
    declared[view.declared] += 1;
    matched[view.matched] += 1;
    usedBy[view.usedBy] += 1;
    crossTab[view.declared][view.matched] += 1;
    if (!view.oursIncludesPay) {
      withoutPay += 1;
      withoutPayRubles += view.customerMachinist;
    }
  }
  return { declared, matched, usedBy, crossTab, oursWithoutPay: { positions: withoutPay, customerMachinist: round2(withoutPayRubles) } };
}

/** Позиции с расходящимся НР или СП, сгруппированные по «шифр — вид — процент заказчика — наш процент». */
export function summarizeRateMismatches(rows: readonly BenchmarkRow[]): RateMismatchSummary {
  const groups = new Map<string, { -readonly [K in keyof RateMismatchGroup]: RateMismatchGroup[K] }>();
  let overheadPositions = 0;
  let profitPositions = 0;
  let eitherPositions = 0;
  for (const row of rows) {
    const overhead = row.overheadRate?.mismatch === true;
    const profit = row.profitRate?.mismatch === true;
    if (overhead) overheadPositions += 1;
    if (profit) profitPositions += 1;
    if (overhead || profit) eitherPositions += 1;
    for (const [kind, rate] of [
      ["overhead", row.overheadRate],
      ["profit", row.profitRate],
    ] as const) {
      if (rate === null || !rate.mismatch) continue;
      const key = `${row.code}|${kind}|${String(rate.customerPercent)}|${String(rate.ourPercent)}`;
      const group = groups.get(key) ?? { code: row.code, kind, customerPercent: rate.customerPercent, ourPercent: rate.ourPercent, positions: 0, amountDelta: 0 };
      group.positions += 1;
      group.amountDelta = round2(group.amountDelta + rate.amountDelta);
      groups.set(key, group);
    }
  }
  return {
    overheadPositions,
    profitPositions,
    eitherPositions,
    groups: [...groups.values()].sort((a, b) => b.positions - a.positions || Math.abs(b.amountDelta) - Math.abs(a.amountDelta) || a.code.localeCompare(b.code)),
  };
}

/** Позиции с наибольшей |Δ| итога в рублях. */
export function topByDelta<T extends BenchmarkRow>(rows: readonly T[], count: number): T[] {
  return rows
    .filter((row) => row.delta !== null)
    .sort((a, b) => Math.abs(b.delta?.total ?? 0) - Math.abs(a.delta?.total ?? 0))
    .slice(0, Math.max(0, count));
}

function countPositions(rows: readonly BenchmarkRow[]): PositionCounts {
  return {
    customer: rows.filter((row) => row.customer !== null).length,
    matched: rows.filter((row) => row.customer !== null && row.ours !== null).length,
    onlyCustomer: rows.filter((row) => row.bucket === "ONLY_CUSTOMER").length,
    onlyOurs: rows.filter((row) => row.bucket === "ONLY_OURS").length,
    skipped: rows.filter((row) => row.skipped !== null).length,
    priced: rows.filter((row) => row.ours !== null && row.ours.flags.priceSource !== null).length,
  };
}

function documentTotals(document: EstimateDocument): DocumentTotalsView {
  const t = document.totals;
  return { workCost: t.workCost, beforeVat: t.beforeVat, vat: t.vat, total: t.total };
}

function aggregateRows(rows: readonly BenchmarkRow[], lsrs: readonly LsrComparison[], document: EstimateDocument, topN: number): TenderAggregate {
  const withTotal = lsrs.filter((lsr) => lsr.customerTotalExVat !== null);
  const customerTotal = withTotal.length === 0 ? null : round2(withTotal.reduce((sum, lsr) => sum + (lsr.customerTotalExVat ?? 0), 0));
  const customerPositions = round2(lsrs.reduce((sum, lsr) => sum + orZero(lsr.customerPositionsTotal), 0));
  const oursRows = round2(rows.reduce((sum, row) => sum + (row.ours?.total ?? 0), 0));
  const totals = documentTotals(document);
  return {
    customerTotalExVat: customerTotal,
    customerTotalIncomplete: withTotal.length !== lsrs.length,
    customerPositionsTotal: customerPositions,
    document: totals,
    oursRowsTotal: oursRows,
    deltaPercent: customerTotal === null ? null : percentOf(totals.beforeVat - customerTotal, customerTotal),
    rowsDeltaPercent: customerPositions === 0 ? null : percentOf(oursRows - customerPositions, customerPositions),
    counts: countPositions(rows),
    buckets: bucketRows(rows),
    attribution: attributeRows(rows),
    machinist: summarizeMachinist(rows),
    rateMismatches: summarizeRateMismatches(rows),
    top: topByDelta(rows, topN),
  };
}

/* ------------------------------ По многим закупкам ------------------------------ */

/** Позиция сводки по многим закупкам: строка и закупка, из которой она взята. */
export interface TenderRow extends BenchmarkRow {
  readonly tenderId: string;
}

export interface CrossAggregate {
  readonly tenders: number;
  readonly lsrs: number;
  readonly customerTotalExVat: number | null;
  /** Не у всех смет (или закупок) итог найден: сумма неполная. */
  readonly customerTotalIncomplete: boolean;
  readonly customerPositionsTotal: number;
  readonly documentBeforeVat: number;
  readonly oursRowsTotal: number;
  readonly deltaPercent: number | null;
  readonly rowsDeltaPercent: number | null;
  readonly counts: PositionCounts;
  readonly buckets: Readonly<Record<DeltaBucket, BucketStat>>;
  readonly attribution: Attribution;
  readonly machinist: MachinistSummary;
  readonly rateMismatches: RateMismatchSummary;
  readonly top: readonly TenderRow[];
}

/** Сводка по результатам многих закупок: те же величины, что у одной закупки, но по всем позициям сразу. */
export function aggregateTenders(
  items: readonly { readonly tenderId: string; readonly comparison: TenderComparison }[],
  options: CompareOptions = {},
): CrossAggregate {
  const rows: TenderRow[] = items.flatMap(({ tenderId, comparison }) => comparison.rows.map((row) => ({ ...row, tenderId })));
  const aggregates = items.map(({ comparison }) => comparison.aggregate);
  const lsrs = items.flatMap(({ comparison }) => comparison.lsrs);

  const withTotal = aggregates.filter((aggregate) => aggregate.customerTotalExVat !== null);
  const customerTotal = withTotal.length === 0 ? null : round2(withTotal.reduce((sum, aggregate) => sum + (aggregate.customerTotalExVat ?? 0), 0));
  const documentBeforeVat = round2(aggregates.reduce((sum, aggregate) => sum + aggregate.document.beforeVat, 0));
  const customerPositions = round2(aggregates.reduce((sum, aggregate) => sum + aggregate.customerPositionsTotal, 0));
  const oursRows = round2(aggregates.reduce((sum, aggregate) => sum + aggregate.oursRowsTotal, 0));
  // Общая |Δ%| считается только по закупкам, у которых итог заказчика известен, — иначе наш итог без пары искажал бы процент.
  const oursComparable = round2(withTotal.reduce((sum, aggregate) => sum + aggregate.document.beforeVat, 0));

  return {
    tenders: items.length,
    lsrs: lsrs.length,
    customerTotalExVat: customerTotal,
    customerTotalIncomplete: aggregates.some((aggregate) => aggregate.customerTotalIncomplete) || withTotal.length !== aggregates.length,
    customerPositionsTotal: customerPositions,
    documentBeforeVat,
    oursRowsTotal: oursRows,
    deltaPercent: customerTotal === null ? null : percentOf(oursComparable - customerTotal, customerTotal),
    rowsDeltaPercent: customerPositions === 0 ? null : percentOf(oursRows - customerPositions, customerPositions),
    counts: countPositions(rows),
    buckets: bucketRows(rows),
    attribution: attributeRows(rows),
    machinist: summarizeMachinist(rows),
    rateMismatches: summarizeRateMismatches(rows),
    top: topByDelta(rows, options.topN ?? DEFAULT_TOP),
  };
}
