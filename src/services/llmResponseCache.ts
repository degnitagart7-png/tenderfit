import { createHash } from "node:crypto";

import { llmResponseCacheRepository, type LlmResponseCacheStore } from "@/repositories/llmResponseCacheRepository";
import type { LlmPurpose } from "@/repositories/llmUsageRepository";

/**
 * Кэш ответов языковой модели для сметы.
 *
 * Зачем. Смета отправляет в шлюз одни и те же запросы снова и снова: каждый круг бенчмарка перечитывает те же документы, пересчёт
 * закупки повторяет подбор норм по тем же позициям, упавшее задание начинается заново. Температура везде 0, промпт — неизменный
 * шаблон плюс те же данные, поэтому ответ на повторный запрос тот же, а платим мы за него дважды. Кэш отдаёт готовый ответ.
 *
 * Где живёт. Там, где происходит настоящий вызов шлюза, то есть на проде (`/api/estimate/bill-rows`, `norm-pick`, `implied-works`
 * зовут `fetchBillRows` и `llmChat`): ключ модели и база кэша — на одной стороне, воркер ничего не знает о кэше и получает ответ
 * так же, как получал бы живой. Поэтому выигрывают и слепые прогоны бенчмарка, и обычные расчёты пользователей.
 *
 * Ключ: sha256 от (версия кэша, модель, вид работы, полный JSON сообщений). Правка промпта меняет сообщения, а значит и ключ;
 * `LLM_CACHE_VERSION` поднимается вручную, когда поменялся разбор ответа и старые ответы нужно забыть. Закупка и задание в ключ
 * не входят — они уже внутри промпта, а в кэш-ключе от них нет пользы: тот же фрагмент того же документа даёт тот же ответ.
 *
 * Что кэшируется. Только полный ответ: `finish_reason` не «length», ответ непустой и проходит проверку вызывающего (JSON читается,
 * не оборван). Оборванный ответ в кэш не попадает — повтор должен получить шанс на полный. Срок — 60 дней по `created_at`.
 *
 * Чего кэш не делает. Не пишет в `llm_usage_log` ничего на попадании: платного вызова не было, и «0 ₽ за 0 токенов» только
 * раздувала бы журнал. Схему таблицы журнала не меняет. Не блокирует: счётчик попаданий обновляется без ожидания, а любой сбой кэша
 * (таблицы нет, база недоступна, зависший запрос) проглатывается, и расчёт идёт настоящим вызовом. `LLM_CACHE_DISABLED=1` выключает его.
 */

/** Версия кэша: поднимается вручную, когда ответы нужно забыть целиком. */
export const LLM_CACHE_VERSION = "1";

/** Срок жизни ответа: 60 суток. Старее — как будто нет. */
export const LLM_CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** Столько ждём базу кэша; дольше — считаем промахом: кэш не должен быть медленнее вызова, который заменяет. */
export const LLM_CACHE_IO_TIMEOUT_MS = 3_000;

/**
 * Виды работы, которые кэшируются: смета и факты компании. Поиск и глубокий анализ — нет (у поиска свой кэш, у анализа — свои правила).
 * Факты компании (`company_facts`): ключ — хэш полного запроса, а в запросе только очищенный от ПД текст; тот же набор документов
 * после «Обновить профиль» не оплачивается второй раз. Соответствие закупке (`company_fit`) кэшируется своей таблицей.
 */
export const CACHEABLE_PURPOSES: readonly LlmPurpose[] = ["estimate_bill", "estimate_norm_pick", "estimate_implied", "company_facts"];

export function isCacheablePurpose(purpose: LlmPurpose): boolean {
  return CACHEABLE_PURPOSES.includes(purpose);
}

/** Ответ шлюза в том виде, в каком его кэшируют и отдают. */
export interface GatewayChatAnswer {
  readonly content: string;
  /** Токенов потрачено; у ответа из кэша — 0. */
  readonly tokens: number;
  readonly tokensIn?: number | null;
  readonly tokensOut?: number | null;
  /** `choices[0].finish_reason`; null или нет — шлюз не сказал. */
  readonly finishReason?: string | null;
}

export interface CachedChatAnswer extends GatewayChatAnswer {
  /** Ответ взят из кэша, шлюз не вызывался. */
  readonly cached: boolean;
}

export interface CachedLlmChatInput {
  readonly purpose: LlmPurpose;
  /** Идентификатор модели, как он уходит в шлюз: другая модель — другой ключ. */
  readonly model: string;
  /** Полные сообщения запроса: ключ строится по ним целиком. */
  readonly messages: readonly unknown[];
  /** Настоящий вызов шлюза с учётом расхода; зовётся только при промахе. Бросает при сбое — кэш его не прячет. */
  readonly call: () => Promise<GatewayChatAnswer>;
  /** Годится ли ответ для кэша (читается ли как JSON и не оборван). Нет — ответ отдаётся, но не запоминается. */
  readonly validate?: (content: string) => boolean;
}

export interface LlmCacheDeps {
  readonly store?: LlmResponseCacheStore;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => number;
}

/** `LLM_CACHE_DISABLED=1` (или `true`) — кэш выключен. */
export function isLlmCacheDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env["LLM_CACHE_DISABLED"] ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/** Ключ кэша: sha256 от версии, модели, вида работы и полного JSON сообщений. */
export function llmCacheKey(input: { readonly model: string; readonly purpose: string; readonly messages: readonly unknown[] }): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: LLM_CACHE_VERSION, model: input.model, purpose: input.purpose, messages: input.messages }))
    .digest("hex");
}

/**
 * Ответ полный? Оборванный по лимиту токенов (`length`, `max_tokens`), отрезанный фильтром или упавший (`error`) не кэшируется.
 * Шлюз не назвал причину — решает проверка содержимого (`validate`): у разных шлюзов причина завершения называется по-разному.
 */
export function isCompleteFinish(reason: string | null | undefined): boolean {
  if (reason === null || reason === undefined) return true;
  const value = reason.trim().toLowerCase();
  return !(value.includes("length") || value.includes("max_tokens") || value.includes("content_filter") || value.includes("error"));
}

const warned = new Set<string>();

/** Для тестов: забыть, о каких сбоях уже сказано. */
export function resetLlmCacheWarnings(): void {
  warned.clear();
}

/** Сбой кэша в консоль — один раз на вид сбоя: без таблицы каждый вызов шумел бы одним и тем же. */
function warnOnce(kind: string, error: unknown): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  console.warn(`[llm-cache] ${kind}: ${error instanceof Error ? error.message : String(error)} (кэш пропущен, вызов идёт в шлюз)`);
}

/** Ждёт обещание не дольше `ms`; по истечении — отказ, а не вечное ожидание. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`база кэша не ответила за ${String(ms)} мс`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ответ модели через кэш: попадание — готовый текст без вызова, промах — настоящий вызов и запоминание полного ответа.
 *
 * Не кэшируются: виды работы вне сметы, любой вызов при `LLM_CACHE_DISABLED=1`. Сбой чтения кэша — промах, сбой записи — тишина:
 * ответ вернётся в любом случае.
 */
export async function cachedLlmChat(input: CachedLlmChatInput, deps: LlmCacheDeps = {}): Promise<CachedChatAnswer> {
  const env = deps.env ?? process.env;
  if (!isCacheablePurpose(input.purpose) || isLlmCacheDisabled(env)) {
    return { ...(await input.call()), cached: false };
  }

  const store = deps.store ?? llmResponseCacheRepository;
  const now = deps.now ?? Date.now;
  const key = llmCacheKey(input);

  try {
    const hit = await withTimeout(store.get(key, new Date(now() - LLM_CACHE_TTL_MS).toISOString()), LLM_CACHE_IO_TIMEOUT_MS);
    if (hit !== null && hit.response !== "") {
      // Счётчик попаданий — без ожидания и без последствий: он нужен для отчёта, а не для работы.
      void store.touch(key, hit.hits + 1).catch((error: unknown) => warnOnce("не удалось обновить счётчик попаданий", error));
      return { content: hit.response, tokens: 0, tokensIn: 0, tokensOut: 0, finishReason: "stop", cached: true };
    }
  } catch (error) {
    warnOnce("чтение кэша не удалось", error);
  }

  const answer = await input.call();

  let valid = true;
  try {
    valid = input.validate === undefined || input.validate(answer.content);
  } catch {
    valid = false;
  }
  const storable = answer.content.trim() !== "" && isCompleteFinish(answer.finishReason) && valid;
  if (storable) {
    try {
      await withTimeout(
        store.put({
          key,
          purpose: input.purpose,
          model: input.model,
          response: answer.content,
          tokensIn: answer.tokensIn ?? null,
          tokensOut: answer.tokensOut ?? null,
        }),
        LLM_CACHE_IO_TIMEOUT_MS,
      );
    } catch (error) {
      warnOnce("запись в кэш не удалась", error);
    }
  }
  return { ...answer, cached: false };
}

/** Токены запроса и ответа из объекта `usage` шлюза; нет — null. */
export function usageTokens(usage: unknown): { tokensIn: number | null; tokensOut: number | null } {
  const record = (typeof usage === "object" && usage !== null ? usage : {}) as Record<string, unknown>;
  const pick = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
  return { tokensIn: pick(record["prompt_tokens"]), tokensOut: pick(record["completion_tokens"]) };
}
