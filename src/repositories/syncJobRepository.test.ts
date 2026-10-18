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
  "is",
  "not",
  "or",
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

  describe("дорожки воркера: захват по виду", () => {
    const claimResponses = (kind: string, payload: Record<string, unknown> = {}) =>
      [
        { data: jobRow({ kind, payload }), error: null },
        { data: [jobRow({ kind, payload, status: "processing", attempts: 1 })], error: null },
      ] as const;

    it("без отбора запрос прежний: ни вида, ни живого поиска в нём нет", async () => {
      mockTable("sync_jobs", ...claimResponses("documents"));
      const { syncJobRepository } = await import("./syncJobRepository");
      await syncJobRepository.claimNextPending("ru-vps", NOW);

      expect(allArgsOf("sync_jobs", "eq")).toEqual([["status", "pending"], ["id", "job-1"], ["status", "pending"]]);
      expect(allArgsOf("sync_jobs", "is")).toEqual([]);
      expect(allArgsOf("sync_jobs", "not")).toEqual([]);
    });

    it("дорожка документации берёт только documents, самое старое первым", async () => {
      mockTable("sync_jobs", ...claimResponses("documents"));
      const { syncJobRepository } = await import("./syncJobRepository");
      await syncJobRepository.claimNextPending("ru-vps", NOW, { kind: "documents" });

      expect(allArgsOf("sync_jobs", "eq")[0]).toEqual(["status", "pending"]);
      expect(allArgsOf("sync_jobs", "eq")).toContainEqual(["kind", "documents"]);
      expect(allArgsOf("sync_jobs", "order")[0]).toEqual(["created_at", { ascending: true }]);
      // Для документации живой поиск не применяется.
      expect(allArgsOf("sync_jobs", "is")).toEqual([]);
      expect(allArgsOf("sync_jobs", "not")).toEqual([]);
    });

    it("обход берёт full_sync без запроса, живой поиск — только с запросом", async () => {
      const { syncJobRepository } = await import("./syncJobRepository");

      mockTable("sync_jobs", ...claimResponses("full_sync"));
      await syncJobRepository.claimNextPending("ru-vps", NOW, { kind: "full_sync", live: false });
      expect(allArgsOf("sync_jobs", "eq")).toContainEqual(["kind", "full_sync"]);
      expect(allArgsOf("sync_jobs", "is")).toEqual([["payload->>liveQuery", null]]);
      expect(allArgsOf("sync_jobs", "not")).toEqual([]);

      calls.length = 0;
      mockTable("sync_jobs", ...claimResponses("full_sync", { liveQuery: "юристы" }));
      await syncJobRepository.claimNextPending("ru-vps", NOW, { kind: "full_sync", live: true });
      expect(allArgsOf("sync_jobs", "not")).toEqual([["payload->>liveQuery", "is", null]]);
      expect(allArgsOf("sync_jobs", "is")).toEqual([]);
    });

    it("full_sync без указания live берёт любой full_sync", async () => {
      mockTable("sync_jobs", ...claimResponses("full_sync"));
      const { syncJobRepository } = await import("./syncJobRepository");
      await syncJobRepository.claimNextPending("ru-vps", NOW, { kind: "full_sync" });
      expect(allArgsOf("sync_jobs", "is")).toEqual([]);
      expect(allArgsOf("sync_jobs", "not")).toEqual([]);
    });

    it("захват остаётся условным: обновление проходит, только пока строка pending", async () => {
      mockTable("sync_jobs", ...claimResponses("estimate"));
      const { syncJobRepository } = await import("./syncJobRepository");
      const claimed = await syncJobRepository.claimNextPending("ru-vps", NOW, { kind: "estimate" });

      expect(claimed?.status).toBe("processing");
      expect(updatePayload()).toMatchObject({ status: "processing", worker_id: "ru-vps", claimed_at: NOW, attempts: 1 });
      const eqs = allArgsOf("sync_jobs", "eq");
      expect(eqs.slice(-2)).toEqual([["id", "job-1"], ["status", "pending"]]);
    });

    it("в дорожке пусто — null без обновления; проигранный захват — тоже null", async () => {
      const { syncJobRepository } = await import("./syncJobRepository");
      mockTable("sync_jobs", { data: null, error: null });
      await expect(syncJobRepository.claimNextPending("ru-vps", NOW, { kind: "estimate" })).resolves.toBeNull();
      expect(allArgsOf("sync_jobs", "update")).toHaveLength(0);

      mockTable("sync_jobs", { data: jobRow({ kind: "estimate" }), error: null }, { data: [], error: null });
      await expect(syncJobRepository.claimNextPending("ru-vps", NOW, { kind: "estimate" })).resolves.toBeNull();
    });

    it("withPendingFilter: без отбора возвращает тот же запрос и ничего не вызывает", async () => {
      const { withPendingFilter } = await import("./syncJobRepository");
      const query = { eq: vi.fn(), is: vi.fn(), not: vi.fn() };
      expect(withPendingFilter(query, undefined)).toBe(query);
      expect(query.eq).not.toHaveBeenCalled();
    });

    it("счётчик по дорожкам делит full_sync на обход и живой поиск", async () => {
      mockTable(
        "sync_jobs",
        {
          data: [
            { kind: "documents" },
            { kind: "documents" },
            { kind: "estimate" },
            { kind: "full_sync" },
            { kind: "full_sync" },
            { kind: "full_sync" },
          ],
          error: null,
        },
        { data: null, error: null, count: 1 },
      );
      const { syncJobRepository } = await import("./syncJobRepository");
      await expect(syncJobRepository.countPendingByLane()).resolves.toEqual({
        documents: 2,
        estimate: 1,
        sync: 2,
        live: 1,
      });
      // Второй запрос (живой поиск) идёт только потому, что full_sync есть.
      expect(allArgsOf("sync_jobs", "not")).toEqual([["payload->>liveQuery", "is", null]]);
    });

    it("счётчик по дорожкам не делает второго запроса, когда full_sync нет", async () => {
      mockTable("sync_jobs", { data: [{ kind: "estimate" }], error: null });
      const { syncJobRepository } = await import("./syncJobRepository");
      await expect(syncJobRepository.countPendingByLane()).resolves.toEqual({ documents: 0, estimate: 1, sync: 0, live: 0 });
      expect(allArgsOf("sync_jobs", "not")).toEqual([]);
    });

    it("счётчик по дорожкам пробрасывает ошибку базы, а не отвечает «пусто»", async () => {
      mockTable("sync_jobs", { data: null, error: { message: "boom" } });
      const { syncJobRepository } = await import("./syncJobRepository");
      await expect(syncJobRepository.countPendingByLane()).rejects.toEqual({ message: "boom" });
    });
  });

  describe("очистка потерянных заданий не трогает то, что воркер выполняет сам", () => {
    const staleAt = "2026-09-25T01:00:00.000Z";

    it("задание из списка исключений остаётся в processing, даже если давно просрочено", async () => {
      mockTable("sync_jobs", {
        data: [
          { id: "job-mine", claimed_at: staleAt },
          { id: "job-lost", claimed_at: staleAt },
        ],
        error: null,
      });
      const { syncJobRepository } = await import("./syncJobRepository");
      const reset = await syncJobRepository.resetStaleJobs(30, new Date(NOW).getTime(), ["job-mine"]);

      expect(reset).toBe(1);
      expect(allArgsOf("sync_jobs", "update")).toHaveLength(1);
      const ids = allArgsOf("sync_jobs", "eq").filter((args) => args[0] === "id").map((args) => args[1]);
      expect(ids).toEqual(["job-lost"]);
    });

    it("сбросить все свои просроченные нельзя: ни одной записи", async () => {
      mockTable("sync_jobs", {
        data: [
          { id: "job-a", claimed_at: staleAt },
          { id: "job-b", claimed_at: staleAt },
        ],
        error: null,
      });
      const { syncJobRepository } = await import("./syncJobRepository");
      const reset = await syncJobRepository.resetStaleJobs(30, new Date(NOW).getTime(), new Set(["job-a", "job-b"]));
      expect(reset).toBe(0);
      expect(allArgsOf("sync_jobs", "update")).toHaveLength(0);
    });

    it("возврат в очередь проверяет статус ещё раз: завершившееся между выборкой и записью не воскрешается", async () => {
      mockTable("sync_jobs", { data: [{ id: "job-lost", claimed_at: staleAt }], error: null });
      const { syncJobRepository } = await import("./syncJobRepository");
      await syncJobRepository.resetStaleJobs(30, new Date(NOW).getTime());
      expect(allArgsOf("sync_jobs", "eq")).toContainEqual(["status", "processing"]);
    });
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
  describe("задания estimate: режим расчёта и аудита хранится в payload.mode", () => {
    const estimateRow = (payload: Record<string, unknown>) => jobRow({ kind: "estimate", payload });

    it("аудит ищется по payload.mode = audit, расчёт сметы — по отсутствию поля или «estimate»", async () => {
      mockTable("sync_jobs", { data: null, error: null });
      const { syncJobRepository } = await import("./syncJobRepository");

      await syncJobRepository.findActiveEstimate("t1", "audit");
      expect(allArgsOf("sync_jobs", "eq")).toContainEqual(["payload->>mode", "audit"]);
      expect(allArgsOf("sync_jobs", "or")).toEqual([]);

      calls.length = 0;
      await syncJobRepository.findActiveEstimate("t1");
      expect(allArgsOf("sync_jobs", "or")).toEqual([["payload->>mode.is.null,payload->>mode.eq.estimate"]]);
      expect(allArgsOf("sync_jobs", "eq").some((args) => args[0] === "payload->>mode")).toBe(false);
    });

    it("последний аудит и последний расчёт отбираются отдельно: один не подменяет другой", async () => {
      mockTable("sync_jobs", { data: estimateRow({ tenderId: "t1", mode: "audit" }), error: null });
      const { syncJobRepository } = await import("./syncJobRepository");

      const audit = await syncJobRepository.findLatestEstimate("t1", "audit");
      expect(audit?.payload).toMatchObject({ mode: "audit" });
      expect(allArgsOf("sync_jobs", "eq")).toContainEqual(["payload->>mode", "audit"]);

      calls.length = 0;
      await syncJobRepository.findLatestEstimate("t1", "estimate");
      expect(allArgsOf("sync_jobs", "or")).toHaveLength(1);
    });

    it("активное задание того же вида, но другого режима занятым не считается: фильтр режима обязателен в обоих вызовах", async () => {
      mockTable("sync_jobs", { data: null, error: null });
      const { syncJobRepository } = await import("./syncJobRepository");
      await syncJobRepository.findActiveEstimate("t1", "audit");
      // Вид и закупка по-прежнему в запросе — режим только сужает.
      expect(allArgsOf("sync_jobs", "eq")).toContainEqual(["kind", "estimate"]);
      expect(allArgsOf("sync_jobs", "eq")).toContainEqual(["payload->>tenderId", "t1"]);
      expect(allArgsOf("sync_jobs", "in")[0]?.[1]).toEqual(["pending", "processing"]);
    });
  });
});
