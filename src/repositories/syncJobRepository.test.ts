import { describe, it, expect, vi, beforeEach } from "vitest";

/*
  Очередь заданий воркеру — это деньги и время партнёра: задание, которое
  потерялось или выполнилось дважды, видно в ленте и в счёте. Поэтому тесты
  проверяют состав запросов к базе, а не только возвращаемые значения.

  Цепочка PostgREST повторяет приём analysisJobRepository.test.ts, но ответы
  раздаются по таблицам: `status()` читает и sync_jobs, и worker_heartbeat, и
  одна общая очередь ответов на такой проверке соврала бы.
*/

interface ChainCall {
  table: string;
  method: string;
  args: unknown[];
}

interface ChainResponse {
  data: unknown;
  error: unknown;
  count?: number | null;
}

const EMPTY: ChainResponse = { data: null, error: null };
const calls: ChainCall[] = [];
const responsesByTable = new Map<string, ChainResponse[]>();

const CHAIN_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "order",
  "limit",
  "range",
] as const;

function currentResponse(table: string): ChainResponse {
  const queue = responsesByTable.get(table) ?? [EMPTY];
  // Последний ответ остаётся для всех последующих запросов той же таблицы.
  if (queue.length > 1) return queue.shift() ?? EMPTY;
  return queue[0] ?? EMPTY;
}

function chain(table: string) {
  const node: Record<string, unknown> = {
    then: (resolve: (value: unknown) => void) => resolve(currentResponse(table)),
    single: async () => currentResponse(table),
    maybeSingle: async () => currentResponse(table),
  };
  for (const method of CHAIN_METHODS) {
    node[method] = (...args: unknown[]) => {
      calls.push({ table, method, args });
      return node;
    };
  }
  return node;
}

const mockFrom = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    from: mockFrom,
  }),
}));

/** Ответы для одной таблицы: по одному на каждый запрос. */
function mockTable(table: string, ...items: ChainResponse[]) {
  responsesByTable.set(table, items.length > 0 ? items : [EMPTY]);
}

function allArgsOf(table: string, method: string): unknown[][] {
  return calls
    .filter((call) => call.table === table && call.method === method)
    .map((call) => call.args);
}

function updatePayload(table = "sync_jobs", index = 0): Record<string, unknown> {
  return (allArgsOf(table, "update")[index]?.[0] ?? {}) as Record<string, unknown>;
}

/** Строка очереди в том виде, в котором её возвращает база. */
function jobRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    kind: "documents",
    status: "pending",
    payload: { regNumbers: ["32616407955"], reason: "press" },
    requested_by: "partner@example.test",
    attempts: 0,
    worker_id: null,
    claimed_at: null,
    finished_at: null,
    report: null,
    error: null,
    created_at: "2026-09-25T00:00:00.000Z",
    updated_at: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = "2026-09-25T03:00:00.000Z";

describe("syncJobRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    responsesByTable.clear();
    mockFrom.mockImplementation((table: string) => chain(table));
  });

  it("ставит задание в очередь с номерами закупок", async () => {
    mockTable("sync_jobs", { data: jobRow(), error: null });

    const { syncJobRepository } = await import("./syncJobRepository");
    const created = await syncJobRepository.create(
      "documents",
      { regNumbers: ["32616407955"], reason: "press" },
      "partner@example.test",
    );

    expect(created.id).toBe("job-1");
    expect(allArgsOf("sync_jobs", "insert")[0]?.[0]).toEqual({
      kind: "documents",
      payload: { regNumbers: ["32616407955"], reason: "press" },
      requested_by: "partner@example.test",
    });
  });

  it("пустая очередь — это «делать нечего», а не запрос на захват", async () => {
    mockTable("sync_jobs", { data: null, error: null });

    const { syncJobRepository } = await import("./syncJobRepository");
    await expect(syncJobRepository.claimNextPending("ru-vps", NOW)).resolves.toBeNull();

    // Обновления не было: воркер не трогает базу, когда заданий нет.
    expect(allArgsOf("sync_jobs", "update")).toHaveLength(0);
  });

  it("захватывает задание условно и увеличивает число попыток", async () => {
    mockTable(
      "sync_jobs",
      { data: jobRow({ attempts: 1 }), error: null },
      { data: [jobRow({ status: "processing", attempts: 2 })], error: null },
    );

    const { syncJobRepository } = await import("./syncJobRepository");
    const claimed = await syncJobRepository.claimNextPending("ru-vps", NOW);

    expect(claimed?.status).toBe("processing");
    expect(updatePayload()).toEqual({
      status: "processing",
      worker_id: "ru-vps",
      claimed_at: NOW,
      attempts: 2,
    });
    // Условие «всё ещё pending» — то, что не даёт двум воркерам взять одно задание.
    expect(allArgsOf("sync_jobs", "eq").map((args) => args[1])).toContain("pending");
  });

  it("проигранный захват возвращает null, а не чужое задание", async () => {
    mockTable(
      "sync_jobs",
      { data: jobRow(), error: null },
      // Второй воркер успел первым: условный update не задел ни одной строки.
      { data: [], error: null },
    );

    const { syncJobRepository } = await import("./syncJobRepository");
    await expect(syncJobRepository.claimNextPending("ru-vps", NOW)).resolves.toBeNull();
  });

  it("успех пишет отчёт целиком и стирает прежнюю ошибку", async () => {
    mockTable("sync_jobs", { data: [], error: null });

    const { syncJobRepository } = await import("./syncJobRepository");
    await syncJobRepository.complete("job-1", {
      tenders: 3,
      documents: 7,
      already: 1,
      unavailable: 0,
      stoppedEarly: false,
    });

    expect(updatePayload()).toMatchObject({
      status: "completed",
      report: { tenders: 3, documents: 7, already: 1, unavailable: 0, stoppedEarly: false },
      error: null,
    });
  });

  it("сбой возвращает задание в очередь, пока попытки не кончились", async () => {
    mockTable("sync_jobs", { data: [], error: null });

    const { syncJobRepository, SYNC_JOB_MAX_ATTEMPTS } = await import("./syncJobRepository");
    const status = await syncJobRepository.fail("job-1", "ЕИС не отвечает", 1);

    expect(status).toBe("pending");
    expect(updatePayload()).toMatchObject({ status: "pending", error: "ЕИС не отвечает" });
    // Без метки завершения: задание ещё будет выполнено.
    expect(updatePayload()["finished_at"]).toBeUndefined();
    expect(SYNC_JOB_MAX_ATTEMPTS).toBeGreaterThan(1);
  });

  it("после предела попыток задание остаётся failed с причиной", async () => {
    mockTable("sync_jobs", { data: [], error: null });

    const { syncJobRepository, SYNC_JOB_MAX_ATTEMPTS } = await import("./syncJobRepository");
    const status = await syncJobRepository.fail(
      "job-1",
      "filestore не отвечает с этого адреса",
      SYNC_JOB_MAX_ATTEMPTS,
    );

    expect(status).toBe("failed");
    expect(updatePayload()).toMatchObject({ status: "failed" });
    expect(typeof updatePayload()["finished_at"]).toBe("string");
  });

  it("зависшее в processing задание возвращается в очередь, свежее не трогается", async () => {
    const staleAt = "2026-09-25T01:00:00.000Z";
    const freshAt = "2026-09-25T02:59:00.000Z";
    mockTable("sync_jobs", {
      data: [
        { id: "job-stale", claimed_at: staleAt },
        { id: "job-fresh", claimed_at: freshAt },
      ],
      error: null,
    });

    const { syncJobRepository } = await import("./syncJobRepository");
    const reset = await syncJobRepository.resetStaleJobs(30, new Date(NOW).getTime());

    expect(reset).toBe(1);
    expect(allArgsOf("sync_jobs", "update")).toHaveLength(1);
    expect(updatePayload()).toMatchObject({ status: "pending", worker_id: null });
  });

  it("пульс пишется upsert и не затирает неизвестный адрес выхода", async () => {
    mockTable("worker_heartbeat", { data: [], error: null });

    const { syncJobRepository } = await import("./syncJobRepository");
    await syncJobRepository.beat("ru-vps", {
      lastSeenAt: NOW,
      host: "vps-1",
      version: "2026-09-25",
      // Адрес выхода на этом тике определить не удалось — прежнее значение
      // важнее честного null: по нему панель судит, российский ли выход.
      exitIp: null,
      exitCountry: undefined,
      lastJobId: "job-1",
    });

    const payload = allArgsOf("worker_heartbeat", "upsert")[0]?.[0] as Record<string, unknown>;
    expect(payload).toEqual({
      worker_id: "ru-vps",
      last_seen_at: NOW,
      host: "vps-1",
      version: "2026-09-25",
      last_job_id: "job-1",
    });
    expect(allArgsOf("worker_heartbeat", "upsert")[0]?.[1]).toEqual({
      onConflict: "worker_id",
    });
  });

  it("известный адрес выхода сохраняется", async () => {
    mockTable("worker_heartbeat", { data: [], error: null });

    const { syncJobRepository } = await import("./syncJobRepository");
    await syncJobRepository.beat("ru-vps", {
      lastSeenAt: NOW,
      exitIp: "176.97.134.221",
      exitCountry: "RU",
    });

    const payload = allArgsOf("worker_heartbeat", "upsert")[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({ exit_ip: "176.97.134.221", exit_country: "RU" });
  });

  it("сводка для панели собирает пульс, последнее задание и длину очереди", async () => {
    const heartbeat = { worker_id: "ru-vps", last_seen_at: NOW, exit_country: "RU" };
    mockTable(
      "sync_jobs",
      { data: [jobRow({ status: "completed" })], error: null },
      { data: null, error: null, count: 2 },
    );
    mockTable("worker_heartbeat", { data: heartbeat, error: null });

    const { syncJobRepository } = await import("./syncJobRepository");
    const status = await syncJobRepository.status("ru-vps");

    expect(status.heartbeat?.worker_id).toBe("ru-vps");
    expect(status.lastJob?.status).toBe("completed");
    expect(status.pending).toBe(2);
  });

  it("нет пульса — значит воркер ни разу не выходил на связь", async () => {
    mockTable("sync_jobs", { data: [], error: null }, { data: null, error: null, count: 0 });
    mockTable("worker_heartbeat", { data: null, error: null });

    const { syncJobRepository } = await import("./syncJobRepository");
    const status = await syncJobRepository.status("ru-vps");

    expect(status).toEqual({ heartbeat: null, lastJob: null, pending: 0 });
  });

  it("ошибка базы пробрасывается, а не превращается в пустой отчёт", async () => {
    mockTable("sync_jobs", { data: null, error: { message: "relation does not exist" } });

    const { syncJobRepository } = await import("./syncJobRepository");
    await expect(syncJobRepository.countPending()).rejects.toEqual({
      message: "relation does not exist",
    });
  });
});
