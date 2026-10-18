import { describe, expect, it, vi } from "vitest";
import {
  ROSELTORG_BASE_URL,
  ROSELTORG_DEFAULT_SECTIONS,
  ROSELTORG_OPEN_STATUSES,
} from "@/adapters/tender-source/roseltorgSearch";
import {
  ROSELTORG_COMMERCIAL_ITEM,
  ROSELTORG_FZ223_ITEM,
  ROSELTORG_FZ44_ITEM,
  ROSELTORG_MULTI_LOT_ITEMS,
  ROSELTORG_PRICED_ITEM,
  ROSELTORG_STALE_ITEM,
  ROSELTORG_TEST_NOW,
  ROSELTORG_UNKNOWN_REGION_ITEM,
  buildRoseltorgSearchPage,
} from "@/adapters/tender-source/roseltorgTestFixtures";
import {
  RoseltorgResponseError,
  RoseltorgTenderSourceAdapter,
  roseltorgProcedureNumber,
} from "@/adapters/tender-source/roseltorgTenderSourceAdapter";
import type { TenderSourceQuery } from "@/adapters/types";

/**
 * Строка без полей: площадка иногда отдаёт пустой контейнер лота. Номера в ней нет,
 * и адаптер обязан посчитать её отдельно, а не сделать закупкой с пустым regNumber.
 */
const NUMBERLESS_ITEM = '<div class="search-results__item autoload-post"></div>';

/** Один подготовленный ответ площадки. */
interface StubRoute {
  /** Значение `query_field`; не задано — маршрут запроса без ключевого слова. */
  readonly query?: string;
  /** Номер страницы; не задан — нулевая. */
  readonly page?: number;
  /** Тело ответа. Массив — тела по попыткам: по нему проверяются повторы. */
  readonly body: string | readonly string[];
  readonly status?: number;
}

/** Что запомнила заглушка об одном обращении. */
interface StubCall {
  readonly url: string;
  readonly query: string | null;
  readonly page: number;
}

/**
 * Заглушка fetch с маршрутами по параметрам запроса.
 *
 * Росэлторг отвечает одним и тем же фрагментом списка и на поиск по слову, и на
 * поиск по номеру процедуры — различает их только `query_field`, поэтому маршруты
 * строятся по нему, а не по порядку вызовов.
 */
function stubFetch(routes: readonly StubRoute[]) {
  const calls: StubCall[] = [];
  const hits = new Map<StubRoute, number>();
  const impl = vi.fn(async (input: string) => {
    const search = new URL(input).searchParams;
    const query = search.get("query_field");
    calls.push({ url: input, query, page: Number(search.get("page") ?? "0") });
    for (const route of routes) {
      if ((route.query ?? null) !== query) continue;
      if ((route.page ?? 0) !== Number(search.get("page") ?? "0")) continue;
      const status = route.status ?? 200;
      const hit = hits.get(route) ?? 0;
      hits.set(route, hit + 1);
      const body = Array.isArray(route.body)
        ? (route.body[Math.min(hit, route.body.length - 1)] ?? "")
        : route.body;
      return { ok: status < 400, status, text: async () => body } as unknown as Response;
    }
    return { ok: false, status: 404, text: async () => "" } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/**
 * Страница выдачи со списком и без кнопки «Далее».
 *
 * В живой выдаче страница — это 10 строк, а здесь одна-две. Так сделано намеренно:
 * обход ведёт только кнопка «Далее», и набивать страницы десятком одинаковых строк
 * значило бы проверять не признак конца, а наше предположение о размере страницы.
 */
const listing = (...items: readonly string[]): string => buildRoseltorgSearchPage({ items });

/** Пустой ответ площадки: «Нет результатов». */
const NO_RESULTS = buildRoseltorgSearchPage({ items: [], noResults: true });

const baseQuery: TenderSourceQuery = { laws: ["FZ_223", "COMMERCIAL"], limit: 10 };

function makeAdapter(fetchImpl: typeof fetch, overrides: object = {}) {
  return new RoseltorgTenderSourceAdapter({
    rateLimitPerSec: 1000,
    maxRetries: 0,
    timeoutMs: 5000,
    maxPages: 3,
    maxResolvePages: 3,
    maxResolves: 40,
    nowProvider: () => ROSELTORG_TEST_NOW,
    fetchImpl,
    ...overrides,
  });
}

/** Обращения поиска без ключевого слова — обход страниц выдачи. */
function discoveryCalls(calls: readonly StubCall[]): StubCall[] {
  return calls.filter((call) => call.query === null);
}

/** Обращения по номеру процедуры — добор полного набора лотов. */
function resolveCalls(calls: readonly StubCall[], ...queries: string[]): StubCall[] {
  if (queries.length === 0) return calls.filter((call) => call.query !== null);
  return calls.filter((call) => call.query !== null && queries.includes(call.query));
}

describe("roseltorgProcedureNumber", () => {
  it("снимает префикс внутреннего id и префикс номера в базе", () => {
    expect(roseltorgProcedureNumber("roseltorg-32616431971")).toBe("32616431971");
    expect(roseltorgProcedureNumber("ROSELTORG-B0210261118005")).toBe("B0210261118005");
  });

  it("голый номер площадки проходит без изменений", () => {
    expect(roseltorgProcedureNumber("B2509261618185")).toBe("B2509261618185");
  });

  it("пустой ключ остаётся пустым: спрашивать площадку нечего", () => {
    expect(roseltorgProcedureNumber("  ")).toBe("");
  });
});

describe("RoseltorgTenderSourceAdapter.fetchTenders — обход поиска", () => {
  it("спрашивает фрагмент выдачи с секциями, статусами и страницей", async () => {
    const { impl, calls } = stubFetch([
      { body: listing(ROSELTORG_PRICED_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders(baseQuery);

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/procedures/search_ajax");
    expect(url.searchParams.getAll("source[]")).toEqual(ROSELTORG_DEFAULT_SECTIONS.map(String));
    expect(url.searchParams.getAll("status[]")).toEqual(ROSELTORG_OPEN_STATUSES.map(String));
    expect(url.searchParams.get("page")).toBe("0");
    expect(url.searchParams.get("query_field")).toBeNull();
  });

  it("идёт на следующую страницу, пока площадка печатает «Далее»", async () => {
    const { impl, calls } = stubFetch([
      {
        page: 0,
        body: buildRoseltorgSearchPage({
          items: [ROSELTORG_PRICED_ITEM],
          hasNextPage: true,
          nextPage: 1,
        }),
      },
      { page: 1, body: listing(ROSELTORG_FZ223_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
      { query: "32616431984", body: listing(ROSELTORG_FZ223_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(discoveryCalls(calls)).toHaveLength(2);
    expect(tenders.map((tender) => tender.regNumber)).toEqual(["32616431971", "32616431984"]);
    expect(adapter.filterStats.discovered).toBe(2);
  });

  it("останавливается на «Нет результатов» и не считает это сбоем", async () => {
    const { impl, calls } = stubFetch([{ body: NO_RESULTS }]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(1);
    expect(tenders).toEqual([]);
    expect(adapter.filterStats.kept).toBe(0);
    expect(adapter.filterStats.rows).toBe(0);
  });

  it("не выходит за предел страниц даже при живой кнопке «Далее»", async () => {
    const pageWithNext = buildRoseltorgSearchPage({
      items: [ROSELTORG_PRICED_ITEM],
      hasNextPage: true,
      nextPage: 1,
    });
    const { impl, calls } = stubFetch([
      { page: 0, body: pageWithNext },
      { page: 1, body: pageWithNext },
      { page: 2, body: pageWithNext },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);

    await makeAdapter(impl, { maxPages: 2 }).fetchTenders(baseQuery);

    expect(discoveryCalls(calls)).toHaveLength(2);
  });

  it("ключевое слово уходит в поиск площадки в его кодировке", async () => {
    const { impl, calls } = stubFetch([
      { query: "насадка", body: listing(ROSELTORG_MULTI_LOT_ITEMS[1] ?? "") },
      { query: "B2509261618185", body: listing(...ROSELTORG_MULTI_LOT_ITEMS) },
    ]);

    const tenders = await makeAdapter(impl).fetchTenders({ ...baseQuery, keywords: ["насадка"] });

    expect(calls[0]?.url).toContain("query_field=%D0%BD%D0%B0%D1%81%D0%B0%D0%B4%D0%BA%D0%B0");
    expect(tenders).toHaveLength(1);
  });
});

describe("RoseltorgTenderSourceAdapter.fetchTenders — лоты и цена", () => {
  it("строка выдачи — это лот: полный набор добирается запросом по номеру процедуры", async () => {
    const { impl, calls } = stubFetch([
      { body: listing(ROSELTORG_MULTI_LOT_ITEMS[1] ?? "") },
      { query: "B2509261618185", body: listing(...ROSELTORG_MULTI_LOT_ITEMS) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);
    const [tender] = tenders;

    expect(resolveCalls(calls)).toHaveLength(1);
    expect(tender?.lots).toHaveLength(3);
    expect(tender?.financial.price).toBe(280500);
    // Предмет — из совпавшего лота: «Позиция каталога №1» не объяснила бы владельцу,
    // почему закупка вообще попала в выдачу по слову «насадка».
    expect(tender?.subject).toBe("Насадка МОП, комплект");
    expect(adapter.filterStats.incomplete).toBe(0);
  });

  it("процедура, лоты которой собрать не удалось, выходит без цены", async () => {
    const { impl } = stubFetch([
      { body: listing(ROSELTORG_MULTI_LOT_ITEMS[1] ?? "") },
      { query: "B2509261618185", body: NO_RESULTS },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);
    const [tender] = tenders;

    expect(tender?.financial.price).toBe(0);
    expect(tender?.lots).toHaveLength(1);
    expect(tender?.subject).toBe("Насадка МОП, комплект");
    expect(adapter.filterStats.incomplete).toBe(1);
  });

  it("неполный обход страниц лотов тоже не даёт цену: сумма части занижена", async () => {
    const { impl } = stubFetch([
      { body: listing(ROSELTORG_MULTI_LOT_ITEMS[1] ?? "") },
      {
        query: "B2509261618185",
        page: 0,
        body: buildRoseltorgSearchPage({
          items: [ROSELTORG_MULTI_LOT_ITEMS[0] ?? ""],
          hasNextPage: true,
          nextPage: 1,
        }),
      },
    ]);
    const adapter = makeAdapter(impl, { maxResolvePages: 1 });

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(tenders[0]?.financial.price).toBe(0);
    expect(adapter.filterStats.incomplete).toBe(1);
  });

  it("строки чужих процедур в ответе по номеру не подмешиваются в закупку", async () => {
    const { impl } = stubFetch([
      { body: listing(ROSELTORG_PRICED_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM, ROSELTORG_FZ223_ITEM) },
    ]);

    const tenders = await makeAdapter(impl).fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.regNumber).toBe("32616431971");
    expect(tenders[0]?.lots).toHaveLength(1);
  });

  it("одна процедура из двух ключевых слов запрашивается по номеру один раз", async () => {
    const { impl, calls } = stubFetch([
      { query: "пропан", body: listing(ROSELTORG_COMMERCIAL_ITEM) },
      { query: "газ", body: listing(ROSELTORG_COMMERCIAL_ITEM) },
      { query: "B0210261118005", body: listing(ROSELTORG_COMMERCIAL_ITEM) },
    ]);

    const tenders = await makeAdapter(impl).fetchTenders({
      ...baseQuery,
      keywords: ["пропан", "газ"],
    });

    expect(resolveCalls(calls, "B0210261118005")).toHaveLength(1);
    expect(tenders).toHaveLength(1);
  });

  it("закон проверяется до запроса по номеру: форма номера известна из строки выдачи", async () => {
    const { impl, calls } = stubFetch([
      { body: listing(ROSELTORG_FZ44_ITEM, ROSELTORG_PRICED_ITEM) },
      { query: "0373200045226001469", body: listing(ROSELTORG_FZ44_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(tenders.map((tender) => tender.regNumber)).toEqual(["32616431971"]);
    expect(resolveCalls(calls, "0373200045226001469")).toHaveLength(0);
    expect(adapter.filterStats.rejected["закон"]).toBe(1);
  });
});

describe("RoseltorgTenderSourceAdapter.fetchTenders — отсев", () => {
  it("просроченный срок приёма заявок отсеивается до запроса по номеру", async () => {
    const { impl, calls } = stubFetch([
      { body: listing(ROSELTORG_STALE_ITEM, ROSELTORG_PRICED_ITEM) },
      { query: "SP10044694", body: listing(ROSELTORG_STALE_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(tenders.map((tender) => tender.regNumber)).toEqual(["32616431971"]);
    expect(resolveCalls(calls, "SP10044694")).toHaveLength(0);
    expect(adapter.filterStats.droppedRows["срок приёма заявок истёк"]).toBe(1);
  });

  it("строка без номера процедуры считается отдельно и закупкой не становится", async () => {
    const { impl } = stubFetch([
      { body: listing(NUMBERLESS_ITEM, ROSELTORG_PRICED_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
    expect(adapter.filterStats.droppedRows["нет номера в строке выдачи"]).toBe(1);
  });

  it("регион профиля отсекает чужой субъект", async () => {
    const { impl } = stubFetch([
      { body: listing(ROSELTORG_PRICED_ITEM, ROSELTORG_COMMERCIAL_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
      { query: "B0210261118005", body: listing(ROSELTORG_COMMERCIAL_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, regions: ["волгоградская"] });

    expect(tenders.map((tender) => tender.region)).toEqual(["Волгоградская область"]);
    expect(adapter.filterStats.rejected["регион"]).toBe(1);
  });

  it("неопределённый регион — это неизвестность, а не «другой регион»", async () => {
    const { impl } = stubFetch([
      { body: listing(ROSELTORG_UNKNOWN_REGION_ITEM) },
      { query: "ATOM02102600184", body: listing(ROSELTORG_UNKNOWN_REGION_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, regions: ["волгоградская"] });

    expect(tenders).toEqual([]);
    expect(adapter.filterStats.rejected["регион не определён"]).toBe(1);
  });

  it("без фильтра по региону закупка с неопределённым регионом остаётся", async () => {
    const { impl } = stubFetch([
      { body: listing(ROSELTORG_UNKNOWN_REGION_ITEM) },
      { query: "ATOM02102600184", body: listing(ROSELTORG_UNKNOWN_REGION_ITEM) },
    ]);

    const tenders = await makeAdapter(impl).fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.region).toBe("Не указан");
  });

  it("лимит цены не отсекает закупку, цена которой не опубликована", async () => {
    const { impl } = stubFetch([
      { body: listing(ROSELTORG_COMMERCIAL_ITEM, ROSELTORG_PRICED_ITEM) },
      { query: "B0210261118005", body: listing(ROSELTORG_COMMERCIAL_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, maxPrice: 1000 });

    expect(tenders.map((tender) => tender.regNumber)).toEqual(["ROSELTORG-B0210261118005"]);
    expect(adapter.filterStats.rejected["цена"]).toBe(1);
  });

  it("ИНН заказчика сверяется локально: поиск площадки его не принимает", async () => {
    const { impl } = stubFetch([
      { body: listing(ROSELTORG_PRICED_ITEM, ROSELTORG_COMMERCIAL_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
      { query: "B0210261118005", body: listing(ROSELTORG_COMMERCIAL_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, customerInns: ["6164266561"] });

    expect(tenders.map((tender) => tender.customerInn)).toEqual(["6164266561"]);
    expect(adapter.filterStats.rejected["заказчик"]).toBe(1);
  });

  it("limit обрезает выдачу и не тратит запросы по номерам зря", async () => {
    const { impl, calls } = stubFetch([
      { body: listing(ROSELTORG_PRICED_ITEM, ROSELTORG_FZ223_ITEM, ROSELTORG_COMMERCIAL_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
      { query: "32616431984", body: listing(ROSELTORG_FZ223_ITEM) },
      { query: "B0210261118005", body: listing(ROSELTORG_COMMERCIAL_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, limit: 1 });

    expect(tenders).toHaveLength(1);
    expect(resolveCalls(calls)).toHaveLength(1);
    expect(adapter.filterStats.discovered).toBe(3);
  });

  it("предел запросов по номерам виден в статистике: часть процедур не осмотрена", async () => {
    const { impl } = stubFetch([
      { body: listing(ROSELTORG_PRICED_ITEM, ROSELTORG_FZ223_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
      { query: "32616431984", body: listing(ROSELTORG_FZ223_ITEM) },
    ]);
    const adapter = makeAdapter(impl, { maxResolves: 1 });

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
    expect(adapter.filterStats.resolveLimitReached).toBe(true);
    expect(adapter.filterStats.resolved).toBe(1);
  });
});

describe("RoseltorgTenderSourceAdapter.fetchTenders — отказы площадки", () => {
  it("HTTP-код ошибки повторяет запрос и после повторов падает", async () => {
    const { impl, calls } = stubFetch([{ body: "", status: 503 }]);
    const adapter = makeAdapter(impl, { maxRetries: 2 });

    await expect(adapter.fetchTenders(baseQuery)).rejects.toBeInstanceOf(RoseltorgResponseError);
    expect(calls).toHaveLength(3);
  });

  it("полная страница вместо фрагмента — это ошибка, а не ноль закупок", async () => {
    const { impl } = stubFetch([
      { body: "<html><head></head><body>Доступ ограничен</body></html>" },
    ]);

    await expect(makeAdapter(impl).fetchTenders(baseQuery)).rejects.toBeInstanceOf(
      RoseltorgResponseError,
    );
  });

  it("пустое тело повторяется: это сбой транспорта, а не ответ площадки", async () => {
    const { impl, calls } = stubFetch([
      { body: ["   ", listing(ROSELTORG_PRICED_ITEM)] },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);

    const tenders = await makeAdapter(impl, { maxRetries: 2 }).fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });
});

describe("RoseltorgTenderSourceAdapter.fetchTenderById", () => {
  it("возвращает процедуру с полным набором лотов", async () => {
    const { impl } = stubFetch([
      { query: "B2509261618185", body: listing(...ROSELTORG_MULTI_LOT_ITEMS) },
    ]);

    const tender = await makeAdapter(impl).fetchTenderById("ROSELTORG-B2509261618185");

    expect(tender?.regNumber).toBe("ROSELTORG-B2509261618185");
    expect(tender?.lots).toHaveLength(3);
    expect(tender?.financial.price).toBe(280500);
  });

  it("принимает и внутренний id, и голый номер площадки", async () => {
    const routes: readonly StubRoute[] = [
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ];

    const byId = stubFetch(routes);
    const first = await makeAdapter(byId.impl).fetchTenderById("roseltorg-32616431971");
    expect(first?.regNumber).toBe("32616431971");

    const byNumber = stubFetch(routes);
    const second = await makeAdapter(byNumber.impl).fetchTenderById("32616431971");
    expect(second?.regNumber).toBe("32616431971");
  });

  it("номер, которого площадка не вернула, даёт null, а не чужую закупку", async () => {
    const { impl } = stubFetch([{ query: "B0210261118005", body: NO_RESULTS }]);

    expect(await makeAdapter(impl).fetchTenderById("ROSELTORG-B0210261118005")).toBeNull();
  });

  it("пустой ключ не уходит в запрос", async () => {
    const { impl, calls } = stubFetch([]);

    expect(await makeAdapter(impl).fetchTenderById("  ")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("RoseltorgTenderSourceAdapter.fetchDocuments", () => {
  it("документов нет, и запрос к площадке не делается", async () => {
    const { impl, calls } = stubFetch([]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchDocuments("ROSELTORG-B0210261118005")).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("RoseltorgTenderSourceAdapter.checkChanges", () => {
  it("сдвинутый срок приёма заявок — это изменение", async () => {
    const { impl } = stubFetch([
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);

    const changed = await makeAdapter(impl).checkChanges(
      "32616431971",
      "2026-10-10T00:00:00.000Z",
    );

    expect(changed).toBe(true);
  });

  it("тот же срок изменения не даёт", async () => {
    const { impl } = stubFetch([
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);

    const changed = await makeAdapter(impl).checkChanges(
      "32616431971",
      "2026-10-13T00:00:00.000Z",
    );

    expect(changed).toBe(false);
  });

  it("процедура пропала из выдачи — изменений нет", async () => {
    const { impl } = stubFetch([{ query: "32616431971", body: NO_RESULTS }]);

    const changed = await makeAdapter(impl).checkChanges(
      "32616431971",
      "2026-10-10T00:00:00.000Z",
    );

    expect(changed).toBe(false);
  });

  it("нечитаемая отметка не даёт выдуманного ответа и не тратит запрос", async () => {
    const { impl, calls } = stubFetch([
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);

    expect(await makeAdapter(impl).checkChanges("32616431971", "не дата")).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("RoseltorgTenderSourceAdapter.filterStats", () => {
  it("различает «площадка ничего не отдала» и «мы отбросили»", async () => {
    const { impl } = stubFetch([
      {
        body: listing(
          ROSELTORG_PRICED_ITEM,
          ROSELTORG_FZ44_ITEM,
          ROSELTORG_STALE_ITEM,
          NUMBERLESS_ITEM,
        ),
      },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
      { query: "0373200045226001469", body: listing(ROSELTORG_FZ44_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders(baseQuery);
    const stats = adapter.filterStats;

    expect(stats.rows).toBe(4);
    expect(stats.discovered).toBe(2);
    expect(stats.resolved).toBe(1);
    expect(stats.kept).toBe(1);
    expect(stats.droppedRows["срок приёма заявок истёк"]).toBe(1);
    expect(stats.droppedRows["нет номера в строке выдачи"]).toBe(1);
    expect(stats.rejected["закон"]).toBe(1);
    expect(stats.resolveLimitReached).toBe(false);
  });

  it("статистика сбрасывается между прогонами", async () => {
    const { impl } = stubFetch([
      { body: listing(ROSELTORG_PRICED_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders({ ...baseQuery, regions: ["сахалинская"] });
    expect(adapter.filterStats.kept).toBe(0);
    expect(adapter.filterStats.rejected["регион"]).toBe(1);

    await adapter.fetchTenders(baseQuery);
    expect(adapter.filterStats.kept).toBe(1);
    expect(adapter.filterStats.rejected["регион"]).toBeUndefined();
  });

  it("адрес площадки настраивается: прогон может идти через тестовый хост", async () => {
    const { impl, calls } = stubFetch([{ body: NO_RESULTS }]);

    await makeAdapter(impl, { baseUrl: "https://search.example.test" }).fetchTenders(baseQuery);

    expect(calls[0]?.url.startsWith("https://search.example.test/procedures/search_ajax?")).toBe(
      true,
    );
    expect(ROSELTORG_BASE_URL).toBe("https://www.roseltorg.ru");
  });
});

/*
  Регион профиля. Региона в форме поиска нет, и обычные пять страниц по всей
  России для небольшого региона пусты (05.10.2026: Бурятия, Забайкалье, Иркутская
  область — ни одной закупки). Строка выдачи печатает регион заказчика, поэтому
  чужие регионы отсеиваются до запросов карточек, а региональный профиль листает
  выдачу глубже.
*/
describe("RoseltorgTenderSourceAdapter.fetchTenders — регион профиля", () => {
  it("чужой регион из строки выдачи не тратит запрос по номеру", async () => {
    const { impl, calls } = stubFetch([
      { body: listing(ROSELTORG_PRICED_ITEM, ROSELTORG_COMMERCIAL_ITEM) },
      { query: "32616431971", body: listing(ROSELTORG_PRICED_ITEM) },
      { query: "B0210261118005", body: listing(ROSELTORG_COMMERCIAL_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, regions: ["Волгоградская область"] });

    expect(tenders.map((tender) => tender.region)).toEqual(["Волгоградская область"]);
    expect(resolveCalls(calls, "B0210261118005")).toHaveLength(0);
    expect(adapter.filterStats.rejected["регион"]).toBe(1);
  });

  it("неизвестный регион в строке тоже отсеивается до запроса", async () => {
    const { impl, calls } = stubFetch([
      { body: listing(ROSELTORG_UNKNOWN_REGION_ITEM) },
      { query: "ATOM02102600184", body: listing(ROSELTORG_UNKNOWN_REGION_ITEM) },
    ]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders({ ...baseQuery, regions: ["Волгоградская область"] });

    expect(resolveCalls(calls)).toHaveLength(0);
    expect(adapter.filterStats.rejected["регион не определён"]).toBe(1);
  });

  it("с регионом выдача листается глубже обычного предела страниц", async () => {
    const pageWithNext = buildRoseltorgSearchPage({
      items: [ROSELTORG_COMMERCIAL_ITEM],
      hasNextPage: true,
      nextPage: 1,
    });
    const routes = Array.from({ length: 8 }, (_, page) => ({ page, body: pageWithNext }));
    const { impl, calls } = stubFetch(routes);

    await makeAdapter(impl, { maxPages: 2, maxRegionalPages: 6 }).fetchTenders({
      ...baseQuery,
      regions: ["Республика Бурятия"],
    });

    expect(discoveryCalls(calls)).toHaveLength(6);
  });
});
