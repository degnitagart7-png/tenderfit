import { buildFactsPrompt, planExtraction, type ExtractionDocument } from "@/domain/companyFacts/extraction";
import { mergeFactsBodies, parseFactsResponse, type FactsBody } from "@/domain/companyFacts/schema";
import { addScrubStats, emptyScrubStats, scrubPii, type ScrubStats } from "@/domain/companyFacts/scrubPii";
import { FACTS_VERSION, type CompanyDocumentCategory, type CompanyFacts } from "@/domain/companyFacts/types";
import { describeError } from "@/lib/errors";
import type { ChatFn } from "@/services/searchAssistService";

/**
 * Извлечение деловых фактов компании из её документов — серверная часть.
 *
 * Порядок строго такой: очистка от ПД → план запросов по бюджету знаков → по одному вызову модели на запрос →
 * проверка и слияние ответов. В модель уходит только очищенный текст; необработанный текст дальше этой функции не живёт.
 * Очистка здесь повторяется, даже если браузер уже очистил текст для предпросмотра: серверу присланное устройством не
 * доверяется, а повторная очистка уже очищенного текста ничего не меняет.
 *
 * Расход пишется в `llm_usage_log` самим чатом (`llmChat`) с видом работы `company_facts`; ответы кэшируются по хэшу
 * запроса (то есть по хэшу очищенного текста) — тот же набор документов не оплачивается дважды.
 */

/** Ответ по набору документов — ~4–12 тыс. токенов; прайс-лист на 400 позиций упирается в верхнюю границу. */
export const FACTS_MAX_TOKENS = 14_000;
/** Меньше двух минут, которые даёт запросу ручка (`maxDuration`). */
export const FACTS_TIMEOUT_MS = 100_000;

export interface FactsInputDocument {
  id: string;
  name: string;
  category: CompanyDocumentCategory;
  text: string;
}

export interface FactsRunInput {
  documents: readonly FactsInputDocument[];
  /** ИНН и название компании из анкеты: остаются в тексте при очистке. */
  companyInn?: string;
  companyName?: string;
  userId: string | null;
  now?: Date;
}

export interface FactsRunResult {
  facts: CompanyFacts;
  /** Документы, не попавшие в запрос, с причиной. */
  skipped: { id: string; name: string; reason: string }[];
  /** Часть текста не вошла в лимит объёма. */
  truncated: boolean;
  /** Сколько знаков очищенного текста ушло в модель. */
  sentChars: number;
  /** Сколько вызовов модели сделано (ответы из кэша тоже считаются: вызов шёл через кэш). */
  calls: number;
  /** Записей отброшено проверкой на личное. */
  droppedForPii: number;
  /** Вызовов, на которые модель не ответила или ответила не по схеме. */
  failedCalls: number;
}

export class FactsExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactsExtractionError";
  }
}

export async function extractCompanyFacts(input: FactsRunInput, deps: { chat: ChatFn }): Promise<FactsRunResult> {
  const now = input.now ?? new Date();
  const scrubOptions = {
    ...(input.companyInn === undefined ? {} : { companyInn: input.companyInn }),
    ...(input.companyName === undefined || input.companyName.trim() === "" ? {} : { keep: [input.companyName] }),
  };

  // 1. Очистка. Дальше по коду существует только очищенный текст.
  let scrubStats: ScrubStats = emptyScrubStats();
  const scrubbed: ExtractionDocument[] = input.documents.map((document) => {
    const result = scrubPii(document.text, scrubOptions);
    scrubStats = addScrubStats(scrubStats, result.stats);
    return { id: document.id, name: document.name, category: document.category, text: result.text };
  });

  // 2. План запросов по бюджету знаков.
  const plan = planExtraction(scrubbed);
  if (plan.batches.length === 0) {
    throw new FactsExtractionError("В документах нет текста, из которого можно извлечь факты.");
  }

  // 3. Вызовы модели — по очереди: ответы маленькие, а параллельные запросы к шлюзу не нужны одному человеку.
  const bodies: FactsBody[] = [];
  let droppedForPii = 0;
  let failedCalls = 0;
  let lastError = "";
  for (const batch of plan.batches) {
    try {
      const answer = await deps.chat(
        buildFactsPrompt(batch),
        FACTS_MAX_TOKENS,
        { purpose: "company_facts", userId: input.userId },
        // Без «рассуждений»: ответ — JSON по схеме, а рассуждения Haiku оплачиваются как выход и съедают лимит.
        { timeoutMs: FACTS_TIMEOUT_MS, reasoning: false },
      );
      const parsed = parseFactsResponse(answer.content, { scrub: scrubOptions, now });
      droppedForPii += parsed.droppedForPii;
      bodies.push(parsed.body);
    } catch (error) {
      failedCalls += 1;
      lastError = describeError(error);
      console.error(`Факты компании: запрос к модели не удался: ${lastError}`);
    }
  }
  if (bodies.length === 0) {
    throw new FactsExtractionError(`Модель не вернула факты (${lastError || "нет ответа"}). Повторите позже.`);
  }

  const merged = mergeFactsBodies(bodies);
  const includedIds = new Set(plan.included);
  const facts: CompanyFacts = {
    version: FACTS_VERSION,
    extractedAt: now.toISOString(),
    sourceDocuments: input.documents.filter((document) => includedIds.has(document.id)).map((document) => document.name),
    scrubStats,
    ...merged,
  };
  return {
    facts,
    skipped: plan.skipped,
    truncated: plan.truncated,
    sentChars: plan.sentChars,
    calls: plan.batches.length,
    droppedForPii,
    failedCalls,
  };
}
