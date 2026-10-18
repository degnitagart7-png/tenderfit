import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/repositories/llmUsageRepository", () => ({
  llmUsageRepository: { record: vi.fn(async () => true) },
}));

/**
 * Каждая точка вызова модели пишет в журнал расхода свой вид работы: по нему
 * отчёт отделяет глубокий анализ от сметы, поиска и диагностики. Шлюз здесь
 * подменён, база — тоже; проверяется то, что ушло в llm_usage_log.
 */

async function lastRow() {
  const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
  const calls = vi.mocked(llmUsageRepository.record).mock.calls;
  return calls[calls.length - 1]?.[0];
}

async function rowCount() {
  const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
  return vi.mocked(llmUsageRepository.record).mock.calls.length;
}

function gatewayAnswer(content: string, usage: Record<string, number> = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content } }], usage }),
    json: async () => ({ choices: [{ message: { content } }], usage }),
  } as Response;
}

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("LLM_API_KEY", "ключ");
  vi.stubEnv("LLM_BASE_URL", "https://routerai.ru/api/v1");
  const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
  vi.mocked(llmUsageRepository.record).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("точки вызова модели пишут вид работы", () => {
  it("глубокий анализ — deep_analysis", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer(JSON.stringify({ findings: [], summary: "ок" })));
    const { analyzeDocumentWithLlm } = await import("@/services/llmAnalysis");
    await analyzeDocumentWithLlm({
      documentText: "Текст",
      tenderContext: { regNumber: "T1", subject: "s", customerName: "c", price: 1 },
      companyProfile: { capabilities: "", restrictions: "" },
      usageContext: { tenderId: "T1", jobId: "J1" },
    });
    expect(await lastRow()).toMatchObject({ purpose: "deep_analysis", tender_id: "T1", job_id: "J1" });
  });

  it("извлечение ведомости для сметы — estimate_bill, с закупкой и заданием расчёта", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer(JSON.stringify({ has_bill: false, rows: [] })));
    const { fetchBillRows } = await import("@/services/billOfWorkExtraction");
    await fetchBillRows({
      chunk: "Текст",
      context: { regNumber: "0138300000426000770", subject: "Ремонт", jobId: "sync-9" },
      documentName: "ТЗ.docx",
    });
    expect(await lastRow()).toMatchObject({
      purpose: "estimate_bill",
      tender_id: "0138300000426000770",
      job_id: "sync-9",
      ok: true,
    });
  });

  it("смета по присланным файлам («без номера») пишется без закупки", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer(JSON.stringify({ has_bill: false, rows: [] })));
    const { fetchBillRows } = await import("@/services/billOfWorkExtraction");
    await fetchBillRows({
      chunk: "Текст",
      context: { regNumber: "без номера", subject: "Расчёт по документации", jobId: "sync-10" },
      documentName: "Смета.xlsx",
    });
    expect((await lastRow())?.tender_id).toBeNull();
  });

  it("сбой шлюза при извлечении ведомости тоже пишется, с ok=false", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "ошибка" } as Response);
    const { fetchBillRows } = await import("@/services/billOfWorkExtraction");
    await expect(
      fetchBillRows({ chunk: "Т", context: { regNumber: "T", subject: "s" }, documentName: "d" }),
    ).rejects.toThrow(/500/);
    expect(await lastRow()).toMatchObject({ purpose: "estimate_bill", ok: false });
  });

  it("подбор норм «ИИ-сметчиком» — estimate_norm_pick, с закупкой, заданием и своей моделью", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer(JSON.stringify({ items: [{ id: "1", pick: null, demolition: false, confidence: "high", reason: "нет" }] })));
    vi.stubEnv("TENDERFIT_NORM_PICK_MODEL", "google/gemini-2.5-pro");
    const { fetchNormPicks } = await import("@/services/normPickService");
    const answer = await fetchNormPicks({
      context: { regNumber: "0134300025826000377", subject: "Ремонт фасада", jobId: "sync-11" },
      items: [
        {
          id: "1",
          workName: "Демонтаж профлиста",
          quantity: 10,
          unit: "м2",
          remark: null,
          section: null,
          candidates: [
            { key: "ГЭСНр|63-03-007-02", book: "ГЭСНр", code: "63-03-007-02", tableCode: "63-03-007", tableName: "Замена облицовки", rowName: "от 1 м2 до 5 м2", unit: "100 м2", collection: "Облицовочные работы", summary: "" },
          ],
        },
      ],
    });
    expect(answer.tokens).toBe(120);
    expect(await lastRow()).toMatchObject({
      purpose: "estimate_norm_pick",
      tender_id: "0134300025826000377",
      job_id: "sync-11",
      model: "google/gemini-2.5-pro",
      ok: true,
      prompt_tokens: 100,
      completion_tokens: 20,
    });
    // В шлюз ушла именно эта модель.
    const sent = JSON.parse(String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body));
    expect(sent.model).toBe("google/gemini-2.5-pro");
  });

  it("сбой шлюза при подборе норм пишется с ok=false", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429, text: async () => "лимит" } as Response);
    const { fetchNormPicks } = await import("@/services/normPickService");
    await expect(
      fetchNormPicks({
        context: { regNumber: "T", subject: "s" },
        items: [{ id: "1", workName: "Работа", quantity: 1, unit: "м2", remark: null, section: null, candidates: [] }],
      }),
    ).rejects.toThrow(/429/);
    expect(await lastRow()).toMatchObject({ purpose: "estimate_norm_pick", ok: false });
  });

  it("варианты формулировки запроса — search_assist", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer('["правовое сопровождение"]'));
    const { createSearchAssist, llmChat } = await import("@/services/searchAssistService");
    await createSearchAssist(llmChat).expand("юридические услуги");
    expect(await lastRow()).toMatchObject({ purpose: "search_assist", tender_id: null, job_id: null });
  });

  it("оценка закупок по смыслу — rerank", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer("[]"));
    const { createSearchAssist, llmChat } = await import("@/services/searchAssistService");
    await createSearchAssist(llmChat).rerank({
      query: "юрист",
      candidates: [{ id: "a", subject: "Юридические услуги" }],
    });
    expect(await lastRow()).toMatchObject({ purpose: "rerank" });
  });

  it("ответ из кэша помощника поиска ничего не пишет: вызова не было", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer('{"synonyms": ["правовая помощь"]}'));
    const { createSearchAssist, llmChat } = await import("@/services/searchAssistService");
    const assist = createSearchAssist(llmChat);
    await assist.expand("договорная работа");
    const before = await rowCount();
    await assist.expand("договорная работа");
    expect(await rowCount()).toBe(before);
  });

  it("диагностика шлюза test-ai — other", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer("OK"));
    vi.stubEnv("ADMIN_TOKEN", "owner-token-123456");
    const { GET } = await import("@/app/api/analysis/test-ai/route");
    const { NextRequest } = await import("next/server");
    const response = await GET(
      new NextRequest("http://localhost/api/analysis/test-ai", {
        headers: { "x-admin-token": "owner-token-123456" },
      }),
    );
    vi.unstubAllEnvs();
    expect(response.status).toBe(200);
    expect(await lastRow()).toMatchObject({ purpose: "other", ok: true });
  });
});

describe("задание расчёта доезжает до журнала", () => {
  it("extractBillOfWork передаёт jobId в запрос к модели", async () => {
    const { extractBillOfWork } = await import("@/services/billOfWorkExtraction");
    const fetcher = vi.fn(async () => ({ rows: [], hasBill: false, tokens: 0, malformed: 0, truncated: false }));
    await extractBillOfWork(
      [{ name: "ТЗ.docx", text: "Текст документа" }],
      { regNumber: "T", subject: "s", jobId: "sync-3" },
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ jobId: "sync-3" }) }));
  });

  it("remoteBillRows отправляет jobId на прод, а ручка bill-rows передаёт его дальше", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rows: [], hasBill: false, tokens: 0 }),
    } as Response);
    const { remoteBillRows } = await import("@/services/billOfWorkExtraction");
    await remoteBillRows("https://app.example")({
      chunk: "Т",
      context: { regNumber: "T", subject: "s", jobId: "sync-4" },
      documentName: "d",
    });
    const sent = JSON.parse(String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body));
    expect(sent.jobId).toBe("sync-4");

    // Ручка принимает jobId и кладёт его в контекст вызова модели.
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer(JSON.stringify({ has_bill: false, rows: [] })));
    const { POST } = await import("@/app/api/estimate/bill-rows/route");
    process.env["TENDERFIT_WORKER_SECRET"] = "test-worker-secret-0123456789abcdef";
    const response = await POST({
      headers: new Headers({ "x-worker-secret": "test-worker-secret-0123456789abcdef" }),
      json: async () => ({ chunk: "Т", regNumber: "T", subject: "s", documentName: "d", jobId: "sync-4" }),
    } as never);
    delete process.env["TENDERFIT_WORKER_SECRET"];
    expect(response.status).toBe(200);
    expect(await lastRow()).toMatchObject({ purpose: "estimate_bill", job_id: "sync-4" });
  });
});
