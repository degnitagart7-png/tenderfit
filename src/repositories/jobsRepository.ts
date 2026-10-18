import type { ProcessingJob, ProcessingJobStatus, ProcessingJobType } from "@/domain/entities";
import { readJSON, writeJSON, STORAGE_KEYS } from "@/lib/storage";

/** Репозиторий журнала фоновых заданий (localStorage). */
export const jobsRepository = {
  getAll(): ProcessingJob[] {
    return readJSON<ProcessingJob[]>(STORAGE_KEYS.jobs, []);
  },
  save(jobs: ProcessingJob[]): void {
    writeJSON(STORAGE_KEYS.jobs, jobs);
  },
  add(type: ProcessingJobType, message = ""): ProcessingJob {
    const job: ProcessingJob = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      status: "QUEUED",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: 0,
      message,
      error: null,
    };
    this.save([job, ...this.getAll()]);
    return job;
  },
  update(id: string, patch: Partial<ProcessingJob>): void {
    const all = this.getAll().map((j) => (j.id === id ? { ...j, ...patch } : j));
    this.save(all);
  },
  setStatus(id: string, status: ProcessingJobStatus): void {
    this.update(id, {
      status,
      finishedAt: status === "SUCCEEDED" || status === "FAILED" ? new Date().toISOString() : null,
      progress: status === "SUCCEEDED" ? 100 : undefined,
    });
  },
};
