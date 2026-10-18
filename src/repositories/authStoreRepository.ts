import type { UserAccessRecord } from "@/domain/access";
import { getSupabaseServerClient } from "@/lib/supabase";
import { CODE_MAX_ATTEMPTS, type AuthStore } from "@/services/authService";

/**
 * Хранилище входа по коду: пользователи, коды, сессии.
 *
 * Читает и пишет только серверный код с ключом service role. Таблицы создаёт
 * миграция 20261005000011_add_email_auth.sql.
 */

function fail(error: { message?: string; code?: string } | null): void {
  if (error) throw new Error(error.message ?? "Ошибка базы данных");
}

const iso = (ms: number): string => new Date(ms).toISOString();

interface AccessColumns {
  trial_ends_at: string | null;
  paid_until: string | null;
  plan: string | null;
}

const ms = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/** Колонки сроков в запись домена; пользователя без записи читаем как «сроков нет» (доступ закрыт). */
export function toAccessRecord(columns: AccessColumns | null | undefined): UserAccessRecord {
  return {
    trialEndsAt: ms(columns?.trial_ends_at),
    paidUntil: ms(columns?.paid_until),
    plan: columns?.plan ?? null,
  };
}

export const authStoreRepository: AuthStore = {
  async lastCodeAt(email) {
    const { data, error } = await getSupabaseServerClient()
      .from("auth_codes")
      .select("created_at")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1);
    fail(error);
    const row = (data as Array<{ created_at: string }> | null)?.[0];
    return row ? Date.parse(row.created_at) : null;
  },

  async countCodesSince(email, sinceMs) {
    const { count, error } = await getSupabaseServerClient()
      .from("auth_codes")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", iso(sinceMs));
    fail(error);
    return count ?? 0;
  },

  async insertCode(row) {
    const { data, error } = await getSupabaseServerClient()
      .from("auth_codes")
      .insert({
        email: row.email,
        code_hash: row.codeHash,
        expires_at: iso(row.expiresAt),
        created_at: iso(row.createdAt),
      })
      .select("id")
      .single();
    fail(error);
    return (data as { id: string }).id;
  },

  async discardCode(id) {
    const { error } = await getSupabaseServerClient().from("auth_codes").delete().eq("id", id);
    fail(error);
  },

  async latestOpenCode(email, nowMs) {
    const { data, error } = await getSupabaseServerClient()
      .from("auth_codes")
      .select("id, code_hash, attempts")
      .eq("email", email)
      .is("consumed_at", null)
      .gt("expires_at", iso(nowMs))
      .lt("attempts", CODE_MAX_ATTEMPTS)
      .order("created_at", { ascending: false })
      .limit(1);
    fail(error);
    const row = (data as Array<{ id: string; code_hash: string; attempts: number }> | null)?.[0];
    return row ? { id: row.id, codeHash: row.code_hash, attempts: row.attempts } : null;
  },

  async bumpAttempts(id) {
    const { error } = await getSupabaseServerClient().rpc("bump_auth_attempts", { code_id: id });
    fail(error);
  },

  async consumeCode(id) {
    // Условие consumed_at is null делает пометку атомарной: из двух одновременных
    // входов одним кодом строку обновит только один.
    const { data, error } = await getSupabaseServerClient()
      .from("auth_codes")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", id)
      .is("consumed_at", null)
      .select("id");
    fail(error);
    return (data ?? []).length === 1;
  },

  async upsertUser(email, trialEndsAt) {
    const client = getSupabaseServerClient();
    // Новому — пробный период; существующему срок не трогаем, поэтому не upsert
    // (он перезаписал бы trial_ends_at при каждом входе по коду).
    const inserted = await client
      .from("app_users")
      .insert({ email, last_login_at: new Date().toISOString(), trial_ends_at: iso(trialEndsAt) })
      .select("id, email")
      .single();
    // 23505 — почта уже есть: обычный повторный вход.
    if (inserted.error?.code !== "23505") {
      fail(inserted.error);
      return inserted.data as { id: string; email: string };
    }
    const { data, error } = await client
      .from("app_users")
      .update({ last_login_at: new Date().toISOString() })
      .eq("email", email)
      .select("id, email")
      .single();
    fail(error);
    return data as { id: string; email: string };
  },

  async findUser(email) {
    const { data, error } = await getSupabaseServerClient()
      .from("app_users")
      .select("id, email, password_hash")
      .eq("email", email)
      .limit(1);
    fail(error);
    const row = (data as Array<{ id: string; email: string; password_hash: string | null }> | null)?.[0];
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash ?? null } : null;
  },

  async createUser(email, passwordHash, trialEndsAt) {
    const { data, error } = await getSupabaseServerClient()
      .from("app_users")
      .insert({
        email,
        password_hash: passwordHash,
        last_login_at: new Date().toISOString(),
        trial_ends_at: iso(trialEndsAt),
      })
      .select("id, email")
      .single();
    // 23505 — уникальный ключ: почту зарегистрировали параллельно.
    if (error?.code === "23505") return null;
    fail(error);
    return data as { id: string; email: string };
  },

  async setPasswordHash(userId, passwordHash) {
    const { error } = await getSupabaseServerClient()
      .from("app_users")
      .update({ password_hash: passwordHash })
      .eq("id", userId);
    fail(error);
  },

  async createSession(row) {
    const { error } = await getSupabaseServerClient().from("auth_sessions").insert({
      user_id: row.userId,
      email: row.email,
      token_hash: row.tokenHash,
      expires_at: iso(row.expiresAt),
    });
    fail(error);
  },

  async findSession(tokenHash, nowMs) {
    // Сроки доступа читаются тем же запросом, что и сессия: через связь с app_users
    // (внешний ключ user_id), без второго обращения к базе на каждую ручку.
    const { data, error } = await getSupabaseServerClient()
      .from("auth_sessions")
      .select("user_id, email, app_users(trial_ends_at, paid_until, plan)")
      .eq("token_hash", tokenHash)
      .gt("expires_at", iso(nowMs))
      .limit(1);
    fail(error);
    const row = (
      data as Array<{
        user_id: string;
        email: string;
        app_users: AccessColumns | AccessColumns[] | null;
      }> | null
    )?.[0];
    if (!row) return null;
    const columns = Array.isArray(row.app_users) ? row.app_users[0] : row.app_users;
    return { userId: row.user_id, email: row.email, access: toAccessRecord(columns) };
  },

  async deleteSession(tokenHash) {
    const { error } = await getSupabaseServerClient().from("auth_sessions").delete().eq("token_hash", tokenHash);
    fail(error);
  },
};
