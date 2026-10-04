/**
 * Тесты адаптера источника «Контур.Закупки».
 *
 * Проверяют подтверждённый контракт (спецификация OpenAPI 3.0.4 «АПИ Закупок»
 * + живой зонд тестовым ключом 23.09.2026) и экономию платных запросов:
 * cache-first, дневной бюджет, бесплатные эндпоинты, повтор только того, что
 * действительно можно повторить. Тела ответов — реальные (konturTestFixtures).
 */
import { describe, expect, it, vi } from "vitest";
import {
  KONTUR_CONTRACT_DEFAULTS,
  KONTUR_PROTOCOL,
  KonturAuthError,
  KonturRateLimitError,
  KonturResponseParseError,
  konturErrorFromResponse,
  konturAuthHeaders,
  konturLimitGroupsUrl,
  konturSearchUrl,
  konturTenderUrl,
  konturTestTenderUrl,
  isBillableKonturKind,
  isRetryableKonturError,
  resolveKonturContract,
} from "@/adapters/tender-source/konturContract";
import {
  KonturDailyLimitError,
  KonturNotConfiguredError,
  KonturTenderSourceAdapter,
  type KonturAdapterOptions,
} from "@/adapters/tender-source/konturTenderSourceAdapter";
import { createMemoryKonturStore, isEntryFresh } from "@/adapters/tender-source/konturCache";
import {
  KONTUR_NOW,
  buildKonturSearchPage,
  konturCard44,
  konturHtmlInsteadOfJson,
  konturLimitGroupsResponse,
  konturSearchItem223,
  konturSearchItemAbandoned,
  konturSearchItemCancelled,
  konturSearchItemNoPrice,
} from "@/adapters/tender-source/konturTestFixtures";
import type { TenderSourceQuery } from "@/adapters/types";

/** Подтверждённые адреса: их нельзя «улучшать» — за ними стоит спецификация. */
const SEARCH_URL = "https://api-zakupki.kontur.ru/external/v1/search";
const LIMIT_GROUPS_URL = "https://api-zakupki.kontur.ru/external/v1/limitGroups";
const CARD_URL = "https://api-zakupki.kontur.ru/external/v1/purchases/0301300335621000492";
const TEST_CARD_URL = "https://api-zakupki.kontur.ru/external/v1/testpurchases/0301300335621000492";

interface StubResponse {
  body: string;
  status?: number;
  headers?: Record<string, string>;
}

/** Заглушка fetch: отдаёт ответы из очереди, последний повторяется. */
function stubFetch(queue: StubResponse[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const item = queue[Math.min(calls.length - 1, queue.length - 1)] ?? { body: "{}" };
    const status = item.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => item.body,
      headers: {
        get: (name: string) => item.headers?.[name] ?? item.headers?.[name.toLowerCase()] ?? null,
      },
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const contract = { ...KONTUR_CONTRACT_DEFAULTS, apiKey: "test-key" };
const baseQuery: TenderSourceQuery = { laws: ["FZ_44"], limit: 10 };

function makeAdapter(fetchImpl: typeof fetch, overrides: Partial<KonturAdapterOptions> = {}) {
  return new KonturTenderSourceAdapter({
    contract,
    fetchImpl,
    nowProvider: () => KONTUR_NOW,
    // 1000 запросов в секунду: тесты не должны ждать троттлинг.
    rateLimitPerSec: 1000,
    maxRetries: 2,
    maxPages: 5,
    ...overrides,
  });
}

/** Страница выдачи из реальных записей: две читаются, две отбрасываются. */
function searchPage(total = 4, pageNumber = 0): string {
  return buildKonturSearchPage(
    [konturSearchItem223, konturSearchItemNoPrice, konturSearchItemCancelled, konturSearchItemAbandoned],
    { total, pageNumber },
  );
}

/** Запись выдачи с другим внутренним Id: нужен для многостраничной выдачи. */
function searchItem(id: string): Record<string, unknown> {
  return { ...konturSearchItem223, Id: id, Link: `https://zakupki.kontur.ru/${id}` };
}

/**
 * Запись выдачи с настоящим местом поставки. Тестовый ключ закрашивает
 * `DeliveryPlaces`, и регион у всей такой выдачи «Не указан» — для проверки
 * регионального отбора нужен читаемый адрес.
 */
function searchItemInRegion(id: string, place: string): Record<string, unknown> {
  return { ...searchItem(id), DeliveryPlaces: [place] };
}

function requestHeaders(call: { init: RequestInit } | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

function requestBody(call: { init: RequestInit } | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

describe("контракт подключения", () => {
  it("читает ключ и пути из переменных окружения", () => {
    const resolved = resolveKonturContract({
      KONTUR_API_KEY: " secret ",
      KONTUR_API_BASE_URL: "https://api.example.ru/",
      KONTUR_API_SEARCH_PATH: "/external/v2/search",
      KONTUR_API_AUTH_HEADER: "X-Api-Key",
      // Пустое значение задано намеренно: у Контур.Закупок нет схемы авторизации.
      KONTUR_API_AUTH_SCHEME: "",
    });
    expect(resolved.apiKey).toBe("secret");
    expect(resolved.baseUrl).toBe("https://api.example.ru");
    expect(resolved.searchPath).toBe("/external/v2/search");
    expect(konturAuthHeaders(resolved)).toEqual({ "X-Api-Key": "secret" });
  });

  it("ключ передаётся заголовком X-Kontur-Apikey без схемы", () => {
    expect(konturAuthHeaders(contract)).toEqual({ "X-Kontur-Apikey": "test-key" });
    expect(konturAuthHeaders(contract)).not.toHaveProperty("Authorization");
    // Без ключа заголовок не добавляется вовсе — запрос упадёт с понятной ошибкой.
    expect(konturAuthHeaders({ ...KONTUR_CONTRACT_DEFAULTS, apiKey: "" })).toEqual({});
  });

  it("строит адреса подтверждённых эндпоинтов", () => {
    expect(konturSearchUrl(contract)).toBe(SEARCH_URL);
    expect(konturTenderUrl(contract, "0301300335621000492")).toBe(CARD_URL);
    expect(konturTestTenderUrl(contract, "0301300335621000492")).toBe(TEST_CARD_URL);
    expect(konturLimitGroupsUrl(contract)).toBe(LIMIT_GROUPS_URL);
  });

  it("протокольные ограничения диктует API, а не настройка", async () => {
    expect(KONTUR_PROTOCOL).toMatchObject({
      pageSize: 50,
      maxPerDateRange: 10_000,
      maxConcurrent: 5,
      requiresDateRange: true,
    });
    // Больше 50 закупок на странице источник не отдаёт: значение урезается.
    const { impl, calls } = stubFetch([{ body: buildKonturSearchPage([konturSearchItem223]) }]);
    const adapter = makeAdapter(impl, { pageSize: 500 });

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
    // Страница из одной записи меньше 50 — выдача закончилась, второго запроса нет.
    expect(calls).toHaveLength(1);
  });

  it("платные виды запросов отличаются от бесплатных", () => {
    expect(isBillableKonturKind("search")).toBe(true);
    expect(isBillableKonturKind("card")).toBe(true);
    // Проверено живым зондом: счётчики групп не меняются после этих вызовов.
    expect(isBillableKonturKind("testcard")).toBe(false);
    expect(isBillableKonturKind("limits")).toBe(false);
  });

  it("классифицирует ошибки: 401 не повторяется, 429 повторяется с Retry-After", () => {
    const auth = konturErrorFromResponse(401, "u", "", null);
    expect(auth).toBeInstanceOf(KonturAuthError);
    expect(isRetryableKonturError(auth)).toBe(false);

    const limited = konturErrorFromResponse(429, "u", "", "7");
    expect(limited).toBeInstanceOf(KonturRateLimitError);
    expect((limited as KonturRateLimitError).retryAfterSec).toBe(7);
    expect(isRetryableKonturError(limited)).toBe(true);

    expect(isRetryableKonturError(konturErrorFromResponse(503, "u", "", null))).toBe(true);
    expect(isRetryableKonturError(konturErrorFromResponse(400, "u", "", null))).toBe(false);
    expect(isRetryableKonturError(new KonturResponseParseError("u", "<html>"))).toBe(false);
    expect(isRetryableKonturError(new TypeError("fetch failed"))).toBe(true);
  });

  it("показывает конфигурацию без ключа", () => {
    const { impl } = stubFetch([{ body: "{}" }]);
    expect(makeAdapter(impl).contractSummary).toEqual({
      baseUrl: "https://api-zakupki.kontur.ru",
      configured: true,
      paths: {
        search: "/external/v1/search",
        tender: "/external/v1/purchases/{id}",
        testTender: "/external/v1/testpurchases/{id}",
        limitGroups: "/external/v1/limitGroups",
      },
    });
  });
});

describe("поиск закупок", () => {
  it("отправляет POST на /external/v1/search с ключом в заголовке и окном дат", async () => {
    const { impl, calls } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["ремонт"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SEARCH_URL);
    expect(calls[0]?.init.method).toBe("POST");
    expect(requestHeaders(calls[0])).toMatchObject({
      "X-Kontur-Apikey": "test-key",
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    expect(requestHeaders(calls[0])).not.toHaveProperty("Authorization");

    const body = requestBody(calls[0]);
    expect(body["Text"]).toEqual(["ремонт"]);
    expect(body["Laws"]).toEqual([1]);
    // Обязательные поля API: без них поиск отвечает 400.
    expect(body["DateTimeTo"]).toBe(KONTUR_NOW);
    expect(body["DateTimeFrom"]).toBe("2026-09-16T12:00:00.000Z");
    // Просроченная закупка не должна попадать в выдачу и получать вердикт.
    expect(body["ApplicationDeadlineFrom"]).toBe(KONTUR_NOW);
    expect(body["PageNumber"]).toBe(0);
    // Нумерация страниц с нуля, offset/limit у API нет.
    expect(body).not.toHaveProperty("offset");
    expect(body).not.toHaveProperty("limit");

    expect(tenders.map((tender) => tender.regNumber)).toEqual([
      "32616401973",
      "0328100002326000522",
    ]);
    expect(tenders[0]?.dataSource).toBe("KONTUR");
  });

  it("листает выдачу по PageNumber, пока не набран лимит", async () => {
    const page0 = buildKonturSearchPage([searchItem("a-1"), searchItem("a-2")], { total: 4 });
    const page1 = buildKonturSearchPage([searchItem("b-1"), searchItem("b-2")], {
      total: 4,
      pageNumber: 1,
    });
    const { impl, calls } = stubFetch([{ body: page0 }, { body: page1 }]);
    const adapter = makeAdapter(impl, { pageSize: 2 });

    const tenders = await adapter.fetchTenders({ ...baseQuery, limit: 10 });

    expect(calls).toHaveLength(2);
    expect(requestBody(calls[0])["PageNumber"]).toBe(0);
    expect(requestBody(calls[1])["PageNumber"]).toBe(1);
    // Момент «сейчас» один на весь обход: иначе окно публикации сдвинулось бы
    // под ногами и ключ кэша перестал бы совпадать.
    expect(requestBody(calls[1])["DateTimeTo"]).toBe(requestBody(calls[0])["DateTimeTo"]);
    expect(tenders).toHaveLength(4);
  });

  it("останавливается на неполной странице и на исчерпанном лимите", async () => {
    const short = stubFetch([{ body: buildKonturSearchPage([konturSearchItem223], { total: 379 }) }]);
    await makeAdapter(short.impl, { pageSize: 50 }).fetchTenders(baseQuery);
    expect(short.calls).toHaveLength(1);

    // maxPages ограничивает расход даже при бесконечной выдаче.
    const capped = stubFetch([
      { body: buildKonturSearchPage([searchItem("a-1"), searchItem("a-2")], { total: 1000 }) },
      { body: buildKonturSearchPage([searchItem("b-1"), searchItem("b-2")], { total: 1000 }) },
    ]);
    await makeAdapter(capped.impl, { pageSize: 2, maxPages: 2 }).fetchTenders({
      ...baseQuery,
      limit: 100,
    });
    expect(capped.calls).toHaveLength(2);

    // Лимит набран — дальше страницы не снимаются.
    const limited = stubFetch([
      { body: buildKonturSearchPage([searchItem("a-1"), searchItem("a-2")], { total: 1000 }) },
      { body: buildKonturSearchPage([searchItem("b-1"), searchItem("b-2")], { total: 1000 }) },
    ]);
    const tenders = await makeAdapter(limited.impl, { pageSize: 2 }).fetchTenders({
      ...baseQuery,
      limit: 2,
    });
    expect(limited.calls).toHaveLength(1);
    expect(tenders).toHaveLength(2);
  });

  it("не дублирует закупку, встреченную на двух страницах", async () => {
    const { impl } = stubFetch([
      { body: buildKonturSearchPage([searchItem("dup"), searchItem("dup-2")], { total: 4 }) },
      { body: buildKonturSearchPage([searchItem("dup"), searchItem("dup-3")], {
        total: 4,
        pageNumber: 1,
      }) },
    ]);
    const tenders = await makeAdapter(impl, { pageSize: 2 }).fetchTenders({
      ...baseQuery,
      limit: 10,
    });
    expect(tenders.map((tender) => tender.regNumber)).toEqual(["dup", "dup-2", "dup-3"]);
  });

  it("пустой ответ — нормальный результат, не ошибка", async () => {
    const { impl } = stubFetch([{ body: buildKonturSearchPage([], { total: 0 }) }]);
    await expect(makeAdapter(impl).fetchTenders(baseQuery)).resolves.toEqual([]);
  });

  it("сообщает, какие записи отброшены и почему", async () => {
    const { impl } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders(baseQuery);

    // Отменённая и несостоявшаяся закупки — штатный отбор, не сбой схемы.
    expect(adapter.lastSkipped).toEqual(["cancelled", "abandoned"]);
  });

  it("сообщает, что часть значений скрыта тестовым ключом", async () => {
    const { impl } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders(baseQuery);

    expect(adapter.lastBlurred).toEqual({
      fields: ["customerInn", "customerName", "deliveryPlaces", "etpLink", "regNumber"],
      documents: 0,
    });
  });

  it("сохраняет сырую запись: закупку можно пересобрать без нового запроса", async () => {
    const { impl } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders(baseQuery);

    const raw = adapter.getRaw("32616401973");
    expect(raw?.["OrderName"]).toBe(konturSearchItem223["OrderName"]);
    expect(adapter.getRaw("нет-такой")).toBeNull();
  });

  it("отсекает закупку чужого региона и показывает, сколько отсек", async () => {
    // Наименования субъектов API не принимает (регион — только UUID из
    // закрытого каталога), поэтому профиль применяется к полученной выдаче.
    // Без этого запрос оплачен, а в базе закупки со всей России.
    const { impl } = stubFetch([
      {
        body: buildKonturSearchPage(
          [
            searchItemInRegion("1", "Республика Башкортостан, г. Уфа"),
            searchItemInRegion("2", "Новосибирская область, г. Новосибирск"),
          ],
          { total: 2 },
        ),
      },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      ...baseQuery,
      regions: ["Республика Башкортостан"],
    });

    expect(tenders.map((tender) => tender.region)).toEqual(["Республика Башкортостан"]);
    expect(adapter.lastFilteredOut).toBe(1);
    expect(adapter.getRaw("2")).toBeNull();
  });

  it("не отсекает закупку с неизвестным регионом", async () => {
    // «Не определён» не равно «другой»: тестовый ключ закрашивает адреса, и
    // жёсткий фильтр оставил бы прогон вообще без закупок.
    const { impl } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, regions: ["Москва"] });

    expect(tenders).toHaveLength(2);
    expect(tenders.every((tender) => tender.region === "Не указан")).toBe(true);
    expect(adapter.lastFilteredOut).toBe(0);
  });

  it("лимит считается по подходящим закупкам: обход страниц продолжается", async () => {
    const foreignPage = (pageNumber: number) =>
      buildKonturSearchPage(
        Array.from({ length: KONTUR_PROTOCOL.pageSize }, (_, index) =>
          searchItemInRegion(`f${pageNumber}-${index}`, "Новосибирская область, г. Новосибирск"),
        ),
        { total: 100, pageNumber },
      );
    const { impl, calls } = stubFetch([
      { body: foreignPage(0) },
      {
        body: buildKonturSearchPage(
          [searchItemInRegion("own", "Республика Башкортостан, г. Уфа")],
          { total: 100, pageNumber: 1 },
        ),
      },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      ...baseQuery,
      regions: ["Республика Башкортостан"],
      limit: 1,
    });

    expect(tenders.map((tender) => tender.regNumber)).toEqual(["own"]);
    expect(adapter.lastFilteredOut).toBe(KONTUR_PROTOCOL.pageSize);
    expect(calls.map((call) => requestBody(call)["PageNumber"])).toEqual([0, 1]);
  });
});

describe("кэш и расход платных запросов", () => {
  it("повторный identical-запрос берётся из кэша и не расходует API", async () => {
    const store = createMemoryKonturStore(() => KONTUR_NOW);
    const { impl, calls } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl, { store, usage: store });

    const first = await adapter.fetchTenders(baseQuery);
    const second = await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(1);
    expect(second).toHaveLength(first.length);
    expect(adapter.counters).toMatchObject({ apiCalls: 1, cacheHits: 1, requestsToday: 1 });
    const log = store.usage();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ kind: "search", fromCache: false, status: 200 });
    expect(log[1]).toMatchObject({ kind: "search", fromCache: true, status: null });
  });

  it("прогон через двадцать минут берётся из кэша: окно выровнено по часу", async () => {
    // Регрессия живого прогона 23.09.2026: ключ кэша считается от тела запроса,
    // а DateTimeTo и ApplicationDeadlineFrom брались из `now` с миллисекундами,
    // поэтому каждый плановый прогон платил заново. Тесты этого не ловили —
    // `nowProvider` в них возвращал одну и ту же строку.
    let now = "2026-09-23T14:05:00.000Z";
    const store = createMemoryKonturStore(() => now);
    const { impl, calls } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl, { store, usage: store, nowProvider: () => now });

    const first = await adapter.fetchTenders(baseQuery);
    now = "2026-09-23T14:25:00.000Z";
    const second = await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(1);
    expect(second).toHaveLength(first.length);
    expect(adapter.counters).toMatchObject({ apiCalls: 1, cacheHits: 1, requestsToday: 1 });
  });

  it("на границе часа ключ новый: прогон платит снова", async () => {
    // Обратная сторона выравнивания — и гарантия, что кэш не отдаёт вчерашнее
    // окно публикации: новые закупки приходят со следующим часовым ключом.
    let now = "2026-09-23T14:55:00.000Z";
    const store = createMemoryKonturStore(() => now);
    const { impl, calls } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl, { store, usage: store, nowProvider: () => now });

    await adapter.fetchTenders(baseQuery);
    now = "2026-09-23T15:05:00.000Z";
    await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(2);
    expect(adapter.counters).toMatchObject({ apiCalls: 2, cacheHits: 0 });
  });

  it("сохраняет сырой ответ вместе с телом запроса", async () => {
    const store = createMemoryKonturStore(() => KONTUR_NOW);
    const { impl } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl, { store });

    await adapter.fetchTenders(baseQuery);

    expect(store.size()).toBe(1);
  });

  it("другой набор фильтров — другой ключ кэша и новый запрос", async () => {
    const store = createMemoryKonturStore(() => KONTUR_NOW);
    const { impl, calls } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl, { store });

    await adapter.fetchTenders({ ...baseQuery, keywords: ["ремонт"] });
    await adapter.fetchTenders({ ...baseQuery, keywords: ["строительство"] });

    expect(calls).toHaveLength(2);
  });

  it("просроченный кэш заставляет повторить запрос", async () => {
    const store = createMemoryKonturStore(() => KONTUR_NOW);
    const { impl, calls } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl, { store, searchTtlSec: 0 });

    await adapter.fetchTenders(baseQuery);
    await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(2);
    expect(
      isEntryFresh({ cacheKey: "k", payload: {}, fetchedAt: KONTUR_NOW }, 0, KONTUR_NOW),
    ).toBe(false);
  });

  it("дневной бюджет останавливает синхронизацию до обращения к API", async () => {
    const { impl, calls } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl, { dailyLimitPerMethod: 1 });

    await adapter.fetchTenders(baseQuery);
    await expect(
      adapter.fetchTenders({ ...baseQuery, keywords: ["другой запрос"] }),
    ).rejects.toBeInstanceOf(KonturDailyLimitError);
    expect(calls).toHaveLength(1);
  });

  it("считает уже израсходованные сегодня запросы", async () => {
    const { impl } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl, {
      dailyLimitPerMethod: 6,
      requestsTodayByMethod: { search: 5 },
    });

    await adapter.fetchTenders(baseQuery);
    expect(adapter.counters.requestsToday).toBe(6);
    await expect(adapter.fetchTenders({ ...baseQuery, keywords: ["ещё"] })).rejects.toThrow(
      /Исчерпан суточный лимит запросов Контур\.Закупок \(поиск\): 6 из 6/,
    );
  });

  it("бюджет каждого метода считается отдельно: поиски кончились, карточки доступны", async () => {
    // Тариф даёт 30 запросов в сутки на группу `search` и 30 на `purchase`.
    // Общий счётчик заблокировал бы карточку вместе с поиском — и закупка
    // осталась бы без документации, хотя лимит на карточки не потрачен.
    const { impl, calls } = stubFetch([{ body: JSON.stringify(konturCard44) }]);
    const adapter = makeAdapter(impl, {
      dailyLimitPerMethod: 30,
      requestsTodayByMethod: { search: 30, card: 0 },
    });

    await expect(adapter.fetchTenders(baseQuery)).rejects.toBeInstanceOf(KonturDailyLimitError);
    const documents = await adapter.fetchCardDocumentList("0301300335621000492");

    expect(documents.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(adapter.counters.requestsTodayByMethod).toEqual({ search: 30, card: 1 });
  });
});

describe("бесплатные эндпоинты", () => {
  it("остаток лимита читается из /limitGroups и не расходует бюджет", async () => {
    const { impl, calls } = stubFetch([{ body: JSON.stringify(konturLimitGroupsResponse) }]);
    const adapter = makeAdapter(impl, { dailyLimitPerMethod: 0 });

    const groups = await adapter.fetchLimitGroups();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(LIMIT_GROUPS_URL);
    expect(calls[0]?.init.method).toBe("GET");
    expect(groups.map((group) => group.availableRequests)).toEqual([199, 199, 200]);
    expect(adapter.counters).toMatchObject({ apiCalls: 0, requestsToday: 0 });
  });

  it("остаток кэшируется на пять минут, а force читает у источника", async () => {
    const { impl, calls } = stubFetch([{ body: JSON.stringify(konturLimitGroupsResponse) }]);
    const adapter = makeAdapter(impl, { store: createMemoryKonturStore(() => KONTUR_NOW) });

    await adapter.fetchLimitGroups();
    await adapter.fetchLimitGroups();
    expect(calls).toHaveLength(1);
    /*
      Счётчик «из кэша» показывается рядом с числом платных запросов, поэтому
      бесплатное чтение тарифа в него не попадает. Живой прогон 24.09.2026 на
      проде: три оплаченных поиска и три чтения `/limitGroups` из кэша —
      прежний подсчёт печатал «платных поисков 3 · из кэша 3», и партнёр решил
      бы, что поиски достались бесплатно.
    */
    expect(adapter.counters).toMatchObject({ apiCalls: 0, cacheHits: 0, requestsToday: 0 });

    // После синхронизации кэшированное значение показало бы остаток до неё.
    await adapter.fetchLimitGroups(true);
    expect(calls).toHaveLength(2);
    expect(adapter.counters.cacheHits).toBe(0);
  });

  it("тестовая карточка не расходует бюджет и не закрашивает значения", async () => {
    const { impl, calls } = stubFetch([{ body: JSON.stringify(konturCard44) }]);
    const adapter = makeAdapter(impl, { dailyLimitPerMethod: 0 });

    const tender = await adapter.fetchTestTenderById("0301300335621000492");

    expect(calls[0]?.url).toBe(TEST_CARD_URL);
    expect(tender?.regNumber).toBe("0301300335621000492");
    expect(tender?.documents).toHaveLength(7);
    expect(adapter.counters).toMatchObject({ apiCalls: 0, requestsToday: 0 });
  });
});

describe("ошибки API", () => {
  it("401 вызывает уведомление администратора и не повторяется", async () => {
    const onAuthError = vi.fn();
    const { impl, calls } = stubFetch([{ body: "ключ недействителен", status: 401 }]);
    const adapter = makeAdapter(impl, { onAuthError });

    await expect(adapter.fetchTenders(baseQuery)).rejects.toBeInstanceOf(KonturAuthError);
    expect(calls).toHaveLength(1);
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it("429 повторяется и заканчивается успехом", async () => {
    const { impl, calls } = stubFetch([
      { body: "", status: 429, headers: { "Retry-After": "0" } },
      { body: searchPage() },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(2);
    expect(tenders).toHaveLength(2);
  });

  it("5xx повторяется, 4xx — нет", async () => {
    const server = stubFetch([{ body: "сбой", status: 503 }, { body: searchPage() }]);
    await expect(makeAdapter(server.impl).fetchTenders(baseQuery)).resolves.toHaveLength(2);
    expect(server.calls).toHaveLength(2);

    const client = stubFetch([{ body: "плохой запрос", status: 400 }]);
    await expect(makeAdapter(client.impl).fetchTenders(baseQuery)).rejects.toThrow(/HTTP 400/);
    expect(client.calls).toHaveLength(1);
  });

  it("HTML вместо JSON не повторяется и объясняет причину", async () => {
    const { impl, calls } = stubFetch([{ body: konturHtmlInsteadOfJson }]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchTenders(baseQuery)).rejects.toBeInstanceOf(KonturResponseParseError);
    // Повтор стоил бы денег и не помог: путь неверен.
    expect(calls).toHaveLength(1);
  });

  it("без ключа запрос не выполняется вовсе", async () => {
    const { impl, calls } = stubFetch([{ body: searchPage() }]);
    const adapter = makeAdapter(impl, {
      contract: { ...KONTUR_CONTRACT_DEFAULTS, apiKey: "" },
    });

    await expect(adapter.fetchTenders(baseQuery)).rejects.toBeInstanceOf(KonturNotConfiguredError);
    expect(calls).toHaveLength(0);
  });
});

describe("карточка, документы и изменения", () => {
  it("запрашивает карточку по идентификатору закупки", async () => {
    const { impl, calls } = stubFetch([{ body: JSON.stringify(konturCard44) }]);
    const adapter = makeAdapter(impl);

    const tender = await adapter.fetchTenderById("kontur-0301300335621000492");

    expect(calls[0]?.url).toBe(CARD_URL);
    expect(calls[0]?.init.method).toBe("GET");
    expect(tender?.regNumber).toBe("0301300335621000492");
    expect(tender?.region).toBe("Республика Башкортостан");
    expect(tender?.documents).toHaveLength(7);
    expect(adapter.getRaw("0301300335621000492")).not.toBeNull();
  });

  it("принимает и чистый идентификатор, и идентификатор ТендерФит", async () => {
    // Кэш не подключён — важнее проверить путь: префикс «kontur-» снимается,
    // и в URL попадает идентификатор источника, а не внутренний ID ТендерФит.
    const { impl, calls } = stubFetch([{ body: JSON.stringify(konturCard44) }]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenderById("0301300335621000492");
    await adapter.fetchTenderById("kontur-0301300335621000492");

    expect(calls.map((call) => call.url)).toEqual([CARD_URL, CARD_URL]);
  });

  it("документы читаются из той же карточки: отдельного метода у API нет", async () => {
    const store = createMemoryKonturStore(() => KONTUR_NOW);
    const { impl, calls } = stubFetch([{ body: JSON.stringify(konturCard44) }]);
    const adapter = makeAdapter(impl, { store });

    const documents = await adapter.fetchDocuments("kontur-0301300335621000492");

    expect(calls[0]?.url).toBe(CARD_URL);
    expect(documents).toHaveLength(7);
    expect(documents.filter((doc) => doc.type === "DRAFT_CONTRACT")).toHaveLength(2);
    expect(adapter.counters).toMatchObject({ apiCalls: 1 });

    // Карточка уже в кэше — документы достаются бесплатно.
    await adapter.fetchTenderById("kontur-0301300335621000492");
    expect(calls).toHaveLength(1);
    expect(adapter.counters).toMatchObject({ apiCalls: 1, cacheHits: 1 });
  });

  it("пустой идентификатор не приводит к запросу", async () => {
    const { impl, calls } = stubFetch([{ body: JSON.stringify(konturCard44) }]);
    const adapter = makeAdapter(impl);

    // Нечего подставлять в путь — запрос не выполняется и деньги не тратятся.
    await expect(adapter.fetchTenderById("")).resolves.toBeNull();
    await expect(adapter.fetchDocuments("")).resolves.toEqual([]);
    await expect(adapter.checkChanges("", KONTUR_NOW)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("сравнивает дату изменения карточки с указанной", async () => {
    const store = createMemoryKonturStore(() => KONTUR_NOW);
    const { impl, calls } = stubFetch([{ body: JSON.stringify(konturCard44) }]);
    const adapter = makeAdapter(impl, { store });

    // UpdatedDatetime карточки — 30.12.2021 07:43:31.
    await expect(
      adapter.checkChanges("kontur-0301300335621000492", "2021-12-29T00:00:00.000Z"),
    ).resolves.toBe(true);
    await expect(
      adapter.checkChanges("kontur-0301300335621000492", "2021-12-31T00:00:00.000Z"),
    ).resolves.toBe(false);
    // Вторая проверка взята из кэша (TTL 15 минут), платных запросов больше не было.
    expect(calls).toHaveLength(1);
    expect(adapter.counters).toMatchObject({ apiCalls: 1, cacheHits: 1 });
  });

  it("карточка кэшируется на неделю", async () => {
    const store = createMemoryKonturStore(() => KONTUR_NOW);
    const { impl, calls } = stubFetch([{ body: JSON.stringify(konturCard44) }]);
    const adapter = makeAdapter(impl, { store });

    await adapter.fetchTenderById("0301300335621000492");
    await adapter.fetchTenderById("0301300335621000492");

    expect(calls).toHaveLength(1);
    expect(adapter.counters).toMatchObject({ apiCalls: 1, cacheHits: 1 });
  });
});
