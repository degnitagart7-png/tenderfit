import { annualDeflator, deflatorYears, forecastLetterLabel } from "@/domain/estimate/ssrNormatives";

/**
 * Индекс прогнозной инфляции на период работ (приказ Минстроя России от 23.12.2019 N 841/пр).
 *
 * Что сказано в приказе:
 * - индексы-дефляторы Минэкономразвития по строке «Инвестиции в основной капитал (капитальные
 *   вложения)» пересчитывают сметную стоимость из уровня цен на дату определения НМЦК в уровень цен
 *   периода работ (п. 8, подп. «б»);
 * - показатели по главам сводного сметного расчёта в текущем уровне цен умножаются на индекс
 *   прогнозной инфляции; индекс — среднее арифметическое индексов на даты начала и окончания работ
 *   (п. 22, подп. «б»);
 * - работы, переходящие на второй и последующие годы: К = Д1 × К1 + Д2 × К2 + … + Дi × Кi, где Д — доля
 *   стоимости работ в году, К1 — среднее индексов на дату начала и на декабрь первого года, К2 —
 *   (индекс на декабрь первого года) × среднее индексов на январь и декабрь второго года, последний год —
 *   (индекс на декабрь предыдущего года) × среднее индексов на январь и на дату окончания (п. 23, формула 2).
 *
 * Чего в приказе нет: как из годового дефлятора получить индекс «на дату». Здесь принято и названо в
 * допущениях результата:
 * 1. Годовой дефлятор (% г/г) распределяется по месяцам геометрически: за месяц — корень 12-й степени.
 * 2. Индекс на дату — уровень цен на КОНЕЦ её месяца относительно конца месяца определения НМЦК
 *    (месяц НМЦК — основа; индекс на этот месяц равен 1). Если дата НМЦК неизвестна, основой служит
 *    месяц начала работ.
 * 3. Доли Д по годам без календарного плана — по числу месяцев работ в каждом году.
 * 4. Индекс округляется до четырёх знаков, как его печатают заказчики («И = 1,0045»).
 *
 * Без сроков индекс не применяется (равен 1) — с причиной в `reason`. Года, которых нет в письме
 * Минэкономразвития (после 2029), индекс не считается, а не продолжается предыдущим значением.
 */

export type SsrPeriodInput =
  /** «Работы с … по …»: ISO-даты. */
  | { readonly kind: "DATES"; readonly start: string; readonly end: string }
  /** «С даты контракта по …» (в ТЗ: «с момента заключения контракта по 30.11.2026»): начало — месяц контракта, иначе месяц НМЦК. */
  | { readonly kind: "UNTIL"; readonly end: string; readonly contractDate?: string | null }
  /** «В течение N месяцев с даты контракта»; дата контракта неизвестна — отсчёт от месяца НМЦК. */
  | { readonly kind: "MONTHS"; readonly months: number; readonly contractDate?: string | null };

export interface InflationYearPart {
  readonly year: number;
  /** Сколько месяцев работ приходится на год. */
  readonly months: number;
  /** Доля стоимости работ в году (Д). */
  readonly share: number;
  /** Индекс на начало отсчёта года (дата начала или январь) относительно основы. */
  readonly fromLevel: number;
  /** Индекс на конец отсчёта года (декабрь или дата окончания) относительно основы. */
  readonly toLevel: number;
  /** Среднее индексов года (К1, К2, …). */
  readonly average: number;
}

export interface InflationResult {
  readonly applied: boolean;
  /** Индекс для умножения: 1, если не применён. Округлён до 4 знаков. */
  readonly index: number;
  /** Индекс до округления; null, если не посчитан. */
  readonly rawIndex: number | null;
  /** Почему не применён. */
  readonly reason: string | null;
  /** Месяц, в котором начинаются и заканчиваются работы («2026-10»). */
  readonly startMonth: string | null;
  readonly endMonth: string | null;
  /** Месяц определения НМЦК, от которого отсчитан индекс. */
  readonly baseMonth: string | null;
  /** Дата НМЦК неизвестна: основой принят месяц начала работ. */
  readonly baseAssumed: boolean;
  readonly parts: readonly InflationYearPart[];
  /** Расчёт словами: «(1,0000 + 1,0095) / 2 = 1,0047». */
  readonly formula: string | null;
  /** Допущения, на которых стоит индекс. */
  readonly assumptions: readonly string[];
  /** Источник индексов. */
  readonly source: string;
}

export interface InflationInput {
  readonly period: SsrPeriodInput | null;
  /** ISO-дата определения НМЦК (дата извещения); null — неизвестна. */
  readonly priceDate: string | null;
  /** ISO-дата «сегодня»: нужна только когда нет ни даты НМЦК, ни даты контракта при сроке в месяцах. */
  readonly today: string;
}

const MONTH_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?/u;

interface YearMonth {
  readonly year: number;
  readonly month: number;
}

function parseMonth(iso: string | null | undefined): YearMonth | null {
  if (iso === null || iso === undefined) return null;
  const match = MONTH_RE.exec(iso);
  if (match === null) return null;
  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return { year, month };
}

const toIndex = (value: YearMonth): number => value.year * 12 + (value.month - 1);
const fromIndex = (index: number): YearMonth => ({ year: Math.floor(index / 12), month: (index % 12) + 1 });
const label = (value: YearMonth): string => `${String(value.year)}-${String(value.month).padStart(2, "0")}`;

const MONTH_NAMES = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;
export function monthLabel(iso: string): string {
  const value = parseMonth(iso);
  return value === null ? iso : `${MONTH_NAMES[value.month - 1] as string} ${String(value.year)}`;
}

function format4(value: number): string {
  return value.toFixed(4).replace(".", ",");
}

export const INFLATION_SOURCE_LABEL = "841/пр, п. 8 (подп. «б»), 22 (подп. «б») и 23; дефляторы — «Инвестиции в основной капитал»";

function source(): string {
  return `${INFLATION_SOURCE_LABEL}; ${forecastLetterLabel()}`;
}

function notApplied(reason: string, extra: Partial<InflationResult> = {}): InflationResult {
  return {
    applied: false,
    index: 1,
    rawIndex: null,
    reason,
    startMonth: null,
    endMonth: null,
    baseMonth: null,
    baseAssumed: false,
    parts: [],
    formula: null,
    assumptions: [],
    source: source(),
    ...extra,
  };
}

/** Индекс прогнозной инфляции на период работ; без сроков — не применяется. */
export function computeForecastInflation(input: InflationInput): InflationResult {
  const period = input.period;
  if (period === null) {
    return notApplied("сроки работ неизвестны: индекс прогнозной инфляции не применён (цена остаётся в текущем уровне цен)");
  }

  const priceMonth = parseMonth(input.priceDate);
  let start: YearMonth | null;
  let end: YearMonth | null;
  if (period.kind === "DATES") {
    start = parseMonth(period.start);
    end = parseMonth(period.end);
    if (start === null || end === null) return notApplied("не разобраны даты начала и окончания работ: индекс не применён");
  } else if (period.kind === "UNTIL") {
    end = parseMonth(period.end);
    start = parseMonth(period.contractDate ?? null) ?? priceMonth ?? parseMonth(input.today);
    if (end === null || start === null) return notApplied("не разобрана дата окончания работ: индекс не применён");
  } else {
    if (!Number.isFinite(period.months) || period.months < 1 || period.months > 120) {
      return notApplied("срок в месяцах указан неверно: индекс не применён");
    }
    const contract = parseMonth(period.contractDate ?? null);
    start = contract ?? priceMonth ?? parseMonth(input.today);
    if (start === null) return notApplied("не известны ни дата контракта, ни дата НМЦК: отсчитать срок в месяцах не от чего");
    end = fromIndex(toIndex(start) + Math.round(period.months) - 1);
  }
  if (toIndex(end) < toIndex(start)) return notApplied("окончание работ раньше начала: индекс не применён");

  const assumptions: string[] = [];
  if (period.kind === "UNTIL") {
    const hasContract = parseMonth(period.contractDate ?? null) !== null;
    assumptions.push(
      hasContract
        ? "начало работ — месяц контракта"
        : `срок «с даты контракта по ${monthLabel(period.end)}»: дата контракта неизвестна, начало работ принято в месяце ${priceMonth === null ? "сегодняшнего дня" : "определения НМЦК"}`,
    );
  }
  if (period.kind === "MONTHS") {
    const hasContract = parseMonth(period.contractDate ?? null) !== null;
    assumptions.push(
      hasContract
        ? `срок «в течение ${String(Math.round(period.months))} мес. с даты контракта»: отсчёт от месяца контракта`
        : `срок «в течение ${String(Math.round(period.months))} мес. с даты контракта»: дата контракта неизвестна, отсчёт от месяца ${priceMonth === null ? "сегодняшнего дня" : "определения НМЦК"}`,
    );
  }

  // Основа — месяц определения НМЦК; неизвестен — месяц начала работ.
  let base = priceMonth;
  let baseAssumed = false;
  if (base === null) {
    base = start;
    baseAssumed = true;
    assumptions.push("дата определения НМЦК неизвестна: уровень цен принят на конец месяца начала работ (индекс на этот месяц равен 1)");
  } else if (toIndex(start) < toIndex(base)) {
    assumptions.push(`работы начинаются раньше месяца НМЦК (${label(base)}): начало принято на месяц НМЦК`);
    start = base;
    if (toIndex(end) < toIndex(start)) end = start;
  }

  const baseIdx = toIndex(base);
  const years = deflatorYears();

  // Уровень цен на конец месяца относительно основы.
  const missing: number[] = [];
  const level = (monthIdx: number): number => {
    let value = 1;
    for (let k = baseIdx + 1; k <= monthIdx; k += 1) {
      const year = fromIndex(k).year;
      const annual = annualDeflator(year);
      if (annual === null) {
        if (!missing.includes(year)) missing.push(year);
        continue;
      }
      value *= annual ** (1 / 12);
    }
    return value;
  };

  const startIdx = toIndex(start);
  const endIdx = toIndex(end);
  const firstYear = start.year;
  const lastYear = end.year;

  const parts: InflationYearPart[] = [];
  const totalMonths = endIdx - startIdx + 1;
  for (let year = firstYear; year <= lastYear; year += 1) {
    const partStart = year === firstYear ? startIdx : toIndex({ year, month: 1 });
    const partEnd = year === lastYear ? endIdx : toIndex({ year, month: 12 });
    const fromLevel = level(partStart);
    const toLevel = level(partEnd);
    parts.push({
      year,
      months: partEnd - partStart + 1,
      share: (partEnd - partStart + 1) / totalMonths,
      fromLevel,
      toLevel,
      average: (fromLevel + toLevel) / 2,
    });
  }
  if (missing.length > 0) {
    const sorted = [...missing].sort((a, b) => a - b);
    return notApplied(
      `в письме Минэкономразвития нет дефлятора на ${sorted.join(", ")} г. (таблица до ${String(years.last)} г.): индекс не рассчитан, цена остаётся в текущем уровне цен`,
      { startMonth: label(start), endMonth: label(end), baseMonth: label(base), baseAssumed, assumptions },
    );
  }

  const raw = parts.reduce((sum, part) => sum + part.share * part.average, 0);
  const index = Number(raw.toFixed(4));

  assumptions.push(
    "годовой дефлятор (% г/г) распределён по месяцам геометрически; индекс на дату — уровень цен на конец её месяца относительно конца месяца НМЦК",
  );
  if (parts.length > 1) {
    assumptions.push("доли стоимости работ по годам приняты пропорционально числу месяцев работ: календарного плана нет");
  }

  const formula =
    parts.length === 1
      ? `(${format4((parts[0] as InflationYearPart).fromLevel)} + ${format4((parts[0] as InflationYearPart).toLevel)}) / 2 = ${format4(index)}`
      : `${parts
          .map((part) => `${format4(part.share)} × (${format4(part.fromLevel)} + ${format4(part.toLevel)}) / 2`)
          .join(" + ")} = ${format4(index)}`;

  return {
    applied: true,
    index,
    rawIndex: raw,
    reason: null,
    startMonth: label(start),
    endMonth: label(end),
    baseMonth: label(base),
    baseAssumed,
    parts,
    formula,
    assumptions,
    source: source(),
  };
}

/** Словесное описание срока: «октябрь 2026 — ноябрь 2026». */
export function periodText(result: InflationResult): string | null {
  if (result.startMonth === null || result.endMonth === null) return null;
  return result.startMonth === result.endMonth
    ? monthLabel(result.startMonth)
    : `${monthLabel(result.startMonth)} — ${monthLabel(result.endMonth)}`;
}
