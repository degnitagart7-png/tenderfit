import { llmUsageRepository, type LlmPurpose } from "@/repositories/llmUsageRepository";
import { computeCost, parseUsage, type UsdRubProvider } from "@/services/llmCost";

/**
 * Учёт одного вызова языковой модели: токены, стоимость в рублях, привязка к
 * закупке и заданию. Вызывается из каждой точки, где код ходит в шлюз.
 *
 * Правило одно: учёт не роняет работу. Любой сбой (нет таблицы, база недоступна,
 * курс ЦБ не ответил) уходит в консоль, а анализ идёт дальше.
 */

/** Контекст вызова: зачем он сделан и к чему относится. */
export interface LlmCallContext {
  purpose: LlmPurpose;
  /** Реестровый номер закупки. */
  tenderId?: string | null;
  /** analysis_jobs.id или sync_jobs.id. */
  jobId?: string | null;
  userId?: string | null;
}

export interface LlmCallOutcome {
  model: string;
  /** Объект usage из ответа шлюза как есть; нет — токены считаются нулевыми. */
  usage?: unknown;
  /** Размер запроса в знаках. */
  inputChars: number;
  ok: boolean;
  error?: string | null;
}

/** Порты — для тестов: запись и курс подменяются. */
export interface LlmUsageDeps {
  record?: typeof llmUsageRepository.record;
  usdRub?: UsdRubProvider;
  env?: Record<string, string | undefined>;
}

/** Пишет строку журнала. Никогда не бросает. */
export async function recordLlmCall(
  context: LlmCallContext,
  outcome: LlmCallOutcome,
  deps: LlmUsageDeps = {},
): Promise<void> {
  try {
    const usage = parseUsage(outcome.usage, deps.env);
    const cost = await computeCost(usage, {
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.usdRub ? { usdRub: deps.usdRub } : {}),
    });
    const record = deps.record ?? llmUsageRepository.record;
    await record({
      purpose: context.purpose,
      tender_id: context.tenderId ?? null,
      job_id: context.jobId ?? null,
      user_id: context.userId ?? null,
      model: outcome.model,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      cost_rub: cost.costRub,
      cost_source: cost.costSource,
      provider_cost: cost.providerCost,
      provider_currency: cost.providerCurrency,
      usd_rub: cost.usdRub,
      input_chars: Math.max(0, Math.round(outcome.inputChars)),
      ok: outcome.ok,
      error: outcome.error ?? null,
    });
  } catch (err) {
    console.warn(
      `[llm-usage] учёт вызова не выполнен (${context.purpose}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Добавлять ли `usage: {include: true}` в запрос.
 *
 * Нужно шлюзам в формате OpenRouter. routerai.ru отдаёт usage.cost без параметра
 * (по документации моделей), а лишнее поле одни шлюзы прощают, другие отвечают
 * 400 — поэтому включается явно: LLM_USAGE_INCLUDE=1.
 */
export function usageIncludeFields(
  env: Record<string, string | undefined> = process.env,
): { usage: { include: true } } | Record<string, never> {
  const flag = (env["LLM_USAGE_INCLUDE"] ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" ? { usage: { include: true } } : {};
}
