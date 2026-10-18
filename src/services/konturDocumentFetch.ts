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
 * Документация закупки из карточки Контур.Закупок.
 *
 * Зачем отдельный модуль, если ЕИС отдаёт те же файлы бесплатно: Контур —
 * агрегатор, и часть его закупок размещена только на электронной площадке, а не
 * в ЕИС. Для них карточка API — единственный источник документов. Порядок
 * поэтому такой: сначала бесплатный обход ЕИС (tenderDocumentSync), и только
 * если он ничего не дал — платная карточка.
 *
 * Что отдаёт карточка: `Docs[]` содержит `FileName` и `Url`. Боевой тариф
 * (проверено 24.09.2026) отдаёт и имя, и настоящую ссылку на filestore
 * zakupki.gov.ru. Пониженный тариф закрашивает `Url` символом U+2591 — файл
 * перечислен, но скачать его нельзя. Терять имя из-за этого нельзя: партнёр
 * видит, что заказчик выложил «МТЗ.docx», и понимает, чего именно не хватает.
 * Поэтому документ без ссылки сохраняется строкой с причиной пропуска, а не
 * теряется молча.
 *
 * Сети и хранилища здесь нет — они приходят портами, поэтому модуль проверяется
 * без Контур.Закупок и без Supabase. Скачивание обязательно локальное: ссылки
 * ведут на filestore zakupki.gov.ru, который не пускает зарубежные IP, а воркер
 * анализа живёт на Vercel именно там.
 */

/** Документ из карточки Контур.Закупок. Форму задаёт konturCardDocumentRefs. */
export interface KonturCardDocument {
  fileName: string;
  /** null — ссылку закрасил тариф: файл перечислен, но не скачивается. */
  url: string | null;
  /** Ссылка в ответе есть, но закрашена: отличает тариф от пустого поля. */
  urlBlurred: boolean;
}

/** Читатель карточки. Реализация — konturTenderSourceAdapter.fetchCardDocumentList. */
export interface KonturCardReader {
  readDocuments(externalId: string): Promise<KonturCardDocument[]>;
}

export interface KonturDocumentDeps extends AttachmentFetchDeps {
  card: KonturCardReader;
  store: TenderDocumentStore;
}

export interface KonturDocumentOptions {
  /** Перезаписать документы, даже если имя уже есть в базе. */
  force?: boolean;
  /** Предел знаков на закупку; в бою — MAX_TOTAL_CHARS_PER_TENDER. */
  budgetChars?: number;
}

export type KonturDocumentOutcome =
  | {
      status: "saved";
      regNumber: string;
      filenames: string[];
      characters: number;
      /** Сколько документов не дошло до разбора: причины уже лежат в базе. */
      skipped: number;
    }
  | { status: "already"; regNumber: string; filenames: string[] }
  /** Карточка отдала имена, но ни одной рабочей ссылки: тариф закрашивает адреса. */
  | { status: "names_only"; regNumber: string; filenames: string[]; reason: string }
  | { status: "empty"; regNumber: string; reason: string }
  | { status: "failed"; regNumber: string; reason: string };

/** Причина для документа, у которого тариф закрыл ссылку. */
export function konturBlurredLinkReason(document: KonturCardDocument): string {
  return document.urlBlurred
    ? "Контур.Закупки отдали имя файла без ссылки: адрес документа закрыт тарифом API. " +
        "Боевой тариф отдаёт ссылки целиком, поэтому такое сообщение означает " +
        "понижение тарифа или ключ без группы `purchase`."
    : "Контур.Закупки перечислили файл без адреса — скачать его негде.";
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
  document: KonturCardDocument,
  skipped: DocumentSkipMark,
): PreparedDocument {
  return {
    filename,
    title: document.fileName,
    documentType: attachmentDocumentType(document.fileName),
    sourceType: "kontur_api",
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
 * Обеспечивает закупку документацией из карточки Контур.Закупок.
 *
 * Вызов стоит денег: карточка — платная группа `purchase`, кэш сглаживает
 * повтор только в пределах TTL. Поэтому вызывать нужно лишь для закупки,
 * которая уже стоит в очереди анализа, и лишь когда ЕИС документацию не отдал.
 */
export async function fetchKonturCardDocuments(
  regNumber: string,
  externalId: string,
  deps: KonturDocumentDeps,
  options: KonturDocumentOptions = {},
): Promise<KonturDocumentOutcome> {
  let cardDocuments: KonturCardDocument[];
  try {
    cardDocuments = await deps.card.readDocuments(externalId);
  } catch (err) {
    return {
      status: "failed",
      regNumber,
      reason: `Карточка Контур.Закупок не прочиталась: ${message(err)}`,
    };
  }

  if (cardDocuments.length === 0) {
    return {
      status: "empty",
      regNumber,
      reason: "В карточке Контур.Закупок нет ни одного документа.",
    };
  }

  const stored = await deps.store.list(regNumber);
  const known = new Set(stored.map((record) => record.filename));
  const budget = Math.max(0, options.budgetChars ?? MAX_TOTAL_CHARS_PER_TENDER);
  let used = options.force ? 0 : stored.reduce((sum, record) => sum + occupiedChars(record), 0);

  const filenames = uniqueFilenames(cardDocuments.map((document) => document.fileName));
  const prepared: PreparedDocument[] = [];

  for (const [index, document] of cardDocuments.entries()) {
    const filename = filenames[index] ?? document.fileName;
    if (!options.force && known.has(filename)) continue;

    if (document.url === null) {
      prepared.push(
        linklessRow(filename, document, {
          code: "download_failed",
          reason: konturBlurredLinkReason(document),
        }),
      );
      continue;
    }

    /*
      Формат проверяется до скачивания. Тома идут отдельной причиной: одиночные
      rar и 7z проект читает, а том комплекта — нет, и тянуть сотни мегабайт,
      чтобы это подтвердить, незачем.
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
      name: document.fileName,
      documentType: attachmentDocumentType(document.fileName),
      url: document.url,
      sourceType: "kontur_api",
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
      reason: "Документы карточки уже в базе, но текста нет ни в одном из них.",
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

  // Ни одного файла с текстом — тариф отдал только имена. Это не сбой, но и не
  // загрузка документации: статус отдельный, чтобы журнал не выдавал имена за
  // разобранные документы. Причина берётся из первой записанной строки — по ней
  // оператор видит, что именно помешало: закрашенная ссылка, том rar или
  // отсутствие текстового слоя.
  if (characters === 0) {
    const linkless = cardDocuments.find((document) => document.url === null);
    const firstSkip = prepared.find((document) => document.skipped !== null)?.skipped;
    return {
      status: "names_only",
      regNumber,
      filenames: savedFilenames,
      reason:
        (linkless ? konturBlurredLinkReason(linkless) : firstSkip?.reason) ??
        "Текста нет ни в одном файле карточки.",
    };
  }

  return { status: "saved", regNumber, filenames: savedFilenames, characters, skipped };
}
