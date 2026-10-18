/**
 * Оповещение владельцу о том, что баланс языковой модели кончается или кончился.
 *
 * Зачем. Дважды баланс routerai.ru заканчивался молча: глубокий анализ и ИИ-смета
 * просто переставали работать, а узнавали об этом по жалобам. Здесь — чистая
 * логика решения «писать ли письмо» и текст письма; сеть, файл состояния и
 * почта живут в src/services/llmBalanceAlert.ts, чтобы правила проверялись
 * тестами без обращений наружу.
 *
 * Состояния: ok (денег хватает), low (ниже порога, ещё работает), empty (≤ 0
 * или шлюз ответил 402). Письмо уходит:
 *   · на переходе ok → low и ok/low → empty — сразу;
 *   · пока состояние low/empty не меняется — напоминанием раз в 24 часа;
 *   · после пополнения (low/empty → ok) — одним коротким «баланс пополнен».
 * Переход empty → low (пополнили, но мало) молчит: денег снова хватает на работу,
 * а напоминание о «низком» придёт по обычному суточному расписанию.
 */

export type BalanceState = "ok" | "low" | "empty";

/** Порог «мало» по умолчанию, ₽: на два-три дня обычной работы. */
export const DEFAULT_LOW_BALANCE_RUB = 150;

/** Через сколько напоминать, пока баланс не пополнен. */
export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Сайт, где пополняется баланс. Глубокие пути не выдумываем: они меняются. */
export const TOP_UP_URL = "https://routerai.ru";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Что помним между проверками (хранится в data/llm-balance-alert.json). */
export interface AlertMemory {
  /** Состояние на момент последней проверки. */
  state: BalanceState;
  /** Когда ушло последнее письмо, мс; null — писем не было. */
  lastSentAt: number | null;
}

export const FRESH_ALERT_MEMORY: AlertMemory = { state: "ok", lastSentAt: null };

export type AlertAction = "none" | "low" | "empty" | "reminder" | "recovered";

export interface AlertDecision {
  action: AlertAction;
  /** Текущее состояние баланса. */
  state: BalanceState;
  /**
   * Память после проверки. Для действий с письмом её записывают только после
   * успешной отправки: упавшая почта не должна «съесть» оповещение.
   */
  next: AlertMemory;
}

export interface AlertConfig {
  /** Куда писать; null — оповещения выключены. */
  email: string | null;
  /** Ниже этого баланса (₽) состояние low. */
  lowRub: number;
}

type Env = Record<string, string | undefined>;

/** Настройки из окружения; кривой порог заменяется значением по умолчанию. */
export function resolveAlertConfig(env: Env = process.env): AlertConfig {
  const email = env["ALERT_EMAIL"]?.trim() ?? "";
  const rawThreshold = env["LLM_BALANCE_ALERT_RUB"]?.trim() ?? "";
  const parsed = rawThreshold === "" ? Number.NaN : Number(rawThreshold.replace(",", "."));
  return {
    email: email === "" ? null : email,
    lowRub: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LOW_BALANCE_RUB,
  };
}

/** Состояние по балансу в рублях. */
export function classifyBalance(balanceRub: number, lowRub: number): BalanceState {
  if (balanceRub <= 0) return "empty";
  if (balanceRub < lowRub) return "low";
  return "ok";
}

/**
 * Достаёт баланс из ответа `GET {LLM_BASE_URL}/credits`: `{"data":{"credits":-0.0135}}`,
 * кредиты — в рублях. Минус — это нормально (шлюз уходит в долг на последнем
 * запросе), а вот не-200, чужой формат и нечисловое значение — «баланс неизвестен»
 * (null): по такому ответу нельзя ни оповещать, ни успокаивать.
 */
export function parseCreditsResponse(status: number, body: unknown): number | null {
  if (status !== 200) return null;
  if (body === null || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return null;
  const raw = (data as { credits?: unknown }).credits;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Читает файл состояния; битый, пустой или чужой формат — чистое состояние. */
export function parseAlertMemory(raw: string | null): AlertMemory {
  if (raw === null) return { ...FRESH_ALERT_MEMORY };
  try {
    const data = JSON.parse(raw) as Partial<AlertMemory> | null;
    if (data === null || typeof data !== "object") return { ...FRESH_ALERT_MEMORY };
    const { state, lastSentAt } = data;
    if (state !== "ok" && state !== "low" && state !== "empty") return { ...FRESH_ALERT_MEMORY };
    const sentAt = typeof lastSentAt === "number" && Number.isFinite(lastSentAt) ? lastSentAt : null;
    return { state, lastSentAt: sentAt };
  } catch {
    return { ...FRESH_ALERT_MEMORY };
  }
}

/**
 * Решает, писать ли письмо.
 *
 * Не пишет дважды за один переход: после письма память хранит новое состояние, и
 * следующая проверка с тем же состоянием отвечает «ничего» до истечения суток.
 */
export function decideAlert(memory: AlertMemory, state: BalanceState, nowMs: number): AlertDecision {
  const sent = (action: AlertAction): AlertDecision => ({
    action,
    state,
    next: { state, lastSentAt: nowMs },
  });
  const quiet: AlertDecision = { action: "none", state, next: { state, lastSentAt: memory.lastSentAt } };

  if (state === "ok") {
    return memory.state === "ok" ? quiet : sent("recovered");
  }
  if (state === "empty") {
    return memory.state === "empty" ? remind(memory, nowMs, sent, quiet) : sent("empty");
  }
  // state === "low"
  if (memory.state === "ok") return sent("low");
  if (memory.state === "empty") return quiet;
  return remind(memory, nowMs, sent, quiet);
}

function remind(
  memory: AlertMemory,
  nowMs: number,
  sent: (action: AlertAction) => AlertDecision,
  quiet: AlertDecision,
): AlertDecision {
  // Нет отметки о письме (файл правили руками) — напомнить сразу.
  if (memory.lastSentAt === null || nowMs - memory.lastSentAt >= REMINDER_INTERVAL_MS) {
    return sent("reminder");
  }
  return quiet;
}

/* ============================ Расход ============================ */

export interface SpendRow {
  created_at: string;
  cost_rub: number;
}

export interface SpendSummary {
  last24hRub: number;
  last7dRub: number;
}

/** Расход в рублях за последние 24 часа и 7 суток по строкам llm_usage_log. */
export function summarizeSpend(rows: readonly SpendRow[], nowMs: number): SpendSummary {
  let day = 0;
  let week = 0;
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at) || !Number.isFinite(row.cost_rub)) continue;
    const age = nowMs - at;
    if (age < 0 || age > 7 * DAY_MS) continue;
    week += row.cost_rub;
    if (age <= DAY_MS) day += row.cost_rub;
  }
  return { last24hRub: day, last7dRub: week };
}

/**
 * На сколько суток хватит баланса при среднем расходе за неделю; null, если
 * считать не из чего (расхода не было или баланс не положительный).
 */
export function estimateDaysLeft(balanceRub: number | null, spend7dRub: number | null): number | null {
  if (balanceRub === null || spend7dRub === null) return null;
  if (balanceRub <= 0 || spend7dRub <= 0) return null;
  return balanceRub / (spend7dRub / 7);
}

/* ============================ Письмо ============================ */

export interface AlertEmailContext {
  /** Баланс, ₽; null — узнать не удалось (например, 402 при недоступном /credits). */
  balanceRub: number | null;
  lowRub: number;
  /** Расход; null — журнал недоступен, строки о расходе опускаются. */
  spend: SpendSummary | null;
}

export interface AlertEmail {
  subject: string;
  text: string;
}

/** «87,12 ₽»: запятая, два знака, без неразрывных пробелов — письмо читают и в логах. */
export function formatRub(value: number): string {
  return `${value.toFixed(2).replace(".", ",")} ₽`;
}

function wholeRub(value: number): string {
  return `${String(Math.round(value))} ₽`;
}

function daysPhrase(days: number): string {
  if (days < 1) return "меньше суток";
  return `примерно на ${String(Math.floor(days))} дн.`;
}

/** Что перестанет работать без денег на балансе. */
const FEATURES_LINES = [
  "— глубокий анализ закупки;",
  "— смета без сметы заказчика: чтение ведомостей и подбор норм ИИ;",
  "— подсказки поиска.",
];

function spendLines(ctx: AlertEmailContext, withForecast: boolean): string[] {
  if (ctx.spend === null) return [];
  const lines = [
    `Расход за 24 часа: ${formatRub(ctx.spend.last24hRub)}`,
    `Расход за 7 дней: ${formatRub(ctx.spend.last7dRub)}` +
      (ctx.spend.last7dRub > 0 ? ` (в среднем ${formatRub(ctx.spend.last7dRub / 7)} в день)` : ""),
  ];
  if (withForecast) {
    const days = estimateDaysLeft(ctx.balanceRub, ctx.spend.last7dRub);
    if (days !== null) lines.push(`При таком расходе хватит ${daysPhrase(days)}`);
  }
  return lines;
}

function balanceLine(ctx: AlertEmailContext): string {
  return ctx.balanceRub === null
    ? "Баланс ИИ на routerai.ru: узнать не удалось, шлюз отвечает «недостаточно средств»."
    : `Баланс ИИ на routerai.ru: ${formatRub(ctx.balanceRub)}.`;
}

/**
 * Тема и текст письма. Письмо короткое: цифра баланса, расход, что остановится и
 * куда идти. Повторное письмо (`reminder`) отличается только пометкой в теме.
 */
export function buildAlertEmail(action: Exclude<AlertAction, "none">, state: BalanceState, ctx: AlertEmailContext): AlertEmail {
  const bal = ctx.balanceRub;
  if (action === "recovered") {
    return {
      subject: `ТендерФит: баланс ИИ пополнен${bal === null ? "" : ` — ${wholeRub(bal)}`}`,
      text: [balanceLine(ctx), "", "Анализ закупок, смета с ИИ и подсказки поиска снова работают."].join("\n"),
    };
  }

  const reminder = action === "reminder" ? " (напоминание)" : "";
  if (state === "empty") {
    return {
      subject: `ТендерФит: баланс ИИ закончился — анализ и смета с ИИ не работают${reminder}`,
      text: [
        balanceLine(ctx),
        ...(ctx.spend === null ? [] : ["", ...spendLines(ctx, false)]),
        "",
        "Пока баланс не пополнен, не работают:",
        ...FEATURES_LINES,
        "",
        `Пополнить: ${TOP_UP_URL}`,
      ].join("\n"),
    };
  }

  const subjectBalance = bal === null ? "" : ` — ${wholeRub(bal)}`;
  return {
    subject: `ТендерФит: баланс ИИ почти закончился${subjectBalance}${reminder}`,
    text: [
      `${balanceLine(ctx)} Порог оповещения — ${wholeRub(ctx.lowRub)}.`,
      ...(ctx.spend === null ? [] : ["", ...spendLines(ctx, true)]),
      "",
      "Когда баланс закончится, перестанут работать:",
      ...FEATURES_LINES,
      "",
      `Пополнить: ${TOP_UP_URL}`,
    ].join("\n"),
  };
}
