import { getSupabaseServerClient } from "@/lib/supabase";
import type { ServerProfile } from "@/domain/syncProfiles";

/** Таблицы нет: миграция 20261004000009 не применена. */
export class SyncProfilesTableMissingError extends Error {
  constructor() {
    super("Таблица профилей сервера не создана: примените миграцию 20261004000009_add_sync_profiles.sql.");
  }
}

interface SyncProfileDbRow {
  name: string;
  laws: ServerProfile["laws"];
  keywords: string[];
  okpd2_codes: string[];
  min_price: number | null;
  max_price: number | null;
  /** Колонка добавлена миграцией 20261005000012; в старой базе поля нет. */
  regions?: string[] | null;
  enabled: boolean;
}

function isMissingTable(error: { code?: string; message?: string }): boolean {
  const message = error.message ?? "";
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    (/sync_profiles/.test(message) && /not find|does not exist/i.test(message))
  );
}

/** Колонки regions нет: миграция 20261005000012_add_regions_to_collection.sql не применена. */
function isMissingRegionsColumn(error: { code?: string; message?: string }): boolean {
  return error.code === "42703" || error.code === "PGRST204" || /regions/.test(error.message ?? "");
}

function toProfile(row: SyncProfileDbRow): ServerProfile {
  return {
    name: row.name,
    laws: row.laws,
    keywords: row.keywords,
    okpd2Codes: row.okpd2_codes,
    minPrice: row.min_price === null ? null : Number(row.min_price),
    maxPrice: row.max_price === null ? null : Number(row.max_price),
    regions: row.regions ?? [],
    enabled: row.enabled,
  };
}

/**
 * Профили, по которым сервер собирает закупки.
 *
 * Читает и пишет только серверный код с ключом service role: у таблицы нет
 * политик для анонимного доступа.
 */
export const syncProfileRepository = {
  async list(): Promise<ServerProfile[]> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase.from("sync_profiles").select("*").order("name");
    if (error) {
      if (isMissingTable(error)) throw new SyncProfilesTableMissingError();
      throw error;
    }
    return ((data ?? []) as SyncProfileDbRow[]).map(toProfile);
  },

  /**
   * Заменяет набор целиком: профили, которых нет в присланном списке, удаляются.
   *
   * Сначала запись, потом удаление лишних: сбой посередине оставит старый и
   * новый профили вместе, а не пустой набор, при котором сборщик откатился бы
   * к зашитым.
   */
  async replaceAll(profiles: readonly ServerProfile[]): Promise<void> {
    const supabase = getSupabaseServerClient();

    if (profiles.length > 0) {
      const now = new Date().toISOString();
      const rows = profiles.map((p) => ({
        name: p.name,
        laws: p.laws,
        keywords: p.keywords,
        okpd2_codes: p.okpd2Codes,
        min_price: p.minPrice,
        max_price: p.maxPrice,
        regions: p.regions,
        enabled: p.enabled,
        updated_at: now,
      }));
      let { error } = await supabase.from("sync_profiles").upsert(rows, { onConflict: "name" });
      if (error && isMissingRegionsColumn(error)) {
        // Миграция с регионами ещё не применена: профили сохраняются без них, а не теряются.
        ({ error } = await supabase
          .from("sync_profiles")
          .upsert(rows.map(({ regions: _regions, ...rest }) => rest), { onConflict: "name" }));
      }
      if (error) {
        if (isMissingTable(error)) throw new SyncProfilesTableMissingError();
        throw error;
      }
    }

    const keep = profiles.map((p) => `"${p.name.replace(/"/g, '\\"')}"`).join(",");
    const query = supabase.from("sync_profiles").delete();
    const { error } =
      profiles.length === 0 ? await query.neq("name", "") : await query.not("name", "in", `(${keep})`);
    if (error) throw error;
  },
};
