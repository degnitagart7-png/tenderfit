import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { readPdfTextBoxes } from "../../src/lib/pdf/pdfTextBoxes";
import { buildTableGrid, diffGrids, type TableGrid } from "../../src/lib/pdf/tableGrid";

/**
 * Осмотр таблицы в PDF перед тем, как писать под неё разбор.
 *
 * Зачем. Разбор таблицы нельзя написать вслепую: колонок может оказаться не
 * столько, сколько кажется по распечатке, шапка может занимать три строки, а
 * половина страниц — быть продолжением без шапки вовсе. Этот скрипт не
 * извлекает данные, он отвечает на три вопроса, с которых начинается работа:
 *
 *   1. Есть ли текстовый слой. Если нет — разбор таблицы не поможет вообще,
 *      нужен другой инструмент, и узнать это надо до, а не после.
 *   2. Сколько колонок нашлось и где проходят их границы.
 *   3. Какие строки накрыты словом поперёк колонок — это шапки и объединённые
 *      ячейки, и именно они ломают наивный разбор.
 *
 * Плюс сверка двух наборов порогов на одной странице: если разбор устойчив,
 * оба дадут одно и то же. Расхождение означает, что колонки держатся на
 * случайном зазоре, и пороги надо задавать явно, а не выводить из страницы.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/inspect-pdf-table.ts <файл.pdf> [--page N] [--rows N]
 */

interface Args {
  readonly file: string;
  readonly page: number;
  readonly rows: number;
}

function parseArgs(argv: readonly string[]): Args {
  const file = argv.find((value) => !value.startsWith("--"));
  if (file === undefined) {
    throw new Error(
      "Укажите путь к PDF: npx tsx scripts/fsnb/inspect-pdf-table.ts <файл.pdf> [--page N] [--rows N]",
    );
  }

  const numeric = (name: string, fallback: number): number => {
    const at = argv.indexOf(name);
    if (at < 0) return fallback;
    const raw = argv[at + 1];
    const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`У аргумента ${name} нет положительного числового значения.`);
    }
    return value;
  };

  return { file, page: numeric("--page", 1), rows: numeric("--rows", 15) };
}

/** Печатает сетку столбиками, обрезая длинные ячейки — это осмотр, а не выгрузка. */
function printGrid(grid: TableGrid, limit: number): void {
  const shown = grid.rows.slice(0, limit);
  const widths = grid.columns.map((_, column) =>
    Math.min(
      28,
      Math.max(4, ...shown.map((row) => (row[column] ?? "").length)),
    ),
  );

  for (const [index, row] of shown.entries()) {
    const marker = grid.spanningRows.includes(index) ? "»" : " ";
    const cells = row.map((cell, column) => {
      const width = widths[column] ?? 8;
      const text = cell.length > width ? `${cell.slice(0, width - 1)}…` : cell;
      return text.padEnd(width);
    });
    console.log(`${marker}${String(index).padStart(3)} │ ${cells.join(" │ ")}`);
  }

  if (grid.rows.length > limit) {
    console.log(`     … ещё ${grid.rows.length - limit} строк`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.file);
  const bytes = new Uint8Array(readFileSync(path));

  console.log(`Файл: ${path}`);
  console.log(`Размер: ${bytes.byteLength.toLocaleString("ru-RU")} байт\n`);

  const result = await readPdfTextBoxes(bytes);

  if (!result.hasTextLayer) {
    /*
      Ради этой ветки скрипт и написан. Пустой текстовый слой не означает, что
      разбор сломался: это скан, и тогда нужен не парсер таблицы, а
      распознавание. Перепутать эти два случая — потерять день на отладку
      того, что работает правильно.
    */
    console.log("ТЕКСТОВОГО СЛОЯ НЕТ.");
    console.log("Документ отсканирован: разбор таблицы по координатам здесь бесполезен,");
    console.log("сначала нужно распознавание, и только потом эта же сетка — по словам OCR.");
    return;
  }

  const totalBoxes = result.pages.reduce((acc, page) => acc + page.boxes.length, 0);
  const rotated = result.pages.reduce((acc, page) => acc + page.rotatedSkipped, 0);

  console.log(`Страниц: ${result.pages.length}`);
  console.log(`Слов с координатами: ${totalBoxes.toLocaleString("ru-RU")}`);
  console.log(`Пропущено повёрнутых: ${rotated}\n`);

  const page = result.pages[args.page - 1];
  if (page === undefined) {
    throw new Error(`В документе нет страницы ${args.page}: всего ${result.pages.length}.`);
  }

  const grid = buildTableGrid(page.boxes);
  console.log(`Страница ${args.page}: слов ${page.boxes.length}, строк ${grid.rows.length}, колонок ${grid.columns.length}`);
  console.log(
    `Границы колонок: ${grid.columns.map((band) => `${band.left.toFixed(0)}–${band.right.toFixed(0)}`).join(", ")}`,
  );
  console.log(
    grid.spanningRows.length === 0
      ? "Строк поперёк колонок нет.\n"
      : `Строки поперёк колонок (помечены »): ${grid.spanningRows.join(", ")}\n`,
  );

  printGrid(grid, args.rows);

  /*
    Сверка устойчивости. Пороги по умолчанию выводятся из высоты слов; если
    подвинуть их и разбор не изменится, колонки держатся на настоящих зазорах.
    Если изменится — зазор между какими-то колонками сопоставим с пробелом
    внутри ячейки, и пороги придётся задавать явно.
  */
  const heights = page.boxes.map((item) => item.height).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] ?? 10;
  const tighter = buildTableGrid(page.boxes, { minColumnGap: typical * 0.6 });
  const looser = buildTableGrid(page.boxes, { minColumnGap: typical * 1.4 });

  console.log("\nУстойчивость разбора:");
  console.log(`  порог ×0,6 → колонок ${tighter.columns.length}, расхождений ${diffGrids(grid, tighter).length}`);
  console.log(`  порог ×1,4 → колонок ${looser.columns.length}, расхождений ${diffGrids(grid, looser).length}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
