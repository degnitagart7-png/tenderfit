import { getSupabaseServerClient } from "@/lib/supabase";

/**
 * Срок подписки пользователя: чтение и ручная запись.
 *
 * Общий для ручной выдачи (scripts/grant-access.ts) и автоматической активации после оплаты
 * (там срок пишет транзакционная функция `payment_apply_activation`, а читает — `findByEmail`).
 * Колонки paid_until, plan, trial_ends_at создаёт миграция 20261011000019_add_access_trial.sql.
 */

export interface SubscriptionUser {
  id: string;
  email: string;
  paidUntil: number | null;
  trialEndsAt: number | null;
  plan: string | null;
}

export interface SubscriptionStore {
  findByEmail(email: string): Promise<SubscriptionUser | null>;
}

const ms = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

export const subscriptionRepository: SubscriptionStore & {
  setPaid(id: string, paidUntilMs: number, plan: string | null): Promise<void>;
} = {
  async findByEmail(email) {
    const { data, error } = await getSupabaseServerClient()
      .from("app_users")
      .select("id, email, trial_ends_at, paid_until, plan")
      .eq("email", email.trim().toLowerCase())
      .limit(1);
    if (error) throw new Error(error.message);
    const row = (data as Array<Record<string, unknown>> | null)?.[0];
    if (!row) return null;
    return {
      id: String(row["id"]),
      email: String(row["email"]),
      paidUntil: ms(row["paid_until"]),
      trialEndsAt: ms(row["trial_ends_at"]),
      plan: typeof row["plan"] === "string" ? row["plan"] : null,
    };
  },

  async setPaid(id, paidUntilMs, plan) {
    const update: { paid_until: string; plan?: string } = { paid_until: new Date(paidUntilMs).toISOString() };
    if (plan !== null) update.plan = plan;
    const { error } = await getSupabaseServerClient().from("app_users").update(update).eq("id", id);
    if (error) throw new Error(error.message);
  },
};
