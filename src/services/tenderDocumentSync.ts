import { describeError } from "@/lib/errors";
import { isEisBlockedError } from "@/lib/eisGate";
import type { DocumentsTabTarget } from "@/services/eisAttachments";
import { computeContentHash } from "@/services/documentParser";
import {
  fetchTenderAttachments,
  MAX_TOTAL_CHARS_PER_TENDER,
  type AttachmentFetchDeps,
  type FetchedAttachment,
} from "@/services/tenderAttachmentsFetcher";
import {
  documentationUnavailableReason,
  expectedDocumentFilename,
  fetchTenderDocumentation,
  publishedInEis,
  type TenderDocumentTarget,
} from "@/services/tenderDocumentsFetcher";
import type { ParsedStatus, SkippedCode } from "@/types/database";
import { detectFileType, isVolumeName } from "@/services/fileFormats";

/**
 * Обеспечение закупки текстом документации перед глубоким анализом.
 *
 * Модуль разделяет две вещи, которые раньше были смешаны в одном пайплайне:
 *  - откуда взять текст (ЕИС блокирует зарубежные IP — значит, локальный скрипт);
 *  - что делать с текстом дальше (AI-разбор делает серверный воркер: очередь и
 *    планировщик живут на проде, там же и ключ шлюза модели).
 *
 * Здесь только первое: найти закупку, скачать извещение и вкладку документов,
 * пройти по вложениям в пределах общего бюджета знаков и положить в
 * tender_documents готовый текст либо причину пропуска. Воркер на проде увидит
 * parsed_status = 'parsed' и пропустит скачивание, перейдя сразу к анализу.
 *
 * Порядок обхода задаёт приоритет вложений: проект контракта, затем описание
 * объекта закупки, затем прочее. Извещение читается первым — без него партнёр
 * не видит даже предмета закупки, а весит оно фиксированно и немного.
 *
 * Все зависимости передаются аргументом, поэтому логика проверяется без сети
 * и без Supabase.
 */

/** Минимум сведений о закупке, нужный для поиска её документации. */
export type TenderDocumentSource = TenderDocumentTarget & DocumentsTabTarget;

/** Что уже лежит в tender_documents по этой закупке. */
export interface DocumentRecord {
  filename: string;
  parsedStatus: ParsedStatus;
  /**
   * Знаков текста из raw_json.chars. null у строк, сохранённых до появления
   * вложений: тогда занятый объём восстанавливается из file_size.
   */
  chars: number | null;
  /** file_size строки в байтах; null, если колонка не заполнена. */
  fileSize: number | null;
  /** Код пропуска из raw_json.skipped; null или нет поля — файл прочитан или пропуска не было. */
  skipCode?: SkippedCode | null;
}

/**
 * Пропуск устарел, и файл стоит прочитать заново.
 *
 * До распаковщика rar и 7z (а позже — odt, ods, rtf, картинок) записывались с
 * «формат не разбирается» — и навсегда: имя файла попадало в известные, и обход его больше не скачивал.
 * В базе таких 109 файлов (84 rar, 19 7z, 6 томов), и это чаще всего полный
 * комплект документации. Теперь формат читается — пропуск больше не правда.
 * Сбой скачивания тоже не окончателен: сеть ЕИС падает и поднимается.
 */
export function isRetryableSkip(record: DocumentRecord): boolean {
  if (record.skipCode === "download_failed") return true;
  if (record.skipCode !== "unsupported_format") return false;
  // Только форматы, которые читаются теперь: архивы, OpenDocument, rtf и картинки
  // (последние — распознаванием). Файл, чьё имя ничего не обещает («pdf», внутри
  // которого что-то чужое), не повторяется: качать его заново на каждом прогоне —
  // пустая трата запросов к ЕИС. Такие файлы перечитывает
  // scripts/reparse-unreadable.ts по тексту причины.
  const kind = detectFileType(null, record.filename);
  return (
    kind === "rar" ||
    kind === "7z" ||
    kind === "odt" ||
    kind === "ods" ||
    kind === "odp" ||
    kind === "rtf" ||
    kind === "image" ||
    isVolumeName(record.filename)
  );
}

/** Документ, готовый к записи: с текстом или с причиной пропуска. */
export interface PreparedDocument extends Omit<FetchedAttachment, "fileSize" | "fileUrl"> {
  /**
   * Адрес файла; null — источник отдал только имя. Так бывает у карточки
   * Контур.Закупок на тестовом тарифе: `Docs[].Url` закрашен, а файл заказчик
   * действительно выложил, и молчать об этом нельзя.
   */
  fileUrl: string | null;
  /** Хэш текста — ключ кэша разбора. У пропущенных документов null. */
  contentHash: string | null;
  /** Объём файла в байтах; null — источник отдал только текст, файла не было. */
  fileSize: number | null;
}

/** Порт хранилища документов. Реализация — documentRepository. */
export interface TenderDocumentStore {
  list(regNumber: string): Promise<DocumentRecord[]>;
  /**
   * Пишет строку документа. Какие колонки заполнять, решает реализация по
   * полю `skipped`: у документа с текстом это parsed_status = 'parsed' и
   * content_hash, у пропущенного — raw_json.skipped и error_message.
   */
  save(regNumber: string, document: PreparedDocument): Promise<void>;
}

/** Порт справочника закупок. Реализация — tenderRepository. */
export interface TenderSourceLookup {
  findByRegNumber(regNumber: string): Promise<TenderDocumentSource | null>;
}

export interface TenderDocumentSyncDeps extends AttachmentFetchDeps {
  lookup: TenderSourceLookup;
  store: TenderDocumentStore;
}

export interface TenderDocumentSyncOptions {
  /** Перечитать страницу и перезаписать текст, даже если он уже в базе. */
  force?: boolean;
  /**
   * Предел знаков на закупку. В бою — MAX_TOTAL_CHARS_PER_TENDER; параметр
   * нужен тестам, чтобы проверять исчерпание бюджета без мегабайт текста.
   */
  budgetChars?: number;
}

export type DocumentSyncOutcome =
  | {
      status: "saved";
      regNumber: string;
      filenames: string[];
      /** Сколько вложений не попали в разбор: их причины уже лежат в базе. */
      skipped: number;
      /** Сколько документов дошло до разбора не целиком: бюджет знаков кончился. */
      truncated: number;
      characters: number;
      /** Что догрузить не удалось; null — получено всё, что источник отдаёт. */
      note: string | null;
    }
  | { status: "already"; regNumber: string; filenames: string[]; note: string | null }
  | { status: "unavailable"; regNumber: string; reason: string }
  /**
   * ЕИС ограничила доступ (затвор `eisGate`): документов не получили и не
   * пытались получить. Это НЕ «документации нет»: закупка остаётся в очереди,
   * в базу не пишется ни пропуск, ни отметка «недоступно», а следующий прогон
   * после `retryAt` (мс) повторит попытку.
   */
  | { status: "blocked"; regNumber: string; reason: string; retryAt: number }
  | { status: "not_found"; regNumber: string; reason: string }
  | { status: "failed"; regNumber: string; reason: string };

/**
 * Сколько знаков бюджета закупки уже занято строкой.
 *
 * У строк прежней версии raw_json.chars нет, а file_size хранит длину UTF-8
 * текста: в русском это примерно два байта на знак. Округление вверх даёт
 * запас — лучше недосчитать вложение, чем потратить бюджет дважды.
 *
 * Обратный случай важнее: у пропущенного файла file_size настоящий (том rar на
 * 300 МБ), а текста нет вовсе. Поэтому chars в приоритете, даже когда он ноль.
 */
export function occupiedChars(record: DocumentRecord): number {
  if (record.chars !== null) return Math.max(0, record.chars);
  return Math.ceil((record.fileSize ?? 0) / 2);
}

/**
 * Ошибка Supabase — не Error, а объект `{ message, code, details, hint }`:
 * `String(err)` давал на нём «[object Object]» и прятал причину сбоя записи.
 */
function errorMessage(err: unknown): string {
  return describeError(err);
}

/** Извещение ЕИС: одна страница, которую модуль документации уже умеет читать. */
async function readNotice(
  target: TenderDocumentTarget,
  deps: TenderDocumentSyncDeps,
): Promise<{ documents: PreparedDocument[]; note: string | null }> {
  const result = await fetchTenderDocumentation(target, deps.fetchHtml);
  const [notice] = result.documents;
  if (!notice) {
    return { documents: [], note: result.reason ?? "Документация недоступна." };
  }

  return {
    documents: [
      {
        ...notice,
        chars: notice.text.length,
        fileSize: null,
        truncated: false,
        archive: null,
        skipped: null,
        contentHash: computeContentHash(notice.text),
      },
    ],
    note: null,
  };
}

/**
 * Гарантирует, что по закупке в базе есть текст документации, — если источник
 * его вообще отдаёт. Ошибки сети и записи не бросаются наружу: вызывающий код
 * получает статус и причину, чтобы вывести её в журнал или в интерфейс.
 */
export async function ensureTenderDocuments(
  regNumber: string,
  deps: TenderDocumentSyncDeps,
  options: TenderDocumentSyncOptions = {},
): Promise<DocumentSyncOutcome> {
  const target = await deps.lookup.findByRegNumber(regNumber);
  if (!target) {
    return {
      status: "not_found",
      regNumber,
      reason: `Закупка ${regNumber} не найдена в таблице tenders — синхронизация её ещё не принесла или уже удалила.`,
    };
  }

  const stored = await deps.store.list(regNumber);
  const parsedFilenames = stored
    .filter((record) => record.parsedStatus === "parsed")
    .map((record) => record.filename);

  // Источник, чьи закупки не публикуются в ЕИС, не отдаёт ни печатной формы,
  // ни вкладки документов: у Сбербанк-АСТ документация лежит за входом по КЭП,
  // у импорта и демо-закупок её нет вовсе. Обходить вложения здесь нечего.
  // Контур.Закупки в этот список не попадают: номер извещения у агрегатора тот
  // же, что в ЕИС, поэтому печатную форму и вкладку документов читает ЕИС —
  // бесплатно и без ключа Контура (см. publishedInEis).
  if (!publishedInEis(target)) {
    if (parsedFilenames.length === 0) {
      return { status: "unavailable", regNumber, reason: documentationUnavailableReason(target) };
    }
    return { status: "already", regNumber, filenames: parsedFilenames, note: null };
  }

  const budget = Math.max(0, options.budgetChars ?? MAX_TOTAL_CHARS_PER_TENDER);
  // Файлы с устаревшим пропуском не считаются известными: обход скачает их
  // снова, а запись по тому же имени заменит строку пропуска текстом.
  const settled = stored.filter((record) => !isRetryableSkip(record));
  const known = new Set(settled.map((record) => record.filename));
  // --force перечитывает всё, поэтому и занятый бюджет обнуляется: иначе
  // извещение пришлось бы к уже посчитанной в базе копии самого себя.
  let used = options.force ? 0 : settled.reduce((sum, record) => sum + occupiedChars(record), 0);

  const notes: string[] = [];
  const prepared: PreparedDocument[] = [];

  const noticeName = expectedDocumentFilename(target);
  const noticeStored = noticeName === null ? undefined : stored.find((r) => r.filename === noticeName);
  const noticeReady = noticeStored?.parsedStatus === "parsed";

  try {
    if (options.force || !noticeReady) {
      const notice = await readNotice(target, deps);
      prepared.push(...notice.documents);
      used += notice.documents.reduce((sum, document) => sum + document.chars, 0);
      if (notice.note) notes.push(notice.note);
    }

    // Вкладка документов читается всегда, даже когда по именам видно, что всё
    // уже в базе: это один запрос на 150–260 КБ вместо десятков скачиваний, и
    // только он знает, какие файлы заказчик добавил с прошлого прогона.
    // Для 223-ФЗ вкладке нужен noticeGuid из карточки, которую readNotice выше
    // уже читал, — запрос повторяется, но переписка карточки в общий результат
    // не попадает, а лишние 130 КБ раз в два часа дешевле сквозного параметра.
    const attachments = await fetchTenderAttachments(target, deps, {
      budgetChars: Math.max(0, budget - used),
      knownFilenames: options.force ? new Set<string>() : known,
    });
    if (attachments.reason) notes.push(attachments.reason);

    for (const attachment of attachments.attachments) {
      prepared.push({
        ...attachment,
        contentHash: attachment.skipped === null ? computeContentHash(attachment.text) : null,
      });
    }
  } catch (err) {
    // Блокировка ЕИС: ничего не сохраняем (скачанное по этой закупке в этот раз
    // отбрасывается — лучше перекачать после паузы, чем отдать на разбор неполный
    // комплект) и отвечаем статусом, который прогон не путает с «документов нет».
    if (!isEisBlockedError(err)) throw err;
    // Текст уже в базе — закупку можно разбирать, вкладка документов просто не обновилась.
    if (parsedFilenames.length > 0) {
      return { status: "already", regNumber, filenames: parsedFilenames, note: err.message };
    }
    return { status: "blocked", regNumber, reason: err.message, retryAt: err.retryAt };
  }

  const savedFilenames: string[] = [];
  let characters = 0;
  let skipped = 0;
  let truncated = 0;

  for (const document of prepared) {
    try {
      await deps.store.save(regNumber, document);
    } catch (err) {
      // Ошибка записи почти всегда системная — ограничение, соединение, квота.
      // Продолжить значит получить её же ещё полсотни раз, поэтому выходим,
      // сохранив то, что успели.
      return {
        status: "failed",
        regNumber,
        reason: `Не удалось сохранить ${document.filename}: ${errorMessage(err)}`,
      };
    }
    savedFilenames.push(document.filename);
    if (document.skipped === null) {
      characters += document.chars;
      if (document.truncated) truncated += 1;
    } else {
      skipped += 1;
    }
  }

  const note = notes.length > 0 ? notes.join(" ") : null;

  if (savedFilenames.length === 0) {
    // Текст уже есть, а источник в этот раз не ответил — не считаем это потерей.
    if (parsedFilenames.length > 0) {
      return { status: "already", regNumber, filenames: parsedFilenames, note };
    }
    return { status: "unavailable", regNumber, reason: note ?? "Документация недоступна." };
  }

  return { status: "saved", regNumber, filenames: savedFilenames, skipped, truncated, characters, note };
}
