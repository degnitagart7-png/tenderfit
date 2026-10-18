import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = { getUser: vi.fn() };
let enabled = true;

vi.mock("@/services/authRuntime", () => ({
  SESSION_COOKIE: "tf_session",
  getAuthService: () => (enabled ? auth : null),
}));
vi.mock("@/repositories/userDataRepository", () => ({
  userDataRepository: { get: vi.fn(), put: vi.fn() },
}));

import { GET, PUT } from "@/app/api/me/data/route";
import { userDataRepository } from "@/repositories/userDataRepository";

/**
 * Данные аккаунта доступны только вошедшему: без действующей сессии — 401, и
 * чужие данные не читаются и не пишутся.
 */

const repo = vi.mocked(userDataRepository);

let counter = 0;
function call(method: "GET" | "PUT", opts: { cookie?: string; body?: unknown } = {}): NextRequest {
  counter += 1;
  const headers: Record<string, string> = { "x-real-ip": `10.5.0.${String(counter)}` };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new NextRequest("http://localhost/api/me/data", {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  enabled = true;
});

describe("/api/me/data", () => {
  it("без сессии GET и PUT — 401, в базу не ходят", async () => {
    auth.getUser.mockResolvedValue(null);

    expect((await GET(call("GET"))).status).toBe(401);
    expect((await PUT(call("PUT", { body: { searchProfiles: [], companyProfile: null } }))).status).toBe(401);
    expect(repo.get).not.toHaveBeenCalled();
    expect(repo.put).not.toHaveBeenCalled();
  });

  it("вход не настроен — как гость: 401", async () => {
    enabled = false;

    expect((await GET(call("GET", { cookie: "tf_session=x" }))).status).toBe(401);
  });

  it("GET отдаёт данные именно этого пользователя", async () => {
    auth.getUser.mockResolvedValue({ id: "u1", email: "ivan@firma.ru" });
    repo.get.mockResolvedValue({
      searchProfiles: [{ name: "А" }],
      companyProfile: { name: "ООО" },
      appState: { onboardingDone: true },
    });

    const response = await GET(call("GET", { cookie: "tf_session=tok" }));

    expect(repo.get).toHaveBeenCalledWith("u1");
    expect(await response.json()).toEqual({
      searchProfiles: [{ name: "А" }],
      companyProfile: { name: "ООО" },
      appState: { onboardingDone: true },
    });
  });

  it("GET нового аккаунта отдаёт пустые данные, а не ошибку", async () => {
    auth.getUser.mockResolvedValue({ id: "u1", email: "ivan@firma.ru" });
    repo.get.mockResolvedValue(null);

    expect(await (await GET(call("GET", { cookie: "tf_session=tok" }))).json()).toEqual({
      searchProfiles: [],
      companyProfile: null,
      appState: {},
    });
  });

  it("PUT сохраняет данные под идентификатором пользователя из сессии, а не из тела", async () => {
    auth.getUser.mockResolvedValue({ id: "u1", email: "ivan@firma.ru" });
    repo.put.mockResolvedValue(undefined);

    const response = await PUT(
      call("PUT", {
        cookie: "tf_session=tok",
        body: { userId: "чужой", searchProfiles: [{ name: "А" }], companyProfile: null },
      }),
    );

    expect(response.status).toBe(200);
    expect(repo.put).toHaveBeenCalledWith("u1", { searchProfiles: [{ name: "А" }], companyProfile: null });
  });

  it("PUT передаёт appState (отметку онбординга, воронку) в хранилище", async () => {
    auth.getUser.mockResolvedValue({ id: "u1", email: "ivan@firma.ru" });
    repo.put.mockResolvedValue(undefined);
    const appState = { onboardingDone: true, pipeline: { t1: { status: "APPLIED" } } };

    const response = await PUT(
      call("PUT", { cookie: "tf_session=tok", body: { searchProfiles: [], companyProfile: null, appState } }),
    );

    expect(response.status).toBe(200);
    expect(repo.put).toHaveBeenCalledWith("u1", { searchProfiles: [], companyProfile: null, appState });
  });

  it("PUT с телом не по форме — 400", async () => {
    auth.getUser.mockResolvedValue({ id: "u1", email: "ivan@firma.ru" });

    const response = await PUT(call("PUT", { cookie: "tf_session=tok", body: { searchProfiles: "нет" } }));

    expect(response.status).toBe(400);
    expect(repo.put).not.toHaveBeenCalled();
  });

  it("PUT больше тридцати профилей — 400", async () => {
    auth.getUser.mockResolvedValue({ id: "u1", email: "ivan@firma.ru" });
    const many = Array.from({ length: 31 }, (_, i) => ({ name: `П${i}` }));

    const response = await PUT(
      call("PUT", { cookie: "tf_session=tok", body: { searchProfiles: many, companyProfile: null } }),
    );

    expect(response.status).toBe(400);
  });

  it("сбой базы — 503 с понятным текстом", async () => {
    auth.getUser.mockResolvedValue({ id: "u1", email: "ivan@firma.ru" });
    repo.get.mockRejectedValue(new Error("db down"));

    expect((await GET(call("GET", { cookie: "tf_session=tok" }))).status).toBe(503);
  });
});
