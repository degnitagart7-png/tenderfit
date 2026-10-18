import type { LlmPurpose, LlmUsageRow } from "@/repositories/llmUsageRepository";

/**
 * Свод расхода на модель по строкам журнала llm_usage_log.
 *
 * Чистые функции без базы и сети: считаются и в скрипте отчёта, и в API-роуте
 * для карточки админки, а проверяются тестом на подменённых строках.
 */

export interface PurposeTotals {
  purpose: LlmPurpose;
  calls: number;
  failedCalls: number;
  costRub: number;
  promptTokens: number;
  completionTokens: number;
}

/** Расход на одну единицу работы: закупка в рамках задания. */
export interface WorkUnitCost {
  tenderId: string | null;
  jobId: string | null;
  costRub: number;
  calls: number;
  inputChars: number;
}

export interface WorkUnitStats {
  /** Сколько единиц работы (анализов, смет) попало в период. */
  count: number;
  avgRub: number;
  medianRub: number;
  p90Rub: number;
  maxRub: number;
  totalRub: number;
  /** Средний объём текста, ушедший в модель на одну единицу, знаков. */
  avgInputChars: number;
  /** Самые дорогие единицы, по убыванию. */
  top: WorkUnitCost[];
}

export interface LlmCostSummary {
  from: string | null;
  to: string | null;
  /** Сколько суток в периоде: знаменатель «в среднем в день». */
  days: number;
  byPurpose: PurposeTotals[];
  deepAnalysis: WorkUnitStats;
  estimateBill: WorkUnitStats;
  totalRub: number;
  totalCalls: number;
  avgPerDayRub: number;
}

const DAY_MS = 86_400_000;
const TOP_SIZE = 5;

/** Медиана: при чётном числе значений — среднее двух средних. */
export function median(sortedAscending: readonly number[]): number {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? sortedAscending[mid]!
    : (sortedAscending[mid - 1]! + sortedAscending[mid]!) / 2;
}

/** Перцентиль по методу ближайшего ранга: p90 из десяти значений — девятое. */
export function percentile(sortedAscending: readonly number[], p: number): number {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)));
  return sortedAscending[rank - 1]!;
}

function emptyStats(): WorkUnitStats {
  return {
    count: 0,
    avgRub: 0,
    medianRub: 0,
    p90Rub: 0,
    maxRub: 0,
    totalRub: 0,
    avgInputChars: 0,
    top: [],
  };
}

/** Единица работы — пара (закупка, задание): все её вызовы суммируются. */
function workUnits(rows: readonly LlmUsageRow[], purpose: LlmPurpose): WorkUnitCost[] {
  const units = new Map<string, WorkUnitCost>();
  for (const row of rows) {
    if (row.purpose !== purpose) continue;
    const key = `${row.tender_id ?? ""}\u0000${row.job_id ?? ""}`;
    const unit = units.get(key) ?? {
      tenderId: row.tender_id,
      jobId: row.job_id,
      costRub: 0,
      calls: 0,
      inputChars: 0,
    };
    unit.costRub += row.cost_rub;
    unit.calls += 1;
    unit.inputChars += row.input_chars;
    units.set(key, unit);
  }
  return [...units.values()];
}

export function workUnitStats(rows: readonly LlmUsageRow[], purpose: LlmPurpose): WorkUnitStats {
  const units = workUnits(rows, purpose);
  if (units.length === 0) return emptyStats();

  const costs = units.map((unit) => unit.costRub).sort((a, b) => a - b);
  const total = costs.reduce((sum, value) => sum + value, 0);
  const chars = units.reduce((sum, unit) => sum + unit.inputChars, 0);

  return {
    count: units.length,
    avgRub: total / units.length,
    medianRub: median(costs),
    p90Rub: percentile(costs, 90),
    maxRub: costs[costs.length - 1]!,
    totalRub: total,
    avgInputChars: chars / units.length,
    top: [...units].sort((a, b) => b.costRub - a.costRub).slice(0, TOP_SIZE),
  };
}

/**
 * Сколько суток в периоде. Границы не заданы — берутся из данных; без строк и
 * границ — одни сутки, чтобы не делить на ноль. Неполные сутки округляются вверх.
 */
function periodDays(rows: readonly LlmUsageRow[], since: Date | null, until: Date | null): number {
  const times = rows.map((row) => Date.parse(row.created_at)).filter(Number.isFinite);
  const start = since?.getTime() ?? (times.length > 0 ? Math.min(...times) : null);
  const end = until?.getTime() ?? (times.length > 0 ? Math.max(...times) : null);
  if (start === null || end === null || end <= start) return 1;
  return Math.max(1, Math.ceil((end - start) / DAY_MS));
}

export function summarizeLlmUsage(
  rows: readonly LlmUsageRow[],
  period: { since?: Date | null; until?: Date | null } = {},
): LlmCostSummary {
  const since = period.since ?? null;
  const until = period.until ?? null;

  const totals = new Map<LlmPurpose, PurposeTotals>();
  for (const row of rows) {
    const entry = totals.get(row.purpose) ?? {
      purpose: row.purpose,
      calls: 0,
      failedCalls: 0,
      costRub: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
    entry.calls += 1;
    if (!row.ok) entry.failedCalls += 1;
    entry.costRub += row.cost_rub;
    entry.promptTokens += row.prompt_tokens;
    entry.completionTokens += row.completion_tokens;
    totals.set(row.purpose, entry);
  }

  const byPurpose = [...totals.values()].sort((a, b) => b.costRub - a.costRub);
  const totalRub = byPurpose.reduce((sum, entry) => sum + entry.costRub, 0);
  const totalCalls = byPurpose.reduce((sum, entry) => sum + entry.calls, 0);
  const days = periodDays(rows, since, until);

  return {
    from: since?.toISOString() ?? null,
    to: until?.toISOString() ?? null,
    days,
    byPurpose,
    deepAnalysis: workUnitStats(rows, "deep_analysis"),
    estimateBill: workUnitStats(rows, "estimate_bill"),
    totalRub,
    totalCalls,
    avgPerDayRub: totalRub / days,
  };
}

/* ============================ Текстовый отчёт ============================ */

const PURPOSE_LABELS: Record<string, string> = {
  deep_analysis: "глубокий анализ (deep_analysis)",
  estimate_bill: "смета, ведомость (estimate_bill)",
  estimate_norm_pick: "смета, подбор норм ИИ (estimate_norm_pick)",
  estimate_implied: "смета, работы по технологии ИИ (estimate_implied)",
  search_assist: "помощник поиска (search_assist)",
  rerank: "оценка по смыслу (rerank)",
  other: "прочее (other)",
};

/** Рубли с копейками: «12,34 ₽». */
export function formatRub(value: number): string {
  return `${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("ru-RU");
}

function unitSection(title: string, noun: string, stats: WorkUnitStats, withTop: boolean): string[] {
  const lines = [title];
  if (stats.count === 0) {
    lines.push(`  ${noun}: нет данных за период`);
    return lines;
  }
  lines.push(
    `  ${noun}: ${formatInt(stats.count)}`,
    `  среднее:   ${formatRub(stats.avgRub)}`,
    `  медиана:   ${formatRub(stats.medianRub)}`,
    `  p90:       ${formatRub(stats.p90Rub)}`,
    `  максимум:  ${formatRub(stats.maxRub)}`,
    `  средний объём текста: ${formatInt(stats.avgInputChars)} знаков`,
  );
  if (withTop && stats.top.length > 0) {
    lines.push("  самые дорогие закупки:");
    for (const unit of stats.top) {
      lines.push(
        `    ${formatRub(unit.costRub)}  ${unit.tenderId ?? "без закупки"}` +
          `${unit.jobId ? `  (задание ${unit.jobId})` : ""}  вызовов ${unit.calls}`,
      );
    }
  }
  return lines;
}

/** Отчёт для консоли: по видам работ, по закупкам, итог. */
export function formatLlmCostReport(summary: LlmCostSummary): string {
  const lines: string[] = [];
  lines.push(
    `Расход на ИИ за период: ${summary.from ? summary.from.slice(0, 10) : "с первого вызова"} — ` +
      `${summary.to ? `${summary.to.slice(0, 10)} (не включая)` : "по сегодня"}, ${summary.days} дн.`,
    "",
    "По видам работ:",
  );
  if (summary.byPurpose.length === 0) lines.push("  вызовов нет");
  for (const entry of summary.byPurpose) {
    lines.push(
      `  ${PURPOSE_LABELS[entry.purpose] ?? entry.purpose}: вызовов ${formatInt(entry.calls)}` +
        `${entry.failedCalls > 0 ? ` (с ошибкой ${formatInt(entry.failedCalls)})` : ""}, ` +
        `${formatRub(entry.costRub)}, токены: вход ${formatInt(entry.promptTokens)}, выход ${formatInt(entry.completionTokens)}`,
    );
  }
  lines.push(
    "",
    ...unitSection("Глубокий анализ на одну закупку (сумма вызовов по закупке и заданию):", "анализов", summary.deepAnalysis, true),
    "",
    ...unitSection("Смета, извлечение ведомости на одну закупку:", "расчётов", summary.estimateBill, true),
    "",
    `Итого за период: ${formatRub(summary.totalRub)} (вызовов ${formatInt(summary.totalCalls)})`,
    `В среднем в день: ${formatRub(summary.avgPerDayRub)}`,
  );
  return lines.join("\n");
}

/**
 * Дата из аргумента командной строки (YYYY-MM-DD, UTC). Для верхней границы
 * `inclusiveEnd` берёт начало следующих суток: день, указанный в --until,
 * входит в отчёт целиком.
 */
export function parseReportDate(value: string, inclusiveEnd: boolean): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Дата «${value}» не в формате YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Нет такой даты: ${value}`);
  return inclusiveEnd ? new Date(date.getTime() + DAY_MS) : date;
}
