import { getSupabaseServerClient } from "@/lib/supabase";
import type {
  SyncJobKind,
  SyncJobPayload,
  SyncJobReport,
  SyncJobRow,
  SyncJobStatus,
  WorkerHeartbeatRow,
  WorkerStatus,
} from "@/types/database";

/** Сколько раз задание возвращается в очередь после сбоя. */
export const SYNC_JOB_MAX_ATTEMPTS = 3;

/**
 * Очередь заданий воркеру с российским IP и его пульс.
 *
 * Прод на Vercel ставит задания, воркер на сервере в России забирает: файл
 * документации ЕИС зарубежному адресу не отдаётся, поэтому тяжёлая часть
 * конвейера живёт там, где выход из российского сегмента. Таблица общая —
 * Supabase в Стокгольме доступен и оттуда, и оттуда.
 */
export const syncJobRepository = {
  async create(
    kind: SyncJobKind,
    payload: SyncJobPayload = {},
    requestedBy: string | null = null,
  ): Promise<SyncJobRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .insert({ kind, payload, requested_by: requestedBy })
      .select()
      .single();

    if (error) throw error;
    return data as SyncJobRow;
  },

  async findById(id: string): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as SyncJobRow | null) ?? null;
  },

  /**
   * Смета по закупке, которая уже считается.
   *
   * Нужна, чтобы повторное нажатие кнопки не ставило второе задание: расчёт
   * стоит минут работы модели, и платить за один ответ дважды незачем.
   */
  async findActiveEstimate(tenderId: string): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("*")
      .eq("kind", "estimate")
      .eq("payload->>tenderId", tenderId)
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as SyncJobRow | null) ?? null;
  },

  /**
   * Задание живого поиска, которое сейчас выполняется или ждёт.
   *
   * Живой поиск — это `full_sync` с запросом в payload: отдельного вида задания
   * нет, потому что список видов закреплён ограничением в базе.
   */
  async findActiveLive(): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("*")
      .eq("kind", "full_sync")
      .not("payload->>liveQuery", "is", null)
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as SyncJobRow | null) ?? null;
  },

  /** Последнее выполненное задание живого поиска по этому запросу. */
  async findRecentLive(query: string): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("*")
      .eq("kind", "full_sync")
      .eq("payload->>liveQuery", query)
      .eq("status", "completed")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as SyncJobRow | null) ?? null;
  },

  /**
   * Последняя смета по закупке, в любом состоянии.
   *
   * По ней открытая заново карточка показывает уже посчитанное, а не
   * предлагает считать второй раз.
   */
  async findLatestEstimate(tenderId: string): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("*")
      .eq("kind", "estimate")
      .eq("payload->>tenderId", tenderId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as SyncJobRow | null) ?? null;
  },

  /** Последние задания — для журнала на панели. */
  async findRecent(limit = 10): Promise<SyncJobRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("sync_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data ?? []) as SyncJobRow[];
  },

  /**
   * Забирает одно задание и переводит его в processing.
   *
   * Захват условный — обновление проходит, только если строка всё ещё pending,
   * поэтому два воркера не возьмут одно задание. Тот же приём, что в
   * `analysisJobRepository.claimNextPending`: RPC-функция в базе не заведена
   * намеренно, чтобы миграция оставалась таблицами, а не кодом на plpgsql.
   *
   * `null` при пустой очереди — нормальный исход, а не ошибка: воркер
   * сообщает «делать нечего» и уходит до следующего тика.
   */
  async claimNextPending(
    workerId: string,
    now: string,
  ): Promise<SyncJobRow | null> {
    const supabase = getSupabaseServerClient();

    const { data: candidate, error: fetchError } = await supabase
      .from("sync_jobs")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!candidate) return null;

    const { id, attempts } = candidate as SyncJobRow;
    const { data: claimed, error: claimError } = await supabase
      .from("sync_jobs")
      .update({
        status: "processing" satisfies SyncJobStatus,
        worker_id: workerId,
        claimed_at: now,
        attempts: (attempts ?? 0) + 1,
      })
      .eq("id", id)
      .eq("status", "pending")
      .select();

    if (claimError) throw claimError;
    return ((claimed ?? []) as SyncJobRow[])[0] ?? null;
  },

  /** Задание выполнено: отчёт пишется целиком, а не прибавляется к прежнему. */
  async complete(id: string, report: SyncJobReport): Promise<void> {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase
      .from("sync_jobs")
      .update({
        status: "completed",
        report,
        // Причина прошлой попытки стирается: задание могло упасть, а со второй
        // пройти, и «completed» с текстом старой ошибки читался бы как провал.
        error: null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
  },

  /**
   * Задание не выполнено.
   *
   * Возврат в очередь ограничен `SYNC_JOB_MAX_ATTEMPTS`: ЕИС отвечает не всегда
   * (фильтр адресов, технические окна), и бесконечные повторения одного и того
   * же падающего задания съели бы всё время воркера, а партнёр видел бы
   * «в очереди» без объяснения. После предела задание остаётся failed с текстом
   * причины — его видно на панели и в журнале.
   */
  async fail(
    id: string,
    error: string,
    attempts: number,
  ): Promise<SyncJobStatus> {
    const supabase = getSupabaseServerClient();
    const retry = attempts < SYNC_JOB_MAX_ATTEMPTS;
    const status: SyncJobStatus = retry ? "pending" : "failed";
    const update: Record<string, unknown> = { status, error };
    if (!retry) update["finished_at"] = new Date().toISOString();

    const { error: dbError } = await supabase
      .from("sync_jobs")
      .update(update)
      .eq("id", id);

    if (dbError) throw dbError;
    return status;
  },

  /**
   * Возвращает в очередь задания, зависшие в processing.
   *
   * Сервер перезагружается и systemd обрывает процесс на середине: без этой
   * очистки задание осталось бы «выполняется» навсегда, а панель показывала бы
   * работу, которой нет.
   *
   * Порог по умолчанию здесь мягче рабочего: воркер передаёт
   * `STALE_JOB_AFTER_MIN` из домена, который обязан быть выше внутреннего
   * бюджета скачивания (25 минут). Иначе живой прогон перехватывался бы вторым
   * воркером, и одни и те же вложения качались дважды.
   */
  async resetStaleJobs(staleMinutes = 30, now = Date.now()): Promise<number> {
    const supabase = getSupabaseServerClient();
    const cutoff = new Date(now - staleMinutes * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("sync_jobs")
      .select("id, claimed_at")
      .eq("status", "processing");

    if (error) throw error;

    const stale = (
      (data ?? []) as Pick<SyncJobRow, "id" | "claimed_at">[]
    ).filter((job) => {
      return job.claimed_at !== null && job.claimed_at < cutoff;
    });

    for (const job of stale) {
      await supabase
        .from("sync_jobs")
        .update({ status: "pending", worker_id: null })
        .eq("id", job.id);
    }

    return stale.length;
  },

  async countPending(): Promise<number> {
    const supabase = getSupabaseServerClient();
    const { count, error } = await supabase
      .from("sync_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");

    if (error) throw error;
    return count ?? 0;
  },

  /**
   * Отметка «воркер жив» и его выход в сеть.
   *
   * Пишется на каждом тике, даже когда делать нечего: молчание воркера — это
   * сигнал, а не отсутствие новостей. Адрес выхода сохраняется отдельно, потому
   * что ЕИС пускает только российские IP, и смена адреса объясняет все
   * последующие сбои загрузки документации.
   */
  async beat(
    workerId: string,
    fields: {
      lastSeenAt: string;
      host?: string | null;
      version?: string | null;
      exitIp?: string | null;
      exitCountry?: string | null;
      lastFullSyncAt?: string | null;
      lastJobId?: string | null;
      lastError?: string | null;
    },
  ): Promise<void> {
    const supabase = getSupabaseServerClient();
    const row: Record<string, unknown> = {
      worker_id: workerId,
      last_seen_at: fields.lastSeenAt,
    };
    // Неизвестное значение не затирает прежнее: адрес выхода определяется не на
    // каждом тике, и null вместо «95.167.245.92» выглядел бы как потеря выхода.
    if (fields.host !== undefined) row["host"] = fields.host;
    if (fields.version !== undefined) row["version"] = fields.version;
    if (fields.exitIp !== undefined && fields.exitIp !== null)
      row["exit_ip"] = fields.exitIp;
    if (fields.exitCountry !== undefined && fields.exitCountry !== null) {
      row["exit_country"] = fields.exitCountry;
    }
    if (fields.lastFullSyncAt !== undefined)
      row["last_full_sync_at"] = fields.lastFullSyncAt;
    if (fields.lastJobId !== undefined) row["last_job_id"] = fields.lastJobId;
    if (fields.lastError !== undefined) row["last_error"] = fields.lastError;

    const { error } = await supabase.from("worker_heartbeat").upsert(row, {
      onConflict: "worker_id",
    });

    if (error) throw error;
  },

  async readHeartbeat(workerId: string): Promise<WorkerHeartbeatRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("worker_heartbeat")
      .select("*")
      .eq("worker_id", workerId)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return (data as WorkerHeartbeatRow | null) ?? null;
  },

  /** Сводка для панели: пульс, последнее задание и длина очереди. */
  async status(workerId: string): Promise<WorkerStatus> {
    const [heartbeat, recent, pending] = await Promise.all([
      this.readHeartbeat(workerId),
      this.findRecent(1),
      this.countPending(),
    ]);
    return { heartbeat, lastJob: recent[0] ?? null, pending };
  },
};
