import type { PipelineItem, PipelineStatus } from "@/domain/entities";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";

type PipelineMap = Record<string, PipelineItem>;

/** Репозиторий воронки работы с закупками (localStorage). */
export const pipelineRepository = {
  getAll(): PipelineMap {
    return readJSON<PipelineMap>(STORAGE_KEYS.pipeline, {});
  },
  getStatus(tenderId: string): PipelineStatus {
    const all = this.getAll();
    return all[tenderId]?.status ?? "NEW";
  },
  setStatus(tenderId: string, status: PipelineStatus, note?: string): void {
    const all = this.getAll();
    all[tenderId] = {
      tenderId,
      status,
      note: note ?? all[tenderId]?.note ?? null,
      updatedAt: new Date().toISOString(),
    };
    writeJSON(STORAGE_KEYS.pipeline, all);
  },
  listItems(): PipelineItem[] {
    return Object.values(this.getAll());
  },
};
