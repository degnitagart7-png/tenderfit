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
} from "@/services/fileFormats";
import {
  eis223CardUrl,
  type FetchedTenderDocument,
  type FetchHtml,
  type StoredDocumentType,
  type StoredSourceType,
} from "@/services/tenderDocumentsFetcher";
import type { DocumentSkipMark, SkippedCode } from "@/types/database";

/**
 * Обход вкладки документов ЕИС: какие файлы скачать, в каком порядке и когда
 * остановиться.
 *
 * Сети и парсеров здесь нет — они приходят портами, поэтому обход проверяется
 * на фикстурах без ЕИС. Модуль серверный: вызывается из локального скрипта,
 * потому что ЕИС не пускает зарубежные IP, а Vercel стоит именно там.
 *
 * Порядок обхода задаёт planAttachments: проект контракта, затем описание
 * объекта закупки и техзадание, затем прочее в порядке страницы. Как только
 * бюджет знаков закупки заполнен, остальные файлы не скачиваются вовсе, но
 * каждый получает строку с причиной — партнёр видит в карточке, чего не хватает.
 */

/** Сколько знаков текста приходится на одну закупку вместе с извещением. */
export const MAX_TOTAL_CHARS_PER_TENDER = 1_000_000;

/**
 * Предел объёма одного файла — 50 МБ.
 *
 * Предел нужен не для экономии трафика, а чтобы многотомная проектная
 * документация не прочиталась целиком в память процесса.
 *
 * 20 МБ оказалось мало: на закупке 32616373657 самый ценный файл,
 * «Закупочная документация.zip» на 28,1 МБ, не читался вовсе — а внутри него
 * проект контракта и описание объекта закупки, ради которых разбор и затевался.
 * Владелец проекта задал 50 МБ 2026-09-22; менять число только здесь, причину
 * пропуска tooLargeReason печатает из этой же константы.
 */
export const MAX_FILE_BYTES = 50_000_000;

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
  /** Порт остановил чтение: файл больше MAX_FILE_BYTES. */
  tooLarge?: boolean;
}

/** Загрузка байтов файла. Реализация — в scripts/fetch-tender-documents.ts. */
export type FetchFile = (url: string) => Promise<FetchedFile>;

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
  archive: { parsed: number; total: number } | null;
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
 * Предел на комплект томов — 300 МБ суммарно.
 *
 * Отдельный от предела на файл (50 МБ): комплект по определению больше одного
 * тома, и применять к нему файловый предел значило бы не читать ни одного
 * многотомного архива вовсе. Значение задал владелец проекта 27.09.2026.
 *
 * Считается по факту загрузки, а не по заявленному размеру: источник размер
 * тома в списке не сообщает.
 */
export const MAX_VOLUME_SET_BYTES = 300_000_000;

function volumeSetTooLargeReason(size: number): string {
  return (
    `Комплект томов объёмом ${(size / 1_000_000).toFixed(1)} МБ больше предела ` +
    `${MAX_VOLUME_SET_BYTES / 1_000_000} МБ и не читается.`
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function overBudgetReason(budget: number): string {
  return (
    `Не влез в бюджет ${budget.toLocaleString("ru-RU")} знаков на закупку. ` +
    "Сначала читаются проект контракта и описание объекта закупки — этот файл оказался дальше по списку."
  );
}

function tooLargeReason(size: number): string {
  const limit = `${MAX_FILE_BYTES / 1_000_000} МБ`;
  return size > 0
    ? `Файл объёмом ${(size / 1_000_000).toFixed(1)} МБ больше предела ${limit} и не читается.`
    : `Файл больше предела ${limit} и не читается.`;
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
  let file: FetchedFile;
  try {
    file = await deps.fetchFile(item.url);
  } catch (err) {
    return skippedRow(
      item,
      "download_failed",
      `Источник не отдал файл: ${message(err)}`,
    );
  }

  const fileSize =
    file.bytes.byteLength > 0
      ? file.bytes.byteLength
      : (file.contentLength ?? 0);
  const mimeType = file.contentType ?? "application/octet-stream";

  if (file.tooLarge === true || file.bytes.byteLength > MAX_FILE_BYTES) {
    return skippedRow(
      item,
      "file_too_large",
      tooLargeReason(fileSize),
      fileSize,
      mimeType,
    );
  }

  let parsed: ParsedAttachment;
  try {
    parsed = await deps.parse(file.bytes, item.filename, mimeType, budgetChars);
  } catch (err) {
    return skippedRow(item, "parse_failed", message(err), fileSize, mimeType);
  }

  switch (parsed.status) {
    case "parsed":
      return {
        ...baseRow(item, fileSize, mimeType),
        text: parsed.text,
        chars: parsed.text.length,
        truncated: parsed.truncated,
        archive: parsed.archive ?? null,
      };
    case "unsupported":
      return skippedRow(
        item,
        "unsupported_format",
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
 * Скачивает все тома комплекта и разбирает их как один архив.
 *
 * Строка с текстом достаётся первому тому: он и есть архив с точки зрения
 * распаковщика. Остальные тома получают строку с пометкой `volume_of_set` —
 * не ошибка, а запись о том, что файл учтён. Без неё следующий прогон скачал бы
 * сотни мегабайт заново, а партнёр не увидел бы во вкладке файлы, которые
 * заказчик выложил.
 */
async function readVolumeSet(
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

  if (deps.parseVolumes === undefined) {
    return ordered.map((item) =>
      skippedRow(
        item,
        "unsupported_format",
        "Это том многотомного архива: чтения комплектом здесь нет.",
      ),
    );
  }

  const parts: { name: string; bytes: Uint8Array }[] = [];
  let total = 0;

  for (const item of ordered) {
    let file: FetchedFile;
    try {
      file = await deps.fetchFile(item.url);
    } catch (err) {
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

    total += file.bytes.byteLength;
    if (file.tooLarge === true || total > MAX_VOLUME_SET_BYTES) {
      return ordered.map((row) =>
        skippedRow(row, "file_too_large", volumeSetTooLargeReason(total)),
      );
    }
    parts.push({ name: item.filename, bytes: file.bytes });
  }

  let parsed: ParsedAttachment;
  try {
    parsed = await deps.parseVolumes(parts, budgetChars);
  } catch (err) {
    return ordered.map((row) =>
      skippedRow(row, "parse_failed", message(err), total),
    );
  }

  const firstSize = parts[0]?.bytes.byteLength ?? 0;
  const tail = rest.map((item, index) =>
    partOfSet(item, parts[index + 1]?.bytes.byteLength ?? 0),
  );

  if (parsed.status === "parsed") {
    return [
      {
        ...baseRow(first, firstSize, "application/octet-stream"),
        text: parsed.text,
        chars: parsed.text.length,
        truncated: parsed.truncated,
        archive: parsed.archive ?? null,
      },
      ...tail,
    ];
  }

  const code =
    parsed.status === "unsupported"
      ? "unsupported_format"
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
