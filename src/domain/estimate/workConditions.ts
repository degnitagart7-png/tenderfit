import { formatDecimal, WORK_CONDITIONS, workCondition } from "@/domain/estimate/normatives";
import type { WorkCondition, WorkPhase } from "@/domain/estimate/normativeTypes";
import type {
  AppliedNormative,
  CustomerConditions,
  EstimateLine,
  LineCoefficients,
  WorkConditionsApplication,
} from "@/domain/estimate/types";
import type { EstimatePhase } from "@/domain/estimate/workKinds";

/**
 * Коэффициенты условий производства работ (Методика 421/пр, приложение 10, пункты 52-62).
 *
 * Правила взяты из текста Методики (`data/fsnb/normatives/sources/421-pr-pp52-62-prilozhenie-10.txt`):
 * - коэффициенты таблиц 1, 3, 5, 7 (снижение производительности) при ресурсно-индексном методе
 *   применяются к затратам труда рабочих, времени эксплуатации машин и затратам труда машинистов;
 *   несколько таких коэффициентов СКЛАДЫВАЮТСЯ по дробным частям: К = ДК1 + ДК2 + … + 1 (п. 52);
 * - коэффициенты таблиц 2, 4, 6, 8 (повышенная оплата труда) — к оплате труда рабочих и машинистов;
 *   допускается совместно с первыми (п. 52); между собой и с коэффициентами п. 58, 60 — перемножаются
 *   (п. 56, 61);
 * - колонка коэффициента зависит от вида нормы: ГЭСН (кроме сборника 46), ГЭСНм, ГЭСНр и ГЭСН 81-02-46;
 *   прочерк — к таким нормам условие не применяется;
 * - пункты 2 и 5 таблицы 1, 3 и 8 таблицы 3, 3 и 9.1-9.3 таблицы 5 не распространяются на работы в
 *   помещениях (п. 52);
 * - п. 58: ремонт и реконструкция по нормам, аналогичным новому строительству, — 1,15 к труду и 1,25 к
 *   машинам; не применяются к ГЭСН 81-02-46, ГЭСНм/р/мр/рр/п и к нормам на разборку (демонтаж) (п. 59).
 *
 * Условия выбирает человек; расчёт сам их не ставит. К какой позиции что применено, видно в строке
 * сметы (`line.coefficients`).
 */

export type NormColumn = "gesn" | "gesnm" | "gesnr" | "gesnp";

/** Колонка коэффициентов для нормы: по книге и сборнику. null — для книги коэффициентов нет (ГЭСНмр). */
export function normColumn(baseType: string, collectionCode: string): NormColumn | null {
  switch (baseType) {
    case "ГЭСН":
      // Сборник 46 «Работы при реконструкции зданий и сооружений» (81-02-46) стоит в третьей колонке.
      return collectionCode === "46" ? "gesnr" : "gesn";
    case "ГЭСНм":
      return "gesnm";
    case "ГЭСНр":
      return "gesnr";
    case "ГЭСНп":
      return "gesnp";
    default:
      return null;
  }
}

/** Нормы на разборку и демонтаж: по наименованию строки сметы. */
const DEMOLITION_WORDS = /разборк|демонтаж|разрушени|снос\b|ломк|пробивк/iu;
/**
 * «Установка и разборка инвентарных лесов», «Устройство и разборка опалубки» — норма на полный цикл временной
 * конструкции, а не на разборку здания или его частей: п. 59 Методики к ней не относится.
 */
const TEMPORARY_CYCLE = /(?:установк\p{L}*|устройств\p{L}*|монтаж\p{L}*)\s+и\s+(?:разборк|демонтаж)/iu;
const ROOF_WORDS = /кровл|крыш|водосточн/iu;
const PUBLIC_AREA_WORDS = /благоустр|тротуар|озеленен|территори|проезд|газон|отмостк/iu;
/** Позиция явно вне помещений: кровля, фасад, территория. */
const EXTERIOR_WORDS = /кровл|крыш|фасад|наружн|отмостк|благоустр|территори|тротуар|проезд|озеленен|ограждени|водосточн|козырьк|балкон/iu;

export interface PositionKind {
  readonly demolition: boolean;
  readonly roof: boolean;
  readonly publicArea: boolean;
  readonly exterior: boolean;
}

export function classifyPosition(name: string, collectionCode: string): PositionKind {
  return {
    demolition: DEMOLITION_WORDS.test(name) && !TEMPORARY_CYCLE.test(name),
    roof: collectionCode === "12" || ROOF_WORDS.test(name),
    publicArea: collectionCode === "27" || collectionCode === "47" || PUBLIC_AREA_WORDS.test(name),
    exterior:
      collectionCode === "12" || collectionCode === "27" || collectionCode === "47" || EXTERIOR_WORDS.test(name),
  };
}

/** Условия, которые сами по себе говорят «работы в помещениях»: к ним п. 52 запрещает стеснённость и т. п. */
const PREMISES_CONDITIONS: ReadonlySet<string> = new Set([
  "T3-1.1", "T3-1.2", "T3-2", "T3-5", "T3-6", "T3-7",
  "T5-1.1", "T5-1.2", "T5-2", "T5-5", "T5-6", "T5-7", "T5-8",
]);

const PHASE_TABLES: Readonly<Record<EstimatePhase, WorkPhase | null>> = {
  CONSTRUCTION: "CONSTRUCTION",
  RECONSTRUCTION: "RECONSTRUCTION",
  CAPITAL_REPAIR: "CAPITAL_REPAIR",
  DEMOLITION: null,
};

/** Условия вида работ: таблицы приложения 10 для строительства, реконструкции или капремонта. */
export function conditionsOfPhase(phase: EstimatePhase): readonly WorkCondition[] {
  const table = PHASE_TABLES[phase];
  return table === null ? [] : WORK_CONDITIONS.conditions.filter((condition) => condition.phase === table);
}

/** Условия пусконаладки (ГЭСНп, таблицы 7 и 8) — выбираются отдельно от вида работ. */
export function commissioningConditions(): readonly WorkCondition[] {
  return WORK_CONDITIONS.conditions.filter((condition) => condition.phase === "COMMISSIONING");
}

const round7 = (value: number): number => Math.round(value * 1e7) / 1e7;

export const NEUTRAL: LineCoefficients = { labour: 1, machines: 1, wage: 1, conditionIds: [], adjustmentIds: [] };

export interface PositionForCoefficients {
  readonly baseType: string;
  readonly collectionCode: string;
  /** Наименование нормы и позиции ведомости. */
  readonly name: string;
}

function selectedConditions(application: WorkConditionsApplication): WorkCondition[] {
  const table = PHASE_TABLES[application.phase];
  const result: WorkCondition[] = [];
  const seen = new Set<string>();
  for (const id of application.conditionIds) {
    const condition = workCondition(id);
    if (condition === null || seen.has(id)) continue;
    seen.add(id);
    // Условие чужого вида работ игнорируется; пусконаладка выбирается отдельно.
    if (condition.phase !== table && condition.phase !== "COMMISSIONING") continue;
    result.push(condition);
  }
  return result;
}

function appliesToPosition(condition: WorkCondition, kind: PositionKind, premises: boolean): boolean {
  if (condition.scope === "ROOF" && !kind.roof) return false;
  if (condition.scope === "PUBLIC_AREA" && !kind.publicArea) return false;
  // П. 52: условия «стеснённость», «действующее предприятие» не распространяются на работы в помещениях.
  if (condition.notForInterior && premises && !kind.exterior) return false;
  return true;
}

/**
 * Коэффициенты позиции. null — к позиции ничего не применяется (расход ресурсов остаётся нормой).
 *
 * Внутри группы взаимоисключающих условий (подпункты одного пункта) берётся одно: условие, заданное
 * для части работ (кровля, территория), вытесняет общее; иначе — с наибольшим коэффициентом.
 */
export function resolveLineCoefficients(
  application: WorkConditionsApplication | undefined,
  position: PositionForCoefficients,
): LineCoefficients | null {
  if (application === undefined) return null;
  const column = normColumn(position.baseType, position.collectionCode);
  if (column === null) return null;
  const kind = classifyPosition(position.name, position.collectionCode);
  const conditions = selectedConditions(application);
  const premises = conditions.some((condition) => PREMISES_CONDITIONS.has(condition.id));

  const eligible: { condition: WorkCondition; value: number }[] = [];
  for (const condition of conditions) {
    // Пусконаладочные таблицы — только к ГЭСНп, остальные — к прочим книгам.
    if ((condition.phase === "COMMISSIONING") !== (column === "gesnp")) continue;
    const value = condition.coefficients[column];
    if (value === null || value === undefined) continue;
    if (!appliesToPosition(condition, kind, premises)) continue;
    eligible.push({ condition, value });
  }

  // Группы взаимоисключающих.
  const byGroup = new Map<string, { condition: WorkCondition; value: number }[]>();
  const chosen: { condition: WorkCondition; value: number }[] = [];
  for (const item of eligible) {
    const group = item.condition.exclusiveGroup;
    if (group === null) {
      chosen.push(item);
      continue;
    }
    byGroup.set(group, [...(byGroup.get(group) ?? []), item]);
  }
  for (const items of byGroup.values()) {
    const scoped = items.filter((item) => item.condition.scope !== "ALL");
    const pool = scoped.length > 0 ? scoped : items;
    chosen.push(pool.reduce((best, item) => (item.value > best.value ? item : best)));
  }

  let productivity = 1;
  let wage = 1;
  const ids: string[] = [];
  for (const { condition, value } of chosen) {
    if (condition.kind === "PRODUCTIVITY") productivity += value - 1;
    else wage *= value;
    ids.push(condition.id);
  }
  ids.sort();

  let labour = round7(productivity);
  let machines = round7(productivity);
  const adjustments: string[] = [];
  if (
    application.newConstructionNorms &&
    (application.phase === "RECONSTRUCTION" || application.phase === "CAPITAL_REPAIR") &&
    column === "gesn" &&
    !kind.demolition
  ) {
    const adjustment = WORK_CONDITIONS.adjustments.find((item) => item.id === "P58");
    if (adjustment !== undefined) {
      // П. 56, 61: с коэффициентами приложения 10 — перемножение.
      labour = round7(labour * adjustment.labour);
      machines = round7(machines * adjustment.machines);
      adjustments.push(adjustment.id);
    }
  }
  wage = round7(wage);

  if (labour === 1 && machines === 1 && wage === 1 && ids.length === 0 && adjustments.length === 0) return null;
  return { labour, machines, wage, conditionIds: ids, adjustmentIds: adjustments };
}

/**
 * Коэффициенты позиции с учётом того, что к ней применил заказчик в своей ЛСР (`customerCoefficients.ts`).
 *
 * Подтверждённые условия добавляются к выбранным человеком и считаются теми же правилами: то же условие,
 * названное дважды, применяется один раз (множество идентификаторов), условия одной группы и таблицы
 * складываются по п. 52, п. 58 перемножается с приложением 10. Вид работ берётся у человека, если он
 * выбран, иначе — у таблицы, на которую сослался заказчик; условие другого вида работ, чем выбран
 * у человека, не применяется (`selectedConditions`) и называется среди пропущенных.
 *
 * Неподтверждённые значения заказчика применяются, только если человек включил их в ведомости
 * (`forceUnconfirmed`): значения заказчика к труду и к машинам перемножаются с итогом, строка помечена «вручную».
 */
export function resolveItemCoefficients(
  application: WorkConditionsApplication | undefined,
  customer: CustomerConditions | undefined,
  position: PositionForCoefficients,
): LineCoefficients | null {
  const own = resolveLineCoefficients(application, position);
  if (customer === undefined || !customer.enabled) return own;

  const confirmed = customer.confirmed;
  const special = customer.special;
  const manual = customer.forceUnconfirmed
    ? customer.rejected.reduce(
        (sum, claim) => ({ labour: sum.labour * (claim.labour ?? 1), machines: sum.machines * (claim.machines ?? 1) }),
        { labour: 1, machines: 1 },
      )
    : null;
  const hasManual = manual !== null && (manual.labour !== 1 || manual.machines !== 1);
  if (confirmed === null && special === undefined && !hasManual) return own;

  let merged = own;
  let applied: string[] = [];
  let duplicates: string[] = [];
  let skipped: string[] = [];
  if (confirmed !== null) {
    const base: WorkConditionsApplication = application ?? { phase: confirmed.phase, conditionIds: [], newConstructionNorms: false };
    const union: WorkConditionsApplication = {
      phase: base.phase,
      conditionIds: [...new Set([...base.conditionIds, ...confirmed.conditionIds])],
      newConstructionNorms: base.newConstructionNorms || confirmed.p58,
    };
    merged = resolveLineCoefficients(union, position);
    const present = new Set([...(merged?.conditionIds ?? []), ...(merged?.adjustmentIds ?? [])]);
    const before = new Set([...(own?.conditionIds ?? []), ...(own?.adjustmentIds ?? [])]);
    const wanted = [...confirmed.conditionIds, ...(confirmed.p58 ? ["P58"] : [])];
    applied = wanted.filter((id) => present.has(id) && !before.has(id));
    duplicates = wanted.filter((id) => present.has(id) && before.has(id));
    skipped = wanted.filter((id) => !present.has(id));
  }

  // Разборка и демонтаж (571/пр п. 83, табл. 2; п. 84, табл. 3): труд, машины и машинисты × коэффициент, материалы не учитываются.
  if (special !== undefined) applied = [...applied, special.id];
  const labour = (merged?.labour ?? 1) * (hasManual ? (manual as { labour: number }).labour : 1) * (special?.labour ?? 1);
  const machines = (merged?.machines ?? 1) * (hasManual ? (manual as { machines: number }).machines : 1) * (special?.machines ?? 1);
  const result: LineCoefficients = {
    labour: round7(labour),
    machines: round7(machines),
    wage: merged?.wage ?? 1,
    ...(special === undefined ? {} : { materials: special.materials }),
    conditionIds: merged?.conditionIds ?? [],
    adjustmentIds: [...(merged?.adjustmentIds ?? []), ...(special === undefined ? [] : [special.id]), ...(hasManual ? ["CUSTOMER_MANUAL"] : [])],
    customer: { applied, duplicates, skipped, manual: hasManual, label: customer.label },
  };
  const nothing =
    result.labour === 1 && result.machines === 1 && result.wage === 1 && applied.length === 0 && duplicates.length === 0 && skipped.length === 0 && !hasManual;
  return nothing && own === null ? null : result;
}

/* ------------------------------ Итог для карточки и отчёта ------------------------------ */

function coefficientLabel(condition: WorkCondition): string {
  const values = [condition.coefficients.gesn, condition.coefficients.gesnm, condition.coefficients.gesnr, condition.coefficients.gesnp].filter(
    (value): value is number => typeof value === "number",
  );
  const distinct = [...new Set(values)];
  return distinct.map((value) => value.toFixed(2).replace(".", ",")).join(" / ");
}

/** Что применено, по строкам сметы: нормативы для карточки «На чём стоят эти числа». */
export function describeWorkConditions(
  application: WorkConditionsApplication | undefined,
  lines: readonly EstimateLine[],
): AppliedNormative[] {
  if (application === undefined && !lines.some((line) => line.coefficients?.customer !== undefined || line.rateMultipliers !== undefined)) return [];
  const result: AppliedNormative[] = [];
  const total = lines.length;
  const countOf = (predicate: (line: EstimateLine) => boolean): number => lines.filter(predicate).length;

  for (const condition of application === undefined ? [] : selectedConditions(application)) {
    const used = countOf((line) => line.coefficients?.conditionIds.includes(condition.id) === true);
    const what =
      condition.kind === "PRODUCTIVITY"
        ? "к затратам труда рабочих, времени эксплуатации машин и затратам труда машинистов"
        : "к оплате труда рабочих и машинистов";
    result.push({
      code: "WORK_CONDITION",
      title: `Условие работ: ${condition.label}`,
      text: condition.text,
      value:
        used > 0
          ? `К = ${coefficientLabel(condition)} ${what}; применён к ${String(used)} из ${String(total)} позиций`
          : `К = ${coefficientLabel(condition)}; ни к одной позиции не применён`,
      source: condition.source.replace("Приложение 10 к 421/пр", "приложение 10 к 421/пр"),
      applied: used > 0,
      ...(used > 0
        ? {}
        : {
            reason:
              "для норм выбранных книг в таблице прочерк либо условие не распространяется на такие работы (п. 52: стеснённость и действующее предприятие — не для работ в помещениях)",
          }),
    });
  }

  if (application?.newConstructionNorms === true) {
    const used = countOf((line) => line.coefficients?.adjustmentIds.includes("P58") === true);
    const adjustment = WORK_CONDITIONS.adjustments.find((item) => item.id === "P58");
    if (adjustment !== undefined) {
      result.push({
        code: "WORK_ADJUSTMENT",
        title: "Ремонт и реконструкция по нормам нового строительства",
        text: adjustment.text,
        value:
          used > 0
            ? `К = ${adjustment.labour.toFixed(2).replace(".", ",")} к труду, ${adjustment.machines.toFixed(2).replace(".", ",")} к машинам и машинистам; применён к ${String(used)} из ${String(total)} позиций`
            : "ни к одной позиции не применён",
        source: "Приказ Минстроя России от 04.08.2020 N 421/пр, п. 58-61",
        applied: used > 0,
        ...(used > 0 ? {} : { reason: "в ведомости нет позиций ГЭСН (кроме сборника 46 и норм на разборку), к которым п. 58 применим" }),
      });
    }
  }

  const customerLines = lines.filter((line) => line.coefficients?.customer !== undefined || line.rateMultipliers !== undefined);
  if (customerLines.length > 0) {
    const multiplierLines = lines.filter((line) => (line.rateMultipliers?.applied.length ?? 0) > 0 && line.rateMultipliers?.manual !== true);
    const multiplierManual = lines.filter((line) => line.rateMultipliers?.manual === true);
    const multiplierLabels = [...new Set(multiplierLines.map((line) => line.rateMultipliers?.label ?? "").filter((label) => label !== ""))];
    const appliedLines = customerLines.filter((line) => (line.coefficients?.customer?.applied.length ?? 0) > 0 && line.coefficients?.customer?.manual !== true);
    const manualLines = customerLines.filter((line) => line.coefficients?.customer?.manual === true);
    const duplicateLines = customerLines.filter((line) => (line.coefficients?.customer?.duplicates.length ?? 0) > 0);
    const labels = [...new Set(customerLines.map((line) => line.coefficients?.customer?.label ?? "").filter((label) => label !== ""))];
    const multiplierText =
      multiplierLines.length > 0
        ? `; множители к нормативам НР и СП применены к ${String(multiplierLines.length)} позициям — ${multiplierLabels.join(" | ")}`
        : "";
    result.push({
      code: "CUSTOMER_COEFFICIENTS",
      title: "Коэффициенты и множители заказчика (как в его ЛСР)",
      text:
        "Коэффициенты, которые заказчик применил к позициям своей сметы и которые подтверждены приложением 10 к 421/пр или п. 58, а также множители к нормативам НР и СП (812/пр п. 25, 774/пр п. 16) применены к тем же позициям нашего расчёта.",
      value:
        `применены к ${String(appliedLines.length)} из ${String(total)} позиций` +
        multiplierText +
        (multiplierManual.length > 0 ? `; у ${String(multiplierManual.length)} позиций множители заказчика включены вручную без подтверждения приказом` : "") +
        (duplicateLines.length > 0 ? `; у ${String(duplicateLines.length)} позиций то же условие выбрано вами — второй раз не применялось` : "") +
        (manualLines.length > 0 ? `; у ${String(manualLines.length)} позиций значения заказчика включены вручную без подтверждения приложением 10` : "") +
        (labels.length > 0 ? ` — ${labels.join(" | ")}` : ""),
      source: "Приказ Минстроя России от 04.08.2020 N 421/пр, приложение 10, п. 52, 56, 58-61",
      applied: appliedLines.length + manualLines.length + multiplierLines.length + multiplierManual.length > 0,
      ...(appliedLines.length + manualLines.length + multiplierLines.length + multiplierManual.length > 0
        ? {}
        : { reason: "подтверждённые условия заказчика к позициям нашего расчёта не подошли (другой вид работ, прочерк в таблице для книги) или уже выбраны вами" }),
    });
  }

  if (result.length > 0) {
    const interior = application !== undefined && selectedConditions(application).some((condition) => PREMISES_CONDITIONS.has(condition.id));
    result.unshift({
      code: "WORK_RULES",
      title: "Правила сочетания коэффициентов",
      text:
        "Коэффициенты снижения производительности (таблицы 1, 3, 5, 7) складываются по дробным частям: К = ДК1 + ДК2 + … + 1 (п. 52); коэффициент повышенной оплаты труда (таблицы 2, 4, 6, 8) применяется совместно и перемножается; с коэффициентом п. 58 — перемножение (п. 56, 61)." +
        (interior
          ? " Выбраны условия работ в помещениях: стеснённость и действующее предприятие применены только к наружным позициям (кровля, фасад, территория), п. 52."
          : ""),
      value: `${String(total)} позиций в расчёте`,
      source: "Приказ Минстроя России от 04.08.2020 N 421/пр, п. 52, 56, 61",
      applied: true,
    });
  }
  return result;
}

/**
 * Одна фраза для результата и Word: «Применены коэффициенты условий работ: … (приложение 10 к 421/пр, п. …)».
 * null — ни одно условие не применено.
 */
export function workConditionsSentence(normatives: readonly AppliedNormative[] | undefined): string | null {
  const used = (normatives ?? []).filter((item) => (item.code === "WORK_CONDITION" || item.code === "WORK_ADJUSTMENT") && item.applied);
  if (used.length === 0) return null;
  const parts = used.map((item) => {
    const value = /^К = ([^;]*?)(?: (?:к |применён)|;|$)/u.exec(item.value)?.[1] ?? item.value;
    const raw = item.title.replace(/^Условие работ: /u, "");
    const label = raw.charAt(0).toLowerCase() + raw.slice(1);
    return `${label} — К ${value} (${item.source})`;
  });
  return `Применены коэффициенты условий работ: ${parts.join("; ")}.`;
}

/* ------------------------------ Подсказки по тексту документации ------------------------------ */

export interface ConditionHint {
  readonly conditionId: string;
  /** Что сказано в документации. */
  readonly quote: string;
}

function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + length + 50);
  return `…${text.slice(start, end).replace(/\s+/gu, " ").trim()}…`;
}

/**
 * Какие условия называет документация. Условие не ставится само: подсказка «В ТЗ сказано: «…» —
 * отметить?» остаётся человеку. Подсказываются только условия, у которых есть шаблон в справочнике.
 */
export function detectConditionHints(text: string, phase: EstimatePhase): ConditionHint[] {
  const hints: ConditionHint[] = [];
  for (const condition of conditionsOfPhase(phase)) {
    for (const pattern of condition.hints) {
      const match = new RegExp(pattern, "iu").exec(text);
      if (match === null) continue;
      hints.push({ conditionId: condition.id, quote: quoteAround(text, match.index, match[0].length) });
      break;
    }
  }
  return hints;
}
