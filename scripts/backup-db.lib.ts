/**
 * Резервная копия базы через API Supabase: чистая логика без сети и диска.
 *
 * Пароля к Postgres у сервиса нет (только ключ service role для REST), поэтому pg_dump
 * недоступен. Копия — данные каждой таблицы построчно (NDJSON); схема и так в репозитории
 * (supabase/migrations). Восстановление — scripts/restore-db.ts в базу с применёнными миграциями.
 */

/** Таблица в копии: имя и колонки, по которым строки упорядочены (уникально в сумме). */
export interface BackupTable {
  name: string;
  orderBy: readonly string[];
  /** Сколько строк просить за раз: у документов тексты бывают по 7 млн знаков. */
  pageSize: number;
}

/*
  Что копируется. Не копируются: auth_codes и auth_sessions (одноразовые коды и сессии —
  после восстановления люди просто войдут заново) и llm_response_cache (кэш, пересоберётся сам).
*/
export const BACKUP_TABLES: readonly BackupTable[] = [
  { name: "app_users", orderBy: ["id"], pageSize: 500 },
  { name: "user_data", orderBy: ["user_id"], pageSize: 20 },
  { name: "user_events", orderBy: ["id"], pageSize: 1000 },
  { name: "tenders", orderBy: ["id"], pageSize: 200 },
  { name: "tender_documents", orderBy: ["id"], pageSize: 5 },
  { name: "document_analyses", orderBy: ["id"], pageSize: 50 },
  { name: "analysis_jobs", orderBy: ["id"], pageSize: 500 },
  { name: "verdict_history", orderBy: ["id"], pageSize: 500 },
  { name: "sync_jobs", orderBy: ["id"], pageSize: 20 },
  { name: "sync_profiles", orderBy: ["name"], pageSize: 500 },
  { name: "search_demand", orderBy: ["visitor_id", "keyword"], pageSize: 1000 },
  { name: "kontur_raw_responses", orderBy: ["id"], pageSize: 20 },
  { name: "api_usage_log", orderBy: ["id"], pageSize: 1000 },
  { name: "llm_usage_log", orderBy: ["id"], pageSize: 1000 },
  { name: "worker_heartbeat", orderBy: ["worker_id"], pageSize: 100 },
];

/** Сколько ежедневных копий хранить на сервере. */
export const KEEP_DAYS = 14;

/** Одна страница строк: offset и размер; ошибка — объект с message. */
export type FetchPage = (table: BackupTable, offset: number, limit: number) => Promise<{ rows: unknown[]; error: string | null }>;

/**
 * Все строки таблицы страницами. Если запрос упал (тяжёлые строки упираются в statement
 * timeout), страница дробится вдвое, вплоть до одной строки; не читается и одна — ошибка.
 */
export async function readAllRows(
  table: BackupTable,
  fetchPage: FetchPage,
  onRows: (rows: unknown[]) => Promise<void> | void,
): Promise<number> {
  let offset = 0;
  let size = table.pageSize;
  let total = 0;
  for (;;) {
    const { rows, error } = await fetchPage(table, offset, size);
    if (error !== null) {
      if (size === 1) throw new Error(`${table.name}: строка ${String(offset)} не читается: ${error}`);
      size = Math.max(1, Math.floor(size / 2));
      continue;
    }
    if (rows.length > 0) await onRows(rows);
    total += rows.length;
    offset += rows.length;
    if (rows.length < size) return total;
    // После удачной мелкой страницы пробуем вернуться к обычному размеру.
    size = Math.min(table.pageSize, size * 2);
  }
}

/** Папки копий (имя — дата ГГГГ-ММ-ДД), которые пора удалить: старше `keepDays` от `today`. */
export function expiredBackups(dirs: readonly string[], today: string, keepDays: number = KEEP_DAYS): string[] {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  return dirs.filter((dir) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dir)) return false;
    const ms = Date.parse(`${dir}T00:00:00Z`);
    return Number.isFinite(ms) && todayMs - ms >= keepDays * 86_400_000;
  });
}
