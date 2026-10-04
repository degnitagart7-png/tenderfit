import type { ManualReviewDecision, ManualReviewOutcome, TenderVerdict } from "@/domain/entities";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";

/**
 * Репозиторий ручных проверок: история решений аналитика по каждой закупке
 * (localStorage). История не перезаписывается — каждое решение добавляется,
 * чтобы трассировать эволюцию оценки.
 */
export const reviewRepository = {
  getAll(): ManualReviewDecision[] {
    return readJSON<ManualReviewDecision[]>(STORAGE_KEYS.manualReviews, []);
  },
  forTender(tenderId: string): ManualReviewDecision[] {
    return this.getAll()
      .filter((d) => d.tenderId === tenderId)
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  },
  latest(tenderId: string): ManualReviewDecision | null {
    return this.forTender(tenderId)[0] ?? null;
  },
  add(
    tenderId: string,
    outcome: ManualReviewOutcome,
    checklist: Record<string, boolean>,
    comment: string,
    systemVerdict: TenderVerdict,
  ): ManualReviewDecision {
    const decision: ManualReviewDecision = {
      id: `mr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      tenderId,
      outcome,
      checklist,
      comment: comment.trim(),
      systemVerdict,
      decidedAt: new Date().toISOString(),
    };
    const all = this.getAll();
    all.push(decision);
    writeJSON(STORAGE_KEYS.manualReviews, all);
    return decision;
  },
  clear(): void {
    writeJSON(STORAGE_KEYS.manualReviews, []);
  },
};
