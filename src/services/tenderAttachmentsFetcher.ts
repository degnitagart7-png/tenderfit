import { isEisBlockedError } from "@/lib/eisGate";
import type { ParsedAttachment } from "@/services/attachmentParser";
import {
  eis223DocumentsTabUrl,
  eisDocumentsTabUrl,
  extractAttachmentLinks,
  extractNoticeGuid,
  planAttachments,
  type DocumentsTabTarget,
  type PlannedAttachment,
} from "@/services/eisAttachments";
import {
  detectFileType,
  isVolumeName,
  unsupportedFormatReason,
  volumeSetName,
  volumeSetProblem,
} from "@/services/fileFormats";
import {
  eis223CardUrl,
  type FetchedTenderDocument,
  type FetchHtml,
  type StoredDocumentType,
  type StoredSourceType,
} from "@/services/tenderDocumentsFetcher";
import type {
  ArchiveReport,
  DocumentSkipMark,
  SkippedCode,
} from "@/types/database";

/**
 * Обход вкладки документов ЕИС: какие файлы скачать, в каком порядке и когда
 * остановиться.
 *
 * Сети и парсеров здесь нет — они приходят портами, поэтому обход проверяется
 * на фикстурах без ЕИС. Модуль серверный: вызывается из локального скрипта,
 * потому что ЕИС не пускает зарубежные IP, а Vercel стоит именно там.
 *
 * Порядок обхода задаёт planAttachments: проект контракта, затем описание
 * объекта закупки и техзадание, затем прочее в порядке страницы. Бюджета знаков
 * по умолчанию нет (см. MAX_TOTAL_CHARS_PER_TENDER); если его включили для
 * аварии и он заполнен, остальные файлы не скачиваются вовсе, но каждый
 * получает строку с причиной — партнёр видит в карточке, чего не хватает.
 */

/**
 * Бюджет знаков текста на одну закупку вместе с извещением.
 *
 * С 2026-10-08 по умолчанию предела нет (Infinity): владелец проекта хочет, чтобы
 * глубокий анализ читал всю документацию без пропусков. Прежний предел —
 * миллион знаков — оставил 65 файлов в базе с причиной «Не влез в бюджет …».
 * На случай аварии (модель дорожает, вход слишком большой) предел включается
 * переменной окружения TENDERFIT_MAX_CHARS_PER_TENDER=<число знаков>; пусто, 0
 * или не число — без предела. Порядок чтения по приоритету (проект контракта,
 * затем описание объекта закупки и техзадание, затем прочее) от этого не меняется.
 */
export function resolveMaxCharsPerTender(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["TENDERFIT_MAX_CHARS_PER_TENDER"]?.trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const value = Number(raw.replace(/[\s_]/g, ""));
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : Number.POSITIVE_INFINITY;
}

export const MAX_TOTAL_CHARS_PER_TENDER = resolveMaxCharsPerTender();

/**
 * Предел объёма одного файла — 300 МБ.
 *
 * Безопасен он только потому, что крупный файл в память не читается: загрузчик
 * пишет всё, что больше SPOOL_ABOVE_BYTES, на диск, а архив распаковывают
 * программы 7z и unrar в каталог mkdtemp (archiveCli.ts). На сервере 4 ГБ ОЗУ.
 *
 * История: 20 МБ оказалось мало (закупка 32616373657: «Закупочная
 * документация.zip» на 28,1 МБ не читалась, а внутри проект контракта), потом
 * 50 МБ (22.09.2026), с 2026-10-08 — 300 МБ по решению владельца проекта. Менять
 * число только здесь, причину пропуска tooLargeReason печатает из этой же константы.
 */
export const MAX_FILE_BYTES = 300_000_000;

/**
 * Прежний предел файла — 50 МБ — остаётся пределом для машины, где нет 7z и
 * unrar: без дисковой распаковки файл приходится держать в памяти целиком.
 */
export const MAX_FILE_BYTES_IN_MEMORY = 50_000_000;

/** С какого объёма скачиваемый файл пишется на диск, а не копится в памяти. */
export const SPOOL_ABOVE_BYTES = 100_000_000;

/**
 * Почему файл не попал в разбор.
 *
 * Набор значений объявлен в @/types/database, потому что код уходит в
 * tender_documents.raw_json.skipped.code и читается интерфейсом: так один и тот
 * же тип видят обход вложений, репозиторий и карточка закупки.
 */
export type { SkippedCode };

/** Причина пропуска: код для интерфейса и текст, который увидит партнёр. */
export type SkippedAttachment = DocumentSkipMark;

/** Скачанный файл. Порт сам решает, читать ли его целиком. */
export interface FetchedFile {
  bytes: Uint8Array;
  contentType: string | null;
  /** Заявленный объём — заполняется, когда порт не стал читать файл до конца. */
  contentLength?: number;
  /** Порт остановил чтение: файл больше предела. */
  tooLarge?: boolean;
  /**
   * Файл записан на диск по этому пути, `bytes` пуст. Бывает, только если
   * вызывающий код передал `spool`. Каталогом владеет вызывающий код.
   */
  path?: string;
  /** Фактический объём файла в байтах; обязателен, когда файл на диске. */
  size?: number;
}

/** Параметры загрузки одного файла. */
export interface FetchFileOptions {
  /**
   * Предел объёма этого файла в байтах; по умолчанию MAX_FILE_BYTES_IN_MEMORY
   * (50 МБ).
   *
   * Нужен комплектам томов: том многотомного архива вполне весит больше
   * 50 МБ, а предел для комплекта целиком — MAX_VOLUME_SET_BYTES. Без
   * параметра порт обрывал такой том как «слишком большой файл» и отдавал
   * ноль байт, а комплект отказывался с «объёмом 0.0 МБ больше предела».
   */
  maxBytes?: number;
  /**
   * Писать тело на диск: файл `dir/name`. Всё, что больше `above` байт, уходит
   * на диск (0 — всегда), меньшее остаётся в памяти. Тогда в ответе `path` и
   * `size`, а `bytes` пуст. Каталог создаёт и убирает вызывающий код.
   */
  spool?: { dir: string; name: string; above: number };
}

/** Загрузка байтов файла. Реализация — в scripts/fetch-tender-documents.ts. */
export type FetchFile = (
  url: string,
  options?: FetchFileOptions,
) => Promise<FetchedFile>;

/** Разбор байтов в текст. Реализация — parseAttachment из attachmentParser.ts. */
export type ParseAttachment = (
  bytes: Uint8Array,
  filename: string,
  contentType: string | null,
  budgetChars: number,
) => Promise<ParsedAttachment>;

export interface AttachmentFetchDeps {
  fetchHtml: FetchHtml;
  fetchFile: FetchFile;
  parse: ParseAttachment;
  /**
   * Разбор комплекта томов: несколько именованных частей одного архива.
   *
   * Отдельно от `parse`, потому что вход другой — не байты одного файла.
   * Необязателен: вызывающий код, который комплекты не читает, передаёт только
   * `parse`, и тогда тома помечаются как нечитаемые.
   */
  parseVolumes?: ParseArchiveVolumes;
  /**
   * Дисковый путь для крупных файлов и комплектов: временные файлы и программы
   * 7z и unrar. Не задан — всё в памяти с прежними пределами (50 МБ на файл и
   * 300 МБ на комплект).
   */
  disk?: AttachmentDiskDeps;
}

/** Временный каталог под одну работу; dispose() убирает его целиком. */
export interface DiskTempDir {
  dir: string;
  dispose(): Promise<void>;
}

/** Порты дискового пути. Реализация — createAttachmentDisk в diskAttachments.ts. */
export interface AttachmentDiskDeps {
  /** Есть ли на машине программы распаковки. false — работаем в памяти. */
  available(): Promise<boolean>;
  makeDir(): Promise<DiskTempDir>;
  parseFile(
    path: string,
    filename: string,
    contentType: string | null,
    budgetChars: number,
  ): Promise<ParsedAttachment>;
  parseVolumeFiles(
    volumes: readonly { name: string; path: string }[],
    budgetChars: number,
  ): Promise<ParsedAttachment>;
}

export type ParseArchiveVolumes = (
  volumes: readonly { name: string; bytes: Uint8Array }[],
  budgetChars: number,
) => Promise<ParsedAttachment>;

export interface AttachmentFetchOptions {
  /** Сколько знаков осталось в бюджете закупки: извещение учтено вызывающим кодом. */
  budgetChars: number;
  /** Имена, которые уже лежат в базе. Такие файлы не скачиваются и в результат не попадают. */
  knownFilenames?: ReadonlySet<string>;
}

/** Вложение, готовое к записи в tender_documents — с текстом или с причиной пропуска. */
export interface FetchedAttachment extends FetchedTenderDocument {
  /** Знаков текста; у пропущенных файлов ноль. */
  chars: number;
  /** Объём файла в байтах; у пропущенных — заявленный, если он известен. */
  fileSize: number;
  /** Текст обрезан по бюджету: целиком файл в лимит не влез. */
  truncated: boolean;
  /** Для архива: прочитано входов из скольких. null — файл не архив. */
  archive: ArchiveReport | null;
  /**
   * Текст распознан со скана: сколько страниц распознано из скольких.
   * null — текст прочитан из файла, а не распознан.
   */
  ocr?: { pages: number; totalPages: number } | null;
  /** Почему текста нет; null — документ разобран. */
  skipped: SkippedAttachment | null;
}

export interface TenderAttachmentsResult {
  attachments: FetchedAttachment[];
  /** Знаков заняли вложения. Извещение сюда не входит. */
  chars: number;
  /** Адрес прочитанной вкладки документов; null, если до неё не дошли. */
  documentsTabUrl: string | null;
  /** Почему вложения не получить вовсе: вкладка недоступна, в карточке нет GUID. */
  reason: string | null;
}

/**
 * Предел на комплект томов — 2 ГБ суммарно.
 *
 * Отдельный от предела на файл: комплект по определению больше одного тома, и
 * применять к нему файловый предел значило бы не читать ни одного многотомного
 * архива вовсе. Было 300 МБ (27.09.2026, в базе лежит комплект на 308 МБ, и он не
 * читался), с 2026-10-08 — 2 ГБ по решению владельца. Тома пишутся на диск по
 * мере скачивания и склеиваются там же, в памяти комплект не собирается.
 *
 * Считается по факту загрузки, а не по заявленному размеру: источник размер
 * тома в списке не сообщает.
 */
export const MAX_VOLUME_SET_BYTES = 2_000_000_000;

/** Прежние 300 МБ — предел комплекта на машине без 7z и unrar, где тома собираются в памяти. */
export const MAX_VOLUME_SET_BYTES_IN_MEMORY = 300_000_000;

/** Почему комплект не читается: предел объёма, а на машине без программ — их отсутствие. */
function volumeSetTooLargeReason(size: number, limit: number, noCli: boolean): string {
  // Размер неизвестен (порт оборвал чтение, не назвав объём): число не пишем,
  // а не показываем «0.0 МБ» там, где файл на самом деле больше предела.
  const of = size > 0 ? ` объёмом ${(size / 1_000_000).toFixed(1)} МБ` : "";
  return (
    `Комплект томов${of} больше предела ` +
    `${limit / 1_000_000} МБ и не читается.` +
    (noCli ? NO_CLI_NOTE : "")
  );
}

/**
 * Подстрока причины, записанной на машине без распаковщиков: по ней повторный
 * разбор знает, что на такой машине отказ по объёму не лечится.
 */
export const NO_ARCHIVE_CLI_FRAGMENT = "нет программ 7z и unrar";

/** Приписка к причине на машине без распаковщиков: объясняет, почему предел прежний. */
const NO_CLI_NOTE = ` На сервере ${NO_ARCHIVE_CLI_FRAGMENT}, поэтому крупные файлы читаются только в памяти.`;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function overBudgetReason(budget: number): string {
  return (
    `Не влез в бюджет ${budget.toLocaleString("ru-RU")} знаков на закупку. ` +
    "Сначала читаются проект контракта и описание объекта закупки — этот файл оказался дальше по списку."
  );
}

function tooLargeReason(size: number, limitBytes: number, noCli: boolean): string {
  const limit = `${limitBytes / 1_000_000} МБ`;
  const base =
    size > 0
      ? `Файл объёмом ${(size / 1_000_000).toFixed(1)} МБ больше предела ${limit} и не читается.`
      : `Файл больше предела ${limit} и не читается.`;
  return noCli ? base + NO_CLI_NOTE : base;
}

/** Дисковый путь, если он есть и на машине стоят программы распаковки. */
async function usableDisk(
  deps: AttachmentFetchDeps,
): Promise<AttachmentDiskDeps | null> {
  if (!deps.disk) return null;
  try {
    return (await deps.disk.available()) ? deps.disk : null;
  } catch {
    return null;
  }
}

/**
 * Что нужно знать о файле, чтобы скачать его и разобрать.
 *
 * Вложение вкладки документов ЕИС и документ из карточки Контур.Закупок
 * описываются одним набором полей, поэтому обход файла общий: различаются только
 * происхождением (`sourceType`) и тем, кто нашёл ссылку.
 */
export interface AttachmentRef {
  /** Имя для tender_documents — уникально в пределах закупки. */
  filename: string;
  /** Название файла, каким его показал источник. */
  name: string;
  documentType: StoredDocumentType;
  url: string;
  /** Происхождение строки; по умолчанию — вкладка документов ЕИС. */
  sourceType?: StoredSourceType;
}

/**
 * План вкладки документов обязан подходить под AttachmentRef: обход ЕИС
 * передаёт его в readAttachmentFile как есть. Утверждение проверено
 * компилятором, а не комментарием, — иначе новое поле в плане молча
 * потерялось бы при скачивании.
 */
type PlannedAttachmentIsRef = PlannedAttachment extends AttachmentRef
  ? true
  : never;
const _plannedAttachmentIsRef: PlannedAttachmentIsRef = true;
void _plannedAttachmentIsRef;

function baseRow(
  item: AttachmentRef,
  fileSize: number,
  mimeType: string,
): FetchedAttachment {
  return {
    filename: item.filename,
    title: item.name,
    documentType: item.documentType,
    sourceType: item.sourceType ?? "eis_api",
    fileUrl: item.url,
    mimeType,
    text: "",
    chars: 0,
    fileSize,
    truncated: false,
    archive: null,
    ocr: null,
    skipped: null,
  };
}

function skippedRow(
  item: AttachmentRef,
  code: SkippedCode,
  reason: string,
  fileSize = 0,
  mimeType = "application/octet-stream",
): FetchedAttachment {
  return { ...baseRow(item, fileSize, mimeType), skipped: { code, reason } };
}

/** Адрес вкладки документов: готовый для 44-ФЗ, для 223-ФЗ — через карточку. */
type TabResolution = { url: string } | { reason: string };

/**
 * Вкладка документов 223-ФЗ без `noticeGuid` отдаёт 404, а GUID лежит только в
 * карточке закупки. Отсюда второй запрос — он стоит ~130 КБ и делается один раз.
 */
async function resolveDocumentsTab(
  target: DocumentsTabTarget,
  fetchHtml: FetchHtml,
): Promise<TabResolution> {
  const direct = eisDocumentsTabUrl(target);
  if (direct) return { url: direct };

  if (target.law !== "FZ_223") {
    return {
      reason: `ЕИС не публикует вкладку документов для закона ${target.law}.`,
    };
  }

  const cardUrl = eis223CardUrl(target.regNumber);
  let html: string;
  try {
    html = await fetchHtml(cardUrl);
  } catch (err) {
    if (isEisBlockedError(err)) throw err;
    return {
      reason: `Не удалось загрузить карточку закупки ${cardUrl}: ${message(err)}`,
    };
  }

  const noticeGuid = extractNoticeGuid(html);
  if (!noticeGuid) {
    return {
      reason: `В карточке ${cardUrl} нет noticeGuid — без него вкладка документов 223-ФЗ недоступна.`,
    };
  }

  return { url: eis223DocumentsTabUrl(target.regNumber, noticeGuid) };
}

/**
 * Один файл: скачать, разобрать, описать причину, если текста нет.
 *
 * Ошибки не бросаются наружу. Одна битая ссылка не должна лишать закупку
 * остальных пятидесяти документов, а партнёру важнее видеть причину по каждому
 * файлу, чем общий сбой загрузки.
 *
 * Функция общая для вкладки документов ЕИС и для файлов из карточки
 * Контур.Закупок: и там и там ссылка ведёт в filestore zakupki.gov.ru, а
 * происхождение строки задаёт `item.sourceType`.
 */
export async function readAttachmentFile(
  item: AttachmentRef,
  deps: AttachmentFetchDeps,
  budgetChars: number,
): Promise<FetchedAttachment> {
  const disk = await usableDisk(deps);
  // Дисковый путь: крупное тело пишется во временный файл, и каталог убирается
  // в finally при любом исходе. Без него — прежний путь в памяти, предел 50 МБ.
  let spool: DiskTempDir | null = null;
  try {
    let file: FetchedFile;
    try {
      if (disk) {
        spool = await disk.makeDir();
        file = await deps.fetchFile(item.url, {
          maxBytes: MAX_FILE_BYTES,
          spool: { dir: spool.dir, name: "file", above: SPOOL_ABOVE_BYTES },
        });
      } else {
        file = await deps.fetchFile(item.url);
      }
    } catch (err) {
      // Блокировка ЕИС — не свойство файла: строка «download_failed» в базе
      // выглядела бы как итог по документу, а закупка ушла бы в разбор по
      // неполному комплекту. Блок летит наверх, закупка остаётся в очереди.
      if (isEisBlockedError(err)) throw err;
      return skippedRow(
        item,
        "download_failed",
        `Источник не отдал файл: ${message(err)}`,
      );
    }

    const fileSize =
      file.size ??
      (file.bytes.byteLength > 0
        ? file.bytes.byteLength
        : (file.contentLength ?? 0));
    const mimeType = file.contentType ?? "application/octet-stream";
    const limit = disk ? MAX_FILE_BYTES : MAX_FILE_BYTES_IN_MEMORY;

    if (file.tooLarge === true || fileSize > limit) {
      return skippedRow(
        item,
        "file_too_large",
        tooLargeReason(fileSize, limit, disk === null && deps.disk !== undefined),
        fileSize,
        mimeType,
      );
    }

    let parsed: ParsedAttachment;
    try {
      parsed =
        file.path !== undefined && disk
          ? await disk.parseFile(file.path, item.filename, mimeType, budgetChars)
          : await deps.parse(file.bytes, item.filename, mimeType, budgetChars);
    } catch (err) {
      return skippedRow(item, "parse_failed", message(err), fileSize, mimeType);
    }

    return rowFromParsed(item, parsed, fileSize, mimeType);
  } finally {
    await spool?.dispose();
  }
}

/** Результат разбора в строку документа: с текстом или с причиной пропуска. */
function rowFromParsed(
  item: AttachmentRef,
  parsed: ParsedAttachment,
  fileSize: number,
  mimeType: string,
): FetchedAttachment {
  switch (parsed.status) {
    case "parsed":
      return {
        ...baseRow(item, fileSize, mimeType),
        text: parsed.text,
        chars: parsed.text.length,
        truncated: parsed.truncated,
        archive: parsed.archive ?? null,
        ocr: parsed.ocr ?? null,
      };
    case "unsupported":
      return skippedRow(
        item,
        parsed.code ?? "unsupported_format",
        parsed.reason ?? unsupportedFormatReason(item.filename),
        fileSize,
        mimeType,
      );
    case "empty":
      return skippedRow(
        item,
        "empty_text",
        parsed.reason ?? "Текстового слоя в файле нет.",
        fileSize,
        mimeType,
      );
    default:
      return skippedRow(
        item,
        "parse_failed",
        parsed.reason ?? "Файл не удалось разобрать.",
        fileSize,
        mimeType,
      );
  }
}

/**
 * Имя тома на диске: общее начало заменено на «volumes», расширение томов
 * сохранено. Распаковщик находит продолжения по имени первого тома, поэтому
 * номера и суффиксы обязаны остаться; а настоящие имена заказчика бывают длиннее
 * 255 байт (кириллица — два байта на знак) и содержат что угодно.
 */
function diskVolumeName(filename: string): string {
  const set = volumeSetName(filename);
  return set === null ? "volume.bin" : `volumes${filename.slice(set.length)}`;
}

/**
 * Скачивает все тома комплекта и разбирает их как один архив.
 *
 * Строка с текстом достаётся первому тому: он и есть архив с точки зрения
 * распаковщика. Остальные тома получают строку с пометкой `volume_of_set` —
 * не ошибка, а запись о том, что файл учтён. Без неё следующий прогон скачал бы
 * сотни мегабайт заново, а партнёр не увидел бы во вкладке файлы, которые
 * заказчик выложил.
 *
 * Два пути. С программами 7z и unrar (`deps.disk`) тома пишутся на диск по мере
 * скачивания, комплект распаковывается там же, предел — 2 ГБ, и память держит
 * не больше одного входа. Без программ тома собираются в памяти, и действует
 * прежний предел в 300 МБ.
 */
export async function readVolumeSet(
  items: readonly AttachmentRef[],
  deps: AttachmentFetchDeps,
  budgetChars: number,
): Promise<FetchedAttachment[]> {
  const ordered = [...items].sort((left, right) =>
    left.filename.localeCompare(right.filename),
  );
  const first = ordered[0]!;
  const rest = ordered.slice(1);

  const partOfSet = (item: AttachmentRef, size: number): FetchedAttachment =>
    skippedRow(
      item,
      "volume_of_set",
      `Том комплекта: прочитан вместе с «${first.filename}».`,
      size,
    );

  const disk = await usableDisk(deps);
  if (!disk && deps.parseVolumes === undefined) {
    return ordered.map((item) =>
      skippedRow(
        item,
        "unsupported_format",
        "Это том многотомного архива: чтения комплектом здесь нет.",
      ),
    );
  }

  // Состав комплекта видно по именам: нет тома посередине — качать остальные
  // сотни мегабайт ради отказа незачем.
  const problem = volumeSetProblem(ordered.map((item) => item.filename));
  if (problem !== null) {
    return ordered.map((item) =>
      skippedRow(item, "unsupported_format", problem),
    );
  }

  const limit = disk ? MAX_VOLUME_SET_BYTES : MAX_VOLUME_SET_BYTES_IN_MEMORY;
  const noCli = disk === null && deps.disk !== undefined;
  const parts: { name: string; bytes: Uint8Array; path?: string; size: number }[] = [];
  let total = 0;

  let spool: DiskTempDir | null = null;
  try {
    if (disk) spool = await disk.makeDir();

    for (const item of ordered) {
      let file: FetchedFile;
      try {
        // Том читается с пределом на остаток комплекта, а не с файловым: том на
        // 80 МБ — обычное дело, а предел комплекта — суммарный.
        file = await deps.fetchFile(item.url, {
          maxBytes: Math.max(0, limit - total),
          ...(spool
            ? { spool: { dir: spool.dir, name: diskVolumeName(item.filename), above: 0 } }
            : {}),
        });
      } catch (err) {
        if (isEisBlockedError(err)) throw err;
        // Комплект без одного тома не распаковывается: отказываемся целиком и
        // называем том, которого не хватило, — иначе причина выглядела бы
        // случайной.
        return ordered.map((row) =>
          skippedRow(
            row,
            "download_failed",
            `Источник не отдал том «${item.filename}», без него комплект не распаковать: ${message(err)}`,
          ),
        );
      }

      const size = file.size ?? file.bytes.byteLength;
      total += size;
      if (file.tooLarge === true || total > limit) {
        // Порт при обрыве отдаёт ноль байт и заявленный объём — он и входит в счёт.
        const known = size > 0 ? total : total + (file.contentLength ?? 0);
        return ordered.map((row) =>
          skippedRow(row, "file_too_large", volumeSetTooLargeReason(known, limit, noCli)),
        );
      }
      parts.push({
        name: item.filename,
        bytes: file.bytes,
        size,
        ...(file.path !== undefined ? { path: file.path } : {}),
      });
    }

    let parsed: ParsedAttachment;
    try {
      const onDisk = parts.every((part) => part.path !== undefined);
      parsed =
        disk && onDisk
          ? await disk.parseVolumeFiles(
              parts.map((part) => ({ name: part.name, path: part.path! })),
              budgetChars,
            )
          : await deps.parseVolumes!(
              parts.map(({ name, bytes }) => ({ name, bytes })),
              budgetChars,
            );
    } catch (err) {
      return ordered.map((row) =>
        skippedRow(row, "parse_failed", message(err), total),
      );
    }

    const firstSize = parts[0]?.size ?? 0;
    const tail = rest.map((item, index) =>
      partOfSet(item, parts[index + 1]?.size ?? 0),
    );

    if (parsed.status === "parsed") {
      return [
        {
          ...baseRow(first, firstSize, "application/octet-stream"),
          text: parsed.text,
          chars: parsed.text.length,
          truncated: parsed.truncated,
          archive: parsed.archive ?? null,
          ocr: parsed.ocr ?? null,
        },
        ...tail,
      ];
    }

    const code: SkippedCode =
      parsed.status === "unsupported"
        ? (parsed.code ?? "unsupported_format")
        : parsed.status === "empty"
          ? "empty_text"
          : "parse_failed";

    return [
      skippedRow(
        first,
        code,
        parsed.reason ?? "Комплект томов не удалось разобрать.",
        firstSize,
      ),
      ...tail,
    ];
  } finally {
    // Тома и всё, что из них склеено или распаковано, исчезают с диска при любом исходе.
    await spool?.dispose();
  }
}

/**
 * Обход вкладки документов одной закупки.
 *
 * `budgetChars` — остаток бюджета знаков после извещения и уже сохранённых
 * документов; его считает tenderDocumentSync. Файлы, чьё имя уже есть в базе,
 * пропускаются молча: повторный прогон не должен скачивать то, что уже лежит.
 */
export async function fetchTenderAttachments(
  target: DocumentsTabTarget,
  deps: AttachmentFetchDeps,
  options: AttachmentFetchOptions,
): Promise<TenderAttachmentsResult> {
  const tab = await resolveDocumentsTab(target, deps.fetchHtml);
  if ("reason" in tab) {
    return {
      attachments: [],
      chars: 0,
      documentsTabUrl: null,
      reason: tab.reason,
    };
  }

  let html: string;
  try {
    html = await deps.fetchHtml(tab.url);
  } catch (err) {
    if (isEisBlockedError(err)) throw err;
    return {
      attachments: [],
      chars: 0,
      documentsTabUrl: tab.url,
      reason: `Не удалось загрузить вкладку документов ${tab.url}: ${message(err)}`,
    };
  }

  const plan = planAttachments(extractAttachmentLinks(html));
  const known = options.knownFilenames ?? new Set<string>();
  const budget = Math.max(0, options.budgetChars);

  /*
    Тома собираются в комплекты до обхода.

    Один том сам по себе не распаковывается, поэтому единицей работы становится
    комплект: скачиваются все его части и уходят распаковщику вместе. Порядок
    обхода при этом сохраняется — комплект обрабатывается на месте своего
    первого тома, чтобы файлы во вкладке шли так же, как их выложил заказчик.
  */
  const volumeSets = new Map<string, AttachmentRef[]>();
  for (const item of plan) {
    if (known.has(item.filename)) continue;
    const set = volumeSetName(item.filename);
    if (set === null) continue;
    const bucket = volumeSets.get(set);
    if (bucket) bucket.push(item);
    else volumeSets.set(set, [item]);
  }
  const handledSets = new Set<string>();

  const attachments: FetchedAttachment[] = [];
  let used = 0;

  for (const item of plan) {
    if (known.has(item.filename)) continue;

    const setName = isVolumeName(item.filename)
      ? volumeSetName(item.filename)
      : null;
    if (setName !== null) {
      if (handledSets.has(setName)) continue;
      handledSets.add(setName);

      const remainingForSet = budget - used;
      const set = volumeSets.get(setName) ?? [item];
      if (remainingForSet <= 0) {
        for (const part of set) {
          attachments.push(
            skippedRow(part, "over_char_budget", overBudgetReason(budget)),
          );
        }
        continue;
      }

      const rows = await readVolumeSet(set, deps, remainingForSet);
      attachments.push(...rows);
      used += rows.reduce((sum, row) => sum + row.chars, 0);
      continue;
    }

    // Формат проверяется до скачивания и до бюджета: причина «формат не
    // разбирается» честнее, чем «не влез в бюджет», и не стоит трафика.
    if (detectFileType(null, item.filename) === "unsupported") {
      attachments.push(
        skippedRow(
          item,
          "unsupported_format",
          unsupportedFormatReason(item.filename),
        ),
      );
      continue;
    }

    const remaining = budget - used;
    if (remaining <= 0) {
      attachments.push(
        skippedRow(item, "over_char_budget", overBudgetReason(budget)),
      );
      continue;
    }

    const row = await readAttachmentFile(item, deps, remaining);
    attachments.push(row);
    used += row.chars;
  }

  return { attachments, chars: used, documentsTabUrl: tab.url, reason: null };
}
