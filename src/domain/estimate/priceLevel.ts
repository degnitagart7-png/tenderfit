/**
 * Уровень цен, объявленный самим документом, и сверка его с собранным индексом.
 *
 * Зачем это нужно. Расчёт считает в том уровне цен, который лежит в индексе, —
 * другого у него нет. Пока он делал это молча, сравнивать его смету с
 * приложенной было нельзя: на смете 02-01-02-КМ1 индекс нёс «Амурская область
 * (1 зона), 3 квартал 2026», а сметчик считал по 2 зоне за 1 квартал 2026.
 * Расходятся цены каждого ресурса, и оба расчёта при этом внутренне верны.
 *
 * Почему отказ, а не пометка. Пометку читают после: она стояла в шапке
 * выгруженной книги и честно всё называла — уже когда расчёт прошёл, деньги
 * посчитаны, а человек сравнивает итоги. Смета не в том уровне цен выглядит
 * ровно как смета в том; единственное место, где различие ещё можно поймать, —
 * до счёта.
 *
 * Разбор нарочно узкий: номер зоны и квартал с годом. Именно они расходились, и
 * именно их документ печатает устойчиво. Читать субъект федерации отсюда же
 * незачем — зона уже содержит его в своём имени, а совпадение названий по
 * склонениям и сокращениям («Респ. Бурятия», «Республика Бурятия») дало бы
 * ложные расхождения на ровном месте.
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

export function quarterIn(text: string): QuarterMark | null {
  const match = QUARTER_PATTERN.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return null;

  const raw = match[1].toUpperCase();
  const quarter = ROMAN_QUARTERS[raw] ?? Number.parseInt(raw, 10);
  if (!Number.isFinite(quarter) || quarter < 1 || quarter > 4) return null;

  const year = Number.parseInt(match[2], 10);
  return { quarter, year };
}

export function declaredPriceLevel(text: string): DeclaredPriceLevel {
  const mark = quarterIn(text);
  return {
    zone: zoneNumberIn(text),
    quarter: mark?.quarter ?? null,
    year: mark?.year ?? null,
  };
}

/**
 * Расхождение уровней цен словами, или `null`, если сверять нечего.
 *
 * Молчание документа расхождением не считается: большая часть документации
 * уровень цен не печатает вовсе, и отказывать по этому поводу значило бы
 * закрыть расчёт для всех, кого сверять не с чем.
 */
export function priceLevelMismatch(
  documentText: string,
  index: IndexPriceLevel,
): string | null {
  const declared = declaredPriceLevel(documentText);
  const indexZone = zoneNumberIn(index.priceZone);
  const indexQuarter = quarterIn(index.period);

  const problems: string[] = [];

  if (declared.zone !== null && indexZone !== null && declared.zone !== indexZone) {
    problems.push(
      `документ считан по «${String(declared.zone)} зона», а собранный индекс — по «${index.priceZone}»`,
    );
  }

  if (
    declared.quarter !== null &&
    declared.year !== null &&
    indexQuarter !== null &&
    (declared.quarter !== indexQuarter.quarter || declared.year !== indexQuarter.year)
  ) {
    problems.push(
      `документ считан на ${String(declared.quarter)} квартал ${String(declared.year)}, а собранный индекс — на ${index.period}`,
    );
  }

  if (problems.length === 0) return null;

  return `Уровень цен документа и индекса не совпадают: ${problems.join("; ")}. Считать в чужом уровне нельзя — цены расходятся по каждому ресурсу, а смета выглядит посчитанной. Соберите цены нужной зоны и квартала.`;
}
