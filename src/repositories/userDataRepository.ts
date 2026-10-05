import { getSupabaseServerClient } from "@/lib/supabase";

/** Данные аккаунта, которые следуют за человеком на другое устройство. */
export interface UserDataRecord {
  searchProfiles: unknown[];
  companyProfile: unknown;
}

interface UserDataRow {
  search_profiles: unknown[];
  company_profile: unknown;
}

/** Читает и пишет только серверный код с ключом service role. */
export const userDataRepository = {
  async get(userId: string): Promise<UserDataRecord | null> {
    const { data, error } = await getSupabaseServerClient()
      .from("user_data")
      .select("search_profiles, company_profile")
      .eq("user_id", userId)
      .limit(1);
    if (error) throw new Error(error.message);
    const row = (data as UserDataRow[] | null)?.[0];
    return row ? { searchProfiles: row.search_profiles ?? [], companyProfile: row.company_profile ?? null } : null;
  },

  async put(userId: string, record: UserDataRecord): Promise<void> {
    const { error } = await getSupabaseServerClient().from("user_data").upsert(
      {
        user_id: userId,
        search_profiles: record.searchProfiles,
        company_profile: record.companyProfile,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
  },
};
