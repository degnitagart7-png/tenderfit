import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { inflateRawSync } from "node:zlib";

/**
 * Потоковое чтение первого листа xlsx: строки отдаются по одной.
 *
 * Зачем свой разбор. Сплит-форма ФГИС ЦС — лист на 281 тысячу строк: в zip он
 * занимает 13,7 МБ, а в виде XML — 110 МБ листа и 93 МБ общих строк. Библиотека
 * `xlsx` собирает из них объект каждой ячейки, и пик памяти при чтении доходит до
 * 1,0–1,3 ГБ — на сервере в 4 ГБ, где живут приложение и воркер, это много. Здесь
 * читаются только первые колонки, строки разбираются из XML окнами по 1 МБ и не
 * накапливаются: в памяти остаются распакованные части zip и таблица общих строк.
 *
 * Формат — обычный SpreadsheetML (ECMA-376), без макросов и формул: значение
 * ячейки берётся из `<v>`, строки — из таблицы общих строк или `<is>`. Поведение
 * совпадает с `sheet_to_json({ header: 1, blankrows: false, defval: "" })`:
 * пустая ячейка — пустая строка, полностью пустые строки пропускаются, ошибки
 * формул (`t="e"`) значением не считаются.
 *
 * Читать zip приходится вручную: средняя директория читается из конца файла, а
 * записи распаковываются `inflateRawSync`. Размеры берутся из директории, а не из
 * локальных заголовков, потому что при флаге «data descriptor» в заголовках нули.
 */

interface ZipEntry {
  readonly method: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

function readZipDirectory(buffer: Buffer): Map<string, ZipEntry> {
  // Запись конца директории — последние 22+ байта; комментарий может её сдвинуть.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Файл не похож на zip: не найдена запись конца центральной директории.");

  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < total; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Повреждена центральная директория zip.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entries: Map<string, ZipEntry>, name: string): Buffer | null {
  const entry = entries.get(name);
  if (entry === undefined) return null;
  const header = entry.localOffset;
  if (buffer.readUInt32LE(header) !== 0x04034b50) throw new Error(`Повреждён локальный заголовок записи ${name}.`);
  const start = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
  const packed = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return packed;
  if (entry.method === 8) return inflateRawSync(packed);
  throw new Error(`Способ сжатия ${String(entry.method)} записи ${name} не поддерживается.`);
}

/** Окнами по 1 МБ декодирует буфер и отдаёт строки, не создавая одну на весь файл. */
function* decodeWindows(buffer: Buffer): Generator<string> {
  const decoder = new StringDecoder("utf8");
  const window = 1 << 20;
  for (let at = 0; at < buffer.length; at += window) {
    yield decoder.write(buffer.subarray(at, Math.min(buffer.length, at + window)));
  }
  const tail = decoder.end();
  if (tail.length > 0) yield tail;
}

/** Целые XML-единицы `<tag …>…</tag>` из потока окон; хвост неполной единицы переносится. */
function* xmlUnits(buffer: Buffer, tag: string): Generator<string> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let carry = "";
  for (const piece of decodeWindows(buffer)) {
    let text = carry + piece;
    carry = "";
    for (;;) {
      const start = text.indexOf(open);
      if (start < 0) {
        // Начало тега могло оборваться на границе окна.
        carry = text.slice(Math.max(0, text.length - open.length));
        break;
      }
      const end = text.indexOf(close, start);
      if (end < 0) {
        carry = text.slice(start);
        break;
      }
      yield text.slice(start, end + close.length);
      text = text.slice(end + close.length);
    }
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(value: string): string {
  if (!value.includes("&") && !value.includes("_x")) return value;
  return value
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, body: string) => {
      if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      return ENTITIES[body] ?? "";
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Текст всех `<t>` внутри `<si>` или `<is>`: богатый текст состоит из нескольких кусков. */
function textOf(unit: string): string {
  let result = "";
  const pattern = /<t(?:\s[^>]*)?>([^<]*)<\/t>|<t\s*\/>/g;
  for (let match = pattern.exec(unit); match !== null; match = pattern.exec(unit)) {
    result += match[1] ?? "";
  }
  return unescapeXml(result);
}

function readSharedStrings(buffer: Buffer | null): string[] {
  const strings: string[] = [];
  if (buffer === null) return strings;
  for (const unit of xmlUnits(buffer, "si")) strings.push(textOf(unit));
  return strings;
}

/** Имя файла первого листа: через workbook.xml и его связи, а не по номеру. */
function firstSheetPath(buffer: Buffer, entries: Map<string, ZipEntry>): string {
  const workbook = readZipEntry(buffer, entries, "xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = readZipEntry(buffer, entries, "xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const sheetTag = /<sheet\b[^>]*>/.exec(workbook)?.[0] ?? "";
  const relId = /r:id="([^"]+)"/.exec(sheetTag)?.[1];
  if (relId !== undefined) {
    for (const rel of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
      if (new RegExp(`Id="${relId}"`).test(rel)) {
        const target = /Target="([^"]+)"/.exec(rel)?.[1];
        if (target !== undefined) return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
      }
    }
  }
  return "xl/worksheets/sheet1.xml";
}

function columnIndex(reference: string): number {
  let index = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

const CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

/**
 * Строки первого листа xlsx: до `maxColumns` колонок, без пустых строк.
 * Значения — числа и строки, как их отдаёт `sheet_to_json` в режиме `raw`.
 */
export function* streamSheetRows(path: string, maxColumns: number): Generator<unknown[]> {
  const buffer = readFileSync(path);
  const entries = readZipDirectory(buffer);
  const sheet = readZipEntry(buffer, entries, firstSheetPath(buffer, entries));
  if (sheet === null) throw new Error(`В ${path} не найден первый лист.`);
  const strings = readSharedStrings(readZipEntry(buffer, entries, "xl/sharedStrings.xml"));

  for (const unit of xmlUnits(sheet, "row")) {
    const row: unknown[] = new Array<unknown>(maxColumns).fill("");
    let blank = true;
    let sequential = 0;
    CELL.lastIndex = 0;
    for (let match = CELL.exec(unit); match !== null; match = CELL.exec(unit)) {
      const attributes = match[1] ?? "";
      const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const column = reference === undefined ? sequential : columnIndex(reference);
      sequential = column + 1;
      if (column < 0 || column >= maxColumns) continue;

      const body = match[2];
      if (body === undefined) continue;
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? "n";
      let value: unknown;
      if (type === "inlineStr") {
        value = textOf(body);
      } else {
        const raw = /<v(?:\s[^>]*)?>([^<]*)<\/v>/.exec(body)?.[1];
        if (raw === undefined) continue;
        if (type === "s") value = strings[Number.parseInt(raw, 10)];
        else if (type === "str") value = unescapeXml(raw);
        else if (type === "b") value = raw === "1";
        else if (type === "e") continue;
        else {
          const number = Number.parseFloat(raw);
          value = Number.isFinite(number) ? number : undefined;
        }
      }
      if (value === undefined || value === "") continue;
      row[column] = value;
      blank = false;
    }
    if (!blank) yield row;
  }
}
