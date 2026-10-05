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
import { resolveLlmEndpoint } from "@/services/llmGateway";

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
}

/** Вызов модели. Вынесен, чтобы тест подменял его целиком и не тратил токены. */
export type ChatFn = (prompt: string, maxTokens: number) => Promise<ChatResult>;

/** Обращение к шлюзу модели. Адрес, ключ и модель читаются из окружения. */
export const llmChat: ChatFn = async (prompt, maxTokens) => {
  const endpoint = resolveLlmEndpoint();
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
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    // Тело ответа шлюза в сообщение не кладём: оно может содержать фрагменты
    // запроса, а сообщение уходит в браузер.
    throw new Error(`Шлюз модели ответил ${String(response.status)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { total_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Шлюз модели вернул пустой ответ");
  return { content, tokens: data.usage?.total_tokens ?? 0 };
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

      const answer = await chat(buildExpandPrompt(query), 400);
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
      const answer = await chat(prompt, 120 + candidates.length * 60);
      const verdicts = parseRerank(answer.content, candidates);
      if (Object.keys(verdicts).length > 0) rerankCache.set(key, verdicts);
      return { verdicts, cached: false, tokens: answer.tokens };
    },
  };
}

/** Экземпляр для роутов: один на процесс, чтобы кэш был общий. */
export const searchAssist = createSearchAssist(llmChat);
