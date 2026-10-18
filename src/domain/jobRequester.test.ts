import { describe, expect, it } from "vitest";

import { withoutRequester } from "@/domain/jobRequester";
import { redactSyncJob } from "@/domain/syncJobRedaction";
import type { SyncJobRow } from "@/types/database";

describe("почта постановщика не уходит чужим", () => {
  it("withoutRequester убирает requested_by и не трогает остальное", () => {
    expect(withoutRequester({ id: "a1", status: "pending", requested_by: "ivan@firma.ru" })).toEqual({ id: "a1", status: "pending" });
    expect(withoutRequester({ id: "a2" })).toEqual({ id: "a2" });
  });

  const job = (requested_by: string | null): SyncJobRow =>
    ({ id: "j1", kind: "estimate", status: "pending", payload: {}, requested_by }) as unknown as SyncJobRow;

  it("журнал очереди: почта скрыта, метка источника остаётся", () => {
    expect(redactSyncJob(job("ivan@firma.ru")).requested_by).toBeNull();
    expect(redactSyncJob(job("ui")).requested_by).toBe("ui");
    expect(redactSyncJob(job("live-search")).requested_by).toBe("live-search");
    expect(redactSyncJob(job(null)).requested_by).toBeNull();
  });
});
