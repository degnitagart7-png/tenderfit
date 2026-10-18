/**
 * Доступ к приложению: администратор, оплата, пробный период, истёк.
 *
 * Чистый модуль без базы, сети и часов: время приходит параметром, поэтому
 * правила доступа проверяются тестом, а не ожиданием трёх суток. Один модуль
 * нужен и серверу (ручки отвечают 402), и экрану (баннер, заглушка), и
 * воркеру (письма): три копии правил разошлись бы в первый же день.
 *
 * Приоритет: администратор (почта в ADMIN_EMAILS) > оплачено (paid_until в
 * будущем) > пробный период (trial_ends_at в будущем) > истёк. Даты, которых
 * нет, считаются прошедшими: аккаунт без срока — не бесплатный навсегда, а
 * закрытый, пока владелец не продлит его.
 */

/** Сколько дней длится бесплатный период. Меняется здесь или переменной TRIAL_DAYS. */
export const DEFAULT_TRIAL_DAYS = 7;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type AccessStatus = "admin" | "paid" | "trial" | "expired";

/** Что хранит база о сроках аккаунта. */
export interface UserAccessRecord {
  /** Конец пробного периода, мс от эпохи; null — не задан. */
  trialEndsAt: number | null;
  /** Оплачено до, мс от эпохи; null — оплат не было. */
  paidUntil: number | null;
  /** Пакет последней оплаты: «start», «calc», «premium». */
  plan: string | null;
}

export interface AccessInfo {
  status: AccessStatus;
  /**
   * Когда доступ кончается: конец оплаты или пробного периода (ISO-строка).
   * У администратора и у истёкшего — null: у первого срока нет, у второго он прошёл.
   */
  endsAt: string | null;
  /** Пакет, если оплачено; иначе null. */
  plan: string | null;
  /** Осталось полных суток (округление вверх), 0 — если доступа нет или срока нет. */
  daysLeft: number;
  /** Осталось полных часов (округление вверх), 0 — если доступа нет или срока нет. */
  hoursLeft: number;
}

/** Число дней пробного периода: TRIAL_DAYS из окружения или 3; нечисло и неположительное — по умолчанию. */
export function trialDays(env: Record<string, string | undefined> = process.env): number {
  const raw = (env["TRIAL_DAYS"] ?? "").trim();
  if (raw === "") return DEFAULT_TRIAL_DAYS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TRIAL_DAYS;
}

/** Конец пробного периода для аккаунта, заведённого в момент `nowMs`. */
export function trialEndsAtFor(nowMs: number, env: Record<string, string | undefined> = process.env): number {
  return nowMs + Math.round(trialDays(env) * DAY_MS);
}

/** Список почт администраторов из ADMIN_EMAILS (через запятую), без регистра и пробелов. */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ""),
  );
}

export function isAdminEmail(email: string, env: Record<string, string | undefined> = process.env): boolean {
  return parseAdminEmails(env["ADMIN_EMAILS"]).has(email.trim().toLowerCase());
}

/** Сколько осталось до `endMs`: полных суток и часов, округление вверх, не меньше нуля. */
export function timeLeft(endMs: number, nowMs: number): { daysLeft: number; hoursLeft: number } {
  const rest = Math.max(0, endMs - nowMs);
  return { daysLeft: Math.ceil(rest / DAY_MS), hoursLeft: Math.ceil(rest / HOUR_MS) };
}

/**
 * Решение о доступе.
 *
 * `record` отсутствует (null/undefined) — сервер не прислал сроков: доступ
 * закрыт, а не открыт, чтобы сбой чтения не раздавал платную часть даром.
 */
export function resolveAccess(
  record: UserAccessRecord | null | undefined,
  email: string,
  nowMs: number,
  env: Record<string, string | undefined> = process.env,
): AccessInfo {
  if (isAdminEmail(email, env)) {
    return { status: "admin", endsAt: null, plan: record?.plan ?? null, daysLeft: 0, hoursLeft: 0 };
  }
  const paidUntil = record?.paidUntil ?? null;
  if (paidUntil !== null && paidUntil > nowMs) {
    return {
      status: "paid",
      endsAt: new Date(paidUntil).toISOString(),
      plan: record?.plan ?? null,
      ...timeLeft(paidUntil, nowMs),
    };
  }
  const trialEndsAt = record?.trialEndsAt ?? null;
  if (trialEndsAt !== null && trialEndsAt > nowMs) {
    return {
      status: "trial",
      endsAt: new Date(trialEndsAt).toISOString(),
      plan: null,
      ...timeLeft(trialEndsAt, nowMs),
    };
  }
  return { status: "expired", endsAt: null, plan: record?.plan ?? null, daysLeft: 0, hoursLeft: 0 };
}

/** Можно ли пользоваться платной частью. */
export function hasAccess(info: Pick<AccessInfo, "status">): boolean {
  return info.status !== "expired";
}

/**
 * Страницы, которые открыты и после окончания пробного периода: оплата,
 * кабинет и настройки. Остальное закрыто заглушкой. Юридические страницы и
 * вход в приложение (AppShell) не входят, поэтому здесь не перечислены.
 */
const OPEN_WHEN_EXPIRED = ["/billing", "/account", "/settings"] as const;

export function isOpenWhenExpired(pathname: string): boolean {
  return OPEN_WHEN_EXPIRED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Подпись остатка: «2 дня», «1 день», «5 часов», «1 час». */
export function formatTimeLeft(info: Pick<AccessInfo, "daysLeft" | "hoursLeft">): string {
  if (info.daysLeft <= 1) return pluralRu(Math.max(1, info.hoursLeft), ["час", "часа", "часов"]);
  return pluralRu(info.daysLeft, ["день", "дня", "дней"]);
}

function pluralRu(n: number, forms: readonly [string, string, string]): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  let form = forms[2];
  if (mod100 < 11 || mod100 > 14) {
    if (mod10 === 1) form = forms[0];
    else if (mod10 >= 2 && mod10 <= 4) form = forms[1];
  }
  return `${String(n)} ${form}`;
}

/** Последние сутки пробного периода: баннер становится горчичным, и пора выбирать тариф. */
export function isLastDay(info: Pick<AccessInfo, "status" | "hoursLeft">): boolean {
  return info.status === "trial" && info.hoursLeft <= 24;
}

/**
 * Доступ «на сейчас» по снимку с сервера.
 *
 * Страница живёт дольше, чем длится последняя минута пробного периода: снимок
 * `/api/auth/me` устаревает, и баннер показывал бы «осталось 1 час» уже после
 * конца. Остаток пересчитывается по `endsAt`, а истёкший срок превращает
 * trial или paid в expired без нового запроса к серверу.
 */
export function effectiveAccess(info: AccessInfo, nowMs: number): AccessInfo {
  if (info.status === "admin" || info.status === "expired" || info.endsAt === null) return info;
  const end = Date.parse(info.endsAt);
  if (Number.isNaN(end)) return info;
  if (end <= nowMs) return { ...info, status: "expired", endsAt: null, daysLeft: 0, hoursLeft: 0 };
  return { ...info, ...timeLeft(end, nowMs) };
}
