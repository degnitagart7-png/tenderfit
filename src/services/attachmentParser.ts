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
  fileExtension,
  sniffFileType,
  unsupportedFormatReason,
  volumeSetKind,
  volumeSetName,
  volumeSetProblem,
} from "@/services/fileFormats";
import type { AttachmentKind } from "@/services/fileFormats";
import {
  ArchiveRefusedError,
  type ArchiveEntry,
} from "@/services/archiveReaders";
import {
  LARGE_ARCHIVE_BYTES,
  MAX_DISK_ARCHIVE_ENTRIES,
  MAX_DISK_ARCHIVE_UNCOMPRESSED,
  concatFiles,
  extractArchive,
  getArchiveCli,
  listExtractedEntries,
  makeTempDir,
  pickTool,
  type ArchiveCli,
} from "@/services/archiveCli";
import type {
  ArchiveReport,
  ArchiveSkippedEntry,
  SkippedCode,
} from "@/types/database";
import {
  odfContentToText,
  odfKindFromContent,
  odfKindFromMime,
  type OdfKind,
} from "@/services/odfText";
import { rtfToText } from "@/services/rtfText";
import { sanitizePgText } from "@/lib/sanitizeText";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OcrEngine, OcrResult } from "@/services/ocr";
import {
  OCR_UNAVAILABLE_NOTE,
  assessOcrPages,
  ocrHeader,
} from "@/services/ocrQuality";

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
  /**
   * Код пропуска, когда он не следует из статуса. Нужен одному случаю: архив,
   * распаковывающийся в объём больше предела, — это «файл слишком большой», а
   * не «формат не читается»: от первого повторный прогон не лечит, а второй
   * плановая загрузка перекачивала бы каждые два часа.
   */
  code?: SkippedCode;
  /** Текст обрезан по бюджету знаков — целиком файл в лимит не влез. */
  truncated: boolean;
  /**
   * Для архива: сколько входов разобрано из скольких и какие не прочитаны
   * (имя и причина). Каталоги в `total` и в `skipped` не входят.
   */
  archive?: ArchiveReport;
  /**
   * Текст распознан со скана, а не прочитан из текстового слоя.
   * `pages` — сколько страниц распознано, `totalPages` — сколько их в файле.
   * Для архива — суммы по всем распознанным входам. Первая строка такого
   * текста — «[Текст распознан со скана: N стр. из M]».
   */
  ocr?: { pages: number; totalPages: number };
}

/**
 * Необязательные порты разбора.
 *
 * `ocr` — движок распознавания сканов. Не задан — берётся общий движок процесса
 * (`getOcrEngine()` из ocr.ts, подключается только когда встретился скан);
 * `null` — распознавание выключено. Тесты подставляют свой движок: настоящий
 * Tesseract в них не запускается.
 */
export interface ParseOptions {
  ocr?: OcrEngine | null;
  /** Часы в миллисекундах; нужны только для лимита времени распознавания на архив. */
  now?: () => number;
  /**
   * Распаковщики 7z и unrar для дисковой распаковки. Не задан — ищутся на машине
   * (один раз за процесс); `null` — выключены, всё идёт в памяти с прежними
   * пределами. Тесты подставляют свой запуск команд.
   */
  archiveCli?: ArchiveCli | null;
}

/**
 * Сколько времени распознавания можно потратить на один разбираемый файл,
 * считая все его вложенные сканы: два часа, как и на отдельный скан в ocr.ts.
 * Это аварийная защита, а не рабочий предел (раньше было 20 минут, и архив с
 * десятком больших сканов дочитывался только до половины).
 */
export const MAX_OCR_MS_PER_PARSE = 2 * 60 * 60_000;

/** Состояние одного вызова разбора: порты и израсходованное время распознавания. */
interface ParseContext {
  options: ParseOptions;
  ocrSpentMs: number;
  /** Найденные распаковщики; undefined — ещё не искали. */
  cli?: ArchiveCli | null;
}

function newContext(options: ParseOptions | undefined): ParseContext {
  return { options: options ?? {}, ocrSpentMs: 0 };
}

/** Распаковщики для этого разбора; null — работаем в памяти. */
async function resolveCli(ctx: ParseContext): Promise<ArchiveCli | null> {
  if (ctx.cli !== undefined) return ctx.cli;
  ctx.cli =
    ctx.options.archiveCli !== undefined
      ? ctx.options.archiveCli
      : await getArchiveCli();
  return ctx.cli;
}

/** Меньше этого объёма текст считается отсутствующим: скан без слоя или битый файл. */
export const MIN_PARSED_CHARS = 40;

/**
 * Сколько входов архива обходится, когда распаковка идёт в памяти (на машине нет
 * 7z и unrar). Когда программы есть, действует MAX_DISK_ARCHIVE_ENTRIES — 5000.
 */
export const MAX_ARCHIVE_ENTRIES = 200;

/**
 * Предохранитель от архива, который распаковывается в гигабайты, пока читаем в
 * памяти процесса: 200 МБ. С программами 7z и unrar архив лежит на диске, и
 * действует MAX_DISK_ARCHIVE_UNCOMPRESSED — 5 ГБ.
 */
export const MAX_ARCHIVE_UNCOMPRESSED = 200_000_000;

/** Пределы обхода входов архива: зависят от того, где идёт распаковка. */
interface ArchiveLimits {
  maxEntries: number;
  maxUncompressed: number;
}

const MEMORY_LIMITS: ArchiveLimits = {
  maxEntries: MAX_ARCHIVE_ENTRIES,
  maxUncompressed: MAX_ARCHIVE_UNCOMPRESSED,
};
const DISK_LIMITS: ArchiveLimits = {
  maxEntries: MAX_DISK_ARCHIVE_ENTRIES,
  maxUncompressed: MAX_DISK_ARCHIVE_UNCOMPRESSED,
};

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
 * от разрастания — не глубина, а лимиты: входы и распакованный объём
 * (5000 и 5 ГБ с программами 7z/unrar, 200 и 200 МБ в памяти) считаются
 * в пределах каждого архива.
 */
const MAX_ARCHIVE_DEPTH = 3;

/** Причина «пусто»: общая для всех форматов, её же ищет скрипт повторного разбора. */
export const NO_TEXT_LAYER_REASON =
  "Текстового слоя нет: файл отсканирован или пуст.";

/** Причина для схемы и чертежа: распознавание отработало, но читать там нечего. */
export const SCHEME_REASON = "Схема или чертёж: текста почти нет.";

function parsed(text: string, budgetChars: number): ParsedAttachment {
  // Нулевые символы и одиночные суррогаты Postgres не принимает: чистим у
  // источника, чтобы длина и хэш текста совпадали с тем, что ляжет в базу.
  const clean = sanitizePgText(text.replace(/\r\n/g, "\n")).trim();
  if (clean.length < MIN_PARSED_CHARS) {
    return {
      text: "",
      status: "empty",
      reason: NO_TEXT_LAYER_REASON,
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
async function readPdf(
  bytes: Uint8Array,
): Promise<{ text: string; numPages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Копия: pdfjs вправе передать буфер воркеру, а байты нужны ещё и распознаванию.
  const document_ = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
  }).promise;

  let text = "";
  for (let page = 1; page <= document_.numPages; page += 1) {
    const content = await (await document_.getPage(page)).getTextContent();
    text +=
      content.items
        .map((item) => ("str" in item ? (item.str ?? "") : ""))
        .join(" ") + "\n\n";
  }
  return { text, numPages: document_.numPages };
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
 * Размер entry в распакованном виде, если JSZip его знает.
 * Поле непубличное, поэтому читается осторожно: нет — значит, не проверяем.
 */
function jszipUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const data = (entry as unknown as { _data?: { uncompressedSize?: unknown } })
    ._data;
  return typeof data?.uncompressedSize === "number" ? data.uncompressedSize : null;
}

/**
 * Предел на content.xml одного документа OpenDocument. XML в десятки мегабайт —
 * это большая ведомость. Поднят со 150 до 400 МБ (2026-10-08): строка в V8 не
 * длиннее ~512 млн знаков, так что больший файл всё равно не прочитать.
 */
const MAX_ODF_XML_BYTES = 400_000_000;

/** Содержимое entry zip как строка UTF-8; null — entry нет. */
async function zipText(archive: JSZip, name: string): Promise<string | null> {
  const key = Object.keys(archive.files).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  const entry = key ? archive.files[key] : undefined;
  if (!entry || entry.dir) return null;
  const size = jszipUncompressedSize(entry);
  if (size !== null && size > MAX_ODF_XML_BYTES) {
    throw new Error(`Entry ${name} в документе OpenDocument слишком велик (${Math.round(size / 1_000_000)} МБ).`);
  }
  return await entry.async("string");
}

/**
 * Тип OpenDocument для открытого контейнера; null — это не OpenDocument.
 *
 * Сначала entry «mimetype», который стандарт требует первым и без сжатия, потом
 * запасной признак: content.xml рядом с META-INF/manifest.xml. Имя файла не
 * участвует: «Ведомость.odt» бывает docx, а «Ведомость.doc» бывает odt.
 */
async function detectOdf(
  archive: JSZip,
  names: readonly string[],
): Promise<{ kind: OdfKind; content: string | null } | null> {
  const mime = names.includes("mimetype") ? await zipText(archive, "mimetype") : null;
  const fromMime = mime ? odfKindFromMime(mime) : null;
  if (fromMime) return { kind: fromMime, content: null };

  if (names.includes("content.xml") && names.includes("meta-inf/manifest.xml")) {
    const content = await zipText(archive, "content.xml");
    if (content === null) return null;
    return { kind: odfKindFromContent(content) ?? "text", content };
  }
  return null;
}

/** Текст документа OpenDocument из открытого контейнера. */
async function readOdfContainer(
  archive: JSZip,
  bytes: Uint8Array,
  found: { kind: OdfKind; content: string | null },
): Promise<string> {
  // Таблицу читает SheetJS: он понимает ods целиком, включая повтор колонок и формулы.
  if (found.kind === "spreadsheet") return await readSpreadsheet(bytes);
  const content = found.content ?? (await zipText(archive, "content.xml"));
  if (content === null)
    throw new Error("В документе OpenDocument нет content.xml.");
  return odfContentToText(content);
}

/** Плоский OpenDocument (fodt, fodp): один xml без контейнера. */
function readFlatOdf(bytes: Uint8Array): string {
  const xml = Buffer.from(bytes).toString("utf-8");
  if (!xml.slice(0, 4096).includes("office:document"))
    throw new Error("Файл не похож на документ OpenDocument.");
  return odfContentToText(xml);
}

/** Файл — RTF, пусть и с пробелами или BOM перед заголовком. */
function looksLikeRtf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 256)).toString("latin1").includes("{\\rtf");
}

/** Часы разбора: порт нужен тестам лимита времени распознавания. */
function clock(ctx: ParseContext): number {
  return (ctx.options.now ?? Date.now)();
}

/** Движок распознавания; null — выключен. Общий движок подключается лениво. */
async function resolveOcr(ctx: ParseContext): Promise<OcrEngine | null> {
  if (ctx.options.ocr !== undefined) return ctx.options.ocr;
  const { getOcrEngine } = await import("@/services/ocr");
  return getOcrEngine();
}

/**
 * Скан без распознавания: как раньше — причина пропуска, но с пометкой о
 * серверной стороне. pdf остаётся «без текстового слоя», картинка — «формат не
 * разбирается»: по этим фразам скрипт повторного разбора находит такие файлы,
 * когда на сервере появляется Tesseract.
 *
 * Картинка получает статус «empty», а не «unsupported», хотя фраза прежняя:
 * формат известен, и повторять скачивание при каждой плановой синхронизации
 * (isRetryableSkip берёт только unsupported_format) незачем.
 */
function scanWithoutOcr(
  kind: "pdf" | "image",
  filename: string,
  note: string,
): ParsedAttachment {
  const reason =
    kind === "pdf"
      ? `${NO_TEXT_LAYER_REASON} ${note}`
      : `${unsupportedFormatReason(filename)} ${note}`;
  return { text: "", status: "empty", reason, truncated: false };
}

/** Распознанное — в результат разбора: оценка качества, заголовок, бюджет. */
function ocrOutcome(
  result: Extract<OcrResult, { status: "ok" }>,
  budgetChars: number,
): ParsedAttachment {
  const ocr = { pages: result.recognized, totalPages: result.totalPages };
  const assessment = assessOcrPages(result.pages);
  if (assessment.kind === "scheme") {
    return { text: "", status: "empty", reason: SCHEME_REASON, truncated: false, ocr };
  }

  const header = ocrHeader(result.recognized, result.totalPages);
  const body = parsed(assessment.text, Math.max(1, budgetChars - header.length - 1));
  if (body.status !== "parsed") {
    // Страницы с текстом нашлись, но набралось меньше порога: это те же обрывки.
    return { text: "", status: "empty", reason: SCHEME_REASON, truncated: false, ocr };
  }
  return {
    text: `${header}\n${body.text}`,
    status: "parsed",
    reason: null,
    // Дочитали не все страницы файла: предел страниц или времени.
    truncated: body.truncated || result.recognized < result.totalPages,
    ocr,
  };
}

/**
 * Распознавание скана: pdf без текстового слоя или картинки.
 *
 * Нет движка или программ — файл остаётся нечитаемым без ошибки. Время
 * распознавания на один вызов разбора ограничено: архив из десятков сканов не
 * должен занять воркер на часы.
 */
async function recognizeScan(
  source:
    | { kind: "pdf"; bytes: Uint8Array; totalPages: number }
    | { kind: "image"; bytes: Uint8Array; extension: string },
  filename: string,
  budgetChars: number,
  ctx: ParseContext,
): Promise<ParsedAttachment> {
  const engine = await resolveOcr(ctx);
  if (!engine || !(await engine.available(source.kind))) {
    return scanWithoutOcr(source.kind, filename, OCR_UNAVAILABLE_NOTE);
  }
  if (ctx.ocrSpentMs >= MAX_OCR_MS_PER_PARSE) {
    return scanWithoutOcr(
      source.kind,
      filename,
      `Распознавание пропущено: на этот файл уже потрачено ${MAX_OCR_MS_PER_PARSE / 60_000} минут.`,
    );
  }

  const started = clock(ctx);
  let result: OcrResult;
  try {
    result =
      source.kind === "pdf"
        ? await engine.recognizePdf(source.bytes, source.totalPages)
        : await engine.recognizeImage(source.bytes, source.extension);
  } catch (err) {
    return failed(`Распознавание не удалось: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ctx.ocrSpentMs += Math.max(0, clock(ctx) - started);
  }

  switch (result.status) {
    case "unavailable":
      return scanWithoutOcr(source.kind, filename, OCR_UNAVAILABLE_NOTE);
    case "failed":
      return failed(result.reason);
    case "ok":
      return ocrOutcome(result, budgetChars);
  }
}

/** PDF: текстовый слой, а когда его нет — распознавание. */
async function parsePdf(
  bytes: Uint8Array,
  filename: string,
  budgetChars: number,
  ctx: ParseContext,
): Promise<ParsedAttachment> {
  const { text, numPages } = await readPdf(bytes);
  const layer = parsed(text, budgetChars);
  if (layer.status !== "empty") return layer;
  return await recognizeScan(
    { kind: "pdf", bytes, totalPages: numPages },
    filename,
    budgetChars,
    ctx,
  );
}

/** Картинка: единственный способ прочитать её — распознавание. */
async function parseImage(
  bytes: Uint8Array,
  filename: string,
  budgetChars: number,
  ctx: ParseContext,
): Promise<ParsedAttachment> {
  return await recognizeScan(
    { kind: "image", bytes, extension: fileExtension(filename) },
    filename,
    budgetChars,
    ctx,
  );
}

/** Сколько пропущенных входов архива записывается в отчёт: список — выборка, а не журнал. */
export const MAX_SKIPPED_ENTRIES = 200;
/** Длина имени и причины в отчёте о пропусках. Имя режется с начала: расширение важнее пути. */
const SKIPPED_NAME_CHARS = 200;
const SKIPPED_REASON_CHARS = 160;

/** Имя входа в отчёт: слишком длинное режется слева, чтобы расширение осталось видно. */
function skippedName(name: string): string {
  return name.length <= SKIPPED_NAME_CHARS
    ? name
    : `…${name.slice(name.length - (SKIPPED_NAME_CHARS - 1))}`;
}

function skippedReason(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length <= SKIPPED_REASON_CHARS
    ? flat
    : `${flat.slice(0, SKIPPED_REASON_CHARS - 1)}…`;
}

/** Причина, по которой вход не стал текстом: своя, а когда её нет — по статусу. */
function innerSkipReason(inner: ParsedAttachment): string {
  if (inner.reason) return inner.reason;
  switch (inner.status) {
    case "unsupported":
      return "формат не читается";
    case "empty":
      return "текста нет";
    case "failed":
      return "ошибка чтения";
    default:
      return "пустой текст";
  }
}

/**
 * Обход входов архива, общий для zip, rar и 7z.
 *
 * Источник входов передаётся списком, а не распаковщиком: все три формата
 * различаются только тем, как достать имена и байты, а лимиты, бюджет знаков,
 * рекурсия и отчёт «разобрано N из M» у них обязаны быть одни. Два набора
 * лимитов на два формата разошлись бы через месяц, и партнёр увидел бы, что
 * одна и та же документация читается по-разному в зависимости от упаковки.
 */
/**
 * Служебные файлы архива, которые документами не являются: временный файл блокировки
 * Word («~$Техническое задание.docx» — 162 байта с именем пользователя), миниатюры и
 * настройки папки Windows и macOS, открепленные электронные подписи (.sig, .sign, .p7s).
 *
 * Зачем. Они считались входами архива и попадали в «не прочитано»: замер 19.10.2026 по
 * 57 перечитанным архивам — из 15 «битых» документов Word 9 были файлами «~$…», ещё
 * 11 входов — Thumbs.db, 9 — подписи. Партнёр видел «прочитано 3 из 5» и список
 * «непрочитанных» там, где прочитано всё, что можно прочитать. Такие входы не читаются
 * и не учитываются ни в total, ни в списке пропусков.
 */
const ARCHIVE_JUNK_NAME = /(?:^|\/)(?:~\$[^/]*|thumbs\.db|desktop\.ini|\.ds_store|[^/]*\.(?:sig|sign|p7s))$|(?:^|\/)__macosx\//i;

export function isArchiveJunk(name: string): boolean {
  return ARCHIVE_JUNK_NAME.test(name);
}

async function readArchive(
  entries: readonly ArchiveEntry[],
  budgetChars: number,
  depth: number,
  ctx: ParseContext,
  limits: ArchiveLimits = MEMORY_LIMITS,
): Promise<ParsedAttachment> {
  const sorted = entries.filter((entry) => !isArchiveJunk(entry.name)).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const names = sorted.map((entry) => entry.name);

  const parts: string[] = [];
  let used = 0;
  let uncompressed = 0;
  let parsedCount = 0;
  let ocrPages = 0;
  let ocrTotalPages = 0;
  // Обход остановлен по объёму распакованного, а не по входам или знакам: такой
  // архив прочитан не целиком, и молчать об этом нельзя.
  let stoppedByVolume = false;
  // Что не прочитано, с причиной: по одному счётчику нельзя понять, какие файлы
  // теряются (родные файлы сметных программ, чертежи, сканы). Каталогов здесь
  // нет — их не отдаёт ни один источник входов, поэтому `total` их не считает.
  const skipped: ArchiveSkippedEntry[] = [];
  const noteSkipped = (name: string, reason: string): void => {
    skipped.push({ name: skippedName(name), reason: skippedReason(reason) });
  };
  /** Первый вход, до которого обход не дошёл, и причина остановки. */
  let notVisitedFrom = sorted.length;
  let notVisitedReason = "";

  const visited = sorted.slice(0, limits.maxEntries);
  for (const [index, entry] of visited.entries()) {
    const name = entry.name;
    if (used >= budgetChars) {
      notVisitedFrom = index;
      notVisitedReason = "не читался: бюджет знаков на архив исчерпан";
      break;
    }

    let inner: ParsedAttachment;
    if (entry.path !== undefined && entry.size >= LARGE_ARCHIVE_BYTES) {
      // Крупный вход дисковой распаковки в память целиком не поднимается: архив
      // внутри архива читается прямо с диска.
      uncompressed += entry.size;
      if (uncompressed > limits.maxUncompressed) {
        stoppedByVolume = true;
        notVisitedFrom = index;
        notVisitedReason = "не читался: превышен предел распакованного объёма";
        break;
      }
      inner = await parseDiskPath(
        entry.path,
        name,
        budgetChars - used,
        depth + 1,
        ctx,
      );
    } else {
      const entryBytes = await entry.bytes();
      uncompressed += entryBytes.byteLength;
      if (uncompressed > limits.maxUncompressed) {
        stoppedByVolume = true;
        notVisitedFrom = index;
        notVisitedReason = "не читался: превышен предел распакованного объёма";
        break;
      }
      inner = await parseBytes(
        entryBytes,
        name,
        null,
        budgetChars - used,
        depth + 1,
        ctx,
      );
    }
    // Прочитанный вход с диска не нужен: место освобождается сразу, а не в конце.
    await entry.release?.();
    if (inner.status !== "parsed" || inner.text.length === 0) {
      // Вложенный архив, из которого ничего не вышло, называет свои входы:
      // «Раздел.zip/Смета.gsfx» говорит больше, чем «Раздел.zip: ни один не прочитан».
      const nested = inner.archive?.skipped;
      if (nested && nested.length > 0) {
        for (const child of nested) noteSkipped(`${name}/${child.name}`, child.reason);
      } else {
        noteSkipped(name, innerSkipReason(inner));
      }
      continue;
    }
    for (const child of inner.archive?.skipped ?? []) {
      noteSkipped(`${name}/${child.name}`, child.reason);
    }

    parts.push(`=== ${name} ===\n${inner.text}`);
    used += inner.text.length;
    parsedCount += 1;
    if (inner.ocr) {
      ocrPages += inner.ocr.pages;
      ocrTotalPages += inner.ocr.totalPages;
    }
  }

  const skippedNames =
    names.length - Math.min(names.length, limits.maxEntries);
  // Не дошли ни по остановке обхода, ни по числу входов: после реальных отказов,
  // чтобы потолок списка отрезал их, а не причины настоящих потерь.
  for (const entry of sorted.slice(notVisitedFrom, limits.maxEntries)) {
    noteSkipped(entry.name, notVisitedReason);
  }
  for (const entry of sorted.slice(limits.maxEntries)) {
    noteSkipped(
      entry.name,
      `не читался: в архиве больше ${limits.maxEntries} файлов`,
    );
  }
  const report = (): ArchiveReport => ({
    parsed: parsedCount,
    total: names.length,
    ...(skipped.length > 0
      ? { skipped: skipped.slice(0, MAX_SKIPPED_ENTRIES) }
      : {}),
  });
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
      archive: report(),
    };
  }

  return {
    text: text.slice(0, budgetChars),
    status: "parsed",
    reason: null,
    truncated:
      text.length > budgetChars ||
      skippedNames > 0 ||
      used >= budgetChars ||
      stoppedByVolume,
    archive: report(),
    ...(ocrTotalPages > 0
      ? { ocr: { pages: ocrPages, totalPages: ocrTotalPages } }
      : {}),
  };
}

/** Отказ читать архив по понятной причине превращается в причину пропуска. */
function refusal(err: ArchiveRefusedError): ParsedAttachment {
  return err.refusal === "TOO_LARGE"
    ? { ...unsupported(err.message), code: "file_too_large" }
    : unsupported(err.message);
}

/** Распаковщики умеют читать этот вид архива. */
type DiskKind = "rar" | "7z" | "zip";

/**
 * Архив на диске: распаковка в mkdtemp-каталог программой 7z или unrar, входы
 * читаются по одному и удаляются, каталог убирается в finally при любом исходе.
 * Память процесса при этом держит один вход, а не весь архив.
 */
async function readArchiveOnDisk(
  archivePath: string,
  tool: "7z" | "unrar",
  cli: ArchiveCli,
  budgetChars: number,
  depth: number,
  ctx: ParseContext,
): Promise<ParsedAttachment> {
  const work = await makeTempDir("tenderfit-arc-", cli.tmpRoot);
  try {
    await extractArchive(cli, tool, archivePath, work.dir);
    const entries = await listExtractedEntries(work.dir);
    return await readArchive(entries, budgetChars, depth, ctx, DISK_LIMITS);
  } finally {
    await work.dispose();
  }
}

/** Первые байты файла: по ним узнаётся формат, не читая файл целиком. */
async function readHead(path: string, length = 16): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Расширения контейнеров Office: zip по подписи, но не архив. */
const ZIP_OFFICE_KINDS: readonly AttachmentKind[] = [
  "docx",
  "xlsx",
  "odt",
  "odp",
  "ods",
];

/**
 * Файл на диске в текст.
 *
 * Архив, который есть чем распаковать (7z, unrar), читается с диска; всё
 * остальное — документ, pdf, архив без программ — поднимается в память и идёт
 * обычным путём. Глубина вложенности считается как у байтового разбора.
 */
async function parseDiskPath(
  path: string,
  filename: string,
  budgetChars: number,
  depth: number,
  ctx: ParseContext,
): Promise<ParsedAttachment> {
  try {
    const cli = await resolveCli(ctx);
    if (cli) {
      const head = await readHead(path);
      const sniffed = sniffFileType(head);
      const kind = detectFileType(null, filename);

      let archiveKind: DiskKind | null = null;
      if (sniffed === "rar" || sniffed === "7z") archiveKind = sniffed;
      else if (sniffed === "zip" && !ZIP_OFFICE_KINDS.includes(kind))
        archiveKind = "zip";
      else if (sniffed === null && (kind === "rar" || kind === "7z"))
        archiveKind = kind;

      if (archiveKind !== null) {
        if (depth >= MAX_ARCHIVE_DEPTH) {
          return unsupported(
            "Вложенный архив не распаковывается: глубже трёх уровней документацию не пакуют.",
          );
        }
        const tool = pickTool(cli, archiveKind);
        if (tool !== null) {
          return await readArchiveOnDisk(path, tool, cli, budgetChars, depth, ctx);
        }
      }
    }
    return await parseBytes(
      new Uint8Array(await readFile(path)),
      filename,
      null,
      budgetChars,
      depth,
      ctx,
    );
  } catch (err) {
    if (err instanceof ArchiveRefusedError) return refusal(err);
    return failed(err instanceof Error ? err.message : String(err));
  }
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
  ctx: ParseContext,
): Promise<ParsedAttachment> {
  if (kind === "docx") return parsed(await readDocx(bytes), budgetChars);
  if (kind === "xlsx") return parsed(await readSpreadsheet(bytes), budgetChars);

  // Крупный zip с программами на машине читается с диска: JSZip держит в памяти
  // весь файл и каталог входов, а для 300 МБ это уже заметно.
  if (bytes.byteLength >= LARGE_ARCHIVE_BYTES && depth < MAX_ARCHIVE_DEPTH) {
    const cli = await resolveCli(ctx);
    const tool = cli ? pickTool(cli, "zip") : null;
    if (cli && tool) {
      return await readBytesOnDisk(bytes, "archive.zip", tool, cli, budgetChars, depth, ctx);
    }
  }

  const JSZip = (await import("jszip")).default;
  // await обязателен: без него исключение из loadAsync уходит мимо catch.
  const archive = await JSZip.loadAsync(bytes);
  const names = Object.keys(archive.files).map((name) => name.toLowerCase());

  if (names.includes("word/document.xml"))
    return parsed(await readDocx(bytes), budgetChars);
  if (names.includes("xl/workbook.xml"))
    return parsed(await readSpreadsheet(bytes), budgetChars);

  // OpenDocument — тоже zip; от архива его отличает mimetype или content.xml.
  const odf = await detectOdf(archive, names);
  if (odf) return parsed(await readOdfContainer(archive, bytes, odf), budgetChars);

  if (depth >= MAX_ARCHIVE_DEPTH) {
    return unsupported(
      "Вложенный архив не распаковывается: глубже трёх уровней документацию не пакуют.",
    );
  }

  /*
    Пределы входов и объёма зависят от того, есть ли на машине распаковщики.
    Вход zip читается лениво и по одному, поэтому большие пределы (5000 входов,
    5 ГБ) памяти не стоят — а без программ остаются прежние 200 входов и 200 МБ.
  */
  const cli = await resolveCli(ctx);
  return await readArchive(
    zipEntries(archive),
    budgetChars,
    depth,
    ctx,
    cli ? DISK_LIMITS : MEMORY_LIMITS,
  );
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
  ctx: ParseContext,
): Promise<ParsedAttachment> {
  if (depth >= MAX_ARCHIVE_DEPTH) {
    return unsupported(
      "Вложенный архив не распаковывается: глубже трёх уровней документацию не пакуют.",
    );
  }

  try {
    // Программы на машине есть — архив читается через диск при любом объёме: wasm
    // держит в памяти и архив, и всё распакованное, а входов у него 200, не 5000.
    const cli = await resolveCli(ctx);
    const tool = cli ? pickTool(cli, kind) : null;
    if (cli && tool) {
      return await readBytesOnDisk(
        bytes,
        kind === "rar" ? "archive.rar" : "archive.7z",
        tool,
        cli,
        budgetChars,
        depth,
        ctx,
      );
    }

    const readers = await import("@/services/archiveReaders");
    const entries =
      kind === "rar"
        ? await readers.readRarEntries(bytes)
        : await readers.read7zEntries(bytes);
    return await readArchive(entries, budgetChars, depth, ctx);
  } catch (err) {
    if (err instanceof ArchiveRefusedError) return refusal(err);
    throw err;
  }
}

/** Байты архива во временный файл и дальше — дисковый путь. */
async function readBytesOnDisk(
  bytes: Uint8Array,
  fileName: string,
  tool: "7z" | "unrar",
  cli: ArchiveCli,
  budgetChars: number,
  depth: number,
  ctx: ParseContext,
): Promise<ParsedAttachment> {
  const work = await makeTempDir("tenderfit-src-", cli.tmpRoot);
  try {
    const archivePath = join(work.dir, fileName);
    await writeFile(archivePath, bytes);
    return await readArchiveOnDisk(archivePath, tool, cli, budgetChars, depth, ctx);
  } finally {
    await work.dispose();
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
  ctx: ParseContext,
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
    if (sniffed === "rtf") return parsed(rtfToText(bytes), budgetChars);
    if (sniffed === "image")
      return await parseImage(bytes, filename, budgetChars, ctx);
    if (sniffed === "rar" || sniffed === "7z") {
      return await readBinaryArchive(bytes, sniffed, budgetChars, depth, ctx);
    }
    if (sniffed === "zip")
      return await readZipContainer(bytes, kind, budgetChars, depth, ctx);
    if (sniffed === "pdf")
      return await parsePdf(bytes, filename, budgetChars, ctx);

    switch (kind) {
      case "pdf":
        return await parsePdf(bytes, filename, budgetChars, ctx);
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
        return await readZipContainer(bytes, kind, budgetChars, depth, ctx);
      case "odt":
      case "odp":
        // Не zip, а плоский xml: fodt и fodp. Настоящие odt/odp сюда не доходят —
        // у них подпись zip, и они ушли в readZipContainer выше.
        return parsed(readFlatOdf(bytes), budgetChars);
      case "ods":
        // SheetJS читает и ods, и плоский fods.
        return parsed(await readSpreadsheet(bytes), budgetChars);
      case "rtf":
        return parsed(
          looksLikeRtf(bytes)
            ? rtfToText(bytes)
            : Buffer.from(bytes).toString("utf-8"),
          budgetChars,
        );
      case "image":
        return await parseImage(bytes, filename, budgetChars, ctx);
      case "rar":
      case "7z":
        // Сюда попадают файлы, чьё имя обещает архив, а подписи в начале нет:
        // первый том без заголовка комплекта, обрезанная загрузка, битый файл.
        // Распаковщик скажет, что именно не так, и это станет причиной пропуска.
        return await readBinaryArchive(bytes, kind, budgetChars, depth, ctx);
      case "unsupported":
        return unsupported(unsupportedFormatReason(filename));
    }
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/** Склейка томов нарезки в один файл: части идут по порядку номеров. */
function concatVolumes(parts: readonly { bytes: Uint8Array }[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.bytes.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part.bytes, offset);
    offset += part.bytes.byteLength;
  }
  return joined;
}

/**
 * Комплект томов в текст: один архив, разрезанный на части.
 *
 * Отдельная точка входа от `parseAttachment`, потому что вход другой — не байты
 * одного файла, а несколько именованных частей. Дальше всё общее: те же лимиты,
 * тот же обход входов и тот же разбор каждого входа по содержимому.
 *
 * Два рода комплектов. Настоящие многотомные архивы («.part1.rar», «.7z.001»)
 * собирает сам распаковщик. Побайтовая нарезка («.zip.001», «.rar.001» — так
 * режет 7-Zip) склеивается здесь: части идут по номерам, и получается обычный
 * zip или rar, который читается как любой другой.
 */
export async function parseArchiveVolumes(
  volumes: readonly { name: string; bytes: Uint8Array }[],
  budgetChars: number,
  options?: ParseOptions,
): Promise<ParsedAttachment> {
  if (budgetChars <= 0) {
    return {
      text: "",
      status: "empty",
      reason: "Бюджет знаков исчерпан.",
      truncated: false,
    };
  }

  const ctx = newContext(options);
  const readers = await import("@/services/archiveReaders");
  const sorted = [...volumes].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const first = sorted[0];
  if (!first) return unsupported("Комплект томов пуст.");

  const kind = volumeSetKind(first.name);
  if (kind === null) return unsupported(unsupportedFormatReason(first.name));

  // Недостающий том делает комплект неподъёмным: отказ с именами недостающих,
  // а не загадочная ошибка распаковщика.
  const problem = volumeSetProblem(sorted.map((part) => part.name));
  if (problem !== null) return unsupported(problem);

  try {
    if (kind === "zip-split" || kind === "rar-split") {
      const set = volumeSetName(first.name) ?? first.name;
      // Имя без номера тома («СД.zip») подсказывает формат, но решает содержимое.
      const result = await parseBytes(
        concatVolumes(sorted),
        set,
        null,
        budgetChars,
        0,
        ctx,
      );
      if (result.status === "failed") {
        return failed(
          `Комплект «${set}» не собрался в архив: ${result.reason ?? "ошибка чтения"}. ` +
            "Возможно, не хватает последнего тома.",
        );
      }
      return result;
    }

    const entries =
      kind === "rar"
        ? await readers.readRarVolumeEntries(volumes)
        : await readers.read7zVolumeEntries(volumes);
    /*
      Нулевой уровень: комплект томов — это один архив, просто разрезанный на
      части. Считать его вложенным значило бы отнять у него уровень и не
      прочитать документ, который в одиночном архиве прочитался бы.
    */
    return await readArchive(entries, budgetChars, 0, ctx);
  } catch (err) {
    if (err instanceof ArchiveRefusedError) return unsupported(err.message);
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Файл на диске в текст.
 *
 * Для крупных файлов, которые загрузчик не стал держать в памяти: архив от
 * ~100 МБ распаковывается программой 7z или unrar в mkdtemp-каталог, а входы
 * читаются по одному. Файл, который распаковать нечем или который не архив,
 * поднимается в память и идёт обычным путём. Файл по пути не удаляется:
 * им владеет вызывающий код.
 */
export async function parseAttachmentFile(
  path: string,
  filename: string,
  contentType: string | null,
  budgetChars: number,
  options?: ParseOptions,
): Promise<ParsedAttachment> {
  if (budgetChars <= 0) {
    return {
      text: "",
      status: "empty",
      reason: "Бюджет знаков исчерпан.",
      truncated: false,
    };
  }
  const ctx = newContext(options);
  try {
    const info = await stat(path);
    if (info.size < LARGE_ARCHIVE_BYTES) {
      return await parseBytes(
        new Uint8Array(await readFile(path)),
        filename,
        contentType,
        budgetChars,
        0,
        ctx,
      );
    }
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  return await parseDiskPath(path, filename, budgetChars, 0, ctx);
}

/**
 * Комплект томов, лежащих на диске в одном каталоге под своими именами.
 *
 * Дисковый двойник `parseArchiveVolumes`: настоящие многотомные архивы
 * («.part1.rar», «.7z.001») распаковщик собирает сам, находя продолжения рядом с
 * первым томом; побайтовая нарезка («.zip.001») склеивается потоком во
 * временный файл. Тома не копируются в память и не удаляются — их каталогом
 * владеет вызывающий код. Программ нет — отказ с понятной причиной: комплект на
 * сотни мегабайт в память не берётся.
 */
export async function parseArchiveVolumeFiles(
  volumes: readonly { name: string; path: string }[],
  budgetChars: number,
  options?: ParseOptions,
): Promise<ParsedAttachment> {
  if (budgetChars <= 0) {
    return {
      text: "",
      status: "empty",
      reason: "Бюджет знаков исчерпан.",
      truncated: false,
    };
  }

  const ctx = newContext(options);
  const sorted = [...volumes].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const first = sorted[0];
  if (!first) return unsupported("Комплект томов пуст.");

  const kind = volumeSetKind(first.name);
  if (kind === null) return unsupported(unsupportedFormatReason(first.name));

  const problem = volumeSetProblem(sorted.map((part) => part.name));
  if (problem !== null) return unsupported(problem);

  const cli = await resolveCli(ctx);
  if (cli === null) {
    return unsupported(
      "Комплект томов читается через диск, а на этом сервере нет программ 7z и unrar.",
    );
  }

  try {
    if (kind === "zip-split" || kind === "rar-split") {
      const set = volumeSetName(first.name) ?? first.name;
      const work = await makeTempDir("tenderfit-join-", cli.tmpRoot);
      try {
        const joined = join(work.dir, "joined");
        await concatFiles(
          sorted.map((part) => part.path),
          joined,
        );
        const result = await parseDiskPath(joined, set, budgetChars, 0, ctx);
        if (result.status === "failed") {
          return failed(
            `Комплект «${set}» не собрался в архив: ${result.reason ?? "ошибка чтения"}. ` +
              "Возможно, не хватает последнего тома.",
          );
        }
        return result;
      } finally {
        await work.dispose();
      }
    }

    if (kind === "7z" && !/\.7z\.0*1$/i.test(first.name)) {
      return unsupported(
        `Первого тома комплекта нет: распаковка начинается с «.7z.001», а самый ранний из полученных — «${first.name}».`,
      );
    }
    const tool = pickTool(cli, kind);
    if (tool === null) {
      return unsupported(
        `Для комплекта ${kind} на этом сервере нет подходящей программы распаковки.`,
      );
    }

    /*
      Нулевой уровень, как и у комплекта в памяти: комплект — один архив,
      разрезанный на части, и вложенным он не считается.
    */
    return await readArchiveOnDisk(first.path, tool, cli, budgetChars, 0, ctx);
  } catch (err) {
    if (err instanceof ArchiveRefusedError) return refusal(err);
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
 *
 * `options.ocr` — порт распознавания сканов; по умолчанию общий движок процесса,
 * который сам определяет, есть ли на машине Tesseract.
 */
export async function parseAttachment(
  bytes: Uint8Array,
  filename: string,
  contentType: string | null,
  budgetChars: number,
  options?: ParseOptions,
): Promise<ParsedAttachment> {
  return parseBytes(
    bytes,
    filename,
    contentType,
    budgetChars,
    0,
    newContext(options),
  );
}
