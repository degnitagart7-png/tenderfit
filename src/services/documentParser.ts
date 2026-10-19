/**
 * Парсинг загружаемых документов в браузере плюс две утилиты для текста.
 *
 * Клиентская часть (`parseDocument`, `formatFileSize`) читает файл, который
 * партнёр загрузил в профиль компании или на страницу сметы: PDF, DOCX, CSV и таблицы Excel.
 * Старый .doc и архивы браузер не читает — их отдаёт серверу serverDocumentParse.ts. Серверный разбор байтов
 * живёт в attachmentParser.ts — он умеет архивы, старые .doc и таблицы, и
 * всегда берёт legacy-сборку pdfjs, потому что обычная падает в Node.
 *
 * `computeContentHash` и `splitIntoChunks` остались здесь: они нужны и клиенту,
 * и серверу, а тяжёлых зависимостей не тянут.
 */

import mammoth from "mammoth";

import { odfContentToText, odfKindFromContent, odfKindFromMime } from "@/services/odfText";
import { rtfToText } from "@/services/rtfText";

import { createHash } from "crypto";

/**
 * Что кладётся в текст вместо содержимого, когда прочитать файл не удалось.
 *
 * Разбор не бросает исключение, а возвращает документ с объяснением в поле
 * текста: вызывающий код обычно показывает список файлов и должен показать в
 * нём причину. Но такой текст — не содержимое, и отправлять его дальше по
 * конвейеру нельзя: на нём разбор ведомости отработает «успешно» и выдаст
 * пустую смету, которая выглядит как настоящая. Отличать одно от другого
 * вызывающий код обязан явно, поэтому обе метки названы и проверяются
 * `isUnreadableText`.
 */
export const UNSUPPORTED_FORMAT_TEXT = "[Неподдерживаемый формат файла]";
export const PARSE_ERROR_PREFIX = "[Ошибка парсинга: ";

/** Текст — это объяснение неудачи, а не содержимое файла. */
export function isUnreadableText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed === UNSUPPORTED_FORMAT_TEXT ||
    trimmed.startsWith(PARSE_ERROR_PREFIX)
  );
}

/** SHA-256 хеш содержимого. */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Разбиение текста на чанки для AI-анализа. */
export function splitIntoChunks(text: string, maxChunkSize: number): string[] {
  if (text.length <= maxChunkSize) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChunkSize;
    if (end < text.length) {
      // Пытаемся разбить по абзацу или предложению
      const lastParagraph = text.lastIndexOf("\n\n", end);
      const lastSentence = text.lastIndexOf(". ", end);
      const splitPoint = Math.max(lastParagraph, lastSentence);
      if (splitPoint > start + maxChunkSize / 2) {
        end = splitPoint + 2;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/* ============================== Клиентские утилиты (для DocumentUploader) ============================== */

export interface ParsedDocument {
  fileName: string;
  fileType: "pdf" | "docx" | "csv" | "txt" | "unknown";
  text: string;
  pageCount?: number;
  size: number;
}

/**
 * Как файл читается. Шире, чем `ParsedDocument["fileType"]`: тот тип лежит в
 * сохранённых документах компании, и новые форматы в нём отдельных значений не
 * получают — odt и rtf сохраняются как «docx» (текстовый документ), ods — как
 * «csv» (таблица).
 */
type ReadKind = ParsedDocument["fileType"] | "odt" | "ods" | "xlsx" | "rtf";

function storedType(kind: ReadKind): ParsedDocument["fileType"] {
  if (kind === "odt" || kind === "rtf") return "docx";
  if (kind === "ods" || kind === "xlsx") return "csv";
  return kind;
}

/** Определение типа файла по расширению. */
function getFileType(fileName: string): ReadKind {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  // Старый бинарный .doc mammoth не читает (только docx): в браузере это «неподдерживаемый формат»,
  // а настоящий разбор — на сервере (serverDocumentParse.ts → /api/documents/parse).
  // Раньше .doc шёл в mammoth и возвращал невнятную ошибку zip.
  if (ext === "csv") return "csv";
  if (ext === "txt") return "txt";
  if (ext === "odt" || ext === "ott") return "odt";
  if (ext === "ods" || ext === "ots") return "ods";
  // Смета чаще всего приходит из Гранд-Сметы или ГОСТ Сметы выгрузкой в Excel.
  if (ext === "xlsx" || ext === "xlsm" || ext === "xls") return "xlsx";
  if (ext === "rtf") return "rtf";
  return "unknown";
}

/** Парсинг PDF через pdf.js. */
async function parsePdf(
  file: File,
): Promise<{ text: string; pageCount: number }> {
  const pdfjsLib = await import("pdfjs-dist");
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pageCount = pdf.numPages;
  let text = "";

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    text += pageText + "\n\n";
  }

  return { text: text.trim(), pageCount };
}

/** Парсинг Word (.docx) через mammoth. */
async function parseDocx(file: File): Promise<{ text: string }> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return { text: result.value };
}

/**
 * Парсинг OpenDocument-текста (.odt): content.xml из zip, разбор без библиотек.
 * jszip уже в бандле клиента через mammoth; тяжёлого здесь ничего не добавлено.
 */
async function parseOdt(file: File): Promise<{ text: string }> {
  const JSZip = (await import("jszip")).default;
  const archive = await JSZip.loadAsync(await file.arrayBuffer());
  const mime = (await archive.file("mimetype")?.async("string")) ?? "";
  const content = (await archive.file("content.xml")?.async("string")) ?? "";
  if (content.length === 0) throw new Error("В файле нет content.xml");
  // Таблицу, спрятанную под именем .odt, читает ods-ветка: тип берётся по содержимому.
  const kind = odfKindFromMime(mime) ?? odfKindFromContent(content);
  if (kind === "spreadsheet") return parseSpreadsheet(await file.arrayBuffer());
  return { text: odfContentToText(content) };
}

/** Таблица (.xlsx, .xls, .ods): тем же читателем и в том же виде, что и на сервере. Подгружается лениво. */
async function parseSpreadsheet(
  buffer: ArrayBuffer,
): Promise<{ text: string }> {
  const XLSX = await import("xlsx");
  const book = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const text = book.SheetNames.map((name) => {
    const sheet = book.Sheets[name];
    const csv = sheet ? XLSX.utils.sheet_to_csv(sheet) : "";
    return `=== ${name} ===\n${csv}`;
  }).join("\n\n");
  return { text };
}

/** RTF: свой конвертер без зависимостей. */
async function parseRtf(file: File): Promise<{ text: string }> {
  return { text: rtfToText(new Uint8Array(await file.arrayBuffer())) };
}

/** Парсинг CSV — просто читаем как текст. */
async function parseCsv(file: File): Promise<{ text: string }> {
  const text = await file.text();
  return { text };
}

/** Главная функция парсинга документа. */
export async function parseDocument(file: File): Promise<ParsedDocument> {
  const fileType = getFileType(file.name);
  let text = "";
  let pageCount: number | undefined;

  try {
    if (fileType === "pdf") {
      const result = await parsePdf(file);
      text = result.text;
      pageCount = result.pageCount;
    } else if (fileType === "docx") {
      const result = await parseDocx(file);
      text = result.text;
    } else if (fileType === "odt") {
      text = (await parseOdt(file)).text;
    } else if (fileType === "ods" || fileType === "xlsx") {
      text = (await parseSpreadsheet(await file.arrayBuffer())).text;
    } else if (fileType === "rtf") {
      text = (await parseRtf(file)).text;
    } else if (fileType === "csv" || fileType === "txt") {
      const result = await parseCsv(file);
      text = result.text;
    } else {
      text = UNSUPPORTED_FORMAT_TEXT;
    }
  } catch (error) {
    console.error(`Ошибка парсинга ${file.name}:`, error);
    text = `${PARSE_ERROR_PREFIX}${error instanceof Error ? error.message : "неизвестная ошибка"}]`;
  }

  return {
    fileName: file.name,
    fileType: storedType(fileType),
    text,
    pageCount,
    size: file.size,
  };
}

/** Форматирование размера файла. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
