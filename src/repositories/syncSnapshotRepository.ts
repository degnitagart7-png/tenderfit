import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";

/** Срез показателей предыдущей синхронизации — для честного тренда KPI. */
export interface SyncSnapshot {
  at: string;
  total: number;
  recommended: number;
  manualReview: number;
  notRecommended: number;
}

export const syncSnapshotRepository = {
  get(): SyncSnapshot | null {
    return readJSON<SyncSnapshot | null>(STORAGE_KEYS.syncSnapshot, null);
  },
  save(snapshot: SyncSnapshot): void {
    writeJSON(STORAGE_KEYS.syncSnapshot, snapshot);
  },
};
