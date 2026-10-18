import type { FeedbackEvent, TenderVerdict } from "@/domain/entities";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";

/** Репозиторий обратной связи по вердиктам (localStorage). */
export const feedbackRepository = {
  getAll(): FeedbackEvent[] {
    return readJSON<FeedbackEvent[]>(STORAGE_KEYS.feedback, []);
  },
  add(tenderId: string, verdict: TenderVerdict, useful: boolean, comment?: string): void {
    const all = this.getAll();
    const event: FeedbackEvent = {
      id: `fb-${Date.now()}-${tenderId}`,
      tenderId,
      verdict,
      useful,
      comment: comment ?? null,
      createdAt: new Date().toISOString(),
    };
    writeJSON(STORAGE_KEYS.feedback, [event, ...all]);
  },
  forTender(tenderId: string): FeedbackEvent | null {
    return this.getAll().find((e) => e.tenderId === tenderId) ?? null;
  },
};
