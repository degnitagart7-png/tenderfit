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
  "eq",
  "order",
  "limit",
  "range",
] as const;

function currentResponse(): ChainResponse {
  if (responses.length > 1) return responses.shift() ?? EMPTY;
  return responses[0] ?? EMPTY;
}

/** Цепочка PostgREST: любой метод возвращает её же и запоминает аргументы. */
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

describe("documentAnalysisRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    responses = [EMPTY];
    mockFrom.mockImplementation(() => chain());
  });

  it("пишет результат разбора одного фрагмента", async () => {
    const row = { id: "an-1", tender_id: "0573100026626000009", model_used: "google/gemini-2.5-flash" };
    responses = [{ data: row, error: null }];

    const { documentAnalysisRepository } = await import("./documentAnalysisRepository");
    const result = await documentAnalysisRepository.record({
      tender_id: "0573100026626000009",
      document_id: "doc-1",
      model_used: "google/gemini-2.5-flash",
      findings: [
        {
          category: "blocker",
          title: "Требуется лицензия ФСБ",
          detail: "Участник должен иметь лицензию на работу со сведениями гостайны.",
          evidence_quote: "наличие лицензии ФСБ России",
          evidence_section: "Требования к участникам",
          severity: "high",
        },
      ],
      summary: "Найден блокирующий фактор",
      tokens_used: 1234,
      processing_time_ms: 5678,
    });

    expect(result).toEqual(row);
    expect(mockFrom).toHaveBeenCalledWith("document_analyses");

    const inserted = calls.find((call) => call.method === "insert")?.args[0] as Record<
      string,
      unknown
    >;
    // Находки и вывод хранятся одним JSON-объектом: так их читает интерфейс карточки.
    expect(inserted["analysis"]).toMatchObject({ summary: "Найден блокирующий фактор" });
    expect((inserted["analysis"] as { findings: unknown[] }).findings).toHaveLength(1);
    expect(inserted["tokens_used"]).toBe(1234);
  });

  it("отдаёт разборы закупки в порядке появления", async () => {
    const rows = [{ id: "an-1" }, { id: "an-2" }];
    responses = [{ data: rows, error: null }];

    const { documentAnalysisRepository } = await import("./documentAnalysisRepository");
    const result = await documentAnalysisRepository.findByTenderId("0573100026626000009");

    expect(result).toEqual(rows);
    expect(calls.filter((call) => call.method === "order").map((call) => call.args)).toEqual([
      ["created_at", { ascending: true }],
    ]);
  });

  it("считает разобранные фрагменты документа", async () => {
    responses = [{ data: null, error: null, count: 3 }];

    const { documentAnalysisRepository } = await import("./documentAnalysisRepository");
    const count = await documentAnalysisRepository.countByDocumentId("doc-1");

    expect(count).toBe(3);
    // Счётчиком, а не выборкой строк: фрагменты содержат десятки тысяч знаков.
    expect(calls.find((call) => call.method === "select")?.args[1]).toMatchObject({
      count: "exact",
      head: true,
    });
  });

  it("пробрасывает ошибку базы", async () => {
    responses = [{ data: null, error: { code: "42P01", message: "relation does not exist" } }];

    const { documentAnalysisRepository } = await import("./documentAnalysisRepository");
    await expect(
      documentAnalysisRepository.record({
        tender_id: "1",
        document_id: "doc-1",
        model_used: "m",
        findings: [],
        summary: "",
      }),
    ).rejects.toMatchObject({ code: "42P01" });
  });
});
