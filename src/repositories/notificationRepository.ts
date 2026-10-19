import { trimFeedRow } from "@/domain/feedRawData";
import { getSupabaseServerClient } from "@/lib/supabase";
import type { TenderRow } from "@/types/database";

/**
 * База для писем: кому слать сводку, какие закупки читать, какие задачи закончились.
 *
 * Читает и пишет только воркер и серверные ручки с ключом service role. Колонки
 * `digest_sent_at` и `notified_at` создаёт миграция 20261015000024_notifications.sql.
 *
 * Настройки и воронка лежат внутри `user_data.app_state` (JSON, у крупных аккаунтов — мегабайты
 * из-за импортированных закупок). Поэтому читаются путями JSON (`app_state->digestSettings`), а не
 * целиком: на каждый десятиминутный прогон тащить чужие документы незачем.
 */

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (value: string | null | undefined): number | null => (value == null ? null : Date.parse(value));

function fail(error: { message?: string } | null): void {
  if (error) throw new Error(error.message ?? "Ошибка базы данных");
}

/** Сколько ключей в одном `in (...)`: длинный список упирается в размер адреса запроса. */
const IN_CHUNK = 150;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Пользователь для сводки: сроки доступа и когда в последний раз обрабатывали его сводку. */
export interface DigestUserRecord {
  id: string;
  email: string;
  trialEndsAt: number | null;
  paidUntil: number | null;
  plan: string | null;
  digestSentAt: number | null;
}

/** Данные человека, по которым строится его сводка. */
export interface UserDigestData {
  searchProfiles: unknown[];
  companyProfile: unknown;
  /** `app_state.pipeline` как есть: разбирает домен (`readPipeline`). */
  pipeline: unknown;
}

/** Завершённая задача, о которой, возможно, надо написать. */
export interface ReadyJob {
  kind: "analysis" | "estimate";
  id: string;
  /** Почта того, кто поставил задачу (в нижнем регистре, непустая и с «@»). */
  requestedBy: string;
  createdAt: number;
  finishedAt: number;
  /** Реестровый номер закупки; у сметы без закупки — null. */
  tenderId: string | null;
  /** Предмет из задания (у сметы — `payload.subject`). */
  subject: string | null;
  /** Только смета: аудит сметы заказчика — не «смета готова». */
  mode: "estimate" | "audit";
  /** Только смета: итог с НДС из отчёта. */
  totalRub: number | null;
}

/** Упавшая задача клиента: письмо администратору. */
export interface FailedJob {
  kind: "analysis" | "estimate";
  id: string;
  /** Реестровый номер закупки; у сметы без закупки — null. */
  tenderId: string | null;
  /** Кто поставил: почта, «ui», служебная метка или null. */
  requestedBy: string | null;
  error: string;
  at: number;
}

interface UserRow {
  id: string;
  email: string;
  trial_ends_at: string | null;
  paid_until: string | null;
  plan: string | null;
  digest_sent_at: string | null;
}

function toUser(row: UserRow): DigestUserRecord {
  return {
    id: row.id,
    email: row.email,
    trialEndsAt: ms(row.trial_ends_at),
    paidUntil: ms(row.paid_until),
    plan: row.plan,
    digestSentAt: ms(row.digest_sent_at),
  };
}

const USER_COLUMNS = "id, email, trial_ends_at, paid_until, plan, digest_sent_at";

/** Итог сметы с НДС: PostgREST отдаёт число из JSON-пути текстом; нет или не число — null. */
function estimateTotal(value: unknown): number | null {
  const total = typeof value === "string" ? Number(value) : value;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

export const notificationRepository = {
  /** Все аккаунты со сроками доступа: решает, кому слать, домен (`resolveAccess`). */
  async listUsers(): Promise<DigestUserRecord[]> {
    const { data, error } = await getSupabaseServerClient().from("app_users").select(USER_COLUMNS).limit(5000);
    fail(error);
    return ((data as UserRow[] | null) ?? []).map(toUser);
  },

  async findUserByEmail(email: string): Promise<DigestUserRecord | null> {
    const { data, error } = await getSupabaseServerClient()
      .from("app_users")
      .select(USER_COLUMNS)
      .eq("email", email.trim().toLowerCase())
      .limit(1);
    fail(error);
    const row = (data as UserRow[] | null)?.[0];
    return row === undefined ? null : toUser(row);
  },

  /** Настройки уведомлений (`app_state.digestSettings`) по аккаунтам; у кого нет — отсутствуют в карте. */
  async readSettings(userIds: readonly string[]): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>();
    for (const part of chunks(userIds, IN_CHUNK)) {
      const { data, error } = await getSupabaseServerClient()
        .from("user_data")
        .select("user_id, settings:app_state->digestSettings")
        .in("user_id", part);
      fail(error);
      for (const row of (data as unknown as { user_id: string; settings: unknown }[] | null) ?? []) {
        if (row.settings !== null && row.settings !== undefined) result.set(row.user_id, row.settings);
      }
    }
    return result;
  },

  /** Профили поиска, анкета и воронка — всё, из чего строится сводка. */
  async readDigestData(userIds: readonly string[]): Promise<Map<string, UserDigestData>> {
    const result = new Map<string, UserDigestData>();
    for (const part of chunks(userIds, IN_CHUNK)) {
      const { data, error } = await getSupabaseServerClient()
        .from("user_data")
        .select("user_id, search_profiles, company_profile, pipeline:app_state->pipeline")
        .in("user_id", part);
      fail(error);
      for (const row of (data as unknown as
        | { user_id: string; search_profiles: unknown; company_profile: unknown; pipeline: unknown }[]
        | null) ?? []) {
        result.set(row.user_id, {
          searchProfiles: Array.isArray(row.search_profiles) ? row.search_profiles : [],
          companyProfile: row.company_profile ?? null,
          pipeline: row.pipeline ?? null,
        });
      }
    }
    return result;
  },

  /** Настройки одного человека по почте (письмо «готов расчёт»); нет аккаунта или настроек — undefined. */
  async readSettingsByEmail(email: string): Promise<unknown> {
    const user = await this.findUserByEmail(email);
    if (user === null) return undefined;
    return (await this.readSettings([user.id])).get(user.id);
  },

  /** Сводка обработана: отправлена или сообщить было нечего. */
  async markDigestSent(userId: string, nowMs: number): Promise<void> {
    const { error } = await getSupabaseServerClient().from("app_users").update({ digest_sent_at: iso(nowMs) }).eq("id", userId);
    fail(error);
  },

  /**
   * Закупки для сводок за один прогон: появившиеся с `sinceMs`, закрывающиеся в ближайшие `closingHours` и
   * перечисленные (воронка). Строки без повторов, `raw_data` урезан, как у ленты.
   */
  async loadTenderRows(query: { sinceMs: number; nowMs: number; closingHours: number; regNumbers: readonly string[] }): Promise<TenderRow[]> {
    const client = getSupabaseServerClient();
    const byReg = new Map<string, TenderRow>();
    const add = (rows: TenderRow[] | null): void => {
      for (const row of rows ?? []) byReg.set(row.reg_number, trimFeedRow(row));
    };

    // Страницами по тысяче: больше PostgREST за раз не отдаёт. Порядок по `id` делает стык страниц надёжным.
    const PAGE = 1000;
    const MAX_PAGES = 5;
    const paged = async (build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>): Promise<void> => {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1);
        fail(error);
        const rows = (data as TenderRow[] | null) ?? [];
        add(rows);
        if (rows.length < PAGE) return;
      }
    };

    await paged((from, to) =>
      client.from("tenders").select("*").gte("created_at", iso(query.sinceMs)).order("id", { ascending: true }).range(from, to),
    );
    await paged((from, to) =>
      client
        .from("tenders")
        .select("*")
        .gt("submission_end", iso(query.nowMs))
        .lte("submission_end", iso(query.nowMs + query.closingHours * 3_600_000))
        .order("id", { ascending: true })
        .range(from, to),
    );
    for (const part of chunks(query.regNumbers, IN_CHUNK)) {
      const { data, error } = await client.from("tenders").select("*").in("reg_number", part);
      fail(error);
      add(data as TenderRow[] | null);
    }
    return [...byReg.values()];
  },

  /** Предмет закупки по реестровому номеру; нет такой — null. */
  async readTenderSubject(regNumber: string): Promise<string | null> {
    const { data, error } = await getSupabaseServerClient().from("tenders").select("subject").eq("reg_number", regNumber).limit(1);
    fail(error);
    return (data as { subject: string }[] | null)?.[0]?.subject ?? null;
  },

  /** Содержимое разборов закупки (`document_analyses.analysis`), старые первыми. */
  async readAnalysisRows(regNumber: string): Promise<unknown[]> {
    const { data, error } = await getSupabaseServerClient()
      .from("document_analyses")
      .select("analysis")
      .eq("tender_id", regNumber)
      .order("created_at", { ascending: true });
    fail(error);
    return ((data as { analysis: unknown }[] | null) ?? []).map((row) => row.analysis);
  },

  /**
   * Задачи, завершённые не раньше `sinceMs`, по которым ещё не разбирались с письмом и у которых
   * есть почта заказчика: глубокий разбор и расчёт сметы.
   */
  async listReadyJobs(sinceMs: number): Promise<ReadyJob[]> {
    const client = getSupabaseServerClient();
    const jobs: ReadyJob[] = [];

    const { data: analysis, error: analysisError } = await client
      .from("analysis_jobs")
      .select("id, tender_id, requested_by, created_at, finished_at")
      .eq("status", "completed")
      .in("job_type", ["full_analysis", "reanalyze"])
      .is("notified_at", null)
      .like("requested_by", "%@%")
      .gte("finished_at", iso(sinceMs))
      .limit(200);
    fail(analysisError);
    for (const row of (analysis as
      | { id: string; tender_id: string; requested_by: string; created_at: string; finished_at: string | null }[]
      | null) ?? []) {
      const created = ms(row.created_at);
      const finished = ms(row.finished_at);
      if (created === null || finished === null) continue;
      jobs.push({
        kind: "analysis",
        id: row.id,
        requestedBy: row.requested_by.trim().toLowerCase(),
        createdAt: created,
        finishedAt: finished,
        tenderId: row.tender_id,
        subject: null,
        mode: "estimate",
        totalRub: null,
      });
    }

    const { data: estimates, error: estimateError } = await client
      .from("sync_jobs")
      // Итог и поля задания берутся путями JSON: отчёт сметы весит мегабайты (ресурсные строки), а в
      // `payload.documents` лежат тексты присланных файлов; письму нужны сумма, объект и номер закупки.
      .select(
        "id, requested_by, subject:payload->>subject, tender_id:payload->>tenderId, mode:payload->>mode, total:report->estimate->document->totals->>total, created_at, finished_at",
      )
      .eq("kind", "estimate")
      .eq("status", "completed")
      .is("notified_at", null)
      .like("requested_by", "%@%")
      .gte("finished_at", iso(sinceMs))
      .limit(200);
    fail(estimateError);
    for (const row of (estimates as
      | {
          id: string;
          requested_by: string;
          subject: string | null;
          tender_id: string | null;
          mode: string | null;
          total: unknown;
          created_at: string;
          finished_at: string | null;
        }[]
      | null) ?? []) {
      const created = ms(row.created_at);
      const finished = ms(row.finished_at);
      if (created === null || finished === null) continue;
      jobs.push({
        kind: "estimate",
        id: row.id,
        requestedBy: row.requested_by.trim().toLowerCase(),
        createdAt: created,
        finishedAt: finished,
        tenderId: row.tender_id ?? null,
        subject: row.subject ?? null,
        mode: row.mode === "audit" ? "audit" : "estimate",
        totalRub: estimateTotal(row.total),
      });
    }
    return jobs;
  },

  /**
   * Занять задачу: отметка ставится условно (`is null`), поэтому из двух одновременных
   * проверок письмо займёт одна. false — уже занято.
   */
  /**
   * Упавшие задачи для письма администратору: анализ и смета со статусом failed, по которым
   * письма ещё не было. Отметка — тот же notified_at, что у писем о готовности: у упавшей
   * задачи письма о готовности не бывает, поле свободно.
   */
  async listFailedJobs(sinceMs: number): Promise<FailedJob[]> {
    const client = getSupabaseServerClient();
    const jobs: FailedJob[] = [];
    const { data: analysis, error: analysisError } = await client
      .from("analysis_jobs")
      .select("id, tender_id, requested_by, error_message, finished_at, updated_at")
      .eq("status", "failed")
      .is("notified_at", null)
      .gte("updated_at", iso(sinceMs))
      .limit(50);
    fail(analysisError);
    for (const row of (analysis as
      | { id: string; tender_id: string; requested_by: string | null; error_message: string | null; finished_at: string | null; updated_at: string }[]
      | null) ?? []) {
      jobs.push({
        kind: "analysis",
        id: row.id,
        tenderId: row.tender_id,
        requestedBy: row.requested_by,
        error: row.error_message ?? "",
        at: ms(row.finished_at) ?? ms(row.updated_at) ?? sinceMs,
      });
    }
    const { data: estimates, error: estimateError } = await client
      .from("sync_jobs")
      .select("id, requested_by, tender_id:payload->>tenderId, error, finished_at, updated_at")
      .eq("kind", "estimate")
      .eq("status", "failed")
      .is("notified_at", null)
      .gte("updated_at", iso(sinceMs))
      .limit(50);
    fail(estimateError);
    for (const row of (estimates as
      | { id: string; requested_by: string | null; tender_id: string | null; error: string | null; finished_at: string | null; updated_at: string }[]
      | null) ?? []) {
      jobs.push({
        kind: "estimate",
        id: row.id,
        tenderId: row.tender_id ?? null,
        requestedBy: row.requested_by,
        error: row.error ?? "",
        at: ms(row.finished_at) ?? ms(row.updated_at) ?? sinceMs,
      });
    }
    return jobs;
  },

  async claimJob(job: Pick<ReadyJob, "kind" | "id">, nowMs: number): Promise<boolean> {
    const { data, error } = await getSupabaseServerClient()
      .from(job.kind === "analysis" ? "analysis_jobs" : "sync_jobs")
      .update({ notified_at: iso(nowMs) })
      .eq("id", job.id)
      .is("notified_at", null)
      .select("id");
    fail(error);
    return (data ?? []).length === 1;
  },

  /** Письмо не ушло: снять отметку, чтобы следующая проверка повторила попытку. */
  async releaseJob(job: Pick<ReadyJob, "kind" | "id">): Promise<void> {
    const { error } = await getSupabaseServerClient()
      .from(job.kind === "analysis" ? "analysis_jobs" : "sync_jobs")
      .update({ notified_at: null })
      .eq("id", job.id);
    fail(error);
  },
};
