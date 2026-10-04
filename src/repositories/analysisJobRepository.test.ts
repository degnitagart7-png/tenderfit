import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    from: mockFrom,
  }),
}));

interface ChainCall {
  method: string;
  args: unknown[];
}

interface ChainResponse {
  data: unknown;
  error: unknown;
  count?: number | null;
}

const calls: ChainCall[] = [];
const EMPTY: ChainResponse = { data: null, error: null };
let responses: ChainResponse[] = [EMPTY];

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

/** Последний ответ остаётся для всех последующих запросов. */
function currentResponse(): ChainResponse {
  if (responses.length > 1) return responses.shift() ?? EMPTY;
  return responses[0] ?? EMPTY;
}

/**
 * Цепочка вызовов PostgREST: любой метод возвращает её же и запоминает аргументы,
 * а await даёт текущий ответ. Такое не ломается от добавления ещё одного
 * .order() или .limit() в запрос.
 */
function chain() {
  const node: Record<string, unknown> = {
    then: (resolve: (value: unknown) => void) => resolve(currentResponse()),
    single: async () => currentResponse(),
    maybeSingle: async () => currentResponse(),
  };
  for (const method of CHAIN_METHODS) {
    node[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return node;
    };
  }
  return node;
}

mockFrom.mockImplementation(() => chain());

/** Успешный ответ. */
function mockChain(data: unknown = null, error: unknown = null) {
  responses = [{ data, error }];
}

/** Несколько ответов подряд — по одному на каждый запрос метода. */
function mockSequence(...items: ChainResponse[]) {
  responses = items;
}

/** Аргументы всех вызовов указанного метода. */
function allArgsOf(method: string): unknown[][] {
  return calls.filter((call) => call.method === method).map((call) => call.args);
}

/** Набор полей, который репозиторий отправил в update: по нему видно состав запроса. */
function updatePayload(): Record<string, unknown> {
  return (allArgsOf("update")[0]?.[0] ?? {}) as Record<string, unknown>;
}

describe("analysisJobRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    responses = [EMPTY];
    mockFrom.mockImplementation(() => chain());
  });

  it("creates a job with pending status", async () => {
    const job = {
      id: "job-1",
      tender_id: "0123456789",
      job_type: "full_analysis",
      status: "pending",
      priority: 0,
      documents_total: 0,
      documents_processed: 0,
      created_at: "2026-09-21T00:00:00Z",
      updated_at: "2026-09-21T00:00:00Z",
    };

    mockChain(job);

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const result = await analysisJobRepository.create("0123456789", "full_analysis");

    expect(result).toEqual(job);
    expect(mockFrom).toHaveBeenCalledWith("analysis_jobs");
  });

  it("creates a job with custom priority", async () => {
    const job = {
      id: "job-2",
      tender_id: "0123456789",
      job_type: "full_analysis",
      status: "pending",
      priority: 10,
      documents_total: 0,
      documents_processed: 0,
    };

    mockChain(job);

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const result = await analysisJobRepository.create("0123456789", "full_analysis", 10);

    expect(result.priority).toBe(10);
  });

  it("finds jobs by tender_id", async () => {
    const jobs = [
      { id: "job-1", tender_id: "0123456789", status: "pending" },
      { id: "job-2", tender_id: "0123456789", status: "completed" },
    ];

    mockChain(jobs);

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const result = await analysisJobRepository.findByTenderId("0123456789");

    expect(result).toEqual(jobs);
  });

  it("updates job status to processing", async () => {
    const job = { id: "job-1", status: "processing", started_at: "2026-09-21T00:00:00Z" };

    mockChain(job);

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const result = await analysisJobRepository.updateStatus("job-1", "processing");

    expect(result).toEqual(job);
  });

  it("задаёт documents_processed одним запросом, без чтения текущего значения", async () => {
    mockChain();

    const { analysisJobRepository } = await import("./analysisJobRepository");
    await analysisJobRepository.setDocumentsProcessed("job-1", 4);

    expect(allArgsOf("update")).toEqual([[{ documents_processed: 4 }]]);
    expect(allArgsOf("eq")).toEqual([["id", "job-1"]]);
    // Инкремент требовал сначала прочитать счётчик; точное значение читает нечего.
    expect(calls.some((call) => call.method === "select")).toBe(false);
  });

  it("пробрасывает ошибку записи счётчика", async () => {
    mockChain(null, { code: "42501", message: "permission denied" });

    const { analysisJobRepository } = await import("./analysisJobRepository");
    await expect(analysisJobRepository.setDocumentsProcessed("job-1", 4)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("отбирает задачи в очереди по приоритету и времени создания", async () => {
    const jobs = [
      { id: "job-9", tender_id: "A", status: "pending", priority: 10 },
      { id: "job-1", tender_id: "B", status: "pending", priority: 0 },
    ];
    mockChain(jobs);

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const result = await analysisJobRepository.findPending(20);

    expect(result).toEqual(jobs);
    expect(allArgsOf("eq")).toEqual([["status", "pending"]]);
    expect(allArgsOf("order")).toEqual([
      ["priority", { ascending: false }],
      ["created_at", { ascending: true }],
    ]);
    expect(allArgsOf("limit")).toEqual([[20]]);
  });

  it("resetStaleJobs возвращает в очередь только зависшие задачи", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    mockSequence(
      { data: [{ id: "job-fresh", updated_at: fresh }, { id: "job-stale", updated_at: stale }], error: null },
      { data: { id: "job-stale", status: "pending" }, error: null },
    );

    const { analysisJobRepository } = await import("./analysisJobRepository");
    const reset = await analysisJobRepository.resetStaleJobs(10);

    expect(reset).toBe(1);
    expect(allArgsOf("eq")).toEqual([
      ["status", "processing"],
      ["id", "job-stale"],
    ]);
  });

  describe("claimNextPending", () => {
    it("забирает задачу из очереди и помечает её processing", async () => {
      mockSequence(
        { data: { id: "job-1", status: "pending" }, error: null },
        { data: [{ id: "job-1", status: "processing", started_at: "2026-09-21T21:33:47Z" }], error: null },
      );

      const { analysisJobRepository } = await import("./analysisJobRepository");
      const claimed = await analysisJobRepository.claimNextPending();

      expect(claimed?.id).toBe("job-1");
      expect(claimed?.status).toBe("processing");
      expect(allArgsOf("eq")).toEqual([
        ["status", "pending"],
        ["id", "job-1"],
        ["status", "pending"],
      ]);
      expect(updatePayload()["status"]).toBe("processing");
      expect(updatePayload()).toHaveProperty("started_at");
    });

    it("не забирает задачу, которую уже перехватил другой воркер", async () => {
      mockSequence(
        { data: { id: "job-1", status: "pending" }, error: null },
        { data: [], error: null },
      );

      const { analysisJobRepository } = await import("./analysisJobRepository");

      expect(await analysisJobRepository.claimNextPending()).toBeNull();
    });

    it("в пустой очереди нечего забирать и нечего обновлять", async () => {
      mockChain(null);

      const { analysisJobRepository } = await import("./analysisJobRepository");

      expect(await analysisJobRepository.claimNextPending()).toBeNull();
      expect(allArgsOf("update")).toEqual([]);
    });
  });

  describe("error_message", () => {
    it("успешное завершение стирает причину прошлого сбоя", async () => {
      mockChain({ id: "job-1", status: "completed", error_message: null });

      const { analysisJobRepository } = await import("./analysisJobRepository");
      await analysisJobRepository.updateStatus("job-1", "completed");

      expect(updatePayload()["status"]).toBe("completed");
      expect(updatePayload()["error_message"]).toBeNull();
      expect(updatePayload()).toHaveProperty("finished_at");
    });

    it("возврат в очередь на дозапуск не оставляет текст ошибки", async () => {
      mockChain({ id: "job-1", status: "pending", error_message: null });

      const { analysisJobRepository } = await import("./analysisJobRepository");
      await analysisJobRepository.updateStatus("job-1", "pending");

      expect(updatePayload()["error_message"]).toBeNull();
      expect(updatePayload()).not.toHaveProperty("finished_at");
    });

    it("сбой сохраняет причину", async () => {
      mockChain({ id: "job-1", status: "failed" });

      const { analysisJobRepository } = await import("./analysisJobRepository");
      await analysisJobRepository.updateStatus("job-1", "failed", "OpenRouter 429");

      expect(updatePayload()["error_message"]).toBe("OpenRouter 429");
      expect(updatePayload()).toHaveProperty("finished_at");
    });
  });

  describe("countCreatedSince", () => {
    it("считает задачи суток счётчиком, а не выборкой строк", async () => {
      responses = [{ data: null, error: null, count: 7 }];

      const { analysisJobRepository } = await import("./analysisJobRepository");
      const count = await analysisJobRepository.countCreatedSince("2026-09-21T21:00:00.000Z");

      expect(count).toBe(7);
      expect(calls.find((call) => call.method === "select")?.args[1]).toMatchObject({
        count: "exact",
        head: true,
      });
      expect(allArgsOf("gte")).toEqual([["created_at", "2026-09-21T21:00:00.000Z"]]);
    });

    it("база не отдала счётчик — это ноль задач, а не неопределённость", async () => {
      responses = [{ data: null, error: null, count: null }];

      const { analysisJobRepository } = await import("./analysisJobRepository");
      expect(await analysisJobRepository.countCreatedSince("2026-09-21T21:00:00.000Z")).toBe(0);
    });

    it("пробрасывает ошибку базы: молчаливый ноль открыл бы безлимитный разбор", async () => {
      responses = [{ data: null, error: { code: "42P01", message: "relation does not exist" } }];

      const { analysisJobRepository } = await import("./analysisJobRepository");
      await expect(
        analysisJobRepository.countCreatedSince("2026-09-21T21:00:00.000Z"),
      ).rejects.toMatchObject({ code: "42P01" });
    });
  });
});
