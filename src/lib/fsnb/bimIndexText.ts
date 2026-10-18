import type {
  BimBase,
  BimDesignRecord,
  BimElementRecord,
  BimParseStats,
  BimSmrRecord,
  BimTransportRecord,
} from "@/domain/estimate/bimIndicesTypes";
import { resolveSubject, zoneOfName } from "@/domain/estimate/bimSubjects";

/**
 * Разбор текста письма Минстроя с индексами пересчёта (`pdftotext -layout`) в записи справочника БИМ.
 *
 * Письмо — PDF из ФГИС ЦС: таблицы широкие, колонки — субъекты РФ, а текст после pdftotext держится
 * только положением по горизонтали. Поэтому разбор геометрический:
 *
 * 1. Страницы режутся по строке «Сведения сформированы ФГИС ЦС …» (колонтитул); номер страницы — из
 *    строк «-» и числа в начале, без него — следующий по порядку.
 * 2. Колонки таблицы — это кластеры горизонтальных положений чисел (значение или прочерк «-»). Названия
 *    субъектов — фрагменты шапки (разделены двумя и более пробелами), отнесённые к ближайшей колонке и
 *    склеенные сверху вниз; каноническое имя и зону даёт `resolveSubject`/`zoneOfName`.
 * 3. Значения берутся по колонке сверху вниз, а не по строке: в таблицах «ФЕР/ТЕР» клетка имеет две строки,
 *    а прочерк иногда сползает на строку выше (при округлении координат в PDF) и построчное чтение
 *    ломалось бы. Порядок значений в колонке неизменен: на объект — оплата труда, материалы, эксплуатация
 *    машин, и у каждого элемента две строки (ФЕР, затем ТЕР).
 * 4. Подписи слева (объект строительства) — фрагменты левее первой колонки. Левая подпись — группа
 *    («Многоквартирные жилые дома», «Объекты образования»), правая, сдвинутая на 12+ знаков, — вид внутри
 *    группы («Кирпичные», «Школы»). Группа стоит против середины своих объектов, поэтому вид без группы
 *    относится к ближайшей подписи группы в пределах той же таблицы (она может быть на соседней странице).
 *
 * Модуль чистый. Что страница не сошлась (число значений в колонках разное, колонок не нашлось, субъект
 * неопознан) — в `warnings` с номером страницы: молча пропустить страницу значило бы потерять субъекта.
 */

export interface TextPage {
  readonly page: number;
  readonly lines: readonly string[];
}

export interface ParsedLetter {
  readonly elements: BimElementRecord[];
  readonly smr: BimSmrRecord[];
  readonly transport: BimTransportRecord[];
  readonly design: BimDesignRecord[];
  readonly warnings: string[];
  /** Страницы, пропущенные намеренно (чужие отраслевые базы): для паспорта. */
  readonly skipped: string[];
  readonly stats: BimParseStats;
  readonly quarter: { readonly year: number; readonly quarter: number } | null;
}

interface Frag {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const FOOTER = /Сведения сформированы ФГИС ЦС/;
/** Число в клетке таблицы: «47,58», «1 234,50», прочерк. Целые не считаются: так не путаются номера строк. */
const VALUE = /^(?:\d{1,3}(?: \d{3})*,\d{1,2}|-)$/;
const ELEMENT_LABELS: ReadonlySet<string> = new Set([
  "Оплата труда",
  "Материалы, изделия и",
  "Материалы, изделия",
  "и конструкции",
  "конструкции",
  "Эксплуатация машин и",
  "Эксплуатация машин",
  "Эксплуатация",
  "машин и",
  "и механизмов",
  "механизмов",
]);
const LEFT_HEADER_WORDS: ReadonlySet<string> = new Set(["Объект", "строительства", "Элемент прямых", "затрат"]);
/** Подпись вида внутри группы сдвинута от подписи группы минимум на столько знаков. */
const SUBTYPE_SHIFT = 12;

export function fragments(line: string): Frag[] {
  const result: Frag[] = [];
  for (const match of line.matchAll(/\S+(?: \S+)*/g)) {
    const start = match.index ?? 0;
    result.push({ start, end: start + match[0].length, text: match[0] });
  }
  return result;
}

function valueOf(text: string): number | null {
  return text === "-" ? null : Number.parseFloat(text.replace(/\s/g, "").replace(",", "."));
}

/** Страницы текста: по колонтитулу «Сведения сформированы ФГИС ЦС»; пустые куски пропускаются. */
export function splitPages(text: string): TextPage[] {
  const chunks: string[][] = [[]];
  for (const line of text.split(/\r?\n/)) {
    if (FOOTER.test(line)) chunks.push([]);
    else (chunks[chunks.length - 1] as string[]).push(line);
  }
  const pages: TextPage[] = [];
  let last = 0;
  for (const chunk of chunks) {
    const meaningful = chunk.filter((line) => line.trim() !== "");
    if (meaningful.length === 0) continue;
    // Номер страницы стоит сразу после «-» в начале куска; нет его — страница идёт следом за предыдущей.
    let page = last + 1;
    const dash = meaningful.findIndex((line) => line.trim() === "-");
    if (dash === 0 || dash === 1) {
      const next = meaningful[dash + 1]?.trim() ?? "";
      if (/^\d{1,3}$/.test(next)) page = Number.parseInt(next, 10);
    }
    pages.push({ page, lines: chunk });
    last = page;
  }
  return pages;
}

/* ---------------------------- Названия субъектов ---------------------------- */

/** Название колонки из склеенных фрагментов шапки: без слипшихся повторов и сносок. */
export function cleanColumnName(raw: string): string {
  return raw
    .replace(/(?<=[А-Яа-яЁё])-\s+(?=[А-Яа-яЁё])/g, "-")
    .replace(/([А-Яа-яЁё]{4,})\1/g, "$1 ")
    .replace(/(?<=\))\s*\d+(?:,\d+)*\s*$/, "")
    .replace(/(?<=[А-Яа-яЁё])\d+(?:,\d+)*\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ColumnSubject {
  readonly subject: string | null;
  readonly zone: number | null;
  readonly raw: string;
}

/**
 * Субъекты колонок: имя очищается от сносок и слипшихся повторов и приводится к названию справочника зон.
 * Колонка, чьё имя оборвано («Карелия (2 зона)»), опознаётся по словам: все они обязаны входить в название
 * одного субъекта (`resolveSubject`).
 */
export function subjectsOfColumns(names: readonly string[]): ColumnSubject[] {
  return names.map((name) => {
    const raw = cleanColumnName(name);
    return { subject: resolveSubject(raw), zone: zoneOfName(raw), raw };
  });
}

/* ------------------------------ Объекты строительства ------------------------------ */

/** Название объекта без сносок: «опорах4,5» → «опорах», «ВЛ 2203,4» → «ВЛ 220 кВ», «ВЛ 330 кВ4» → «ВЛ 330 кВ». */
export function cleanObjectName(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  const line = /^ВЛ\s*(\d{3})(?:\s*кВ)?\s*\d?(?:,\d)*$/u.exec(text);
  if (line?.[1] !== undefined) return `ВЛ ${line[1]} кВ`;
  return text
    .replace(/(?<=[А-Яа-яЁё)»])\s*\d(?:,\d)*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface LabelFragment {
  readonly line: number;
  readonly start: number;
  readonly text: string;
}

/** Подпись объекта в блоке: группа (левый уровень) и вид внутри неё (правый). */
export interface BlockLabel {
  readonly group: string | null;
  readonly subtype: string | null;
}

/**
 * Имена объектов по блокам. Блок только с левой подписью — самостоятельный объект и граница групп. Блок
 * с обеими подписями — «якорь» группы: подпись группы стоит против её середины. Блок только с видом
 * принадлежит ближайшему якорю в пределах отрезка между самостоятельными объектами; нет якоря —
 * группа неизвестна (`null`): угадывать её по соседней таблице нельзя.
 */
export function objectNamesOfBlocks(labels: readonly BlockLabel[]): Array<string | null> {
  const names: Array<string | null> = labels.map(() => null);
  let segmentStart = 0;
  const closeSegment = (end: number): void => {
    const anchors: number[] = [];
    for (let index = segmentStart; index < end; index += 1) {
      const label = labels[index] as BlockLabel;
      if (label.group !== null && label.subtype !== null) anchors.push(index);
    }
    for (let index = segmentStart; index < end; index += 1) {
      const label = labels[index] as BlockLabel;
      if (label.subtype === null) continue;
      let group = label.group;
      if (group === null) {
        let best: number | undefined;
        for (const anchor of anchors) {
          if (best === undefined || Math.abs(anchor - index) < Math.abs(best - index)) best = anchor;
        }
        group = best === undefined ? null : ((labels[best] as BlockLabel).group ?? null);
      }
      names[index] = group === null ? null : `${cleanObjectName(group)}: ${cleanObjectName(label.subtype)}`;
    }
  };
  labels.forEach((label, index) => {
    if (label.subtype === null) {
      closeSegment(index);
      names[index] = label.group === null ? null : cleanObjectName(label.group);
      segmentStart = index + 1;
    }
  });
  closeSegment(labels.length);
  return names;
}

/**
 * Подписи одного уровня, идущие почти подряд (не дальше `gap` строк), — одна подпись, перенесённая по строкам.
 * Подписи соседних объектов отстоят дальше. В таблицах по элементам у объекта шесть строк значений, и перенос
 * идёт через строку (`gap` 2); в таблице СМР и ПНР — две, и перенос идёт вплотную (`gap` 1).
 */
export function mergeLabels(labels: readonly LabelFragment[], gap: number): Array<{ text: string; first: number; last: number }> {
  const merged: Array<{ text: string; first: number; last: number }> = [];
  for (const label of [...labels].sort((a, b) => a.line - b.line)) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && label.line - previous.last <= gap) {
      previous.text = `${previous.text} ${label.text}`;
      previous.last = label.line;
    } else {
      merged.push({ text: label.text, first: label.line, last: label.line });
    }
  }
  return merged;
}

/* ------------------------------ Таблицы с колонками-субъектами ------------------------------ */

interface Cell {
  /** Строка страницы; в накопленной таблице — со смещением страницы (`PAGE_STRIDE`). */
  readonly line: number;
  readonly value: number | null;
  readonly page: number;
}

interface ColumnTable {
  readonly names: string[];
  /** Значения по колонкам сверху вниз. */
  readonly columns: Cell[][];
  /** Подписи слева (объекты) вместе со строкой. */
  readonly labels: LabelFragment[];
}

function clusterColumns(tokens: ReadonlyArray<{ center: number }>): number[] {
  const centers = [...new Set(tokens.map((token) => token.center))].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const center of centers) {
    const last = clusters[clusters.length - 1];
    if (last !== undefined && center - (last[last.length - 1] as number) <= 6) last.push(center);
    else clusters.push([center]);
  }
  return clusters.map((cluster) => cluster.reduce((sum, value) => sum + value, 0) / cluster.length);
}

/** Смещение строк страницы внутри таблицы: подписи и значения разных страниц не слипаются. */
const PAGE_STRIDE = 1000;

/**
 * Читает тело таблицы с колонками-субъектами одной страницы: шапка — от строки после `fromLine` до первой
 * строки с числами, тело — до «Примечания». Нет чисел — null.
 */
export function readColumnTable(lines: readonly string[], fromLine: number, page: number): ColumnTable | null {
  let bodyStart = -1;
  for (let index = fromLine; index < lines.length; index += 1) {
    if (fragments(lines[index] as string).some((fragment) => VALUE.test(fragment.text))) {
      bodyStart = index;
      break;
    }
  }
  if (bodyStart < 0) return null;
  let bodyEnd = lines.length;
  for (let index = bodyStart; index < lines.length; index += 1) {
    if (/^\s*Примечани/.test(lines[index] as string)) {
      bodyEnd = index;
      break;
    }
  }

  const tokens: Array<{ line: number; center: number; value: number | null }> = [];
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    for (const fragment of fragments(lines[index] as string)) {
      if (VALUE.test(fragment.text)) tokens.push({ line: index, center: (fragment.start + fragment.end) / 2, value: valueOf(fragment.text) });
    }
  }
  const centers = clusterColumns(tokens);
  if (centers.length === 0) return null;
  const nearest = (center: number): number => {
    let best = 0;
    for (let index = 1; index < centers.length; index += 1) {
      if (Math.abs((centers[index] as number) - center) < Math.abs((centers[best] as number) - center)) best = index;
    }
    return best;
  };

  const columns: Cell[][] = centers.map(() => []);
  for (const token of tokens) {
    (columns[nearest(token.center)] as Cell[]).push({ line: token.line, value: token.value, page });
  }
  const firstColumnStart = Math.min(...tokens.map((token) => token.center)) - 3;

  // Шапка: фрагменты правее подписей слева; к колонке — по ближайшему центру.
  const parts: Array<Array<{ line: number; start: number; text: string }>> = centers.map(() => []);
  for (let index = fromLine; index < bodyStart; index += 1) {
    for (const fragment of fragments(lines[index] as string)) {
      if (fragment.end < firstColumnStart) continue;
      if (VALUE.test(fragment.text) || LEFT_HEADER_WORDS.has(fragment.text)) continue;
      parts[nearest((fragment.start + fragment.end) / 2)]?.push({ line: index, start: fragment.start, text: fragment.text });
    }
  }
  const names = parts.map((list) =>
    list
      .sort((a, b) => a.line - b.line || a.start - b.start)
      .map((part) => part.text)
      .join(" "),
  );

  const labels: LabelFragment[] = [];
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    for (const fragment of fragments(lines[index] as string)) {
      if (fragment.end > firstColumnStart) continue;
      if (VALUE.test(fragment.text) || ELEMENT_LABELS.has(fragment.text)) continue;
      labels.push({ line: index, start: fragment.start, text: fragment.text });
    }
  }
  return { names, columns, labels };
}

/** Одна таблица на нескольких страницах: колонки-субъекты те же, значения и подписи копятся вместе. */
interface Run {
  readonly kind: "ELEMENTS" | "OBJECT_SMR";
  readonly withTer: boolean;
  readonly key: string;
  readonly names: ColumnSubject[];
  readonly columns: Cell[][];
  readonly labels: LabelFragment[];
  pages: number;
  broken: string | null;
}

/**
 * Режет накопленную таблицу на блоки (один блок — один объект) по числу значений в колонке и называет
 * объекты. Подписи относятся к блоку, чей диапазон строк ближе всего. Таблица не сошлась — null и причина.
 */
function blocksOf(run: Run, perBlock: number): { blocks: Array<{ name: string | null; page: number; values: Array<Array<number | null>> }>; error: string | null } {
  const sizes = run.columns.map((column) => column.length);
  const total = sizes[0] ?? 0;
  if (sizes.some((size) => size !== total)) return { blocks: [], error: `в колонках разное число значений (${sizes.join(", ")})` };
  if (total === 0 || total % perBlock !== 0) return { blocks: [], error: `число значений в колонке ${String(total)} не кратно ${String(perBlock)}` };

  const count = total / perBlock;
  const ranges = Array.from({ length: count }, (_, block) => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let page = 0;
    for (const column of run.columns) {
      for (let at = block * perBlock; at < (block + 1) * perBlock; at += 1) {
        const cell = column[at] as Cell;
        lo = Math.min(lo, cell.line);
        hi = Math.max(hi, cell.line);
        if (at === block * perBlock && (page === 0 || cell.page < page)) page = cell.page;
      }
    }
    return { lo, hi, page };
  });

  /** Подпись длиннее этого (в строках) — не перенос одного названия, а несколько слипшихся: ей не верим. */
  const maxSpan = run.kind === "ELEMENTS" ? 8 : 4;
  const untrusted = new Set<number>();
  const assign = (merged: ReturnType<typeof mergeLabels>): string[][] => {
    const perBlockTexts: string[][] = Array.from({ length: count }, () => []);
    for (const label of merged) {
      const center = (label.first + label.last) / 2;
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      ranges.forEach((range, index) => {
        const distance = center < range.lo ? range.lo - center : center > range.hi ? center - range.hi : 0;
        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      });
      (perBlockTexts[best] as string[]).push(label.text);
      if (label.last - label.first > maxSpan) {
        ranges.forEach((range, index) => {
          if (range.hi >= label.first && range.lo <= label.last) untrusted.add(index);
        });
      }
    }
    return perBlockTexts;
  };
  // Левый уровень отсчитывается от самой левой подписи таблицы: у алмазодобычи подписи стоят правее обычного.
  const base = run.labels.length === 0 ? 0 : Math.min(...run.labels.map((label) => label.start));
  const gap = run.kind === "ELEMENTS" ? 2 : 1;
  const lows = assign(mergeLabels(run.labels.filter((label) => label.start - base < SUBTYPE_SHIFT), gap));
  const highs = assign(mergeLabels(run.labels.filter((label) => label.start - base >= SUBTYPE_SHIFT), gap));
  const resolved = objectNamesOfBlocks(
    ranges.map((_, index) => ({
      group: (lows[index] as string[]).length === 0 ? null : (lows[index] as string[]).join(" "),
      subtype: (highs[index] as string[]).length === 0 ? null : (highs[index] as string[]).join(" "),
    })),
  );
  const names = resolved.map((name, index) => (untrusted.has(index) ? null : name));
  return {
    blocks: ranges.map((range, index) => ({
      name: names[index] ?? null,
      page: range.page,
      values: run.columns.map((column) => column.slice(index * perBlock, (index + 1) * perBlock).map((cell) => cell.value)),
    })),
    error: null,
  };
}

/* ------------------------------ Разбор писем ------------------------------ */

const CAPTION = /Индексы к (ФЕР-2001\/ТЕР-2001|ФЕР-2001|ОСНБЖ-2001)/;

type PageKind = "ELEMENTS" | "OBJECT_SMR" | "SUBJECT_ROWS" | "TRANSPORT" | "OSNBZH" | "OTHER";

function classify(lines: readonly string[]): { kind: PageKind; captionLine: number; withTer: boolean } {
  const text = lines.join("\n");
  const captionLine = lines.findIndex((line) => CAPTION.test(line));
  const caption = captionLine < 0 ? null : CAPTION.exec(lines[captionLine] as string);
  if (caption?.[1] === "ОСНБЖ-2001") return { kind: "OSNBZH", captionLine, withTer: false };
  const withTer = caption?.[1] === "ФЕР-2001/ТЕР-2001";
  const bySubject = /п\/(?:п|\s)/.test(text) && /Субъект/.test(text);
  if (captionLine >= 0 && /Элемент прямых/.test(text)) return { kind: "ELEMENTS", captionLine, withTer };
  if (captionLine >= 0 && /Объект/.test(text) && !bySubject) return { kind: "OBJECT_SMR", captionLine, withTer };
  if (captionLine >= 0 && bySubject) return { kind: "SUBJECT_ROWS", captionLine, withTer };
  if (bySubject && /автомобил|автобетоно/.test(text) && /Индексы по типам/.test(text)) {
    return { kind: "TRANSPORT", captionLine: lines.findIndex((line) => /Индексы по типам/.test(line)), withTer: false };
  }
  return { kind: "OTHER", captionLine, withTer };
}

interface ParseContext {
  readonly letter: string;
  readonly out: ParsedLetter;
}

/**
 * Таблицы «Индексы к ФЕР-2001» с одной строкой на элемент — отдельные приложения писем (линейные объекты
 * ПАО «Россети», атомная энергетика, алмазодобыча): названия их объектов («ВЛ 110 кВ на металлических опорах»)
 * совпадают с названиями из общего приложения, а индексы другие. Объект получает префикс приложения; приложение
 * опознаётся по объектам, а не по заголовку: в письме Москвы страница с заголовком не извлеклась.
 */
export function categoryOfFerOnlyTable(names: ReadonlyArray<string | null>): string | null {
  const known = names.filter((name): name is string => name !== null);
  if (known.some((name) => /^ВЛ\s/u.test(name))) return "ВЛ ПАО «Россети»";
  if (known.some((name) => /Градирня|Здание реактора|радиоактивных|радиационного/u.test(name))) return "Объекты использования атомной энергии";
  if (known.some((name) => /алмазодобывающей/u.test(name))) return null;
  return null;
}

function flushRun(run: Run | null, ctx: ParseContext): void {
  if (run === null) return;
  const where = `стр. ${String(run.columns[0]?.[0]?.page ?? "?")}…`;
  if (run.broken !== null) {
    ctx.out.warnings.push(`${where} таблица пропущена: ${run.broken}`);
    return;
  }
  const elementCount = run.kind === "ELEMENTS" ? 3 : 1;
  const bases: BimBase[] = run.withTer ? ["FER", "TER"] : ["FER"];
  const parsed = blocksOf(run, elementCount * bases.length);
  if (parsed.error !== null) {
    ctx.out.warnings.push(`${where} таблица пропущена: ${parsed.error}`);
    return;
  }
  const step = bases.length;
  const category = run.kind === "ELEMENTS" && !run.withTer ? categoryOfFerOnlyTable(parsed.blocks.map((block) => block.name)) : null;
  parsed.blocks.forEach((block) => {
    if (block.name === null) {
      ctx.out.warnings.push(`стр. ${String(block.page)}: у объекта не определена группа (подпись группы осталась за пределами письма) — объект пропущен`);
      return;
    }
    run.names.forEach((column, columnIndex) => {
      if (column.subject === null) return;
      const cells = block.values[columnIndex] as Array<number | null>;
      bases.forEach((base, baseIndex) => {
        if (run.kind === "ELEMENTS") {
          const labour = cells[baseIndex] ?? null;
          const materials = cells[step + baseIndex] ?? null;
          const machines = cells[2 * step + baseIndex] ?? null;
          if (labour === null && materials === null && machines === null) return;
          ctx.out.elements.push({
            subject: column.subject as string,
            zone: column.zone,
            object: category === null ? (block.name as string) : `${category}: ${block.name as string}`,
            base,
            labour,
            materials,
            machines,
            letter: ctx.letter,
            page: block.page,
          });
        } else {
          const value = cells[baseIndex] ?? null;
          if (value === null) return;
          ctx.out.smr.push({
            subject: column.subject as string,
            zone: column.zone,
            object: block.name as string,
            base,
            kind: "SMR_PNR",
            value,
            letter: ctx.letter,
            page: block.page,
          });
        }
      });
    });
  });
}

function addColumnPage(page: TextPage, info: ReturnType<typeof classify>, ctx: ParseContext, run: Run | null): Run | null {
  const kind = info.kind as "ELEMENTS" | "OBJECT_SMR";
  const table = readColumnTable(page.lines, info.captionLine + 1, page.page);
  if (table === null) {
    ctx.out.warnings.push(`стр. ${String(page.page)}: в таблице нет чисел`);
    if (run !== null) run.broken = `страница ${String(page.page)} не разобрана`;
    return run;
  }
  const names = subjectsOfColumns(table.names);
  const key = `${kind}|${String(info.withTer)}|${names.map((entry) => entry.raw).join("|")}`;
  let current = run;
  if (current === null || current.key !== key) {
    flushRun(current, ctx);
    const unknown = names.filter((entry) => entry.subject === null);
    if (unknown.length > 0) {
      ctx.out.warnings.push(`стр. ${String(page.page)}: не опознан субъект в колонке «${unknown.map((entry) => entry.raw).join("», «")}»`);
    }
    current = {
      kind,
      withTer: info.withTer,
      key,
      names,
      columns: table.columns.map(() => []),
      labels: [],
      pages: 0,
      broken: null,
    };
  }
  if (table.columns.length !== current.columns.length) {
    current.broken = `на странице ${String(page.page)} другое число колонок`;
    return current;
  }
  // Строки страниц таблицы разнесены, чтобы подписи и значения соседних страниц не слипались.
  const offset = current.pages * PAGE_STRIDE;
  table.columns.forEach((column, index) =>
    (current as Run).columns[index]?.push(...column.map((cell) => ({ ...cell, line: cell.line + offset }))),
  );
  current.labels.push(...table.labels.map((label) => ({ ...label, line: label.line + offset })));
  current.pages += 1;
  return current;
}

/* ------------------------------ Таблицы «по субъектам» ------------------------------ */

const ROMAN_LINE = /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/;

/** Название типа автотранспорта из текста шапки. */
function vehicleOf(text: string): string {
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  if (lower.includes("трубоплет")) return "автомобили-трубоплетевозы";
  if (lower.includes("самосвал")) return "автомобили-самосвалы";
  if (lower.includes("панелевоз")) return "автомобили-панелевозы";
  if (lower.includes("бетоносмес")) return "автобетоносмесители";
  if (lower.includes("бортов")) return "автомобили бортовые";
  return text.replace(/\s+/g, " ").trim();
}

interface SubjectRow {
  readonly line: number;
  readonly subject: string;
  /** Значения: в одной строке с названием или в строках над ним и под ним (ФЕР и ТЕР). */
  readonly rows: Array<Array<{ center: number; value: number | null }>>;
}

/** Строки «№ | субъект | значения» (ж/д, перевозка) и «значения / № субъект / значения» (автомобильные дороги). */
function readSubjectRows(lines: readonly string[], fromLine: number): { rows: SubjectRow[]; header: string[]; centers: number[] } {
  const rows: SubjectRow[] = [];
  const valueOnly = (line: string): Array<{ center: number; value: number | null }> | null => {
    const list = fragments(line);
    if (list.length === 0 || !list.every((fragment) => VALUE.test(fragment.text))) return null;
    return list.map((fragment) => ({ center: (fragment.start + fragment.end) / 2, value: valueOf(fragment.text) }));
  };

  let numbering = -1;
  for (let index = fromLine; index < lines.length; index += 1) {
    const list = fragments(lines[index] as string);
    if (list.length >= 3 && list.every((fragment, position) => fragment.text === String(position + 1))) {
      numbering = index;
      break;
    }
  }
  if (numbering < 0) return { rows, header: [], centers: [] };

  let end = lines.length;
  for (let index = numbering + 1; index < lines.length; index += 1) {
    if (/^\s*Примечани/.test(lines[index] as string)) {
      end = index;
      break;
    }
  }

  const allTokens: Array<{ center: number }> = [];
  const subjectLines: Array<{ index: number; subject: string; inline: Array<{ center: number; value: number | null }> }> = [];
  for (let index = numbering + 1; index < end; index += 1) {
    const list = fragments(lines[index] as string);
    if (list.length === 0) continue;
    const only = valueOnly(lines[index] as string);
    if (only !== null) {
      allTokens.push(...only);
      continue;
    }
    const first = list[0] as Frag;
    if (ROMAN_LINE.test(first.text)) continue;
    if (/^\d{1,3}$/.test(first.text) && list.length >= 2) {
      const inline = list.slice(2).filter((fragment) => VALUE.test(fragment.text));
      const name = (list[1] as Frag).text;
      subjectLines.push({
        index,
        subject: name,
        inline: inline.map((fragment) => ({ center: (fragment.start + fragment.end) / 2, value: valueOf(fragment.text) })),
      });
      allTokens.push(...inline.map((fragment) => ({ center: (fragment.start + fragment.end) / 2 })));
    }
  }

  const centers = clusterColumns(allTokens);
  for (const entry of subjectLines) {
    if (entry.inline.length > 0) {
      rows.push({ line: entry.index, subject: entry.subject, rows: [entry.inline] });
      continue;
    }
    // Название без значений: ФЕР — строка значений прямо над ним, ТЕР — прямо под ним.
    const above = (() => {
      for (let index = entry.index - 1; index > numbering; index -= 1) {
        if ((lines[index] as string).trim() === "") continue;
        return valueOnly(lines[index] as string);
      }
      return null;
    })();
    const below = (() => {
      for (let index = entry.index + 1; index < end; index += 1) {
        if ((lines[index] as string).trim() === "") continue;
        return valueOnly(lines[index] as string);
      }
      return null;
    })();
    const collected = [above, below].filter((row): row is Array<{ center: number; value: number | null }> => row !== null);
    if (collected.length > 0) rows.push({ line: entry.index, subject: entry.subject, rows: collected });
  }

  const header: string[] = centers.map(() => "");
  const nearest = (center: number): number => {
    let best = 0;
    for (let index = 1; index < centers.length; index += 1) {
      if (Math.abs((centers[index] as number) - center) < Math.abs((centers[best] as number) - center)) best = index;
    }
    return best;
  };
  if (centers.length > 0) {
    const firstCenter = Math.min(...centers);
    for (let index = fromLine; index < numbering; index += 1) {
      for (const fragment of fragments(lines[index] as string)) {
        if ((fragment.start + fragment.end) / 2 < firstCenter - 8) continue;
        const column = nearest((fragment.start + fragment.end) / 2);
        header[column] = `${header[column] as string} ${fragment.text}`.trim();
      }
    }
  }
  return { rows, header, centers };
}

function parseSubjectRowsPage(page: TextPage, info: ReturnType<typeof classify>, ctx: ParseContext): void {
  const parsed = readSubjectRows(page.lines, Math.max(0, info.captionLine + 1));
  if (parsed.rows.length === 0) {
    ctx.out.warnings.push(`стр. ${String(page.page)}: в таблице «по субъектам» нет строк`);
    return;
  }
  const nearest = (center: number): number => {
    let best = 0;
    for (let index = 1; index < parsed.centers.length; index += 1) {
      if (Math.abs((parsed.centers[index] as number) - center) < Math.abs((parsed.centers[best] as number) - center)) best = index;
    }
    return best;
  };
  const bases: BimBase[] = info.withTer ? ["FER", "TER"] : ["FER"];

  for (const row of parsed.rows) {
    const raw = cleanColumnName(row.subject);
    const subject = resolveSubject(raw);
    if (subject === null) {
      ctx.out.warnings.push(`стр. ${String(page.page)}: не опознан субъект «${raw}»`);
      continue;
    }
    const zone = zoneOfName(raw);
    row.rows.forEach((cells, rowIndex) => {
      const base = bases[rowIndex];
      if (base === undefined) return;
      for (const cell of cells) {
        if (cell.value === null) continue;
        const column = nearest(cell.center);
        const title = (parsed.header[column] ?? "").replace(/\s+/g, " ").trim();
        if (info.kind === "TRANSPORT") {
          ctx.out.transport.push({ subject, zone, vehicle: vehicleOf(title), value: cell.value, letter: ctx.letter, page: page.page });
        } else {
          const object = cleanObjectName(title).replace(/\s*\d(?:,\d)*$/, "");
          ctx.out.smr.push({ subject, zone, object, base, kind: "SMR", value: cell.value, letter: ctx.letter, page: page.page });
        }
      }
    });
  }
}

/* ------------------------------ Проектные и изыскательские работы ------------------------------ */

/** Индексы ПИР из текста приложения «проектных и изыскательских работ»: «к уровню цен на 01.01.2001 – 7,22». */
function parseDesign(page: TextPage, ctx: ParseContext): void {
  const text = page.lines.join("\n");
  if (!/проектных\s+и\s+изыскательских\s+работ/i.test(text)) return;
  const lines = page.lines.map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line !== "");
  const VALUE_END = /[–‒-]\s*(\d+(?:,\d+)?)\s*[;.]?\s*$/;
  let kind: "DESIGN" | "SURVEY" | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (/^1\.\s/.test(line) && /проектных\s+работ/i.test(line)) kind = "DESIGN";
    else if (/^2\.\s/.test(line) && /изыскательских\s+работ/i.test(line)) kind = "SURVEY";
    if (kind === null || !/^к\s+уровню\s+цен/i.test(line)) continue;
    // Строка уровня может переноситься: «к уровню цен, учтенному в сборнике … Госстроя СССР … – 99,17;»
    let chunk = line;
    let next = index + 1;
    while (!VALUE_END.test(chunk) && next < lines.length && next < index + 4) {
      chunk += ` ${lines[next] as string}`;
      next += 1;
    }
    const value = VALUE_END.exec(chunk);
    if (value?.[1] === undefined) continue;
    const date = /по\s+состоянию\s+на\s+(\d{2})\.(\d{2})\.(\d{4})/i.exec(chunk);
    const level =
      date?.[1] !== undefined && date[2] !== undefined && date[3] !== undefined
        ? `${date[3]}-${date[2]}-${date[1]}`
        : chunk
            .replace(VALUE_END, "")
            .replace(/^к\s+уровню\s+цен,?\s*/i, "")
            .trim()
            .slice(0, 240);
    ctx.out.design.push({ kind, level, value: Number.parseFloat(value[1].replace(",", ".")), letter: ctx.letter, page: page.page });
    index = next - 1;
  }
}

/* ------------------------------ Точка входа ------------------------------ */

/** Квартал письма из заголовка: «на III квартал 2026 года». */
export function quarterOfLetter(text: string): { year: number; quarter: number } | null {
  const roman: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 };
  const match = /(?:на|за)?\s*(IV|III|II|I|[1-4])\s*квартал\s*(20\d{2})/u.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { quarter: roman[match[1]] ?? Number.parseInt(match[1], 10), year: Number.parseInt(match[2], 10) };
}

/** Разбор одного письма. `letterId` попадает в каждую запись, чтобы значение можно было найти в письме. */
export function parseBimIndexLetter(text: string, letterId: string): ParsedLetter {
  const out: ParsedLetter = {
    elements: [],
    smr: [],
    transport: [],
    design: [],
    warnings: [],
    skipped: [],
    stats: { pages: 0, elementPages: 0, elements: 0, smr: 0, transport: 0, design: 0 },
    quarter: quarterOfLetter(text),
  };
  const ctx: ParseContext = { letter: letterId, out };
  const pages = splitPages(text);
  let elementPages = 0;

  const osnbzhPages: number[] = [];
  let run: Run | null = null;
  for (const page of pages) {
    const info = classify(page.lines);
    if (info.kind === "ELEMENTS" || info.kind === "OBJECT_SMR") {
      elementPages += info.kind === "ELEMENTS" ? 1 : 0;
      run = addColumnPage(page, info, ctx, run);
      continue;
    }
    flushRun(run, ctx);
    run = null;
    if (info.kind === "SUBJECT_ROWS" || info.kind === "TRANSPORT") parseSubjectRowsPage(page, info, ctx);
    else if (info.kind === "OSNBZH") osnbzhPages.push(page.page);
    else parseDesign(page, ctx);
  }
  flushRun(run, ctx);
  if (osnbzhPages.length > 0) {
    out.skipped.push(
      `стр. ${String(osnbzhPages[0])}–${String(osnbzhPages[osnbzhPages.length - 1])}: индексы к ОСНБЖ-2001 (отраслевая база железных дорог) — не БИМ по ФЕР/ТЕР, не собраны`,
    );
  }

  return {
    ...out,
    stats: {
      pages: pages.length,
      elementPages,
      elements: out.elements.length,
      smr: out.smr.length,
      transport: out.transport.length,
      design: out.design.length,
    },
  };
}
