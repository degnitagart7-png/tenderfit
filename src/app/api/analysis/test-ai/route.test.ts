import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

describe("GET /api/analysis/test-ai", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("без ключа владельца модель не вызывается", async () => {
    vi.stubEnv("ADMIN_TOKEN", "owner-token-123456");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await GET(new NextRequest("http://localhost/api/analysis/test-ai"));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("без ADMIN_TOKEN на сервере проверка выключена", async () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await GET(new NextRequest("http://localhost/api/analysis/test-ai"));
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
