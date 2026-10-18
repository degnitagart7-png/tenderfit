import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/repositories/searchDemandRepository", () => {
  class SearchDemandTableMissingError extends Error {}
  class SearchDemandFullError extends Error {}
  return {
    SearchDemandTableMissingError,
    SearchDemandFullError,
    searchDemandRepository: { replaceForVisitor: vi.fn() },
  };
});

import { POST } from "@/app/api/demand/route";
import {
  SearchDemandFullError,
  SearchDemandTableMissingError,
  searchDemandRepository,
} from "@/repositories/searchDemandRepository";

/**
 * Ручка спроса посетителя.
 *
 * Открыта без входа, а за каждой темой стоят запросы к чужим площадкам: проверяем
 * пределы отчёта, чистку слов и то, что отказ не доходит до базы.
 */

const repo = vi.mocked(searchDemandRepository);
const VISITOR = "a1b2c3d4-e5f6-4789-8abc-def012345678";

let counter = 0;
function post(body: unknown): NextRequest {
  counter += 1;
  return new NextRequest("http://localhost/api/demand", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": `10.3.0.${String(counter)}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const profile = { keywords: ["Юридические услуги"], laws: ["FZ_44"], enabled: true };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/demand", () => {
  it("принимает отчёт и пишет очищенные темы посетителя", async () => {
    repo.replaceForVisitor.mockResolvedValue(undefined);

    const response = await POST(post({ visitorId: VISITOR, profiles: [profile] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ topics: 1 });
    expect(repo.replaceForVisitor).toHaveBeenCalledWith(VISITOR, [
      { keyword: "юридические услуги", laws: ["FZ_44"], regions: [] },
    ]);
  });

  it("регионы профиля доходят до записи спроса", async () => {
    repo.replaceForVisitor.mockResolvedValue(undefined);

    await POST(post({ visitorId: VISITOR, profiles: [{ ...profile, regions: ["Республика Бурятия"] }] }));

    expect(repo.replaceForVisitor).toHaveBeenCalledWith(VISITOR, [
      { keyword: "юридические услуги", laws: ["FZ_44"], regions: ["Республика Бурятия"] },
    ]);
  });

  it("пустой список профилей снимает темы посетителя", async () => {
    repo.replaceForVisitor.mockResolvedValue(undefined);

    const response = await POST(post({ visitorId: VISITOR, profiles: [] }));

    expect(response.status).toBe(200);
    expect(repo.replaceForVisitor).toHaveBeenCalledWith(VISITOR, []);
  });

  it("непригодный идентификатор — 400, в базу не ходит", async () => {
    const response = await POST(post({ visitorId: "x", profiles: [profile] }));

    expect(response.status).toBe(400);
    expect(repo.replaceForVisitor).not.toHaveBeenCalled();
  });

  it("тело не JSON — 400", async () => {
    expect((await POST(post("{не json"))).status).toBe(400);
  });

  it("слишком большое тело — 413, в базу не ходит", async () => {
    const huge = { visitorId: VISITOR, profiles: [], pad: "x".repeat(25_000) };

    const response = await POST(post(huge));

    expect(response.status).toBe(413);
    expect(repo.replaceForVisitor).not.toHaveBeenCalled();
  });

  it("лимит на адрес: двадцать первое обновление подряд отклоняется", async () => {
    repo.replaceForVisitor.mockResolvedValue(undefined);
    const same = () =>
      new NextRequest("http://localhost/api/demand", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-real-ip": "10.9.9.9" },
        body: JSON.stringify({ visitorId: VISITOR, profiles: [profile] }),
      });

    let last = 200;
    for (let i = 0; i < 21; i += 1) last = (await POST(same())).status;

    expect(last).toBe(429);
  });

  it("миграция не применена и таблица переполнена — 503, а не 500", async () => {
    repo.replaceForVisitor.mockRejectedValueOnce(new SearchDemandTableMissingError());
    repo.replaceForVisitor.mockRejectedValueOnce(new SearchDemandFullError());

    expect((await POST(post({ visitorId: VISITOR, profiles: [profile] }))).status).toBe(503);
    expect((await POST(post({ visitorId: VISITOR, profiles: [profile] }))).status).toBe(503);
  });
});
