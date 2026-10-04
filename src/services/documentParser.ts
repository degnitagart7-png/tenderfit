/**
 * Парсинг загружаемых документов в браузере плюс две утилиты для текста.
 *
 * Клиентская часть (`parseDocument`, `formatFileSize`) читает файл, который
 * партнёр загрузил в профиль компании: PDF, DOCX и CSV. Серверный разбор байтов
 * живёт в attachmentParser.ts — он умеет архивы, старые .doc и таблицы, и
 * всегда берёт legacy-сборку pdfjs, потому что обычная падает в Node.
 *
 * `computeContentHash` и `splitIntoChunks` остались здесь: они нужны и клиенту,
 * и серверу, а тяжёлых зависимостей не тянут.
 */

import mammoth from "mammoth";

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

/** Определение типа файла по расширению. */
function getFileType(fileName: string): ParsedDocument["fileType"] {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  if (ext === "csv") return "csv";
  if (ext === "txt") return "txt";
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
    fileType,
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
