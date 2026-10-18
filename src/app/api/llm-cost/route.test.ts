import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/repositories/llmUsageRepository", () => ({
  llmUsageRepository: { listBetween: vi.fn() },
}));

/** Ручка расхода на ИИ закрыта ключом владельца, как /api/sync-profiles. */

function request(token?: string, ip = "10.0.0.1") {
  const headers = new Map<string, string>();
  if (token !== undefined) headers.set("x-admin-token", token);
  headers.set("x-forwarded-for", ip);
  return { headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null } } as never;
}

const SECRET = "очень-длинный-ключ-владельца";
let counter = 0;

beforeEach(() => {
  counter += 1;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/llm-cost", () => {
  it("ADMIN_TOKEN не задан — ручка выключена (503), а не открыта", async () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    const { GET } = await import("./route");
    const response = await GET(request(SECRET, `10.1.0.${counter}`));
    expect(response.status).toBe(503);
  });

  it("без ключа или с чужим ключом — 401, база не читается", async () => {
    vi.stubEnv("ADMIN_TOKEN", SECRET);
    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    const { GET } = await import("./route");

    expect((await GET(request(undefined, `10.2.0.${counter}`))).status).toBe(401);
    expect((await GET(request("чужой-ключ-ключ", `10.2.1.${counter}`))).status).toBe(401);
    expect(llmUsageRepository.listBetween).not.toHaveBeenCalled();
  });

  it("с верным ключом отдаёт свод за 30 дней без списка дорогих закупок", async () => {
    vi.stubEnv("ADMIN_TOKEN", SECRET);
    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    vi.mocked(llmUsageRepository.listBetween).mockResolvedValueOnce([
      {
        created_at: new Date().toISOString(),
        purpose: "deep_analysis",
        tender_id: "T1",
        job_id: "J1",
        prompt_tokens: 100,
        completion_tokens: 10,
        cost_rub: 4.5,
        input_chars: 1000,
        ok: true,
      },
    ]);
    const { GET } = await import("./route");

    const response = await GET(request(SECRET, `10.3.0.${counter}`));
    const body = (await response.json()) as {
      windowDays: number;
      summary: { totalRub: number; deepAnalysis: Record<string, unknown> };
    };

    expect(response.status).toBe(200);
    expect(body.windowDays).toBe(30);
    expect(body.summary.totalRub).toBe(4.5);
    expect(body.summary.deepAnalysis["avgRub"]).toBe(4.5);
    expect(body.summary.deepAnalysis).not.toHaveProperty("top");
  });

  it("таблицы нет — 503 с указанием на миграцию", async () => {
    vi.stubEnv("ADMIN_TOKEN", SECRET);
    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    vi.mocked(llmUsageRepository.listBetween).mockRejectedValueOnce({ code: "42P01", message: "нет таблицы" });
    const { GET } = await import("./route");

    const response = await GET(request(SECRET, `10.4.0.${counter}`));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("20261008000016");
  });
});
