/**
 * Постоянный уровень кэша Контур.Закупок: сырые ответы и журнал расхода API.
 *
 * Работает через service-role клиент Supabase, то есть только на сервере.
 * Если SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY не заданы или таблицы ещё не
 * созданы (миграция 20260921000003 не применена), репозиторий деградирует
 * в «ничего не хранить»: синхронизация остаётся работоспособной, но каждый
 * запрос уходит в платный API. Это видно в логе и в сводке расхода.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabase";
import {
  KONTUR_BILLABLE_KINDS,
  type KonturBillableKind,
} from "@/adapters/tender-source/konturContract";
import type {
  KonturCacheEntry,
  KonturRawResponseInput,
  KonturUsageEntry,
} from "@/adapters/types";
import type { ApiUsageLogRow, ApiUsageSummary, KonturRawResponseRow } from "@/types/database";

const PROVIDER = "kontur";

/** Клиент или null, если Supabase не настроен. */
function clientOrNull(): SupabaseClient | null {
  try {
    return getSupabaseServerClient();
  } catch {
    return null;
  }
}

/** Начало UTC-суток для указанной даты. */
function dayStart(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00.000Z`;
}

function rowToEntry(row: KonturRawResponseRow): KonturCacheEntry {
  return {
    cacheKey: row.cache_key,
    payload: row.payload,
    fetchedAt: row.fetched_at,
  };
}

export const konturCacheRepository = {
  /** Сырой ответ по ключу кэша. */
  async read(cacheKey: string): Promise<KonturCacheEntry | null> {
    const supabase = clientOrNull();
    if (!supabase) return null;
    const { data, error } = await supabase
      .from("kontur_raw_responses")
      .select("*")
      .eq("cache_key", cacheKey)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return rowToEntry(data as KonturRawResponseRow);
  },

  /** Сохраняет (или обновляет) сырой ответ: ключ кэша уникален. */
  async write(input: KonturRawResponseInput): Promise<void> {
    const supabase = clientOrNull();
    if (!supabase) return;
    await supabase.from("kontur_raw_responses").upsert(
      {
        cache_key: input.cacheKey,
        kind: input.kind,
        url: input.url,
        method: input.method,
        status: input.status,
        request_body: input.requestBody,
        payload: input.payload,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "cache_key" },
    );
  },

  /** Запись журнала расхода. */
  async record(entry: KonturUsageEntry): Promise<void> {
    const supabase = clientOrNull();
    if (!supabase) return;
    await supabase.from("api_usage_log").insert({
      provider: PROVIDER,
      kind: entry.kind,
      url: entry.url,
      status: entry.status,
      from_cache: entry.fromCache,
      duration_ms: entry.durationMs,
      error: entry.error,
      requested_at: entry.at,
    });
  },

  /**
   * Сколько платных запросов каждого метода сделано за текущие UTC-сутки.
   *
   * Тариф считает группы раздельно (`search` и `purchase`), поэтому расход тоже
   * нужен по методам: одна общая сумма не показала бы, что поиски кончились,
   * а карточки ещё доступны. Считаются только платные виды — `/testpurchases` и
   * `/limitGroups` бесплатны (проверено живым зондом: счётчики групп после них
   * не меняются), и включать их означало бы занижать доступный бюджет.
   */
  async billableCallsToday(now: string): Promise<Record<KonturBillableKind, number>> {
    const spent: Record<KonturBillableKind, number> = { search: 0, card: 0 };
    const supabase = clientOrNull();
    if (!supabase) return spent;
    const { data, error } = await supabase
      .from("api_usage_log")
      .select("kind")
      .eq("provider", PROVIDER)
      .eq("from_cache", false)
      .in("kind", [...KONTUR_BILLABLE_KINDS])
      .gte("requested_at", dayStart(now));
    if (error || !data) return spent;
    for (const row of data as Pick<ApiUsageLogRow, "kind">[]) {
      // `kind` в журнале хранится строкой, поэтому сужаем до платных методов
      // явно: значения закреплены CHECK-ограничением миграции 20260921000003.
      if (row.kind === "search" || row.kind === "card") spent[row.kind] += 1;
    }
    return spent;
  },

  /**
   * Когда последний раз делался платный запрос указанного метода — за любые
   * сутки, а не только за сегодняшние.
   *
   * Нужно плановому прогону: он запускается каждые два часа, а боевой тариф
   * даёт 30 поисков в сутки, поэтому Контур.Закупки опрашиваются реже, чем
   * остальные источники. Отсчёт от журнала, а не от часа суток — расписание
   * может стоять на нечётных часах, и привязка к «hour % 6» не сработала бы
   * ни разу. `null` означает «платных запросов не было или журнал недоступен»:
   * в обоих случаях источник опрашиваем, а от перерасхода защищает суточный
   * бюджет метода.
   */
  async lastBillableCallAt(kind: KonturBillableKind): Promise<string | null> {
    const supabase = clientOrNull();
    if (!supabase) return null;
    const { data, error } = await supabase
      .from("api_usage_log")
      .select("requested_at")
      .eq("provider", PROVIDER)
      .eq("from_cache", false)
      .eq("kind", kind)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return (data as Pick<ApiUsageLogRow, "requested_at">).requested_at;
  },

  /** Сводка расхода платных запросов за текущие UTC-сутки. */
  async summaryToday(now: string): Promise<ApiUsageSummary> {
    const supabase = clientOrNull();
    if (!supabase) {
      return { apiCalls: 0, cacheHits: 0, errors: 0, firstCallAt: null, lastCallAt: null };
    }
    const { data, error } = await supabase
      .from("api_usage_log")
      .select("from_cache,status,requested_at")
      .eq("provider", PROVIDER)
      .in("kind", [...KONTUR_BILLABLE_KINDS])
      .gte("requested_at", dayStart(now))
      .order("requested_at", { ascending: true });
    if (error || !data) {
      return { apiCalls: 0, cacheHits: 0, errors: 0, firstCallAt: null, lastCallAt: null };
    }
    const rows = data as Pick<ApiUsageLogRow, "from_cache" | "status" | "requested_at">[];
    const calls = rows.filter((r) => !r.from_cache);
    return {
      apiCalls: calls.length,
      cacheHits: rows.length - calls.length,
      errors: calls.filter((r) => r.status === null || r.status >= 400).length,
      firstCallAt: calls[0]?.requested_at ?? null,
      lastCallAt: calls[calls.length - 1]?.requested_at ?? null,
    };
  },

  /** Последние записи журнала — для «Журнала заданий». */
  async recent(limit = 50): Promise<ApiUsageLogRow[]> {
    const supabase = clientOrNull();
    if (!supabase) return [];
    const { data, error } = await supabase
      .from("api_usage_log")
      .select("*")
      .eq("provider", PROVIDER)
      .order("requested_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as ApiUsageLogRow[];
  },

  /** Сколько сырых ответов накоплено в кэше. */
  async storedResponses(): Promise<number> {
    const supabase = clientOrNull();
    if (!supabase) return 0;
    const { count, error } = await supabase
      .from("kontur_raw_responses")
      .select("id", { count: "exact", head: true });
    if (error) return 0;
    return count ?? 0;
  },
};
