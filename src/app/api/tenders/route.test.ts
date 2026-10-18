import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/auth/requireAccess", () => ({ requireAccess: vi.fn(async () => null) }));
vi.mock("@/repositories/tenderRepository", () => ({
  tenderRepository: { list: vi.fn(), count: vi.fn() },
}));

import { GET } from "@/app/api/tenders/route";
import { tenderRepository } from "@/repositories/tenderRepository";
import type { TenderRow } from "@/types/database";

/**
 * GET /api/tenders: страницы базы собирает сервер, а не браузер.
 *
 * Репозиторий подменён базой из N строк с пределом тысяча строк на обращение —
 * как у PostgREST. Проверяем, что один запрос отдаёт всю выдачу в порядке
 * репозитория, что страницы идут параллельно и что `raw_data` урезан.
 */

const repo = vi.mocked(tenderRepository);

function makeRows(total: number): TenderRow[] {
  return Array.from(
    { length: total },
    (_, i) =>
      ({
        id: `id-${String(i)}`,
        reg_number: `R-${String(i)}`,
        raw_data: i % 2 === 0 ? { origin: "live", query: "q", huge: "x".repeat(50) } : { huge: "y" },
      }) as unknown as TenderRow,
  );
}

function get(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/tenders${query}`);
}

let inFlight = 0;
let maxInFlight = 0;

function stubRepo(total: number): void {
  const rows = makeRows(total);
  inFlight = 0;
  maxInFlight = 0;
  repo.list.mockImplementation(async (_filters, limit = 100, offset = 0) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return rows.slice(offset, offset + Math.min(limit, 1000));
  });
  repo.count.mockResolvedValue(total);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/tenders — вся лента одним ответом", () => {
  it("больше тысячи строк приходят одним ответом, порядок сохранён", async () => {
    stubRepo(2300);

    const response = await GET(get("?limit=5000&offset=0"));
    const body = (await response.json()) as { tenders: Array<{ reg_number: string }>; count: number };

    expect(response.status).toBe(200);
    expect(body.count).toBe(2300);
    expect(body.tenders.map((t) => t.reg_number)).toEqual(Array.from({ length: 2300 }, (_, i) => `R-${String(i)}`));
  });

  it("страницы базы запрашиваются параллельно", async () => {
    stubRepo(3500);

    await GET(get("?limit=5000"));

    // Первая страница идёт вместе с подсчётом, остальные три — одновременно.
    expect(repo.list).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBeGreaterThanOrEqual(3);
  });

  it("предел ответа — 5000 строк", async () => {
    stubRepo(7000);

    const body = (await (await GET(get("?limit=999999"))).json()) as { count: number };

    expect(body.count).toBe(5000);
  });

  it("limit до тысячи — один запрос в базу и без подсчёта", async () => {
    stubRepo(3000);

    const body = (await (await GET(get("?limit=1&reg_number=R-5"))).json()) as { count: number };

    expect(body.count).toBe(1);
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(repo.count).not.toHaveBeenCalled();
  });

  it("фильтры доходят и до страниц, и до подсчёта", async () => {
    stubRepo(2500);

    await GET(get("?limit=5000&region=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0"));

    expect(repo.count).toHaveBeenCalledWith(expect.objectContaining({ region: "Москва" }));
    for (const call of repo.list.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ region: "Москва" }));
    }
  });

  it("raw_data урезан до ключей ленты", async () => {
    stubRepo(4);

    const body = (await (await GET(get("?limit=10"))).json()) as {
      tenders: Array<{ raw_data: Record<string, unknown> | null }>;
    };

    expect(body.tenders[0]?.raw_data).toEqual({ origin: "live", query: "q" });
    expect(body.tenders[1]?.raw_data).toBeNull();
  });

  it("ошибка базы — 500 с текстом причины", async () => {
    repo.list.mockRejectedValue(new Error("база недоступна"));
    repo.count.mockResolvedValue(10);

    const response = await GET(get("?limit=5000"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "база недоступна" });
  });
});
