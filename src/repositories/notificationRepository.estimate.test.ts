import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  Письма «смета готова» и «смета не удалась» читают задания estimate. В payload лежат тексты присланных
  файлов (до 2 млн знаков), в report — смета на мегабайты, а письму нужны объект, закупка, режим и итог:
  поля берутся путями JSON, а не строкой целиком.
*/

interface Call {
  table: string;
  method: string;
  args: unknown[];
}
const calls: Call[] = [];
const rows: Record<string, unknown[]> = {};

function chain(table: string) {
  const node: Record<string, unknown> = {
    then: (resolve: (value: unknown) => void) => resolve({ data: rows[table] ?? [], error: null }),
  };
  for (const method of ["select", "eq", "in", "is", "like", "gte", "limit"]) {
    node[method] = (...args: unknown[]) => {
      calls.push({ table, method, args });
      return node;
    };
  }
  return node;
}

vi.mock("@/lib/supabase", () => ({ getSupabaseServerClient: () => ({ from: (table: string) => chain(table) }) }));

import { notificationRepository } from "@/repositories/notificationRepository";

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(rows)) delete rows[key];
});

const selects = (): string[] =>
  calls.filter((call) => call.table === "sync_jobs" && call.method === "select").map((call) => String(call.args[0]));

describe("notificationRepository: задания estimate без тяжёлых полей", () => {
  it("готовые: payload и report целиком не читаются, поля задания приходят путями JSON и попадают в письмо", async () => {
    rows["analysis_jobs"] = [];
    rows["sync_jobs"] = [
      {
        id: "est-1",
        requested_by: "Anna@Firma.ru",
        subject: "Ремонт кровли",
        tender_id: null,
        mode: "audit",
        total: "15300000",
        created_at: "2026-10-20T10:00:00Z",
        finished_at: "2026-10-20T10:20:00Z",
      },
    ];

    const jobs = await notificationRepository.listReadyJobs(0);

    const [select] = selects();
    expect(select).not.toMatch(/(^|,\s*)payload(\s*,|$)/);
    expect(select).toContain("subject:payload->>subject");
    expect(select).toContain("tender_id:payload->>tenderId");
    expect(jobs).toEqual([
      {
        kind: "estimate",
        id: "est-1",
        requestedBy: "anna@firma.ru",
        createdAt: Date.parse("2026-10-20T10:00:00Z"),
        finishedAt: Date.parse("2026-10-20T10:20:00Z"),
        tenderId: null,
        subject: "Ремонт кровли",
        mode: "audit",
        totalRub: 15_300_000,
      },
    ]);
  });

  it("упавшие: закупка берётся путём JSON, номер задания сохраняется для ссылки в письме", async () => {
    rows["analysis_jobs"] = [];
    rows["sync_jobs"] = [{ id: "est-2", requested_by: "client@firma.ru", tender_id: "0373", error: "нет зоны", finished_at: "2026-10-20T10:20:00Z", updated_at: "2026-10-20T10:20:00Z" }];

    const jobs = await notificationRepository.listFailedJobs(0);

    expect(selects()[0]).not.toMatch(/(^|,\s*)payload(\s*,|$)/);
    expect(jobs.find((job) => job.kind === "estimate")).toMatchObject({ id: "est-2", tenderId: "0373", requestedBy: "client@firma.ru" });
  });
});
