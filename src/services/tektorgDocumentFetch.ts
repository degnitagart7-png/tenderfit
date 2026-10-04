/**
 * Документация закупки с электронной площадки ТЭК-Торг.
 *
 * Зачем отдельный модуль, если ЕИС отдаёт документы бесплатно: часть процедур
 * площадки размещена только на ней и в реестр не попадает вовсе. За сутки
 * 01.10.2026 в секции «223-ФЗ и Коммерческие закупки» опубликовано 75 процедур,
 * из них 49 несут номер извещения ЕИС — значит, 26 записей не приходят ни из
 * одного другого источника, и документацию к ним отдаёт только площадка.
 *
 * Чем этот путь отличается от карточки Контур.Закупок:
 *
 * 1. **Он бесплатный.** SOAP-экспорт процедур не требует ключа, а адреса байт
 *    приходят в том же ответе (`open-api/documents/procedure/{id}`). Платный
 *    бюджет дня не расходуется, поэтому обход можно запускать на всю очередь, а
 *    не по явному флагу.
 *
 * 2. **Номер площадки в ЕИС не публикуется.** Закупка, сохранённая под номером
 *    «TEKTORG-ЗП610102», не найдётся ни в реестре, ни во вкладке документов —
 *    искать её там бесполезно. Отсюда порядок: сначала бесплатный обход ЕИС
 *    (`tenderDocumentSync`), и только если он не дал текста — площадка.
 *
 * 3. **Площадка сообщает об отзыве документа.** Вместо адреса байт экспорт
 *    присылает `<removed>true</removed>`. ЕИС такого сигнала не даёт, и терять
 *    его нельзя: файл записывается строкой с причиной, и партнёр видит, что
 *    заказчик снял документ с публикации, а не «документации нет».
 *
 * Сети и хранилища здесь нет — они приходят портами, поэтому модуль проверяется
 * без ТЭК-Торга и без Supabase. Скачивание обязательно из России: адреса байт
 * ведут на api.tektorg.ru, а воркер анализа живёт на Vercel за рубежом, поэтому
 * файлы тянет локальный скрипт или воркер на VPS.
 */
import { attachmentDocumentType } from "@/services/eisAttachments";
import { uniqueFilenames } from "@/services/attachmentFilenames";
import { computeContentHash } from "@/services/documentParser";
import {
  detectFileType,
  isVolumeName,
  unsupportedFormatReason,
  volumeSetReason,
} from "@/services/fileFormats";
import {
  MAX_TOTAL_CHARS_PER_TENDER,
  readAttachmentFile,
  type AttachmentFetchDeps,
  type AttachmentRef,
} from "@/services/tenderAttachmentsFetcher";
import {
  occupiedChars,
  type PreparedDocument,
  type TenderDocumentStore,
} from "@/services/tenderDocumentSync";
import type { DocumentSkipMark } from "@/types/database";

/**
 * Документ процедуры, каким его перечислил экспорт.
 *
 * Полей намеренно меньше, чем у `TektorgDocument` в адаптере: внутренний
 * идентификатор документа загрузчику не нужен, а структурная типизация
 * позволяет передать сюда список адаптера как есть. Так `services/` не
 * импортирует `adapters/` и слоистость не нарушается.
 */
export interface TektorgPlatformDocument {
  readonly filename: string;
  /** Адрес байт; null — документ снят с публикации или адреса у него нет. */
  readonly url: string | null;
  /** Площадка прислала `<removed>` вместо `<file>`: файл отозван заказчиком. */
  readonly removed: boolean;
}

/** Читатель экспорта. Реализация — tektorgTenderSourceAdapter.readDocumentList. */
export interface TektorgDocumentReader {
  readDocuments(tenderId: string): Promise<readonly TektorgPlatformDocument[]>;
}

export interface TektorgDocumentDeps extends AttachmentFetchDeps {
  reader: TektorgDocumentReader;
  store: TenderDocumentStore;
}

export interface TektorgDocumentOptions {
  /** Перезаписать документы, даже если имя уже есть в базе. */
  force?: boolean;
  /** Предел знаков на закупку; в бою — MAX_TOTAL_CHARS_PER_TENDER. */
  budgetChars?: number;
}

export type TektorgDocumentOutcome =
  | {
      status: "saved";
      regNumber: string;
      filenames: string[];
      characters: number;
      /** Сколько документов не дошло до разбора: причины уже лежат в базе. */
      skipped: number;
      /** Сколько из пропущенных отозваны площадкой — сигнал, которого ЕИС не даёт. */
      withdrawn: number;
    }
  | { status: "already"; regNumber: string; filenames: string[] }
  /** Площадка перечислила файлы, но текста нет ни в одном. */
  | { status: "no_text"; regNumber: string; filenames: string[]; reason: string }
  | { status: "empty"; regNumber: string; reason: string }
  | { status: "failed"; regNumber: string; reason: string };

/**
 * Причина для документа, снятого с публикации.
 *
 * Имя файла в тексте обязательно: в карточке закупки строка пропуска показана
 * отдельно от имени, и «документ отозван» без названия партнёр не сопоставит
 * ни с чем. Код пропуска при этом `download_failed` — ближайший по смыслу из
 * существующих: байты действительно не получены. Отдельного кода для отзыва в
 * `SkippedCode` нет, и добавлять его ради одной площадки значило бы править ещё
 * и показ причин в UI.
 */
export function tektorgWithdrawnReason(filename: string): string {
  return (
    `Документ «${filename}» снят с публикации на площадке ТЭК-Торг: вместо адреса ` +
    "файла экспорт прислал отметку об отзыве. Скачать его нельзя, а прежний текст " +
    "в базе, если он был загружен, считать действующим не следует."
  );
}

/** Причина для документа, у которого адреса байт нет, но и отзыва тоже. */
function tektorgLinklessReason(filename: string): string {
  return (
    `ТЭК-Торг перечислил документ «${filename}» без адреса: байты негде взять.`
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Строка документа, который не скачивался: имя и причина, текста нет.
 * Ей же пишется пропуск по формату и по бюджету — разница только в причине.
 */
function linklessRow(
  filename: string,
  document: TektorgPlatformDocument,
  skipped: DocumentSkipMark,
): PreparedDocument {
  return {
    filename,
    title: document.filename,
    documentType: attachmentDocumentType(document.filename),
    sourceType: "tektorg_api",
    fileUrl: document.url,
    mimeType: "application/octet-stream",
    text: "",
    chars: 0,
    fileSize: null,
    truncated: false,
    archive: null,
    skipped,
    contentHash: null,
  };
}

/**
 * Обеспечивает закупку документацией с площадки ТЭК-Торг.
 *
 * Вызов бесплатный, но не даром: каждая закупка — это запрос SOAP-экспорта и
 * скачивание всех её файлов, а у прогона есть жёсткий бюджет времени
 * (`FETCH_BUDGET_MS`). Поэтому вызывать нужно для закупки, которая уже стоит в
 * очереди анализа, и только когда ЕИС документацию не отдала.
 */
export async function fetchTektorgPlatformDocuments(
  regNumber: string,
  externalId: string,
  deps: TektorgDocumentDeps,
  options: TektorgDocumentOptions = {},
): Promise<TektorgDocumentOutcome> {
  let platformDocuments: readonly TektorgPlatformDocument[];
  try {
    platformDocuments = await deps.reader.readDocuments(externalId);
  } catch (err) {
    return {
      status: "failed",
      regNumber,
      reason: `Экспорт ТЭК-Торга не прочитался: ${message(err)}`,
    };
  }

  if (platformDocuments.length === 0) {
    return {
      status: "empty",
      regNumber,
      reason:
        `ТЭК-Торг не перечислил ни одного документа по номеру площадки ${externalId}: ` +
        "либо у процедуры нет файлов, либо экспорт не нашёл её по этому номеру.",
    };
  }

  const stored = await deps.store.list(regNumber);
  const known = new Set(stored.map((record) => record.filename));
  const budget = Math.max(0, options.budgetChars ?? MAX_TOTAL_CHARS_PER_TENDER);
  let used = options.force ? 0 : stored.reduce((sum, record) => sum + occupiedChars(record), 0);

  const filenames = uniqueFilenames(platformDocuments.map((document) => document.filename));
  const prepared: PreparedDocument[] = [];
  /** Сколько строк записано из-за отзыва или отсутствия адреса: байт у них нет. */
  let linkless = 0;

  for (const [index, document] of platformDocuments.entries()) {
    const filename = filenames[index] ?? document.filename;
    if (!options.force && known.has(filename)) continue;

    /*
      Отзыв важнее адреса: документ без `<removed>`, но и без `<file>` — это
      сбой экспорта, а отозванный файл — осмысленное действие заказчика. Причины
      разные, и по ним оператор отличает «заказчик передумал» от «площадка
      ответила неполно».
    */
    if (document.removed || document.url === null) {
      linkless += 1;
      prepared.push(
        linklessRow(
          filename,
          document,
          document.removed
            ? { code: "download_failed", reason: tektorgWithdrawnReason(document.filename) }
            : { code: "download_failed", reason: tektorgLinklessReason(document.filename) },
        ),
      );
      continue;
    }

    /*
      Формат проверяется до скачивания. Тома идут отдельной причиной: одиночные
      rar и 7z проект читает, а том комплекта — нет, и тянуть сотни мегабайт,
      чтобы это подтвердить, незачем. Имена в экспорте транслитерированы, но
      расширение площадка сохраняет, поэтому проверки по имени достаточно.
    */
    if (isVolumeName(filename)) {
      prepared.push(
        linklessRow(filename, document, {
          code: "unsupported_format",
          reason: volumeSetReason(filename),
        }),
      );
      continue;
    }

    if (detectFileType(null, filename) === "unsupported") {
      prepared.push(
        linklessRow(filename, document, {
          code: "unsupported_format",
          reason: unsupportedFormatReason(filename),
        }),
      );
      continue;
    }

    const remaining = budget - used;
    if (remaining <= 0) {
      const reason = `Не влез в бюджет ${budget.toLocaleString("ru-RU")} знаков на закупку.`;
      prepared.push(linklessRow(filename, document, { code: "over_char_budget", reason }));
      continue;
    }

    const ref: AttachmentRef = {
      filename,
      name: document.filename,
      documentType: attachmentDocumentType(document.filename),
      url: document.url,
      sourceType: "tektorg_api",
    };
    const row = await readAttachmentFile(ref, deps, remaining);
    prepared.push({
      ...row,
      contentHash: row.skipped === null ? computeContentHash(row.text) : null,
    });
    used += row.chars;
  }

  if (prepared.length === 0) {
    const parsed = stored
      .filter((record) => record.parsedStatus === "parsed")
      .map((record) => record.filename);
    if (parsed.length > 0) return { status: "already", regNumber, filenames: parsed };
    return {
      status: "empty",
      regNumber,
      reason: "Документы площадки уже в базе, но текста нет ни в одном из них.",
    };
  }

  const savedFilenames: string[] = [];
  let characters = 0;
  let skipped = 0;

  for (const document of prepared) {
    try {
      await deps.store.save(regNumber, document);
    } catch (err) {
      // Ошибка записи почти всегда системная: ограничение, соединение, квота.
      // Продолжить значит получить её же ещё полсотни раз, поэтому выходим,
      // сохранив то, что успели.
      return {
        status: "failed",
        regNumber,
        reason: `Не удалось сохранить ${document.filename}: ${message(err)}`,
      };
    }
    savedFilenames.push(document.filename);
    if (document.skipped === null) characters += document.chars;
    else skipped += 1;
  }

  // Ни одного файла с текстом. Это не сбой и не «документация загружена»: статус
  // отдельный, чтобы журнал не выдавал перечисленные имена за разобранные
  // документы. Причина берётся из первой записанной строки — по ней оператор
  // видит, что именно помешало: отзыв, том rar, неподдерживаемый формат или
  // отсутствие текстового слоя.
  if (characters === 0) {
    const firstSkip = prepared.find((document) => document.skipped !== null)?.skipped;
    return {
      status: "no_text",
      regNumber,
      filenames: savedFilenames,
      reason: firstSkip?.reason ?? "Текста нет ни в одном файле площадки.",
    };
  }

  return {
    status: "saved",
    regNumber,
    filenames: savedFilenames,
    characters,
    skipped,
    withdrawn: linkless,
  };
}
