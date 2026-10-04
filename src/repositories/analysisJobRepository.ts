import { getSupabaseServerClient } from "@/lib/supabase";
import type { AnalysisJobRow, JobType, JobStatus } from "@/types/database";

export const analysisJobRepository = {
  async create(
    tenderId: string,
    jobType: JobType,
    priority = 0,
  ): Promise<AnalysisJobRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("analysis_jobs")
      .insert({
        tender_id: tenderId,
        job_type: jobType,
        priority,
      })
      .select()
      .single();

    if (error) throw error;
    return data as AnalysisJobRow;
  },

  /**
   * Сколько задач создано начиная с указанного момента (включительно).
   *
   * Считаются все задачи, а не только успешные: суточный лимит защищает от
   * расходов, а платит и упавший разбор — токены на него уже потрачены.
   * Задачи, которые не создали новую запись (повторный перенос карточки в
   * «Интересное» возвращает прежнюю), в счётчик не попадают — их и в таблице нет.
   */
  async countCreatedSince(sinceIso: string): Promise<number> {
    const supabase = getSupabaseServerClient();
    const { count, error } = await supabase
      .from("analysis_jobs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sinceIso);

    if (error) throw error;
    return count ?? 0;
  },

  async findPending(limit = 50): Promise<AnalysisJobRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("analysis_jobs")
      .select("*")
      .eq("status", "pending")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throw error;
    return (data ?? []) as AnalysisJobRow[];
  },

  /**
   * Закупки, по которым разбор уже закончен, — свежие сверху.
   *
   * Отдаёт только идентификаторы и время окончания, а не строки целиком: это
   * запрос на весь список закупок, а не на одну карточку, и таскать ради галочки
   * в выдаче десяток полей задания незачем. Наименование закупки клиент и так
   * держит у себя — он показывает ту же выдачу.
   */
  async listCompleted(limit = 200): Promise<{ tenderId: string; finishedAt: string | null }[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("analysis_jobs")
      .select("tender_id, finished_at")
      .eq("status", "completed")
      .order("finished_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    /*
      Одна закупка может быть разобрана не один раз: повторный разбор после
      обновления документации создаёт второе задание. В список она обязана
      попасть один раз и со свежей датой — записи уже отсортированы по убыванию,
      поэтому достаточно взять первую встреченную.
    */
    const seen = new Set<string>();
    const result: { tenderId: string; finishedAt: string | null }[] = [];
    for (const row of (data ?? []) as { tender_id: string; finished_at: string | null }[]) {
      if (seen.has(row.tender_id)) continue;
      seen.add(row.tender_id);
      result.push({ tenderId: row.tender_id, finishedAt: row.finished_at });
    }
    return result;
  },

  async findByTenderId(tenderId: string): Promise<AnalysisJobRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("analysis_jobs")
      .select("*")
      .eq("tender_id", tenderId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data ?? []) as AnalysisJobRow[];
  },

  async findById(id: string): Promise<AnalysisJobRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("analysis_jobs")
      .select("*")
      .eq("id", id)
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return data as AnalysisJobRow;
  },

  /**
   * Забирает из очереди одну задачу и переводит её в processing.
   *
   * Захват условный: строка обновляется, только если она всё ещё pending,
   * поэтому два воркера не возьмут одну задачу, а завершённая задача никогда
   * не вернётся в работу. RPC claim_next_analysis_job не используем — в базе
   * его нет и в миграциях он не описан, а лишний заведомо ошибочный запрос
   * на каждый вызов воркера только замедляет отбор.
   *
   * Вернуть null вместо ошибки при пустой очереди — нормальный исход:
   * воркер сообщает «делать нечего».
   */
  async claimNextPending(): Promise<AnalysisJobRow | null> {
    const supabase = getSupabaseServerClient();

    const { data: candidate, error: fetchError } = await supabase
      .from("analysis_jobs")
      .select("*")
      .eq("status", "pending")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!candidate) return null;

    const { id } = candidate as AnalysisJobRow;
    const { data: claimed, error: claimError } = await supabase
      .from("analysis_jobs")
      .update({ status: "processing", started_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .select();

    if (claimError) throw claimError;
    return ((claimed ?? []) as AnalysisJobRow[])[0] ?? null;
  },

  async updateStatus(
    id: string,
    status: JobStatus,
    errorMessage?: string,
  ): Promise<AnalysisJobRow> {
    const supabase = getSupabaseServerClient();
    const updateData: Record<string, unknown> = { status };

    if (status === "processing") {
      updateData["started_at"] = new Date().toISOString();
    }
    if (status === "completed" || status === "failed") {
      updateData["finished_at"] = new Date().toISOString();
    }
    if (errorMessage !== undefined) {
      updateData["error_message"] = errorMessage;
    } else if (status === "completed" || status === "pending") {
      // Задача могла упасть, а со второй попытки пройти: без этой строки
      // «completed» продолжал бы показывать текст прошлой ошибки. Возврат
      // в очередь (большой документ разбирается частями) ошибкой тоже не
      // считается, поэтому причина сбоя стирается и там.
      updateData["error_message"] = null;
    }

    const { data, error } = await supabase
      .from("analysis_jobs")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data as AnalysisJobRow;
  },

  /**
   * Пишет точное число обработанных документов задачи.
   *
   * Инкремент здесь не годится: большой документ разбирается по фрагментам за
   * несколько вызовов воркера, и счётчик, растущий на каждом вызове, после трёх
   * дозапусков показывал «12 из 4». Значение задаётся заново — по числу
   * документов, у которых есть хотя бы один разобранный фрагмент, плюс
   * документы без текста: ждать от них больше нечего.
   */
  async setDocumentsProcessed(id: string, processed: number): Promise<void> {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase
      .from("analysis_jobs")
      .update({ documents_processed: processed })
      .eq("id", id);

    if (error) throw error;
  },

  async setDocumentsTotal(id: string, total: number): Promise<void> {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase
      .from("analysis_jobs")
      .update({ documents_total: total })
      .eq("id", id);

    if (error) throw error;
  },

  async resetStaleJobs(staleMinutes = 10): Promise<number> {
    const supabase = getSupabaseServerClient();
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("analysis_jobs")
      .select("id, updated_at")
      .eq("status", "processing");

    if (error) throw error;

    const staleJobs = (data ?? []).filter((job: { updated_at: string }) => {
      return new Date(job.updated_at) < new Date(cutoff);
    }) as { id: string }[];

    for (const job of staleJobs) {
      await supabase
        .from("analysis_jobs")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", job.id);
    }

    return staleJobs.length;
  },
};
