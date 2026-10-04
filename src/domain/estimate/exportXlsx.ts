import {
  buildLocalEstimateFormRows,
  COLUMN_COUNT,
  type LocalEstimateFormInput,
  type Row,
} from "@/domain/estimate/exportForm";
import type { EstimateDocument } from "@/domain/estimate/types";

/**
 * Выгрузка сметы в книгу Excel.
 *
 * Зачем рядом с CSV. CSV открывается везде и читается глазами, но остаётся
 * текстом: в нём нет ни чисел, ни листов, и сметная программа при импорте
 * заново спрашивает разделители и кодировку. Книга Excel приезжает с числами
 * как числами и с двумя листами — формой локальной сметы и ведомостью объёмов,
 * — то есть в том виде, в каком смету и передают.
 *
 * Числа остаются числами. В CSV они печатаются с запятой ради русского Excel, а
 * здесь запятая означала бы текст: сумма, по которой нельзя сложить колонку, в
 * смете бесполезна. Поэтому ячейка, которая выглядит числом, числом и
 * записывается, а всё остальное — строкой.
 *
 * Библиотека `xlsx` грузится динамически: она весит около мегабайта и нужна
 * только в момент выгрузки, а не на каждом открытии карточки.
 */

export interface EstimateWorkbookInput extends LocalEstimateFormInput {
  /** Имя файла без расширения — видно пользователю в списке загрузок. */
  readonly fileName?: string;
}

/** Ширины колонок формы, в знаках. Без них наименование работ не видно вовсе. */
const FORM_COLUMN_WIDTHS = [
  6, 22, 52, 12, 12, 10, 12, 14, 8, 14, 10, 14,
] as const;

const BILL_COLUMN_WIDTHS = [6, 22, 52, 10, 12, 30, 40] as const;

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

/** Собирает книгу Excel: лист формы и лист ведомости. */
export async function buildEstimateWorkbook(
  input: EstimateWorkbookInput,
): Promise<Uint8Array> {
  const module_ = await import("xlsx");
  const XLSX =
    (module_ as unknown as { default?: typeof module_ }).default ?? module_;

  const workbook = XLSX.utils.book_new();

  const form = XLSX.utils.aoa_to_sheet(
    toSheetMatrix(buildLocalEstimateFormRows(input)),
  );
  form["!cols"] = FORM_COLUMN_WIDTHS.map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(workbook, form, "ЛСР по форме 421пр");

  const bill = XLSX.utils.aoa_to_sheet(toBillMatrix(input.document));
  bill["!cols"] = BILL_COLUMN_WIDTHS.map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(workbook, bill, "Ведомость объёмов");

  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new Uint8Array(buffer as ArrayBuffer);
}
