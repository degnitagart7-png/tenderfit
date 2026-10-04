import { getSupabaseServerClient } from "@/lib/supabase";
import type { AnalysisFinding, DocumentAnalysisRow } from "@/types/database";

export interface RecordDocumentAnalysisInput {
  tender_id: string;
  document_id: string;
  model_used: string;
  findings: AnalysisFinding[];
  summary: string;
  tokens_used?: number | null;
  processing_time_ms?: number | null;
  confidence_score?: number | null;
}

/**
 * Результаты AI-разбора документации: одна строка = один вызов модели,
 * то есть один фрагмент текста (документы режутся на чанки по 100 тыс. знаков).
 */
export const documentAnalysisRepository = {
  async record(input: RecordDocumentAnalysisInput): Promise<DocumentAnalysisRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("document_analyses")
      .insert({
        tender_id: input.tender_id,
        document_id: input.document_id,
        model_used: input.model_used,
        analysis: { findings: input.findings, summary: input.summary },
        tokens_used: input.tokens_used ?? null,
        processing_time_ms: input.processing_time_ms ?? null,
        confidence_score: input.confidence_score ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    return data as DocumentAnalysisRow;
  },

  async findByTenderId(tenderId: string): Promise<DocumentAnalysisRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("document_analyses")
      .select("*")
      .eq("tender_id", tenderId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return (data ?? []) as DocumentAnalysisRow[];
  },

  /**
   * Сколько фрагментов документа уже разобрано. По этому числу воркер понимает,
   * с какого чанка продолжать, если предыдущий вызов упёрся в лимит времени Vercel.
   */
  async countByDocumentId(documentId: string): Promise<number> {
    const supabase = getSupabaseServerClient();
    const { count, error } = await supabase
      .from("document_analyses")
      .select("id", { count: "exact", head: true })
      .eq("document_id", documentId);

    if (error) throw error;
    return count ?? 0;
  },
};
