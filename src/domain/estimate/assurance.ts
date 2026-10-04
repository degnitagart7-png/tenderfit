import { roundTo } from "@/domain/estimate/resourceKinds";
import type {
  EstimateDocument,
  EstimateGap,
  EstimateGapKind,
  EstimateLine,
} from "@/domain/estimate/types";

/**
 * Сверка расчёта «сверху вниз»: какая доля стоимости держится на допущении.
 *
 * `auditEstimateArithmetic` проверяет документ снизу вверх — сходится ли каждая
 * строка сама с собой. Этого мало для решения об участии: смета может быть
 * арифметически безупречной и при этом целиком стоять на резервных нормативах и
 * ценах четырёхлетней давности. Список пометок эту разницу несёт, но читать его
 * приходится позиция за позицией, а вопрос к расчёту один: насколько ему можно
 * верить. Здесь он сводится к одному проценту с расшифровкой, откуда он взялся.
 *
 * База сравнения — стоимость строительно-монтажных работ, а не итог с НДС:
 * лимитированные затраты и налог начисляются процентом от неё, поэтому доля
 * допущений в итоге ровно та же, а знаменатель без них честнее — он не растёт
 * от ставки НДС.
 */

/**
 * Вид допущения. Перечень закрытый: расчёт не имеет права опереться на
 * допущение, которого нет в этом списке, — сначала оно появляется здесь вместе
 * с объяснением для пользователя.
 */
export type EstimateAssumptionKind =
  /** Норматив НР или СП начислен резервом документа, а не по указателю расценки. */
  | "OVERHEAD_DEFAULT"
  /** Цена ресурса взята из базы 01.01.2022 — с индексом или без него. */
  | "BASE_PRICE"
  /** Ставка оплаты труда продолжена за пределы известной шкалы. */
  | "EXTRAPOLATED_WAGE";

/** Одно допущение: сколько стоимости на нём держится. */
export interface EstimateAssumption {
  readonly kind: EstimateAssumptionKind;
  /** Стоимость, начисленная по этому допущению, ₽ без НДС. */
  readonly cost: number;
  /** Доля в стоимости СМР, %. */
  readonly percent: number;
  /** Объяснение одной фразой — то, что видит пользователь. */
  readonly message: string;
}

/** Итог сверки по документу. */
export interface EstimateAssurance {
  /** Стоимость СМР — знаменатель всех долей. */
  readonly workCost: number;
  /** Стоимость, посчитанная по открытым данным без допущений. */
  readonly explainedCost: number;
  /** Стоимость, которая держится на допущении. */
  readonly assumedCost: number;
  /** Доля допущений в стоимости СМР, %. Ноль, когда стоимости нет вовсе. */
  readonly assumedPercent: number;
  /** Допущения с ненулевой стоимостью, по убыванию. */
  readonly assumptions: readonly EstimateAssumption[];
  /**
   * Ресурсные строки с расходом, но без денег: цены нет, цена в справочнике
   * равна нулю, или ставки на этот труд в открытых данных не существует.
   *
   * Считаются штуками, а не рублями, и намеренно не входят в `assumedCost`:
   * их вклад в стоимость — ноль, поэтому в проценте они не видны. Смета, где
   * доля допущений мала, а таких строк много, занижена, а не точна.
   */
  readonly unpricedResources: number;
  /**
   * Позиции ведомости, не попавшие в расчёт вовсе: норма не найдена, объём не
   * число, единица не совпала с единицей нормы.
   *
   * Их стоимости в документе нет ни в каком виде, поэтому процент о них не
   * говорит ничего — а итог без них занижен настолько, насколько они весили.
   */
  readonly droppedPositions: number;
}

/**
 * Пробелы, при которых позиция не дала строки сметы.
 *
 * Считаются по списку пробелов документа, а он склеен по «вид + книга + код +
 * текст», поэтому две разные позиции с одной и той же ненайденной нормой дадут
 * одну запись. Для решения «идти или не идти» это допустимо: важно, что часть
 * ведомости не посчитана, а не сколько именно строк её не посчитали.
 */
const DROPPING_GAPS: readonly EstimateGapKind[] = [
  "NO_NORM",
  "BAD_QUANTITY",
  "BAD_DIVISOR",
  "UNIT_MISMATCH",
];

/**
 * Пробелы документа, из-за которых позиция ведомости не попала в расчёт вовсе.
 *
 * Отдельная функция, а не фильтр внутри компонента: перечень видов, роняющих
 * позицию, живёт в домене вместе с долей допущений, и экран обязан показывать
 * ровно то же множество, которое домен считает. Иначе «Позиций без расчёта: 1»
 * и список под ним разъезжаются на первом же новом виде пробела.
 */
export function droppingGaps(document: EstimateDocument): readonly EstimateGap[] {
  return document.gaps.filter((gap) => DROPPING_GAPS.includes(gap.kind));
}

export function computeAssurance(
  document: EstimateDocument,
): EstimateAssurance {
  const lines = document.sections.flatMap((section) => section.lines);
  const workCost = document.totals.workCost;

  const reserveRates = sumReserveRates(lines);
  const basePrices = sumResources(
    lines,
    (resource) =>
      resource.source === "BASE_2022" ||
      resource.source === "BASE_2022_INDEXED",
  );
  const extrapolatedWages = sumResources(
    lines,
    (resource) => resource.wageOrigin === "EXTRAPOLATED",
  );

  const candidates: readonly {
    kind: EstimateAssumptionKind;
    cost: number;
    message: string;
  }[] = [
    {
      kind: "OVERHEAD_DEFAULT",
      cost: reserveRates,
      message:
        "Накладные расходы и сметная прибыль начислены резервом документа: указателя расценки нет или норматив не найден в справочнике приказов 812/пр и 774/пр",
    },
    {
      kind: "BASE_PRICE",
      cost: basePrices,
      message: `Цены ресурсов взяты из базы ${document.baseEdition}, потому что текущей цены по зоне «${document.priceZone}» за ${document.period} на них нет`,
    },
    {
      kind: "EXTRAPOLATED_WAGE",
      cost: extrapolatedWages,
      message: `Ставка оплаты труда продолжена за пределы шкалы зоны (известны разряды ${formatRankRange(document)})`,
    },
  ];

  const assumptions = candidates
    .filter((candidate) => candidate.cost > 0)
    .map((candidate) => ({
      kind: candidate.kind,
      cost: roundTo(candidate.cost, 2),
      percent: share(candidate.cost, workCost),
      message: candidate.message,
    }))
    .sort(
      (left, right) =>
        right.cost - left.cost || left.kind.localeCompare(right.kind),
    );

  const assumedCost = roundTo(
    assumptions.reduce((total, assumption) => total + assumption.cost, 0),
    2,
  );

  return {
    workCost,
    explainedCost: roundTo(workCost - assumedCost, 2),
    assumedCost,
    assumedPercent: share(assumedCost, workCost),
    assumptions,
    unpricedResources: countResources(
      lines,
      (resource) => resource.quantity > 0 && resource.total === 0,
    ),
    droppedPositions: droppingGaps(document).length,
  };
}

/**
 * НР и СП, начисленные резервом, складываются независимо друг от друга: в
 * выгрузке встречается норма, у которой задан только один из двух указателей,
 * и тогда резервом идёт только одно из двух начислений.
 */
function sumReserveRates(lines: readonly EstimateLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (line.overheadSource === "DEFAULT") total += line.overheadCost;
    if (line.profitSource === "DEFAULT") total += line.profitCost;
  }
  return total;
}

function sumResources(
  lines: readonly EstimateLine[],
  matches: (resource: EstimateLine["resources"][number]) => boolean,
): number {
  let total = 0;
  for (const line of lines) {
    for (const resource of line.resources) {
      if (matches(resource)) total += resource.total;
    }
  }
  return total;
}

function countResources(
  lines: readonly EstimateLine[],
  matches: (resource: EstimateLine["resources"][number]) => boolean,
): number {
  let count = 0;
  for (const line of lines) {
    for (const resource of line.resources) {
      if (matches(resource)) count += 1;
    }
  }
  return count;
}

/** Доля в процентах; пустая смета даёт ноль, а не деление на ноль. */
function share(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return roundTo((part / whole) * 100, 2);
}

function formatRankRange(document: EstimateDocument): string {
  const { minRank, maxRank } = document.wageScale;
  return `${minRank.toFixed(1).replace(".", ",")}–${maxRank.toFixed(1).replace(".", ",")}`;
}
