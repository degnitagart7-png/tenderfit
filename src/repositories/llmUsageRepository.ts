import { getSupabaseServerClient } from "@/lib/supabase";

/** Вид работы, ради которого вызвана модель. */
export type LlmPurpose =
  | "deep_analysis"
  | "estimate_bill"
  /** Подбор норм «ИИ-сметчиком» для позиций ведомости без шифра (`/api/estimate/norm-pick`). */
  | "estimate_norm_pick"
  /** Предложение работ по технологии, которых нет в ведомости (`/api/estimate/implied-works`). */
  | "estimate_implied"
  | "search_assist"
  | "rerank"
  | "other";

export const LLM_PURPOSES: readonly LlmPurpose[] = [
  "deep_analysis",
  "estimate_bill",
  "estimate_norm_pick",
  "estimate_implied",
  "search_assist",
  "rerank",
  "other",
];

/** Строка к записи: одна на вызов шлюза. */
export interface LlmUsageInsert {
  purpose: LlmPurpose;
  tender_id: string | null;
  job_id: string | null;
  user_id: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_rub: number;
  cost_source: "provider" | "price_table";
  provider_cost: number | null;
  provider_currency: string | null;
  usd_rub: number | null;
  input_chars: number;
  ok: boolean;
  error: string | null;
}

/** Строка, как её читает отчёт: числа приведены, лишнего нет. */
export interface LlmUsageRow {
  created_at: string;
  purpose: LlmPurpose;
  tender_id: string | null;
  job_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_rub: number;
  input_chars: number;
  ok: boolean;
}

const REPORT_COLUMNS =
  "created_at, purpose, tender_id, job_id, prompt_tokens, completion_tokens, cost_rub, input_chars, ok";

/** Столько знаков ошибки хранится: тело ответа шлюза бывает длинным. */
const MAX_ERROR_CHARS = 1000;

/** Postgres не принимает нулевой символ в text. */
function cleanText(value: string | null): string | null {
  if (value === null) return null;
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u0000/g, "").slice(0, MAX_ERROR_CHARS);
}

function toRow(raw: Record<string, unknown>): LlmUsageRow {
  return {
    created_at: String(raw["created_at"]),
    purpose: raw["purpose"] as LlmPurpose,
    tender_id: (raw["tender_id"] as string | null) ?? null,
    job_id: (raw["job_id"] as string | null) ?? null,
    prompt_tokens: Number(raw["prompt_tokens"] ?? 0),
    completion_tokens: Number(raw["completion_tokens"] ?? 0),
    // numeric приходит из PostgREST числом или строкой — приводим явно.
    cost_rub: Number(raw["cost_rub"] ?? 0),
    input_chars: Number(raw["input_chars"] ?? 0),
    ok: raw["ok"] !== false,
  };
}

export const llmUsageRepository = {
  /**
   * Пишет одну строку учёта. Сбой записи не бросается: учёт расхода не должен
   * ронять разбор, за который он считает деньги. Возвращает true, если записано.
   */
  async record(row: LlmUsageInsert): Promise<boolean> {
    try {
      const supabase = getSupabaseServerClient();
      const { error } = await supabase.from("llm_usage_log").insert({
        ...row,
        error: cleanText(row.error),
        cost_rub: Math.round(row.cost_rub * 10_000) / 10_000,
      });
      if (error) {
        console.warn(
          `[llm-usage] не удалось записать расход (${row.purpose}): ${error.message ?? String(error)}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      console.warn(
        `[llm-usage] не удалось записать расход (${row.purpose}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  },

  /**
   * Строки за период для отчёта. Страницы по тысяче: PostgREST отдаёт не больше
   * этого за запрос. Границы — ISO-даты; `until` не включается.
   */
  async listBetween(options: { since?: string; until?: string }): Promise<LlmUsageRow[]> {
    const supabase = getSupabaseServerClient();
    const pageSize = 1000;
    const rows: LlmUsageRow[] = [];

    for (let from = 0; ; from += pageSize) {
      let query = supabase.from("llm_usage_log").select(REPORT_COLUMNS);
      if (options.since) query = query.gte("created_at", options.since);
      if (options.until) query = query.lt("created_at", options.until);
      const { data, error } = await query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;

      const page = (data ?? []) as unknown as Record<string, unknown>[];
      for (const raw of page) rows.push(toRow(raw));
      if (page.length < pageSize) break;
    }
    return rows;
  },
};
