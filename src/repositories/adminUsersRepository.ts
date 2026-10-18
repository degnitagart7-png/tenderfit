import type {
  AdminEventRecord,
  AdminJobRecord,
  AdminSessionRecord,
  AdminUserRecord,
  JournalEventRecord,
  JournalFailedJob,
} from "@/domain/adminUsers";
import type { FunnelEventFact, FunnelFacts, FunnelProfileFact } from "@/domain/adminFunnel";
import { getSupabaseServerClient } from "@/lib/supabase";

/**
 * Чтение для админ-панели «Пользователи»: пользователи, входы, журнал действий,
 * задания и их владельцы.
 *
 * Только чтение и только нужные колонки: `password_hash` и `token_hash` не
 * запрашиваются вовсе, поэтому не могут попасть в ответ ни по ошибке, ни через
 * `select *`. Данных немного (десятки пользователей, тысячи строк), поэтому
 * страницы по тысяче читаются подряд — предел PostgREST за обращение.
 */

const PAGE = 1000;
/** Предохранитель: разрастание таблицы не должно превратиться в бесконечный цикл. */
const MAX_PAGES = 100;

type Row = Record<string, unknown>;
type PageResult = PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;

async function readAll(page: (from: number, to: number) => PageResult): Promise<Row[]> {
  const rows: Row[] = [];
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const { data, error } = await page(index * PAGE, index * PAGE + PAGE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as Row[];
    rows.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return rows;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Таблицы нет (миграция не применена): PostgREST отвечает 42P01 или PGRST205. */
export function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205";
}

/** Колонки нет (42703): миграция `requested_by` не применена — заданий с почтой по определению нет. */
async function orEmptyWhenColumnMissing(read: Promise<Row[]>): Promise<Row[]> {
  try {
    return await read;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "42703") return [];
    throw error;
  }
}

/** Профиль поиска «есть»: хотя бы один с непустыми ключевыми словами. */
function hasSearchProfile(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((profile) => {
    const keywords = (profile as { keywords?: unknown } | null)?.keywords;
    return Array.isArray(keywords) && keywords.some((word) => typeof word === "string" && word.trim() !== "");
  });
}

/** Анкета компании «есть»: заполнено название или описание деятельности. */
function hasCompanyProfile(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return ["name", "legalName", "activityDescription"].some((key) => str(profile[key]).trim() !== "");
}

export const adminUsersRepository = {
  async listUsers(): Promise<AdminUserRecord[]> {
    const rows = await readAll((from, to) =>
      getSupabaseServerClient()
        .from("app_users")
        .select("id, email, created_at, last_login_at, trial_ends_at, paid_until, plan")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
    return rows.map((row) => ({
      id: str(row["id"]),
      email: str(row["email"]),
      created_at: str(row["created_at"]),
      last_login_at: strOrNull(row["last_login_at"]),
      trial_ends_at: strOrNull(row["trial_ends_at"]),
      paid_until: strOrNull(row["paid_until"]),
      plan: strOrNull(row["plan"]),
    }));
  },

  async listSessionsSince(sinceIso: string): Promise<AdminSessionRecord[]> {
    const rows = await readAll((from, to) =>
      getSupabaseServerClient()
        .from("auth_sessions")
        .select("email, created_at")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
    return rows.map((row) => ({ email: str(row["email"]), created_at: str(row["created_at"]) }));
  },

  /** `available: false` — таблицы журнала ещё нет (миграция не применена), событий нет по определению. */
  async listEventsSince(sinceIso: string): Promise<{ rows: AdminEventRecord[]; available: boolean }> {
    try {
      const rows = await readAll((from, to) =>
        getSupabaseServerClient()
          .from("user_events")
          .select("email, created_at, kind, ok")
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      );
      return {
        available: true,
        rows: rows.map((row) => ({
          email: str(row["email"]),
          created_at: str(row["created_at"]),
          kind: str(row["kind"]),
          ok: row["ok"] !== false,
        })),
      };
    } catch (error) {
      if (isMissingTable(error)) return { rows: [], available: false };
      throw error;
    }
  },

  /**
   * Все задания, у которых известна почта: расход за всё время относится к человеку
   * через них. У `sync_jobs.requested_by` бывают и метки источника («ui»), поэтому
   * берутся только значения с «@».
   */
  async listAttributedJobs(): Promise<AdminJobRecord[]> {
    const analysis = await orEmptyWhenColumnMissing(
      readAll((from, to) =>
        getSupabaseServerClient()
          .from("analysis_jobs")
          .select("id, requested_by, status, created_at, finished_at")
          .not("requested_by", "is", null)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      ),
    );
    const sync = await readAll((from, to) =>
      getSupabaseServerClient()
        .from("sync_jobs")
        .select("id, requested_by, status, created_at, finished_at")
        .like("requested_by", "%@%")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
    const toRecord =
      (source: AdminJobRecord["source"]) =>
      (row: Row): AdminJobRecord => ({
        id: str(row["id"]),
        source,
        email: str(row["requested_by"]),
        status: str(row["status"]),
        created_at: str(row["created_at"]),
        finished_at: strOrNull(row["finished_at"]),
      });
    return [...analysis.map(toRecord("analysis")), ...sync.map(toRecord("sync"))];
  },

  /** Последние `limit` событий одного человека, новые сверху. */
  async listUserEvents(email: string, limit: number): Promise<{ rows: JournalEventRecord[]; available: boolean }> {
    const { data, error } = await getSupabaseServerClient()
      .from("user_events")
      .select("created_at, kind, ok, tender_id, detail")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) {
      if (isMissingTable(error)) return { rows: [], available: false };
      throw error;
    }
    return {
      available: true,
      rows: ((data ?? []) as Row[]).map((row) => ({
        created_at: str(row["created_at"]),
        kind: str(row["kind"]),
        ok: row["ok"] !== false,
        tender_id: strOrNull(row["tender_id"]),
        detail: strOrNull(row["detail"]),
      })),
    };
  },

  /** Упавшие задания одного человека (разбор и очередь), новые сверху. */
  async listFailedJobs(email: string, limit: number): Promise<JournalFailedJob[]> {
    const client = getSupabaseServerClient();
    const [analysis, sync] = await Promise.all([
      client
        .from("analysis_jobs")
        .select("tender_id, error_message, created_at, finished_at")
        .eq("requested_by", email)
        .eq("status", "failed")
        .order("created_at", { ascending: false })
        .limit(limit),
      client
        .from("sync_jobs")
        .select("kind, error, created_at, finished_at, tender_id:payload->>tenderId")
        .eq("requested_by", email)
        .eq("status", "failed")
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);
    if (analysis.error) throw analysis.error;
    if (sync.error) throw sync.error;
    return [
      ...((analysis.data ?? []) as Row[]).map(
        (row): JournalFailedJob => ({
          source: "analysis",
          tender_id: strOrNull(row["tender_id"]),
          error: strOrNull(row["error_message"]),
          created_at: str(row["created_at"]),
          finished_at: strOrNull(row["finished_at"]),
        }),
      ),
      ...((sync.data ?? []) as Row[]).map(
        (row): JournalFailedJob => ({
          source: "sync",
          kind: str(row["kind"]),
          tender_id: strOrNull(row["tender_id"]),
          error: strOrNull(row["error"]),
          created_at: str(row["created_at"]),
          finished_at: strOrNull(row["finished_at"]),
        }),
      ),
    ];
  },

  /**
   * Факты для воронки клиентов: четыре чтения без запроса на человека.
   *
   *  - `user_data`: профили и анкета целиком (они небольшие), а из `app_state` — только
   *    два флага путём JSON: у крупных аккаунтов он весит мегабайты из-за закупок;
   *  - `user_events`: все события, кроме ошибок; строки сворачиваются до «последний раз
   *    такое действие было тогда-то» по паре «почта, вид, успех»;
   *  - `analysis_jobs` и `sync_jobs` (estimate): только завершённые, только почта.
   *
   * Нет журнала (миграция не применена) — события пусты, `eventsAvailable: false`.
   */
  async loadFunnelFacts(): Promise<FunnelFacts & { eventsAvailable: boolean }> {
    const client = getSupabaseServerClient();

    const dataRows = await readAll((from, to) =>
      client
        .from("user_data")
        .select(
          "user_id, search_profiles, company_profile, onboarding_done:app_state->onboardingDone, tour_done:app_state->tourDone",
        )
        .order("user_id", { ascending: true })
        .range(from, to),
    );
    const profiles: FunnelProfileFact[] = dataRows.map((row) => ({
      userId: str(row["user_id"]),
      hasSearchProfile: hasSearchProfile(row["search_profiles"]),
      hasCompanyProfile: hasCompanyProfile(row["company_profile"]),
      onboardingDone: row["onboarding_done"] === true,
      tourDone: row["tour_done"] === true,
    }));

    let events: FunnelEventFact[] = [];
    let eventsAvailable = true;
    try {
      const eventRows = await readAll((from, to) =>
        client
          .from("user_events")
          .select("email, kind, ok, created_at")
          .neq("kind", "error")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      );
      const latest = new Map<string, FunnelEventFact>();
      for (const row of eventRows) {
        const email = str(row["email"]).trim().toLowerCase();
        if (email === "") continue;
        const kind = str(row["kind"]);
        const ok = row["ok"] !== false;
        // Строки идут по возрастанию времени: последняя перезаписывает прежние.
        latest.set(`${email}|${kind}|${String(ok)}`, { email, kind, ok, lastAt: str(row["created_at"]) });
      }
      events = [...latest.values()];
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      eventsAvailable = false;
    }

    const emails = (rows: Row[]) => [...new Set(rows.map((row) => str(row["requested_by"]).trim().toLowerCase()).filter((e) => e !== ""))];
    const analysis = await orEmptyWhenColumnMissing(
      readAll((from, to) =>
        client
          .from("analysis_jobs")
          .select("id, requested_by")
          .eq("status", "completed")
          .not("requested_by", "is", null)
          .order("id", { ascending: true })
          .range(from, to),
      ),
    );
    const estimates = await orEmptyWhenColumnMissing(
      readAll((from, to) =>
        client
          .from("sync_jobs")
          .select("id, requested_by")
          .eq("kind", "estimate")
          .eq("status", "completed")
          .like("requested_by", "%@%")
          .order("id", { ascending: true })
          .range(from, to),
      ),
    );

    return {
      profiles,
      events,
      analysisDoneEmails: emails(analysis),
      estimateDoneEmails: emails(estimates),
      eventsAvailable,
    };
  },
};
