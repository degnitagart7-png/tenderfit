import { isAdminEmail, resolveAccess, type AccessStatus } from "@/domain/access";

/**
 * Воронка клиентов для админ-панели (/admin/users): где на пилоте теряются люди.
 *
 * Чистый модуль без базы и часов: факты читает репозиторий, время приходит
 * параметром. Так правила («что считать шагом», «кто застрял») проверяются тестом
 * на выдуманных людях, а не на живой базе.
 *
 * Как считается шаг. Журнал действий (`user_events`) ведётся только с 14.10.2026,
 * а профили, разборы и сметы были и раньше, поэтому у части людей «открыл ленту»
 * в журнале нет, хотя глубокий анализ они запускали. Чтобы воронка не рассыпалась,
 * человек, у которого есть признак позднего шага, считается прошедшим и все
 * предыдущие: кто посчитал смету — тот и профиль завёл, и закупку открывал; кто
 * оплатил — тот прошёл всё. Шаг человека — это самый поздний из шагов с признаком.
 * Отсюда числа по шагам не растут слева направо, а «застряли здесь» (дошёл до шага,
 * но не до следующего) — непересекающиеся группы, в сумме дающие всех
 * зарегистрировавшихся. Это и есть список «кому позвонить».
 *
 * Администраторы (ADMIN_EMAILS) в воронку не входят: они пользуются сервисом иначе
 * и исказили бы картину пилота.
 */

const DAY_MS = 86_400_000;

export type FunnelPeriod = "all" | "7d" | "30d";
export const FUNNEL_PERIODS: readonly FunnelPeriod[] = ["all", "7d", "30d"];

export function parseFunnelPeriod(raw: string | null | undefined): FunnelPeriod | null {
  if (raw === null || raw === undefined || raw === "") return "all";
  return (FUNNEL_PERIODS as readonly string[]).includes(raw) ? (raw as FunnelPeriod) : null;
}

const PERIOD_DAYS: Record<FunnelPeriod, number | null> = { all: null, "7d": 7, "30d": 30 };

export const FUNNEL_PERIOD_LABELS: Record<FunnelPeriod, string> = {
  all: "Все",
  "7d": "За 7 дней",
  "30d": "За 30 дней",
};

/** Пользователь как в `app_users` (подмножество `AdminUserRecord`). */
export interface FunnelUserRecord {
  id: string;
  email: string;
  created_at: string;
  last_login_at: string | null;
  trial_ends_at: string | null;
  paid_until: string | null;
  plan: string | null;
}

/** Что известно о данных аккаунта (`user_data`), уже свёрнутое репозиторием в признаки. */
export interface FunnelProfileFact {
  userId: string;
  /** Есть хотя бы один профиль поиска с непустыми ключевыми словами. */
  hasSearchProfile: boolean;
  /** Анкета компании: заполнено название или описание деятельности. */
  hasCompanyProfile: boolean;
  onboardingDone: boolean;
  tourDone: boolean;
}

/** Событие журнала, свёрнутое до «последний раз такое действие было тогда-то». */
export interface FunnelEventFact {
  email: string;
  kind: string;
  ok: boolean;
  /** Время последнего такого события (ISO). */
  lastAt: string;
}

export interface FunnelFacts {
  profiles: readonly FunnelProfileFact[];
  events: readonly FunnelEventFact[];
  /** Почты, у которых есть завершённый глубокий анализ (`analysis_jobs`). */
  analysisDoneEmails: readonly string[];
  /** Почты, у которых есть завершённый расчёт сметы (`sync_jobs`, kind = estimate). */
  estimateDoneEmails: readonly string[];
}

export type FunnelStepKey = "registered" | "profile" | "feed" | "tender" | "analysis" | "estimate" | "paid";

interface StepDefinition {
  key: FunnelStepKey;
  label: string;
}

export const FUNNEL_STEPS: readonly StepDefinition[] = [
  { key: "registered", label: "Зарегистрировались" },
  { key: "profile", label: "Заполнили профиль поиска" },
  { key: "feed", label: "Открыли ленту или искали" },
  { key: "tender", label: "Открыли закупку" },
  { key: "analysis", label: "Запустили глубокий анализ" },
  { key: "estimate", label: "Посчитали смету" },
  { key: "paid", label: "Оплатили" },
];

const FEED_KINDS = new Set(["feed_open", "live_search", "find_new", "link_import"]);

export type FunnelAccessStatus = Exclude<AccessStatus, "admin">;

export interface FunnelUserRow {
  email: string;
  registeredAt: string;
  /** Индекс самого позднего достигнутого шага (0 — только зарегистрировался). */
  reachedStep: number;
  reachedLabel: string;
  /** Максимум из последнего входа и последнего действия в журнале; null — не заходил. */
  lastActivityAt: string | null;
  /** Осталось полных суток пробного периода; null — не пробный. */
  trialDaysLeft: number | null;
  status: FunnelAccessStatus;
  hasSearchProfile: boolean;
  hasCompanyProfile: boolean;
  onboardingDone: boolean;
  tourDone: boolean;
}

export interface FunnelStep {
  key: FunnelStepKey;
  label: string;
  /** Сколько людей дошло до шага (с учётом тех, кто ушёл дальше). */
  count: number;
  /** Доля от зарегистрировавшихся, 0..1. */
  shareOfRegistered: number;
  /** Доля от предыдущего шага, 0..1; у первого шага — 1 (или 0, если людей нет). */
  shareOfPrevious: number;
  /** Все, кто дошёл до шага. */
  emails: string[];
  /** Дошли до шага, но не до следующего: кому позвонить. У последнего шага пусто. */
  stuckEmails: string[];
}

export interface FunnelReport {
  period: FunnelPeriod;
  registered: number;
  steps: FunnelStep[];
  /** Все люди воронки; по `email` из шагов находится строка с подробностями. */
  users: FunnelUserRow[];
}

const norm = (email: string): string => email.trim().toLowerCase();

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Оплатил: срок оплаты в будущем или пакет, отличный от пробного, — оплата была, даже если уже истекла. */
export function hasPaid(user: Pick<FunnelUserRecord, "paid_until" | "plan">, nowMs: number): boolean {
  const paidUntil = parseMs(user.paid_until);
  if (paidUntil !== null && paidUntil > nowMs) return true;
  const plan = (user.plan ?? "").trim().toLowerCase();
  return plan !== "" && plan !== "trial";
}

export function buildFunnel(
  users: readonly FunnelUserRecord[],
  facts: FunnelFacts,
  now: number,
  period: FunnelPeriod = "all",
  env: Record<string, string | undefined> = process.env,
): FunnelReport {
  const days = PERIOD_DAYS[period];
  const since = days === null ? null : now - days * DAY_MS;

  const profileByUser = new Map(facts.profiles.map((p) => [p.userId, p]));
  const analysisDone = new Set(facts.analysisDoneEmails.map(norm));
  const estimateDone = new Set(facts.estimateDoneEmails.map(norm));

  const eventsByEmail = new Map<string, FunnelEventFact[]>();
  for (const event of facts.events) {
    const key = norm(event.email);
    const list = eventsByEmail.get(key);
    if (list) list.push(event);
    else eventsByEmail.set(key, [event]);
  }

  const rows: FunnelUserRow[] = [];
  for (const user of users) {
    const email = norm(user.email);
    if (email === "" || isAdminEmail(email, env)) continue;
    if (since !== null) {
      const registered = parseMs(user.created_at);
      if (registered === null || registered < since) continue;
    }

    const profile = profileByUser.get(user.id);
    const events = eventsByEmail.get(email) ?? [];
    const done = (predicate: (event: FunnelEventFact) => boolean) => events.some(predicate);

    // Признак каждого шага; индекс 0 («зарегистрировались») есть у всех.
    const signals = [
      true,
      profile?.hasSearchProfile === true,
      done((e) => FEED_KINDS.has(e.kind)),
      done((e) => e.kind === "tender_open"),
      done((e) => e.kind === "deep_analysis" && e.ok) || analysisDone.has(email),
      done((e) => e.kind === "estimate" && e.ok) || estimateDone.has(email),
      hasPaid(user, now),
    ];
    let reachedStep = 0;
    signals.forEach((signal, index) => {
      if (signal) reachedStep = index;
    });

    const access = resolveAccess(
      { trialEndsAt: parseMs(user.trial_ends_at), paidUntil: parseMs(user.paid_until), plan: user.plan },
      email,
      now,
      env,
    );
    // Админы отсеяны выше, но тип шире: «admin» сюда прийти не может.
    const status: FunnelAccessStatus = access.status === "admin" ? "expired" : access.status;

    let lastActivityMs = parseMs(user.last_login_at);
    for (const event of events) {
      const at = parseMs(event.lastAt);
      if (at !== null && (lastActivityMs === null || at > lastActivityMs)) lastActivityMs = at;
    }

    rows.push({
      email,
      registeredAt: user.created_at,
      reachedStep,
      reachedLabel: FUNNEL_STEPS[reachedStep]?.label ?? "",
      lastActivityAt: lastActivityMs === null ? null : new Date(lastActivityMs).toISOString(),
      trialDaysLeft: status === "trial" ? access.daysLeft : null,
      status,
      hasSearchProfile: profile?.hasSearchProfile === true,
      hasCompanyProfile: profile?.hasCompanyProfile === true,
      onboardingDone: profile?.onboardingDone === true,
      tourDone: profile?.tourDone === true,
    });
  }

  // Кому звонить — сверху: свежая активность раньше давней, не заходившие в конце.
  rows.sort((a, b) => {
    const left = parseMs(a.lastActivityAt) ?? -Infinity;
    const right = parseMs(b.lastActivityAt) ?? -Infinity;
    return right - left || a.email.localeCompare(b.email);
  });

  const registered = rows.length;
  const steps: FunnelStep[] = FUNNEL_STEPS.map((definition, index) => {
    const reached = rows.filter((row) => row.reachedStep >= index);
    const stuck = rows.filter((row) => row.reachedStep === index && index < FUNNEL_STEPS.length - 1);
    const previous = index === 0 ? registered : rows.filter((row) => row.reachedStep >= index - 1).length;
    return {
      key: definition.key,
      label: definition.label,
      count: reached.length,
      shareOfRegistered: registered === 0 ? 0 : reached.length / registered,
      shareOfPrevious: previous === 0 ? 0 : reached.length / previous,
      emails: reached.map((row) => row.email),
      stuckEmails: stuck.map((row) => row.email),
    };
  });

  return { period, registered, steps, users: rows };
}
