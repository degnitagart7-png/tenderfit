import { stem, uniqueTokens } from "@/domain/estimate/normalize";
import type {
  BillOfWorkItem,
  VolumeFinding,
  VolumeVariant,
} from "@/domain/estimate/types";
import { baseUnitOf } from "@/domain/estimate/units";

/**
 * Сверка ведомости со сметой заказчика.
 *
 * Когда в документации есть ведомость объёмов, объёмы расчёта берутся только из
 * неё. Смета заказчика при этом не выбрасывается: она подсказывает шифры
 * расценок (шифр из сметы точнее поиска по наименованию) и даёт повод сверить
 * цифры. Расхождение больше порога — находка «В ведомости X, в смете заказчика Y»:
 * оно ничего не меняет в сумме, а говорит человеку, какую из двух цифр
 * перепроверить перед подачей цены.
 *
 * Обратное направление. Когда смета заказчика формы 421/пр, прочитанная кодом, выше ведомости (решение
 * владельца 2026-10-10: у неё все нормы, а в ведомости нет технологических работ), основа расчёта — ЛСР, а
 * ведомость — сверка: `findBillDiscrepancies`. Находки двух видов: объём одной работы в ведомости и в ЛСР
 * расходится («В смете заказчика X, в ведомости Y — проверьте») и работа есть в ведомости, но в ЛСР её нет
 * («Работа есть в ведомости, но нет в смете заказчика» — возможно, заказчик забыл её, и участнику придётся
 * включить её в цену). Позиции ЛСР без пары в ведомости находкой не считаются: ЛСР законно содержит то, чего в
 * ведомости нет, — леса, материалы, перевозку.
 *
 * Позиции ведомости и сметы сопоставляются по шифру, по наименованию или по
 * объёму — и всегда с запасом: строки с одинаковым объёмом (505,94 т для
 * погрузки, перевозки и размещения мусора) по одному объёму не склеиваются.
 */

/** Расхождение объёмов, которое считается находкой, % от объёма сметы заказчика. */
export const VOLUME_TOLERANCE_PERCENT = 2;

/** Минимальная оценка сходства, при которой строки считаются одной позицией. */
const MIN_MATCH_SCORE = 0.5;
/** Добавка к оценке, если объёмы в одной единице совпали до процента. */
const VOLUME_BONUS = 0.25;
/** Добавка к оценке, если у строк один и тот же шифр. */
const CODE_BONUS = 1;

function nameStems(name: string): Set<string> {
  const result = new Set<string>();
  for (const token of uniqueTokens(name)) {
    if (!/[a-zа-я]/.test(token) || token.length < 3) continue;
    result.add(stem(token));
  }
  return result;
}

/**
 * Сходство наименований. Обычно это доля общих слов, но смета заказчика называет
 * работу длиннее ведомости («Разборка зданий методом обрушения: деревянных жилых
 * домов и прочих отапливаемых зданий строительного объема» против «Разборка зданий
 * деревянных жилых домов»): короткое наименование целиком входит в длинное, а
 * доля общих слов от объединения выходит ниже половины. Поэтому, если три и
 * больше слова короткого наименования найдены в длинном, оценка не ниже 0,75
 * доли вхождения.
 */
function nameSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const jaccard = shared / (a.size + b.size - shared);
  const containment = shared >= 3 ? (shared / Math.min(a.size, b.size)) * 0.75 : 0;
  return Math.max(jaccard, containment);
}

/** Объём позиции во всех единицах: основной и, у парного значения, остальные. */
export function variantsOf(item: BillOfWorkItem): readonly VolumeVariant[] {
  return item.volumeVariants ?? [{ quantity: item.quantity, unit: item.quantityUnit }];
}

/** Ближайшая пара объёмов в одной основной единице; null — единицы несравнимы. */
function closestPair(
  a: BillOfWorkItem,
  b: BillOfWorkItem,
): { left: VolumeVariant; right: VolumeVariant; diffPercent: number } | null {
  let best: { left: VolumeVariant; right: VolumeVariant; diffPercent: number } | null = null;
  for (const left of variantsOf(a)) {
    const leftUnit = baseUnitOf(left.unit);
    if (leftUnit === null) continue;
    for (const right of variantsOf(b)) {
      if (baseUnitOf(right.unit) !== leftUnit || !(right.quantity > 0)) continue;
      const diffPercent = (Math.abs(left.quantity - right.quantity) * 100) / right.quantity;
      if (best === null || diffPercent < best.diffPercent) best = { left, right, diffPercent };
    }
  }
  return best;
}

function sameCode(a: BillOfWorkItem, b: BillOfWorkItem): boolean {
  if (a.resourceCode !== null && a.resourceCode === b.resourceCode) return true;
  const left = a.normCodeHint?.code;
  const right = b.normCodeHint?.code;
  return left !== undefined && left === right;
}

interface RowMatch {
  readonly row: BillOfWorkItem | null;
  /** Лучших пар несколько и они одинаково близки: выбирать наугад нельзя. */
  readonly tie: boolean;
}

function bestMatch(item: BillOfWorkItem, rows: readonly BillOfWorkItem[]): RowMatch {
  const itemStems = nameStems(item.workName);
  let best: { row: BillOfWorkItem; score: number } | null = null;
  let tie = false;

  for (const row of rows) {
    let score = nameSimilarity(itemStems, nameStems(row.workName));
    const pair = closestPair(item, row);
    if (pair !== null && pair.diffPercent <= 1) score += VOLUME_BONUS;
    if (sameCode(item, row)) score += CODE_BONUS;
    if (score < MIN_MATCH_SCORE) continue;

    if (best === null || score > best.score + 1e-9) {
      best = { row, score };
      tie = false;
    } else if (Math.abs(score - best.score) <= 1e-9) {
      tie = true;
    }
  }
  return { row: best === null || tie ? null : best.row, tie };
}

/**
 * Строка сметы заказчика, соответствующая позиции ведомости. null — подходящей нет
 * или их несколько одинаково близких: выбирать наугад нельзя, по неверной паре
 * шифр расценки подменил бы работу.
 */
export function matchCustomerRow(
  item: BillOfWorkItem,
  rows: readonly BillOfWorkItem[],
): BillOfWorkItem | null {
  return bestMatch(item, rows).row;
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  const [whole = "0", fraction] = String(rounded).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return fraction === undefined ? grouped : `${grouped},${fraction}`;
}

/**
 * Расхождение объёма позиции ведомости с объёмом той же позиции в смете заказчика.
 * null — объёмы сошлись в пределах порога или несравнимы по единице.
 */
export function compareVolumes(
  item: BillOfWorkItem,
  customerRow: BillOfWorkItem,
): VolumeFinding | null {
  const pair = closestPair(item, customerRow);
  if (pair === null || pair.diffPercent <= VOLUME_TOLERANCE_PERCENT) return null;

  const percent = Math.round(pair.diffPercent * 10) / 10;
  return {
    workName: item.workName,
    billQuantity: pair.left.quantity,
    billUnit: pair.left.unit,
    customerQuantity: pair.right.quantity,
    customerUnit: pair.right.unit,
    diffPercent: percent,
    customerDocument: customerRow.sourceDocument,
    message:
      `В ведомости ${formatNumber(pair.left.quantity)} ${pair.left.unit}, ` +
      `в смете заказчика ${formatNumber(pair.right.quantity)} ${pair.right.unit} — ` +
      `«${item.workName}», расхождение ${formatNumber(percent)} %`,
  };
}

/** Находки по всем позициям ведомости, для которых нашлась строка сметы заказчика. */
export function findVolumeDiscrepancies(
  items: readonly BillOfWorkItem[],
  customerRows: readonly BillOfWorkItem[],
): VolumeFinding[] {
  if (customerRows.length === 0) return [];
  const findings: VolumeFinding[] = [];
  for (const item of items) {
    const row = matchCustomerRow(item, customerRows);
    if (row === null) continue;
    const finding = compareVolumes(item, row);
    if (finding !== null) findings.push(finding);
  }
  return findings;
}

/**
 * Цена заказчика для позиции ведомости: если позиция сопоставлена со строкой сметы
 * заказчика, у которой есть цена, и объёмы выражены в одной основной единице, цена
 * за единицу из сметы умножается на объём ведомости. Пара не нашлась или единицы
 * разные — позиция остаётся без цены заказчика и при отсутствии нормы выпадет.
 */
export function inheritCustomerPrice(
  item: BillOfWorkItem,
  customerRows: readonly BillOfWorkItem[],
): BillOfWorkItem {
  if (item.customerPrice != null || customerRows.length === 0) return item;
  const row = matchCustomerRow(item, customerRows);
  const price = row?.customerPrice;
  if (price == null) return item;

  const priceUnit = baseUnitOf(price.unit);
  const variant = variantsOf(item).find((candidate) => baseUnitOf(candidate.unit) === priceUnit);
  if (priceUnit === null || variant === undefined) return item;

  return {
    ...item,
    customerPrice: {
      total: Math.round(price.unitPrice * variant.quantity * 100) / 100,
      unitPrice: price.unitPrice,
      unit: price.unit,
      origin: price.origin,
      document: price.document,
    },
  };
}

/* --------------------- Обратная сверка: основа — ЛСР, ведомость — проверка --------------------- */

/**
 * Сходство наименований, ниже которого строка ЛСР точно не пара позиции ведомости. Ниже порога пары
 * (`MIN_MATCH_SCORE`) строки не склеиваются, но и «работы нет в смете» по ним говорить рано: заказчик мог назвать
 * работу иначе («Разборка» вместо «Демонтаж»). «Нет в смете» — только когда ничего похожего нет совсем.
 */
const LOOSE_NAME_SIMILARITY = 0.3;

/** Есть ли в строках ЛСР хоть что-то, что может быть этой работой: тот же шифр, похожее название или тот же объём. */
function hasPossibleCounterpart(item: BillOfWorkItem, rows: readonly BillOfWorkItem[]): boolean {
  const itemStems = nameStems(item.workName);
  for (const row of rows) {
    if (sameCode(item, row)) return true;
    const rowStems = nameStems(row.workName);
    if (nameSimilarity(itemStems, rowStems) >= LOOSE_NAME_SIMILARITY) return true;
    const pair = closestPair(item, row);
    if (pair !== null && pair.diffPercent <= 1 && [...itemStems].some((token) => rowStems.has(token))) return true;
  }
  return false;
}

/**
 * Сверка ведомости с ЛСР, на которой держится расчёт.
 *
 * - объём работы в ведомости и в ЛСР расходится больше `VOLUME_TOLERANCE_PERCENT` — находка «В смете заказчика X,
 *   в ведомости Y — проверьте»; расхождение в процентах от объёма ЛСР;
 * - работы ведомости в ЛСР нет вовсе — находка «Работа есть в ведомости, но нет в смете заказчика»;
 * - позиции ЛСР без пары в ведомости — не находка (технология, материалы, перевозка).
 *
 * На сумму расчёта находки не влияют. Пустая ЛСР или пустая ведомость — пусто.
 */
export function findBillDiscrepancies(
  lsrRows: readonly BillOfWorkItem[],
  billRows: readonly BillOfWorkItem[],
): VolumeFinding[] {
  if (lsrRows.length === 0 || billRows.length === 0) return [];
  const findings: VolumeFinding[] = [];
  const seen = new Set<string>();

  for (const bill of billRows) {
    if (!(bill.quantity > 0) || nameStems(bill.workName).size === 0) continue;
    const key = `${bill.workName.toLowerCase()}|${String(bill.quantity)}|${bill.quantityUnit}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { row, tie } = bestMatch(bill, lsrRows);
    if (row !== null) {
      const pair = closestPair(bill, row);
      if (pair === null || pair.diffPercent <= VOLUME_TOLERANCE_PERCENT) continue;
      const percent = Math.round(pair.diffPercent * 10) / 10;
      findings.push({
        kind: "VOLUME_DIFF",
        workName: bill.workName,
        billQuantity: pair.left.quantity,
        billUnit: pair.left.unit,
        customerQuantity: pair.right.quantity,
        customerUnit: pair.right.unit,
        diffPercent: percent,
        customerDocument: row.sourceDocument,
        message:
          `В смете заказчика ${formatNumber(pair.right.quantity)} ${pair.right.unit}, ` +
          `в ведомости ${formatNumber(pair.left.quantity)} ${pair.left.unit} — проверьте: ` +
          `«${bill.workName}», расхождение ${formatNumber(percent)} %`,
      });
      continue;
    }
    if (tie || hasPossibleCounterpart(bill, lsrRows)) continue;

    findings.push({
      kind: "BILL_ONLY",
      workName: bill.workName,
      billQuantity: bill.quantity,
      billUnit: bill.quantityUnit,
      customerQuantity: 0,
      customerUnit: "",
      diffPercent: 100,
      customerDocument: null,
      message:
        `Работа есть в ведомости, но нет в смете заказчика: «${bill.workName}», ` +
        `${formatNumber(bill.quantity)} ${bill.quantityUnit} — проверьте`,
    });
  }
  return findings;
}

/**
 * Все находки сверки объёмов расчёта. Строки расчёта сверяются с тем, что осталось справкой: со сметой заказчика
 * (расчёт по ведомости) и с ведомостью (расчёт по ЛСР формы 421/пр). Справка пуста — находок нет.
 */
export function crossCheckVolumes(
  items: readonly BillOfWorkItem[],
  reference: { readonly customerReference: readonly BillOfWorkItem[]; readonly billReference: readonly BillOfWorkItem[] },
): VolumeFinding[] {
  return [
    ...findVolumeDiscrepancies(items, reference.customerReference),
    ...findBillDiscrepancies(items, reference.billReference),
  ];
}
