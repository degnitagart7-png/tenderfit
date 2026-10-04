import type { ResourcePrice } from "@/domain/estimate/types";

/**
 * Сплит-форма индексов и сметных цен ФГИС ЦС.
 *
 * Что это. Один файл на ценовую зону за квартал, в котором Минстрой публикует
 * всё, что нужно ресурсно-индексному методу: сметную цену ресурса в уровне
 * 01.01.2022, сметную цену в текущем уровне и — для ресурсов, которых на рынке
 * зоны нет, — индекс к группе однородных строительных ресурсов. Плюс в шапке
 * лежат реквизиты письма об индексах и акта об оплате труда, то есть ровно те
 * поля, которые требует форма локальной сметы по Приложению 3 к Методике
 * 421/пр.
 *
 * Почему это заменяет письма Минстроя об индексах. Письма серии ИФ-09
 * публикуют индексы к сметно-нормативной базе 2001 года: сейчас они порядка
 * 25–30, тогда как к уровню 01.01.2022 — около 1,1–1,7. Применить их к ценам
 * ФСНБ-2022 значит завысить смету примерно в двадцать раз. Сплит-форма — это
 * индексы именно к 2022 году, и другого их источника нет.
 *
 * Текущая цена и индекс взаимно исключают друг друга: в выгрузке Амурской
 * области 235 441 ресурс имеет текущую цену, 46 000 — индекс, и ни один не
 * имеет обоих. Это не совпадение, а устройство формы: индекс дают там, где
 * цену по зоне определить не удалось.
 *
 * Разбор отделён от чтения файла: на вход идут строки листа, поэтому поведение
 * проверяется на настоящих строках выгрузки, без xlsx на 14 МБ в тесте.
 */

/** Реквизиты из шапки: печатаются в шапке формы локальной сметы. */
export interface SplitFormMeta {
  /** Наименование субъекта Российской Федерации. */
  readonly subject: string;
  /** Наименование зоны субъекта: «Амурская область (1 зона)». */
  readonly zone: string;
  /** Период, как он назван в заголовке листа: «3 квартал 2026 года». */
  readonly period: string;
  /** Реквизиты письма Минстроя об индексах изменения сметной стоимости. */
  readonly indexLetter: string;
  /** Реквизиты акта субъекта об утверждении оплаты труда. */
  readonly wageAct: string;
}

/** Одна строка сплит-формы. */
export interface SplitFormRow {
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  /** Отпускная цена в уровне 01.01.2022; у машин её нет. */
  readonly releasePrice: number | null;
  /** Сметная цена в уровне 01.01.2022 по этой зоне. */
  readonly basePrice: number | null;
  readonly groupNumber: number | null;
  readonly groupName: string;
  /** Сметная цена в текущем уровне цен. */
  readonly currentPrice: number | null;
  /** Индекс к группе однородных строительных ресурсов. */
  readonly index: number | null;
}

export interface SplitForm {
  readonly meta: SplitFormMeta;
  readonly rows: readonly SplitFormRow[];
}

/** Строка листа: ячейки как их отдаёт чтение xlsx. */
export type SheetRow = readonly unknown[];

const HEADER_FIRST_CELL = "Код ресурса, услуги";

/** «-» и пустая ячейка означают «значения нет», а не ноль. */
function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "" || cleaned === "-") return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : typeof value === "number"
      ? String(value)
      : "";
}

/** Значение поля шапки: подпись в первой ячейке, значение — в первой непустой справа. */
function fieldValue(row: SheetRow | undefined): string {
  if (row === undefined) return "";
  for (const cell of row.slice(1)) {
    const value = text(cell);
    if (value !== "") return value;
  }
  return "";
}

/**
 * Разбирает лист сплит-формы.
 *
 * Шапка ищется по подписи первой колонки, а не по номеру строки: в выгрузках
 * разных кварталов число примечаний перед таблицей разное, и жёсткий номер
 * строки сломался бы на первой же новой публикации. Данные начинаются после
 * строки нумерации колонок.
 */
export function parseSplitForm(rows: readonly SheetRow[]): SplitForm {
  const headerAt = rows.findIndex((row) => text(row[0]) === HEADER_FIRST_CELL);
  if (headerAt < 0) {
    throw new Error(
      `В листе нет шапки таблицы: не нашлась колонка «${HEADER_FIRST_CELL}».`,
    );
  }

  const title = text(rows[0]?.[0]);
  const period = /на (.+?) года/.exec(title)?.[1] ?? "";

  const meta: SplitFormMeta = {
    subject: fieldValue(rows[3]),
    zone: fieldValue(rows[4]),
    period: period === "" ? "" : `${period} года`,
    indexLetter: fieldValue(rows[1]),
    wageAct: fieldValue(rows[2]),
  };

  const parsed: SplitFormRow[] = [];
  for (const row of rows.slice(headerAt + 1)) {
    const code = text(row[0]);
    // Строка нумерации колонок и любые подписи пропускаются: код ресурса
    // начинается с цифры и содержит разделители, «1» ему не подходит.
    if (!/^\d.*[.\-]/.test(code)) continue;

    parsed.push({
      code,
      name: text(row[1]),
      unit: text(row[2]),
      releasePrice: numberOrNull(row[3]),
      basePrice: numberOrNull(row[4]),
      groupNumber: numberOrNull(row[5]),
      groupName: text(row[6]),
      currentPrice: numberOrNull(row[7]),
      index: numberOrNull(row[8]),
    });
  }

  return { meta, rows: parsed };
}

/** Что известно о ресурсе из федеральной базы — нужно только машинам. */
export interface BaseMachineFacts {
  /** Оплата труда звена, ₽ за маш.-ч, в уровне 01.01.2022. */
  readonly machinistSalary: number;
  readonly machinistHours: number;
}

/**
 * Превращает строку сплит-формы в цену ресурса для расчёта.
 *
 * Два пути, и оба честные. Есть текущая цена — берём её, источник
 * `CURRENT_ZONE`. Есть только индекс — умножаем на него сметную цену уровня
 * 01.01.2022 **из той же сплит-формы**, источник `BASE_2022_INDEXED`. Брать для
 * этого федеральную цену ФСБЦ нельзя: у машин зональная сметная цена включает
 * доставку и отличается от федеральной почти вдвое, а индекс рассчитан именно к
 * зональной.
 *
 * Оплата труда машинистов. Сплит-форма её отдельной колонкой не публикует, а
 * расчёту она нужна: ОТм входит в фонд оплаты труда и через него в НР и СП.
 * Поэтому она берётся из федеральной базы и двигается тем же множителем, каким
 * двинулась цена маш.-ч. Это допущение, и оно названо: другого разложения
 * текущей цены на части в открытых данных нет, а оставить ОТм на уровне 2022
 * года значило бы занизить фонд оплаты труда, то есть и накладные расходы.
 */
export function toCurrentPrice(
  row: SplitFormRow,
  meta: SplitFormMeta,
  machine: BaseMachineFacts | null = null,
): ResourcePrice | null {
  const direct = row.currentPrice;
  const indexed =
    row.index !== null && row.basePrice !== null
      ? round(row.basePrice * row.index)
      : null;

  const price = direct ?? indexed;
  if (price === null) return null;

  const factor =
    row.basePrice !== null && row.basePrice > 0 ? price / row.basePrice : 1;

  return {
    code: row.code,
    name: row.name,
    unit: row.unit,
    price,
    machinistSalary:
      machine === null ? null : round(machine.machinistSalary * factor),
    machinistHours: machine?.machinistHours ?? null,
    source: direct !== null ? "CURRENT_ZONE" : "BASE_2022_INDEXED",
    period: meta.period,
    zone: meta.zone,
  } satisfies ResourcePrice;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Сводка по выгрузке: печатается при сборке, чтобы видеть, что именно приехало. */
export interface SplitFormCoverage {
  readonly total: number;
  readonly withCurrentPrice: number;
  readonly withIndex: number;
  readonly withNothing: number;
}

export function splitFormCoverage(
  rows: readonly SplitFormRow[],
): SplitFormCoverage {
  let withCurrentPrice = 0;
  let withIndex = 0;
  let withNothing = 0;

  for (const row of rows) {
    if (row.currentPrice !== null) withCurrentPrice += 1;
    else if (row.index !== null && row.basePrice !== null) withIndex += 1;
    else withNothing += 1;
  }

  return { total: rows.length, withCurrentPrice, withIndex, withNothing };
}
