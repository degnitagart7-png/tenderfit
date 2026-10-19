import { config } from "dotenv";
import { resolve } from "node:path";

import { getSupabaseServerClient } from "../src/lib/supabase";
import { subscriptionRepository } from "../src/repositories/subscriptionRepository";
import {
  GRANT_USAGE,
  GrantArgsError,
  extendPaidUntil,
  formatUserLine,
  parseGrantArgs,
  type UserRow,
} from "./grant-access.lib";

config({ path: resolve(__dirname, "../.env.local") });

/**
 * Ручное продление доступа: оплата идёт по счёту, поэтому после поступления денег
 * владелец запускает скрипт.
 *
 *   npx tsx scripts/grant-access.ts --email x@y.ru --days 30 [--plan calc]
 *   npx tsx scripts/grant-access.ts --list
 *
 * Срок продлевается от большего из «сейчас» и текущего paid_until: оплата вперёд
 * не сгорает. Пакет меняется только с --plan. Ключи Supabase — из .env.local.
 * Нужна применённая миграция 20261011000019_add_access_trial.sql.
 */

interface DbRow {
  email: string;
  trial_ends_at: string | null;
  paid_until: string | null;
  plan: string | null;
}

const ms = (value: string | null): number | null => (value === null ? null : Date.parse(value));

const toRow = (row: DbRow): UserRow => ({
  email: row.email,
  record: { trialEndsAt: ms(row.trial_ends_at), paidUntil: ms(row.paid_until), plan: row.plan },
});

async function main(): Promise<void> {
  const command = parseGrantArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(GRANT_USAGE);
    return;
  }

  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`В .env.local нет ${missing.join(", ")}`);
  const db = getSupabaseServerClient();

  if (command.kind === "list") {
    const { data, error } = await db
      .from("app_users")
      .select("email, trial_ends_at, paid_until, plan")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const rows = (data as DbRow[] | null) ?? [];
    const now = Date.now();
    console.log(["почта".padEnd(36), "статус".padEnd(10), "до".padEnd(22), "пакет"].join(" "));
    for (const row of rows) console.log(formatUserLine(toRow(row), now));
    console.log(`\nВсего: ${String(rows.length)}`);
    return;
  }

  const user = await subscriptionRepository.findByEmail(command.email);
  if (!user) throw new Error(`Пользователь ${command.email} не найден: он должен сначала зарегистрироваться`);

  // Правило продления общее с автоматической активацией после оплаты (src/domain/subscription.ts).
  const now = Date.now();
  const paidUntil = extendPaidUntil(user.paidUntil, now, command.days);
  await subscriptionRepository.setPaid(user.id, paidUntil, command.plan);

  console.log(`Готово. ${command.email}: оплачено до ${new Date(paidUntil).toISOString()} (+${String(command.days)} дн.)`);
  console.log(`Пакет: ${command.plan ?? user.plan ?? "не задан"}`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    if (err instanceof GrantArgsError) {
      console.error(`${err.message}\n\n${GRANT_USAGE}`);
      process.exit(2);
    }
    console.error("Ошибка:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
