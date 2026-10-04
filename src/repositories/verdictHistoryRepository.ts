import { getSupabaseServerClient } from "@/lib/supabase";
import type { VerdictHistoryRow, Verdict, TriggeredBy } from "@/types/database";

interface RecordVerdictChangeInput {
  tender_id: string;
  old_verdict: Verdict | null;
  new_verdict: Verdict;
  old_score: number | null;
  new_score: number | null;
  reason: string;
  triggered_by: TriggeredBy;
  analysis_id: string | null;
}

export const verdictHistoryRepository = {
  async record(input: RecordVerdictChangeInput): Promise<VerdictHistoryRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("verdict_history")
      .insert({
        tender_id: input.tender_id,
        old_verdict: input.old_verdict,
        new_verdict: input.new_verdict,
        old_score: input.old_score,
        new_score: input.new_score,
        reason: input.reason,
        triggered_by: input.triggered_by,
        analysis_id: input.analysis_id,
      })
      .select()
      .single();

    if (error) throw error;
    return data as VerdictHistoryRow;
  },

  async findByTenderId(tenderId: string): Promise<VerdictHistoryRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("verdict_history")
      .select("*")
      .eq("tender_id", tenderId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data ?? []) as VerdictHistoryRow[];
  },
};
