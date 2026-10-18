import {
  buildConsolidationPrompt,
  finalizeConsolidated,
  parseConsolidationResponse,
  readConsolidated,
  type ConsolidatedAnalysis,
  type ConsolidationTender,
  type SourcedFinding,
} from "@/domain/analysisConsolidation";
import { describeError } from "@/lib/errors";
import { getSupabaseServerClient } from "@/lib/supabase";
import { documentAnalysisRepository } from "@/repositories/documentAnalysisRepository";
import { llmChat, type ChatFn } from "@/services/searchAssistService";
import type { DocumentAnalysisRow, TenderDocumentRow } from "@/types/database";

/**
 * Сведение выводов глубокого анализа: один вызов модели после разбора всех документов.
 *
 * Сбой сводки разбор не роняет: карточка покажет построчные выводы, как раньше, с
 * правилами закона поверх (`summarizeDeepAnalysis`). Расход пишется в журнал под
 * видом работы `deep_analysis`.
 */

/** Ответ сводки короче разбора документа, но с запасом под 25 выводов и вопросы. */
const CONSOLIDATION_MAX_TOKENS = 16_000;
/** Меньше двух минут, которые воркер ждёт ответа на один вызов разбора (`WORKER_TIMEOUT_MS`). */
const CONSOLIDATION_TIMEOUT_MS = 105_000;

export interface ConsolidationDeps {
  chat: ChatFn;
  model: string;
  /** Записать сводку строкой `document_analyses` без документа. */
  save: (row: { tenderId: string; model: string; analysis: ConsolidatedAnalysis; tokens: number; ms: number }) => Promise<void>;
  now: () => number;
}

/** Выводы построчных разборов с именами документов; прежние сводки в счёт не идут. */
export function sourcedFindings(
  analyses: readonly DocumentAnalysisRow[],
  documents: readonly Pick<TenderDocumentRow, "id" | "filename">[],
): SourcedFinding[] {
  const names = new Map(documents.map((d) => [d.id, d.filename] as const));
  const out: SourcedFinding[] = [];
  for (const row of analyses) {
    if (readConsolidated(row.analysis) !== null) continue;
    const document = names.get(row.document_id) ?? "документ закупки";
    for (const finding of row.analysis?.findings ?? []) out.push({ document, finding });
  }
  return out;
}

export async function consolidateAnalysis(
  tender: ConsolidationTender,
  items: readonly SourcedFinding[],
  context: { jobId: string | null },
  deps: ConsolidationDeps,
): Promise<ConsolidatedAnalysis | null> {
  if (items.length === 0) return null;
  const started = deps.now();
  try {
    const answer = await deps.chat(
      buildConsolidationPrompt(tender, items),
      CONSOLIDATION_MAX_TOKENS,
      { purpose: "deep_analysis", tenderId: tender.regNumber, jobId: context.jobId },
      // Без «рассуждений»: иначе модель тратит на них почти весь лимит, и ответ обрывается.
      { timeoutMs: CONSOLIDATION_TIMEOUT_MS, reasoning: false },
    );
    const consolidated = finalizeConsolidated(parseConsolidationResponse(answer.content), tender);
    await deps.save({
      tenderId: tender.regNumber,
      model: deps.model,
      analysis: consolidated,
      tokens: answer.tokens,
      ms: deps.now() - started,
    });
    return consolidated;
  } catch (err) {
    console.error(`Сводка анализа ${tender.regNumber} не сделана: ${describeError(err)}`);
    return null;
  }
}

export function defaultConsolidationDeps(model: string): ConsolidationDeps {
  return {
    chat: llmChat,
    model,
    save: async ({ tenderId, model: usedModel, analysis, tokens, ms }) => {
      const supabase = getSupabaseServerClient();
      const { error } = await supabase.from("document_analyses").insert({
        tender_id: tenderId,
        document_id: null,
        model_used: usedModel,
        analysis,
        tokens_used: tokens,
        processing_time_ms: ms,
      });
      if (error) throw error;
    },
    now: Date.now,
  };
}

/** Последняя сводка закупки, если есть. */
export async function latestConsolidation(tenderId: string): Promise<ConsolidatedAnalysis | null> {
  const rows = await documentAnalysisRepository.findByTenderId(tenderId);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const consolidated = readConsolidated(rows[i]?.analysis);
    if (consolidated !== null) return consolidated;
  }
  return null;
}
