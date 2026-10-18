import { droppingGaps } from "@/domain/estimate/assurance";
import {
  CUSTOMER_NORM_BASE_LABEL,
  normalizeSectionTitle,
  type CustomerEstimate,
  type CustomerEstimateMethod,
  type CustomerNormBase,
} from "@/domain/estimate/customerEstimate";
import type { LsrSourceInfo } from "@/domain/estimate/customerLsrSet";
import type { DeclaredPriceLevel } from "@/domain/estimate/priceLevel";
import type { EstimateDocument, EstimateLine } from "@/domain/estimate/types";

/**
 * Сравнение нашего расчёта со сметой заказчика по разделам.
 *
 * Зачем. Итог «заказчик заложил 5 млн, у нас вышло 6,2 млн» говорит, что есть
 * расхождение, но не где. По разделам видно, что заказчик занизил ремонтные
 * работы и что демонтаж у нас почти совпал, — и куда смотреть при расчёте цены.
 *
 * Что с чем сравнивается. Стоимость строки у нас — прямые затраты, накладные и
 * сметная прибыль, без НДС и лимитированных затрат: так устроена строка «Итого по
 * разделу» в локальной смете заказчика. Разделы сопоставляются по названию, а не
 * по номеру: номера повторяются между сметами одного архива.
 *
 * Чего здесь нет. Смет в базисных ценах 2001 г. по разделам не сравниваем: их
 * числа не сопоставимы с текущими ценами, и разница между ними — это индексы, а
 * не ошибка заказчика. Они перечисляются отдельно.
 *
 * Деньги внутри не округляются: округление — дело вывода.
 */

export type SectionVerdict = "CLOSE" | "OURS_HIGHER" | "OURS_LOWER" | "MISSING_IN_OURS";
export type TotalVerdict = Exclude<SectionVerdict, "MISSING_IN_OURS">;

export type ComparisonStatus =
  | "NO_CUSTOMER_ESTIMATE"
  /** Сметы есть, но разделов в них нет — только итоги. */
  | "NO_SECTIONS"
  /** Смета посчитана до появления разделов: у всех строк поля `billSection` нет вовсе. */
  | "LEGACY_ESTIMATE"
  /** Поле есть, но везде пусто: в документах, по которым считались объёмы, разделов нет. */
  | "NO_OUR_SECTIONS"
  /** Все сметы заказчика в базисных ценах 2001 г. */
  | "BASE_PRICES_ONLY"
  | "OK";

export interface ComparisonRow {
  /** Название раздела — как у заказчика. */
  readonly title: string;
  readonly customerAmount: number;
  /** null — у нас нет ни одной позиции этого раздела. */
  readonly ourAmount: number | null;
  /** Наш минус заказчика; null, если пары нет. */
  readonly diff: number | null;
  /** Разница в процентах от суммы заказчика; null, если пары нет или у заказчика ноль. */
  readonly diffPercent: number | null;
  readonly verdict: SectionVerdict;
  /**
   * Сколько позиций раздела выпало из расчёта (норма не найдена, объём, единица).
   * Считается по пробелам документа с тем же нормализованным разделом, что у
   * группы, сопоставленной со строкой; у раздела без пары — по названию раздела
   * заказчика. Пробелы склеены по тексту сообщения внутри раздела, поэтому две
   * позиции с одним наименованием в одном разделе дают одну запись — это нижняя
   * оценка.
   */
  readonly droppedPositions: number;
}

export interface ComparisonEstimateInfo {
  readonly documentName: string;
  readonly estimateName: string | null;
  readonly statedTotal: number | null;
  readonly totalIncludesVat: boolean | null;
  readonly checked: boolean;
  readonly method: CustomerEstimateMethod;
  readonly priceLevel: DeclaredPriceLevel;
  readonly sectionsCount: number;
  /** База норм сметы, если это ТСН-2001 Москвы: в подписи источника называется («база ТСН-2001 (Москва)»). Нет поля — база не названа. */
  readonly base?: CustomerNormBase;
}

/**
 * Сравнение по одной локальной смете заказчика: «у заказчика / у нас / разница / %».
 *
 * Сметы 421/пр с разделами без строк «Итого по разделу» (Гранд-Смета печатает только «Итоги по смете»)
 * по разделам не сравнить, а по сметам — можно: наш расчёт строит раздел на каждую ЛСР заказчика
 * (`lsrSectionTitle`), и пара находится по названию раздела.
 */
export interface LsrComparisonRow {
  /** Название сметы и нашего раздела: «ЛСР 02-02-08. Ремонтные работы …». */
  readonly title: string;
  readonly number: string | null;
  /** Итог сметы заказчика без НДС; null — итог в тексте не найден. */
  readonly customerAmount: number | null;
  /** Позиции сметы заказчика, включая подпозиции (поставки, оборудование). */
  readonly customerPositions: number;
  /** null — нашего раздела с таким названием нет. */
  readonly ourAmount: number | null;
  readonly ourPositions: number;
  readonly diff: number | null;
  readonly diffPercent: number | null;
  /** `MISSING_IN_OURS`, когда нашего раздела нет; `CLOSE`, когда итога заказчика нет. */
  readonly verdict: SectionVerdict;
  /** Позиции сметы заказчика, по которым у нас нет строки (норма не найдена и цены заказчика нет). */
  readonly droppedPositions: number;
  /** Смета лежит в нескольких документах: откуда взята. Пусто — документ один. */
  readonly foundIn: readonly string[];
  readonly documentName: string;
}

export interface TotalComparison {
  readonly customerAmount: number;
  readonly ourAmount: number;
  readonly diff: number;
  readonly diffPercent: number | null;
  readonly verdict: TotalVerdict;
}

export interface CustomerComparison {
  readonly status: ComparisonStatus;
  /** Все разделы заказчика (кроме смет в базисных ценах) — с парой или без. */
  readonly rows: readonly ComparisonRow[];
  /** Сумма заказчика и наша по сопоставленным разделам. */
  readonly matchedCustomer: number;
  readonly matchedOurs: number;
  readonly diff: number;
  readonly diffPercent: number | null;
  /** null — ни один раздел не сопоставился. */
  readonly verdict: TotalVerdict | null;
  /** Наши позиции, раздел которых не нашёл пары у заказчика, включая «вне разделов». */
  readonly unmatchedOurs: { readonly count: number; readonly amount: number };
  /** Разделы заказчика без наших позиций. */
  readonly customerOnly: readonly ComparisonRow[];
  /** Доля суммы заказчика, которую покрыли сопоставленные разделы; null — разделов нет. */
  readonly coverage: number | null;
  /** Все участвующие сметы с разделами сверены с итогом сметы. */
  readonly checked: boolean;
  /** Сметы, участвующие в сравнении по разделам. */
  readonly estimates: readonly ComparisonEstimateInfo[];
  /** Сметы в базисных ценах 2001 г.: по разделам не сравниваются. */
  readonly baseEstimates: readonly ComparisonEstimateInfo[];
  /** Сумма всех разделов заказчика против нашего итога СМР; null — разделов нет. */
  readonly overall: TotalComparison | null;
  /** Позиций ведомости, не попавших в наш расчёт вовсе. */
  readonly droppedPositions: number;
  /** Сравнение по каждой ЛСР заказчика. Нет поля или пусто — ЛСР, из которых построен расчёт, не передавались. */
  readonly perLsr?: readonly LsrComparisonRow[];
  /** Итог по ЛСР: сумма заказчика и наша по сметам, у которых есть и то и другое. */
  readonly perLsrTotal?: TotalComparison | null;
}

/** Порог «близко»: разница до 10 % от суммы заказчика. */
export const CLOSE_PERCENT = 10;
/** Порог сходства названий разделов по токенам. */
export const MIN_JACCARD = 0.6;

const EPSILON = 1e-9;

function lineCost(line: EstimateLine): number {
  return line.directCost + line.overheadCost + line.profitCost;
}

function percentOf(diff: number, customer: number): number | null {
  return customer === 0 ? null : (diff * 100) / customer;
}

function verdictOf(diff: number, customer: number): TotalVerdict {
  if (customer === 0) return diff > 0 ? "OURS_HIGHER" : "CLOSE";
  const percent = (diff * 100) / customer;
  if (Math.abs(percent) <= CLOSE_PERCENT + EPSILON) return "CLOSE";
  return percent > 0 ? "OURS_HIGHER" : "OURS_LOWER";
}

function infoOf(estimate: CustomerEstimate): ComparisonEstimateInfo {
  return {
    documentName: estimate.documentName,
    estimateName: estimate.estimateName,
    statedTotal: estimate.statedTotal,
    totalIncludesVat: estimate.totalIncludesVat,
    checked: estimate.checked,
    method: estimate.method,
    priceLevel: estimate.priceLevel,
    sectionsCount: estimate.sections.length,
    ...(estimate.base === undefined ? {} : { base: estimate.base }),
  };
}

interface Group {
  readonly key: string;
  readonly title: string;
  amount: number;
  lines: number;
}

function tokensOf(key: string): Set<string> {
  return new Set(key.split(" ").filter((token) => token !== ""));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Сопоставляет разделы заказчика с нашими: по названию, затем по сходству токенов. */
function matchGroups(
  customer: readonly Group[],
  ours: ReadonlyMap<string, Group>,
): Map<string, string> {
  const pairs = new Map<string, string>();
  const used = new Set<string>();

  for (const group of customer) {
    if (group.key !== "" && ours.has(group.key) && !used.has(group.key)) {
      pairs.set(group.key, group.key);
      used.add(group.key);
    }
  }

  // Приближённо: единственный лучший кандидат с сходством не ниже порога.
  const claims = new Map<string, { customerKey: string; score: number; tie: boolean }>();
  for (const group of customer) {
    if (pairs.has(group.key) || group.key === "") continue;
    const tokens = tokensOf(group.key);
    let best: { key: string; score: number } | null = null;
    let tied = false;
    for (const candidate of ours.values()) {
      if (candidate.key === "" || used.has(candidate.key)) continue;
      const score = jaccard(tokens, tokensOf(candidate.key));
      if (score < MIN_JACCARD) continue;
      if (best === null || score > best.score + EPSILON) {
        best = { key: candidate.key, score };
        tied = false;
      } else if (Math.abs(score - best.score) <= EPSILON) tied = true;
    }
    if (best === null || tied) continue;
    const existing = claims.get(best.key);
    if (existing === undefined || best.score > existing.score + EPSILON) {
      claims.set(best.key, { customerKey: group.key, score: best.score, tie: false });
    } else if (Math.abs(best.score - existing.score) <= EPSILON) {
      claims.set(best.key, { ...existing, tie: true });
    }
  }
  for (const [ourKey, claim] of claims) {
    if (claim.tie) continue;
    pairs.set(claim.customerKey, ourKey);
    used.add(ourKey);
  }
  return pairs;
}

/** Сравнение по ЛСР: наши разделы по названию, суммы заказчика — из прочитанных смет. */
export function compareByLsr(
  document: EstimateDocument,
  lsrs: readonly LsrSourceInfo[],
): { rows: LsrComparisonRow[]; total: TotalComparison | null } {
  const rows: LsrComparisonRow[] = lsrs.map((info) => {
    const section = document.sections.find((candidate) => candidate.title === info.sectionTitle);
    const customerPositions = info.positions + info.subPositions;
    const customerAmount = info.totalExVat;
    if (section === undefined) {
      return {
        title: info.sectionTitle,
        number: info.number,
        customerAmount,
        customerPositions,
        ourAmount: null,
        ourPositions: 0,
        diff: null,
        diffPercent: null,
        verdict: customerAmount !== null && customerAmount > 0 ? "MISSING_IN_OURS" : "CLOSE",
        droppedPositions: customerPositions,
        foundIn: info.documents.length > 1 ? info.documents : [],
        documentName: info.documentName,
      };
    }
    const ourAmount = section.workCost;
    // Строки «неучтённых ресурсов позиции» (`-rest`) — часть позиции заказчика, а не отдельные позиции.
    const ourLines = section.lines.filter((line) => (line.itemId as string | undefined)?.endsWith("-rest") !== true).length;
    const diff = customerAmount === null ? null : ourAmount - customerAmount;
    return {
      title: info.sectionTitle,
      number: info.number,
      customerAmount,
      customerPositions,
      ourAmount,
      ourPositions: ourLines,
      diff,
      diffPercent: diff === null || customerAmount === null ? null : percentOf(diff, customerAmount),
      verdict: diff === null || customerAmount === null ? "CLOSE" : verdictOf(diff, customerAmount),
      droppedPositions: Math.max(0, customerPositions - ourLines),
      foundIn: info.documents.length > 1 ? info.documents : [],
      documentName: info.documentName,
    };
  });

  const paired = rows.filter((row) => row.customerAmount !== null && row.ourAmount !== null);
  if (paired.length === 0) return { rows, total: null };
  const customerAmount = paired.reduce((sum, row) => sum + (row.customerAmount as number), 0);
  const ourAmount = paired.reduce((sum, row) => sum + (row.ourAmount as number), 0);
  const diff = ourAmount - customerAmount;
  return {
    rows,
    total: { customerAmount, ourAmount, diff, diffPercent: percentOf(diff, customerAmount), verdict: verdictOf(diff, customerAmount) },
  };
}

export function compareWithCustomerEstimate(
  document: EstimateDocument,
  estimates: readonly CustomerEstimate[],
  lsrs: readonly LsrSourceInfo[] = [],
): CustomerComparison {
  const byLsr = lsrs.length === 0 ? null : compareByLsr(document, lsrs);
  const withLsr = <T extends CustomerComparison>(result: T): T =>
    byLsr === null ? result : { ...result, perLsr: byLsr.rows, perLsrTotal: byLsr.total };
  return withLsr(compareBySections(document, estimates));
}

function compareBySections(
  document: EstimateDocument,
  estimates: readonly CustomerEstimate[],
): CustomerComparison {
  const participating = estimates.filter((estimate) => estimate.method !== "BASE_2001");
  const baseEstimates = estimates.filter((estimate) => estimate.method === "BASE_2001").map(infoOf);
  const withSections = participating.filter((estimate) => estimate.sections.length > 0);

  const lines = document.sections.flatMap((section) => section.lines);
  const hasOurSections = lines.some((line) => (line.billSection ?? "").trim() !== "");
  // Поле отсутствует у всех строк — смета старая; есть, но пусто — в документе разделов нет.
  const isLegacy = lines.every((line) => line.billSection === undefined);

  // Наша сторона: группы по нормализованному названию раздела документа.
  const ours = new Map<string, Group>();
  for (const line of lines) {
    const title = (line.billSection ?? "").trim();
    const key = title === "" ? "" : normalizeSectionTitle(title);
    const group = ours.get(key) ?? { key, title, amount: 0, lines: 0 };
    group.amount += lineCost(line);
    group.lines += 1;
    ours.set(key, group);
  }

  // Сторона заказчика: одноимённые разделы разных смет складываются.
  const customerGroups = new Map<string, Group>();
  for (const estimate of withSections) {
    for (const section of estimate.sections) {
      const key = normalizeSectionTitle(section.title);
      const group = customerGroups.get(key) ?? { key, title: section.title, amount: 0, lines: 0 };
      group.amount += section.amount;
      group.lines += 1;
      customerGroups.set(key, group);
    }
  }
  const customer = [...customerGroups.values()];
  const customerTotal = customer.reduce((total, group) => total + group.amount, 0);

  const overall: TotalComparison | null =
    customer.length === 0
      ? null
      : (() => {
          const ourAmount = document.totals.workCost;
          const diff = ourAmount - customerTotal;
          return {
            customerAmount: customerTotal,
            ourAmount,
            diff,
            diffPercent: percentOf(diff, customerTotal),
            verdict: verdictOf(diff, customerTotal),
          };
        })();

  const checked = withSections.length > 0 && withSections.every((estimate) => estimate.checked);
  const common = {
    estimates: participating.map(infoOf),
    baseEstimates,
    checked,
    overall,
    droppedPositions: droppingGaps(document).length,
  };
  const empty = {
    rows: [],
    matchedCustomer: 0,
    matchedOurs: 0,
    diff: 0,
    diffPercent: null,
    verdict: null,
    unmatchedOurs: { count: 0, amount: 0 },
    customerOnly: [],
    coverage: null,
  } as const;

  let status: ComparisonStatus;
  if (estimates.length === 0) status = "NO_CUSTOMER_ESTIMATE";
  else if (participating.length === 0) status = "BASE_PRICES_ONLY";
  else if (withSections.length === 0) status = "NO_SECTIONS";
  else if (isLegacy) status = "LEGACY_ESTIMATE";
  else if (!hasOurSections) status = "NO_OUR_SECTIONS";
  else status = "OK";

  if (status !== "OK") return { ...empty, ...common, status };

  const pairs = matchGroups(customer, ours);

  // Выпавшие из расчёта позиции по разделам документа.
  const droppedByKey = new Map<string, Group>();
  for (const gap of droppingGaps(document)) {
    const title = (gap.billSection ?? "").trim();
    if (title === "") continue;
    const key = normalizeSectionTitle(title);
    const group = droppedByKey.get(key) ?? { key, title, amount: 0, lines: 0 };
    group.lines += 1;
    droppedByKey.set(key, group);
  }
  // У раздела без наших строк пара ищется среди разделов, где что-то выпало.
  const unpaired = customer.filter((group) => !pairs.has(group.key));
  const droppedPairs = matchGroups(unpaired, droppedByKey);

  const rows: ComparisonRow[] = customer.map((group) => {
    const paired = pairs.get(group.key);
    const ourGroup = paired === undefined ? undefined : ours.get(paired);
    if (ourGroup === undefined) {
      const droppedKey = droppedPairs.get(group.key);
      return {
        title: group.title,
        customerAmount: group.amount,
        ourAmount: null,
        diff: null,
        diffPercent: null,
        verdict: group.amount > 0 ? "MISSING_IN_OURS" : "CLOSE",
        droppedPositions: droppedKey === undefined ? 0 : (droppedByKey.get(droppedKey)?.lines ?? 0),
      };
    }
    const diff = ourGroup.amount - group.amount;
    return {
      title: group.title,
      customerAmount: group.amount,
      ourAmount: ourGroup.amount,
      diff,
      diffPercent: percentOf(diff, group.amount),
      verdict: verdictOf(diff, group.amount),
      droppedPositions: droppedByKey.get(paired as string)?.lines ?? 0,
    };
  });

  const matchedRows = rows.filter((row) => row.ourAmount !== null);
  const matchedCustomer = matchedRows.reduce((total, row) => total + row.customerAmount, 0);
  const matchedOurs = matchedRows.reduce((total, row) => total + (row.ourAmount ?? 0), 0);
  const matchedOurKeys = new Set(pairs.values());
  const unmatched = [...ours.values()].filter((group) => !matchedOurKeys.has(group.key));

  const diff = matchedOurs - matchedCustomer;
  return {
    ...common,
    status,
    rows,
    matchedCustomer,
    matchedOurs,
    diff,
    diffPercent: percentOf(diff, matchedCustomer),
    verdict: matchedRows.length === 0 ? null : verdictOf(diff, matchedCustomer),
    unmatchedOurs: {
      count: unmatched.reduce((total, group) => total + group.lines, 0),
      amount: unmatched.reduce((total, group) => total + group.amount, 0),
    },
    customerOnly: rows.filter((row) => row.verdict === "MISSING_IN_OURS"),
    coverage: customerTotal === 0 ? null : matchedCustomer / customerTotal,
  };
}

/* ====================== Подписи для пользователя ====================== */

/** Пометка к строке сравнения: что разница значит для цены. */
export const SECTION_VERDICT_NOTE: Record<SectionVerdict, string> = {
  CLOSE: "близко",
  OURS_HIGHER: "заказчик заложил меньше текущих цен — риск",
  OURS_LOWER: "у заказчика запас",
  MISSING_IN_OURS: "у нас нет позиций этого раздела",
};

/**
 * Пометка строки целиком. У раздела без наших позиций, где часть выпала из
 * расчёта, вывод другой: «позиций нет» и «позиции есть, но не посчитаны» — не одно.
 */
export function rowNote(row: ComparisonRow): string {
  if (row.verdict === "MISSING_IN_OURS" && row.droppedPositions > 0) {
    return `у нас нет посчитанных позиций, но ${String(row.droppedPositions)} выпали из расчёта`;
  }
  return SECTION_VERDICT_NOTE[row.verdict];
}

/** Вторая строка пометки: о выпавших позициях раздела, если они есть и вывод о другом. */
export function rowDroppedNote(row: ComparisonRow): string | null {
  return row.verdict === "MISSING_IN_OURS" ? null : droppedNote(row.droppedPositions);
}

/** Пометка строки сравнения по ЛСР: вывод по сумме, не посчитанные позиции и откуда взята смета. */
export function lsrRowNote(row: LsrComparisonRow): string {
  if (row.verdict === "MISSING_IN_OURS") return "в нашей смете раздела этой ЛСР нет";
  if (row.customerAmount === null) return "итог сметы заказчика в тексте не найден";
  return SECTION_VERDICT_NOTE[row.verdict];
}

/** Вторая строка пометки: позиции без строки у нас и документы, где найдена смета. */
export function lsrRowDetails(row: LsrComparisonRow): string[] {
  const details: string[] = [];
  const dropped = droppedNote(row.droppedPositions);
  if (dropped !== null && row.ourAmount !== null) details.push(dropped);
  if (row.foundIn.length > 1) {
    details.push(`найдена в ${String(row.foundIn.length)} документах, взята из «${row.documentName}»`);
  }
  return details;
}

/** Объяснение для смет в базисных ценах и по территориальным базам. */
export const BASE_PRICES_TEXT =
  "составлена в базисных ценах 2001 г. или по территориальной базе (ТЕР/ФЕР/ТСН) — по разделам с текущими ценами ФСНБ-2022 не сравнить";

/** Пометка о выпавших позициях раздела; пусто, если выпавших нет. */
export function droppedNote(count: number): string | null {
  return count > 0 ? `${String(count)} поз. не посчитано — разница может быть из-за этого` : null;
}

/** Уровень цен заказчика словами: «2 зона, 3 кв. 2026»; null — документ о нём молчит. */
export function describePriceLevel(level: DeclaredPriceLevel): string | null {
  const parts: string[] = [];
  if (level.zone !== null) parts.push(`${String(level.zone)} зона`);
  if (level.quarter !== null && level.year !== null) {
    parts.push(`${String(level.quarter)} кв. ${String(level.year)}`);
  }
  return parts.length === 0 ? null : parts.join(", ");
}

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** Одна смета заказчика строкой для подписи источника: файл, лист, итог, разделы, уровень цен. */
export function describeComparisonEstimate(info: ComparisonEstimateInfo): string {
  const name = info.estimateName === null ? info.documentName : `${info.documentName} · ${info.estimateName}`;
  const parts: string[] = [];
  if (info.statedTotal !== null) {
    const vat = info.totalIncludesVat === null ? "" : info.totalIncludesVat ? " (с НДС)" : " (без НДС)";
    parts.push(`итог ${RUB.format(Math.round(info.statedTotal))} ₽${vat}`);
  }
  parts.push(info.sectionsCount > 0 ? `разделов: ${String(info.sectionsCount)}` : "разделов нет");
  const level = describePriceLevel(info.priceLevel);
  if (level !== null) parts.push(`уровень цен заказчика: ${level}`);
  if (info.base !== undefined) parts.push(`база норм: ${CUSTOMER_NORM_BASE_LABEL[info.base]}`);
  return `${name}: ${parts.join(", ")}`;
}

export interface VerificationLine {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Строки сверки смет с итогом. Причин несверенности две, и они разные: итог в
 * тексте есть, но не сошёлся (не та колонка), или итога в тексте нет вовсе
 * (документ обрезан) — во втором случае слова «не сошёлся» были бы неправдой.
 * Если у разных смет причины разные, показываются обе строки.
 */
export function verificationLines(estimates: readonly ComparisonEstimateInfo[]): VerificationLine[] {
  const withSections = estimates.filter((info) => info.sectionsCount > 0);
  if (withSections.length === 0) return [];
  const lines: VerificationLine[] = [];
  const unchecked = withSections.filter((info) => !info.checked);
  if (unchecked.length === 0) {
    const includesVat = withSections.some((info) => info.totalIncludesVat === true);
    lines.push({
      ok: true,
      text: `✓ сумма разделов сходится с итогом сметы${includesVat ? " (итог указан с НДС)" : ""}`,
    });
    return lines;
  }
  if (unchecked.some((info) => info.statedTotal !== null)) {
    lines.push({
      ok: false,
      text: "⚠ итог сметы не сошёлся с разделами — суммы могли быть прочитаны не из той колонки, проверьте",
    });
  }
  if (unchecked.some((info) => info.statedTotal === null)) {
    lines.push({
      ok: false,
      text: "⚠ итог сметы в тексте не найден (документ мог быть обрезан) — суммы разделов не сверены",
    });
  }
  return lines;
}
