import { roundTo } from "@/domain/estimate/resourceKinds";
import type {
  VolumeSource,
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
  /**
   * Цена ресурса взята из базы 01.01.2022 — с индексом или без него. Цена «по индексу
   * сплит-формы» (`SPLIT_INDEXED`) сюда не входит: у неё текущий уровень.
   */
  | "BASE_PRICE"
  /** Ставка оплаты труда продолжена за пределы известной шкалы. */
  | "EXTRAPOLATED_WAGE"
  /** Позиция взята по цене из сметы заказчика: нашей нормы или цены нет, проверить нечем. */
  | "CUSTOMER_PRICE"
  /**
   * Зимнее удорожание начислено с допущением о территории: часть субъекта, заданная линией, по закупке
   * не определилась, принята «остальная территория» (Методика 325/пр, приложение 4).
   */
  | "NORMATIVE_ASSUMED"
  /**
   * Базисно-индексный метод: индексы взяты по «Прочим объектам» (объект строительства по наименованию определить
   * однозначно не удалось) или ТЕР региона посчитаны по ФЕР: вся стоимость строк БИМ держится на этом допущении.
   */
  | "BIM_INDEX_ASSUMED"
  /**
   * Объёмы взяты из сметы контракта (приказ 841/пр), а не из ведомости или ЛСР: позиции в ней укрупнены,
   * без шифров расценок, материалов и оборудования. Вся стоимость СМР держится на этом допущении.
   */
  | "CONTRACT_ESTIMATE_VOLUMES"
  /**
   * Коэффициенты заказчика к позиции включены человеком в ведомости, хотя приложение 10 к 421/пр их не подтверждает:
   * стоимость этих строк держится на значениях заказчика. Подтверждённые коэффициенты допущением не считаются.
   */
  | "CUSTOMER_COEFFICIENT_MANUAL";

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

/**
 * Стоимость, посчитанная по ценам «по индексу сплит-формы».
 *
 * Не допущение: уровень цен текущий — ресурс оценён индексом к группе однородных ресурсов по
 * письму Минстроя, а не взят из базы 2022 года. Но и не измеренная по зоне цена, поэтому
 * называется отдельно, рядом с допущениями, и в их долю не входит.
 */
export interface EstimateIndexedPrices {
  /** Стоимость ресурсных строк с ценой по индексу сплит-формы, ₽ без НДС. */
  readonly cost: number;
  /** Доля в стоимости СМР, %. */
  readonly percent: number;
  readonly message: string;
}

/**
 * Норматив, который не начислен из-за неизвестных данных (вид работ, сроки, территория).
 *
 * Не допущение с суммой: начисления нет, и сколько он добавил бы, неизвестно, — но смета без него
 * занижена, и это обязано быть видно рядом с допущениями, со строкой причины.
 */
export interface EstimateUnappliedNormative {
  readonly code: string;
  readonly title: string;
  /** Причина одной фразой: «зимнее удорожание не начислено: не известен период работ». */
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
  /** Цены по индексу сплит-формы — не допущение, но называются; нет поля, когда таких цен нет. */
  readonly indexedPrices?: EstimateIndexedPrices;
  /** Нормативы, не начисленные из-за неизвестных данных; нет поля, когда таких нет. */
  readonly unappliedNormatives?: readonly EstimateUnappliedNormative[];
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
  /**
   * Материалы норм «по проекту» (расход «П» или ресурс без марки), которых в расчёте нет: количество и цена в проекте, и пока человек
   * не назвал их в ведомости, стоимость позиции занижена на них. Нет поля, когда таких нет.
   */
  readonly projectMaterialGaps?: number;
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

/** Что о расчёте известно помимо документа: откуда взяты объёмы. */
export interface AssuranceContext {
  readonly volumeSource?: Pick<VolumeSource, "level" | "documents"> | null;
}

export function computeAssurance(
  document: EstimateDocument,
  context: AssuranceContext = {},
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

  // Цена заказчика: позиции без нормы (в том числе невидимый остаток позиции ЛСР) и материалы, взятые по его сумме.
  const customerPrices =
    sumLines(lines, (line) => line.priceSource === "CUSTOMER_PRICE") + sumResources(lines, (resource) => resource.source === "CUSTOMER_SUM");
  const projectMaterialGaps = document.gaps.filter((gap) => gap.kind === "PROJECT_SPECIFIC_RESOURCE" || gap.kind === "QUANTITY_BY_PROJECT").length;
  const unapplied: EstimateUnappliedNormative[] = (document.appliedNormatives ?? [])
    .filter((normative) => !normative.applied && normative.missingData === true)
    .map((normative) => ({
      code: normative.code,
      title: normative.title,
      message: `${normative.title}: ${normative.reason ?? "не начислен"}`,
    }));
  const indexedPrices = sumResources(lines, (resource) => resource.source === "SPLIT_INDEXED");

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
      kind: "CUSTOMER_PRICE",
      cost: customerPrices,
      message:
        "Часть позиций взята по цене заказчика из его сметы: нашей нормы или цены на них нет, и проверить сумму нашими ценами нечем",
    },
    {
      kind: "EXTRAPOLATED_WAGE",
      cost: extrapolatedWages,
      message: `Ставка оплаты труда продолжена за пределы шкалы зоны (известны разряды ${formatRankRange(document)})`,
    },
    {
      kind: "NORMATIVE_ASSUMED",
      cost: assumedNormativeCost(document),
      message: assumedNormativeMessage(document),
    },
    {
      kind: "BIM_INDEX_ASSUMED",
      cost: assumedBimCost(document, lines),
      message: assumedBimMessage(document),
    },
    {
      kind: "CUSTOMER_COEFFICIENT_MANUAL",
      cost: sumLines(lines, (line) => line.coefficients?.customer?.manual === true || line.rateMultipliers?.manual === true),
      message:
        "К части позиций применены коэффициенты или множители заказчика, которых нет в приложении 10 к 421/пр и в приказах 812/пр и 774/пр: их включил человек в ведомости, основание — только смета заказчика",
    },
    {
      kind: "CONTRACT_ESTIMATE_VOLUMES",
      cost: context.volumeSource?.level === "CONTRACT_ESTIMATE" ? workCost : 0,
      message:
        "Объёмы взяты из сметы контракта (приказ 841/пр): позиции в ней укрупнены, без шифров расценок, материалов и оборудования. " +
        "Ведомости объёмов и локальной сметы заказчика в документации нет, поэтому расчёт держится на этом допущении и занижен там, где ЛСР раскрыла бы работу подробнее",
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
    ...(indexedPrices > 0
      ? {
          indexedPrices: {
            cost: roundTo(indexedPrices, 2),
            percent: share(indexedPrices, workCost),
            message: `Часть цен взята по индексу сплит-формы ФГИС ЦС зоны «${document.priceZone}» за ${document.period}: текущий уровень, получен индексом к группе однородных ресурсов, а не измерен по зоне. Это не база ${document.baseEdition}`,
          },
        }
      : {}),
    ...(unapplied.length > 0 ? { unappliedNormatives: unapplied } : {}),
    unpricedResources: countResources(
      lines,
      (resource) => resource.quantity > 0 && resource.total === 0,
    ),
    droppedPositions: droppingGaps(document).length,
    ...(projectMaterialGaps > 0 ? { projectMaterialGaps } : {}),
  };
}

/** Строки БИМ держатся на допущении: объект не определён однозначно или ТЕР региона посчитаны по ФЕР. */
function assumedBimCost(document: EstimateDocument, lines: readonly EstimateLine[]): number {
  const bim = document.bim;
  if (document.method !== "BASE_INDEX" || bim === undefined || (bim.objectDetected && bim.customerBase !== "TER")) return 0;
  return sumLines(lines, (line) => line.bim !== undefined);
}

function assumedBimMessage(document: EstimateDocument): string {
  const bim = document.bim;
  const parts: string[] = [];
  if (bim !== undefined && !bim.objectDetected) {
    parts.push(`объект строительства по наименованию определить однозначно не удалось — индексы взяты по «${bim.object}»`);
  }
  if (bim?.customerBase === "TER") parts.push("заказчик считает по ТЕР региона, открытой базы ТЕР нет — посчитано по ФЕР с индексами к ФЕР, возможна разница");
  return `Базисно-индексный метод: ${parts.join("; ")}`;
}

/** Зимнее удорожание, начисленное с допущением о территории: его сумма держится на допущении. */
function assumedNormativeCost(document: EstimateDocument): number {
  const winter = (document.appliedNormatives ?? []).find((item) => item.code === "WINTER" && item.applied && item.assumption !== undefined);
  return winter === undefined ? 0 : document.totals.winterSurcharge;
}

function assumedNormativeMessage(document: EstimateDocument): string {
  const winter = (document.appliedNormatives ?? []).find((item) => item.code === "WINTER" && item.applied && item.assumption !== undefined);
  return `Зимнее удорожание начислено с допущением: ${winter?.assumption ?? ""}`;
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

/** Стоимость строк (прямые затраты, НР и СП), отобранных условием. */
function sumLines(lines: readonly EstimateLine[], matches: (line: EstimateLine) => boolean): number {
  let total = 0;
  for (const line of lines) {
    if (matches(line)) total += line.directCost + line.overheadCost + line.profitCost;
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
