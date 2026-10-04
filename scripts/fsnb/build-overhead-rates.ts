import { readFileSync, writeFileSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import {
  buildOverheadRateMap,
  parseNormativeGrid,
  type NormativeGridRow,
  type NormativeKind,
  type OverheadNormative,
  withoutTableHeader,
} from "../../src/domain/estimate/overheadNormatives";
import { readPdfTextBoxes } from "../../src/lib/pdf/pdfTextBoxes";
import { buildTableGrid } from "../../src/lib/pdf/tableGrid";

/**
 * Сборка справочника НР и СП из приказов 812/пр и 774/пр.
 *
 * Зачем скрипт, а не разбор на ходу. Приказы — PDF по 700 КБ, они не меняются
 * месяцами, а расчёт сметы должен быть быстрым и работать без файловой системы.
 * Поэтому таблицы разбираются один раз и кладутся рядом с остальной выгрузкой
 * ФСНБ, а домен получает готовые нормативы.
 *
 * Полнота проверяется не на глаз. В выгрузке ФСНБ у каждой нормы есть указатель
 * `Nr`/`Sp`, и скрипт сверяет разобранные пункты со всеми указателями,
 * встречающимися в `norms.jsonl`. Разбор считается удачным, только когда
 * непокрытых указателей не осталось: пропущенный пункт означает, что часть
 * расценок молча уедет на резервный процент, а в смете это выглядит как
 * нормальное начисление.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/build-overhead-rates.ts <НР.pdf> <СП.pdf>
 */

const OUTPUT = resolve("data/fsnb/index/overhead-rates.json");
const NORMS = resolve("data/fsnb/index/norms.jsonl");

/** Страницы приложения: от заголовка «НОРМАТИВЫ … ПО ВИДАМ РАБОТ» до конца. */
const APPENDIX_TITLE = /НОРМАТИВЫ\s+(НАКЛАДНЫХ\s+РАСХОДОВ|СМЕТНОЙ\s+ПРИБЫЛИ)/i;

async function gridRows(file: string): Promise<NormativeGridRow[]> {
  const result = await readPdfTextBoxes(new Uint8Array(readFileSync(file)));
  if (!result.hasTextLayer) {
    throw new Error(
      `В ${file} нет текстового слоя: это скан, разбор не поможет.`,
    );
  }

  const rows: NormativeGridRow[] = [];
  let inAppendix = false;

  for (const page of result.pages) {
    const grid = buildTableGrid(page.boxes);
    if (!inAppendix) {
      const hasTitle = grid.rows.some((row) =>
        APPENDIX_TITLE.test(row.join(" ")),
      );
      if (!hasTitle) continue;
      inAppendix = true;
    }
    // Шапка повторяется на каждой странице: без неё строка нумерации колонок
    // выглядит как пункт 1, а номер страницы — как норматив.
    rows.push(...withoutTableHeader(grid.rows));
  }

  if (!inAppendix) {
    throw new Error(
      `В ${file} не нашлось приложения «Нормативы … по видам работ».`,
    );
  }
  return rows;
}

/** Все указатели НР и СП, которые встречаются в выгрузке ФСНБ. */
async function refsFromNorms(): Promise<{
  overhead: Set<string>;
  profit: Set<string>;
}> {
  const overhead = new Set<string>();
  const profit = new Set<string>();

  const reader = createInterface({
    input: createReadStream(NORMS),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (line.trim() === "") continue;
    let record: { overheadRef?: string | null; profitRef?: string | null };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (record.overheadRef) overhead.add(record.overheadRef);
    if (record.profitRef) profit.add(record.profitRef);
  }

  return { overhead, profit };
}

function report(
  kind: NormativeKind,
  parsed: readonly OverheadNormative[],
  expected: Set<string>,
): number {
  const found = new Set(parsed.map((item) => item.ref));
  const missing = [...expected].filter((ref) => !found.has(ref)).sort();
  const extra = [...found].filter((ref) => !expected.has(ref)).sort();
  const label = kind === "OVERHEAD" ? "НР (812/пр)" : "СП (774/пр)";

  console.log(
    `${label}: разобрано пунктов ${parsed.length}, указателей в ФСНБ ${expected.size}`,
  );
  if (missing.length > 0) {
    console.log(`  не покрыто ${missing.length}: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    console.log(
      `  лишних ${extra.length} (в выгрузке не встречаются): ${extra.slice(0, 15).join(", ")}${extra.length > 15 ? " …" : ""}`,
    );
  }
  if (missing.length === 0) console.log("  покрытие полное");

  return missing.length;
}

async function main(): Promise<void> {
  const files = process.argv
    .slice(2)
    .filter((value) => !value.startsWith("--"));
  const [overheadPdf, profitPdf] = files;
  if (overheadPdf === undefined || profitPdf === undefined) {
    throw new Error(
      "Укажите оба файла: npx tsx scripts/fsnb/build-overhead-rates.ts <НР.pdf> <СП.pdf>",
    );
  }

  const overhead = parseNormativeGrid(await gridRows(overheadPdf), "OVERHEAD");
  const profit = parseNormativeGrid(await gridRows(profitPdf), "PROFIT");

  const expected = await refsFromNorms();
  const gaps =
    report("OVERHEAD", overhead, expected.overhead) +
    report("PROFIT", profit, expected.profit);

  writeFileSync(
    OUTPUT,
    `${JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        sources: {
          overhead: "Приказ Минстроя России от 21.12.2020 № 812/пр",
          profit: "Приказ Минстроя России от 11.12.2020 № 774/пр",
        },
        overhead,
        profit,
      },
      null,
      1,
    )}\n`,
    "utf8",
  );
  console.log(`\nЗаписано: ${OUTPUT}`);

  // Пример: сколько процентов получит первая расценка земляных работ.
  const map = buildOverheadRateMap(overhead, "OVERHEAD");
  const sample = map.get("Пр/812-001.1");
  if (sample !== undefined) {
    console.log(
      `Проверка: ${sample.ref} → ${sample.percent} % — ${sample.workType}`,
    );
  }

  if (gaps > 0) {
    console.log(
      "\nЕсть непокрытые указатели: часть расценок уедет на резервный процент.",
    );
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
