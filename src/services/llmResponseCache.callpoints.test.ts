import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImpliedRequest } from "@/domain/estimate/impliedWorks";

const store = vi.hoisted(() => {
  const rows = new Map<string, { response: string; hits: number }>();
  return {
    rows,
    get: vi.fn(async (key: string) => {
      const row = rows.get(key);
      return row === undefined ? null : { key, response: row.response, hits: row.hits };
    }),
    put: vi.fn(async (entry: { key: string; response: string }) => {
      rows.set(entry.key, { response: entry.response, hits: 0 });
    }),
    touch: vi.fn(async (key: string, hits: number) => {
      const row = rows.get(key);
      if (row !== undefined) row.hits = hits;
    }),
  };
});

vi.mock("@/repositories/llmResponseCacheRepository", () => ({ llmResponseCacheRepository: store }));
vi.mock("@/repositories/llmUsageRepository", () => ({ llmUsageRepository: { record: vi.fn(async () => true) } }));

/**
 * Кэш на настоящих точках вызова модели (ведомость, подбор норм и материалов, работы по технологии): шлюз подменён, база — тоже.
 * Проверяется, что второй такой же запрос не доходит до шлюза и не пишется в журнал расхода, а оборванный ответ не запоминается.
 */

function gatewayAnswer(content: string, extra: { finish_reason?: string } = {}): Response {
  const body = { choices: [{ message: { content }, ...extra }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response;
}

const BILL_REQUEST = {
  chunk: "Устройство пароизоляции | м2 | 640",
  context: { regNumber: "0134300025826000377", subject: "Ремонт кровли", jobId: "bench-blind:1" },
  documentName: "ТЗ.docx",
};

const BATCH = {
  context: { regNumber: "0134300025826000377", subject: "Ремонт фасада", jobId: "sync-5" },
  items: [{ id: "1", workName: "Демонтаж профлиста", quantity: 10, unit: "м2", remark: null, section: null, candidates: [] }],
};

beforeEach(() => {
  store.rows.clear();
  store.get.mockClear();
  store.put.mockClear();
  store.touch.mockClear();
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("LLM_API_KEY", "ключ");
  vi.stubEnv("LLM_BASE_URL", "https://routerai.ru/api/v1");
  vi.stubEnv("LLM_CACHE_DISABLED", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("извлечение ведомости (estimate_bill)", () => {
  it("второй такой же фрагмент берётся из кэша: шлюз не зовётся, расход не пишется, строки те же", async () => {
    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    const { fetchBillRows } = await import("@/services/billOfWorkExtraction");
    const reply = JSON.stringify({ has_bill: true, rows: [{ work_name: "Устройство пароизоляции", quantity: "640", unit: "м2", evidence_quote: "Устройство пароизоляции | м2 | 640" }] });
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer(reply, { finish_reason: "stop" }));
    vi.mocked(llmUsageRepository.record).mockClear();

    const first = await fetchBillRows(BILL_REQUEST);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(llmUsageRepository.record).toHaveBeenCalledTimes(1);
    expect(first.tokens).toBe(120);

    const second = await fetchBillRows(BILL_REQUEST);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(llmUsageRepository.record).toHaveBeenCalledTimes(1);
    expect(second.rows).toEqual(first.rows);
    expect(second.hasBill).toBe(true);
    expect(second.tokens).toBe(0);
    await vi.waitFor(() => expect(store.touch).toHaveBeenCalledTimes(1));
  });

  it("другой текст фрагмента — другой запрос: шлюз зовётся снова", async () => {
    const { fetchBillRows } = await import("@/services/billOfWorkExtraction");
    vi.mocked(fetch).mockResolvedValue(gatewayAnswer(JSON.stringify({ has_bill: false, rows: [] }), { finish_reason: "stop" }));
    await fetchBillRows(BILL_REQUEST);
    await fetchBillRows({ ...BILL_REQUEST, chunk: "Другой фрагмент документа" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ответ, оборванный по токенам (finish_reason length), не кэшируется", async () => {
    const { fetchBillRows } = await import("@/services/billOfWorkExtraction");
    vi.mocked(fetch).mockResolvedValue(gatewayAnswer(JSON.stringify({ has_bill: false, rows: [] }), { finish_reason: "length" }));
    await fetchBillRows(BILL_REQUEST);
    await fetchBillRows(BILL_REQUEST);
    expect(store.put).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ответ, дочитанный разбором из оборванного JSON (truncated), не кэшируется", async () => {
    const { fetchBillRows } = await import("@/services/billOfWorkExtraction");
    const cut = '{"has_bill":true,"rows":[{"work_name":"Кладка","quantity":"5","unit":"м3","evidence_quote":"Кладка | м3 | 5"},{"work_name":"Недопис';
    vi.mocked(fetch).mockResolvedValue(gatewayAnswer(cut));
    const answer = await fetchBillRows(BILL_REQUEST);
    expect(answer.truncated).toBe(true);
    expect(answer.rows).toHaveLength(1);
    expect(store.put).not.toHaveBeenCalled();
  });

  it("ответ не JSON не кэшируется, ошибка пробрасывается, расход пишется с ok=false", async () => {
    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    const { fetchBillRows } = await import("@/services/billOfWorkExtraction");
    vi.mocked(llmUsageRepository.record).mockClear();
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer("извините, не могу", { finish_reason: "stop" }));
    await expect(fetchBillRows(BILL_REQUEST)).rejects.toThrow(/не JSON/);
    expect(store.put).not.toHaveBeenCalled();
    expect(vi.mocked(llmUsageRepository.record).mock.calls[0]?.[0]).toMatchObject({ purpose: "estimate_bill", ok: false });
  });

  it("таблицы кэша нет: расчёт идёт настоящим вызовом", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchBillRows } = await import("@/services/billOfWorkExtraction");
    store.get.mockRejectedValueOnce(new Error('relation "llm_response_cache" does not exist'));
    store.put.mockRejectedValueOnce(new Error('relation "llm_response_cache" does not exist'));
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer(JSON.stringify({ has_bill: false, rows: [] }), { finish_reason: "stop" }));
    const answer = await fetchBillRows(BILL_REQUEST);
    expect(answer.tokens).toBe(120);
    vi.restoreAllMocks();
  });

  it("LLM_CACHE_DISABLED=1: хранилище не трогается", async () => {
    vi.stubEnv("LLM_CACHE_DISABLED", "1");
    const { fetchBillRows } = await import("@/services/billOfWorkExtraction");
    vi.mocked(fetch).mockResolvedValue(gatewayAnswer(JSON.stringify({ has_bill: false, rows: [] }), { finish_reason: "stop" }));
    await fetchBillRows(BILL_REQUEST);
    await fetchBillRows(BILL_REQUEST);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });
});

describe("подбор норм и материалов (estimate_norm_pick)", () => {
  const reply = JSON.stringify({ items: [{ id: "1", pick: null, demolition: false, confidence: "high", reason: "нет" }] });

  it("тот же запрос второй раз — из кэша: шлюз не зовётся, ответ тот же, tokens 0", async () => {
    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    const { fetchNormPicks } = await import("@/services/normPickService");
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer(reply, { finish_reason: "stop" }));
    vi.mocked(llmUsageRepository.record).mockClear();

    const first = await fetchNormPicks(BATCH);
    const second = await fetchNormPicks(BATCH);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(llmUsageRepository.record).toHaveBeenCalledTimes(1);
    expect(first.tokens).toBe(120);
    expect(second.tokens).toBe(0);
    expect(second.picks).toEqual(first.picks);
  });

  it("другая модель подбора — другой ключ", async () => {
    const { fetchNormPicks } = await import("@/services/normPickService");
    vi.mocked(fetch).mockResolvedValue(gatewayAnswer(reply, { finish_reason: "stop" }));
    await fetchNormPicks(BATCH);
    await fetchNormPicks(BATCH, undefined, { TENDERFIT_NORM_PICK_MODEL: "google/gemini-2.5-pro" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("оборванный ответ (length) и ответ не JSON не кэшируются", async () => {
    const { fetchNormPicks } = await import("@/services/normPickService");
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer(reply, { finish_reason: "length" }));
    await fetchNormPicks(BATCH);
    expect(store.put).not.toHaveBeenCalled();

    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer("не JSON", { finish_reason: "stop" }));
    await expect(fetchNormPicks(BATCH)).rejects.toThrow();
    expect(store.put).not.toHaveBeenCalled();
  });
});

describe("работы по технологии (estimate_implied)", () => {
  it("тот же запрос второй раз — из кэша", async () => {
    const { fetchImpliedWorks } = await import("@/services/impliedWorksService");
    vi.mocked(fetch).mockResolvedValueOnce(gatewayAnswer(JSON.stringify({ additions: [] }), { finish_reason: "stop" }));
    const request: ImpliedRequest = {
      context: { regNumber: "0134300025826000377", subject: "Ремонт фасада", jobId: "sync-5" },
      facts: { heightM: 12, floors: null, mentions: { facade: true, roof: false, interior: false }, snippets: [] },
      items: [{ id: "1", name: "Монтаж утеплителя", quantity: 56.5, unit: "м2", norm: null, machines: null }],
    };
    await fetchImpliedWorks(request);
    await fetchImpliedWorks(request);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("вне сметы кэша нет", () => {
  it("поиск (search_assist) каждый раз идёт в шлюз", async () => {
    const { llmChat } = await import("@/services/searchAssistService");
    vi.mocked(fetch).mockResolvedValue(gatewayAnswer('["правовая помощь"]', { finish_reason: "stop" }));
    await llmChat("запрос", 100, { purpose: "search_assist" });
    await llmChat("запрос", 100, { purpose: "search_assist" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.get).not.toHaveBeenCalled();
  });
});
