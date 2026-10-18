import type { Alignment, Border, Cell, Font, PaperSize, Worksheet } from "exceljs";

import {
  buildLocalEstimateForm,
  COLUMN_COUNT,
  type FormRow,
  type FormRowKind,
  type LocalEstimateFormInput,
  type Row,
} from "@/domain/estimate/exportForm";
import type { EstimateDocument } from "@/domain/estimate/types";

/**
 * Выгрузка сметы в книгу Excel.
 *
 * Зачем рядом с CSV. CSV открывается везде и читается глазами, но остаётся
 * текстом: в нём нет ни чисел, ни листов, ни оформления, и сметная программа
 * при импорте заново спрашивает разделители и кодировку. Книга Excel приезжает
 * с числами как числами, с оформлением как у ГРАНД-Сметы и с тремя листами —
 * формой локальной сметы, ведомостью объёмов и пояснениями, — то есть в том
 * виде, в каком смету и передают.
 *
 * Числа остаются числами. В CSV они печатаются с запятой ради русского Excel, а
 * здесь запятая означала бы текст: сумма, по которой нельзя сложить колонку, в
 * смете бесполезна. Поэтому ячейка, которая выглядит числом, числом и
 * записывается, а всё остальное — строкой. Исключение — обоснование и
 * наименование: код «0123» не должен потерять ноль.
 *
 * Пояснения («Не заполнено в форме», оговорка документа) вынесены на отдельный лист:
 * лист «ЛСР» должен выглядеть как документ из ГРАНД-Сметы, а не как рабочая таблица с примечаниями.
 *
 * Библиотека `exceljs` грузится динамически: она весит больше мегабайта и нужна
 * только в момент выгрузки, а не на каждом открытии карточки. Она, а не `xlsx`,
 * потому что бесплатная сборка `xlsx` не умеет оформление: шрифты, рамки, объединения
 * и печатные параметры там пишутся только в платной версии.
 */

export interface EstimateWorkbookInput extends LocalEstimateFormInput {
  /** Имя файла без расширения — видно пользователю в списке загрузок. */
  readonly fileName?: string;
  /**
   * Насколько расчёту можно верить (`estimateConfidence.ts`): название и пояснение печатаются первыми строками листа
   * «Пояснения». Лист «ЛСР» не трогаем: он должен выглядеть как форма 421/пр. Нет — строк нет.
   */
  readonly confidence?: { readonly title: string; readonly explanation: string; readonly rangeText?: string } | null;
}

/** Ширины колонок формы, в знаках. Без них наименование работ не видно вовсе. */
const FORM_COLUMN_WIDTHS = [
  6, 18, 48, 11, 11, 8, 11, 12, 8, 12, 8, 14,
] as const;

const BILL_COLUMN_WIDTHS = [6, 22, 52, 10, 12, 30, 40] as const;

/** Имена листов: «ЛСР» — как в выгрузках ГРАНД-Сметы. */
export const FORM_SHEET_NAME = "ЛСР";
export const BILL_SHEET_NAME = "Ведомость объёмов";
export const NOTES_SHEET_NAME = "Пояснения";

const FONT_NAME = "Arial";
const MONEY_FORMAT = "#,##0.00";
const GREY = "FF595959";

/**
 * Ячейка, которую Excel должен считать числом.
 *
 * Распознаётся то, что напечатала форма: десятичная запятая и пробелы в
 * разрядах. Проценты и единицы остаются текстом — «103 %» это не число, а
 * подпись к начислению.
 */
export function asNumber(value: string): number | null {
  const cleaned = value.replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Превращает строки формы в матрицу значений для листа. */
export function toSheetMatrix(rows: readonly Row[]): (string | number)[][] {
  return rows.map((row) => {
    const cells: (string | number)[] = [];
    for (let index = 0; index < Math.max(COLUMN_COUNT, row.length); index += 1) {
      const raw = row[index] ?? "";
      const numeric = asNumber(raw);
      cells.push(numeric === null ? raw : numeric);
    }
    return cells;
  });
}

/** Ведомость объёмов отдельным листом: по ней проверяют, что откуда взялось. */
export function toBillMatrix(document: EstimateDocument): (string | number)[][] {
  const rows: (string | number)[][] = [
    [
      "№",
      "Обоснование",
      "Наименование работ",
      "Ед. изм.",
      "Количество",
      "Документ-основание",
      "Цитата",
    ],
  ];

  let number = 0;
  for (const section of document.sections) {
    rows.push([`Раздел: ${section.title}`]);
    for (const line of section.lines) {
      number += 1;
      rows.push([
        number,
        `${line.normBaseType} ${line.normCode}`,
        line.normName,
        line.normUnit,
        line.quantity,
        line.sourceDocument ?? "",
        line.sourceQuote ?? "",
      ]);
    }
  }

  return rows;
}

/** Имя файла: по нему видно смету и день выгрузки, не открывая. */
export function estimateFileName(
  regNumber: string,
  generatedAt: Date,
  extension: "csv" | "xlsx",
): string {
  const safe = regNumber.replace(/[\\/:"*?<>|]/g, "");
  const date = generatedAt.toISOString().slice(0, 10);
  return `Смета ${safe} от ${date}.${extension}`;
}

/** Собирает книгу Excel: лист формы, лист ведомости и лист пояснений. */
export async function buildEstimateWorkbook(
  input: EstimateWorkbookInput,
): Promise<Uint8Array> {
  const module_ = await import("exceljs");
  const ExcelJS =
    (module_ as unknown as { default?: typeof module_ }).default ?? module_;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TenderFit";
  workbook.created = new Date(input.document.generatedAt);

  const formRows = buildLocalEstimateForm(input);
  writeFormSheet(workbook.addWorksheet(FORM_SHEET_NAME), formRows.filter((row) => row.kind !== "note"));
  writeBillSheet(workbook.addWorksheet(BILL_SHEET_NAME), input.document);
  writeNotesSheet(workbook.addWorksheet(NOTES_SHEET_NAME), formRows, input.confidence ?? null);

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/* ------------------------------ лист формы ------------------------------ */

/** Какие колонки какого вида строки могут быть числом: коды и наименования остаются строками. */
function numericAllowed(kind: FormRowKind, column: number): boolean {
  if (kind === "columnNumbers") return true;
  if (column === 0) return kind !== "summaryLine" && kind !== "summaryHeading" && kind !== "field";
  if (column === 1) return kind === "element";
  if (column === 2) return false;
  if (column === 3) return kind === "costBlock";
  // Колонки 5…12 — количества, коэффициенты, цены и суммы; подпись поля шапки сюда не попадает (она в колонке 1).
  return kind !== "field" && kind !== "appendix" && kind !== "caption" && kind !== "name" && kind !== "title" && kind !== "workTitle";
}

/** Формат числа ячейки: деньги с копейками, количества — как есть, без хвоста нулей. */
function numberFormat(kind: FormRowKind, column: number, row: FormRow): string | undefined {
  if (kind === "costBlock") {
    // Рядом с числом стоит единица: «тыс.руб.» — деньги, «чел.-ч.» — часы, их копейками не округляем.
    const unit = row.cells[column + 1] ?? "";
    return unit.startsWith("тыс") ? MONEY_FORMAT : undefined;
  }
  if (kind === "columnNumbers" || kind === "tableHead") return undefined;
  // Колонки 8, 10 и 12 — цена в базисном уровне, цена в текущем уровне и сумма.
  if (column === 7 || column === 9 || column === 11) return MONEY_FORMAT;
  return undefined;
}

const BOLD_KINDS: ReadonlySet<FormRowKind> = new Set([
  "title",
  "workTitle",
  "tableHead",
  "columnNumbers",
  "section",
  "position",
  "positionTotal",
  "sectionTotal",
  "summaryHeading",
  "summaryTotal",
]);

const THIN: Partial<Border> = { style: "thin", color: { argb: "FF000000" } };

/** Шрифт строки: Arial 9, остальное — по виду строки. */
function fontOf(kind: FormRowKind): Partial<Font> {
  const font: Partial<Font> = { name: FONT_NAME, size: 9 };
  if (BOLD_KINDS.has(kind)) font.bold = true;
  switch (kind) {
    case "title":
      font.size = 12;
      break;
    case "workTitle":
    case "name":
      font.size = 10;
      break;
    case "caption":
      font.size = 7;
      font.italic = true;
      break;
    case "condition":
      font.italic = true;
      break;
    case "resource":
      font.size = 8;
      font.color = { argb: GREY };
      break;
    default:
      break;
  }
  return font;
}

/** Выравнивание: числа вправо, шапка таблицы и заголовки по центру, остальное влево; переносы везде, где есть текст. */
function alignmentOf(kind: FormRowKind, column: number, numeric: boolean): Partial<Alignment> {
  switch (kind) {
    case "appendix":
      return { horizontal: "right", vertical: "top" };
    case "name":
    case "caption":
    case "title":
    case "workTitle":
      return { horizontal: "center", vertical: "middle", wrapText: true };
    case "tableHead":
    case "columnNumbers":
      return { horizontal: "center", vertical: "middle", wrapText: true };
    case "blank":
      return { vertical: "top" };
    default:
      break;
  }
  if (numeric) return { horizontal: "right", vertical: "top" };
  // Единица измерения — по центру, как в ГРАНД; остальной текст влево с переносом.
  if (column === 3 && kind !== "costBlock") return { horizontal: "center", vertical: "top", wrapText: true };
  return { horizontal: "left", vertical: "top", wrapText: true };
}

/** Знаков в строке на одну единицу ширины колонки — с запасом, чтобы высота строки не обрезала текст. */
const CHARS_PER_WIDTH = 1.1;
/** Высота одной строки текста, пт, по размеру шрифта. */
const LINE_HEIGHT: Readonly<Record<number, number>> = { 7: 10, 8: 11, 9: 12, 10: 13.5, 12: 16 };

/**
 * Высота строки, где есть объединённые ячейки или перенос в узких колонках шапки.
 *
 * Excel сам подбирает высоту только у необъединённых ячеек; в объединённых длинный текст
 * (реквизиты шапки, наименование стройки) обрезался бы одной строкой. Оценка с запасом.
 * null — оценивать нечего, высота остаётся автоматической.
 */
function heightOf(row: FormRow): number | null {
  const size = (fontOf(row.kind).size ?? 9) as number;
  const lineHeight = LINE_HEIGHT[size] ?? 12;
  let lines = 1;

  const spans = row.spans ?? [];
  for (const span of spans) {
    if (span.from === span.to && row.kind !== "tableHead") continue;
    if ((span.rows ?? 1) > 1) continue;
    const text = row.cells[span.from] ?? "";
    let width = 0;
    for (let column = span.from; column <= span.to; column += 1) width += FORM_COLUMN_WIDTHS[column] ?? 10;
    lines = Math.max(lines, wrappedLines(text, width));
  }
  if (row.kind === "tableHead" || row.kind === "columnNumbers") {
    row.cells.forEach((text, column) => {
      const covered = spans.some((span) => span.from <= column && column <= span.to && (span.from !== span.to || (span.rows ?? 1) > 1));
      if (!covered) lines = Math.max(lines, wrappedLines(text, FORM_COLUMN_WIDTHS[column] ?? 10));
    });
  }
  return lines > 1 ? lines * lineHeight + 3 : null;
}

function wrappedLines(text: string, width: number): number {
  if (text === "") return 1;
  const perLine = Math.max(1, Math.floor(width * CHARS_PER_WIDTH));
  return text.split("\n").reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / perLine)), 0);
}

function writeFormSheet(sheet: Worksheet, rows: readonly FormRow[]): void {
  sheet.columns = FORM_COLUMN_WIDTHS.map((width) => ({ width }));

  const firstTable = rows.findIndex((row) => row.kind === "tableHead");
  const afterTable = rows.findIndex((row) => row.kind === "summaryHeading");
  const headerRows = rows.flatMap((row, index) => (row.kind === "tableHead" || row.kind === "columnNumbers" ? [index + 1] : []));
  const merges: { top: number; left: number; bottom: number; right: number }[] = [];

  rows.forEach((formRow, index) => {
    const rowNumber = index + 1;
    const excelRow = sheet.getRow(rowNumber);
    const inTable = firstTable >= 0 && index >= firstTable && (afterTable < 0 || index < afterTable);

    for (let column = 0; column < COLUMN_COUNT; column += 1) {
      const cell = excelRow.getCell(column + 1);
      const raw = formRow.cells[column] ?? "";
      const numeric = numericAllowed(formRow.kind, column) ? asNumber(raw) : null;
      if (raw !== "") cell.value = numeric ?? raw;
      cell.font = fontOf(formRow.kind);
      cell.alignment = alignmentOf(formRow.kind, column, numeric !== null);
      if (numeric !== null) {
        const format = numberFormat(formRow.kind, column, formRow);
        if (format !== undefined) cell.numFmt = format;
      }
      if (inTable) cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
    }
    underline(formRow, excelRow.getCell.bind(excelRow));

    const height = heightOf(formRow);
    if (height !== null) excelRow.height = height;

    for (const span of formRow.spans ?? []) {
      const rowsDown = span.rows ?? 1;
      if (span.from === span.to && rowsDown === 1) continue;
      merges.push({ top: rowNumber, left: span.from + 1, bottom: rowNumber + rowsDown - 1, right: span.to + 1 });
    }
  });

  // Объединяем в конце: ячейки-«хвосты» наследуют стиль главной ячейки, и рамка не теряется.
  for (const merge of merges) sheet.mergeCells(merge.top, merge.left, merge.bottom, merge.right);

  const first = headerRows[0];
  const last = headerRows[headerRows.length - 1];
  sheet.pageSetup = {
    orientation: "landscape",
    paperSize: 9 as PaperSize,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 },
    ...(first === undefined || last === undefined ? {} : { printTitlesRow: `${String(first)}:${String(last)}` }),
  };
  sheet.headerFooter.oddFooter = "&CСтраница &P из &N";
}

/** Наименование стройки и объекта подчёркнуты линией, как в форме: рамки у них нет, а подпись-пояснение стоит под чертой. */
function underline(row: FormRow, cellOf: (column: number) => Cell): void {
  if (row.kind !== "name") return;
  for (let column = 0; column < COLUMN_COUNT; column += 1) {
    cellOf(column + 1).border = { bottom: THIN };
  }
}

/* ------------------------------ остальные листы ------------------------------ */

function writeBillSheet(sheet: Worksheet, document: EstimateDocument): void {
  sheet.columns = BILL_COLUMN_WIDTHS.map((width) => ({ width }));
  const matrix = toBillMatrix(document);
  matrix.forEach((values, index) => {
    const row = sheet.getRow(index + 1);
    const header = index === 0;
    const sectionRow = values.length === 1;
    values.forEach((value, column) => {
      const cell = row.getCell(column + 1);
      cell.value = value;
      cell.font = { name: FONT_NAME, size: 9, bold: header || sectionRow };
      cell.alignment = { vertical: "top", wrapText: true, ...(header ? { horizontal: "center" as const } : {}) };
      if (header) cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
    });
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/** Лист «Пояснения»: точность расчёта, что в форме не заполнено и оговорка документа — одним столбцом. */
function writeNotesSheet(
  sheet: Worksheet,
  rows: readonly FormRow[],
  confidence: EstimateWorkbookInput["confidence"] = null,
): void {
  sheet.columns = [{ width: 140 }];
  let index = 0;
  if (confidence != null) {
    const lines = [
      { text: confidence.title, bold: true },
      ...(confidence.rangeText === undefined ? [] : [{ text: confidence.rangeText, bold: false }]),
      { text: confidence.explanation, bold: false },
      { text: "", bold: false },
    ];
    for (const line of lines) {
      index += 1;
      if (line.text === "") continue;
      const cell = sheet.getRow(index).getCell(1);
      cell.value = line.text;
      cell.font = { name: FONT_NAME, size: 9, bold: line.bold };
      cell.alignment = { vertical: "top", wrapText: true };
    }
  }
  for (const formRow of rows) {
    if (formRow.kind !== "note") continue;
    const text = formRow.cells[0] ?? "";
    // Пустая строка перед заголовком блока листу не нужна, а между примечаниями и оговоркой отделяет их.
    if (index === 0 && text === "") continue;
    index += 1;
    const cell = sheet.getRow(index).getCell(1);
    if (text === "") continue;
    cell.value = text;
    // Заголовок блока — первая непустая строка листа, остальное — примечания и оговорка.
    cell.font = { name: FONT_NAME, size: 9, bold: text === "Не заполнено в форме" };
    cell.alignment = { vertical: "top", wrapText: true };
  }
}
