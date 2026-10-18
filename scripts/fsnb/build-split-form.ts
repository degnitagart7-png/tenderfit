import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import {
  parseSplitForm,
  splitFormCoverage,
  toCurrentPrice,
  type BaseMachineFacts,
  type SheetRow,
} from "../../src/domain/estimate/splitForm";

/**
 * Сборка текущих цен и индексов из сплит-формы ФГИС ЦС.
 *
 * Зачем отдельный файл индекса, а не правка prices-current.jsonl. Сплит-форма —
 * другой источник с другим составом: в ней 281 732 строки против 2 800 в нашей
 * прежней выгрузке ФСЦСР, и часть цен получена не измерением, а индексом к
 * группе однородных ресурсов. Смешать их в одном файле значило бы потерять
 * различие между «цена зоны за квартал» и «база 2022 года, пересчитанная
 * индексом», а именно это различие расчёт печатает в каждой строке сметы.
 *
 * Оплата труда машинистов берётся из prices-base.jsonl: сплит-форма её отдельной
 * колонкой не публикует, а расчёту она нужна для фонда оплаты труда. Как
 * именно она переносится — описано в `toCurrentPrice`.
 *
 * Запуск:
 *   npx tsx scripts/fsnb/build-split-form.ts "<Сплит-форма ….xlsx>"
 */

const OUTPUT = resolve("data/fsnb/index/prices-split.jsonl");
const META = resolve("data/fsnb/index/split-form.json");
const BASE_PRICES = resolve("data/fsnb/index/prices-base.jsonl");
const NORMS = resolve("data/fsnb/index/norms.jsonl");

/**
 * Коды ресурсов, которые вообще встречаются в нормах ФСНБ.
 *
 * Зачем фильтр. В сплит-форме 281 732 строки, а нормы ссылаются всего на 6 664
 * разных кода — то есть расчёту нужно 2 % выгрузки. Остальное это цены на
 * ресурсы, которых нет ни в одной расценке: держать их в памяти значит платить
 * 140 МБ на зону за данные, к которым расчёт не обратится ни разу. С фильтром
 * зона стоит около трёх мегабайт, и тогда несколько десятков регионов живут на
 * одной машине без ухищрений.
 *
 * Флаг `--all` оставляет выгрузку целиком: он нужен, когда база обновлена
 * дополнениями и в нормах появились коды, которых на момент сборки не было.
 */
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

/** Оплата труда звена по коду машины — только то, чего нет в сплит-форме. */
async function machineFacts(): Promise<Map<string, BaseMachineFacts>> {
  const map = new Map<string, BaseMachineFacts>();
  const reader = createInterface({
    input: createReadStream(BASE_PRICES),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (line.trim() === "") continue;
    let record: {
      code?: string;
      machinistSalary?: number | null;
      machinistHours?: number | null;
    };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const { code, machinistSalary, machinistHours } = record;
    if (code === undefined) continue;
    if (typeof machinistSalary !== "number") continue;
    map.set(code, {
      machinistSalary,
      machinistHours: typeof machinistHours === "number" ? machinistHours : 1,
    });
  }

  return map;
}

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((value) => !value.startsWith("--"));
  if (file === undefined) {
    throw new Error(
      'Укажите файл: npx tsx scripts/fsnb/build-split-form.ts "<Сплит-форма ….xlsx>"',
    );
  }

  /*
    xlsx грузится динамически: библиотека нужна только сборке, не расчёту.
    Пакет собран как CommonJS, и под tsx именованные функции уезжают в `default`,
    поэтому берём его оттуда, а не из пространства модуля.
  */
  const module_ = await import("xlsx");
  const XLSX =
    (module_ as unknown as { default?: typeof module_ }).default ?? module_;
  const workbook = XLSX.readFile(file);
  const sheetName = workbook.SheetNames[0];
  if (sheetName === undefined) throw new Error(`В ${file} нет листов.`);
  const sheet = workbook.Sheets[sheetName];
  if (sheet === undefined) throw new Error(`Лист ${sheetName} не читается.`);

  const rows = XLSX.utils.sheet_to_json<SheetRow>(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
  });

  const form = parseSplitForm(rows);
  const coverage = splitFormCoverage(form.rows);
  const machines = await machineFacts();
  const keepAll = process.argv.includes("--all");
  const used = keepAll ? null : await codesUsedByNorms();

  console.log(`Зона: ${form.meta.zone}, период: ${form.meta.period}`);
  console.log(`Письмо об индексах: ${form.meta.indexLetter}`);
  console.log(`Оплата труда: ${form.meta.wageAct}`);
  console.log(
    `Строк: ${coverage.total}, с текущей ценой ${coverage.withCurrentPrice}, ` +
      `по индексу ${coverage.withIndex}, без цены ${coverage.withNothing}`,
  );

  const lines: string[] = [];
  let indexed = 0;
  let skipped = 0;
  for (const row of form.rows) {
    if (used !== null && !used.has(row.code)) {
      skipped += 1;
      continue;
    }
    const price = toCurrentPrice(
      row,
      form.meta,
      machines.get(row.code) ?? null,
    );
    if (price === null) continue;
    if (price.source === "BASE_2022_INDEXED") indexed += 1;
    lines.push(JSON.stringify(price));
  }

  writeFileSync(OUTPUT, `${lines.join("\n")}\n`, "utf8");
  writeFileSync(
    META,
    `${JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        source: file,
        ...form.meta,
        coverage,
        written: lines.length,
        indexed,
        skippedUnusedByNorms: skipped,
      },
      null,
      1,
    )}\n`,
    "utf8",
  );

  console.log(
    `\nЗаписано цен: ${lines.length} (из них по индексу ${indexed}) → ${OUTPUT}`,
  );
  console.log(`Реквизиты выгрузки → ${META}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
