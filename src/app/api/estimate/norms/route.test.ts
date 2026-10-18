import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Доступ проверяет requireAccess (его правила — в access.routes.test.ts); здесь ручка ведёт себя как для вошедшего.
vi.mock("@/app/api/auth/requireAccess", () => ({ requireAccess: vi.fn(async () => null) }));

import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { SEARCH_NORMS } from "@/test/estimateFixtures";

const loadIndex = vi.fn();
const loadFer = vi.fn();

vi.mock("@/repositories/bimRepository", async () => {
  const actual = await vi.importActual<typeof import("@/repositories/bimRepository")>("@/repositories/bimRepository");
  return { ...actual, loadFerBase: (...args: unknown[]) => loadFer(...args) };
});

vi.mock("@/repositories/estimateBaseRepository", async () => {
  const actual = await vi.importActual<typeof import("@/repositories/estimateBaseRepository")>("@/repositories/estimateBaseRepository");
  return { ...actual, loadNormSearchIndex: (...args: unknown[]) => loadIndex(...args) };
});

import { GET } from "@/app/api/estimate/norms/route";
import { FerBaseUnavailableError } from "@/repositories/bimRepository";
import { EstimateBaseUnavailableError } from "@/repositories/estimateBaseRepository";
import { makeFerBase } from "@/test/bimFixtures";

/*
  Поиск нормы для правки ведомости. База норм подставлена тестовой: проверяется роут —
  вид запроса, лимит, кэш, пустой запрос и отказ при отсутствии базы.
*/

const index = createNormSearchIndex(SEARCH_NORMS);
let counter = 0;

function get(query: string, ip = `10.9.0.${String((counter += 1))}`): NextRequest {
  return new NextRequest(`http://localhost/api/estimate/norms${query}`, { headers: { "x-real-ip": ip } });
}

beforeEach(() => {
  loadIndex.mockReset();
  loadIndex.mockResolvedValue(index);
  loadFer.mockReset();
  loadFer.mockResolvedValue(makeFerBase());
});

describe("GET /api/estimate/norms", () => {
  it("шифр: точная норма с книгой, кодом, наименованием и единицей", async () => {
    const response = await GET(get("?q=" + encodeURIComponent("ГЭСН 01-01-111-01")));
    const body = (await response.json()) as { mode: string; items: Record<string, unknown>[] };

    expect(response.status).toBe(200);
    expect(body.mode).toBe("CODE");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ code: "01-01-111-01", baseType: "ГЭСН", unit: "1000 м2", exact: true });
  });

  it("слова: топ N, лучшие первыми; limit ограничивает выдачу", async () => {
    const response = await GET(get("?q=" + encodeURIComponent("разработка грунта") + "&limit=2"));
    const body = (await response.json()) as { items: { code: string }[]; limit: number };

    expect(body.limit).toBe(2);
    expect(body.items.length).toBeLessThanOrEqual(2);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("лимит не больше 30, мусорный лимит — по умолчанию", async () => {
    const big = (await (await GET(get("?q=01-01&limit=999"))).json()) as { limit: number };
    const junk = (await (await GET(get("?q=01-01&limit=abc"))).json()) as { limit: number };
    expect(big.limit).toBe(30);
    expect(junk.limit).toBe(10);
  });

  it("пустой запрос — 200 и пустая выдача, базу не читали", async () => {
    const response = await GET(get("?q="));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "EMPTY", items: [] });
    const missing = await GET(get(""));
    expect(((await missing.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("единица позиции: нормы с несходящейся единицей помечены unitOk: false", async () => {
    const body = (await (await GET(get("?q=" + encodeURIComponent("планировка откосов") + "&unit=" + encodeURIComponent("т")))).json()) as {
      items: { unitOk?: boolean }[];
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => item.unitOk === false)).toBe(true);

    const fits = (await (await GET(get("?q=" + encodeURIComponent("планировка откосов") + "&unit=" + encodeURIComponent("м2")))).json()) as {
      items: { unitOk?: boolean }[];
    };
    expect(fits.items[0]?.unitOk).toBe(true);
  });

  it("кэш: одинаковый запрос не перечитывает индекс и не пересчитывает поиск, регистр и пробелы не важны", async () => {
    await GET(get("?q=" + encodeURIComponent("Планировка  откосов")));
    const calls = loadIndex.mock.calls.length;
    const again = await GET(get("?q=" + encodeURIComponent("планировка откосов")));

    expect(again.status).toBe(200);
    expect(loadIndex.mock.calls.length).toBe(calls);
    expect(again.headers.get("Cache-Control")).toContain("max-age");
  });

  it("базы норм на сервере нет — 503 с причиной, а не пустая выдача", async () => {
    loadIndex.mockRejectedValue(new EstimateBaseUnavailableError("нет файла", "data/fsnb/index", "MISSING_FILE"));
    const response = await GET(get("?q=" + encodeURIComponent("уникальный запрос про бетон")));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/База норм/);
  });

  it("лимит запросов с адреса: после 300 за окно — 429", async () => {
    let last = 200;
    for (let index2 = 0; index2 < 301; index2 += 1) {
      last = (await GET(get("?q=", "10.77.0.1"))).status;
    }
    expect(last).toBe(429);
  });
});

describe("GET /api/estimate/norms: базисно-индексный метод", () => {
  it("method=BASE_INDEX: ищутся расценки ФЕР-2020, а не нормы ГЭСН; книга в запросе ограничивает выдачу", async () => {
    const response = await GET(get("?method=BASE_INDEX&q=" + encodeURIComponent("ФЕРм 08-02-001-01")));
    const body = (await response.json()) as { mode: string; items: Record<string, unknown>[] };

    expect(response.status).toBe(200);
    expect(body.mode).toBe("CODE");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ baseType: "ФЕРм", code: "08-02-001-01", unit: "т", exact: true });
    expect(loadIndex).not.toHaveBeenCalled();
  });

  it("по словам находится расценка ФЕР, а не норма ГЭСН", async () => {
    const body = (await (await GET(get("?method=BASE_INDEX&q=" + encodeURIComponent("кладка стен кирпичных")))).json()) as { items: { baseType: string; code: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((hit) => hit.baseType.startsWith("ФЕР"))).toBe(true);
  });

  it("кэш разделён по методу: тот же запрос без method идёт в нормы ГЭСН", async () => {
    await GET(get("?method=BASE_INDEX&q=" + encodeURIComponent("грунт")));
    await GET(get("?q=" + encodeURIComponent("грунт")));
    expect(loadFer).toHaveBeenCalledTimes(1);
    expect(loadIndex).toHaveBeenCalledTimes(1);
  });

  it("ФЕР-2020 не собраны — 503 с причиной, а не пустая выдача", async () => {
    loadFer.mockRejectedValue(new FerBaseUnavailableError("нет каталога", "data/fsnb/index"));
    const response = await GET(get("?method=BASE_INDEX&q=" + encodeURIComponent("кладка")));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("ФЕР-2020");
  });
});
