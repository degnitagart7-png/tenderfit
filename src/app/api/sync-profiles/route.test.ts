import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/repositories/syncProfileRepository", () => {
  class SyncProfilesTableMissingError extends Error {}
  return {
    SyncProfilesTableMissingError,
    syncProfileRepository: { list: vi.fn(), replaceAll: vi.fn() },
  };
});

import { GET, PUT } from "@/app/api/sync-profiles/route";
import {
  SyncProfilesTableMissingError,
  syncProfileRepository,
} from "@/repositories/syncProfileRepository";

/**
 * Ручка профилей сбора.
 *
 * Входа в приложении нет, поэтому запись закрыта ключом владельца. Ключ не
 * задан — ручка выключена: открытая запись позволила бы любому посетителю
 * менять темы, по которым сервер ходит на чужие площадки.
 */

const repo = vi.mocked(syncProfileRepository);
const TOKEN = "owner-key-12345";

let counter = 0;
function request(method: "GET" | "PUT", opts: { token?: string; body?: unknown } = {}): NextRequest {
  counter += 1;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-real-ip": `10.2.0.${String(counter)}`,
  };
  if (opts.token !== undefined) headers["x-admin-token"] = opts.token;
  return new NextRequest("http://localhost/api/sync-profiles", {
    method,
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
}

const profile = {
  name: "Юридические услуги",
  laws: ["FZ_44", "FZ_223"],
  keywords: ["юрист"],
  okpd2Codes: [],
  minPrice: null,
  maxPrice: null,
  enabled: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ADMIN_TOKEN", TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/sync-profiles", () => {
  it("ключ на сервере не задан — 503, в базу не ходит", async () => {
    vi.stubEnv("ADMIN_TOKEN", "");

    const response = await PUT(request("PUT", { token: TOKEN, body: { profiles: [profile] } }));

    expect(response.status).toBe(503);
    expect(repo.replaceAll).not.toHaveBeenCalled();
  });

  it("без ключа и с чужим ключом — 401, в базу не ходит", async () => {
    const none = await PUT(request("PUT", { body: { profiles: [profile] } }));
    const wrong = await PUT(request("PUT", { token: "wrong-key-123456", body: { profiles: [profile] } }));

    expect(none.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(repo.replaceAll).not.toHaveBeenCalled();
  });

  it("верный ключ и корректный набор — сохраняет и называет число", async () => {
    repo.replaceAll.mockResolvedValue(undefined);

    const response = await PUT(request("PUT", { token: TOKEN, body: { profiles: [profile] } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: 1 });
    expect(repo.replaceAll).toHaveBeenCalledWith([expect.objectContaining({ name: "Юридические услуги" })]);
  });

  it("профиль без ключевых слов — 400 с причиной, в базу не ходит", async () => {
    const response = await PUT(
      request("PUT", { token: TOKEN, body: { profiles: [{ ...profile, keywords: [] }] } }),
    );

    expect(response.status).toBe(400);
    expect(repo.replaceAll).not.toHaveBeenCalled();
  });

  it("тело не JSON — 400", async () => {
    const response = await PUT(request("PUT", { token: TOKEN, body: "{не json" }));

    expect(response.status).toBe(400);
  });

  it("миграция не применена — 503 с указанием, что делать", async () => {
    repo.replaceAll.mockRejectedValue(new SyncProfilesTableMissingError());

    const response = await PUT(request("PUT", { token: TOKEN, body: { profiles: [profile] } }));

    expect(response.status).toBe(503);
  });

  it("GET с верным ключом отдаёт профили сервера", async () => {
    repo.list.mockResolvedValue([profile as never]);

    const response = await GET(request("GET", { token: TOKEN }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ profiles: [profile] });
  });

  it("GET без ключа — 401", async () => {
    const response = await GET(request("GET"));

    expect(response.status).toBe(401);
    expect(repo.list).not.toHaveBeenCalled();
  });
});
