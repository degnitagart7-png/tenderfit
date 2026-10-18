import { tenderRepository } from "@/repositories/tenderRepository";

/**
 * Записать обеспечение и аванс из текста только что сохранённого документа.
 *
 * Не бросает: документ к этому моменту уже лежит в базе, и сбой на побочном
 * шаге — например, миграция с колонкой `doc_terms` ещё не применена — не
 * должен превращать удачную загрузку документации в ошибку задания. Пропуск
 * восстановим: `npm run backfill:doc-terms` перечитает всю документацию.
 */
export async function recordDocumentTerms(
  regNumber: string,
  text: string,
): Promise<boolean> {
  try {
    return await tenderRepository.recordDocumentTerms(regNumber, text);
  } catch {
    return false;
  }
}
