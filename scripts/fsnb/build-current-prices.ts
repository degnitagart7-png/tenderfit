import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import {
  parseCurrentPricesMeta,
  parseMachinePrices,
  parseMaterialPrices,
  zoneSlug,
  type SheetRow,
} from "@/domain/estimate/currentPrices";

/**
 * Сборка текущих цен из сборника ФГИС ЦС «Сметные цены строительных ресурсов».
 *
 * Зачем отдельно от сплит-формы. Это другой документ: в нём нет базисных цен,
 * групп однородных ресурсов и индексов к ним, зато у машин опубликована оплата
 * труда машинистов — та самая составляющая, которую из сплит-формы приходится
 * выводить пропорцией. Смешивать их в одном разборе значило бы потерять
 * различие между измеренной величиной и выведенной.
 *
 * Файл называется по зоне, а не «prices-current.jsonl»: у подписчика закупки
 * идут по разным регионам, и цены одной зоны не должны затирать другую. Какую
 * зону берёт расчёт, решает паспорт сборки.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/build-current-prices.ts "Сметные цены … (город Москва).xlsx"
 */

const INDEX_DIR = resolve("data/fsnb/index");
const NORMS = resolve(INDEX_DIR, "norms.jsonl");

/** Коды ресурсов, которые вообще встречаются в нормах ФСНБ. */
async function codesUsedByNorms(): Promise<Set<string>> {
  const used = new Set<string>();
  const reader = createInterface({
    input: createReadStream(NORMS),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (line.trim() === "") continue;
    let record: { resources?: { code?: string }[] };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    for (const resource of record.resources ?? []) {
      if (typeof resource.code === "string") used.add(resource.code);
    }
  }

  return used;
}

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((value) => !value.startsWith("--"));
  if (file === undefined) {
    throw new Error(
      'Укажите файл: npx tsx scripts/fsnb/build-current-prices.ts "<Сметные цены ….xlsx>"',
    );
  }

  const module_ = await import("xlsx");
  const XLSX =
    (module_ as unknown as { default?: typeof module_ }).default ?? module_;
  const workbook = XLSX.readFile(file);

  const sheetRows = (name: string | undefined): SheetRow[] =>
    name === undefined || workbook.Sheets[name] === undefined
      ? []
      : XLSX.utils.sheet_to_json<SheetRow>(workbook.Sheets[name], {
          header: 1,
          blankrows: false,
          defval: "",
        });

  const materialsSheet = sheetRows(workbook.SheetNames[0]);
  const machinesSheet = sheetRows(workbook.SheetNames[1]);

  const meta = parseCurrentPricesMeta(materialsSheet);
  if (meta.zone === "" || meta.period === "") {
    throw new Error(
      `В ${file} не читается шапка: зона «${meta.zone}», период «${meta.period}»`,
    );
  }

  const materials = parseMaterialPrices(materialsSheet, meta);
  const machines = parseMachinePrices(machinesSheet, meta);
  const all = [...materials, ...machines];

  const used = await codesUsedByNorms();
  const needed = all.filter((price) => used.has(price.code));

  const slug = zoneSlug(meta.zone);
  const output = resolve(INDEX_DIR, `prices-current.${slug}.jsonl`);
  writeFileSync(
    output,
    `${needed.map((price) => JSON.stringify(price)).join("\n")}\n`,
    "utf8",
  );

  console.log(`Зона: ${meta.zone}`);
  console.log(`Период: ${meta.period}`);
  console.log(
    `Материалов ${materials.length}, машин ${machines.length}, всего ${all.length}`,
  );
  console.log(
    `Нужных расчёту (есть в нормах ФСНБ): ${needed.length} — записано в ${output}`,
  );
  console.log(
    `С оплатой труда машинистов: ${needed.filter((p) => p.machinistSalary !== null).length}`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
