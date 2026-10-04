import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    from: mockFrom,
  }),
}));

function mockChain(data: unknown = null, error: unknown = null) {
  const singleFn = vi.fn().mockResolvedValue({ data, error });

  mockFrom.mockReturnValue({
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: singleFn,
      }),
    }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({ data: Array.isArray(data) ? data : [data], error }),
      }),
      order: vi.fn().mockResolvedValue({ data: Array.isArray(data) ? data : [data], error }),
    }),
  });

  return { singleFn };
}

describe("verdictHistoryRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a verdict change", async () => {
    const entry = {
      id: "vh-1",
      tender_id: "0123456789",
      old_verdict: "RECOMMENDED",
      new_verdict: "MANUAL_REVIEW",
      old_score: 80,
      new_score: 60,
      reason: "Обнаружен риск в документе",
      triggered_by: "document_analysis",
      analysis_id: "analysis-1",
      created_at: "2026-09-21T00:00:00Z",
    };

    mockChain(entry);

    const { verdictHistoryRepository } = await import("./verdictHistoryRepository");
    const result = await verdictHistoryRepository.record({
      tender_id: "0123456789",
      old_verdict: "RECOMMENDED",
      new_verdict: "MANUAL_REVIEW",
      old_score: 80,
      new_score: 60,
      reason: "Обнаружен риск в документе",
      triggered_by: "document_analysis",
      analysis_id: "analysis-1",
    });

    expect(result).toEqual(entry);
  });

  it("fetches history for a tender", async () => {
    const entries = [
      { id: "vh-1", tender_id: "0123456789", new_verdict: "MANUAL_REVIEW" },
      { id: "vh-2", tender_id: "0123456789", new_verdict: "NOT_RECOMMENDED" },
    ];

    mockChain(entries);

    const { verdictHistoryRepository } = await import("./verdictHistoryRepository");
    const result = await verdictHistoryRepository.findByTenderId("0123456789");

    expect(result).toEqual(entries);
  });
});
