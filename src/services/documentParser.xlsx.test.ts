// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { parseDocument } from "./documentParser";

/*
  Смету на странице «Расчёт сметы» чаще всего загружают выгрузкой Гранд-Сметы в Excel.
  Браузер читает её тем же способом, что и сервер документы закупки: лист за листом в CSV
  с заголовком «=== Лист ===», — поэтому разбор ЛСР работает одинаково в обоих местах.
*/

function workbookFile(name: string, bookType: XLSX.BookType): File {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["№ п/п", "Обоснование", "Наименование работ", "Ед. изм.", "Кол-во"],
      [1, "ФЕР15-04-005-03", "Окраска стен водоэмульсионными составами", "100 м2", 1.2],
    ]),
    "ЛСР 02-01",
  );
  const bytes = XLSX.write(book, { type: "array", bookType }) as ArrayBuffer;
  return new File([bytes], name);
}

describe("parseDocument: таблицы Excel", () => {
  it.each([
    ["smeta.xlsx", "xlsx"],
    ["smeta.xls", "biff8"],
  ] as const)("%s читается в текст листов, как на сервере", async (name, bookType) => {
    const parsed = await parseDocument(workbookFile(name, bookType));

    expect(parsed.fileType).toBe("csv");
    expect(parsed.text).toContain("=== ЛСР 02-01 ===");
    expect(parsed.text).toContain("ФЕР15-04-005-03");
    expect(parsed.text).toContain("Окраска стен водоэмульсионными составами");
  });
});
