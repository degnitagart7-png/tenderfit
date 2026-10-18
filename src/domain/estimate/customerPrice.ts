/**
 * Цена позиции из сметы заказчика.
 *
 * Зачем. Если нашей нормы или цены на позицию нет, позиция выпадала из итога, и
 * итог становился «нижней границей». Но заказчик уже посчитал эту позицию в своей
 * смете, и его число — лучше нуля: оно входит в итог с пометкой «по цене
 * заказчика — не проверено нашими ценами» и считается допущением.
 *
 * Что берётся. Только смета в текущем уровне цен: сумма базисного уровня
 * несопоставима с нашими ценами. Только сумма без НДС: в локальной смете НДС
 * стоит отдельно, внизу.
 *
 * Откуда. Первый источник — сама строка позиции: у поставки и услуги в ней стоят
 * цена за единицу и сумма, и сумма обязана равняться объёму × цене. Это проверка
 * против OCR: распознавание путает цифры, и строка «Всего по позиции 220 775,12»
 * под строкой «505,94 × 831,67 = 420 775,12» не должна победить. Второй — строка
 * «Всего по позиции» после ресурсов работы, её последнее число (первое — базисный
 * уровень, если он напечатан).
 */

/**
 * Смета составлена в текущем уровне цен. Явное «Составлен(а) в текущем уровне цен»;
 * базисный или базовый уровень хоть в одной смете документа — отказ: числа
 * разных уровней в одном документе не различить.
 */
export function declaresCurrentPrices(text: string): boolean {
  let current = false;
  const declaration = /составлен\p{L}*\s*(?:\([а-я]\))?\s*в\s+(текущ\p{L}*|базис\p{L}*|базов\p{L}*)\s+уровне\s+цен/giu;
  for (const match of text.matchAll(declaration)) {
    const level = (match[1] as string).toLowerCase();
    if (level.startsWith("текущ")) current = true;
    else return false;
  }
  return current;
}

/** Числа строки: «1 740,33», «76 768,41», «34,7», «295.01». Разряды отделены пробелом. */
const NUMBER_IN_LINE = /(?<![\d.,])(?:\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,]\d+)?(?![\d])/g;

export function numbersOf(segment: string): number[] {
  const result: number[] = [];
  for (const match of segment.matchAll(NUMBER_IN_LINE)) {
    const value = Number.parseFloat(match[0].replace(/[\s ]/g, "").replace(",", "."));
    if (Number.isFinite(value)) result.push(value);
  }
  return result;
}

/**
 * Пара «цена за единицу, сумма» среди чисел строки, для которой объём × цена даёт
 * сумму. Берётся самая правая пара: сумма стоит в конце строки. Единица (1) как
 * цена и сумма, равная объёму, — коэффициент и повтор графы, а не цена.
 */
export function priceFromLine(
  printedQuantity: number,
  pool: readonly number[],
): { unitPrice: number; total: number } | null {
  let found: { unitPrice: number; total: number } | null = null;
  for (let i = 0; i < pool.length; i += 1) {
    const price = pool[i] as number;
    if (price <= 1 || Math.abs(price - printedQuantity) < 1e-9) continue;
    for (let j = i + 1; j < pool.length; j += 1) {
      const total = pool[j] as number;
      if (total <= price || Math.abs(total - printedQuantity) < 1e-9) continue;
      if (Math.abs(printedQuantity * price - total) <= Math.max(0.05, total * 0.002)) {
        found = { unitPrice: price, total };
      }
    }
  }
  return found;
}

/** Начало строки следующей позиции: «4.1 ФСБЦ-…», «5 42-1 …». */
const NEXT_POSITION = /^\s*\d{1,3}(?:\.\d{1,2})?\s+(?=\S*\d\S*[-.]\S*\d)/;
const POSITION_TOTAL = /всего\s+по\s+позиции/i;
const SECTION_END = /(?:всего|итого)\s+по\s+(?:разделу|смете)|итоги\s+по\s+смете/i;
/** Дальше этого от строки позиции «Всего по позиции» уже не ищется. */
const MAX_BLOCK_CHARS = 3500;

/**
 * Сумма из строки «Всего по позиции» этой позиции: поиск идёт вперёд от конца её
 * строки и обрывается на строке следующей позиции или итоге раздела. Последнее
 * число строки — сумма в текущем уровне.
 */
export function positionTotalAfter(sourceText: string, from: number): number | null {
  const end = Math.min(sourceText.length, from + MAX_BLOCK_CHARS);
  let position = from;
  while (position < end) {
    const newline = sourceText.indexOf("\n", position);
    const lineEnd = newline < 0 || newline > end ? end : newline;
    const line = sourceText.slice(position, lineEnd);
    if (POSITION_TOTAL.test(line)) {
      const numbers = numbersOf(line.replace(POSITION_TOTAL, " "));
      const last = numbers[numbers.length - 1];
      return last !== undefined && last > 0 ? last : null;
    }
    if (line.trim() !== "" && (NEXT_POSITION.test(line) || SECTION_END.test(line))) return null;
    if (newline < 0) break;
    position = newline + 1;
  }
  return null;
}
