import { resolveAccess, type AccessInfo, type UserAccessRecord } from "../src/domain/access";
import { PLANS } from "../src/domain/plans";
import { extendPaidUntil } from "../src/domain/subscription";

/**
 * Чистая часть scripts/grant-access.ts: разбор аргументов, новый срок оплаты и
 * строка списка. Отдельно от скрипта, чтобы проверяться тестом без базы.
 */

/** Правило продления общее с автоматической активацией после оплаты (src/domain/subscription.ts). */
export { extendPaidUntil };

export type GrantCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "grant"; email: string; days: number; plan: string | null };

export class GrantArgsError extends Error {}

export function parseGrantArgs(argv: readonly string[]): GrantCommand {
  let email: string | null = null;
  let days: number | null = null;
  let plan: string | null = null;
  let list = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new GrantArgsError(`${String(arg)} требует значение`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--help":
      case "-h":
        return { kind: "help" };
      case "--list":
        list = true;
        break;
      case "--email":
        email = value().trim().toLowerCase();
        break;
      case "--days": {
        const raw = value();
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3650) {
          throw new GrantArgsError("--days: число дней от 1 до 3650");
        }
        days = parsed;
        break;
      }
      case "--plan": {
        plan = value().trim().toLowerCase();
        if (!PLANS.some((p) => p.id === plan)) {
          throw new GrantArgsError(`--plan: один из ${PLANS.map((p) => p.id).join(", ")}`);
        }
        break;
      }
      default:
        throw new GrantArgsError(`Неизвестный аргумент: ${String(arg)}`);
    }
  }

  if (list) return { kind: "list" };
  if (email === null || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new GrantArgsError("Нужен --email адрес@почта.ру");
  if (days === null) throw new GrantArgsError("Нужен --days число дней");
  return { kind: "grant", email, days, plan };
}

const STATUS_LABEL: Record<AccessInfo["status"], string> = {
  admin: "админ",
  paid: "оплачено",
  trial: "пробный",
  expired: "истёк",
};

const date = (ms: number | null): string => (ms === null ? "—" : new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC");

export interface UserRow {
  email: string;
  record: UserAccessRecord;
}

/** Строка списка пользователей: почта, статус, до какого числа, пакет. */
export function formatUserLine(
  row: UserRow,
  nowMs: number,
  env: Record<string, string | undefined> = process.env,
): string {
  const info = resolveAccess(row.record, row.email, nowMs, env);
  const until = info.status === "paid" ? row.record.paidUntil : info.status === "trial" ? row.record.trialEndsAt : null;
  return [
    row.email.padEnd(36),
    STATUS_LABEL[info.status].padEnd(10),
    date(until).padEnd(22),
    row.record.plan ?? "—",
  ].join(" ");
}

export const GRANT_USAGE = [
  "Продление оплаченного доступа (оплата идёт по счёту).",
  "",
  "  npx tsx scripts/grant-access.ts --email x@y.ru --days 30 [--plan calc]",
  "  npx tsx scripts/grant-access.ts --list",
  "",
  "  --email   почта пользователя (должен быть зарегистрирован)",
  "  --days    на сколько дней продлить; срок считается от большего из «сейчас» и текущего paid_until",
  "  --plan    пакет: start, calc или premium (без него пакет не меняется)",
  "  --list    все пользователи со статусом доступа",
  "",
  "Ключи Supabase берутся из .env.local; ADMIN_EMAILS — для пометки админов в списке.",
].join("\n");
