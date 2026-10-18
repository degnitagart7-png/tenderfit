import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  NorthClass,
  NorthData,
  NorthEntry,
  NorthSubject,
  NormativeSourceInfo,
  TemperatureZone,
  TemperatureZoneInfo,
  TemporaryData,
  TemporaryNormRow,
  WinterData,
  WinterNormRow,
  WinterRule,
  WinterZonePart,
} from "../../src/domain/estimate/normativeTypes";
import { TEMPERATURE_ZONES } from "../../src/domain/estimate/normativeTypes";
import { buildWorkConditions } from "./work-conditions-data";

/**
 * Сборка справочников нормативов из сохранённых текстов первоисточников.
 *
 * Тексты лежат в `data/fsnb/normatives/sources/` и получены из PDF справочных систем без правок
 * (см. шапки файлов). Здесь они разбираются в JSON: зимнее удорожание (приказ 325/пр), временные
 * здания (332/пр), районы Крайнего Севера (постановление Правительства РФ N 1946) и условия
 * производства работ (421/пр, приложение 10). Каждая запись несёт `fragment` — кусок исходного
 * текста, по которому `build-normatives.test.ts` проверяет число в JSON. Правка вручную в JSON
 * запрещена: меняйте источник или этот скрипт и запускайте заново.
 *
 *   npx tsx scripts/fsnb/build-normatives.ts
 */

export const SOURCES_DIR = resolve("data/fsnb/normatives/sources");
export const OUTPUT_DIR = resolve("data/fsnb/normatives");
/**
 * Копия JSON для приложения. `data/` на сервер не выкладывается (deploy/deploy-app.sh исключает
 * каталог целиком), а справочники нужны и сборке Next.js, и воркеру, и браузеру — поэтому те же файлы
 * лежат рядом с кодом. Тест следит, чтобы копия совпадала с `data/fsnb/normatives`.
 */
export const APP_COPY_DIR = resolve("src/domain/estimate/normativesData");

export function readSource(file: string): string {
  return readFileSync(resolve(SOURCES_DIR, file), "utf8");
}

/** Текст без служебных строк постраничной печати (`=== стр. N ===`, «Страница N из M»). */
export function pageless(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => !/^=== стр\. \d+ ===$/u.test(line) && !/^Страница \d+ из \d+$/u.test(line));
}

/* ------------------------------------------------------------------ */
/* Приложения 1 и 2 к 325/пр и приложения 1 и 2 к 332/пр: таблицы чисел */
/* ------------------------------------------------------------------ */

const VALUE_TOKEN = /^(\d+,\d+|-)-?$/u;
const ITEM_START = /^(\d{1,3}(?:\.\d{1,2}){0,2}(?:\(\d\))?)(?:\s+(\S.*))?$/u;

interface RawRow {
  readonly item: string;
  readonly section: string;
  nameParts: string[];
  values: string[];
  /** Числа по строкам источника (для сверки): «11,7 0 16,1 7 …». */
  fragmentParts: string[];
}

function joinBrokenItemIds(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const next = lines[i + 1];
    if (/^\d{1,3}\(\d$/u.test(line.trim()) && next !== undefined && next.trim() === ")") {
      out.push(`${line.trim()})`);
      i += 1;
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Разбирает таблицу «номер, наименование, N чисел». Числа в источнике иногда переносятся
 * («11,7» + «0» = 11,70): одиночная цифра сразу после числа достраивает его.
 */
export function parseNumericTable(
  lines: readonly string[],
  columns: number,
  isSection: (line: string) => string | null,
): RawRow[] {
  const rows: RawRow[] = [];
  let current: RawRow | null = null;
  let section = "";
  let valuesDone = false;
  let lastInt = 0;

  for (const rawLine of joinBrokenItemIds([...lines])) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (/^Позиция утратила силу/u.test(line) || /^\((?:п\.|пп\.|в ред\.|введено|введен)/u.test(line)) continue;

    const sectionTitle = isSection(line);
    if (sectionTitle !== null) {
      section = sectionTitle;
      current = null;
      continue;
    }

    const start = ITEM_START.exec(line);
    const tokens = line.split(/\s+/u);
    const allValues = tokens.every((token) => VALUE_TOKEN.test(token));

    if (current !== null && current.values.length > 0 && tokens.length === 1 && /^\d{1,2}$/u.test(line)) {
      // Перенесённый хвост числа.
      const last = current.values.length - 1;
      current.values[last] = `${current.values[last] as string}${line}`;
      current.fragmentParts.push(line);
      continue;
    }

    const startInt = start === null ? -1 : Number.parseInt(start[1] as string, 10);
    // Номер следующей строки не может прыгнуть: «35 кВ и выше» внутри наименования пункта 51 — не пункт 35.
    const plausible =
      start !== null &&
      startInt >= lastInt &&
      startInt <= lastInt + 2 &&
      (start[2] !== undefined || (start[1] as string).includes("("));
    if (start !== null && plausible && !allValues) {
      const item = start[1] as string;
      const rest = start[2] ?? "";
      lastInt = startInt;
      current = { item, section, nameParts: [], values: [], fragmentParts: [] };
      valuesDone = false;
      rows.push(current);
      absorb(current, rest, columns, () => {
        valuesDone = true;
      });
      continue;
    }

    if (current === null) continue;
    if (allValues && !valuesDone) {
      absorb(current, line, columns, () => {
        valuesDone = true;
      });
      continue;
    }
    if (!valuesDone || continuation(line)) {
      absorb(current, line, columns, () => {
        valuesDone = true;
      });
    }
  }
  return rows;
}

/** Строка после чисел продолжает наименование, если не похожа на заголовок раздела. */
function continuation(line: string): boolean {
  return /^[а-яё(\d]/u.test(line);
}

function absorb(row: RawRow, text: string, columns: number, done: () => void): void {
  const tokens = text.split(/\s+/u);
  const nameTokens: string[] = [];
  for (const token of tokens) {
    if (row.values.length < columns && VALUE_TOKEN.test(token) && (row.values.length > 0 || /,|^-$/u.test(token))) {
      // Число принимается только после того, как наименование закончилось: «0,4 - 35 кВ» в названии — не норматив.
      if (row.values.length === 0 && nameTokens.length === 0 && row.nameParts.length === 0 && token === "-") {
        // одиночный прочерк в начале строки без имени — значение
      }
      row.values.push(token.replace(/-$/u, "") === "" ? "-" : token.replace(/-$/u, ""));
      row.fragmentParts.push(token);
      if (row.values.length === columns) done();
    } else {
      nameTokens.push(token);
    }
  }
  if (nameTokens.length > 0) row.nameParts.push(nameTokens.join(" "));
}

function toNumber(value: string): number {
  return Number(value.replace(",", "."));
}

/* ------------------------------ Зимнее удорожание ------------------------------ */

const WINTER_SOURCE: NormativeSourceInfo = {
  id: "325-pr",
  title:
    "Приказ Минстроя России от 25.05.2021 N 325/пр «Об утверждении Методики определения дополнительных затрат при производстве работ в зимнее время» (рег. Минюста 28.07.2021 N 64411)",
  edition:
    "с изменениями приказа Минстроя России от 21.03.2025 N 170/пр (рег. Минюста 11.09.2025 N 83519); приказ от 30.03.2026 N 192/пр (рег. Минюста 30.04.2026 N 86299) в сохранённый текст не вошёл",
  url: "https://tu78.rosim.gov.ru/app/uploads/2026/04/730e05_prikaz-25.05.2021-n-325.pdf",
  file: "325-pr-zimnee-udorozhanie.txt",
  notes: [
    "Приказ 192/пр по справочным данным меняет строку 55.4 приложения 1 и строку 83(1) приложения 4; строка 55.4 не перенесена, строка 83(1) перенесена в редакции 170/пр (не используется расчётом).",
    "Текст получен из PDF печатной формы справочной системы на сайте Росимущества; первоисточник publication.pravo.gov.ru открыть не удалось.",
  ],
};

const WINTER_SECTIONS_A1 = new Map<string, string>([
  ["Промышленное строительство", "Промышленное строительство"],
  ["Предприятия строительной индустрии и строительных материалов", "Предприятия строительной индустрии и строительных материалов"],
  ["Энергетическое строительство", "Энергетическое строительство"],
  ["Горнопроходческие работы (без общешахтных расходов)", "Горнопроходческие работы (без общешахтных расходов)"],
  ["Склады и хранилища", "Склады и хранилища"],
  ["Мелиоративное и водохозяйственное строительство", "Мелиоративное и водохозяйственное строительство"],
  ["Прочие объекты", "Прочие объекты"],
  ["Воздушные линии электропередачи", "Воздушные линии электропередачи"],
  ["Магистральные трубопроводы", "Магистральные трубопроводы"],
  ["Строительство дорог", "Строительство дорог"],
  ["Искусственные дорожные сооружения", "Искусственные дорожные сооружения"],
  ["Строительство производственных и служебных зданий эксплуатации", "Строительство производственных и служебных зданий эксплуатации"],
  ["Аэродромные сооружения летных полей (за исключением оборудования)", "Аэродромные сооружения летных полей"],
  ["Электрификация, устройство связи, сигнализации железных дорог и прочие", "Электрификация, устройство связи, сигнализации железных дорог и прочие работы"],
  ["Строительство тоннелей и", "Строительство тоннелей и метрополитенов"],
  ["Сети инженерно-технического обеспечения", "Сети инженерно-технического обеспечения"],
  ["Объекты жилищного назначения (без учета наружных инженерных сетей,", "Объекты жилищного назначения (без учета наружных инженерных сетей, внутриквартальной планировки и проездов, благоустройства, озеленения)"],
  ["Объекты общественного, социально-культурного и коммунально-бытового", "Объекты общественного, социально-культурного и коммунально-бытового назначения"],
  ["Снос объектов капитального строительства", "Снос объектов капитального строительства"],
]);

/** Заголовки-продолжения, которые не должны попасть в наименование или раздел. */
const WINTER_HEADING_TAILS = new Set([
  "работы",
  "метрополитенов",
  "внутриквартальной планировки и проездов, благоустройства, озеленения)",
  "назначения",
]);

function winterSection(line: string): string | null {
  return WINTER_SECTIONS_A1.get(line) ?? null;
}

function tableLines(all: readonly string[], fromMarker: string, toMarker: string): string[] {
  const from = all.indexOf(fromMarker);
  const to = all.indexOf(toMarker, from + 1);
  if (from < 0 || to < 0) throw new Error(`Не найдены границы «${fromMarker}» - «${toMarker}»`);
  const slice = all.slice(from + 1, to);
  // Шапка таблицы кончается строкой нумерации граф «1 2 3 ... 10».
  const header = slice.findIndex((line) => /^1 2 3 4 5 6 7 8 9 10$/u.test(line.trim()));
  return slice.slice(header + 1).filter((line) => !WINTER_HEADING_TAILS.has(line.trim()));
}

function winterRowsOf(table: "A1" | "A2", raw: readonly RawRow[]): WinterNormRow[] {
  const rows: WinterNormRow[] = [];
  const parents = new Map<string, string>();
  for (const row of raw) {
    if (row.values.length === 0) {
      // Заголовок группы («46 Насосные станции:»): его название входит в наименование подпунктов.
      parents.set(row.item, row.nameParts.join(" ").replace(/\s+/gu, " ").trim());
      continue;
    }
    if (row.values.length !== 8) {
      throw new Error(`Приложение ${table}, пункт ${row.item}: ${String(row.values.length)} чисел вместо 8`);
    }
    const percent: Partial<Record<TemperatureZone, number>> = {};
    TEMPERATURE_ZONES.forEach((zone, index) => {
      const value = row.values[index] as string;
      if (value !== "-") percent[zone] = toNumber(value);
    });
    rows.push({
      id: `${table}-${row.item.replace(/[()]/gu, (c) => (c === "(" ? "." : ""))}`,
      table,
      item: row.item,
      section: row.section,
      name: [row.item.includes(".") ? (parents.get(row.item.split(".")[0] as string) ?? "") : "", row.nameParts.join(" ")]
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim(),
      percent,
      fragment: row.fragmentParts.join(" "),
    });
  }
  return rows;
}

const WINTER_TABLE1 = /^(\d)\s+(I|II|III|IV|V|VI|VII|VIII)\s+(до \d+|ниже \d+ до \d+|ниже \d+)\s+(0,\d+)$/u;

export function parseTemperatureZones(lines: readonly string[]): TemperatureZoneInfo[] {
  const out: TemperatureZoneInfo[] = [];
  for (const line of lines) {
    const m = WINTER_TABLE1.exec(line.trim());
    if (m === null) continue;
    out.push({
      zone: m[2] as TemperatureZone,
      meanTemperature: `${m[3] as string} град. C`,
      winterShare: toNumber(m[4] as string),
      fragment: line.trim(),
    });
  }
  if (out.length !== 8) throw new Error(`Таблица N 1: найдено ${String(out.length)} зон из 8`);
  return out;
}

/* ------------------------- Приложение 4 к 325/пр (зоны по субъектам) ------------------------- */

const ZONE_TAIL = /(?:^|\s)(VIII|VII|VI|IV|V|III|II|I)\s+(\d{1,2}\.\d{1,2})\s+(\d{1,2}\.\d{1,2})\s+(\d(?:[.,]\d+)?)$/u;

export interface ZoneDraft {
  readonly item: string;
  readonly subject: string;
  readonly description: string;
  readonly zone: TemperatureZone;
  readonly winterStart: string;
  readonly winterEnd: string;
  readonly coefficient: number;
  readonly fragment: string;
}

const SUB_ID = /^(\d{1,3}\.\d{1,2}|\d{1,3}\(\d\))(?:\s+(.*))?$/u;

/**
 * Приложение 4: запись заканчивается строкой «зона начало конец коэффициент». Всё до неё — номер
 * части, описание и (если часть первая у субъекта) заголовок субъекта.
 */
export function parseZoneParts(lines: readonly string[]): ZoneDraft[] {
  const out: ZoneDraft[] = [];
  let subject = "";
  let prefix: string[] = [];
  let afterTail = false;

  for (const rawLine of joinBrokenItemIds([...lines])) {
    const line = rawLine.trim();
    if (line === "" || /^\((?:в ред\.|п\.|пп\.)/u.test(line)) continue;
    const tail = ZONE_TAIL.exec(line);
    if (tail === null) {
      // Печать разрывает описание части: хвост «зона, даты, коэффициент» стоит выше последних слов описания.
      // Строка без номера сразу после хвоста — продолжение описания той же части.
      if (afterTail && !/^\d{1,3}(?:\.\d{1,2}|\(\d\))?(?:\s|$)/u.test(line)) {
        const last = out[out.length - 1] as ZoneDraft;
        out[out.length - 1] = { ...last, description: `${last.description} ${line}`.replace(/\s+/gu, " ").trim() };
        continue;
      }
      afterTail = false;
      prefix.push(line);
      continue;
    }
    afterTail = true;
    const record = [...prefix, line.slice(0, tail.index).trim()].filter((part) => part !== "");
    prefix = [];

    const subIndex = record.findIndex((part) => SUB_ID.test(part));
    let item: string;
    let description: string;
    if (subIndex >= 0) {
      const header = record.slice(0, subIndex).join(" ").replace(/\s+/gu, " ").trim();
      if (header !== "") {
        const h = /^\d{1,3}\s+(.*)$/u.exec(header);
        subject = (h === null ? header : (h[1] as string)).replace(/:$/u, "").trim();
      }
      const sub = SUB_ID.exec(record[subIndex] as string) as RegExpExecArray;
      item = sub[1] as string;
      description = [sub[2] ?? "", ...record.slice(subIndex + 1)].join(" ").replace(/\s+/gu, " ").trim();
    } else {
      const whole = record.join(" ").replace(/\s+/gu, " ").trim();
      const w = /^(\d{1,3})\s+(.*)$/u.exec(whole);
      if (w === null) throw new Error(`Приложение 4: запись без номера «${whole}»`);
      item = w[1] as string;
      subject = (w[2] as string).replace(/:$/u, "").trim();
      description = "";
    }
    out.push({
      item,
      subject,
      description,
      zone: tail[1] as TemperatureZone,
      winterStart: tail[2] as string,
      winterEnd: tail[3] as string,
      coefficient: toNumber((tail[4] as string).replace(".", ",")),
      fragment: `${tail[1] as string} ${tail[2] as string} ${tail[3] as string} ${tail[4] as string}`,
    });
  }
  return out;
}

/* ------------------------------ Временные здания ------------------------------ */

const TEMPORARY_SOURCE: NormativeSourceInfo = {
  id: "332-pr",
  title:
    "Приказ Минстроя России от 19.06.2020 N 332/пр «Об утверждении Методики определения затрат на строительство временных зданий и сооружений, включаемых в сводный сметный расчет стоимости строительства объектов капитального строительства» (рег. Минюста 29.10.2020 N 60665)",
  edition: "с изменениями приказов Минстроя России от 21.09.2023 N 683/пр и от 13.08.2024 N 534/пр",
  url: "https://agentstvotek.ru/upload/files/Приказ 19.06.2020 N 332_пр (ред. от 13.08...).pdf",
  file: "332-pr-vremennye-zdaniya.txt",
  notes: [
    "Текст получен из PDF печатной формы справочной системы на стороннем сайте; первоисточник publication.pravo.gov.ru открыть не удалось.",
  ],
};

/** Разделы приложения 1 к 332/пр. */
const TEMPORARY_SECTIONS = new Map<string, string>([
  ["Промышленное строительство", "Раздел 1. Промышленное строительство"],
  ["Энергетическое строительство", "Раздел 1. Энергетическое строительство"],
  ["Объекты обороны и безопасности", "Раздел 1. Объекты обороны и безопасности"],
  ["Прочие объекты строительства", "Раздел 1. Прочие объекты строительства"],
  ["Объекты жилищно-гражданского строительства в городских поселениях", "Раздел 3. Объекты жилищно-гражданского строительства в городских поселениях"],
  ["Объекты жилищно-гражданского строительства в сельской местности", "Раздел 3. Объекты жилищно-гражданского строительства в сельской местности"],
]);

const TEMPORARY_ROW = /^(\d{1,2}(?:\.\d{1,2}){0,2})\s+(.+?)\s+(\d{1,2},\d)$/u;
const TEMPORARY_ID = /^(\d{1,2}(?:\.\d{1,2}){0,2})\s+(\S.*)$/u;

/**
 * Приложения 1 и 2 к 332/пр: «номер, наименование, норматив». Строка-заголовок группы («5 Предприятия
 * горнодобывающей промышленности:») числа не несёт, её название входит в наименование подпунктов.
 */
export function parseTemporaryAppendix(
  lines: readonly string[],
  table: "A1" | "A2",
): TemporaryNormRow[] {
  const out: TemporaryNormRow[] = [];
  const parents = new Map<string, string>();
  let section = "";
  let chapter = "";
  let buf: string[] = [];

  const ancestors = (item: string): string => {
    const parts = item.split(".");
    const names: string[] = [];
    for (let n = 1; n < parts.length; n += 1) {
      const name = parents.get(parts.slice(0, n).join("."));
      if (name !== undefined) names.push(name);
    }
    return names.join(" ");
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || /^\((?:в ред\.|п\.|пп\.)/u.test(line)) continue;
    const chapterMatch = /^Раздел (\d)\. /u.exec(line);
    if (chapterMatch !== null) {
      chapter = `Раздел ${chapterMatch[1] as string}`;
      section = chapter;
      buf = [];
      continue;
    }
    const heading = TEMPORARY_SECTIONS.get(line);
    if (heading !== undefined) {
      section = table === "A1" ? heading : line;
      buf = [];
      continue;
    }
    if (TEMPORARY_ID.test(line)) {
      if (buf.length > 0) {
        const head = TEMPORARY_ID.exec(buf[0] as string);
        if (head !== null) parents.set(head[1] as string, buf.join(" ").replace(/^\S+\s+/u, "").replace(/\s+/gu, " ").trim());
      }
      buf = [line];
    } else if (buf.length > 0) {
      buf.push(line);
    } else {
      continue;
    }
    const full = TEMPORARY_ROW.exec(buf.join(" ").replace(/\s+/gu, " ").trim());
    if (full === null) continue;
    const item = full[1] as string;
    const own = (full[2] as string).trim();
    out.push({
      id: `${table}-${item}`,
      table,
      item,
      section,
      name: [ancestors(item), own].filter((part) => part !== "").join(" ").replace(/\s+/gu, " ").trim(),
      percent: toNumber(full[3] as string),
      fragment: `${item} ${own} ${full[3] as string}`.replace(/\s+/gu, " "),
    });
    buf = [];
  }
  return out;
}

/* ------------------------------ Север ------------------------------ */

const NORTH_SOURCE: NormativeSourceInfo = {
  id: "pp-1946",
  title:
    "Постановление Правительства Российской Федерации от 16.11.2021 N 1946 «Об утверждении перечня районов Крайнего Севера и местностей, приравненных к районам Крайнего Севера, в целях предоставления государственных гарантий и компенсаций ...» (действует с 01.01.2022); перечень, на который отсылает п. 6 Методики 812/пр",
  edition: "первоначальная редакция от 16.11.2021 (изменений не выявлено)",
  url: "http://static.government.ru/media/files/iZ4S29b1c3HF8pPlvF1A5DEti3IiCSay.pdf",
  file: "1946-north-perechen.txt",
  notes: [
    "Сохранён НЕ дословный текст, а структурированная выписка приложения с зеркала zakonrf.info (два независимых прогона совпали). Требует сверки по первоисточнику publication.pravo.gov.ru/document/0001202111170030.",
    "Постановление Совмина СССР от 10.11.1967 N 1029 и список 1983 г. N 12 заменены этим перечнем и не используются.",
  ],
};

const UNIT_KINDS = [
  "городские поселения",
  "сельские поселения",
  "городские округа",
  "муниципальные районы",
  "муниципальные округа",
  "города",
];

/** Разбирает перечень записей одного субъекта: «городские округа: А; Б; муниципальные районы: В; Г». */
export function parseNorthEntries(text: string): NorthEntry[] {
  const entries: NorthEntry[] = [];
  let kind = "территория";
  for (const chunk of text.split(";")) {
    let piece = chunk.trim();
    if (piece === "") continue;
    const labelled = /^(городские поселения|сельские поселения|городские округа|муниципальные районы|муниципальные округа|города):\s*(.*)$/u.exec(piece);
    if (labelled !== null) {
      kind = singular(labelled[1] as string);
      piece = (labelled[2] as string).trim();
    } else {
      const single = /^(городской округ|муниципальный район|муниципальный округ|городское поселение|сельское поселение|город)\s+(.*)$/u.exec(piece);
      if (single !== null) {
        kind = single[1] as string;
        piece = (single[2] as string).trim();
      }
    }
    // Хвост-определение: «Таежненское Красноармейского муниципального района» оставляем в названии.
    const noteMatch = /^(.*?)\s*\((за исключением [^)]*)\)\s*$/u.exec(piece);
    const name = (noteMatch === null ? piece : (noteMatch[1] as string)).trim().replace(/^город\s+/u, "");
    entries.push({ kind, name, note: noteMatch === null ? null : (noteMatch[2] as string) });
  }
  return entries;
}

function singular(plural: string): string {
  const map: Record<string, string> = {
    "городские поселения": "городское поселение",
    "сельские поселения": "сельское поселение",
    "городские округа": "городской округ",
    "муниципальные районы": "муниципальный район",
    "муниципальные округа": "муниципальный округ",
    города: "город",
  };
  return map[plural] ?? plural;
}

export function parseNorth(text: string): NorthData {
  const bySubject = new Map<string, { rks: NorthEntry[]; mprks: NorthEntry[]; whole: NorthClass | null; fragments: string[] }>();
  const order: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^(РКС|МПРКС) \| (.*?) \| (.*)$/u.exec(line.trim());
    if (m === null) continue;
    const cls: NorthClass = m[1] === "РКС" ? "RKS" : "MPRKS";
    const subject = (m[2] as string).trim();
    const rest = (m[3] as string).trim();
    let bucket = bySubject.get(subject);
    if (bucket === undefined) {
      bucket = { rks: [], mprks: [], whole: null, fragments: [] };
      bySubject.set(subject, bucket);
      order.push(subject);
    }
    bucket.fragments.push(line.trim());
    if (rest === "WHOLE") bucket.whole = cls;
    else (cls === "RKS" ? bucket.rks : bucket.mprks).push(...parseNorthEntries(rest));
  }
  const subjects: NorthSubject[] = order.map((subject) => {
    const bucket = bySubject.get(subject) as { rks: NorthEntry[]; mprks: NorthEntry[]; whole: NorthClass | null; fragments: string[] };
    return {
      subject,
      whole: bucket.whole,
      rks: bucket.rks,
      mprks: bucket.mprks,
      source: `Постановление Правительства РФ от 16.11.2021 N 1946, приложение (Перечень), ${
        bucket.whole !== null || bucket.rks.length > 0 ? "раздел «Районы Крайнего Севера»" : ""
      }${bucket.rks.length > 0 || bucket.whole !== null ? (bucket.mprks.length > 0 ? " и " : "") : ""}${
        bucket.mprks.length > 0 ? "раздел «Местности, приравненные к районам Крайнего Севера»" : ""
      }`,
      fragment: bucket.fragments.join("\n"),
    };
  });
  return { source: NORTH_SOURCE, subjects };
}

/* ------------------------------------------------------------------ */

export interface BuiltNormatives {
  readonly winter: WinterData;
  readonly temporary: TemporaryData;
  readonly north: NorthData;
  readonly workConditions: ReturnType<typeof buildWorkConditions>;
}

export function buildAll(): BuiltNormatives {
  const winterLines = pageless(readSource("325-pr-zimnee-udorozhanie.txt"));
  const a1 = parseNumericTable(tableLines(winterLines, "Приложение N 1", "Приложение N 2"), 8, winterSection);
  const a2 = parseNumericTable(tableLines(winterLines, "Приложение N 2", "Приложение N 3"), 8, () => null);
  const rows = [...winterRowsOf("A1", a1), ...winterRowsOf("A2", a2)];

  const zoneLines = winterLines.slice(winterLines.indexOf("Приложение N 4"), winterLines.indexOf("Приложение N 5"));
  const zoneStart = zoneLines.findIndex((line) => line.trim() === "1 2 3 4 5 6") + 1;
  const zoneEnd = zoneLines.findIndex((line) => /^Примечание:/u.test(line.trim()));
  const zoneDrafts = parseZoneParts(zoneLines.slice(zoneStart, zoneEnd));
  const zoneParts = finalizeZoneParts(zoneDrafts);

  const winter: WinterData = {
    source: WINTER_SOURCE,
    temperatureZones: parseTemperatureZones(winterLines),
    rows,
    zoneParts,
    rules: winterRules(),
  };

  const tempLines = pageless(readSource("332-pr-vremennye-zdaniya.txt"));
  const t1 = tempLines.indexOf("Приложение N 1");
  const t2 = tempLines.indexOf("Приложение N 2");
  const tempRows = [
    ...parseTemporaryAppendix(tempLines.slice(t1, t2), "A1"),
    ...parseTemporaryAppendix(tempLines.slice(t2), "A2"),
  ];
  const temporary: TemporaryData = { source: TEMPORARY_SOURCE, rows: tempRows, rules: temporaryRules() };

  const north = parseNorth(readSource("1946-north-perechen.txt"));
  return { winter, temporary, north, workConditions: buildWorkConditions() };
}

/* Доработка частей: «остальная территория», списки территорий. Подробности в winterZoneExtras. */
import { finalizeZoneParts, temporaryRules, winterRules } from "./normatives-extras";

/* ------------------------------------------------------------------ */

function main(): void {
  const built = buildAll();
  mkdirSync(APP_COPY_DIR, { recursive: true });
  const write = (name: string, data: unknown): void => {
    const text = `${JSON.stringify(data, null, 2)}\n`;
    writeFileSync(resolve(OUTPUT_DIR, name), text, "utf8");
    writeFileSync(resolve(APP_COPY_DIR, name), text, "utf8");
  };
  write("winter.json", built.winter);
  write("temporary.json", built.temporary);
  write("north.json", built.north);
  write("work-conditions.json", built.workConditions);
  console.log(
    `winter: ${String(built.winter.rows.length)} строк НДЗ, ${String(built.winter.zoneParts.length)} частей субъектов; ` +
      `temporary: ${String(built.temporary.rows.length)} строк; north: ${String(built.north.subjects.length)} субъектов; ` +
      `work-conditions: ${String(built.workConditions.conditions.length)} условий`,
  );
}

if (process.argv[1] !== undefined && /build-normatives\.ts$/u.test(process.argv[1])) main();
