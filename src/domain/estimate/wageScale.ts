import { rankFromWageCode, roundTo } from "@/domain/estimate/resourceKinds";
import type {
  ResolvedWage,
  WageAnchor,
  WageOrigin,
  WageScale,
} from "@/domain/estimate/types";

/**
 * Тарифная шкала оплаты труда ценовой зоны.
 *
 * Зачем она нужна. Открытый реестр ставок рабочих (`RimWorkerSalaryRegistry`)
 * по Амурской области, 1 зона, 3 квартал 2026 содержит 186 записей, но всего
 * 25 кодов — разряды от 1,0 до 3,4. Нормы ГЭСН при этом требуют 3,8; 4,2; 5,0
 * и выше. Взять ставку неоткуда, а обнулить оплату труда значит занизить смету
 * на десятки процентов без единой пометки.
 *
 * Недостающие разряды находятся во втором открытом источнике той же зоны за тот
 * же квартал: колонка «Оплата труда машинистов» выгрузки ФСЦСР, делённая на
 * «Трудозатраты машинистов». Так получаются разряды 2; 3; 4; 5; 6; 6,5; 7; 8;
 * 8,7; 9. Пересечение с реестром сходится до копейки — разряд 2,0 даёт 598,26 ₽
 * в обоих источниках, разряд 3,0 — 653,14 ₽.
 *
 * Модель подтверждена всеми 33 опорными точками без исключений. Ставка равна
 * «ставка 1-го разряда × тарифный коэффициент». Целые разряды дают
 * коэффициенты 1,000; 1,090; 1,190; 1,340; 1,540; 1,800; 1,920; 2,050; 2,190,
 * а дробные лежат строго на прямой между целыми: 6,5 → 1,860, 8,7 → 2,148,
 * 3,4 → 1,250.
 *
 * Отсюда решение, без которого точность теряется: коэффициент берётся не
 * «как получилось при делении», а округляется до четырёх знаков. Тогда все 33
 * наблюдаемые ставки воспроизводятся до копейки — и 686,08 ₽ реестра за разряд
 * 3,4, и 1 020,88 ₽ машинистов за 6,5, и 1 178,95 ₽ за 8,7. Без округления
 * деление 653,14 / 548,86 даёт 1,19000036, и интерполяция разряда 3,4
 * промахивается на копейку. Мелочь, но именно из таких копеек складывается
 * расхождение сметы с проверочным расчётом сметчика.
 *
 * Модуль чистый: шкала собирается из готовых опорных точек, время и сеть в него
 * не входят.
 */

/** Допуск сравнения разрядов: шкала оперирует десятыми, но коды дают их же. */
const RANK_EPSILON = 1e-6;

/**
 * Знаков после запятой в тарифном коэффициенте. Четырёх хватает с запасом:
 * самый дробный из наблюдаемых — 2,148 для разряда 8,7.
 */
const COEFFICIENT_DIGITS = 4;

/**
 * Собирает шкалу из опорных точек. Точки с одним разрядом схлопываются: если
 * источники дали разные ставки, берётся наибольшая, чтобы не занизить оплату.
 */
export function buildWageScale(
  anchors: readonly WageAnchor[],
  meta: { readonly region: string; readonly zone: string; readonly period: string },
): WageScale {
  const byRank = new Map<number, WageAnchor>();
  for (const anchor of anchors) {
    if (!Number.isFinite(anchor.rank) || !Number.isFinite(anchor.salary)) continue;
    if (anchor.salary <= 0) continue;
    const rank = roundTo(anchor.rank, 2);
    const existing = byRank.get(rank);
    if (existing === undefined || existing.salary < anchor.salary) {
      byRank.set(rank, { rank, salary: roundTo(anchor.salary, 2), source: anchor.source });
    }
  }

  const sorted = [...byRank.values()].sort((a, b) => a.rank - b.rank);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  return {
    region: meta.region,
    zone: meta.zone,
    period: meta.period,
    anchors: sorted,
    baseSalary: first?.salary ?? 0,
    minRank: first?.rank ?? 0,
    maxRank: last?.rank ?? 0,
  };
}

/**
 * Ставка для кода оплаты труда. Возвращает null, если код не про труд или
 * шкала пуста: вызывающий код обязан показать это как пробел, а не как ноль.
 */
export function resolveWage(scale: WageScale, code: string): ResolvedWage | null {
  const rank = rankFromWageCode(code);
  if (rank === null) return null;
  return resolveWageByRank(scale, code.trim(), rank);
}

/** То же, но разряд уже известен — нужен для сверки шкалы с выгрузкой. */
export function resolveWageByRank(
  scale: WageScale,
  code: string,
  rank: number,
): ResolvedWage | null {
  if (scale.anchors.length === 0 || scale.baseSalary <= 0) return null;

  const exact = findAnchor(scale, rank);
  if (exact !== null) {
    return { code, rank, salary: exact.salary, origin: "ANCHOR" };
  }

  const bounds = bracket(scale, rank);
  if (bounds === null) {
    return {
      code,
      rank,
      salary: extrapolate(scale, rank),
      origin: "EXTRAPOLATED",
    };
  }

  return {
    code,
    rank,
    salary: interpolate(scale, bounds.lower, bounds.upper, rank),
    origin: "INTERPOLATED",
  };
}

/**
 * Описание покрытия шкалы одной фразой — то, что видит пользователь рядом с
 * пометкой о приближении.
 */
export function describeWageScale(scale: WageScale): string {
  if (scale.anchors.length === 0) {
    return "Тарифная шкала не загружена: ставки оплаты труда взять неоткуда";
  }
  return (
    `Тарифная шкала «${scale.zone}» за «${scale.period}»: ` +
    `разряды от ${formatRank(scale.minRank)} до ${formatRank(scale.maxRank)}, ` +
    `опорных точек ${String(scale.anchors.length)}, ` +
    `ставка 1-го разряда ${formatSalary(scale.baseSalary)} ₽/чел.-ч`
  );
}

/** Форматирует разряд так, как он записан в открытых данных: «3,8». */
export function formatRank(rank: number): string {
  return rank.toFixed(1).replace(".", ",");
}

/**
 * Ставка в рублях через запятую: «548,86».
 *
 * Точка здесь была бы мелочью, но ровно эту строку сметчик сверяет со своим
 * расчётом, и расхождение в разделителе читается как расхождение в данных.
 */
export function formatSalary(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

function findAnchor(scale: WageScale, rank: number): WageAnchor | null {
  for (const anchor of scale.anchors) {
    if (Math.abs(anchor.rank - rank) <= RANK_EPSILON) return anchor;
  }
  return null;
}

function bracket(
  scale: WageScale,
  rank: number,
): { lower: WageAnchor; upper: WageAnchor } | null {
  const anchors = scale.anchors;
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const lower = anchors[index];
    const upper = anchors[index + 1];
    if (lower === undefined || upper === undefined) continue;
    if (rank > lower.rank && rank < upper.rank) return { lower, upper };
  }
  return null;
}

/**
 * Пересчёт через тарифный коэффициент, а не через ставку: именно так открытые
 * данные устроены, и именно так интерполяция попадает в наблюдаемые значения
 * с точностью до копейки.
 */
function interpolate(
  scale: WageScale,
  lower: WageAnchor,
  upper: WageAnchor,
  rank: number,
): number {
  const span = upper.rank - lower.rank;
  if (span <= 0) return lower.salary;
  const ratio = (rank - lower.rank) / span;
  const lowerCoefficient = coefficientOf(scale, lower);
  const upperCoefficient = coefficientOf(scale, upper);
  const coefficient = lowerCoefficient + (upperCoefficient - lowerCoefficient) * ratio;
  return roundTo(coefficient * scale.baseSalary, 2);
}

/**
 * Продолжение шкалы за последний известный разряд по наклону крайнего участка.
 * Это приближение: шаг тарифной сетки меняется на каждом целом разряде, и за
 * пределами открытых данных он неизвестен. Вызывающий код обязан пометить
 * результат как пробел.
 */
function extrapolate(scale: WageScale, rank: number): number {
  const anchors = scale.anchors;
  const above = rank > scale.maxRank;
  const edge = above ? anchors[anchors.length - 1] : anchors[0];
  const neighbour = above ? anchors[anchors.length - 2] : anchors[1];
  if (edge === undefined || neighbour === undefined) {
    return roundTo(scale.baseSalary, 2);
  }
  const span = edge.rank - neighbour.rank;
  if (span === 0) return roundTo(edge.salary, 2);
  const slope = (coefficientOf(scale, edge) - coefficientOf(scale, neighbour)) / span;
  const coefficient = coefficientOf(scale, edge) + slope * (rank - edge.rank);
  if (coefficient <= 0) return 0;
  return roundTo(coefficient * scale.baseSalary, 2);
}

function coefficientOf(scale: WageScale, anchor: WageAnchor): number {
  return roundTo(anchor.salary / scale.baseSalary, COEFFICIENT_DIGITS);
}

/** Происхождение ставки одной фразой — для расшифровки строки сметы. */
export function describeWageOrigin(origin: WageOrigin): string {
  switch (origin) {
    case "ANCHOR":
      return "ставка из открытых данных ценовой зоны";
    case "INTERPOLATED":
      return "ставка получена интерполяцией между соседними разрядами шкалы";
    case "EXTRAPOLATED":
      return "ставка продолжена за пределы известных разрядов — приближение";
  }
}
