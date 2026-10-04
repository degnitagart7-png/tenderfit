import type { ResourcePrice } from "@/domain/estimate/types";

/**
 * Сборник сметных цен строительных ресурсов ФГИС ЦС.
 *
 * Что это за документ. «Сметные цены строительных ресурсов за N квартал года
 * (город X)» — публикация текущих цен по ценовой зоне: два листа, материалы и
 * машины. Это не сплит-форма: базисных цен уровня 01.01.2022, групп однородных
 * ресурсов и индексов к ним здесь нет вовсе. Значит, ресурс, которого в
 * сборнике не оказалось, придётся считать по базе 2022 года без пересчёта — и
 * расчёт обязан такую позицию пометить, а не промолчать.
 *
 * Чем этот сборник ценен. У машин он даёт то, чего сплит-форма не публикует:
 * оплату труда машинистов отдельной колонкой, вместе с их трудозатратами.
 * В сплит-форме эту составляющую приходится выводить пропорцией, а здесь она
 * измерена, и в фонд оплаты труда — а через него в накладные расходы и сметную
 * прибыль — попадает настоящее число.
 *
 * Разбор отделён от чтения файла: на вход идут строки листа, поэтому поведение
 * проверяется на настоящих строках публикации, без xlsx в тесте.
 */

/** Строка листа: ячейки как их отдаёт чтение xlsx. */
export type SheetRow = readonly unknown[];

export interface CurrentPricesMeta {
  /** Ценовая зона, как она названа в шапке: «город Москва, г. Москва». */
  readonly zone: string;
  /** Отчётный период: «3 квартал 2026». */
  readonly period: string;
}

/** Первая ячейка шапки каждого листа — по ней ищется начало таблицы. */
const MATERIAL_HEADER = /^Код материала/i;
const MACHINE_HEADER = /^Код ресурса/i;

function text(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : typeof value === "number"
      ? String(value)
      : "";
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "" || cleaned === "-") return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Читает зону и период из шапки листа материалов. */
export function parseCurrentPricesMeta(rows: readonly SheetRow[]): CurrentPricesMeta {
  const zone = text(rows[1]?.[0]);
  const periodRow = rows.find(
    (row) => text(row[0]).toLowerCase() === "отчетный период:",
  );
  return { zone, period: text(periodRow?.[1]) };
}

/**
 * Материалы: код по КСР, наименование, единица, сметная цена.
 *
 * Оплаты труда машинистов у материала быть не может, поэтому поле остаётся
 * пустым: ноль означал бы, что звено работало бесплатно.
 */
export function parseMaterialPrices(
  rows: readonly SheetRow[],
  meta: CurrentPricesMeta,
): ResourcePrice[] {
  return parseSheet(rows, meta, MATERIAL_HEADER, (row) => ({
    price: numberOrNull(row[3]),
    machinistSalary: null,
    machinistHours: null,
  }));
}

/**
 * Машины: к цене маш.-ч прилагается оплата труда звена и его трудозатраты.
 *
 * Обе величины берутся как опубликованы. Выводить их из цены нельзя: внутри
 * маш.-ч оплата труда доля непостоянная, и подстановка среднего дала бы другой
 * фонд оплаты труда, а значит другие накладные расходы.
 */
export function parseMachinePrices(
  rows: readonly SheetRow[],
  meta: CurrentPricesMeta,
): ResourcePrice[] {
  return parseSheet(rows, meta, MACHINE_HEADER, (row) => ({
    price: numberOrNull(row[3]),
    machinistSalary: numberOrNull(row[4]),
    machinistHours: numberOrNull(row[7]) ?? 1,
  }));
}

function parseSheet(
  rows: readonly SheetRow[],
  meta: CurrentPricesMeta,
  header: RegExp,
  values: (row: SheetRow) => {
    price: number | null;
    machinistSalary: number | null;
    machinistHours: number | null;
  },
): ResourcePrice[] {
  const headerAt = rows.findIndex((row) => header.test(text(row[0])));
  if (headerAt < 0) return [];

  const out: ResourcePrice[] = [];
  for (const row of rows.slice(headerAt + 1)) {
    const code = text(row[0]);
    // Код ресурса начинается с цифр и содержит разделители: строка нумерации
    // колонок («1», «2», …) под это не подходит и отсеивается сама.
    if (!/^\d.*[.\-]/.test(code)) continue;

    const parsed = values(row);
    if (parsed.price === null || parsed.price <= 0) continue;

    out.push({
      code,
      name: text(row[1]),
      unit: text(row[2]),
      price: parsed.price,
      machinistSalary: parsed.machinistSalary,
      machinistHours: parsed.machinistHours,
      source: "CURRENT_ZONE",
      period: meta.period,
      zone: meta.zone,
    });
  }

  return out;
}

/** Короткое имя зоны для имени файла: «город Москва, г. Москва» → «moskva». */
export function zoneSlug(zone: string): string {
  const table: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
    з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
    п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c",
    ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
    я: "ya",
  };

  const first = zone.split(",")[0] ?? zone;
  return [...first.toLowerCase()]
    .map((letter) => table[letter] ?? (/[a-z0-9]/.test(letter) ? letter : "-"))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
