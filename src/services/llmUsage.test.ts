import { describe, expect, it, vi } from "vitest";

import type { LlmUsageInsert } from "@/repositories/llmUsageRepository";
import { recordLlmCall, usageIncludeFields } from "@/services/llmUsage";

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: vi.fn(),
}));

/**
 * Запись одного вызова в журнал расхода. Главное правило: сбой учёта не должен
 * ронять работу, за которую он считает деньги.
 */

describe("recordLlmCall", () => {
  it("собирает строку: вид работы, закупка, задание, токены, стоимость", async () => {
    const record = vi.fn(async (_row: LlmUsageInsert) => true);

    await recordLlmCall(
      { purpose: "estimate_bill", tenderId: "0138300000426000770", jobId: "sync-5", userId: "u-1" },
      {
        model: "google/gemini-2.5-flash",
        usage: { prompt_tokens: 50_000, completion_tokens: 2_000, cost: 0.9 },
        inputChars: 150_000,
        ok: true,
      },
      { record, env: {} },
    );

    expect(record).toHaveBeenCalledWith({
      purpose: "estimate_bill",
      tender_id: "0138300000426000770",
      job_id: "sync-5",
      user_id: "u-1",
      model: "google/gemini-2.5-flash",
      prompt_tokens: 50_000,
      completion_tokens: 2_000,
      cost_rub: 0.9,
      cost_source: "provider",
      provider_cost: 0.9,
      provider_currency: "RUB",
      usd_rub: null,
      input_chars: 150_000,
      ok: true,
      error: null,
    });
  });

  it("без закупки, задания и пользователя пишет null", async () => {
    const record = vi.fn(async (_row: LlmUsageInsert) => true);
    await recordLlmCall(
      { purpose: "search_assist" },
      { model: "m", inputChars: 100, ok: true },
      { record, env: {} },
    );
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      tender_id: null,
      job_id: null,
      user_id: null,
      prompt_tokens: 0,
      cost_rub: 0,
    });
  });

  it("не бросает, если запись упала", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const record = vi.fn(async () => {
      throw new Error("база недоступна");
    });

    await expect(
      recordLlmCall({ purpose: "deep_analysis" }, { model: "m", inputChars: 1, ok: true }, { record }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("база недоступна"));
    warn.mockRestore();
  });

  it("не бросает, если курс не получен и стоимость в долларах", async () => {
    const record = vi.fn(async (_row: LlmUsageInsert) => true);
    await recordLlmCall(
      { purpose: "rerank" },
      { model: "m", usage: { prompt_tokens: 1_000_000, cost: 0.3, currency: "USD" }, inputChars: 1, ok: true },
      { record, env: {}, usdRub: async () => null },
    );
    expect(record.mock.calls[0]?.[0]).toMatchObject({ cost_source: "price_table", cost_rub: 11 });
  });

  it("длинную ошибку не режет: это дело репозитория, а строка уходит как есть", async () => {
    const record = vi.fn(async (_row: LlmUsageInsert) => true);
    await recordLlmCall(
      { purpose: "other" },
      { model: "m", inputChars: 1, ok: false, error: "x".repeat(5000) },
      { record, env: {} },
    );
    expect(record.mock.calls[0]?.[0].ok).toBe(false);
  });
});

describe("usageIncludeFields", () => {
  it("по умолчанию в запрос ничего не добавляется", () => {
    expect(usageIncludeFields({})).toEqual({});
  });
  it("LLM_USAGE_INCLUDE=1 просит у шлюза стоимость в формате OpenRouter", () => {
    expect(usageIncludeFields({ LLM_USAGE_INCLUDE: "1" })).toEqual({ usage: { include: true } });
  });
});

describe("llmUsageRepository.record", () => {
  const row: LlmUsageInsert = {
    purpose: "deep_analysis",
    tender_id: "t",
    job_id: "j",
    user_id: null,
    model: "m",
    prompt_tokens: 1,
    completion_tokens: 1,
    cost_rub: 1.23456789,
    cost_source: "price_table",
    provider_cost: null,
    provider_currency: null,
    usd_rub: null,
    input_chars: 10,
    ok: true,
    error: null,
  };

  it("пишет строку в llm_usage_log с округлением до копеек и долей", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const { getSupabaseServerClient } = await import("@/lib/supabase");
    vi.mocked(getSupabaseServerClient).mockReturnValue({
      from: vi.fn(() => ({ insert })),
    } as never);

    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    expect(await llmUsageRepository.record(row)).toBe(true);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ cost_rub: 1.2346, purpose: "deep_analysis" }));
  });

  it("ошибку базы (нет таблицы) гасит и возвращает false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getSupabaseServerClient } = await import("@/lib/supabase");
    vi.mocked(getSupabaseServerClient).mockReturnValue({
      from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: { message: "relation does not exist" } })) })),
    } as never);

    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    expect(await llmUsageRepository.record(row)).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("исключение клиента (не задан SUPABASE_URL) тоже не вылетает наружу", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getSupabaseServerClient } = await import("@/lib/supabase");
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("SUPABASE_URL is not set");
    });

    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    await expect(llmUsageRepository.record(row)).resolves.toBe(false);
    warn.mockRestore();
  });

  it("длинную ошибку режет до тысячи знаков и убирает нулевой символ", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const { getSupabaseServerClient } = await import("@/lib/supabase");
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from: vi.fn(() => ({ insert })) } as never);

    const { llmUsageRepository } = await import("@/repositories/llmUsageRepository");
    await llmUsageRepository.record({ ...row, ok: false, error: `a\u0000${"б".repeat(5000)}` });
    const sent = (insert.mock.calls[0] as unknown as [{ error: string }])[0];
    expect(sent.error).toHaveLength(1000);
    expect(sent.error).not.toContain("\u0000");
  });
});
