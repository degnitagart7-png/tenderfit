import { planExtraction, type ExtractionDocument } from "@/domain/companyFacts/extraction";
import { addScrubStats, emptyScrubStats, scrubPii, type ScrubOptions, type ScrubStats } from "@/domain/companyFacts/scrubPii";
import type { CompanyDocumentCategory } from "@/domain/companyFacts/types";

/**
 * «Что уйдёт в ИИ»: предпросмотр отправки, который видит человек ДО нажатия кнопки.
 *
 * Строится теми же функциями, что и серверная отправка (`scrubPii` и `planExtraction`), поэтому показанное — это в точности то,
 * что уйдёт в модель: тот же очищенный текст, тот же порядок документов, тот же бюджет знаков. Браузер отправляет серверу уже
 * очищенный текст (необработанный не покидает устройство), сервер чистит его ещё раз — повторная очистка очищенного ничего не меняет.
 */

export interface PreviewInputDocument {
  id: string;
  name: string;
  category: CompanyDocumentCategory;
  text: string;
}

export type PreviewStatus = "sent" | "partial" | "skipped";

export interface PreviewDocument {
  id: string;
  name: string;
  category: CompanyDocumentCategory;
  /** Что скрыто в этом документе. */
  stats: ScrubStats;
  /** Очищенный текст всего документа — его и отправит браузер серверу. */
  cleanText: string;
  /** Ровно тот текст документа, что уйдёт в модель (с учётом бюджета знаков). */
  sentText: string;
  status: PreviewStatus;
  /** Почему документ не ушёл или ушёл не весь. */
  note: string | null;
}

export interface SendPreview {
  documents: PreviewDocument[];
  /** Скрыто во всех документах. */
  stats: ScrubStats;
  /** Сколько знаков уйдёт в модель. */
  sentChars: number;
  /** Сколько запросов к модели это будет. */
  calls: number;
}

export function buildSendPreview(documents: readonly PreviewInputDocument[], options: ScrubOptions = {}): SendPreview {
  let stats = emptyScrubStats();
  const scrubbed = documents.map((document) => {
    const result = scrubPii(document.text, options);
    stats = addScrubStats(stats, result.stats);
    return { document, result };
  });
  const extraction: ExtractionDocument[] = scrubbed.map(({ document, result }) => ({
    id: document.id,
    name: document.name,
    category: document.category,
    text: result.text,
  }));
  const plan = planExtraction(extraction);

  const sentById = new Map<string, string[]>();
  for (const batch of plan.batches) {
    for (const piece of batch) sentById.set(piece.documentId, [...(sentById.get(piece.documentId) ?? []), piece.text]);
  }
  const skippedById = new Map(plan.skipped.map((item) => [item.id, item.reason] as const));

  return {
    documents: scrubbed.map(({ document, result }): PreviewDocument => {
      const parts = sentById.get(document.id) ?? [];
      const sentText = parts.join("\n\n");
      const skipped = skippedById.get(document.id) ?? null;
      const complete = sentText.length > 0 && sentText.replace(/\s+/gu, "").length >= result.text.replace(/\s+/gu, "").length;
      return {
        id: document.id,
        name: document.name,
        category: document.category,
        stats: result.stats,
        cleanText: result.text,
        sentText,
        status: sentText === "" ? "skipped" : complete ? "sent" : "partial",
        note: skipped ?? (sentText !== "" && !complete ? "в модель уйдёт только начало: остальное не помещается в лимит объёма" : null),
      };
    }),
    stats,
    sentChars: plan.sentChars,
    calls: plan.batches.length,
  };
}
