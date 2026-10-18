import { describe, expect, it, vi } from "vitest";
import { SberAstTenderSourceAdapter } from "@/adapters/tender-source/sberAstTenderSourceAdapter";
import {
  TEST_NOW,
  activeSberPurchase,
  buildSberEmptyResponse,
  buildSberResponse,
  buildSberSingleResponse,
  closedSberPurchase,
  finishedSberPurchase,
  noPriceSberPurchase,
  saleSberPurchase,
  siblingLotSberPurchase,
} from "@/adapters/tender-source/sberAstTestFixtures";
import type { TenderSourceQuery } from "@/adapters/types";

/** Заглушка fetch: отдаёт заранее подготовленные ответы по порядку. */
function stubFetch(bodies: string[], status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const index = Math.min(calls.length - 1, bodies.length - 1);
    const body = bodies[index] ?? "";
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const baseQuery: TenderSourceQuery = { laws: ["COMMERCIAL"], limit: 10 };

function makeAdapter(fetchImpl: typeof fetch, overrides = {}) {
  return new SberAstTenderSourceAdapter({
    rateLimitPerSec: 1000,
    maxRetries: 0,
    pageSize: 2,
    maxPages: 5,
    nowProvider: () => TEST_NOW,
    fetchImpl,
    ...overrides,
  });
}

describe("SberAstTenderSourceAdapter.fetchTenders", () => {
  it("отправляет POST на Processing/main с поисковым фильтром", async () => {
    const { impl, calls } = stubFetch([buildSberResponse([activeSberPurchase], 1)]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders({ ...baseQuery, keywords: ["ноутбук"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://www.sberbank-ast.ru/api/Processing/main");
    expect(calls[0]?.init.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, string>;
    expect(body["windowCode"]).toBe("/EsOpenUnitedPurchaseList");
    expect(body["parm"]).toBe("es");
    expect(body["filterBody"]).toContain("<mainInput>ноутбук</mainInput>");
    expect(body["filterBody"]).toContain(
      "<sourceTerm>Торги коммерческих заказчиков</sourceTerm>",
    );
  });

  it("возвращает активные закупки как доменные объекты", async () => {
    const { impl } = stubFetch([
      buildSberResponse(
        [activeSberPurchase, closedSberPurchase, finishedSberPurchase],
        3,
      ),
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.regNumber).toBe("SBR028-2609210061");
    expect(tenders[0]?.law).toBe("COMMERCIAL");
    expect(tenders[0]?.dataSource).toBe("SBER_AST");
  });

  it("склеивает лоты одной закупки в одну карточку", async () => {
    const { impl } = stubFetch([
      buildSberResponse([activeSberPurchase, siblingLotSberPurchase], 2),
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.regNumber).toBe("SBR028-2609210061");
    expect(tenders[0]?.lots.map((lot) => lot.id)).toEqual([
      "SBR028-2609210061.1",
      "SBR028-2609210061.4",
    ]);
    expect(tenders[0]?.financial.price).toBe(8943377 + 2025093);
    // Срок подачи — самый ранний среди лотов.
    expect(tenders[0]?.deadlines.submissionEnd).toBe("2026-09-23T07:00:00.000Z");
  });

  it("не дублирует лот, который площадка повторила на следующей странице", async () => {
    const { impl, calls } = stubFetch([
      buildSberResponse([activeSberPurchase, siblingLotSberPurchase], 3),
      buildSberResponse([siblingLotSberPurchase, closedSberPurchase], 3),
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(calls.length).toBe(2);
    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.lots).toHaveLength(2);
    expect(tenders[0]?.financial.price).toBe(8943377 + 2025093);
  });

  it("ходит по страницам, пока не найдёт активные закупки", async () => {
    const { impl, calls } = stubFetch([
      buildSberResponse([closedSberPurchase, finishedSberPurchase], 4),
      buildSberResponse([activeSberPurchase], 4),
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(calls.length).toBe(2);
    expect(tenders).toHaveLength(1);
    expect(String(calls[1]?.init.body)).toContain("<pagenum>1</pagenum>");
  });

  it("останавливается по достижении limit", async () => {
    const { impl, calls } = stubFetch([
      buildSberResponse([activeSberPurchase, closedSberPurchase], 100),
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, limit: 1 });

    expect(tenders).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("листает дальше, пока фильтр регионов не наберёт limit", async () => {
    const moscow = {
      ...activeSberPurchase,
      purchCode: "SBR028-0000000011.1",
      PurchaseCodeNoBidTerm: "SBR028-0000000011",
      RegionName: "Москва",
    };
    const moscow2 = {
      ...moscow,
      purchCode: "SBR028-0000000012.1",
      PurchaseCodeNoBidTerm: "SBR028-0000000012",
    };
    const buryatia = {
      ...activeSberPurchase,
      purchCode: "SBR028-0000000013.1",
      PurchaseCodeNoBidTerm: "SBR028-0000000013",
      RegionName: "Республика Бурятия",
    };
    const { impl, calls } = stubFetch([
      buildSberResponse([moscow, moscow2], 4),
      buildSberResponse([buryatia, closedSberPurchase], 4),
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      ...baseQuery,
      limit: 1,
      regions: ["бурят"],
    });

    expect(calls).toHaveLength(2);
    expect(tenders.map((t) => t.regNumber)).toEqual(["SBR028-0000000013"]);
  });

  it("применяет ценовой фильтр и фильтр регионов локально", async () => {
    const cheap = {
      ...activeSberPurchase,
      purchCode: "SBR028-0000000001.1",
      PurchaseCodeNoBidTerm: "SBR028-0000000001",
      purchAmountRUB: "50000",
      RegionName: "Москва",
    };
    const expensive = {
      ...activeSberPurchase,
      purchCode: "SBR028-0000000002.1",
      PurchaseCodeNoBidTerm: "SBR028-0000000002",
      purchAmountRUB: "9000000",
      RegionName: "Приморский край",
    };
    const { impl } = stubFetch([buildSberResponse([cheap, expensive], 2)]);
    const adapter = makeAdapter(impl);

    const byPrice = await adapter.fetchTenders({ ...baseQuery, maxPrice: 100000 });
    expect(byPrice.map((t) => t.regNumber)).toEqual(["SBR028-0000000001"]);

    const byRegion = await adapter.fetchTenders({ ...baseQuery, regions: ["примор"] });
    expect(byRegion.map((t) => t.regNumber)).toEqual(["SBR028-0000000002"]);
  });

  it("не отсеивает закупку без опубликованной цены", async () => {
    const { impl } = stubFetch([buildSberResponse([noPriceSberPurchase], 1)]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      ...baseQuery,
      minPrice: 30000,
      maxPrice: 5000000,
    });

    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.regNumber).toBe("SBR028-2609210077");
    expect(tenders[0]?.financial.price).toBe(0);
  });

  it("повторяет запрос, если площадка вернула HTML вместо JSON", async () => {
    const { impl, calls } = stubFetch([
      "<html>cache miss</html>",
      buildSberResponse([activeSberPurchase], 1),
    ]);
    const adapter = makeAdapter(impl, { maxRetries: 1 });

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(calls.length).toBe(2);
    expect(tenders).toHaveLength(1);
  });

  it("бросает ошибку при HTTP-сбое", async () => {
    const { impl } = stubFetch([""], 503);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchTenders(baseQuery)).rejects.toThrow(/HTTP 503/);
  });
});

describe("SberAstTenderSourceAdapter.fetchTenderById", () => {
  it("ищет закупку по номеру, включая неактивные", async () => {
    const { impl, calls } = stubFetch([buildSberResponse([finishedSberPurchase], 1)]);
    const adapter = makeAdapter(impl);

    const tender = await adapter.fetchTenderById("sber-SBR028-2608100022.1");

    expect(tender?.regNumber).toBe("SBR028-2608100022");
    // Ищем по коду закупки без номера лота — так площадка находит все лоты.
    expect(String(calls[0]?.init.body)).toContain(
      "<mainInput>SBR028-2608100022</mainInput>",
    );
  });

  it("принимает и код закупки без префикса и номера лота", async () => {
    const { impl } = stubFetch([
      buildSberResponse([activeSberPurchase, siblingLotSberPurchase], 2),
    ]);
    const adapter = makeAdapter(impl);

    const tender = await adapter.fetchTenderById("SBR028-2609210061");

    expect(tender?.id).toBe("sber-SBR028-2609210061");
    expect(tender?.lots).toHaveLength(2);
  });

  it("возвращает null, если закупка не найдена", async () => {
    const { impl } = stubFetch([buildSberResponse([activeSberPurchase], 1)]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchTenderById("SBR999-0000000000.1")).resolves.toBeNull();
  });

  it("читает ответ площадки, где единственный результат отдан объектом", async () => {
    const { impl } = stubFetch([buildSberSingleResponse(activeSberPurchase)]);
    const adapter = makeAdapter(impl);

    const tender = await adapter.fetchTenderById("SBR028-2609210061");

    expect(tender?.regNumber).toBe("SBR028-2609210061");
    expect(tender?.lots).toHaveLength(1);
  });

  it("пустая выдача (PurchaseList: null) — это null, а не ошибка", async () => {
    const { impl } = stubFetch([buildSberEmptyResponse()]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchTenderById("SBR999-0000000000")).resolves.toBeNull();
  });

  it("не возвращает продажу имущества", async () => {
    const { impl } = stubFetch([buildSberSingleResponse(saleSberPurchase)]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchTenderById("SBR028-2608280041")).resolves.toBeNull();
  });
});

/**
 * Документация Сбербанк-АСТ лежит в карточке площадки под входом по КЭП, а
 * поисковый API её не отдаёт. Адаптер обязан сказать «документов нет», а не
 * подсунуть ссылку на карточку под видом извещения: разъём `fetchDocuments`
 * возвращает документы, и потребитель скачает и разберёт HTML-оболочку,
 * приняв навигацию площадки за текст закупки.
 */
describe("SberAstTenderSourceAdapter.fetchDocuments", () => {
  it("не отдаёт карточку закупки под видом документа", async () => {
    const { impl } = stubFetch([buildSberResponse([activeSberPurchase], 1)]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchDocuments("SBR028-2609210061.4")).resolves.toEqual([]);
  });

  it("не тратит поисковый запрос: читать карточку всё равно нечем", async () => {
    const { impl, calls } = stubFetch([buildSberResponse([activeSberPurchase], 1)]);
    const adapter = makeAdapter(impl);

    await adapter.fetchDocuments("SBR028-2609210061.4");

    expect(calls).toHaveLength(0);
  });
});

describe("SberAstTenderSourceAdapter.checkChanges", () => {
  it("замечает обновление после указанной даты", async () => {
    const { impl } = stubFetch([buildSberResponse([activeSberPurchase], 1)]);
    const adapter = makeAdapter(impl);

    // lastUpdateDate закупки — 21.09.2026 16:15 UTC.
    await expect(
      adapter.checkChanges("SBR028-2609210061.4", "2026-09-20T00:00:00.000Z"),
    ).resolves.toBe(true);
    await expect(
      adapter.checkChanges("SBR028-2609210061.4", "2026-09-22T00:00:00.000Z"),
    ).resolves.toBe(false);
  });
});
