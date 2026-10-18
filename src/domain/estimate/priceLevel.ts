/**
 * Разбор номера зоны и квартала в произвольном тексте, а также форма уровня цен нашей ценовой книги.
 *
 * Здесь только разбор: «первый квартал и первая зона где угодно в тексте». Сверять с ним целые документы нельзя — фраза
 * договора «работы выполняются в IV квартале 2026» или санитарная «1 зона» ничего не говорят об уровне цен сметы
 * (раньше такая сверка отказывала в расчёте). Уровень цен заказчика читается только из шапки его локальной сметы
 * (`customerPriceLevel.ts`), а расхождение с нашей книгой — пометка расчёта `PRICE_LEVEL_DIFFERS`, не отказ.
 *
 * Разбор нарочно узкий: номер зоны и квартал с годом. Субъект федерации отсюда читать незачем — зона уже содержит
 * его в своём имени, а совпадение названий по склонениям и сокращениям дало бы ложные расхождения на ровном месте.
 */

/** Квартал и год, найденные в тексте. */
export interface QuarterMark {
  readonly quarter: number;
  readonly year: number;
}

/** Уровень цен, как о нём говорит документ. `null` — документ молчит. */
export interface DeclaredPriceLevel {
  readonly zone: number | null;
  readonly quarter: number | null;
  readonly year: number | null;
}

/** Уровень цен собранного индекса — то, в чём расчёт умеет считать. */
export interface IndexPriceLevel {
  readonly priceZone: string;
  readonly period: string;
}

/*
  Номер зоны стоит перед словом «зона»: «(2 зона)», «2-я зона», «зона 2» в
  выгрузках ФГИС ЦС не встречается. Требование цифры отсекает «зона
  производства работ» — предложение, которое в документации закупки попадается
  чаще, чем сама ценовая зона.
*/
const ZONE_PATTERN = /(\d)\s*(?:-?я)?\s*зон[аеы]/i;

const ROMAN_QUARTERS: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 };

const QUARTER_PATTERN = /\b(IV|III|II|I|[1-4])\s*(?:квартал[а-я]*|кв\.?)\s*(\d{4})/i;

export function zoneNumberIn(text: string): number | null {
  const match = ZONE_PATTERN.exec(text);
  if (match?.[1] === undefined) return null;
  const zone = Number.parseInt(match[1], 10);
  return Number.isFinite(zone) && zone > 0 ? zone : null;
}

/**
 * Годы, которые считаются годом расчёта. В prod есть текст, из которого шаблон
 * достаёт «4 кв. 1000»: номер позиции или шифр рядом со словом «кв.». Такой год
 * сравнивался с индексом и отказывал в расчёте сметы без всякой причины.
 */
const MIN_YEAR = 2000;
const MAX_YEAR = 2099;

export function quarterIn(text: string): QuarterMark | null {
  const pattern = new RegExp(QUARTER_PATTERN.source, "gi");
  for (const match of text.matchAll(pattern)) {
    if (match[1] === undefined || match[2] === undefined) continue;

    const raw = match[1].toUpperCase();
    const quarter = ROMAN_QUARTERS[raw] ?? Number.parseInt(raw, 10);
    if (!Number.isFinite(quarter) || quarter < 1 || quarter > 4) continue;

    const year = Number.parseInt(match[2], 10);
    if (year < MIN_YEAR || year > MAX_YEAR) continue;
    return { quarter, year };
  }
  return null;
}

/** Корни названий месяцев: «сентябрь», «сентября», «сентябре» — один корень; номер месяца — по порядку. */
const MONTH_STEMS: readonly string[] = ["январ", "феврал", "март", "апрел", "ма[йяе]", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const MONTH_YEAR_PATTERN = new RegExp(`(?<![\\p{L}])(${MONTH_STEMS.join("|")})[ьяеаюй]?(?![\\p{L}])\\s+(\\d{4})(?!\\d)`, "iu");

/**
 * Квартал по названию месяца и году: «на сентябрь 2026 года» → III квартал 2026. Так печатает уровень цен Smeta.RU
 * («Составлен(а) в текущем уровне цен на сентябрь 2026 года»); дня в такой записи нет. Только для текста сразу за подписью
 * уровня цен: «марта 2024» в любом другом месте документа — просто дата, а не уровень цен сметы.
 */
export function monthQuarterIn(text: string): QuarterMark | null {
  const match = MONTH_YEAR_PATTERN.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const word = match[1].toLowerCase();
  const index = MONTH_STEMS.findIndex((stem) => new RegExp(`^${stem}`, "u").test(word));
  const year = Number.parseInt(match[2], 10);
  if (index < 0 || year < MIN_YEAR || year > MAX_YEAR) return null;
  return { quarter: Math.floor(index / 3) + 1, year };
}

export function declaredPriceLevel(text: string): DeclaredPriceLevel {
  const mark = quarterIn(text);
  return {
    zone: zoneNumberIn(text),
    quarter: mark?.quarter ?? null,
    year: mark?.year ?? null,
  };
}
