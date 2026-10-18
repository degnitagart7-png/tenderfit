import { deflateRawSync } from "node:zlib";

/**
 * Сборка zip-архива в памяти для тестов: имена в кодировке cp866 (как в архивах ФГИС ЦС) или UTF-8,
 * записи сжаты deflate или хранятся как есть. Этого хватает, чтобы проверить чтение настоящих
 * архивов, не кладя в репозиторий 13 МБ.
 */

/** Строка в cp866: русские буквы А–п → 0x80–0xAF, р–я → 0xE0–0xEF, ё/Ё; ASCII как есть. */
export function toCp866(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (code < 0x80) bytes.push(code);
    else if (code >= 0x410 && code <= 0x43f) bytes.push(0x80 + (code - 0x410));
    else if (code >= 0x440 && code <= 0x44f) bytes.push(0xe0 + (code - 0x440));
    else if (code === 0x401) bytes.push(0xf0);
    else if (code === 0x451) bytes.push(0xf1);
    else bytes.push(63);
  }
  return Buffer.from(bytes);
}

/** Строка в windows-1251: А–я → 0xC0–0xFF, ё/Ё; ASCII как есть. */
export function toCp1251(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (code < 0x80) bytes.push(code);
    else if (code >= 0x410 && code <= 0x44f) bytes.push(0xc0 + (code - 0x410));
    else if (code === 0x401) bytes.push(0xa8);
    else if (code === 0x451) bytes.push(0xb8);
    else bytes.push(63);
  }
  return Buffer.from(bytes);
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (`zlib.crc32` появился только в Node 22). */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipFixtureEntry {
  readonly name: string;
  readonly content: Buffer | string;
  /** Как закодировать имя; по умолчанию cp866. */
  readonly nameEncoding?: "cp866" | "utf8";
  /** Хранить без сжатия. */
  readonly stored?: boolean;
}

export function makeZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const utf8 = (entry.nameEncoding ?? "cp866") === "utf8";
    const name = utf8 ? Buffer.from(entry.name, "utf8") : toCp866(entry.name);
    const content = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
    const method = entry.stored === true || content.length === 0 ? 0 : 8;
    const packed = method === 0 ? content : deflateRawSync(content);
    const crc = crc32(content) >>> 0;
    const flags = utf8 ? 0x0800 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += 30 + name.length + packed.length;
  }

  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}
