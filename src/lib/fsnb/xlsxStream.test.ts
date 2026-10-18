import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { streamSheetRows } from "@/lib/fsnb/xlsxStream";

/*
  Потоковое чтение должно давать ровно то, что дал бы `sheet_to_json({header: 1,
  blankrows: false, defval: ""})`: от этого зависит, что сборщик зоны получает те
  же цены, что и прежний путь через библиотеку (проверено и на настоящей
  сплит-форме Амура: файлы совпадают побайтово).
*/

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xlsx-stream-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function write(rows: readonly unknown[][], name = "t.xlsx", extraSheets = false): string {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows as unknown[][]), "Лист1");
  if (extraSheets) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["не тот лист"]]), "Лист2");
  const path = join(dir, name);
  XLSX.writeFile(book, path);
  return path;
}

function viaLibrary(path: string, columns: number): unknown[][] {
  const book = XLSX.readFile(path);
  const sheet = book.Sheets[book.SheetNames[0] as string] as XLSX.WorkSheet;
  return XLSX.utils
    .sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" })
    .map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? ""));
}

describe("streamSheetRows", () => {
  it("совпадает с sheet_to_json: числа, строки, пустые ячейки, пропущенные строки", () => {
    const path = write([
      ["Код ресурса, услуги", "Наименование", "Ед.", 1.5, "-"],
      [],
      ["01.1.01.02-0011", "Доска «электротехническая» & прочее <АЦЭИД>", "т", 25044.62, "", 0.5],
      [12, "число в первой ячейке", "", "", 7, "", "хвост"],
      ["  пробелы  ", "строка\nс переносом", "м3", -3.25, 1e-7],
    ]);

    expect([...streamSheetRows(path, 6)]).toEqual(viaLibrary(path, 6));
  });

  it("берёт только первые maxColumns колонок", () => {
    const path = write([["а", "б", "в", "г"], ["1", 2, 3, 4]]);
    expect([...streamSheetRows(path, 2)]).toEqual([["а", "б"], ["1", 2]]);
  });

  it("читает первый лист, а не последний", () => {
    const path = write([["первый"]], "two.xlsx", true);
    expect([...streamSheetRows(path, 1)]).toEqual([["первый"]]);
  });

  it("много строк и общих строк: порядок и значения сохраняются", () => {
    const rows: unknown[][] = [];
    for (let i = 0; i < 3000; i += 1) rows.push([`код-${String(i)}`, `имя ${String(i % 40)} ёж`, i % 7 === 0 ? "" : i, i / 8]);
    const path = write(rows);

    const streamed = [...streamSheetRows(path, 4)];
    expect(streamed).toHaveLength(3000);
    expect(streamed).toEqual(viaLibrary(path, 4));
  });

  it("ячейки на границе окон в 1 МБ не теряются", () => {
    // Длинные тексты гоняют границу окна по разным местам XML.
    const rows: unknown[][] = [];
    for (let i = 0; i < 400; i += 1) rows.push([`код-${String(i)}`, "длинное наименование ".repeat(150) + String(i), i]);
    const path = write(rows);

    expect([...streamSheetRows(path, 3)]).toEqual(viaLibrary(path, 3));
  });

  it("не zip — внятная ошибка", async () => {
    const path = join(dir, "bad.xlsx");
    await writeFile(path, "это просто текст, а не книга Excel".repeat(10));
    expect(() => [...streamSheetRows(path, 1)]).toThrow(/не похож на zip/);
  });

  it("полностью пустая строка из пустых ячеек пропускается, как и отсутствующая", () => {
    const path = write([["а"], ["", ""], ["б"]]);
    expect([...streamSheetRows(path, 2)]).toEqual([["а", ""], ["б", ""]]);
  });
});
