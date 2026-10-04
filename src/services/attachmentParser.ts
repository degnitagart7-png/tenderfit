/**
 * Разбор двоичных документов в текст. Серверная часть.
 *
 * Модуль читают только серверный код и локальные скрипты: `jszip`, `xlsx` и
 * `word-extractor` тянут за собой Node-API, и в клиентскую сборку им нельзя.
 * Клиентский разбор загружаемых файлов живёт отдельно, в documentParser.ts.
 * Определение формата по расширению вынесено в fileFormats.ts — оно нужно и
 * клиенту, и обходу вложений, который не скачивает файл неподдерживаемого
 * формата вообще.
 */

import type JSZip from "jszip";
import {
  detectFileType,
  sniffFileType,
  unsupportedContentReason,
  unsupportedFormatReason,
} from "@/services/fileFormats";
import type { AttachmentKind } from "@/services/fileFormats";
import {
  ArchiveRefusedError,
  type ArchiveEntry,
} from "@/services/archiveReaders";

/** Определитель формата переехал в fileFormats.ts; прежний адрес импорта сохранён. */
export {
  detectFileType,
  fileExtension,
  sniffFileType,
  unsupportedFormatReason,
} from "@/services/fileFormats";
export type { AttachmentKind, SniffedKind } from "@/services/fileFormats";

export interface ParsedAttachment {
  /** Готовый текст. Пустая строка, если разбор не удался. */
  text: string;
  status: "parsed" | "unsupported" | "empty" | "failed";
  /** Почему текста нет: показывается партнёру в карточке закупки. */
  reason: string | null;
  /** Текст обрезан по бюджету знаков — целиком файл в лимит не влез. */
  truncated: boolean;
  /** Для архива: сколько входов разобрано из скольких. */
  archive?: { parsed: number; total: number };
}

/** Меньше этого объёма текст считается отсутствующим: скан без слоя или битый файл. */
export const MIN_PARSED_CHARS = 40;

/** Сколько входов архива вообще имеет смысл обходить. */
export const MAX_ARCHIVE_ENTRIES = 200;

/**
 * Предохранитель от архива, который распаковывается в гигабайты.
 * Файлы приходят с государственного сервера и проверены антивирусом ЕИС,
 * но читать 200 МБ в память процесса всё равно не нужно.
 */
const MAX_ARCHIVE_UNCOMPRESSED = 200_000_000;

/**
 * Сколько уровней вложенности архивов раскрывается.
 *
 * Три, а не два. Проектную документацию в ЕИС пакуют слоями: архив вкладки
 * документов, внутри архив раздела, внутри него — том с чертежами и
 * пояснительной запиской. Пока проект читал только zip, третий уровень
 * встречался редко и предел в два уровня почти не мешал; с поддержкой rar и 7z
 * он стал обычным делом, а документ, до которого обход не дошёл, выглядит для
 * партнёра так же, как документ, которого нет.
 *
 * Четвёртый уровень намеренно не раскрывается: дальше это уже не упаковка
 * документации, а вложенность ради вложенности, и обход рискует потратить
 * бюджет знаков на служебные файлы вместо проекта контракта. Настоящая защита
 * от разрастания — не глубина, а лимиты: 200 входов и 200 МБ распакованного
 * считаются сквозь все уровни сразу.
 */
const MAX_ARCHIVE_DEPTH = 3;

function parsed(text: string, budgetChars: number): ParsedAttachment {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length < MIN_PARSED_CHARS) {
    return {
      text: "",
      status: "empty",
      reason: "Текстового слоя нет: файл отсканирован или пуст.",
      truncated: false,
    };
  }
  if (clean.length > budgetChars) {
    return {
      text: clean.slice(0, budgetChars),
      status: "parsed",
      reason: null,
      truncated: true,
    };
  }
  return { text: clean, status: "parsed", reason: null, truncated: false };
}

/** Причина пропуска берётся из fileFormats: её же печатает обход вложений до скачивания. */
function unsupported(reason: string): ParsedAttachment {
  return { text: "", status: "unsupported", reason, truncated: false };
}

function failed(message: string): ParsedAttachment {
  return { text: "", status: "failed", reason: message, truncated: false };
}

/**
 * Текст PDF.
 *
 * Здесь всегда legacy-сборка pdfjs: обычная вызывает `Uint8Array.prototype.toHex`,
 * которого нет в Node вплоть до 25-й версии, и падает с `hashOriginal.toHex is not
 * a function` на первом же документе с нестандартным шрифтом. Модуль серверный,
 * поэтому выбора между сборками нет; браузерный разбор живёт в documentParser.ts.
 *
 * `verbosity: 0` — это VerbosityLevel.errors. Без него один архив проектной
 * документации печатает сотню строк «standardFontDataUrl» и «TT: undefined
 * function»: стандартные шрифты pdfjs подгружает для отрисовки, а текст
 * извлекается и без них — на живой закупке 32616393585 извлечение дало 821 973
 * знака без единого символа замены. Журнал плановой синхронизации — единственное
 * окно оператора в ночной прогон, топить его в предупреждениях нельзя.
 */
async function readPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document_ = await pdfjs.getDocument({ data: bytes, verbosity: 0 })
    .promise;

  let text = "";
  for (let page = 1; page <= document_.numPages; page += 1) {
    const content = await (await document_.getPage(page)).getTextContent();
    text +=
      content.items
        .map((item) => ("str" in item ? (item.str ?? "") : ""))
        .join(" ") + "\n\n";
  }
  return text;
}

async function readDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return result.value;
}

async function readDoc(bytes: Uint8Array): Promise<string> {
  const WordExtractor = (await import("word-extractor")).default;
  const document_ = await new WordExtractor().extract(Buffer.from(bytes));
  return document_.getBody();
}

async function readSpreadsheet(bytes: Uint8Array): Promise<string> {
  const XLSX = await import("xlsx");
  const book = XLSX.read(Buffer.from(bytes), { type: "buffer" });
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name];
    const csv = sheet ? XLSX.utils.sheet_to_csv(sheet) : "";
    return `=== ${name} ===\n${csv}`;
  }).join("\n\n");
}

/**
 * Разбор архива: входы обходятся по алфавиту, пока не кончится бюджет знаков.
 * Порядок важен — из архива проекта контракта иначе нельзя понять, что именно
 * в текст попало, а что нет.
 *
 * Распакованный контейнер приходит аргументом: его уже открыли, чтобы отличить
 * архив от docx и xlsx, и открывать второй раз значит читать файл заново.
 */
/**
 * Обход входов архива, общий для zip, rar и 7z.
 *
 * Источник входов передаётся списком, а не распаковщиком: все три формата
 * различаются только тем, как достать имена и байты, а лимиты, бюджет знаков,
 * рекурсия и отчёт «разобрано N из M» у них обязаны быть одни. Два набора
 * лимитов на два формата разошлись бы через месяц, и партнёр увидел бы, что
 * одна и та же документация читается по-разному в зависимости от упаковки.
 */
async function readArchive(
  entries: readonly ArchiveEntry[],
  budgetChars: number,
  depth: number,
): Promise<ParsedAttachment> {
  const sorted = [...entries].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const names = sorted.map((entry) => entry.name);

  const parts: string[] = [];
  let used = 0;
  let uncompressed = 0;
  let parsedCount = 0;

  for (const entry of sorted.slice(0, MAX_ARCHIVE_ENTRIES)) {
    const name = entry.name;
    if (used >= budgetChars) break;

    const entryBytes = await entry.bytes();
    uncompressed += entryBytes.byteLength;
    if (uncompressed > MAX_ARCHIVE_UNCOMPRESSED) break;

    const inner = await parseBytes(
      entryBytes,
      name,
      null,
      budgetChars - used,
      depth + 1,
    );
    if (inner.status !== "parsed" || inner.text.length === 0) continue;

    parts.push(`=== ${name} ===\n${inner.text}`);
    used += inner.text.length;
    parsedCount += 1;
  }

  const skippedNames =
    names.length - Math.min(names.length, MAX_ARCHIVE_ENTRIES);
  const text = parts.join("\n\n");

  if (text.trim().length < MIN_PARSED_CHARS) {
    return {
      text: "",
      status: "empty",
      reason:
        names.length === 0
          ? "Архив пуст."
          : `В архиве ${names.length} ${pluralFiles(names.length)}, ни один не удалось прочитать.`,
      truncated: false,
      archive: { parsed: parsedCount, total: names.length },
    };
  }

  return {
    text: text.slice(0, budgetChars),
    status: "parsed",
    reason: null,
    truncated:
      text.length > budgetChars || skippedNames > 0 || used >= budgetChars,
    archive: { parsed: parsedCount, total: names.length },
  };
}

/**
 * Контейнер zip: документ Office или архив.
 *
 * Один и тот же заголовок PK бывает у docx, у xlsx и у настоящего архива, а
 * имя файла в ЕИС ничего не гарантирует. На живых закупках 0320100032126000114
 * и 0320100032126000115 четыре файла «Электронный документ, полученный из
 * внешней системы (…).pdf» оказались docx: pdfjs ответил «Invalid PDF
 * structure», и документы потерялись. Поэтому контейнер открывается и
 * смотрится по именам входов — word/document.xml и xl/workbook.xml предписаны
 * спецификацией OOXML и случайными не бывают.
 *
 * Если имя уже обещает документ Office, контейнер не открывается: байты уйдут
 * родному читателю, а открывать их ещё и распаковщиком значило бы разбирать
 * каждый docx дважды — в архиве проекта контракта их бывает семнадцать.
 */
async function readZipContainer(
  bytes: Uint8Array,
  kind: AttachmentKind,
  budgetChars: number,
  depth: number,
): Promise<ParsedAttachment> {
  if (kind === "docx") return parsed(await readDocx(bytes), budgetChars);
  if (kind === "xlsx") return parsed(await readSpreadsheet(bytes), budgetChars);

  const JSZip = (await import("jszip")).default;
  // await обязателен: без него исключение из loadAsync уходит мимо catch.
  const archive = await JSZip.loadAsync(bytes);
  const names = Object.keys(archive.files).map((name) => name.toLowerCase());

  if (names.includes("word/document.xml"))
    return parsed(await readDocx(bytes), budgetChars);
  if (names.includes("xl/workbook.xml"))
    return parsed(await readSpreadsheet(bytes), budgetChars);

  if (depth >= MAX_ARCHIVE_DEPTH) {
    return unsupported(
      "Вложенный архив не распаковывается: глубже трёх уровней документацию не пакуют.",
    );
  }
  return await readArchive(zipEntries(archive), budgetChars, depth);
}

/**
 * Входы zip в общем виде. Чтение остаётся ленивым: обход прерывается по
 * лимитам, и распаковывать то, до чего он не дошёл, незачем.
 */
function zipEntries(archive: JSZip): ArchiveEntry[] {
  return Object.keys(archive.files)
    .filter((name) => !archive.files[name]?.dir)
    .map((name) => ({
      name,
      size: 0,
      bytes: async () => {
        const entry = archive.files[name];
        if (!entry) return new Uint8Array();
        return await entry.async("uint8array");
      },
    }));
}

/**
 * Архив rar или 7z: читатели живут в отдельном модуле с динамическими
 * импортами, потому что тянут wasm на мегабайты.
 *
 * Отказ по понятной причине (том комплекта, пароль) превращается в причину
 * пропуска, а не в сбой: партнёру важно знать, что файл не прочитан и почему,
 * а не увидеть техническую ошибку распаковщика.
 */
async function readBinaryArchive(
  bytes: Uint8Array,
  kind: "rar" | "7z",
  budgetChars: number,
  depth: number,
): Promise<ParsedAttachment> {
  if (depth >= MAX_ARCHIVE_DEPTH) {
    return unsupported(
      "Вложенный архив не распаковывается: глубже трёх уровней документацию не пакуют.",
    );
  }

  const readers = await import("@/services/archiveReaders");
  try {
    const entries =
      kind === "rar"
        ? await readers.readRarEntries(bytes)
        : await readers.read7zEntries(bytes);
    return await readArchive(entries, budgetChars, depth);
  } catch (err) {
    if (err instanceof ArchiveRefusedError) return unsupported(err.message);
    throw err;
  }
}

function pluralFiles(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "файл";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "файла";
  return "файлов";
}

async function parseBytes(
  bytes: Uint8Array,
  filename: string,
  contentType: string | null,
  budgetChars: number,
  depth: number,
): Promise<ParsedAttachment> {
  if (budgetChars <= 0) {
    return {
      text: "",
      status: "empty",
      reason: "Бюджет знаков исчерпан.",
      truncated: false,
    };
  }

  const kind = detectFileType(contentType, filename);

  // Содержимое важнее имени: MIME у ЕИС всегда application/download, а
  // расширение документам назначает внешняя система. Форматы, которые проект
  // не читает, определяются здесь же — иначе rar под именем zip доходит до
  // распаковщика и падает с его технической ошибкой вместо причины пропуска.
  const sniffed = sniffFileType(bytes);

  try {
    if (sniffed === "rtf")
      return unsupported(unsupportedContentReason(sniffed, filename));
    if (sniffed === "rar" || sniffed === "7z") {
      return await readBinaryArchive(bytes, sniffed, budgetChars, depth);
    }
    if (sniffed === "zip")
      return await readZipContainer(bytes, kind, budgetChars, depth);
    if (sniffed === "pdf") return parsed(await readPdf(bytes), budgetChars);

    switch (kind) {
      case "pdf":
        return parsed(await readPdf(bytes), budgetChars);
      case "docx":
        return parsed(await readDocx(bytes), budgetChars);
      case "doc":
        return parsed(await readDoc(bytes), budgetChars);
      case "xlsx":
        return parsed(await readSpreadsheet(bytes), budgetChars);
      case "csv":
      case "text":
        return parsed(Buffer.from(bytes).toString("utf-8"), budgetChars);
      case "html":
        return parsed(
          Buffer.from(bytes)
            .toString("utf-8")
            .replace(/<[^>]+>/g, " "),
          budgetChars,
        );
      case "zip":
        // Имя обещает архив, но подписи zip в файле нет — например, битый файл.
        // Пробуем открыть: ошибка распаковщика и будет причиной пропуска.
        return await readZipContainer(bytes, kind, budgetChars, depth);
      case "rar":
      case "7z":
        // Сюда попадают файлы, чьё имя обещает архив, а подписи в начале нет:
        // первый том без заголовка комплекта, обрезанная загрузка, битый файл.
        // Распаковщик скажет, что именно не так, и это станет причиной пропуска.
        return await readBinaryArchive(bytes, kind, budgetChars, depth);
      case "unsupported":
        return unsupported(unsupportedFormatReason(filename));
    }
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Комплект томов в текст: один архив, разрезанный на части.
 *
 * Отдельная точка входа от `parseAttachment`, потому что вход другой — не байты
 * одного файла, а несколько именованных частей. Дальше всё общее: те же лимиты,
 * тот же обход входов и тот же разбор каждого входа по содержимому.
 */
export async function parseArchiveVolumes(
  volumes: readonly { name: string; bytes: Uint8Array }[],
  budgetChars: number,
): Promise<ParsedAttachment> {
  if (budgetChars <= 0) {
    return {
      text: "",
      status: "empty",
      reason: "Бюджет знаков исчерпан.",
      truncated: false,
    };
  }

  const readers = await import("@/services/archiveReaders");
  const first = [...volumes].sort((left, right) =>
    left.name.localeCompare(right.name),
  )[0];
  if (!first) return unsupported("Комплект томов пуст.");

  const kind = readers.volumeSetKind(first.name);
  if (kind === null) return unsupported(unsupportedFormatReason(first.name));

  try {
    const entries =
      kind === "rar"
        ? await readers.readRarVolumeEntries(volumes)
        : await readers.read7zVolumeEntries(volumes);
    /*
      Нулевой уровень: комплект томов — это один архив, просто разрезанный на
      части. Считать его вложенным значило бы отнять у него уровень и не
      прочитать документ, который в одиночном архиве прочитался бы.
    */
    return await readArchive(entries, budgetChars, 0);
  } catch (err) {
    if (err instanceof ArchiveRefusedError) return unsupported(err.message);
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Байты документа в текст для анализа.
 *
 * Ошибки не бросаются: вызывающий код получает статус и причину, чтобы записать
 * её в карточку закупки. Исключение — повреждённый файл, и тогда партнёру важно
 * видеть конкретное сообщение парсера, а не общее «не удалось».
 *
 * `budgetChars` — сколько знаков осталось в бюджете закупки. Текст длиннее
 * бюджета обрезается, и результат помечается `truncated`.
 */
export async function parseAttachment(
  bytes: Uint8Array,
  filename: string,
  contentType: string | null,
  budgetChars: number,
): Promise<ParsedAttachment> {
  return parseBytes(bytes, filename, contentType, budgetChars, 0);
}
