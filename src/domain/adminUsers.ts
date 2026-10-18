import { resolveAccess, type AccessStatus } from "@/domain/access";
import { userEventLabel } from "@/domain/userEvents";

/**
 * Сводка для админ-панели «Пользователи» (/admin/users).
 *
 * Чистый модуль: базу читают репозиторий и ручка, сюда приходят готовые строки,
 * а время — параметром. Так правила (кого считать активным, как относить расход
 * на ИИ к человеку, что считать ошибкой) проверяются тестом на выдуманных данных,
 * а не на живой базе.
 *
 * Откуда что берётся:
 *  - вход и активность — журнал `user_events` (с 14.10.2026), входы
 *    `auth_sessions` и `app_users.last_login_at` (раньше журнала). Сессия
 *    стирается при выходе, поэтому по ней входы занижены; журнал точен;
 *  - ошибки — события вида `error` (ручка ответила 5xx) плюс упавшие задания
 *    (`analysis_jobs`, `sync_jobs`) с почтой в `requested_by`. Отказ по лимиту или
 *    доступу (ok = false у `deep_analysis`) ошибкой сервиса не считается;
 *  - расход — `llm_usage_log.cost_rub`. Вызов относится к человеку, если его
 *    `job_id` — это `analysis_jobs.id` или `sync_jobs.id` с его почтой в
 *    `requested_by`. Всё прочее (до 14.10.2026, плановые прогоны воркера,
 *    помощник поиска, оценка по смыслу) — «без привязки». Прогоны бенчмарка
 *    (`job_id` начинается с «bench») в сумму не входят нигде.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MOSCOW_OFFSET_MS = 3 * HOUR_MS;

/** Вызов модели, у которого нет человека: бенчмарки отброшены ещё до привязки. */
const BENCH_PREFIX = "bench";

export interface AdminUserRecord {
  id: string;
  email: string;
  created_at: string;
  last_login_at: string | null;
  trial_ends_at: string | null;
  paid_until: string | null;
  plan: string | null;
}

export interface AdminSessionRecord {
  email: string;
  created_at: string;
}

export interface AdminEventRecord {
  email: string;
  created_at: string;
  kind: string;
  ok: boolean;
}

/** Задание очереди или разбора с человеком, который его поставил. */
export interface AdminJobRecord {
  id: string;
  source: "analysis" | "sync";
  email: string;
  status: string;
  created_at: string;
  finished_at: string | null;
}

export interface AdminLlmRecord {
  job_id: string | null;
  created_at: string;
  cost_rub: number;
}

export interface AdminUsersInput {
  nowMs: number;
  users: readonly AdminUserRecord[];
  sessions: readonly AdminSessionRecord[];
  /** События не старше 30 суток. */
  events: readonly AdminEventRecord[];
  /** Все задания с почтой — для расхода за всё время нужны и старые. */
  jobs: readonly AdminJobRecord[];
  /** Весь журнал расхода. */
  llm: readonly AdminLlmRecord[];
  env?: Record<string, string | undefined>;
}

export interface AdminUsersSummary {
  usersTotal: number;
  newLast7d: number;
  activeToday: number;
  active7d: number;
  active30d: number;
  /** Оплачено сейчас (статус «paid»; администратор не считается). */
  payingNow: number;
  onTrial: number;
  expired: number;
  /** События с ошибкой и упавшие задания за 7 суток — по всем почтам, в том числе без аккаунта. */
  errors7d: number;
  spendToday: number;
  spend7d: number;
  spend30d: number;
  spendTotal: number;
  /** Расход, который не отнести к человеку (до 14.10.2026, плановые прогоны, служебные вызовы). */
  spendUnattributed: number;
  /** Прогоны бенчмарка: исключены из всех сумм выше, показаны для сверки с отчётом llm-cost-report. */
  spendBenchExcluded: number;
}

export interface AdminUserRow {
  email: string;
  registeredAt: string;
  lastLoginAt: string | null;
  accessStatus: AccessStatus;
  trialEndsAt: string | null;
  paidUntil: string | null;
  plan: string | null;
  logins30d: number;
  /** Дней с действиями из последних 7 (по Москве, включая сегодня). */
  activeDays7d: number;
  activeDays30d: number;
  lastActivityAt: string | null;
  deepAnalyses30d: number;
  estimates30d: number;
  liveSearches30d: number;
  errors7d: number;
  spend30d: number;
  spendTotal: number;
}

export interface AdminUsersReport {
  generatedAt: string;
  summary: AdminUsersSummary;
  users: AdminUserRow[];
}

function ms(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Московские сутки в виде «2026-10-14»: активность считается по рабочему дню владельца. */
export function mskDay(timeMs: number): string {
  return new Date(timeMs + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Почта вызова в нижнем регистре; пустая — null. */
function lower(email: string | null | undefined): string | null {
  const value = (email ?? "").trim().toLowerCase();
  return value === "" ? null : value;
}

export function isBenchJob(jobId: string | null): boolean {
  return jobId !== null && jobId.trim().toLowerCase().startsWith(BENCH_PREFIX);
}

interface Acc {
  activity: number[];
  loginEvents: number;
  sessions: number;
  deep30: number;
  estimate30: number;
  live30: number;
  errors7: number;
  spend30: number;
  spendTotal: number;
}

const emptyAcc = (): Acc => ({
  activity: [],
  loginEvents: 0,
  sessions: 0,
  deep30: 0,
  estimate30: 0,
  live30: 0,
  errors7: 0,
  spend30: 0,
  spendTotal: 0,
});

export function buildAdminUsersReport(input: AdminUsersInput): AdminUsersReport {
  const { nowMs } = input;
  const env = input.env ?? process.env;
  const todayKey = mskDay(nowMs);
  const day7Key = mskDay(nowMs - 6 * DAY_MS);
  const day30Key = mskDay(nowMs - 29 * DAY_MS);
  const since7 = nowMs - 7 * DAY_MS;
  const since30 = nowMs - 30 * DAY_MS;
  // Начало московских суток: «сегодня» для расхода и активности.
  const todayStart = Date.parse(`${todayKey}T00:00:00.000Z`) - MOSCOW_OFFSET_MS;

  const known = new Set(input.users.map((u) => lower(u.email)).filter((e): e is string => e !== null));
  const acc = new Map<string, Acc>();
  const of = (email: string): Acc => {
    let entry = acc.get(email);
    if (!entry) {
      entry = emptyAcc();
      acc.set(email, entry);
    }
    return entry;
  };

  let errors7d = 0;

  for (const user of input.users) {
    const email = lower(user.email);
    const last = ms(user.last_login_at);
    if (email !== null && last !== null && last >= since30) of(email).activity.push(last);
  }

  for (const session of input.sessions) {
    const email = lower(session.email);
    const at = ms(session.created_at);
    if (email === null || at === null || at < since30) continue;
    const entry = of(email);
    entry.sessions += 1;
    entry.activity.push(at);
  }

  for (const event of input.events) {
    const email = lower(event.email);
    const at = ms(event.created_at);
    if (email === null || at === null || at < since30) continue;
    const entry = of(email);
    entry.activity.push(at);
    if (event.ok) {
      if (event.kind === "login") entry.loginEvents += 1;
      else if (event.kind === "deep_analysis") entry.deep30 += 1;
      else if (event.kind === "estimate") entry.estimate30 += 1;
      else if (event.kind === "live_search") entry.live30 += 1;
    } else if (event.kind === "error" && at >= since7) {
      // Отказ по лимиту или доступу (ok = false у другого вида) — не сбой сервиса: он виден в журнале, но ошибкой не считается.
      entry.errors7 += 1;
      errors7d += 1;
    }
  }

  const jobEmail = new Map<string, string>();
  for (const job of input.jobs) {
    const email = lower(job.email);
    if (email === null) continue;
    jobEmail.set(job.id, email);
    if (job.status === "failed") {
      const at = ms(job.finished_at) ?? ms(job.created_at);
      if (at !== null && at >= since7) {
        of(email).errors7 += 1;
        errors7d += 1;
      }
    }
  }

  let spendToday = 0;
  let spend7d = 0;
  let spend30d = 0;
  let spendTotal = 0;
  let spendUnattributed = 0;
  let spendBench = 0;

  for (const call of input.llm) {
    const cost = Number.isFinite(call.cost_rub) ? call.cost_rub : 0;
    if (isBenchJob(call.job_id)) {
      spendBench += cost;
      continue;
    }
    const at = ms(call.created_at);
    spendTotal += cost;
    if (at !== null) {
      if (at >= todayStart) spendToday += cost;
      if (at >= since7) spend7d += cost;
      if (at >= since30) spend30d += cost;
    }
    const owner = call.job_id === null ? undefined : jobEmail.get(call.job_id);
    // Расход на почту без аккаунта (аккаунт удалён) показать некому — он «без привязки».
    if (owner === undefined || !known.has(owner)) {
      spendUnattributed += cost;
      continue;
    }
    const entry = of(owner);
    entry.spendTotal += cost;
    if (at !== null && at >= since30) entry.spend30 += cost;
  }

  const now = nowMs;
  const rows: AdminUserRow[] = [];
  const counts = { activeToday: 0, active7d: 0, active30d: 0, paying: 0, trial: 0, expired: 0, new7: 0 };

  for (const user of input.users) {
    const email = lower(user.email);
    if (email === null) continue;
    const entry = acc.get(email) ?? emptyAcc();

    const days = new Set(entry.activity.map(mskDay));
    let activeDays7d = 0;
    let activeDays30d = 0;
    for (const day of days) {
      if (day >= day30Key && day <= todayKey) activeDays30d += 1;
      if (day >= day7Key && day <= todayKey) activeDays7d += 1;
    }
    const lastActivity = entry.activity.length === 0 ? null : Math.max(...entry.activity);

    const access = resolveAccess(
      { trialEndsAt: ms(user.trial_ends_at), paidUntil: ms(user.paid_until), plan: user.plan },
      email,
      now,
      env,
    );

    if (days.has(todayKey)) counts.activeToday += 1;
    if (activeDays7d > 0) counts.active7d += 1;
    if (activeDays30d > 0) counts.active30d += 1;
    if (access.status === "paid") counts.paying += 1;
    else if (access.status === "trial") counts.trial += 1;
    else if (access.status === "expired") counts.expired += 1;
    const created = ms(user.created_at);
    if (created !== null && created >= since7) counts.new7 += 1;

    rows.push({
      email,
      registeredAt: user.created_at,
      lastLoginAt: user.last_login_at,
      accessStatus: access.status,
      trialEndsAt: user.trial_ends_at,
      paidUntil: user.paid_until,
      plan: user.plan,
      // Сессия стирается при выходе, журнал — нет: берём большее из двух.
      logins30d: Math.max(entry.sessions, entry.loginEvents),
      activeDays7d,
      activeDays30d,
      lastActivityAt: lastActivity === null ? null : new Date(lastActivity).toISOString(),
      deepAnalyses30d: entry.deep30,
      estimates30d: entry.estimate30,
      liveSearches30d: entry.live30,
      errors7d: entry.errors7,
      spend30d: round4(entry.spend30),
      spendTotal: round4(entry.spendTotal),
    });
  }

  rows.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.email.localeCompare(b.email));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      usersTotal: rows.length,
      newLast7d: counts.new7,
      activeToday: counts.activeToday,
      active7d: counts.active7d,
      active30d: counts.active30d,
      payingNow: counts.paying,
      onTrial: counts.trial,
      expired: counts.expired,
      errors7d,
      spendToday: round4(spendToday),
      spend7d: round4(spend7d),
      spend30d: round4(spend30d),
      spendTotal: round4(spendTotal),
      spendUnattributed: round4(spendUnattributed),
      spendBenchExcluded: round4(spendBench),
    },
    users: rows,
  };
}

/* ------------------------------ Сортировка таблицы ------------------------------ */

export type AdminUserSortKey = keyof Pick<
  AdminUserRow,
  | "email"
  | "registeredAt"
  | "lastLoginAt"
  | "lastActivityAt"
  | "accessStatus"
  | "activeDays7d"
  | "activeDays30d"
  | "deepAnalyses30d"
  | "estimates30d"
  | "liveSearches30d"
  | "errors7d"
  | "spend30d"
  | "spendTotal"
>;

/** Порядок статусов при сортировке: сначала те, кому нужно внимание (истёк), потом платящие. */
const ACCESS_ORDER: Record<AccessStatus, number> = { expired: 0, trial: 1, paid: 2, admin: 3 };

/** Сортировка строк; пустые значения всегда в конце, при равенстве — по почте. Исходный массив не меняется. */
export function sortAdminUsers(
  rows: readonly AdminUserRow[],
  key: AdminUserSortKey,
  direction: "asc" | "desc",
): AdminUserRow[] {
  const sign = direction === "asc" ? 1 : -1;
  const value = (row: AdminUserRow): number | string | null => {
    const raw = row[key];
    if (key === "accessStatus") return ACCESS_ORDER[row.accessStatus];
    if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw)) return Date.parse(raw);
    return raw;
  };
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === null && right === null) return a.email.localeCompare(b.email);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left < right) return -sign;
    if (left > right) return sign;
    return a.email.localeCompare(b.email);
  });
}

/* ------------------------------ Журнал одного пользователя ------------------------------ */

export interface JournalItem {
  at: string;
  /** Вид для значка: вид события или «analysis_job» / «sync_job» для упавшего задания. */
  kind: string;
  /** Готовая русская подпись действия. */
  label: string;
  ok: boolean;
  tenderId: string | null;
  detail: string | null;
  source: "event" | "analysis_job" | "sync_job";
}

export interface JournalEventRecord {
  created_at: string;
  kind: string;
  ok: boolean;
  tender_id: string | null;
  detail: string | null;
}

export interface JournalFailedJob {
  source: "analysis" | "sync";
  /** Вид задания очереди (estimate, documents, full_sync); у разбора не нужен. */
  kind?: string;
  tender_id: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

const SYNC_FAILED_LABELS: Record<string, string> = {
  estimate: "Смета не рассчитана",
  documents: "Загрузка документации не удалась",
  full_sync: "Поиск закупок не выполнен",
};

/** Журнал одного человека: его события и упавшие задания, новые сверху, не больше `limit`. */
export function buildUserJournal(
  events: readonly JournalEventRecord[],
  failedJobs: readonly JournalFailedJob[],
  limit = 200,
): JournalItem[] {
  const items: JournalItem[] = [];
  for (const event of events) {
    items.push({
      at: event.created_at,
      kind: event.kind,
      label: userEventLabel(event.kind),
      ok: event.ok,
      tenderId: event.tender_id,
      detail: event.detail,
      source: "event",
    });
  }
  for (const job of failedJobs) {
    items.push({
      at: job.finished_at ?? job.created_at,
      kind: job.source === "analysis" ? "analysis_job" : "sync_job",
      label: job.source === "analysis" ? "Глубокий анализ не выполнен" : (SYNC_FAILED_LABELS[job.kind ?? ""] ?? "Задание не выполнено"),
      ok: false,
      tenderId: job.tender_id,
      detail: job.error,
      source: job.source === "analysis" ? "analysis_job" : "sync_job",
    });
  }
  items.sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
  return items.slice(0, limit);
}
