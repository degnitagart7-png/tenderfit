import { inflateRawSync } from "node:zlib";

/**
 * Чтение zip-архива целиком из буфера: оглавление и распаковка записи по имени.
 *
 * Зачем свой разбор. Архивы ФГИС ЦС («ФСНБ-2020 …», 13 МБ) собраны русской программой без флага
 * UTF-8: имена файлов лежат в кодировке cp866, и системный `unzip` на сервере падает на них с
 * «Illegal byte sequence». Нужна только распаковка по имени, а добавлять зависимость ради этого
 * в прод-сборку нет смысла: формат — обычный PKZIP, записи сжаты deflate или хранятся как есть.
 *
 * Размеры берутся из центральной директории, а не из локальных заголовков: при флаге «data
 * descriptor» в заголовках нули. zip64 не поддерживается — файлы открытых данных меньше 4 ГБ.
 */

export interface ZipEntry {
  /** Имя как в архиве, в UTF-8 (cp866 для архивов без флага UTF-8). С путями каталогов. */
  readonly name: string;
  /** Последний компонент имени: «ФЕР.xml». */
  readonly baseName: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

/** Имя записи: флаг «UTF-8» — как есть; иначе допустимый UTF-8 без потерь, иначе cp866 (русский DOS/Windows-архиватор). */
export function decodeZipName(bytes: Uint8Array, flags: number): string {
  if ((flags & 0x0800) !== 0) return new TextDecoder("utf-8").decode(bytes);
  const ascii = bytes.every((byte) => byte < 0x80);
  if (ascii) return new TextDecoder("utf-8").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("ibm866").decode(bytes);
  }
}

/** Оглавление архива: записи в порядке центральной директории. */
export function readZipDirectory(buffer: Buffer): ZipEntry[] {
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
  const entries: ZipEntry[] = [];
  for (let n = 0; n < total; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Повреждена центральная директория zip.");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = decodeZipName(buffer.subarray(offset + 46, offset + 46 + nameLength), flags);
    entries.push({ name, baseName: name.split("/").pop() ?? name, method, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Содержимое записи. Каталоги и пустые записи — пустой буфер. */
export function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  if (entry.size === 0 && entry.compressedSize === 0) return Buffer.alloc(0);
  const header = entry.localOffset;
  if (buffer.readUInt32LE(header) !== 0x04034b50) throw new Error(`Повреждён локальный заголовок записи ${entry.name}.`);
  const start = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
  const packed = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return packed;
  if (entry.method === 8) return inflateRawSync(packed);
  throw new Error(`Способ сжатия ${String(entry.method)} записи ${entry.name} не поддерживается.`);
}

/** Запись по последнему компоненту имени («ФЕР.xml»); нет такой — null. */
export function findZipEntry(entries: readonly ZipEntry[], baseName: string): ZipEntry | null {
  return entries.find((entry) => entry.baseName === baseName) ?? null;
}
