import { stem, tokenizeForMatch } from "@/domain/estimate/normalize";
import { parseUnit } from "@/domain/estimate/units";
import type { BillOfWorkItem, VolumeSourceLevel } from "@/domain/estimate/types";

/**
 * Повторы позиций между документами, независимо от того, чем документ прочитан.
 *
 * Зачем. Одна ведомость лежит в закупке дважды: «…-ДВ.XLS» и копия в .DOC. Один файл прочитала таблица
 * (код, строка «65\tУстройство поясов: в опалубке\tм3\t7,52»), другой — модель (строка
 * «65,Устройство поясов: в опалубке,м3,"7,52 …»). Сравнение копий по таблицам (`billItemKey`) видит только
 * код-прочитанные документы, и каждая строка попала в смету дважды: +73 % к заказчику (закупка 32616407955).
 *
 * Что значит «та же позиция». Позиции из РАЗНЫХ документов одного уровня источника совпали, когда совпали
 * нормализованное наименование, единица (с множителем) и объём (допуск 0,5 %). Номер строки в начале цитаты
 * («65») выбирает пару, когда кандидатов несколько. Внутри ОДНОГО документа повторы не трогаются никогда:
 * одинаковые строки в разных разделах («Устройство поясков … 0,1726 100 м») — законная ведомость.
 *
 * Что убирается. Документ, у которого не меньше 60 % позиций повторяют более ранний документ, снимается
 * целиком (копия файла). Иначе убираются только повторившиеся позиции. Пары один к одному: если в первом
 * документе строка стоит один раз, а во втором два, лишней считается одна.
 */

/** Допуск по объёму между копиями: форматы округляют по-разному. */
export const DUPLICATE_QUANTITY_TOLERANCE = 0.005;

/** С какой доли повторов документ считается копией другого и снимается целиком. */
export const DUPLICATE_DOCUMENT_SHARE = 0.6;

/** Позиции одного документа и уровень, который их читает в расчёт. */
export interface DedupeGroup {
  readonly document: string;
  readonly items: readonly BillOfWorkItem[];
}

export interface DedupeResult {
  /** Группы без повторов, в том же порядке; пустые группы остаются пустыми, их отбрасывает вызывающий. */
  readonly groups: readonly DedupeGroup[];
  /** Документы, чьи позиции сняты целиком. */
  readonly duplicateDocuments: readonly { readonly name: string; readonly duplicateOf: string }[];
  /** Документы, у которых убраны только повторившиеся позиции. */
  readonly partial: readonly { readonly name: string; readonly duplicateOf: string; readonly dropped: number }[];
}

/** Наименование для сравнения: слова без служебных, основы слов, без знаков и порядка записи. */
export function dedupeNameKey(name: string): string {
  return tokenizeForMatch(name).map(stem).join("");
}

/** Единица и объём в единице без множителя: «100 м» × 0,1726 и «м» × 17,26 — один объём. */
function effectiveVolume(item: Pick<BillOfWorkItem, "quantity" | "quantityUnit">): { unit: string; quantity: number } {
  const parsed = parseUnit(item.quantityUnit);
  if (parsed === null) return { unit: item.quantityUnit.trim().toLowerCase(), quantity: item.quantity };
  return { unit: parsed.unit, quantity: item.quantity * parsed.multiplier };
}

/** Номер строки в начале цитаты («65\t…», «65,…», «65 …», «65. …»): у ведомости из таблицы он стоит первым. */
export function leadingRowNumber(quote: string | null | undefined): string | null {
  if (quote == null) return null;
  const match = /^\s*(\d{1,4})(?:[\t,;|.)]|\s)/.exec(quote);
  return match?.[1] ?? null;
}

function sameQuantity(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? a === b : Math.abs(a - b) <= scale * DUPLICATE_QUANTITY_TOLERANCE;
}

interface Signature {
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly row: string | null;
}

function signatureOf(item: BillOfWorkItem): Signature {
  const volume = effectiveVolume(item);
  return {
    name: dedupeNameKey(item.workName),
    unit: volume.unit,
    quantity: volume.quantity,
    row: leadingRowNumber(item.sourceQuote) ?? item.positionNumber ?? null,
  };
}

function sameItem(a: Signature, b: Signature): boolean {
  return a.name !== "" && a.name === b.name && a.unit === b.unit && sameQuantity(a.quantity, b.quantity);
}

interface Earlier {
  readonly document: string;
  readonly signature: Signature;
}

/**
 * Сводит повторы позиций между документами. Группы идут в порядке документов; остаётся первое вхождение.
 * `levelOf` — уровень источника группы: позиции разных уровней (ведомость и смета заказчика) повторами не считаются,
 * они нужны друг другу для сверки.
 */
export function dedupeItemsAcrossDocuments(
  groups: readonly DedupeGroup[],
  levelOf: (item: BillOfWorkItem) => VolumeSourceLevel = (item) => item.sourceLevel ?? "SPEC",
): DedupeResult {
  const earlier = new Map<VolumeSourceLevel, Earlier[]>();
  const duplicateDocuments: { name: string; duplicateOf: string }[] = [];
  const partial: { name: string; duplicateOf: string; dropped: number }[] = [];
  const result: DedupeGroup[] = [];

  for (const group of groups) {
    const kept: BillOfWorkItem[] = [];
    const keptSignatures: { level: VolumeSourceLevel; signature: Signature }[] = [];
    const dropped: BillOfWorkItem[] = [];
    const sources = new Map<string, number>();
    const claimed = new Set<Earlier>();

    for (const item of group.items) {
      const level = levelOf(item);
      const signature = signatureOf(item);
      const candidates = (earlier.get(level) ?? []).filter(
        (other) => other.document !== group.document && !claimed.has(other) && sameItem(signature, other.signature),
      );
      // Номер строки выбирает пару среди нескольких одинаковых; нет совпавшего номера — берётся первая.
      const match =
        candidates.find((other) => signature.row !== null && other.signature.row === signature.row) ?? candidates[0];
      if (match === undefined) {
        kept.push(item);
        keptSignatures.push({ level, signature });
        continue;
      }
      claimed.add(match);
      dropped.push(item);
      sources.set(match.document, (sources.get(match.document) ?? 0) + 1);
    }

    const total = group.items.length;
    const origin = [...sources].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (dropped.length === 0 || origin === undefined) {
      result.push(group);
    } else if (dropped.length >= DUPLICATE_DOCUMENT_SHARE * total) {
      // Копия файла: снимается целиком, в том числе те строки, которым пары не нашлось (OCR-мусор, потерянный перенос).
      duplicateDocuments.push({ name: group.document, duplicateOf: origin });
      result.push({ document: group.document, items: [] });
      continue;
    } else {
      partial.push({ name: group.document, duplicateOf: origin, dropped: dropped.length });
      result.push({ document: group.document, items: kept });
    }

    // Сохранённые позиции становятся «ранними» для следующих документов.
    const list = (level: VolumeSourceLevel) => {
      const existing = earlier.get(level);
      if (existing !== undefined) return existing;
      const created: Earlier[] = [];
      earlier.set(level, created);
      return created;
    };
    const survivors = dropped.length === 0 ? group.items.map((item) => ({ level: levelOf(item), signature: signatureOf(item) })) : keptSignatures;
    for (const entry of survivors) list(entry.level).push({ document: group.document, signature: entry.signature });
  }

  return { groups: result, duplicateDocuments, partial };
}
