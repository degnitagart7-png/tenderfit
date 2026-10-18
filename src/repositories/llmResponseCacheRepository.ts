import { getSupabaseServerClient } from "@/lib/supabase";

/** Строка кэша ответов модели (`llm_response_cache`, миграция 20261012000020). */
export interface LlmCacheEntry {
  readonly key: string;
  readonly response: string;
  readonly hits: number;
}

export interface LlmCacheInsert {
  readonly key: string;
  readonly purpose: string;
  readonly model: string;
  readonly response: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

/** Порт хранилища: тесты подставляют своё, не трогая базу. Методы бросают при сбое — решает вызывающий (кэш сбой проглатывает). */
export interface LlmResponseCacheStore {
  /** Ответ по ключу, не старше `notOlderThan` (ISO); нет или устарел — null. */
  get(key: string, notOlderThan: string): Promise<LlmCacheEntry | null>;
  /** Кладёт ответ; существующий ключ (в том числе устаревший) перезаписывается и начинает жить заново. */
  put(entry: LlmCacheInsert): Promise<void>;
  /** Счётчик попаданий: hits = `hits`, last_hit_at = сейчас. Вызывается без ожидания. */
  touch(key: string, hits: number): Promise<void>;
}

/** Postgres не принимает нулевой символ в text. */
function cleanText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u0000/g, "");
}

export const llmResponseCacheRepository: LlmResponseCacheStore = {
  async get(key, notOlderThan) {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("llm_response_cache")
      .select("key, response, hits")
      .eq("key", key)
      .gte("created_at", notOlderThan)
      .maybeSingle();
    if (error) throw new Error(error.message ?? String(error));
    if (data === null || data === undefined) return null;
    const row = data as { key: string; response: string; hits: number | null };
    return { key: row.key, response: row.response, hits: Number(row.hits ?? 0) };
  },

  async put(entry) {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase.from("llm_response_cache").upsert(
      {
        key: entry.key,
        purpose: entry.purpose,
        model: entry.model,
        response: cleanText(entry.response),
        tokens_in: entry.tokensIn,
        tokens_out: entry.tokensOut,
        created_at: new Date().toISOString(),
        hits: 0,
        last_hit_at: null,
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message ?? String(error));
  },

  async touch(key, hits) {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase
      .from("llm_response_cache")
      .update({ hits, last_hit_at: new Date().toISOString() })
      .eq("key", key);
    if (error) throw new Error(error.message ?? String(error));
  },
};
