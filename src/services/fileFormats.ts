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
  /** OpenDocument: текст (odt, fodt), презентация (odp, fodp). Таблицы ods читает читатель xlsx. */
  | "odt"
  | "odp"
  | "ods"
  | "rtf"
  /** Растровое изображение: читается только распознаванием. */
  | "image"
  | "unsupported";

/**
 * Что можно узнать о формате по первым байтам.
 *
 * «zip» здесь означает контейнер, а не архив: docx и xlsx устроены так же, и
 * различает их уже парсер по именам входов. Форматы, которые проект не читает,
 * названы явно — иначе rar под чужим именем даёт ошибку распаковщика вместо
 * внятной причины пропуска.
 */
export type SniffedKind = "pdf" | "zip" | "rar" | "7z" | "rtf" | "image";

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
  odt: "odt",
  ott: "odt",
  fodt: "odt",
  odp: "odp",
  otp: "odp",
  fodp: "odp",
  ods: "ods",
  ots: "ods",
  fods: "ods",
  rtf: "rtf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  tif: "image",
  tiff: "image",
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
    if (mime.includes("opendocument.text")) return "odt";
    if (mime.includes("opendocument.presentation")) return "odp";
    if (mime.includes("opendocument.spreadsheet")) return "ods";
    if (mime.includes("rtf")) return "rtf";
    if (
      mime.includes("image/png") ||
      mime.includes("image/jpeg") ||
      mime.includes("image/tiff")
    )
      return "image";
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

  Пять написаний, все встречаются в ЕИС:
    «Документация.part1.rar», «…part01.rar» — тома RAR нового образца;
    «Документация.r01» — старое написание: первый том .rar, продолжения .r00, .r01;
    «ПСД.7z.001» — тома 7-Zip, номер после расширения;
    «СД_2-этап.zip.001», «Закупочная документация.rar.001» — побайтовая нарезка
    одного готового файла (так режет 7-Zip, «Разделить на тома»): части
    склеиваются по порядку, и получается обычный zip или rar.

  Распознаётся по имени, а не по заголовку, намеренно: проверка нужна ДО
  скачивания. Том проектной документации весит сотни мегабайт, и тянуть его,
  чтобы прочитать из заголовка то, что видно по имени, — впустую потраченный
  трафик и время воркера.
*/
const RAR_PART_VOLUME = /\.part(\d+)\.rar$/i;
const RAR_OLD_VOLUME = /\.r\d{2}$/i;
const SEVENZIP_VOLUME = /\.7z\.(\d{3})$/i;
const ZIP_SPLIT_VOLUME = /\.zip\.(\d{3})$/i;
const RAR_SPLIT_VOLUME = /\.rar\.(\d{3})$/i;

/** Том многотомного архива: один такой файл сам по себе не распаковывается. */
export function isVolumeName(fileName: string): boolean {
  return (
    RAR_PART_VOLUME.test(fileName) ||
    RAR_OLD_VOLUME.test(fileName) ||
    SEVENZIP_VOLUME.test(fileName) ||
    ZIP_SPLIT_VOLUME.test(fileName) ||
    RAR_SPLIT_VOLUME.test(fileName)
  );
}

/**
 * Общее имя комплекта томов; null — файл не том. Нужно, чтобы собрать тома
 * одного архива вместе: «…part1.rar» и «…part2.rar» дают одно имя.
 *
 * У нарезки «.zip.001» и «.rar.001» имя сохраняет расширение архива («СД.zip»):
 * рядом могут лежать «ПД.zip.001» и «ПД.rar.001», и это два разных комплекта.
 */
export function volumeSetName(fileName: string): string | null {
  if (RAR_PART_VOLUME.test(fileName))
    return fileName.replace(RAR_PART_VOLUME, "");
  if (RAR_OLD_VOLUME.test(fileName))
    return fileName.replace(RAR_OLD_VOLUME, "");
  if (SEVENZIP_VOLUME.test(fileName))
    return fileName.replace(SEVENZIP_VOLUME, "");
  if (ZIP_SPLIT_VOLUME.test(fileName))
    return fileName.replace(/\.\d{3}$/, "");
  if (RAR_SPLIT_VOLUME.test(fileName))
    return fileName.replace(/\.\d{3}$/, "");
  return null;
}

/**
 * Чем читается комплект; null — файл не том.
 *
 * «rar» и «7z» — настоящие многотомные архивы, которые распаковщик собирает
 * сам. «zip-split» и «rar-split» — побайтовая нарезка одного файла: тома
 * склеиваются и читаются как обычный архив.
 */
export type VolumeSetKind = "rar" | "7z" | "zip-split" | "rar-split";

export function volumeSetKind(fileName: string): VolumeSetKind | null {
  if (RAR_PART_VOLUME.test(fileName) || RAR_OLD_VOLUME.test(fileName))
    return "rar";
  if (SEVENZIP_VOLUME.test(fileName)) return "7z";
  if (ZIP_SPLIT_VOLUME.test(fileName)) return "zip-split";
  if (RAR_SPLIT_VOLUME.test(fileName)) return "rar-split";
  return null;
}

/**
 * Номер тома в комплекте, с единицы; null — номера в имени нет.
 *
 * У старого написания «.rNN» первый том называется просто «.rar», и его номера
 * из имени продолжения не вывести, поэтому для него null: пропуски там не ищутся.
 */
export function volumeNumber(fileName: string): number | null {
  const match =
    RAR_PART_VOLUME.exec(fileName) ??
    SEVENZIP_VOLUME.exec(fileName) ??
    ZIP_SPLIT_VOLUME.exec(fileName) ??
    RAR_SPLIT_VOLUME.exec(fileName);
  if (!match) return null;
  const value = parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Что не так с составом комплекта: нет тома посередине или первого.
 *
 * Принимает имена всех томов одного комплекта. Возвращает готовую причину для
 * партнёра либо null, когда номера идут подряд с первого. Проверка по именам, а
 * не по байтам: она нужна до скачивания — недостающий том делает комплект
 * неподъёмным, и качать остальные сотни мегабайт ради отказа незачем.
 *
 * Не проверяет «хвост»: если последнего тома нет совсем, по именам это не
 * увидеть — это выяснится при распаковке.
 */
export function volumeSetProblem(fileNames: readonly string[]): string | null {
  const numbers = fileNames
    .map((name) => volumeNumber(name))
    .filter((value): value is number => value !== null);
  // Старое написание «.rNN» и смешанные комплекты по номерам не проверяются.
  if (numbers.length === 0 || numbers.length !== fileNames.length) return null;

  const present = new Set(numbers);
  const highest = Math.max(...numbers);
  const missing: number[] = [];
  for (let n = 1; n <= highest; n += 1) if (!present.has(n)) missing.push(n);
  if (missing.length === 0) return null;

  const width = Math.max(
    3,
    ...fileNames.map((name) => {
      const match =
        RAR_PART_VOLUME.exec(name) ??
        SEVENZIP_VOLUME.exec(name) ??
        ZIP_SPLIT_VOLUME.exec(name) ??
        RAR_SPLIT_VOLUME.exec(name);
      return (match?.[1] ?? "").length;
    }),
  );
  const shown = missing
    .slice(0, 5)
    .map((n) => String(n).padStart(width, "0"))
    .join(", ");
  const more = missing.length > 5 ? ` и ещё ${missing.length - 5}` : "";
  const set = volumeSetName(fileNames[0] ?? "");
  return (
    `В комплекте томов${set ? ` «${set}»` : ""} не хватает ` +
    `${missing.length === 1 ? "тома" : "томов"} ${shown}${more}: ` +
    "заказчик не выложил их, без них архив не распаковать."
  );
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
  // PNG, JPEG и TIFF (оба порядка байт): сканы и схемы под чужим именем.
  if (hasSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image";
  if (hasSignature(bytes, [0xff, 0xd8, 0xff])) return "image";
  if (hasSignature(bytes, [0x49, 0x49, 0x2a, 0x00])) return "image";
  if (hasSignature(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image";
  return null;
}
