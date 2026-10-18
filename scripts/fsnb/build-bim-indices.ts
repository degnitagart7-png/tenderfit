import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  BimDesignRecord,
  BimElementRecord,
  BimIndicesData,
  BimLetterInfo,
  BimSmrRecord,
  BimTransportRecord,
} from "../../src/domain/estimate/bimIndicesTypes";
import { parseBimIndexLetter, splitPages, type ParsedLetter } from "../../src/lib/fsnb/bimIndexText";

/**
 * Сборка справочника индексов БИМ из текстов писем Минстроя (`pdftotext -layout`).
 *
 * Локальная сборка: `npx tsx scripts/fsnb/build-bim-indices.ts` читает тексты из
 * `data/fsnb/normatives/sources/bim-indices-2026q3-<id>.txt` и пишет
 * `data/fsnb/normatives/bim-indices-2026q3.json` и копию для приложения
 * `src/domain/estimate/normativesData/bim-indices-2026q3.json` (каталог `data/` на сервер не выкладывается).
 * Квартальное обновление на сервере — `fetch-bim-indices.ts`: он скачивает письма, извлекает текст и зовёт
 * `buildBimIndices` из этого файла. Вручную JSON не правят.
 *
 * Слияние писем. Письма квартала охватывают разные субъекты и разные приложения, но пересекаются
 * (Ленинградская область — в четырёх). Одна и та же запись (субъект, зона, объект, база, вид) из двух писем —
 * побеждает более позднее по дате: Минстрой уточняет индексы последним письмом. Число таких замен — в notes.
 */

export const SOURCES_DIR = resolve(__dirname, "../../data/fsnb/normatives/sources");
export const OUTPUT_DIR = resolve(__dirname, "../../data/fsnb/normatives");
export const APP_COPY_DIR = resolve(__dirname, "../../src/domain/estimate/normativesData");

export const BASE_ROW_MEANING =
  "В клетке таблицы «Индексы к ФЕР-2001/ТЕР-2001» две строки: верхняя — индекс к единичным расценкам ФЕР-2001, нижняя — к ТЕР-2001 субъекта. " +
  "Так читается заголовок таблицы «ФЕР-2001/ТЕР-2001»; нижняя строка заполнена только у субъектов с собственными ТЕР-2001 (у Белгородской области " +
  "оплата труда 47,58 к ФЕР и 50,75 к ТЕР), у остальных стоит «-». Таблицы «Индексы к ФЕР-2001» (атомная энергетика, ВЛ ПАО «Россети», алмазодобыча, " +
  "железные дороги) печатают одну строку. Явной сноски об этом в тексте писем нет: вывод по заголовку и структуре таблиц, его стоит подтвердить в Минстрое.";

/** Письма III квартала 2026 года: реквизиты — из ФГИС ЦС (файл письма сохранён рядом с кодом). */
export const LETTERS_2026Q3: ReadonlyArray<Omit<BimLetterInfo, "pages">> = [
  {
    id: "d465eb3f",
    number: "45358-ИФ/09",
    date: "2026-07-23",
    title: "Индексы изменения сметной стоимости на III квартал 2026 года: по элементам прямых затрат по объектам строительства (ФЕР/ТЕР), СМР ж/д, ВЛ «Россети», проектные и изыскательские работы, перевозка",
    file: "bim-indices-2026q3-d465eb3f.txt",
  },
  {
    id: "4a127ad8",
    number: "46728-ИФ/09",
    date: "2026-07-30",
    title: "Индексы изменения сметной стоимости на III квартал 2026 года: по элементам прямых затрат по объектам строительства (ФЕР/ТЕР), алмазодобыча, перевозка",
    file: "bim-indices-2026q3-4a127ad8.txt",
  },
  {
    id: "862c733b",
    number: "50058-ИФ/09",
    date: "2026-08-13",
    title: "Индексы изменения сметной стоимости на III квартал 2026 года: по элементам прямых затрат по объектам строительства (ФЕР/ТЕР), атомная энергетика",
    file: "bim-indices-2026q3-862c733b.txt",
  },
  {
    id: "73448900",
    number: "53691-АЛ/09",
    date: "2026-08-28",
    title: "Индексы изменения сметной стоимости на III квартал 2026 года: по элементам прямых затрат по объектам строительства (ФЕР/ТЕР), СМР и ПНР, автомобильные дороги, атомная энергетика, перевозка",
    file: "bim-indices-2026q3-73448900.txt",
  },
  {
    id: "1ae7a169",
    number: "58705-ИФ/09",
    date: "2026-09-21",
    title: "Индекс изменения сметной стоимости СМР по объектам «Автомобильные дороги» и «Искусственные дорожные сооружения» на III квартал 2026 года",
    file: "bim-indices-2026q3-1ae7a169.txt",
  },
];

export interface LetterInput {
  readonly info: Omit<BimLetterInfo, "pages">;
  readonly text: string;
}

const elementKey = (record: BimElementRecord): string => `${record.subject}|${String(record.zone)}|${record.object}|${record.base}`;
const smrKey = (record: BimSmrRecord): string => `${record.subject}|${String(record.zone)}|${record.object}|${record.base}|${record.kind}`;
const transportKey = (record: BimTransportRecord): string => `${record.subject}|${String(record.zone)}|${record.vehicle}`;
const designKey = (record: BimDesignRecord): string => `${record.kind}|${record.level}`;

/** Записи из писем по порядку дат: поздняя заменяет раннюю. Возвращает записи и число замен. */
function mergeRecords<T extends { readonly letter: string }>(
  parts: ReadonlyArray<{ readonly date: string; readonly records: readonly T[] }>,
  keyOf: (record: T) => string,
): { records: T[]; replaced: number } {
  const byKey = new Map<string, T>();
  let replaced = 0;
  for (const part of [...parts].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const record of part.records) {
      const key = keyOf(record);
      const previous = byKey.get(key);
      if (previous !== undefined && previous.letter !== record.letter) replaced += 1;
      byKey.set(key, record);
    }
  }
  return { records: [...byKey.values()], replaced };
}

/** Собирает справочник из текстов писем одного квартала. Письма разных кварталов — ошибка. */
export function buildBimIndices(letters: readonly LetterInput[]): { data: BimIndicesData; parsed: ReadonlyMap<string, ParsedLetter> } {
  if (letters.length === 0) throw new Error("Нет ни одного письма с индексами.");
  const parsed = new Map<string, ParsedLetter>();
  const notes: string[] = [];
  let quarter: { year: number; quarter: 1 | 2 | 3 | 4 } | null = null;

  for (const letter of letters) {
    const result = parseBimIndexLetter(letter.text, letter.info.id);
    parsed.set(letter.info.id, result);
    if (result.quarter !== null) {
      const found = { year: result.quarter.year, quarter: result.quarter.quarter as 1 | 2 | 3 | 4 };
      if (quarter !== null && (quarter.year !== found.year || quarter.quarter !== found.quarter)) {
        throw new Error(
          `Письмо ${letter.info.number} относится к ${String(found.quarter)} кварталу ${String(found.year)}, а остальные — к ${String(quarter.quarter)} кварталу ${String(quarter.year)}.`,
        );
      }
      quarter = found;
    }
    for (const warning of result.warnings) notes.push(`${letter.info.number}: ${warning}`);
    for (const skipped of result.skipped) notes.push(`${letter.info.number}: ${skipped}`);
  }
  if (quarter === null) throw new Error("Ни в одном письме не найден квартал («на III квартал 2026 года»).");

  const dated = letters.map((letter) => ({ date: letter.info.date, parsed: parsed.get(letter.info.id) as ParsedLetter }));
  const elements = mergeRecords(dated.map((item) => ({ date: item.date, records: item.parsed.elements })), elementKey);
  const smr = mergeRecords(dated.map((item) => ({ date: item.date, records: item.parsed.smr })), smrKey);
  const transport = mergeRecords(dated.map((item) => ({ date: item.date, records: item.parsed.transport })), transportKey);
  const design = mergeRecords(dated.map((item) => ({ date: item.date, records: item.parsed.design })), designKey);
  const replaced = elements.replaced + smr.replaced + transport.replaced + design.replaced;
  if (replaced > 0) notes.push(`Записей, которые повторяются в нескольких письмах: ${String(replaced)}; взято значение более позднего письма.`);

  const data: BimIndicesData = {
    version: 1,
    quarter,
    baseRowMeaning: BASE_ROW_MEANING,
    letters: letters.map((letter) => ({ ...letter.info, pages: splitPages(letter.text).length })),
    elements: elements.records,
    smr: smr.records,
    transport: transport.records,
    design: design.records,
    notes,
  };
  return { data, parsed };
}

/** JSON с одной записью на строку: читается глазами и даёт построчный diff при обновлении квартала. */
export function stringifyBimIndices(data: BimIndicesData): string {
  const lines: string[] = ["{"];
  const scalar = (key: string, value: unknown, last = false): void => {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${last ? "" : ","}`);
  };
  const list = (key: string, items: readonly unknown[], last = false): void => {
    if (items.length === 0) {
      lines.push(`  ${JSON.stringify(key)}: []${last ? "" : ","}`);
      return;
    }
    lines.push(`  ${JSON.stringify(key)}: [`);
    items.forEach((item, index) => lines.push(`    ${JSON.stringify(item)}${index === items.length - 1 ? "" : ","}`));
    lines.push(`  ]${last ? "" : ","}`);
  };
  scalar("version", data.version);
  scalar("quarter", data.quarter);
  scalar("baseRowMeaning", data.baseRowMeaning);
  list("letters", data.letters);
  list("elements", data.elements);
  list("smr", data.smr);
  list("transport", data.transport);
  list("design", data.design);
  list("notes", data.notes, true);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function bimIndicesFileName(quarter: BimIndicesData["quarter"]): string {
  return `bim-indices-${String(quarter.year)}q${String(quarter.quarter)}.json`;
}

/** Читает сохранённые тексты писем III квартала 2026 года. */
export function readLetters2026q3(): LetterInput[] {
  return LETTERS_2026Q3.map((info) => {
    const path = resolve(SOURCES_DIR, info.file ?? "");
    if (!existsSync(path)) throw new Error(`Нет текста письма ${info.number}: ${path}`);
    return { info, text: readFileSync(path, "utf8") };
  });
}

function main(): void {
  const { data, parsed } = buildBimIndices(readLetters2026q3());
  const json = stringifyBimIndices(data);
  const name = bimIndicesFileName(data.quarter);
  for (const dir of [OUTPUT_DIR, APP_COPY_DIR]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, name), json, "utf8");
  }
  process.stdout.write(`${name}: ${String(data.elements.length)} записей по элементам, ${String(data.smr.length)} СМР, ${String(data.transport.length)} перевозка, ${String(data.design.length)} ПИР\n`);
  for (const [id, result] of parsed) {
    process.stdout.write(`  ${id}: ${JSON.stringify(result.stats)}${result.warnings.length > 0 ? `, предупреждений ${String(result.warnings.length)}` : ""}\n`);
  }
  for (const note of data.notes) process.stdout.write(`  ПРИМЕЧАНИЕ: ${note}\n`);
}

if (typeof require !== "undefined" && require.main === module) main();
