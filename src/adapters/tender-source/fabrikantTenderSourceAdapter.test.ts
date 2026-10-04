import { describe, expect, it, vi } from "vitest";
import { UNKNOWN_REGION } from "@/domain/entities";
import {
  FABRIKANT_DEFAULT_SECTIONS,
  FABRIKANT_OPEN_STATUSES,
  FABRIKANT_PAGE_LIMIT,
} from "@/adapters/tender-source/fabrikantSearch";
import type { FabrikantCardFixture } from "@/adapters/tender-source/fabrikantTestFixtures";
import {
  FABRIKANT_COMMERCIAL_CARD,
  FABRIKANT_FZ223_CARD,
  FABRIKANT_NO_PRICE_CARD,
  FABRIKANT_SPARSE_CARD,
  FABRIKANT_TEST_NOW,
  buildFabrikantCardPage,
  buildFabrikantSearchPage,
} from "@/adapters/tender-source/fabrikantTestFixtures";
import {
  FabrikantResponseError,
  FabrikantTenderSourceAdapter,
  fabrikantTenderNumber,
} from "@/adapters/tender-source/fabrikantTenderSourceAdapter";
import type { TenderSourceQuery } from "@/adapters/types";

/** Путь выдачи. Совпадает с тем, что собирает `fabrikantSearchUrl`. */
const SEARCH_PATH = "/procedure/search/purchases";

/** Путь карточки процедуры на публичном хосте. */
const CARD_PATH = "/v2/trades/procedure/view/";

/**
 * Адрес карточки, который площадка НЕ понимает.
 *
 * Живой замер 02.10.2026: «Маркет» ведёт на `market.fabrikant.ru/purchase_notice_es/view?id=…`,
 * а секция 44-ФЗ — на `44.fabrikant.ru/44/procedure/…`. Парсер карточки `/v2`
 * разбирает только свой путь, поэтому такие строки адаптер обязан пропустить со
 * счётчиком, а не запросить и получить ноль лотов.
 */
const MARKET_CARD_URL = "https://market.fabrikant.ru/purchase_notice_es/view?id=679704362";

/**
 * Строка выдачи, ведущая в ЕИС, а не на площадку.
 *
 * Живой замер 02.10.2026: таких 19 из 79 строк выдачи без ключевого слова. Это
 * не потеря — то же извещение приносит адаптер реестра, и приносит вместе с
 * документами, которых Фабрикант не отдаёт вовсе.
 */
const EIS_ROW_URL =
  "https://zakupki.gov.ru/epz/order/extendedsearch/results.html?searchString=0123456789";

/** Один подготовленный ответ площадки. */
type StubRoute =
  | {
      readonly kind: "search";
      /** Значение `query`; не задано — маршрут запроса без ключевого слова. */
      readonly query?: string;
      /** Номер страницы выдачи; не задан — первая. */
      readonly page?: number;
      readonly body: StubBody;
      readonly status?: number;
    }
  | {
      readonly kind: "card";
      /** Внутренний номер лота из адреса карточки. */
      readonly lotId: string;
      /** Номер страницы лотов; не задан — первая. */
      readonly page?: number;
      readonly body: StubBody;
      readonly status?: number;
    };

/** Тело ответа. Массив — тела по попыткам: по нему проверяются повторы. */
type StubBody = string | readonly string[];

/** Что запомнила заглушка об одном обращении. */
interface StubCall {
  readonly url: string;
  readonly kind: "search" | "card" | "other";
  readonly query: string | null;
  readonly page: number;
  readonly lotId: string | null;
}

/**
 * Заглушка fetch с маршрутами по пути и параметрам запроса.
 *
 * Фабрикант отвечает одной и той же выдачей и на поиск по слову, и на поиск по
 * номеру — различает их только `query`, поэтому маршруты строятся по нему, а не
 * по порядку вызовов. Карточка отличается путём и своим параметром страницы:
 * выдача нумерует страницы `page_number`, а карточка — `page`.
 */
function stubFetch(routes: readonly StubRoute[]) {
  const calls: StubCall[] = [];
  const hits = new Map<StubRoute, number>();
  const impl = vi.fn(async (input: string) => {
    const url = new URL(input);
    const isSearch = url.pathname === SEARCH_PATH;
    const isCard = url.pathname.startsWith(CARD_PATH);
    const lotId = isCard ? url.pathname.slice(CARD_PATH.length) : null;
    const query = isSearch ? url.searchParams.get("query") : null;
    const page = Number(
      url.searchParams.get(isSearch ? "page_number" : "page") ?? "1",
    );
    calls.push({ url: input, kind: isSearch ? "search" : isCard ? "card" : "other", query, page, lotId });

    for (const route of routes) {
      if (route.kind === "search") {
        if (!isSearch) continue;
        if ((route.query ?? null) !== query) continue;
        if ((route.page ?? 1) !== page) continue;
      } else {
        if (!isCard) continue;
        if (route.lotId !== lotId) continue;
        if ((route.page ?? 1) !== page) continue;
      }
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

/** Внутренний номер лота, который фикстура подставит в адрес карточки. */
function lotIdOf(procedureNumber: number): string {
  return String(procedureNumber * 100 + 1);
}

/** Строка выдачи: один лот одной процедуры. */
function lot(
  procedureNumber: number,
  overrides: Partial<FabrikantCardFixture> = {},
): FabrikantCardFixture {
  return {
    name: "Строительно-монтажные работы по объекту",
    lotId: Number(lotIdOf(procedureNumber)),
    procedureNumber,
    sectionEnum: "commercial",
    purchaseOosNumber: null,
    ...overrides,
  };
}

/** Страница выдачи без объекта пагинации: площадка не объявила продолжения. */
const listing = (...cards: readonly FabrikantCardFixture[]): string =>
  buildFabrikantSearchPage({ cards });

/** Пустой ответ площадки: «По вашему запросу ничего не найдено». */
const NO_RESULTS = buildFabrikantSearchPage({ noResults: true });

/**
 * Ответ площадки с ограниченным доступом: закупки нашлись, но анонимному
 * посетителю их не показывают. Живой замер 02.10.2026, запрос «МФУ».
 */
const RESTRICTED_PAGE = buildFabrikantSearchPage({ restricted: true });

/** Ответ, который не разбирается ни как выдача, ни как карточка. */
const ANTI_BOT_PAGE = "<html><head></head><body>Доступ ограничен</body></html>";

/**
 * Страница карточки с нужными номерами лотов.
 *
 * Номера лотов обязаны быть разными на всех страницах: маппер выбрасывает
 * повтор номера, чтобы задвоенная страница не удвоила публикуемую сумму.
 */
function cardPage(numbers: readonly number[], declared: number, submissionEnd = "15.10.2026 17:00"): string {
  return buildFabrikantCardPage({
    declaredLotCount: declared,
    eisNumber: null,
    procedurePanels: [
      { key: "purchase_category_custom", label: "Название процедуры на ЭТП", value: "Запрос предложений" },
      { key: "purchase_section", label: "Секция на торговой площадке", value: "Коммерческие процедуры" },
      { key: "date_publication", label: "Дата публикации", value: "01.10.2026 16:32" },
    ],
    organizer: {
      name: 'ООО "ПРИМЕР ПОСТАВЩИКА"',
      address: "443000, Россия, Самарская область, Самара, ул. Примерная, 1",
      inn: "6315000000",
    },
    lots: numbers.map((number) => ({
      number,
      subject: `Поставка смазочных материалов, лот ${number}`,
      price: `${number} 000 000,00`,
      vatIncluded: false,
      submissionEnd,
      deliveryRegion: "Самарская область",
    })),
  });
}

/** Четыре страницы карточки процедуры с 18 лотами: по пять лотов на страницу. */
const EIGHTEEN_LOT_PAGES: readonly string[] = [
  cardPage([1, 2, 3, 4, 5], 18),
  cardPage([6, 7, 8, 9, 10], 18),
  cardPage([11, 12, 13, 14, 15], 18),
  cardPage([16, 17, 18], 18),
];

/**
 * Карточка, у которой регион не читается ни из лота, ни из адреса организатора.
 *
 * Живой замер: у карточки нет обязательных полей, и панель организатора
 * встречается не всегда. Регион в такой закупке остаётся неопределённым, и это
 * неизвестность, а не «другой регион».
 */
const REGIONLESS_CARD = buildFabrikantCardPage({
  declaredLotCount: 1,
  organizer: null,
  procedurePanels: [
    {
      key: "purchase_section",
      label: "Секция на торговой площадке",
      value: "Коммерческие процедуры",
    },
  ],
  lots: [
    {
      number: 1,
      subject: "Поставка оборудования",
      price: "100 000,00",
      submissionEnd: "15.10.2026 17:00",
    },
  ],
});

const baseQuery: TenderSourceQuery = { laws: ["FZ_223", "COMMERCIAL"], limit: 10 };

function makeAdapter(fetchImpl: typeof fetch, overrides: object = {}) {
  return new FabrikantTenderSourceAdapter({
    rateLimitPerSec: 1000,
    maxRetries: 0,
    timeoutMs: 5000,
    maxPages: 3,
    maxCardPages: 4,
    maxResolves: 40,
    nowProvider: () => FABRIKANT_TEST_NOW,
    fetchImpl,
    ...overrides,
  });
}

/** Обращения к выдаче. */
function searchCalls(calls: readonly StubCall[]): StubCall[] {
  return calls.filter((call) => call.kind === "search");
}

/** Обращения к карточкам процедур. */
function cardCalls(calls: readonly StubCall[]): StubCall[] {
  return calls.filter((call) => call.kind === "card");
}

describe("fabrikantTenderNumber", () => {
  it("снимает префикс внутреннего id и префикс номера в базе", () => {
    expect(fabrikantTenderNumber("fabrikant-5582388")).toBe("5582388");
    expect(fabrikantTenderNumber("FABRIKANT-32616400001")).toBe("32616400001");
  });

  it("голый номер площадки и номер ЕИС проходят без изменений", () => {
    expect(fabrikantTenderNumber("5582388")).toBe("5582388");
    expect(fabrikantTenderNumber("32616400001")).toBe("32616400001");
  });

  it("пустой ключ остаётся пустым: спрашивать площадку нечего", () => {
    expect(fabrikantTenderNumber("  ")).toBe("");
  });
});

describe("FabrikantTenderSourceAdapter.fetchTenders — обход выдачи", () => {
  it("спрашивает выдачу с секциями, статусами и первой страницей", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    await makeAdapter(impl).fetchTenders(baseQuery);

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe(SEARCH_PATH);
    expect(url.searchParams.getAll("section_ids[]")).toEqual(
      FABRIKANT_DEFAULT_SECTIONS.map(String),
    );
    expect(url.searchParams.getAll("statuses[]")).toEqual(FABRIKANT_OPEN_STATUSES.map(String));
    expect(url.searchParams.get("page_number")).toBe("1");
    expect(url.searchParams.get("page_limit")).toBe(String(FABRIKANT_PAGE_LIMIT));
    expect(url.searchParams.get("query")).toBeNull();
  });

  it("не отправляет площадке границы цены: отсев по цене остаётся локальным", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_NO_PRICE_CARD },
    ]);

    const tenders = await makeAdapter(impl).fetchTenders({
      ...baseQuery,
      minPrice: 100_000,
      maxPrice: 5_000_000,
    });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("price_from")).toBeNull();
    expect(url.searchParams.get("price_to")).toBeNull();
    // Закупка без опубликованной цены остаётся: ноль значит «не опубликована»,
    // а серверный фильтр мог бы отбросить её молча — это правило ux-legal не допускает.
    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.financial.price).toBe(0);
  });

  it("идёт на следующую страницу, пока площадка объявляет страницы", async () => {
    const { impl, calls } = stubFetch([
      {
        kind: "search",
        page: 1,
        body: buildFabrikantSearchPage({ cards: [lot(5582388)], total: 80, pages: 2 }),
      },
      { kind: "search", page: 2, body: listing(lot(5582399)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
      { kind: "card", lotId: lotIdOf(5582399), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(searchCalls(calls)).toHaveLength(2);
    expect(tenders.map((tender) => tender.externalId)).toEqual(["5582388", "5582399"]);
    expect(adapter.filterStats.discovered).toBe(2);
  });

  it("останавливается на «По вашему запросу ничего не найдено» и не считает это сбоем", async () => {
    const { impl, calls } = stubFetch([{ kind: "search", body: NO_RESULTS }]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(1);
    expect(tenders).toEqual([]);
    expect(adapter.filterStats.kept).toBe(0);
    expect(adapter.filterStats.rows).toBe(0);
  });

  it("не выходит за предел страниц даже при объявленном продолжении", async () => {
    const pageWithNext = buildFabrikantSearchPage({
      cards: [lot(5582388)],
      total: 400,
      pages: 10,
    });
    const { impl, calls } = stubFetch([
      { kind: "search", page: 1, body: pageWithNext },
      { kind: "search", page: 2, body: pageWithNext },
      { kind: "search", page: 3, body: pageWithNext },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    await makeAdapter(impl, { maxPages: 2 }).fetchTenders(baseQuery);

    expect(searchCalls(calls)).toHaveLength(2);
  });

  it("ключевое слово уходит в поиск площадки в его кодировке", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", query: "насадка", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    await makeAdapter(impl).fetchTenders({ ...baseQuery, keywords: ["насадка"] });

    expect(new URL(calls[0]?.url ?? "").searchParams.get("query")).toBe("насадка");
  });
});

describe("FabrikantTenderSourceAdapter.fetchTenders — карточка и лоты", () => {
  it("каждую процедуру добирает запросом карточки по адресу из строки", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(cardCalls(calls)).toHaveLength(1);
    expect(cardCalls(calls)[0]?.url).toBe(
      `https://fabrikant.ru/v2/trades/procedure/view/${lotIdOf(5582388)}`,
    );
    expect(tenders[0]?.regNumber).toBe("FABRIKANT-5582388");
    expect(tenders[0]?.financial.price).toBe(1_500_000);
    expect(adapter.filterStats.resolved).toBe(1);
    expect(adapter.filterStats.incomplete).toBe(0);
  });

  it("многолотовая процедура собирается со всех страниц карточки", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      ...EIGHTEEN_LOT_PAGES.map((body, index) => ({
        kind: "card" as const,
        lotId: lotIdOf(5582388),
        page: index + 1,
        body,
      })),
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(cardCalls(calls)).toHaveLength(4);
    expect(tenders[0]?.lots).toHaveLength(18);
    expect(tenders[0]?.lots.map((one) => one.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(tenders[0]?.financial.price).toBe(171_000_000);
    expect(adapter.filterStats.incomplete).toBe(0);
  });

  it("предел страниц карточки оставляет набор лотов неполным: цена не публикуется", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      ...EIGHTEEN_LOT_PAGES.map((body, index) => ({
        kind: "card" as const,
        lotId: lotIdOf(5582388),
        page: index + 1,
        body,
      })),
    ]);
    const adapter = makeAdapter(impl, { maxCardPages: 2 });

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(cardCalls(calls)).toHaveLength(2);
    expect(tenders[0]?.lots).toHaveLength(10);
    // Сумма десяти лотов из восемнадцати прошла бы лимит профиля и показала бы
    // владельцу закупку втрое дешевле настоящей.
    expect(tenders[0]?.financial.price).toBe(0);
    expect(adapter.filterStats.incomplete).toBe(1);
  });

  it("закон проверяется до запроса карточки, когда строка его называет", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388, { sectionEnum: "44fz" })) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ laws: ["FZ_223", "COMMERCIAL"], limit: 10 });

    expect(cardCalls(calls)).toHaveLength(0);
    expect(tenders).toEqual([]);
    expect(adapter.filterStats.rejected["закон"]).toBe(1);
  });

  it("строка без слова секции доходит до карточки: закон решает панель", async () => {
    const { impl, calls } = stubFetch([
      // RSC присылает "$undefined" вместо слова секции: живой замер дал 17 таких
      // строк из 40 в секции 223-ФЗ. Отбросить их значило бы молча потерять закупки.
      { kind: "search", body: listing(lot(5582388, { sectionEnum: null })) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_FZ223_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ laws: ["FZ_223"], limit: 10 });

    expect(cardCalls(calls)).toHaveLength(1);
    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.law).toBe("FZ_223");
    expect(tenders[0]?.regNumber).toBe("32616400001");
  });

  it("закон из карточки тоже сверяется с профилем", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582388, { sectionEnum: null })) },
      {
        kind: "card",
        lotId: lotIdOf(5582388),
        body: buildFabrikantCardPage({
          declaredLotCount: 1,
          eisNumber: "0344300000026000001",
          procedurePanels: [
            { key: "purchase_section", label: "Секция на торговой площадке", value: "Закупки по 44-ФЗ" },
          ],
          lots: [
            {
              number: 1,
              subject: "Поставка оборудования",
              price: "100 000,00",
              submissionEnd: "15.10.2026 17:00",
              deliveryRegion: "Республика Татарстан",
            },
          ],
        }),
      },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ laws: ["FZ_223"], limit: 10 });

    expect(tenders).toEqual([]);
    expect(adapter.filterStats.rejected["закон"]).toBe(1);
  });

  it("одна процедура из двух ключевых слов запрашивается один раз", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", query: "соль", body: listing(lot(5582388)) },
      { kind: "search", query: "склад", body: listing(lot(5582388, { lotId: Number(lotIdOf(5582388)) + 1 })) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    const tenders = await makeAdapter(impl).fetchTenders({
      ...baseQuery,
      keywords: ["соль", "склад"],
    });

    expect(searchCalls(calls)).toHaveLength(2);
    expect(cardCalls(calls)).toHaveLength(1);
    expect(tenders).toHaveLength(1);
  });

  it("процедуры без номера ЕИС осматриваются первыми", async () => {
    const { impl, calls } = stubFetch([
      {
        kind: "search",
        body: listing(
          lot(5582378, { purchaseOosNumber: "32616433843", sectionEnum: "223fz" }),
          lot(5582399),
        ),
      },
      { kind: "card", lotId: lotIdOf(5582378), body: FABRIKANT_FZ223_CARD },
      { kind: "card", lotId: lotIdOf(5582399), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl, { maxResolves: 1 });

    const tenders = await adapter.fetchTenders(baseQuery);

    // Закупку с номером ЕИС принесёт адаптер реестра, и приоритет источника всё
    // равно оставит его версию: тратить на неё единственный запрос карточки значит
    // остаться без коммерческих закупок, которых в реестре нет вовсе.
    expect(cardCalls(calls).map((call) => call.lotId)).toEqual([lotIdOf(5582399)]);
    expect(tenders.map((tender) => tender.regNumber)).toEqual(["FABRIKANT-5582399"]);
    expect(adapter.filterStats.discovered).toBe(2);
    expect(adapter.filterStats.withEisNumber).toBe(1);
    expect(adapter.filterStats.resolveLimitReached).toBe(true);
  });
});

describe("FabrikantTenderSourceAdapter.fetchTenders — отсев", () => {
  it("несколько лотов одной процедуры в выдаче дают один запрос карточки", async () => {
    // Строка выдачи — это лот, а не закупка: живой замер 02.10.2026 дал 40 строк
    // на 24 процедуры. Номера в строке нет только у приманки, и её парсер не
    // отдаёт вовсе, поэтому группировка по номеру покрывает каждую строку.
    const { impl, calls } = stubFetch([
      {
        kind: "search",
        body: listing(
          lot(5582388, { lotId: 11, sequenceNumber: 1 }),
          lot(5582388, { lotId: 12, sequenceNumber: 2 }),
          lot(5582399, { lotId: 21, sequenceNumber: 1 }),
        ),
      },
      { kind: "card", lotId: "11", body: FABRIKANT_COMMERCIAL_CARD },
      { kind: "card", lotId: "12", body: FABRIKANT_COMMERCIAL_CARD },
      { kind: "card", lotId: "21", body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(adapter.filterStats.rows).toBe(3);
    expect(adapter.filterStats.discovered).toBe(2);
    // Карточка запрашивается по адресу первой строки группы: все строки одной
    // процедуры ведут на одну и ту же карточку, различаясь только номером лота.
    expect(cardCalls(calls).map((call) => call.lotId)).toEqual(["11", "21"]);
    expect(tenders.map((tender) => tender.externalId)).toEqual(["5582388", "5582399"]);
  });

  it("строка без адреса карточки не доходит до запроса", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388, { url: null }), lot(5582399)) },
      { kind: "card", lotId: lotIdOf(5582399), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(cardCalls(calls)).toHaveLength(1);
    expect(tenders.map((tender) => tender.externalId)).toEqual(["5582399"]);
    expect(adapter.filterStats.droppedRows["нет адреса карточки"]).toBe(1);
  });

  it("карточка «Маркета» пропускается со своим счётчиком", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388, { url: MARKET_CARD_URL })) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(cardCalls(calls)).toHaveLength(0);
    expect(tenders).toEqual([]);
    expect(adapter.filterStats.droppedRows["карточка на «Маркете»: другой хост и путь"]).toBe(1);
  });

  it("строка, ведущая в ЕИС, считается отдельно: это не потеря", async () => {
    // То же извещение приносит адаптер реестра, и с документами. Общая причина
    // «карточка вне публичного хоста» сказала бы владельцу, что Фабрикант
    // потерял закупку, которой у него и так нет в одиночку.
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388, { url: EIS_ROW_URL })) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(cardCalls(calls)).toHaveLength(0);
    expect(tenders).toEqual([]);
    expect(
      adapter.filterStats.droppedRows["строка ведёт в ЕИС — закупку приносит адаптер реестра"],
    ).toBe(1);
    expect(adapter.filterStats.droppedRows["карточка на «Маркете»: другой хост и путь"]).toBe(
      undefined,
    );
  });

  it("карточка, которую не удалось разобрать, видна в статистике", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_SPARSE_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(tenders).toEqual([]);
    expect(adapter.filterStats.resolved).toBe(1);
    expect(adapter.filterStats.rejected["карточка не разобрана"]).toBe(1);
  });

  it("просроченный срок приёма заявок отсеивается по карточке", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: cardPage([1], 1, "20.09.2026 12:00") },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(tenders).toEqual([]);
    expect(adapter.filterStats.rejected["срок приёма заявок истёк"]).toBe(1);
  });

  it("нечитаемый срок просрочкой не считается", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: cardPage([1], 1, "дата уточняется") },
    ]);

    const tenders = await makeAdapter(impl).fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
  });

  it("регион профиля отсекает чужой субъект", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, regions: ["Самарская область"] });

    expect(tenders).toEqual([]);
    expect(adapter.filterStats.rejected["регион"]).toBe(1);
  });

  it("неопределённый регион — это неизвестность, а не «другой регион»", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582399)) },
      { kind: "card", lotId: lotIdOf(5582399), body: REGIONLESS_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, regions: ["Татарстан"] });

    expect(tenders).toEqual([]);
    expect(adapter.filterStats.rejected["регион не определён"]).toBe(1);
  });

  it("без фильтра по региону закупка с неопределённым регионом остаётся", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582399)) },
      { kind: "card", lotId: lotIdOf(5582399), body: REGIONLESS_CARD },
    ]);

    const tenders = await makeAdapter(impl).fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.region).toBe(UNKNOWN_REGION);
  });

  it("лимит цены не отсекает закупку, цена которой не опубликована", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_NO_PRICE_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, minPrice: 1_000_000 });

    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.financial.price).toBe(0);
  });

  it("цена вне лимита отсекается локально", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, maxPrice: 100_000 });

    expect(tenders).toEqual([]);
    expect(adapter.filterStats.rejected["цена"]).toBe(1);
  });

  it("ИНН заказчика сверяется локально: поиск площадки его не принимает", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, customerInns: ["7707083893"] });

    expect(tenders).toEqual([]);
    expect(adapter.filterStats.rejected["заказчик"]).toBe(1);
  });

  it("limit обрезает выдачу и не тратит запросы карточек зря", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388), lot(5582399), lot(5582400)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
      { kind: "card", lotId: lotIdOf(5582399), body: FABRIKANT_COMMERCIAL_CARD },
      { kind: "card", lotId: lotIdOf(5582400), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, limit: 2 });

    expect(tenders).toHaveLength(2);
    expect(cardCalls(calls)).toHaveLength(2);
    expect(adapter.filterStats.discovered).toBe(3);
  });

  it("предел запросов карточек виден в статистике", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388), lot(5582399)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
      { kind: "card", lotId: lotIdOf(5582399), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl, { maxResolves: 1 });

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(cardCalls(calls)).toHaveLength(1);
    expect(tenders).toHaveLength(1);
    expect(adapter.filterStats.resolved).toBe(1);
    expect(adapter.filterStats.resolveLimitReached).toBe(true);
  });
});

describe("FabrikantTenderSourceAdapter.fetchTenders — отказы площадки", () => {
  it("HTTP-код ошибки повторяет запрос и после повторов падает", async () => {
    const { impl, calls } = stubFetch([{ kind: "search", body: "", status: 503 }]);
    const adapter = makeAdapter(impl, { maxRetries: 2 });

    await expect(adapter.fetchTenders(baseQuery)).rejects.toBeInstanceOf(FabrikantResponseError);
    expect(calls).toHaveLength(3);
  });

  it("страница антибота вместо выдачи — это ошибка, а не ноль закупок", async () => {
    const { impl } = stubFetch([{ kind: "search", body: ANTI_BOT_PAGE }]);

    await expect(makeAdapter(impl).fetchTenders(baseQuery)).rejects.toBeInstanceOf(
      FabrikantResponseError,
    );
  });

  it("страница антибота вместо карточки — тоже ошибка", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: ANTI_BOT_PAGE },
    ]);

    await expect(makeAdapter(impl).fetchTenders(baseQuery)).rejects.toBeInstanceOf(
      FabrikantResponseError,
    );
    expect(cardCalls(calls)).toHaveLength(1);
  });

  it("пустое тело повторяется: это сбой транспорта, а не ответ площадки", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: ["   ", listing(lot(5582388))] },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    const tenders = await makeAdapter(impl, { maxRetries: 2 }).fetchTenders(baseQuery);

    expect(tenders).toHaveLength(1);
    expect(searchCalls(calls)).toHaveLength(2);
  });

  it("страница с ограниченным доступом принимается как ответ, а не повторяется", async () => {
    const { impl, calls } = stubFetch([{ kind: "search", query: "МФУ", body: RESTRICTED_PAGE }]);
    const adapter = makeAdapter(impl, { maxRetries: 2 });

    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["МФУ"] });

    expect(tenders).toEqual([]);
    // Ответ исправен, поэтому повторы на него тратить нельзя: живой прогон
    // 02.10.2026 сделал три запроса одной и той же страницы и упал.
    expect(searchCalls(calls)).toHaveLength(1);
    expect(adapter.filterStats.restrictedKeywords).toBe(1);
  });

  it("отказ площадки по одному слову не уносит выдачу остальных слов", async () => {
    const { impl } = stubFetch([
      { kind: "search", query: "МФУ", body: RESTRICTED_PAGE },
      { kind: "search", query: "принтер", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      ...baseQuery,
      keywords: ["МФУ", "принтер"],
    });

    expect(tenders).toHaveLength(1);
    expect(adapter.filterStats.restrictedKeywords).toBe(1);
    expect(adapter.filterStats.failedKeywords).toBe(0);
  });

  it("сбой запроса по одному слову не уносит выдачу остальных, но виден в статистике", async () => {
    const { impl } = stubFetch([
      { kind: "search", query: "принтер", body: ANTI_BOT_PAGE },
      { kind: "search", query: "сервер", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      ...baseQuery,
      keywords: ["принтер", "сервер"],
    });

    expect(tenders).toHaveLength(1);
    expect(adapter.filterStats.failedKeywords).toBe(1);
    expect(adapter.filterStats.rows).toBe(1);
  });

  it("когда не ответило ни одно слово, вызов падает: это сбой источника, а не пустота", async () => {
    // Молча вернуть пустой список значило бы напечатать в журнале «найдено 0»
    // вместо причины: профиль без единого ответа площадки и профиль, по которому
    // у площадки действительно ничего нет, выглядят одинаково.
    const { impl } = stubFetch([
      { kind: "search", query: "принтер", body: ANTI_BOT_PAGE },
      { kind: "search", query: "сервер", body: ANTI_BOT_PAGE },
    ]);

    await expect(
      makeAdapter(impl).fetchTenders({ ...baseQuery, keywords: ["принтер", "сервер"] }),
    ).rejects.toBeInstanceOf(FabrikantResponseError);
  });
});

describe("FabrikantTenderSourceAdapter.fetchTenderById", () => {
  it("находит процедуру по номеру площадки и возвращает её с лотами", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", query: "5582388", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    const tender = await makeAdapter(impl).fetchTenderById("fabrikant-5582388");

    expect(tender?.regNumber).toBe("FABRIKANT-5582388");
    expect(tender?.financial.price).toBe(1_500_000);
    expect(searchCalls(calls)).toHaveLength(1);
  });

  it("находит процедуру по номеру ЕИС: площадка ищет и по нему", async () => {
    // Зонд 02.10.2026: `query=32616433843` вернул ровно одну строку процедуры
    // 5582378. Без этого номер, который мы положили в базу как ключ записи,
    // нельзя было бы обратно спросить у площадки.
    const { impl } = stubFetch([
      {
        kind: "search",
        query: "32616400001",
        body: listing(lot(5582378, { purchaseOosNumber: "32616400001", sectionEnum: "223fz" })),
      },
      { kind: "card", lotId: lotIdOf(5582378), body: FABRIKANT_FZ223_CARD },
    ]);

    const tender = await makeAdapter(impl).fetchTenderById("32616400001");

    expect(tender?.regNumber).toBe("32616400001");
    expect(tender?.law).toBe("FZ_223");
  });

  it("запрос по номеру не несёт секций и статусов: закрытая процедура тоже находится", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", query: "5582388", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    await makeAdapter(impl).fetchTenderById("5582388");

    const url = new URL(searchCalls(calls)[0]?.url ?? "");
    expect(url.searchParams.getAll("section_ids[]")).toEqual([]);
    expect(url.searchParams.getAll("statuses[]")).toEqual([]);
    expect(url.searchParams.get("query")).toBe("5582388");
  });

  it("чужая процедура в ответе на номер даёт null, а не чужую закупку", async () => {
    // `query` у площадки — подстрока, а не точное совпадение: на номер 5582388
    // она может ответить строкой 55823880. Подставить её значило бы показать
    // карточку чужой закупки.
    const { impl, calls } = stubFetch([
      { kind: "search", query: "5582388", body: listing(lot(55823880)) },
    ]);

    expect(await makeAdapter(impl).fetchTenderById("5582388")).toBeNull();
    expect(cardCalls(calls)).toHaveLength(0);
  });

  it("номер, которого площадка не вернула, даёт null", async () => {
    const { impl } = stubFetch([{ kind: "search", query: "9999999", body: NO_RESULTS }]);

    expect(await makeAdapter(impl).fetchTenderById("9999999")).toBeNull();
  });

  it("пустой ключ не уходит в запрос", async () => {
    const { impl, calls } = stubFetch([]);

    expect(await makeAdapter(impl).fetchTenderById("  ")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("FabrikantTenderSourceAdapter.fetchDocuments", () => {
  it("документов нет, и запрос к площадке не делается", async () => {
    const { impl, calls } = stubFetch([]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchDocuments("fabrikant-5582388")).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("FabrikantTenderSourceAdapter.checkChanges", () => {
  it("сдвинутый срок приёма заявок — это изменение", async () => {
    const { impl } = stubFetch([
      { kind: "search", query: "5582388", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    await expect(
      makeAdapter(impl).checkChanges("fabrikant-5582388", "2026-10-01T00:00:00.000Z"),
    ).resolves.toBe(true);
  });

  it("тот же срок изменения не даёт", async () => {
    const { impl } = stubFetch([
      { kind: "search", query: "5582388", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    await expect(
      makeAdapter(impl).checkChanges("fabrikant-5582388", "2026-10-12T14:00:00.000Z"),
    ).resolves.toBe(false);
  });

  it("процедура пропала из выдачи — изменений нет", async () => {
    const { impl } = stubFetch([{ kind: "search", query: "5582388", body: NO_RESULTS }]);

    await expect(
      makeAdapter(impl).checkChanges("fabrikant-5582388", "2026-10-01T00:00:00.000Z"),
    ).resolves.toBe(false);
  });

  it("нечитаемая отметка не даёт выдуманного ответа и не тратит запрос", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", query: "5582388", body: listing(lot(5582388)) },
    ]);

    await expect(makeAdapter(impl).checkChanges("fabrikant-5582388", "не дата")).resolves.toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("FabrikantTenderSourceAdapter.filterStats", () => {
  it("различает «площадка ничего не отдала» и «мы отбросили»", async () => {
    const { impl } = stubFetch([
      {
        kind: "search",
        body: listing(
          lot(5582388, { url: null }),
          lot(5582401, { url: MARKET_CARD_URL }),
          lot(5582399, { sectionEnum: "44fz" }),
          lot(5582400),
        ),
      },
      { kind: "card", lotId: lotIdOf(5582400), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, regions: ["Самарская область"] });

    const stats = adapter.filterStats;
    expect(tenders).toEqual([]);
    expect(stats.rows).toBe(4);
    expect(stats.discovered).toBe(2);
    expect(stats.withEisNumber).toBe(0);
    expect(stats.droppedRows["нет адреса карточки"]).toBe(1);
    expect(stats.droppedRows["карточка на «Маркете»: другой хост и путь"]).toBe(1);
    expect(stats.rejected["закон"]).toBe(1);
    expect(stats.rejected["регион"]).toBe(1);
    expect(stats.resolved).toBe(1);
    expect(stats.kept).toBe(0);
  });

  it("статистика сбрасывается между прогонами", async () => {
    const { impl } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders(baseQuery);
    expect(adapter.filterStats.kept).toBe(1);

    await adapter.fetchTenders(baseQuery);
    expect(adapter.filterStats.rows).toBe(1);
    expect(adapter.filterStats.kept).toBe(1);
  });

  it("сорвавшийся вызов не выдаёт числа предыдущего профиля за свои", async () => {
    // Прогон идёт одним адаптером по нескольким профилям. Если второй профиль
    // упал, а `filterStats` всё ещё хранит числа первого, журнал печатает чужую
    // выдачу под заголовком профиля, который не дал ничего, — ровно та подмена
    // причины, против которой написан итог по источникам в `sync-eis.ts`.
    const { impl } = stubFetch([
      { kind: "search", body: [listing(lot(5582388)), ANTI_BOT_PAGE] },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders(baseQuery);
    expect(adapter.filterStats.kept).toBe(1);

    await expect(adapter.fetchTenders(baseQuery)).rejects.toBeInstanceOf(FabrikantResponseError);
    expect(adapter.filterStats.rows).toBe(0);
    expect(adapter.filterStats.kept).toBe(0);
    expect(adapter.filterStats.resolved).toBe(0);
  });

  it("адрес площадки настраивается: прогон может идти через тестовый хост", async () => {
    const { impl, calls } = stubFetch([
      { kind: "search", body: listing(lot(5582388)) },
      { kind: "card", lotId: lotIdOf(5582388), body: FABRIKANT_COMMERCIAL_CARD },
    ]);

    await makeAdapter(impl, { baseUrl: "https://fabrikant.test" }).fetchTenders(baseQuery);

    expect(calls[0]?.url.startsWith("https://fabrikant.test/procedure/search/purchases?")).toBe(
      true,
    );
  });
});
