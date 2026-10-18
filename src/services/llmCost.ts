/**
 * Стоимость одного вызова языковой модели в рублях.
 *
 * Источники по убыванию доверия:
 *  1. `usage.cost` из ответа шлюза. Российский routerai.ru считает в рублях и по
 *     своей документации отдаёт фактическую стоимость в поле `usage.cost`
 *     (проверено 2026-10-08 на страницах моделей routerai.ru: «Стоимость запроса
 *     в рублях» — `result["usage"]["cost"]`, отдельный параметр запроса не нужен).
 *     Для текстовых моделей этот факт в документации прямо не подтверждён, поэтому
 *     путь с таблицей цен обязателен как запасной.
 *  2. Таблица цен: токены × цена за миллион из окружения.
 *
 * Если шлюз отдал стоимость в долларах (другой провайдер с форматом OpenRouter),
 * она переводится по курсу ЦБ на дату вызова; курс сохраняется рядом со строкой.
 */

/**
 * Цены anthropic/claude-haiku-5.5 на routerai.ru, ₽ за миллион токенов (каталог API /api/v1/models, 2026-10-11):
 * вход 11 ₽, выход 55 ₽. До 2026-10-11 модель по умолчанию была google/gemini-2.5-flash (33 ₽ / 277 ₽): Google объявил её
 * устаревшей с отключением не раньше 16.10.2026. Русский текст Claude режет на токены примерно вдвое мельче Gemini, поэтому
 * реальная экономия на тех же документах — около трёх раз, а не пяти.
 * Обычно стоимость приходит от шлюза (`usage.cost`, ₽); таблица — запасной путь. Меняются на сайте без предупреждения:
 * актуальные значения — в LLM_PRICE_IN_RUB_PER_M и LLM_PRICE_OUT_RUB_PER_M.
 */
export const DEFAULT_PRICE_IN_RUB_PER_M = 11;
export const DEFAULT_PRICE_OUT_RUB_PER_M = 55;

export type CostSource = "provider" | "price_table";

/** То, что удалось прочитать из объекта usage ответа шлюза. */
export interface ParsedUsage {
  promptTokens: number;
  completionTokens: number;
  /** Стоимость как её назвал шлюз; null — не назвал. */
  providerCost: number | null;
  /** Валюта стоимости шлюза (RUB, USD); null, если стоимости нет. */
  providerCurrency: string | null;
}

export interface CostResult {
  /** Стоимость в рублях; 0 для вызова без токенов и без стоимости. */
  costRub: number;
  costSource: CostSource;
  providerCost: number | null;
  providerCurrency: string | null;
  /** Курс ЦБ, по которому пересчитан доллар; null — пересчёта не было. */
  usdRub: number | null;
}

type Env = Record<string, string | undefined>;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Читает usage из ответа. Принимает что угодно: ответ чужого шлюза и ответ с
 * ошибкой не должны ронять учёт.
 *
 * Валюта берётся из `usage.currency` или `usage.cost_currency`, иначе из
 * LLM_COST_CURRENCY, иначе RUB: российский шлюз считает в рублях.
 */
export function parseUsage(raw: unknown, env: Env = process.env): ParsedUsage {
  const usage = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const prompt = finiteNumber(usage["prompt_tokens"]) ?? finiteNumber(usage["input_tokens"]) ?? 0;
  const total = finiteNumber(usage["total_tokens"]);
  let completion =
    finiteNumber(usage["completion_tokens"]) ?? finiteNumber(usage["output_tokens"]);
  if (completion === null) completion = total !== null ? Math.max(0, total - prompt) : 0;

  const rawCost = finiteNumber(usage["cost"]);
  const cost = rawCost !== null && rawCost >= 0 ? rawCost : null;
  const currencyRaw =
    (typeof usage["currency"] === "string" ? usage["currency"] : null) ??
    (typeof usage["cost_currency"] === "string" ? usage["cost_currency"] : null) ??
    env["LLM_COST_CURRENCY"] ??
    "RUB";
  const currency = currencyRaw.trim().toUpperCase() || "RUB";

  return {
    promptTokens: Math.max(0, Math.round(prompt)),
    completionTokens: Math.max(0, Math.round(completion)),
    providerCost: cost,
    providerCurrency: cost === null ? null : currency,
  };
}

/** Цены из окружения; кривое значение заменяется значением по умолчанию. */
export function resolvePriceTable(env: Env = process.env): { inRubPerM: number; outRubPerM: number } {
  const read = (name: string, fallback: number): number => {
    const value = finiteNumber(env[name]);
    return value !== null && value >= 0 ? value : fallback;
  };
  return {
    inRubPerM: read("LLM_PRICE_IN_RUB_PER_M", DEFAULT_PRICE_IN_RUB_PER_M),
    outRubPerM: read("LLM_PRICE_OUT_RUB_PER_M", DEFAULT_PRICE_OUT_RUB_PER_M),
  };
}

/** Стоимость по таблице цен, ₽. */
export function priceTableCost(
  promptTokens: number,
  completionTokens: number,
  env: Env = process.env,
): number {
  const { inRubPerM, outRubPerM } = resolvePriceTable(env);
  return (promptTokens * inRubPerM + completionTokens * outRubPerM) / 1_000_000;
}

/* ============================ Курс ЦБ ============================ */

export const CBR_DAILY_URL = "https://www.cbr-xml-daily.ru/daily_json.js";
const RATE_TTL_MS = 24 * 60 * 60 * 1000;

export type UsdRubProvider = () => Promise<number | null>;

/**
 * Курс доллара к рублю по ЦБ: кэш на сутки, при сбое — последний известный.
 * Нет ни курса, ни прошлого значения — null, и вызывающий код считает по таблице цен.
 * Время и сеть передаются параметрами ради тестов.
 */
export function createUsdRubProvider(
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): UsdRubProvider {
  const now = deps.now ?? Date.now;
  let cached: { rate: number; at: number } | null = null;

  return async () => {
    if (cached && now() - cached.at < RATE_TTL_MS) return cached.rate;
    try {
      const fetchImpl = deps.fetchImpl ?? fetch;
      const response = await fetchImpl(CBR_DAILY_URL, {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const data = (await response.json()) as {
        Valute?: { USD?: { Value?: unknown; Nominal?: unknown } };
      };
      const value = finiteNumber(data.Valute?.USD?.Value);
      const nominal = finiteNumber(data.Valute?.USD?.Nominal) ?? 1;
      if (value === null || value <= 0 || nominal <= 0) throw new Error("в ответе нет курса USD");
      cached = { rate: value / nominal, at: now() };
      return cached.rate;
    } catch {
      // Последний известный курс лучше отсутствия курса, даже устаревший.
      return cached?.rate ?? null;
    }
  };
}

/** Общий провайдер процесса: кэш курса один на все вызовы. */
export const getUsdRub: UsdRubProvider = createUsdRubProvider();

/* ============================ Итоговый расчёт ============================ */

/**
 * Стоимость вызова в рублях.
 *
 * Сначала стоимость шлюза (рубли как есть, доллары — по курсу), иначе таблица
 * цен. Вызов без usage даёт 0 по таблице: токенов нет, платить не за что.
 */
export async function computeCost(
  usage: ParsedUsage,
  deps: { env?: Env; usdRub?: UsdRubProvider } = {},
): Promise<CostResult> {
  const env = deps.env ?? process.env;
  const getRate = deps.usdRub ?? getUsdRub;

  if (usage.providerCost !== null && usage.providerCurrency !== null) {
    if (usage.providerCurrency === "RUB" || usage.providerCurrency === "RUR") {
      return {
        costRub: usage.providerCost,
        costSource: "provider",
        providerCost: usage.providerCost,
        providerCurrency: "RUB",
        usdRub: null,
      };
    }
    if (usage.providerCurrency === "USD") {
      const rate = await getRate();
      if (rate !== null) {
        return {
          costRub: usage.providerCost * rate,
          costSource: "provider",
          providerCost: usage.providerCost,
          providerCurrency: "USD",
          usdRub: rate,
        };
      }
      // Курса нет совсем: честнее посчитать по таблице, чем занулить стоимость.
    }
    // Неизвестная валюта: стоимости шлюза верить нельзя, считаем по таблице,
    // но то, что шлюз назвал, сохраняем рядом.
  }

  return {
    costRub: priceTableCost(usage.promptTokens, usage.completionTokens, env),
    costSource: "price_table",
    providerCost: usage.providerCost,
    providerCurrency: usage.providerCurrency,
    usdRub: null,
  };
}
