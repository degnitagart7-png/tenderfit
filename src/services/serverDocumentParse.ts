/**
 * Разбор загруженного файла: в браузере или на сервере.
 *
 * Браузерный `parseDocument` читает PDF, DOCX, таблицы, ODF, RTF и текст, но не
 * умеет старый бинарный .doc (mammoth его не открывает) и архивы. Эти форматы
 * уходят на `POST /api/documents/parse`, где работает серверный разбор
 * (attachmentParser: word-extractor, zip/rar/7z с вложенными архивами). Всё
 * остальное по-прежнему читается у человека в браузере и на сервер не уходит.
 *
 * Модуль клиентский: ни Node-модулей, ни серверного разбора он не тянет.
 *
 * Результат серверного разбора приводится к тому же виду, что у браузерного:
 * неудача — это текст-объяснение (`PARSE_ERROR_PREFIX … ]`), и `isUnreadableText`
 * узнаёт его так же, как у браузерного разбора. Нечитаемый файл не должен
 * попасть в расчёт сметы как текст: на нём ведомость «успешно» разберётся в ноль.
 */

import { MAX_UPLOAD_BYTES } from "@/domain/documentUpload";
import type { ArchiveReport } from "@/types/database";
import { PARSE_ERROR_PREFIX, parseDocument, type ParsedDocument } from "@/services/documentParser";

/** Расширения, которые читает только сервер. */
const SERVER_EXTENSIONS: ReadonlySet<string> = new Set(["doc", "zip", "rar", "7z"]);

function extensionOf(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? (parts.pop() ?? "") : "";
}

export function isArchiveName(fileName: string): boolean {
  return ["zip", "rar", "7z"].includes(extensionOf(fileName));
}

/** Файл читает сервер: старый .doc или архив. */
export function needsServerParse(fileName: string): boolean {
  return SERVER_EXTENSIONS.has(extensionOf(fileName));
}

/** Документ с дополнениями серверного разбора. */
export interface ReadDocument extends ParsedDocument {
  /** Для архива: сколько файлов прочитано из скольких и какие пропущены (с причиной). */
  archive?: ArchiveReport;
  /** Текст обрезан по бюджету знаков. */
  truncated?: boolean;
}

interface ServerParseBody {
  status?: "parsed" | "unsupported" | "empty" | "failed";
  text?: string;
  reason?: string | null;
  archive?: ArchiveReport | null;
  truncated?: boolean;
  error?: string;
}

function unreadable(file: File, reason: string, archive?: ArchiveReport | null): ReadDocument {
  return {
    fileName: file.name,
    fileType: isArchiveName(file.name) ? "unknown" : "docx",
    text: `${PARSE_ERROR_PREFIX}${reason}]`,
    size: file.size,
    ...(archive ? { archive } : {}),
  };
}

/** Серверный разбор одного файла. Не бросает: сбой запроса — тоже «нечитаемый» результат с причиной. */
async function parseOnServer(file: File, fetchImpl: typeof fetch): Promise<ReadDocument> {
  if (file.size > MAX_UPLOAD_BYTES) {
    return unreadable(
      file,
      `файл больше ${String(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ — разделите архив или загрузите нужные файлы отдельно`,
    );
  }

  let response: Response;
  try {
    const form = new FormData();
    form.append("file", file, file.name);
    response = await fetchImpl("/api/documents/parse", { method: "POST", body: form });
  } catch {
    return unreadable(file, "не удалось отправить файл на сервер, проверьте соединение");
  }

  let body: ServerParseBody = {};
  try {
    body = (await response.json()) as ServerParseBody;
  } catch {
    // Не JSON (например, страница ошибки прокси): причину даст код ответа ниже.
  }

  if (!response.ok) {
    const reason =
      response.status === 413
        ? (body.error ?? "файл слишком большой")
        : (body.error ?? `сервер ответил ${String(response.status)}`);
    return unreadable(file, reason);
  }

  const text = typeof body.text === "string" ? body.text : "";
  if (body.status !== "parsed" || text.trim().length === 0) {
    return unreadable(file, body.reason ?? "файл не прочитан", body.archive);
  }

  return {
    fileName: file.name,
    fileType: isArchiveName(file.name) ? "unknown" : "docx",
    text,
    size: file.size,
    ...(body.archive ? { archive: body.archive } : {}),
    ...(body.truncated === true ? { truncated: true } : {}),
  };
}

/**
 * Прочитать файл там, где это возможно: .doc и архивы — на сервере, остальное — в браузере.
 * `fetchImpl` подставляют тесты.
 */
export async function parseDocumentSmart(file: File, fetchImpl: typeof fetch = fetch): Promise<ReadDocument> {
  if (needsServerParse(file.name)) return parseOnServer(file, fetchImpl);
  return parseDocument(file);
}
