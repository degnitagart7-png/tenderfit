/**
 * Определение формата документа по расширению и MIME.
 *
 * Модуль отделён от attachmentParser.ts намеренно: здесь только чистые функции
 * без единого импорта, а там — парсеры с динамическими `import("jszip")`,
 * `import("xlsx")` и `import("word-extractor")`. webpack собирает достижимые
 * динамические импорты в чанки, поэтому клиентскому коду нельзя ссылаться на
 * attachmentParser даже ради `fileExtension`.
 *
 * Форматы выбраны по тому, что реально лежит во вложениях ЕИС (проверено
 * 2026-09-22 на живых закупках): в одном архиве проекта контракта из 29 файлов
 * было 17 старых .doc, 7 .xls, 3 .docx и 2 .pdf.
 */

/** Какой формат видит определитель по расширению и MIME. */
export type AttachmentKind =
  | "pdf"
  | "docx"
  | "doc"
  | "xlsx"
  | "csv"
  | "text"
  | "html"
  | "zip"
  | "rar"
  | "7z"
  | "unsupported";

/**
 * Что можно узнать о формате по первым байтам.
 *
 * «zip» здесь означает контейнер, а не архив: docx и xlsx устроены так же, и
 * различает их уже парсер по именам входов. Форматы, которые проект не читает,
 * названы явно — иначе rar под чужим именем даёт ошибку распаковщика вместо
 * внятной причины пропуска.
 */
export type SniffedKind = "pdf" | "zip" | "rar" | "7z" | "rtf";

const EXTENSION_KINDS: Record<string, AttachmentKind> = {
  pdf: "pdf",
  docx: "docx",
  docm: "docx",
  doc: "doc",
  xlsx: "xlsx",
  xls: "xlsx",
  xlsm: "xlsx",
  csv: "csv",
  tsv: "csv",
  txt: "text",
  md: "text",
  html: "html",
  htm: "html",
  zip: "zip",
  rar: "rar",
  "7z": "7z",
};

/** Расширение файла без точки, в нижнем регистре. Пустая строка, если расширения нет. */
export function fileExtension(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * Определение формата по MIME и расширению.
 *
 * ЕИС отдаёт все вложения с `content-type: application/download`, поэтому MIME
 * здесь почти никогда не решает: он оставлен для документов, загруженных рукой.
 * Расширение важнее и проверяется вторым.
 */
export function detectFileType(
  mimeType: string | null,
  fileName?: string,
): AttachmentKind {
  const mime = mimeType?.toLowerCase() ?? "";
  if (
    mime &&
    !mime.includes("application/download") &&
    !mime.includes("octet-stream")
  ) {
    if (mime.includes("pdf")) return "pdf";
    if (mime.includes("wordprocessingml")) return "docx";
    if (mime.includes("msword")) return "doc";
    if (mime.includes("spreadsheetml") || mime.includes("ms-excel"))
      return "xlsx";
    if (mime.includes("csv")) return "csv";
    if (mime.includes("html")) return "html";
    if (mime.includes("zip")) return "zip";
    if (mime.includes("rar")) return "rar";
    if (mime.includes("7z")) return "7z";
    if (mime.startsWith("text/")) return "text";
  }
  return EXTENSION_KINDS[fileExtension(fileName ?? "")] ?? "unsupported";
}

/**
 * Причина пропуска для формата, который проект не читает.
 *
 * Строка нужна и парсеру, и обходу вложений: обход определяет неподдерживаемый
 * файл до скачивания, по одному имени. На закупке 0373100096726000028 это
 * экономит 46 запросов к ЕИС за томами rar, которые всё равно нечем открыть.
 */
const UNSUPPORTED_SUFFIX =
  "не разбирается: нужен отдельный распаковщик или распознавание.";

export function unsupportedFormatReason(fileName: string): string {
  return `Формат ${fileExtension(fileName) || "неизвестный"} ${UNSUPPORTED_SUFFIX}`;
}

/**
 * Причина пропуска для формата, который узнали по содержимому.
 *
 * Расширение в ЕИС врёт: на живых закупках 0320100032126000114 и
 * 0320100032126000115 четыре файла «Электронный документ, полученный из внешней
 * системы (…).pdf» оказались docx, а pdfjs отвечал на них «Invalid PDF
 * structure». Когда имя и содержимое расходятся, партнёру важно видеть оба
 * факта — иначе причина пропуска выглядит как наша ошибка.
 */
export function unsupportedContentReason(
  kind: SniffedKind,
  fileName: string,
): string {
  const base = `Формат ${kind} ${UNSUPPORTED_SUFFIX}`;
  const extension = fileExtension(fileName);
  return extension && extension !== kind
    ? `${base} Файл назван «.${extension}», но внутри ${kind}.`
    : base;
}

/*
  Тома многотомных архивов.

  Три написания, все встречаются в ЕИС:
    «Документация.part1.rar», «…part01.rar» — тома RAR нового образца;
    «Документация.r01» — старое написание: первый том .rar, продолжения .r00, .r01;
    «ПСД.7z.001» — тома 7-Zip, номер после расширения.

  Распознаётся по имени, а не по заголовку, намеренно: проверка нужна ДО
  скачивания. Том проектной документации весит сотни мегабайт, и тянуть его,
  чтобы прочитать из заголовка то, что видно по имени, — впустую потраченный
  трафик и время воркера.
*/
const RAR_PART_VOLUME = /\.part\d+\.rar$/i;
const RAR_OLD_VOLUME = /\.r\d{2}$/i;
const SEVENZIP_VOLUME = /\.7z\.\d{3}$/i;

/** Том многотомного архива: один такой файл сам по себе не распаковывается. */
export function isVolumeName(fileName: string): boolean {
  return (
    RAR_PART_VOLUME.test(fileName) ||
    RAR_OLD_VOLUME.test(fileName) ||
    SEVENZIP_VOLUME.test(fileName)
  );
}

/**
 * Общее имя комплекта томов; null — файл не том. Нужно, чтобы собрать тома
 * одного архива вместе: «…part1.rar» и «…part2.rar» дают одно имя.
 */
export function volumeSetName(fileName: string): string | null {
  if (RAR_PART_VOLUME.test(fileName))
    return fileName.replace(RAR_PART_VOLUME, "");
  if (RAR_OLD_VOLUME.test(fileName))
    return fileName.replace(RAR_OLD_VOLUME, "");
  if (SEVENZIP_VOLUME.test(fileName))
    return fileName.replace(SEVENZIP_VOLUME, "");
  return null;
}

/** Каким распаковщиком читается комплект; null — файл не том. */
export function volumeSetKind(fileName: string): "rar" | "7z" | null {
  if (RAR_PART_VOLUME.test(fileName) || RAR_OLD_VOLUME.test(fileName))
    return "rar";
  if (SEVENZIP_VOLUME.test(fileName)) return "7z";
  return null;
}

/**
 * Причина пропуска тома: комплектная загрузка пока не сделана.
 *
 * Предел на комплект владелец проекта задал 27.09.2026 — 300 МБ; он вступит в
 * силу вместе с группировкой томов.
 */
export function volumeSetReason(fileName: string): string {
  const set = volumeSetName(fileName);
  return (
    `Это том многотомного архива${set ? ` «${set}»` : ""}: ` +
    "для распаковки нужны все тома комплекта, а скачивание комплектом пока не сделано."
  );
}

/** Совпадают ли первые байты с подписью формата. */
function hasSignature(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

const ASCII = (text: string): number[] =>
  [...text].map((char) => char.charCodeAt(0));

/**
 * Определение формата по содержимому файла.
 *
 * Нужно потому, что ни MIME, ни расширение в ЕИС не гарантируют ничего: все
 * вложения приходят как `application/download`, а имена документам даёт внешняя
 * система. Возвращает null, когда первые байты ничего не говорят, — тогда
 * решает расширение.
 *
 * Старый бинарный Office (заголовок D0 CF 11 E0) здесь намеренно не определён:
 * по подписи не отличить .doc от .xls, а читатель у них разный.
 */
export function sniffFileType(bytes: Uint8Array): SniffedKind | null {
  if (hasSignature(bytes, ASCII("%PDF"))) return "pdf";
  // Локальный заголовок, пустой архив и многотомный архив — всё один контейнер.
  if (hasSignature(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (hasSignature(bytes, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (hasSignature(bytes, [0x50, 0x4b, 0x07, 0x08])) return "zip";
  // «Rar!» + 1A 07: дальше 00 у RAR4 и 01 00 у RAR5, общий префикс у них один.
  if (hasSignature(bytes, [...ASCII("Rar!"), 0x1a, 0x07])) return "rar";
  if (hasSignature(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
  if (hasSignature(bytes, ASCII("{\\rtf"))) return "rtf";
  return null;
}
