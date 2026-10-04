import type { EstimateDocument, EstimateLine } from "@/domain/estimate/types";

/**
 * Выгрузка расчёта в CSV: ведомость объёмов работ и форма локальной сметы.
 *
 * Зачем текст, а не .gsd или АРПС. Формат ГРАНД-Сметы закрыт, а обмен АРПС
 * описан спецификацией, которой у проекта нет: написать её «по памяти» значит
 * отдать файл, который объявляет себя совместимым и не открывается. CSV с
 * колонками в том порядке, в каком сметные программы предлагают сопоставить их
 * при импорте из Excel, проверяется глазами за минуту и открывается везде.
 * Раскладка колонок остаётся неподтверждённой до первого живого импорта. В саму
 * ведомость оговорка не пишется — лишняя строка сбила бы разбор заголовка; она
 * стоит в подвале формы локальной сметы и в отчёте прогона.
 *
 * Три решения о формате, все ради русского Excel: разделитель — точка с запятой
 * (Excel русской локали ждёт именно её), дробная часть — запятая (иначе числа
 * приедут текстом), файл начинается с BOM (иначе кириллица в UTF-8 читается
 * как мусор). Запятая в числах и точка с запятой в разделителе не конфликтуют.
 *
 * Обоснование позиции печатается как «книга + код», а не одним кодом: один и
 * тот же шифр живёт в четырёх книгах ГЭСН и означает четыре разные работы, и
 * строка без книги непроверяема — сметчик не найдёт по ней ту же расценку.
 */

/** Метка кодировки в начале файла: без неё Excel читает UTF-8 как cp1251. */
export const CSV_BOM = "﻿";

const SEPARATOR = ";";
const NEWLINE = "\r\n";

/**
 * Ведомость объёмов работ: то, что человек не должен вычитывать из документации
 * руками.
 *
 * Колонки объёма две. Первая — количество в единицах нормы, она и умножается на
 * расценку. Вторая — объём так, как он записан в документации, вместе с её
 * единицей: без неё проверить перевод «м3 → 1000 м3» можно только пересчётом в
 * уме, а именно на этом переводе теряется порядок величины.
 */
export function toBillOfWorkCsv(document: EstimateDocument): string {
  const rows: string[][] = [
    [
      "№",
      "Обоснование",
      "Наименование работ",
      "Ед. изм.",
      "Количество",
      "Объём по ведомости",
      "Ед. ведомости",
      "Документ-основание",
      "Цитата",
    ],
  ];

  let number = 0;
  for (const section of document.sections) {
    for (const line of section.lines) {
      number += 1;
      rows.push([
        String(number),
        reason(line),
        line.normName,
        line.normUnit,
        quantity(line.quantity),
        quantity(line.billQuantity),
        line.billUnit,
        line.sourceDocument ?? "",
        line.sourceQuote ?? "",
      ]);
    }
  }

  return render(rows);
}

/**
 * Форма локальной сметы: позиции с начислениями, подытоги разделов и итоги.
 *
 * Нормативы НР и СП печатаются в самой строке, а не только в шапке документа:
 * они теперь свои у каждой расценки, и смета, где напечатан один процент на
 * всех, не даёт проверить начисление. Пометки позиции идут последней колонкой —
 * строка, посчитанная по базе 2022 года или по резервному нормативу, обязана
 * говорить об этом там же, где стоит её сумма.
 */
export function toLocalEstimateCsv(document: EstimateDocument): string {
  const rows: string[][] = [
    [
      "№",
      "Обоснование",
      "Наименование работ",
      "Ед. изм.",
      "Количество",
      "Прямые затраты",
      "ФОТ",
      "НР, %",
      "НР",
      "СП, %",
      "СП",
      "Всего",
      "Пометки",
    ],
  ];

  let number = 0;
  for (const section of document.sections) {
    rows.push([`Раздел: ${section.title}`]);
    for (const line of section.lines) {
      number += 1;
      rows.push([
        String(number),
        reason(line),
        line.normName,
        line.normUnit,
        quantity(line.quantity),
        money(line.directCost),
        money(line.wageFund),
        percent(line.overheadPercent),
        money(line.overheadCost),
        percent(line.profitPercent),
        money(line.profitCost),
        money(line.directCost + line.overheadCost + line.profitCost),
        line.gaps.map((gap) => `${gap.kind}: ${gap.message}`).join(" | "),
      ]);
    }
    rows.push([
      `Итого по разделу «${section.title}»`,
      "",
      "",
      "",
      "",
      money(section.directCost),
      "",
      "",
      money(section.overheadCost),
      "",
      money(section.profitCost),
      money(section.workCost),
      "",
    ]);
  }

  const totals = document.totals;
  rows.push([]);
  rows.push(["Итоги по документу"]);
  rows.push(["Прямые затраты", money(totals.directCost)]);
  rows.push(["Фонд оплаты труда", money(totals.wageFund)]);
  rows.push(["Накладные расходы", money(totals.overheadCost)]);
  rows.push(["Сметная прибыль", money(totals.profitCost)]);
  rows.push(["Стоимость СМР", money(totals.workCost)]);
  rows.push([
    "Временные здания и сооружения",
    money(totals.temporaryStructures),
  ]);
  rows.push(["Зимнее удорожание", money(totals.winterSurcharge)]);
  rows.push(["Без НДС", money(totals.beforeVat)]);
  rows.push([
    `НДС ${percent(document.parameters.vatPercent)} %`,
    money(totals.vat),
  ]);
  rows.push(["Итого с НДС", money(totals.total)]);
  rows.push([]);
  rows.push([document.disclaimer]);
  rows.push([
    `Уровень цен базы: ${document.baseEdition}. Ценовая зона: ${document.priceZone}. Период текущих цен: ${document.period}`,
  ]);
  rows.push([
    "Раскладка колонок ведомости объёмов работ под импорт в сметную программу живым импортом не проверена.",
  ]);

  return render(rows);
}

/** «ГЭСН 01-01-001-01»: книга обязательна, иначе строку не найти в справочнике. */
function reason(line: EstimateLine): string {
  return `${line.normBaseType} ${line.normCode}`;
}

function render(rows: readonly string[][]): string {
  const body = rows.map((row) => row.map(escape).join(SEPARATOR)).join(NEWLINE);
  return `${CSV_BOM}${body}${NEWLINE}`;
}

/**
 * Поле в кавычках, если внутри есть разделитель, кавычка или перевод строки;
 * внутренние кавычки удваиваются — правило CSV, которое понимает Excel.
 */
function escape(value: string): string {
  if (!/[";\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Рубли: две цифры после запятой всегда — так складывается столбец. */
function money(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

/**
 * Объём: до четырёх знаков, незначащие нули убраны. Четыре, а не два, потому что
 * норма на 1000 м3 при объёме в сотнях кубометров даёт третий знак, и округление
 * до двух меняло бы сумму позиции.
 */
function quantity(value: number): string {
  const fixed = value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return fixed.replace(".", ",");
}

/** Проценты как они заданы: 105, 66, 7,5 — без дописанных нулей. */
function percent(value: number): string {
  return String(value).replace(".", ",");
}
