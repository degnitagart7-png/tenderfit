import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(),
  })),
}));

describe("getSupabaseServerClient", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  });

  it("creates a Supabase client with correct URL and key", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { getSupabaseServerClient } = await import("./supabase");

    const client = getSupabaseServerClient();

    expect(client).toBeDefined();
    expect(createClient).toHaveBeenCalledWith(
      "https://test.supabase.co",
      "test-service-role-key",
      expect.objectContaining({ global: expect.any(Object) }),
    );
  });

  it("запрещает кэш Next.js для запросов к базе", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { getSupabaseServerClient } = await import("./supabase");

    getSupabaseServerClient();

    const options = vi.mocked(createClient).mock.calls[0]?.[2] as {
      global?: { fetch?: (input: string, init?: RequestInit) => Promise<unknown> };
    };
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    await options.global?.fetch?.("https://test.supabase.co/rest/v1/analysis_jobs", {
      method: "GET",
    });

    expect(fetchStub).toHaveBeenCalledWith(
      "https://test.supabase.co/rest/v1/analysis_jobs",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    vi.unstubAllGlobals();
  });

  it("returns the same singleton instance on repeated calls", async () => {
    const { getSupabaseServerClient } = await import("./supabase");

    const client1 = getSupabaseServerClient();
    const client2 = getSupabaseServerClient();

    expect(client1).toBe(client2);
  });

  it("throws if SUPABASE_URL is missing", async () => {
    delete process.env.SUPABASE_URL;
    const { getSupabaseServerClient } = await import("./supabase");

    expect(() => getSupabaseServerClient()).toThrow("SUPABASE_URL");
  });

  it("throws if SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { getSupabaseServerClient } = await import("./supabase");

    expect(() => getSupabaseServerClient()).toThrow("SUPABASE_SERVICE_ROLE_KEY");
  });
});
