import {
  MAX_RERANK_ITEMS,
  buildExpandPrompt,
  buildRerankPrompt,
  parseExpansions,
  parseRerank,
  type RerankCandidate,
  type RerankVerdict,
} from "@/domain/searchAssist";
import { createTtlCache } from "@/lib/ttlCache";
import { parseImpliedWorksResponse } from "@/domain/estimate/impliedWorks";
import { parseNormPickResponse } from "@/domain/estimate/normPick";
import { resolveLlmEndpoint } from "@/services/llmGateway";
import { cachedLlmChat, isCacheablePurpose, usageTokens, type GatewayChatAnswer } from "@/services/llmResponseCache";
import { noteLlmGatewayResponse } from "@/services/llmBalanceTrigger";
import { recordLlmCall, usageIncludeFields, type LlmCallContext } from "@/services/llmUsage";

/**
 * Помощник поиска: вызов языковой модели с кэшем.
 *
 * Работает только по явному нажатию кнопки и на малом числе кандидатов: модель
 * платная, а поиск без неё работает всегда. Кэш — потому что люди повторяют
 * один и тот же запрос, и каждый повтор без кэша стоил бы токенов за тот же
 * ответ.
 */

export interface ChatResult {
  content: string;
  /** Сколько токенов потрачено; 0 для ответа из кэша. */
  tokens: number;
  /** Ответ взят из кэша ответов модели (`llmResponseCache.ts`): шлюз не вызывался. Только у видов работы сметы. */
  cached?: boolean;
}

/** Вызов модели. Вынесен, чтобы тест подменял его целиком и не тратил токены. */
export type ChatFn = (
  prompt: string,
  maxTokens: number,
  /** Зачем вызов: по нему расход ложится в журнал llm_usage_log. Нет — «other». */
  context?: LlmCallContext,
  /** Особые условия вызова; нет — модель шлюза по умолчанию и таймаут помощника поиска. */
  options?: ChatOptions,
) => Promise<ChatResult>;

export interface ChatOptions {
  /** Другая модель шлюза (подбор норм читает её из TENDERFIT_NORM_PICK_MODEL). */
  model?: string;
  /** Таймаут ответа, мс. По умолчанию 45 с — для коротких запросов помощника; длинная пачка подбора норм просит больше. */
  timeoutMs?: number;
  /**
   * false — без «рассуждений» модели. Haiku на длинном сложном запросе сама включает их и тратит
   * на них большую часть лимита: сводка анализа (13.10.2026) потратила 13 тыс. из 16 тыс. токенов на
   * рассуждения, и ответ оборвался, а при лимите 10 тыс. пришёл пустым.
   */
  reasoning?: false;
}

/**
 * Один вызов шлюза с учётом расхода. Адрес, ключ и модель читаются из окружения. Возвращает и причину завершения ответа:
 * по ней кэш (`llmResponseCache.ts`) не запоминает оборванное.
 */
async function callGateway(
  prompt: string,
  maxTokens: number,
  context: LlmCallContext,
  options: ChatOptions,
): Promise<GatewayChatAnswer> {
  const endpoint = { ...resolveLlmEndpoint(), ...(options.model === undefined ? {} : { model: options.model }) };
  let usage: unknown;
  let failure: string | null = null;

  try {
    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      cache: "no-store",
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: "user", content: prompt }],
        // Ноль: оценка закупки не должна меняться между двумя нажатиями кнопки.
        temperature: 0,
        max_tokens: maxTokens,
        ...(options.reasoning === false ? { reasoning: { enabled: false } } : {}),
        ...usageIncludeFields(),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });

    if (!response.ok) {
      // 402 «кончились деньги»: письмо владельцу уходит сразу, не дожидаясь проверки воркера.
      noteLlmGatewayResponse(response.status);
      // Тело ответа шлюза в сообщение не кладём: оно может содержать фрагменты
      // запроса, а сообщение уходит в браузер.
      throw new Error(`Шлюз модели ответил ${String(response.status)}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string | null }[];
      usage?: { total_tokens?: number };
    };
    usage = data.usage;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Шлюз модели вернул пустой ответ");
    return {
      content,
      tokens: data.usage?.total_tokens ?? 0,
      ...usageTokens(data.usage),
      finishReason: data.choices?.[0]?.finish_reason ?? null,
    };
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await recordLlmCall(context, {
      model: endpoint.model,
      usage,
      inputChars: prompt.length,
      ok: failure === null,
      error: failure,
    });
  }
}

/** Ответ читается как то, что от него ждёт вид работы: непрочитанный и оборванный ответ в кэш не кладётся. */
function readableForPurpose(purpose: LlmCallContext["purpose"], content: string): boolean {
  try {
    if (purpose === "estimate_norm_pick") parseNormPickResponse(content);
    else if (purpose === "estimate_implied") parseImpliedWorksResponse(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Обращение к шлюзу модели. Виды работы сметы (подбор норм и материалов, работы по технологии) идут через кэш ответов:
 * тот же запрос не оплачивается второй раз. Остальные — напрямую, как раньше.
 */
export const llmChat: ChatFn = async (prompt, maxTokens, context = { purpose: "other" }, options = {}) => {
  if (!isCacheablePurpose(context.purpose)) {
    const answer = await callGateway(prompt, maxTokens, context, options);
    return { content: answer.content, tokens: answer.tokens };
  }
  const answer = await cachedLlmChat({
    purpose: context.purpose,
    // Ключ нужен и на попадании: без него расчёт упал бы так же, как раньше, а не «работал бы, пока кэш полон».
    model: options.model ?? resolveLlmEndpoint().model,
    messages: [{ role: "user", content: prompt }],
    call: () => callGateway(prompt, maxTokens, context, options),
    validate: (content) => readableForPurpose(context.purpose, content),
  });
  return { content: answer.content, tokens: answer.tokens, ...(answer.cached ? { cached: true } : {}) };
};

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Ключ кэша: регистр и пробелы в запросе не должны плодить платные обращения. */
function normalizeKey(...parts: string[]): string {
  return parts.map((part) => part.replace(/\s+/g, " ").trim().toLowerCase()).join("␟");
}

export function createSearchAssist(chat: ChatFn) {
  const expandCache = createTtlCache<string[]>({ ttlMs: SIX_HOURS_MS, maxEntries: 300 });
  const rerankCache = createTtlCache<Record<string, RerankVerdict>>({
    ttlMs: SIX_HOURS_MS,
    maxEntries: 300,
  });

  return {
    /** Варианты формулировки запроса. Пустой разбор в кэш не попадает. */
    async expand(query: string): Promise<{ synonyms: string[]; cached: boolean; tokens: number }> {
      const key = normalizeKey(query);
      const hit = expandCache.get(key);
      if (hit !== undefined) return { synonyms: hit, cached: true, tokens: 0 };

      const answer = await chat(buildExpandPrompt(query), 400, { purpose: "search_assist" });
      const synonyms = parseExpansions(answer.content, query);
      if (synonyms.length > 0) expandCache.set(key, synonyms);
      return { synonyms, cached: false, tokens: answer.tokens };
    },

    /** Оценка соответствия закупок запросу по смыслу. */
    async rerank(input: {
      query: string;
      companyNote?: string;
      candidates: readonly RerankCandidate[];
    }): Promise<{ verdicts: Record<string, RerankVerdict>; cached: boolean; tokens: number }> {
      const candidates = input.candidates.slice(0, MAX_RERANK_ITEMS);
      const key = normalizeKey(
        input.query,
        input.companyNote ?? "",
        ...candidates.map((candidate) => `${candidate.id}:${candidate.subject}`),
      );
      const hit = rerankCache.get(key);
      if (hit !== undefined) return { verdicts: hit, cached: true, tokens: 0 };

      const prompt = buildRerankPrompt({
        query: input.query,
        ...(input.companyNote === undefined ? {} : { companyNote: input.companyNote }),
        candidates,
      });
      // Токенов на ответ: около сорока на закупку с причиной, с запасом.
      // Без «размышлений»: ответ — короткий JSON с вердиктами, а рассуждения модели оплачиваются как выход.
      // Замер 16–20.10.2026: у Gemini 2.5 Flash ~1000 выходных токенов на вызов при ~40 на закупку в ответе.
      const answer = await chat(prompt, 120 + candidates.length * 60, { purpose: "rerank" }, { reasoning: false });
      const verdicts = parseRerank(answer.content, candidates);
      if (Object.keys(verdicts).length > 0) rerankCache.set(key, verdicts);
      return { verdicts, cached: false, tokens: answer.tokens };
    },
  };
}

/** Экземпляр для роутов: один на процесс, чтобы кэш был общий. */
export const searchAssist = createSearchAssist(llmChat);
