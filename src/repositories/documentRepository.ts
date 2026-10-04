import { getSupabaseServerClient } from "@/lib/supabase";
import type {
  DocumentMeta,
  DocumentRawJson,
  DocumentSkipMark,
  TenderDocumentRow,
  DocumentSourceType,
  DocumentType,
  DownloadStatus,
  ParsedStatus,
} from "@/types/database";

interface CreateDocumentInput {
  tender_id: string;
  source_type: DocumentSourceType;
  filename: string;
  document_type: DocumentType;
  file_url?: string | null;
  raw_json?: Record<string, unknown> | null;
  file_size?: number | null;
  mime_type?: string | null;
}

interface UpdateParsedInput {
  parsed_text: string | null;
  parsed_status: ParsedStatus;
  content_hash?: string | null;
  error_message?: string | null;
  /** Текст дошёл не целиком: в разбор попала часть файла. */
  truncated?: boolean;
  /** Для архива: прочитано входов из скольких. null — файл не архив. */
  archive?: { parsed: number; total: number } | null;
}

interface UpdateDownloadInput {
  download_status: DownloadStatus;
  file_size?: number | null;
  error_message?: string | null;
}

/** Документ, который сохраняется сразу с готовым текстом (локальный скрипт загрузки). */
export interface SaveParsedDocumentInput {
  tender_id: string;
  filename: string;
  title?: string | null;
  document_type: DocumentType;
  source_type: DocumentSourceType;
  file_url?: string | null;
  mime_type?: string | null;
  parsed_text: string;
  content_hash: string;
  /**
   * Настоящий объём файла в байтах. Когда его нет — например, извещение ЕИС
   * это страница, а не файл, — пишется длина UTF-8 текста.
   */
  file_size?: number | null;
  /**
   * Сколько знаков текст занял в бюджете закупки. По этому числу повторный
   * прогон понимает, какой остаток достанется вложениям; без него пришлось бы
   * пересчитывать бюджет по file_size, а у страницы извещения он условный.
   */
  chars?: number | null;
  /** Текст обрезан по остатку бюджета: в разбор попала часть файла. */
  truncated?: boolean;
  /** Для архива: прочитано входов из скольких. null — файл не архив. */
  archive?: { parsed: number; total: number } | null;
}

/**
 * Вложение, которое не попало в разбор: текста нет, но строка в базе нужна.
 *
 * Партнёр видит в карточке закупки причину по каждому файлу, а повторный прогон
 * не пытается скачать его заново — имя уже занято. Ссылка на ЕИС сохраняется:
 * по ней файл можно забрать вручную, когда формат у нас не читается.
 */
export interface SaveSkippedDocumentInput {
  tender_id: string;
  filename: string;
  title?: string | null;
  document_type: DocumentType;
  source_type: DocumentSourceType;
  file_url?: string | null;
  mime_type?: string | null;
  /** Заявленный или фактический объём файла; null, если файл не скачивался. */
  file_size?: number | null;
  skipped: DocumentSkipMark;
}

/** Тип определён в @/types/database: его используют домен, репозиторий и API. */
export type { DocumentMeta };

const META_COLUMNS =
  "id, filename, document_type, source_type, file_url, parsed_status, download_status, content_hash, file_size, error_message, created_at, updated_at, raw_json";

/**
 * Служебные поля для raw_json. Пустой объект не пишется: колонка остаётся null,
 * как у строк прежней версии, и их легко отличить запросом.
 */
function rawJson(fields: {
  title?: string | null;
  chars?: number | null;
  truncated?: boolean;
  archive?: { parsed: number; total: number } | null;
  skipped?: DocumentSkipMark | null;
}): Record<string, unknown> | null {
  const value: Record<string, unknown> = {};
  if (fields.title) value["title"] = fields.title;
  if (typeof fields.chars === "number") value["chars"] = fields.chars;
  // Обрезка пишется только когда она есть: строка без признака означает
  // «текст дошёл до разбора целиком», и отличать её от старого null незачем.
  if (fields.truncated === true) value["truncated"] = true;
  /*
    Состав архива пишется независимо от обрезки.

    Раньше он был вложен в ветку обрезки, и архив, уложившийся в бюджет, терял
    отчёт целиком: по записи нельзя было отличить zip, из которого прочитаны все
    сорок файлов, от zip, где прочитан один, а остальные — сканы. Обе строки
    выглядели одинаково успешными.
  */
  if (fields.archive) value["archive"] = fields.archive;
  if (fields.skipped) value["skipped"] = fields.skipped;
  return Object.keys(value).length === 0 ? null : value;
}

/**
 * id строки документа или undefined, если её ещё нет.
 *
 * Уникального ограничения на пару (tender_id, filename) в схеме нет, поэтому
 * повторный вызов обязан найти прежнюю строку сам: иначе закупка обросла бы
 * десятком копий одного и того же вложения. PGRST116 — «строк не найдено» —
 * это нормальный исход, а не сбой.
 */
async function findRowId(
  tenderId: string,
  filename: string,
): Promise<string | undefined> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("tender_documents")
    .select("id")
    .eq("tender_id", tenderId)
    .eq("filename", filename)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (error) {
    if (error.code === "PGRST116") return undefined;
    throw error;
  }
  return (data as { id?: string } | null)?.id;
}

/**
 * Текущий raw_json строки документа; пустой объект, если колонка не заполнена.
 *
 * PostgREST умеет заменить JSONB целиком, но не долить в него поле. Точечная
 * правка поэтому требует чтения — оно происходит только там, где это нужно
 * (обрезанный документ), а не на каждом обновлении разбора.
 */
async function readRawJson(id: string): Promise<Record<string, unknown>> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("tender_documents")
    .select("raw_json")
    .eq("id", id)
    .limit(1)
    .single();

  if (error) {
    if (error.code === "PGRST116") return {};
    throw error;
  }
  const raw = (data as { raw_json?: unknown } | null)?.raw_json;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** Вставляет строку документа либо обновляет уже существующую с тем же именем. */
async function upsertByFilename(
  tenderId: string,
  filename: string,
  row: Record<string, unknown>,
): Promise<TenderDocumentRow> {
  const supabase = getSupabaseServerClient();
  const existingId = await findRowId(tenderId, filename);
  const query = existingId
    ? supabase.from("tender_documents").update(row).eq("id", existingId)
    : supabase.from("tender_documents").insert(row);

  const { data, error } = await query.select().single();
  if (error) throw error;
  return data as TenderDocumentRow;
}

/**
 * Строка приходит из PostgREST как набор unknown-полей, а интерфейс обещает
 * конкретные типы. Приводим явно в одном месте: список колонок рядом, поэтому
 * расхождение между запросом и типом видно при чтении этой функции.
 */
function toDocumentMeta(row: Record<string, unknown>): DocumentMeta {
  const raw = row["raw_json"];
  return {
    id: row["id"] as string,
    filename: row["filename"] as string,
    document_type: row["document_type"] as DocumentType,
    source_type: row["source_type"] as DocumentSourceType,
    file_url: (row["file_url"] as string | null) ?? null,
    parsed_status: row["parsed_status"] as ParsedStatus,
    download_status: row["download_status"] as DownloadStatus,
    content_hash: (row["content_hash"] as string | null) ?? null,
    file_size: (row["file_size"] as number | null) ?? null,
    error_message: (row["error_message"] as string | null) ?? null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    raw_json: raw && typeof raw === "object" ? (raw as DocumentRawJson) : null,
  };
}

export const documentRepository = {
  async create(input: CreateDocumentInput): Promise<TenderDocumentRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .insert({
        tender_id: input.tender_id,
        source_type: input.source_type,
        filename: input.filename,
        document_type: input.document_type,
        file_url: input.file_url ?? null,
        raw_json: input.raw_json ?? null,
        file_size: input.file_size ?? null,
        mime_type: input.mime_type ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    return data as TenderDocumentRow;
  },

  async findByTenderId(tenderId: string): Promise<TenderDocumentRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .select("*")
      .eq("tender_id", tenderId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return (data ?? []) as TenderDocumentRow[];
  },

  /**
   * Список документов закупки без parsed_text: текст извещения ЕИС занимает
   * сотни килобайт, и тянуть его ради проверки «уже скачано или нет» незачем.
   */
  async listMetaByTenderId(tenderId: string): Promise<DocumentMeta[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .select(META_COLUMNS)
      .eq("tender_id", tenderId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(toDocumentMeta);
  },

  /**
   * Сохраняет документ сразу с готовым текстом: файл уже скачан и разобран
   * локальным скриптом, поэтому download_status и parsed_status выставляются
   * в итоговые значения, а воркер на проде не пытается качать его заново.
   *
   * Повторный вызов с тем же (tender_id, filename) обновляет существующую строку.
   */
  async saveParsed(input: SaveParsedDocumentInput): Promise<TenderDocumentRow> {
    return upsertByFilename(input.tender_id, input.filename, {
      tender_id: input.tender_id,
      filename: input.filename,
      document_type: input.document_type,
      source_type: input.source_type,
      file_url: input.file_url ?? null,
      mime_type: input.mime_type ?? null,
      raw_json: rawJson({
        title: input.title,
        chars: input.chars,
        truncated: input.truncated,
        archive: input.archive,
      }),
      // Извещение ЕИС — страница, а не файл: настоящего объёма у него нет,
      // поэтому вместо него пишется длина UTF-8 текста.
      file_size:
        input.file_size ?? Buffer.byteLength(input.parsed_text, "utf8"),
      download_status: "downloaded" as const,
      parsed_status: "parsed" as const,
      parsed_text: input.parsed_text,
      content_hash: input.content_hash,
      error_message: null,
    });
  },

  /**
   * Пишет вложение, которое не попало в разбор: текста нет, но причина есть.
   *
   * Оба статуса выставляются в «неудачу», а ссылка остаётся настоящей — по ней
   * партнёр может забрать файл с ЕИС вручную, когда формат у нас не читается.
   * Именно ссылка и делает строку опасной для воркера: он перечитывает любой
   * документ с parsed_status !== 'parsed', а ЕИС зарубежные IP не пускает.
   * От повторного скачивания строку удерживает raw_json.skipped — по нему
   * documentAnalysisPipeline.ensureDocumentText выходит сразу, до сети.
   */
  async saveSkipped(
    input: SaveSkippedDocumentInput,
  ): Promise<TenderDocumentRow> {
    return upsertByFilename(input.tender_id, input.filename, {
      tender_id: input.tender_id,
      filename: input.filename,
      document_type: input.document_type,
      source_type: input.source_type,
      file_url: input.file_url ?? null,
      mime_type: input.mime_type ?? null,
      raw_json: rawJson({
        title: input.title,
        chars: 0,
        skipped: input.skipped,
      }),
      file_size: input.file_size ?? null,
      download_status: "failed" as const,
      parsed_status: "failed" as const,
      parsed_text: null,
      content_hash: null,
      error_message: input.skipped.reason,
    });
  },

  async findById(id: string): Promise<TenderDocumentRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .select("*")
      .eq("id", id)
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return data as TenderDocumentRow;
  },

  async findByContentHash(hash: string): Promise<TenderDocumentRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .select("*")
      .eq("content_hash", hash)
      .eq("parsed_status", "parsed")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return data as TenderDocumentRow;
  },

  async updateDownloadStatus(
    id: string,
    input: UpdateDownloadInput,
  ): Promise<TenderDocumentRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tender_documents")
      .update({
        download_status: input.download_status,
        file_size: input.file_size ?? undefined,
        error_message: input.error_message ?? null,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data as TenderDocumentRow;
  },

  async updateParsed(
    id: string,
    input: UpdateParsedInput,
  ): Promise<TenderDocumentRow> {
    const supabase = getSupabaseServerClient();
    const patch: Record<string, unknown> = {
      parsed_text: input.parsed_text,
      parsed_status: input.parsed_status,
      content_hash: input.content_hash ?? null,
      error_message: input.error_message ?? null,
    };

    // Обрезку пишем обязательно: воркер качает сам только документы-ссылки
    // (вручную загруженные и контуровские), но и у них один файл может не
    // влезть в бюджет знаков. Без отметки карточка показала бы «Разбор
    // завершён» над документацией, которую модель не видела целиком.
    // Остальные поля raw_json при этом трогать нельзя — там title и chars.
    if (input.truncated === true || input.archive) {
      const current = await readRawJson(id);
      patch["raw_json"] = {
        ...current,
        ...(input.truncated === true ? { truncated: true } : {}),
        ...(input.archive ? { archive: input.archive } : {}),
      };
    }

    const { data, error } = await supabase
      .from("tender_documents")
      .update(patch)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data as TenderDocumentRow;
  },
};
