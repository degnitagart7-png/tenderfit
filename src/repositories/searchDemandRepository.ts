import type { DemandEntry, DemandRow } from "@/domain/demand";
import { getSupabaseServerClient } from "@/lib/supabase";

/** Таблицы нет: миграция 20261005000010 не применена. */
export class SearchDemandTableMissingError extends Error {
  constructor() {
    super("Таблица спроса не создана: примените миграцию 20261005000010_add_search_demand.sql.");
  }
}

/** Таблицу засоряют: новые отчёты не принимаются, пока сборщик не вычистит старое. */
export class SearchDemandFullError extends Error {
  constructor() {
    super("Сервис сейчас не принимает новые темы: попробуйте позже.");
  }
}

/** Предел числа строк: защита от рассылки отчётов под выдуманными идентификаторами. */
export const MAX_DEMAND_ROWS = 20_000;

/** Колонки regions нет: миграция 20261005000012_add_regions_to_collection.sql не применена. */
function isMissingRegionsColumn(error: { code?: string; message?: string }): boolean {
  return error.code === "42703" || error.code === "PGRST204" || /regions/.test(error.message ?? "");
}

function isMissingTable(error: { code?: string; message?: string }): boolean {
  const message = error.message ?? "";
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    (/search_demand/.test(message) && /not find|does not exist/i.test(message))
  );
}

/**
 * Спрос посетителей на темы закупок.
 *
 * Читает и пишет только серверный код с ключом service role.
 */
export const searchDemandRepository = {
  /**
   * Заменяет темы посетителя присланными.
   *
   * Сначала запись, потом удаление снятых: сбой посередине оставит лишние темы,
   * а не пустой спрос.
   */
  async replaceForVisitor(visitorId: string, entries: readonly DemandEntry[]): Promise<void> {
    const supabase = getSupabaseServerClient();

    if (entries.length > 0) {
      const { count, error: countError } = await supabase
        .from("search_demand")
        .select("visitor_id", { count: "exact", head: true });
      if (countError) {
        if (isMissingTable(countError)) throw new SearchDemandTableMissingError();
        throw countError;
      }
      if ((count ?? 0) >= MAX_DEMAND_ROWS) throw new SearchDemandFullError();

      const now = new Date().toISOString();
      const rows = entries.map((e) => ({
        visitor_id: visitorId,
        keyword: e.keyword,
        laws: e.laws,
        regions: e.regions,
        last_seen_at: now,
      }));
      let { error } = await supabase.from("search_demand").upsert(rows, { onConflict: "visitor_id,keyword" });
      if (error && isMissingRegionsColumn(error)) {
        // Миграция с регионами ещё не применена: тема сохраняется без региона, а не теряется.
        ({ error } = await supabase
          .from("search_demand")
          .upsert(rows.map(({ regions: _regions, ...rest }) => rest), { onConflict: "visitor_id,keyword" }));
      }
      if (error) throw error;
    }

    const keep = entries.map((e) => `"${e.keyword.replace(/"/g, "")}"`).join(",");
    const base = supabase.from("search_demand").delete().eq("visitor_id", visitorId);
    const { error } = entries.length === 0 ? await base : await base.not("keyword", "in", `(${keep})`);
    if (error) {
      if (isMissingTable(error)) throw new SearchDemandTableMissingError();
      throw error;
    }
  },

  async listAll(): Promise<DemandRow[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase.from("search_demand").select("*").limit(MAX_DEMAND_ROWS);
    if (error) {
      if (isMissingTable(error)) throw new SearchDemandTableMissingError();
      throw error;
    }
    return (data ?? []) as DemandRow[];
  },
};
