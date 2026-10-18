import { getSupabaseServerClient } from "@/lib/supabase";

/** Данные аккаунта, которые следуют за человеком на другое устройство. */
export interface UserDataRecord {
  searchProfiles: unknown[];
  companyProfile: unknown;
  /** Отметка онбординга, воронка, настройки и прочее; undefined при записи — не трогать. */
  appState?: Record<string, unknown>;
}

interface UserDataRow {
  search_profiles: unknown[];
  company_profile: unknown;
  app_state?: Record<string, unknown> | null;
}

/**
 * Колонки app_state нет: миграция 20261005000014 ещё не применена. Тогда
 * профили и анкета продолжают сохраняться, а остальное живёт только на устройстве.
 */
function missingAppState(error: { message?: string; code?: string } | null): boolean {
  return error !== null && (error.message ?? "").includes("app_state");
}

/**
 * Ключи данных аккаунта, которыми владеет сервер, а не браузер: `bill-edits:<tenderId>` — правки
 * ведомости сметы за закупкой (`/api/estimate/edits`). Устройство о них не знает и в свой
 * `appState` не кладёт, поэтому его полная запись («заменить») стёрла бы их. Репозиторий
 * переносит такие ключи из хранимого состояния в записываемое, а чтение для устройства их скрывает.
 */
export const SERVER_OWNED_KEY_PREFIXES: readonly string[] = ["bill-edits:"];

export function isServerOwnedKey(key: string): boolean {
  return SERVER_OWNED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Состояние без ключей, которыми владеет сервер: именно его видит и отправляет устройство. */
export function withoutServerOwnedKeys(appState: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(appState).filter(([key]) => !isServerOwnedKey(key)));
}

/** Колонки app_state в базе нет (миграция 20261005000014 не применена): запись по ключу невозможна. */
export class AppStateUnavailableError extends Error {
  constructor() {
    super("Колонка app_state не создана: примените миграцию 20261005000014_add_user_app_state.sql");
    this.name = "AppStateUnavailableError";
  }
}

/** Читает и пишет только серверный код с ключом service role. */
export const userDataRepository = {
  async get(userId: string): Promise<UserDataRecord | null> {
    const client = getSupabaseServerClient();
    const read = (columns: string) => client.from("user_data").select(columns).eq("user_id", userId).limit(1);
    let { data, error } = await read("search_profiles, company_profile, app_state");
    if (missingAppState(error)) ({ data, error } = await read("search_profiles, company_profile"));
    if (error) throw new Error(error.message);
    const row = (data as unknown as UserDataRow[] | null)?.[0];
    return row
      ? {
          searchProfiles: row.search_profiles ?? [],
          companyProfile: row.company_profile ?? null,
          appState: withoutServerOwnedKeys(row.app_state ?? {}),
        }
      : null;
  },

  /** Только app_state пользователя; null — строки нет. Нет колонки — `AppStateUnavailableError`. */
  async getAppState(userId: string): Promise<Record<string, unknown> | null> {
    const client = getSupabaseServerClient();
    const { data, error } = await client.from("user_data").select("app_state").eq("user_id", userId).limit(1);
    if (missingAppState(error)) throw new AppStateUnavailableError();
    if (error) throw new Error(error.message);
    const row = (data as unknown as { app_state?: Record<string, unknown> | null }[] | null)?.[0];
    return row === undefined ? null : (row.app_state ?? {});
  },

  /**
   * Одно значение app_state по ключу; `null` удаляет ключ. Остальные поля строки (профили, анкета,
   * остальное состояние) не трогаются: пишутся только `app_state` и метка времени.
   */
  async setAppStateEntry(userId: string, key: string, value: unknown | null): Promise<void> {
    const client = getSupabaseServerClient();
    const current = (await this.getAppState(userId)) ?? {};
    const next = { ...current };
    if (value === null) delete next[key];
    else next[key] = value;
    const { error } = await client
      .from("user_data")
      .upsert({ user_id: userId, app_state: next, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (missingAppState(error)) throw new AppStateUnavailableError();
    if (error) throw new Error(error.message);
  },

  async put(userId: string, record: UserDataRecord): Promise<void> {
    const client = getSupabaseServerClient();
    const base = {
      user_id: userId,
      search_profiles: record.searchProfiles,
      company_profile: record.companyProfile,
      updated_at: new Date().toISOString(),
    };
    let appState = record.appState;
    if (appState !== undefined) {
      // Ключи сервера (правки ведомости) устройство не знает и не присылает: переносим их из хранимого, а не стираем.
      const stored = await this.getAppState(userId).catch(() => null);
      const owned = Object.entries(stored ?? {}).filter(([key]) => isServerOwnedKey(key));
      if (owned.length > 0) appState = { ...appState, ...Object.fromEntries(owned) };
    }
    const row = appState === undefined ? base : { ...base, app_state: appState };
    let { error } = await client.from("user_data").upsert(row, { onConflict: "user_id" });
    if (missingAppState(error)) {
      ({ error } = await client.from("user_data").upsert(base, { onConflict: "user_id" }));
    }
    if (error) throw new Error(error.message);
  },
};
