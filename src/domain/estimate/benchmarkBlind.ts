import { documentOrder } from "@/domain/estimate/customerLsrBill";
import type { LsrSet } from "@/domain/estimate/customerLsrSet";
import { stem, tokenizeForMatch } from "@/domain/estimate/normalize";
import type { BillOfWorkSection, EstimateDocument, GeneratedKind } from "@/domain/estimate/types";
import { parseUnit } from "@/domain/estimate/units";

/**
 * Бенчмарк «вслепую»: расчёт без сметы заказчика (объёмы читает модель из ТЗ, ведомости и спецификаций) против этой самой сметы как эталона.
 *
 * Зачем. Обычный бенчмарк (`benchmark.ts`) строит ведомость из ЛСР заказчика кодом, и позиции у обеих сторон одни и те же: он проверяет цены и
 * начисления. Когда сметы заказчика нет, объёмы и нормы подбирает наш конвейер: модель читает документацию, поиск выбирает расценку, расчёт
 * считает деньги. Этот путь и проверяется здесь. Смета заказчика вырезана из входа (`estimateRemoval.ts`), а потом читается из исходных
 * документов и служит эталоном: что в ней есть, а у нас нет; что есть у нас, а в ней нет; насколько сошлись объёмы там, где нормы совпали.
 *
 * Как сопоставляются позиции. Только по шифру нормы, книга входит в шифр: «ГЭСНр 58-01-003-01» и «ГЭСНр58-01-003-01» — одна норма, «ГЭСН58-01-003-01» — другая.
 * - совпал шифр — `MATCHED`; у шифра может быть несколько позиций с каждой стороны (одна норма в разных помещениях), и объём сравнивается
 *   суммой по шифру, в единицах нормы (приведённых к базовой, «100 м2» и «м2» — одна величина);
 * - шифр не совпал, но совпала таблица (книга и первые три части шифра, «58-01-003») — `SAME_TABLE`: модель выбрала соседний вариант той же нормы;
 * - иначе `MISSING`. Для таких позиций отдельно ищется похожая по названию наша строка (`similar`): так видно, что модель выбрала другую,
 *   но равноценную норму. Похожесть на счёт `MISSING` не влияет — это подсказка, а не совпадение.
 * Наша строка, которой не нашлось пары по шифру и таблице, — «лишняя» (`extra`).
 *
 * Модуль чистый: ни диска, ни сети, ни модели. Смету заказчика и документ ему приносит скрипт `scripts/estimate-benchmark.ts --blind`.
 */

/* ------------------------------ Входы ------------------------------ */

/** Позиция сметы заказчика, как её видит сравнение. */
export interface BlindCustomerPosition {
  /** Номер сметы или её ключ в наборе. */
  readonly lsr: string | null;
  /** Метка позиции («3», «3.1»). */
  readonly label: string;
  readonly sub: boolean;
  /** Шифр как напечатан («ГЭСНр56-01-009-01», «01.7.15.03-0042», «ТЦ_…»). */
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number | null;
  /** «Всего по позиции», ₽ без НДС. */
  readonly total: number | null;
}

/** Наша строка сметы. */
export interface BlindOurLine {
  readonly itemId: string;
  readonly normBaseType: string;
  readonly normCode: string;
  readonly normName: string;
  readonly normUnit: string;
  /** Объём в единицах нормы. */
  readonly quantity: number;
  readonly billQuantity: number;
  readonly billUnit: string;
  /** Прямые + НР + СП, ₽ без НДС. */
  readonly total: number;
  readonly sourceQuote: string | null;
  readonly sourceDocument: string | null;
  readonly priceSource: string | null;
  /**
   * Строка добавлена расчётом или ИИ сверх ведомости (`BillOfWorkItem.generated`): мусор по нормам или работа по технологии. Такие строки идут в общее
   * сравнение наравне с остальными и, кроме того, перечислены отдельно (`BlindComparison.generated`). Нет поля — строка из документа.
   */
  readonly generated?: GeneratedKind | null;
}

/** Добавленная расчётом строка, у которой нет цены, а значит, нет и строки сметы: расстояния до полигона нет, тариф неизвестен. */
export interface BlindGeneratedUnpriced {
  readonly itemId: string;
  readonly kind: GeneratedKind;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly reason: string | null;
}

export interface BlindInput {
  readonly customer: readonly BlindCustomerPosition[];
  readonly ours: readonly BlindOurLine[];
  /** Стоимость СМР нашего документа без НДС (`totals.workCost`). */
  readonly ourWorkTotal: number;
  /** Σ «ВСЕГО по смете» без НДС по сметам заказчика; null — итогов в смете нет. */
  readonly customerLsrTotal: number | null;
  /** Добавленные расчётом строки без цены (нет строки сметы); нет поля — таких нет или расчёт не различал. */
  readonly generatedUnpriced?: readonly BlindGeneratedUnpriced[];
}

export interface BlindOptions {
  /** Сколько крупнейших разрывов оставить (по умолчанию 15). */
  readonly topN?: number;
  /** Порог похожести названий (коэффициент Сёренсена — Дайса); по умолчанию 0,5. */
  readonly similarity?: number;
  /** Допуск отношения объёмов: за его пределами пара считается расхождением по объёму; по умолчанию 0,1. */
  readonly quantityTolerance?: number;
}

export const DEFAULT_BLIND_TOP = 15;
export const DEFAULT_SIMILARITY = 0.5;
export const DEFAULT_QUANTITY_TOLERANCE = 0.1;
/** Запас на двоичную арифметику: отношение 1,1 при допуске 0,1 — в допуске. */
const EPSILON = 1e-9;

/* ------------------------------ Шифры ------------------------------ */

const NORM_CODE_RE = /(ГЭСН|ФЕР|ТЕР)\s*(МР|М|Р|П)?\s*[-–]?\s*(\d{2}-\d{2}-\d{3}-\d{2})(?![\d-])/iu;
const BARE_NORM_RE = /(?<![\d.-])(\d{2}-\d{2}-\d{3}-\d{2})(?![\d-])/u;
const RESOURCE_CODE_RE = /(?<![\d.])(\d{2}\.\d\.\d{2}\.\d{2}-\d{4}|\d{2}\.\d{2}\.\d{2}-\d{3})(?![\d-])/u;
const SUFFIX: Readonly<Record<string, string>> = { МР: "мр", М: "м", Р: "р", П: "п" };

/**
 * Шифр в каноническом виде: книга и код слитно, «ГЭСНр58-01-003-01». Нет книги — код без неё; у ресурса ФСНБ (материал, машина) — сам код.
 * null — шифра нет (цена заказчика «ТЦ_…», «КА», прочерк).
 */
export function canonicalCode(raw: string): string | null {
  const text = raw.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
  const norm = NORM_CODE_RE.exec(text);
  if (norm !== null) return `${(norm[1] as string).toUpperCase()}${SUFFIX[(norm[2] ?? "").toUpperCase()] ?? ""}${norm[3] as string}`;
  const bare = BARE_NORM_RE.exec(text);
  if (bare !== null) return bare[1] as string;
  const resource = RESOURCE_CODE_RE.exec(text);
  return resource === null ? null : (resource[1] as string);
}

/** Таблица нормы: книга и первые три части шифра («ГЭСНр58-01-003»); у ресурса и шифра без четырёх частей таблицы нет. */
export function tableOfCode(code: string | null): string | null {
  if (code === null) return null;
  const match = /^(ГЭСН(?:мр|м|р|п)?|ФЕР(?:мр|м|р|п)?|ТЕР(?:мр|м|р|п)?)?(\d{2}-\d{2}-\d{3})-\d{2}$/u.exec(code);
  return match === null ? null : `${match[1] ?? ""}${match[2] as string}`;
}

/* ------------------------------ Объёмы и названия ------------------------------ */

/** Объём в базовой единице («100 м2» × 1,2 → 120 м2) и сама единица; null — единица не распознана. */
function baseQuantity(quantity: number | null, unit: string): { readonly unit: string; readonly value: number } | null {
  if (quantity === null) return null;
  const parsed = parseUnit(unit);
  return parsed === null ? null : { unit: parsed.unit, value: quantity * parsed.multiplier };
}

/** Отношение наш/заказчика по суммам объёмов в базовой единице; null — единицы не распознаны или различаются, объём заказчика нулевой или неизвестен. */
function quantityRatio(customer: readonly BlindCustomerPosition[], ours: readonly BlindOurLine[]): { readonly ratio: number | null; readonly unit: string | null; readonly customerQuantity: number | null; readonly ourQuantity: number | null } {
  let unit: string | null = null;
  let customerSum = 0;
  let known = true;
  for (const position of customer) {
    const base = baseQuantity(position.quantity, position.unit);
    if (base === null || (unit !== null && unit !== base.unit)) {
      known = false;
      break;
    }
    unit = base.unit;
    customerSum += base.value;
  }
  let ourSum = 0;
  if (known) {
    for (const line of ours) {
      const base = baseQuantity(line.quantity, line.normUnit);
      if (base === null || unit === null || unit !== base.unit) {
        known = false;
        break;
      }
      ourSum += base.value;
    }
  }
  if (!known || unit === null) return { ratio: null, unit: null, customerQuantity: null, ourQuantity: null };
  return { ratio: customerSum === 0 ? null : round(ourSum / customerSum, 4), unit, customerQuantity: round(customerSum, 4), ourQuantity: round(ourSum, 4) };
}

function tokenSet(text: string): Set<string> {
  return new Set(
    tokenizeForMatch(text)
      .filter((token) => token.length > 1 && !/^\d+(?:[.,]\d+)*$/.test(token))
      .map((token) => stem(token)),
  );
}

/** Похожесть названий: коэффициент Сёренсена — Дайса на основах слов (числа и служебные слова не считаются); 0 — общего нет. */
export function nameSimilarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return round((2 * common) / (a.size + b.size), 4);
}

function commonTokens(left: string, right: string): number {
  const b = tokenSet(right);
  let common = 0;
  for (const token of tokenSet(left)) if (b.has(token)) common += 1;
  return common;
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/* ------------------------------ Результат ------------------------------ */

export type PositionStatus = "MATCHED" | "SAME_TABLE" | "MISSING";

/** Похожая по названию строка с другой стороны. */
export interface SimilarByName {
  readonly side: "OURS" | "CUSTOMER";
  /** Шифр, название и итог похожей строки. */
  readonly code: string | null;
  readonly name: string;
  readonly total: number | null;
  readonly score: number;
  /** Метка позиции заказчика или идентификатор нашей строки. */
  readonly ref: string;
}

export interface PositionResult {
  readonly position: BlindCustomerPosition;
  readonly code: string | null;
  readonly status: PositionStatus;
  /** Наши строки, по которым найдена пара: с тем же шифром (`MATCHED`) или из той же таблицы (`SAME_TABLE`). */
  readonly ourItemIds: readonly string[];
  /** Отношение объёмов по шифру или таблице целиком; null — не определено. */
  readonly quantityRatio: number | null;
  /** `MISSING`: ближайшая по названию наша строка, если она похожа достаточно. */
  readonly similar: SimilarByName | null;
}

export interface ExtraLine {
  readonly line: BlindOurLine;
  readonly code: string | null;
  /** Ближайшая по названию позиция заказчика без пары по шифру. */
  readonly similar: SimilarByName | null;
}

/** Группа сравнения: один шифр или одна таблица — позиции заказчика и наши строки, посчитанные вместе. */
export interface CodeGroup {
  readonly scope: "CODE" | "TABLE";
  readonly key: string;
  readonly customerLabels: readonly string[];
  readonly ourItemIds: readonly string[];
  readonly unit: string | null;
  readonly customerQuantity: number | null;
  readonly ourQuantity: number | null;
  readonly ratio: number | null;
  readonly customerTotal: number;
  readonly ourTotal: number;
}

export type GapKind = "MISSING" | "EXTRA" | "QUANTITY" | "VARIANT" | "PRICE";

export interface GapSide {
  readonly code: string | null;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number | null;
  readonly total: number | null;
  readonly ref: string;
}

export interface GapOurSide extends GapSide {
  readonly sourceQuote: string | null;
  readonly sourceDocument: string | null;
  readonly priceSource: string | null;
}

export interface Gap {
  readonly kind: GapKind;
  /** Размер разрыва, ₽: |итог заказчика| у недостающих, |наш итог| у лишних, |разница итогов| у остальных. */
  readonly rub: number;
  /** Позиция заказчика (у группы — самая дорогая из группы) и сколько позиций в группе. */
  readonly customer: GapSide | null;
  readonly customerPositions: number;
  readonly ours: readonly GapOurSide[];
  readonly ratio: number | null;
  readonly similar: SimilarByName | null;
}

export interface KindCoverage {
  readonly positions: number;
  readonly customerTotal: number;
  readonly matchedRub: number;
  readonly sameTableRub: number;
  readonly missingRub: number;
}

export interface BlindCoverage {
  readonly customerPositions: number;
  readonly matched: number;
  readonly sameTable: number;
  readonly missing: number;
  /** Из недостающих: у скольких есть похожая по названию наша строка. */
  readonly missingSimilar: number;
  readonly extra: number;
  readonly extraSimilar: number;
  /** Вес в рублях: Σ |«Всего по позиции»| заказчика; позиция без итога весит ноль. */
  readonly customerWeight: number;
  readonly matchedRub: number;
  readonly sameTableRub: number;
  readonly missingRub: number;
  readonly missingSimilarRub: number;
  readonly extraRub: number;
  /** Доли от веса сметы заказчика, %. */
  readonly matchedPercent: number | null;
  readonly matchedOrTablePercent: number | null;
  readonly missingPercent: number | null;
  readonly extraPercent: number | null;
  /** То же отдельно для работ (шифр нормы ГЭСН/ФЕР/ТЕР) и для остального (материалы, оборудование, цены заказчика). */
  readonly byKind: { readonly WORK: KindCoverage; readonly OTHER: KindCoverage };
}

export interface QuantityStats {
  /** Групп (шифров) с известным отношением объёмов. */
  readonly groups: number;
  readonly median: number | null;
  readonly p25: number | null;
  readonly p75: number | null;
  /** Доля групп с отношением в пределах допуска, %. */
  readonly withinTolerancePercent: number | null;
}

export interface BlindTotals {
  readonly ourWorkTotal: number;
  readonly ourLinesTotal: number;
  readonly customerPositionsTotal: number;
  readonly customerLsrTotal: number | null;
  readonly deltaVsPositions: number;
  readonly deltaPercentVsPositions: number | null;
  readonly deltaVsLsr: number | null;
  readonly deltaPercentVsLsr: number | null;
}

export interface BlindComparison {
  readonly totals: BlindTotals;
  readonly coverage: BlindCoverage;
  readonly quantity: QuantityStats;
  readonly positions: readonly PositionResult[];
  readonly extras: readonly ExtraLine[];
  readonly groups: readonly CodeGroup[];
  readonly gaps: readonly Gap[];
  /** Строки, добавленные расчётом и ИИ сверх ведомости, отдельно: совпали ли они с позициями заказчика (например, ГЭСН08-07-001-02 «леса»). */
  readonly generated: GeneratedComparison;
}

export type GeneratedStatus = "MATCHED" | "SAME_TABLE" | "NOT_IN_CUSTOMER";

/** Одна добавленная строка и её судьба в сравнении. */
export interface GeneratedLineResult {
  readonly itemId: string;
  readonly kind: GeneratedKind;
  readonly code: string | null;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  /** Прямые + НР + СП, ₽ без НДС. */
  readonly total: number;
  /** `MATCHED` — шифр нормы есть в смете заказчика; `SAME_TABLE` — та же таблица, другой вариант; `NOT_IN_CUSTOMER` — у заказчика такой позиции нет. */
  readonly status: GeneratedStatus;
  /** Самая дорогая позиция заказчика, с которой строка встала в пару; null — пары нет. */
  readonly customer: GapSide | null;
  /** Отношение объёмов (мы / заказчик) по шифру или таблице целиком; null — не определено. */
  readonly quantityRatio: number | null;
  /** `NOT_IN_CUSTOMER`: ближайшая по названию позиция заказчика без пары по шифру, если она похожа достаточно. */
  readonly similar: SimilarByName | null;
  /** Пояснение строки: как получен объём («мусор по нормам …», «добавлено ИИ: …; объём = …»). */
  readonly note: string | null;
}

export interface GeneratedKindTotals {
  readonly count: number;
  readonly total: number;
}

export interface GeneratedComparison {
  readonly lines: readonly GeneratedLineResult[];
  /** Добавленные строки без цены: в сметe их стоимости нет. */
  readonly unpriced: readonly BlindGeneratedUnpriced[];
  readonly count: number;
  /** Σ стоимости добавленных строк, ₽ без НДС. */
  readonly total: number;
  readonly matched: number;
  readonly sameTable: number;
  readonly notInCustomer: number;
  /** Стоимость добавленных строк, у которых нашлась пара у заказчика, и вес этих позиций заказчика, ₽. */
  readonly matchedRub: number;
  readonly customerMatchedRub: number;
  readonly byKind: Readonly<Record<GeneratedKind, GeneratedKindTotals>>;
  /** Наш итог СМР без добавленных строк и его отклонение от суммы позиций заказчика, %: что дала бы смета без этих этапов. */
  readonly ourWorkTotalWithoutGenerated: number;
  readonly deltaPercentWithoutGenerated: number | null;
}

/* ------------------------------ Сравнение ------------------------------ */

const weightOf = (position: BlindCustomerPosition): number => Math.abs(position.total ?? 0);
const sumTotal = (positions: readonly BlindCustomerPosition[]): number => positions.reduce((sum, position) => sum + (position.total ?? 0), 0);
const sumOurs = (lines: readonly BlindOurLine[]): number => lines.reduce((sum, line) => sum + line.total, 0);

function percentOf(delta: number, base: number | null): number | null {
  if (base === null || base === 0) return null;
  return round((delta / Math.abs(base)) * 100);
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return round((sorted[low] as number) + ((sorted[high] as number) - (sorted[low] as number)) * (at - low), 4);
}

function customerSide(position: BlindCustomerPosition): GapSide {
  return { code: position.code === "" ? null : position.code, name: position.name, unit: position.unit, quantity: position.quantity, total: position.total, ref: position.lsr === null ? position.label : `${position.lsr} поз. ${position.label}` };
}

function ourSide(line: BlindOurLine): GapOurSide {
  return {
    code: `${line.normBaseType} ${line.normCode}`.trim(),
    name: line.normName,
    unit: line.normUnit,
    quantity: line.quantity,
    total: line.total,
    ref: line.itemId,
    sourceQuote: line.sourceQuote,
    sourceDocument: line.sourceDocument,
    priceSource: line.priceSource,
  };
}

function groupBy<T>(items: readonly T[], key: (item: T, index: number) => string | null): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const [index, item] of items.entries()) {
    const k = key(item, index);
    if (k === null) continue;
    const list = result.get(k);
    if (list === undefined) result.set(k, [item]);
    else list.push(item);
  }
  return result;
}

interface GroupDraft {
  readonly scope: "CODE" | "TABLE";
  readonly key: string;
  readonly members: readonly BlindCustomerPosition[];
  readonly lines: readonly BlindOurLine[];
}

function toGroup(draft: GroupDraft): { readonly group: CodeGroup; readonly ratio: number | null } {
  const quantity = quantityRatio(draft.members, draft.lines);
  return {
    ratio: quantity.ratio,
    group: {
      scope: draft.scope,
      key: draft.key,
      customerLabels: draft.members.map((position) => position.label),
      ourItemIds: draft.lines.map((line) => line.itemId),
      unit: quantity.unit,
      customerQuantity: quantity.customerQuantity,
      ourQuantity: quantity.ourQuantity,
      ratio: quantity.ratio,
      customerTotal: round(sumTotal(draft.members)),
      ourTotal: round(sumOurs(draft.lines)),
    },
  };
}

/**
 * Сравнение нашего расчёта «вслепую» со сметой заказчика (см. шапку файла). Не меняет входы; порядок позиций и строк сохраняется.
 */
export function compareBlind(input: BlindInput, options: BlindOptions = {}): BlindComparison {
  const topN = options.topN ?? DEFAULT_BLIND_TOP;
  const threshold = options.similarity ?? DEFAULT_SIMILARITY;
  const tolerance = options.quantityTolerance ?? DEFAULT_QUANTITY_TOLERANCE;

  const customerCodes = new Map(input.customer.map((position) => [position, canonicalCode(position.code)] as const));
  const ourCodes = new Map(input.ours.map((line) => [line, canonicalCode(`${line.normBaseType} ${line.normCode}`)] as const));

  const drafts: GroupDraft[] = [];
  const found = new Map<BlindCustomerPosition, { status: PositionStatus; ourItemIds: string[]; ratio: number | null }>();
  const claimed = new Set<BlindOurLine>();

  const settle = (draft: GroupDraft, status: PositionStatus): void => {
    const { group, ratio } = toGroup(draft);
    drafts.push(draft);
    for (const line of draft.lines) claimed.add(line);
    for (const position of draft.members) found.set(position, { status, ourItemIds: [...group.ourItemIds], ratio });
  };

  // 1. Совпал шифр.
  const oursByCode = groupBy(input.ours, (line) => ourCodes.get(line) ?? null);
  for (const [code, members] of groupBy(input.customer, (position) => customerCodes.get(position) ?? null)) {
    const lines = oursByCode.get(code);
    if (lines !== undefined) settle({ scope: "CODE", key: code, members, lines }, "MATCHED");
  }

  // 2. Та же таблица, другой вариант: только строки, которые не стали парой по шифру.
  const freeByTable = groupBy(
    input.ours.filter((line) => !claimed.has(line)),
    (line) => tableOfCode(ourCodes.get(line) ?? null),
  );
  const unmatchedByTable = groupBy(
    input.customer.filter((position) => !found.has(position)),
    (position) => tableOfCode(customerCodes.get(position) ?? null),
  );
  for (const [table, members] of unmatchedByTable) {
    const lines = freeByTable.get(table);
    if (lines !== undefined) settle({ scope: "TABLE", key: table, members, lines }, "SAME_TABLE");
  }

  // 3. Похожие по названию: недостающие позиции заказчика и лишние строки, один к одному, по убыванию похожести.
  const missing = input.customer.filter((position) => !found.has(position));
  const extraLines = input.ours.filter((line) => !claimed.has(line));
  const candidates: { position: BlindCustomerPosition; line: BlindOurLine; score: number }[] = [];
  for (const position of missing) {
    for (const line of extraLines) {
      let best = 0;
      let bestText = line.normName;
      for (const text of [line.normName, line.sourceQuote ?? ""]) {
        const score = nameSimilarity(position.name, text);
        if (score > best) {
          best = score;
          bestText = text;
        }
      }
      if (best >= threshold && commonTokens(position.name, bestText) >= 2) candidates.push({ position, line, score: best });
    }
  }
  candidates.sort((a, b) => b.score - a.score || weightOf(b.position) - weightOf(a.position));
  const similarOfPosition = new Map<BlindCustomerPosition, SimilarByName>();
  const similarOfLine = new Map<BlindOurLine, SimilarByName>();
  for (const { position, line, score } of candidates) {
    if (similarOfPosition.has(position) || similarOfLine.has(line)) continue;
    similarOfPosition.set(position, { side: "OURS", code: `${line.normBaseType} ${line.normCode}`.trim(), name: line.normName, total: line.total, score, ref: line.itemId });
    similarOfLine.set(line, { side: "CUSTOMER", code: position.code === "" ? null : position.code, name: position.name, total: position.total, score, ref: customerSide(position).ref });
  }

  const positions: PositionResult[] = input.customer.map((position) => {
    const hit = found.get(position);
    return {
      position,
      code: customerCodes.get(position) ?? null,
      status: hit?.status ?? "MISSING",
      ourItemIds: hit?.ourItemIds ?? [],
      quantityRatio: hit?.ratio ?? null,
      similar: hit === undefined ? (similarOfPosition.get(position) ?? null) : null,
    };
  });
  const extras: ExtraLine[] = extraLines.map((line) => ({ line, code: ourCodes.get(line) ?? null, similar: similarOfLine.get(line) ?? null }));
  const groups = drafts.map((draft) => toGroup(draft).group);

  const coverage = coverageOf(positions, extras);
  const gaps = gapsOf({ positions, extras, drafts, tolerance }).slice(0, topN);

  const ratios = groups
    .filter((group) => group.scope === "CODE" && group.ratio !== null)
    .map((group) => group.ratio as number)
    .sort((a, b) => a - b);
  const within = ratios.filter((ratio) => Math.abs(ratio - 1) <= tolerance + EPSILON).length;
  const quantity: QuantityStats = {
    groups: ratios.length,
    median: quantile(ratios, 0.5),
    p25: quantile(ratios, 0.25),
    p75: quantile(ratios, 0.75),
    withinTolerancePercent: ratios.length === 0 ? null : round((within / ratios.length) * 100),
  };

  const customerPositionsTotal = round(sumTotal(input.customer));
  const deltaVsPositions = round(input.ourWorkTotal - customerPositionsTotal);
  const deltaVsLsr = input.customerLsrTotal === null ? null : round(input.ourWorkTotal - input.customerLsrTotal);
  const totals: BlindTotals = {
    ourWorkTotal: round(input.ourWorkTotal),
    ourLinesTotal: round(sumOurs(input.ours)),
    customerPositionsTotal,
    customerLsrTotal: input.customerLsrTotal === null ? null : round(input.customerLsrTotal),
    deltaVsPositions,
    deltaPercentVsPositions: percentOf(deltaVsPositions, customerPositionsTotal),
    deltaVsLsr,
    deltaPercentVsLsr: deltaVsLsr === null ? null : percentOf(deltaVsLsr, input.customerLsrTotal),
  };

  const generated = generatedOf({ ours: input.ours, positions, extras, unpriced: input.generatedUnpriced ?? [], ourWorkTotal: input.ourWorkTotal, customerPositionsTotal });

  return { totals, coverage, quantity, positions, extras, groups, gaps, generated };
}

function generatedOf(context: {
  readonly ours: readonly BlindOurLine[];
  readonly positions: readonly PositionResult[];
  readonly extras: readonly ExtraLine[];
  readonly unpriced: readonly BlindGeneratedUnpriced[];
  readonly ourWorkTotal: number;
  readonly customerPositionsTotal: number;
}): GeneratedComparison {
  const lines: GeneratedLineResult[] = [];
  const byKind: Record<GeneratedKind, { count: number; total: number }> = { AI_IMPLIED: { count: 0, total: 0 }, DEBRIS: { count: 0, total: 0 } };
  let matched = 0;
  let sameTable = 0;
  let notInCustomer = 0;
  let matchedRub = 0;
  const customerMatched = new Set<BlindCustomerPosition>();

  for (const line of context.ours) {
    if (line.generated === undefined || line.generated === null) continue;
    const pairs = context.positions.filter((result) => result.status !== "MISSING" && result.ourItemIds.includes(line.itemId));
    const best = pairs.slice().sort((a, b) => weightOf(b.position) - weightOf(a.position))[0];
    const status: GeneratedStatus = best === undefined ? "NOT_IN_CUSTOMER" : best.status === "MATCHED" ? "MATCHED" : "SAME_TABLE";
    const extra = context.extras.find((candidate) => candidate.line === line);
    for (const pair of pairs) customerMatched.add(pair.position);
    if (status === "MATCHED") matched += 1;
    else if (status === "SAME_TABLE") sameTable += 1;
    else notInCustomer += 1;
    if (status !== "NOT_IN_CUSTOMER") matchedRub += line.total;
    byKind[line.generated].count += 1;
    byKind[line.generated].total += line.total;
    lines.push({
      itemId: line.itemId,
      kind: line.generated,
      code: `${line.normBaseType} ${line.normCode}`.trim() || null,
      name: line.normName,
      unit: line.normUnit,
      quantity: line.quantity,
      total: round(line.total),
      status,
      customer: best === undefined ? null : customerSide(best.position),
      quantityRatio: best?.quantityRatio ?? null,
      similar: status === "NOT_IN_CUSTOMER" ? (extra?.similar ?? null) : null,
      note: line.sourceQuote,
    });
  }

  const total = lines.reduce((sum, line) => sum + line.total, 0);
  const withoutGenerated = round(context.ourWorkTotal - total);
  return {
    lines,
    unpriced: context.unpriced,
    count: lines.length,
    total: round(total),
    matched,
    sameTable,
    notInCustomer,
    matchedRub: round(matchedRub),
    customerMatchedRub: round([...customerMatched].reduce((sum, position) => sum + weightOf(position), 0)),
    byKind: {
      AI_IMPLIED: { count: byKind.AI_IMPLIED.count, total: round(byKind.AI_IMPLIED.total) },
      DEBRIS: { count: byKind.DEBRIS.count, total: round(byKind.DEBRIS.total) },
    },
    ourWorkTotalWithoutGenerated: withoutGenerated,
    deltaPercentWithoutGenerated: percentOf(withoutGenerated - context.customerPositionsTotal, context.customerPositionsTotal),
  };
}

function kindOf(result: PositionResult): "WORK" | "OTHER" {
  return tableOfCode(result.code) === null ? "OTHER" : "WORK";
}

function coverageOf(positions: readonly PositionResult[], extras: readonly ExtraLine[]): BlindCoverage {
  const empty = (): { positions: number; customerTotal: number; matchedRub: number; sameTableRub: number; missingRub: number } => ({ positions: 0, customerTotal: 0, matchedRub: 0, sameTableRub: 0, missingRub: 0 });
  const kinds = { WORK: empty(), OTHER: empty() };
  let matched = 0;
  let sameTable = 0;
  let missing = 0;
  let missingSimilar = 0;
  let matchedRub = 0;
  let sameTableRub = 0;
  let missingRub = 0;
  let missingSimilarRub = 0;

  for (const result of positions) {
    const weight = weightOf(result.position);
    const kind = kinds[kindOf(result)];
    kind.positions += 1;
    kind.customerTotal += weight;
    if (result.status === "MATCHED") {
      matched += 1;
      matchedRub += weight;
      kind.matchedRub += weight;
    } else if (result.status === "SAME_TABLE") {
      sameTable += 1;
      sameTableRub += weight;
      kind.sameTableRub += weight;
    } else {
      missing += 1;
      missingRub += weight;
      kind.missingRub += weight;
      if (result.similar !== null) {
        missingSimilar += 1;
        missingSimilarRub += weight;
      }
    }
  }
  const customerWeight = matchedRub + sameTableRub + missingRub;
  const extraRub = extras.reduce((sum, extra) => sum + Math.abs(extra.line.total), 0);
  const share = (value: number): number | null => (customerWeight === 0 ? null : round((value / customerWeight) * 100));
  const finish = (kind: ReturnType<typeof empty>): KindCoverage => ({
    positions: kind.positions,
    customerTotal: round(kind.customerTotal),
    matchedRub: round(kind.matchedRub),
    sameTableRub: round(kind.sameTableRub),
    missingRub: round(kind.missingRub),
  });
  return {
    customerPositions: positions.length,
    matched,
    sameTable,
    missing,
    missingSimilar,
    extra: extras.length,
    extraSimilar: extras.filter((extra) => extra.similar !== null).length,
    customerWeight: round(customerWeight),
    matchedRub: round(matchedRub),
    sameTableRub: round(sameTableRub),
    missingRub: round(missingRub),
    missingSimilarRub: round(missingSimilarRub),
    extraRub: round(extraRub),
    matchedPercent: share(matchedRub),
    matchedOrTablePercent: share(matchedRub + sameTableRub),
    missingPercent: share(missingRub),
    extraPercent: share(extraRub),
    byKind: { WORK: finish(kinds.WORK), OTHER: finish(kinds.OTHER) },
  };
}

function gapsOf(context: {
  readonly positions: readonly PositionResult[];
  readonly extras: readonly ExtraLine[];
  readonly drafts: readonly GroupDraft[];
  readonly tolerance: number;
}): Gap[] {
  const { positions, extras, drafts, tolerance } = context;
  const gaps: Gap[] = [];

  for (const result of positions) {
    if (result.status !== "MISSING") continue;
    gaps.push({ kind: "MISSING", rub: round(weightOf(result.position)), customer: customerSide(result.position), customerPositions: 1, ours: [], ratio: null, similar: result.similar });
  }
  for (const extra of extras) {
    gaps.push({ kind: "EXTRA", rub: round(Math.abs(extra.line.total)), customer: null, customerPositions: 0, ours: [ourSide(extra.line)], ratio: null, similar: extra.similar });
  }

  for (const draft of drafts) {
    const { group } = toGroup(draft);
    const diff = group.ourTotal - group.customerTotal;
    const rub = round(Math.abs(diff));
    const quantityOff = group.ratio !== null && Math.abs(group.ratio - 1) > tolerance + EPSILON;
    const kind: GapKind | null = group.scope === "TABLE" ? "VARIANT" : quantityOff ? "QUANTITY" : Math.abs(diff) > Math.abs(group.customerTotal) * tolerance + EPSILON ? "PRICE" : null;
    if (kind === null || rub === 0) continue;
    const biggest = draft.members.slice().sort((a, b) => weightOf(b) - weightOf(a))[0];
    gaps.push({
      kind,
      rub,
      customer: biggest === undefined ? null : customerSide(biggest),
      customerPositions: draft.members.length,
      ours: draft.lines.map(ourSide),
      ratio: group.ratio,
      similar: null,
    });
  }

  return gaps.sort((a, b) => b.rub - a.rub);
}

/* ------------------------------ Адаптеры ------------------------------ */

/** Все позиции и подпозиции смет заказчика в порядке документа (как их сравнивает обычный бенчмарк). */
export function customerPositionsOf(lsrSet: LsrSet): BlindCustomerPosition[] {
  const result: BlindCustomerPosition[] = [];
  for (const entry of lsrSet.entries) {
    for (const position of documentOrder(entry)) {
      result.push({
        lsr: entry.number ?? entry.key,
        label: position.label ?? String(position.number),
        sub: position.sub === true,
        code: position.code !== "" ? position.code : (position.rawJustification.split("\n")[0] ?? "").replace(/\s+/g, " ").trim(),
        name: position.name.replace(/\s+/g, " ").trim(),
        unit: position.unit,
        quantity: position.quantity,
        total: position.total ?? position.ownTotal,
      });
    }
  }
  return result;
}

/**
 * Добавленные расчётом строки ведомости, у которых нет строки в сметном документе (цены нет): для отчёта о том, что добавлено, но не посчитано.
 * Причина — `generatedUnpricedReason`; если её нет (строку не взял расчёт по другой причине), причина не названа.
 */
export function generatedUnpricedOf(
  sections: readonly BillOfWorkSection[],
  document: Pick<EstimateDocument, "sections">,
): BlindGeneratedUnpriced[] {
  const priced = new Set(document.sections.flatMap((section) => section.lines.map((line) => line.itemId)));
  return sections
    .flatMap((section) => section.items)
    .filter((item) => item.generated !== undefined && !priced.has(item.id))
    .map((item) => ({
      itemId: item.id,
      kind: item.generated as GeneratedKind,
      name: item.workName,
      unit: item.quantityUnit,
      quantity: item.quantity,
      reason: item.generatedUnpricedReason ?? null,
    }));
}

/**
 * Строки нашего документа в виде для сравнения. `items` — позиции ведомости расчёта: по ним строки, добавленные расчётом, получают признак `generated`
 * (в строке сметы его нет). Без них все строки считаются строками документа.
 */
export function ourLinesOf(
  document: Pick<EstimateDocument, "sections">,
  items: readonly Pick<BillOfWorkSection["items"][number], "id" | "generated">[] = [],
): BlindOurLine[] {
  const generated = new Map<string, GeneratedKind>();
  for (const item of items) if (item.generated !== undefined) generated.set(item.id, item.generated);
  const result: BlindOurLine[] = [];
  for (const section of document.sections) {
    for (const line of section.lines) {
      result.push({
        itemId: line.itemId,
        normBaseType: line.normBaseType,
        normCode: line.normCode,
        normName: line.normName,
        normUnit: line.normUnit,
        quantity: line.quantity,
        billQuantity: line.billQuantity,
        billUnit: line.billUnit,
        total: round(line.directCost + line.overheadCost + line.profitCost),
        sourceQuote: line.sourceQuote,
        sourceDocument: line.sourceDocument,
        priceSource: line.priceSource ?? null,
        ...(generated.has(line.itemId) ? { generated: generated.get(line.itemId) as GeneratedKind } : {}),
      });
    }
  }
  return result;
}
