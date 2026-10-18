import type { Tender } from "@/domain/entities";
import { isPriceKnown } from "@/domain/entities";

/**
 * Видимость цены в выдаче.
 *
 * Повод — коммерческие закупки и запросы цен: площадка публикует их без НМЦ,
 * а половина объявлена в валюте. Сегодня `filterRows` сравнивает цену с
 * границами диапазона напрямую, и закупка с ценой 0 (то есть «не опубликована»)
 * молча исчезает, как только пользователь задал «от … ₽». Это ровно то, на что
 * жалуются: самые интересные коммерческие торги пропадают из выдачи без
 * объяснения.
 *
 * Решение согласовано с пользователем: такие закупки показываются с пометкой
 * «Цена не указана», а два переключателя в духе Контур.Закупок
 * («Включать закупки без НМЦ» и «Включать закупки в валюте») позволяют их
 * скрыть. Оба включены по умолчанию — прятать данные молча нельзя.
 *
 * Модуль чистый: ни сети, ни времени, ни хранилища.
 */

/** Настройки показа закупок с неполной ценой. */
export interface PriceVisibility {
  /** Показывать закупки, у которых цена не опубликована. */
  includeUnknown: boolean;
  /** Показывать закупки, объявленные не в рублях. */
  includeForeignCurrency: boolean;
}

/**
 * Оба переключателя включены: выдача по умолчанию показывает всё, что найдено.
 * Скрывать закупки — осознанное действие пользователя, а не наше решение.
 */
export const defaultPriceVisibility: PriceVisibility = {
  includeUnknown: true,
  includeForeignCurrency: true,
};

/** Код рубля в данных ЕИС и площадок. */
export const RUB_CURRENCY = "RUB";

/**
 * Пустая строка и отсутствующая валюта считаются рублями.
 *
 * Иначе закупки с неполной карточкой (импорт, старые записи) попали бы в
 * «валютные» и исчезли при выключенном переключателе — за отсутствующее поле
 * выдача наказывать не должна.
 */
export function isRub(currency: string | null | undefined): boolean {
  const code = (currency ?? "").trim().toUpperCase();
  return code.length === 0 || code === RUB_CURRENCY;
}

/** Валюта закупки отличается от рубля. */
export function isForeignCurrency(currency: string | null | undefined): boolean {
  return !isRub(currency);
}

/**
 * Цена опубликована.
 *
 * Отдельная обёртка над `isPriceKnown`, чтобы вызывающий код не разбирался,
 * где в сущности лежит цена и чем «0» отличается от null.
 */
export function isPricePublished(tender: Tender): boolean {
  return isPriceKnown(tender.financial.price);
}

/**
 * Проходит ли закупка по переключателям видимости цены.
 *
 * Проверяется до ценового диапазона и независимо от него: переключатель
 * «Включать закупки без НМЦ» отвечает на вопрос «показывать ли такие закупки
 * вообще», а диапазон — на вопрос «какие суммы нас устраивают».
 */
export function passesPriceVisibility(
  tender: Tender,
  visibility: PriceVisibility = defaultPriceVisibility,
): boolean {
  if (!visibility.includeUnknown && !isPricePublished(tender)) return false;
  if (
    !visibility.includeForeignCurrency &&
    isForeignCurrency(tender.financial.currency)
  ) {
    return false;
  }
  return true;
}

/**
 * Укладывается ли цена в границы диапазона.
 *
 * Неопубликованная цена границам не препятствует: сравнивать нечего, а отсев
 * превратил бы «от 100 000 ₽» в «скрыть все коммерческие закупки». Правило
 * уже действует в `matchesSearchProfile`; здесь оно вынесено, чтобы лента и
 * профили поиска не разъезжались.
 */
export function passesPriceBounds(
  price: number | null | undefined,
  minPrice: number | null | undefined,
  maxPrice: number | null | undefined,
): boolean {
  if (!isPriceKnown(price)) return true;
  if (minPrice != null && price < minPrice) return false;
  if (maxPrice != null && price > maxPrice) return false;
  return true;
}

/* ============================== Подписи ============================== */

/** Пометка для закупки без опубликованной цены. */
export const unknownPriceLabel = "Цена не указана";

/**
 * Короткая подпись к строке цены в таблице.
 *
 * Возвращает null, когда пояснять нечего: цена опубликована и объявлена в
 * рублях. Так таблица не обрастает подписями у каждой второй строки.
 */
export function priceNote(
  tender: Tender,
): string | null {
  if (!isPricePublished(tender)) return unknownPriceLabel;
  const currency = (tender.financial.currency ?? "").trim().toUpperCase();
  if (isForeignCurrency(currency)) return `Цена в ${currency}`;
  return null;
}
