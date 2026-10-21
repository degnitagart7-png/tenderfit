import { getSupabaseServerClient } from "@/lib/supabase";

/** Строка `company_fit` (миграция 20261021000027): последний результат сверки на (пользователь, закупка). */
export interface CompanyFitRow {
  userId: string;
  tenderId: string;
  analysisHash: string;
  factsHash: string;
  result: unknown;
  llmUsed: boolean;
  updatedAt: string;
}

export interface CompanyFitInsert {
  userId: string;
  tenderId: string;
  analysisHash: string;
  factsHash: string;
  result: unknown;
  overall: string;
  llmUsed: boolean;
}

/** Порт хранилища: тесты подставляют своё. Методы бросают при сбое — решает вызывающий (таблицы может не быть). */
export interface CompanyFitStore {
  get(userId: string, tenderId: string): Promise<CompanyFitRow | null>;
  put(row: CompanyFitInsert): Promise<void>;
  /** Сколько модельных сверок этот человек получил с момента `sinceIso` (по строкам, обновлённым после него). */
  countLlmSince(userId: string, sinceIso: string): Promise<number>;
}

export const companyFitRepository: CompanyFitStore = {
  async get(userId, tenderId) {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("company_fit")
      .select("user_id, tender_id, analysis_hash, facts_hash, result, llm_used, updated_at")
      .eq("user_id", userId)
      .eq("tender_id", tenderId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data === null || data === undefined) return null;
    const row = data as {
      user_id: string;
      tender_id: string;
      analysis_hash: string;
      facts_hash: string;
      result: unknown;
      llm_used: boolean | null;
      updated_at: string;
    };
    return {
      userId: row.user_id,
      tenderId: row.tender_id,
      analysisHash: row.analysis_hash,
      factsHash: row.facts_hash,
      result: row.result,
      llmUsed: row.llm_used === true,
      updatedAt: row.updated_at,
    };
  },

  async put(row) {
    const supabase = getSupabaseServerClient();
    const now = new Date().toISOString();
    const { error } = await supabase.from("company_fit").upsert(
      {
        user_id: row.userId,
        tender_id: row.tenderId,
        analysis_hash: row.analysisHash,
        facts_hash: row.factsHash,
        result: row.result,
        overall: row.overall,
        llm_used: row.llmUsed,
        updated_at: now,
      },
      { onConflict: "user_id,tender_id" },
    );
    if (error) throw new Error(error.message);
  },

  async countLlmSince(userId, sinceIso) {
    const supabase = getSupabaseServerClient();
    const { count, error } = await supabase
      .from("company_fit")
      .select("tender_id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("llm_used", true)
      .gte("updated_at", sinceIso);
    if (error) throw new Error(error.message);
    return count ?? 0;
  },
};
