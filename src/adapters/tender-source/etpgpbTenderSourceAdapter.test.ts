import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tender } from "@/domain/entities";
import type { TenderSourceQuery } from "@/adapters/types";
import {
  ETPGPB_CARD_COMMERCE,
  ETPGPB_CARD_ETP_CLICK,
  ETPGPB_CARD_ETP_EIS11,
  ETPGPB_CARD_ETP_PRICE_UNKNOWN,
  ETPGPB_CARD_GAZ_EIS_URL,
  ETPGPB_CARD_SALE,
} from "@/adapters/tender-source/etpgpbCardFixtures";
import { createEtpgpbCardCache } from "@/adapters/tender-source/etpgpbCache";
import {
  ETPGPB_NOW,
  FILLER_OLD,
  LASTMOD,
  PROCEDURES_SITEMAP_URL,
  PROCEDURES_SITEMAP_XML,
  SITEMAP_INDEX_URL,
  SITEMAP_INDEX_XML,
  SYNTHETIC_CONTACT_PATTERN,
  chunkUrl,
  nuxtPage,
  standardRoutes,
  stubFetch,
  urlset,
  withSyntheticContacts,
  type StubReply,
} from "@/adapters/tender-source/etpgpbTestFixtures";
import {
  EtpgpbBlockedError,
  EtpgpbTenderSourceAdapter,
  etpgpbCardTtlMs,
  type EtpgpbAdapterOptions,
} from "@/adapters/tender-source/etpgpbTenderSourceAdapter";
import { EtpgpbUrlNotAllowedError, isEtpgpbUrlAllowed } from "@/adapters/tender-source/etpgpbUrl";
import { parseEtpgpbCard } from "@/adapters/tender-source/etpgpbCard";
import { mapEtpgpbCard } from "@/adapters/tender-source/etpgpbMapper";

const HOUR = 60 * 60 * 1000;
const baseQuery: TenderSourceQuery = { laws: ["FZ_223", "COMMERCIAL"], limit: 50 };

const URLS = {
  click: ETPGPB_CARD_ETP_CLICK.url,
  eis11: ETPGPB_CARD_ETP_EIS11.url,
  priceUnknown: ETPGPB_CARD_ETP_PRICE_UNKNOWN.url,
  gaz: ETPGPB_CARD_GAZ_EIS_URL.url,
  commerce: ETPGPB_CARD_COMMERCE.url,
  sale: ETPGPB_CARD_SALE.url,
} as const;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "etpgpb-adapter-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeAdapter(fetchImpl: typeof fetch, overrides: EtpgpbAdapterOptions = {}) {
  const sleeps: number[] = [];
  const clock = { now: ETPGPB_NOW };
  const adapter = new EtpgpbTenderSourceAdapter({
    minIntervalMs: 0,
    maxRetries: 0,
    timeoutMs: 5000,
    nowProvider: () => new Date(clock.now),
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl,
    ...overrides,
  });
  return { adapter, sleeps, clock };
}

const cardUrls = (urls: readonly string[]): string[] => urls.filter((url) => url.startsWith("https://etpgpb.ru/procedures/"));
const regNumbers = (tenders: readonly Tender[]): string[] => tenders.map((t) => t.regNumber);

describe("fetchTenders: основной поток", () => {
  it("карта сайта → слово в адресе → карточки от свежих к старым → закупки", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    // Самые свежие по <lastmod> первыми: etp_click 19:23, 11-значный 18:32, цена не указана 15:28.
    expect(regNumbers(tenders)).toEqual(["ETPGPB-17793", "32616467295", "ETPGPB-АП125184"]);
    expect(tenders.every((t) => t.dataSource === "ETP_GPB")).toBe(true);

    expect(stub.urls()).toEqual([
      SITEMAP_INDEX_URL,
      PROCEDURES_SITEMAP_URL,
      // Куски: самый свежий по дате первым. Кусок 58 вне окна, 1–3 старые — не запрашиваются.
      chunkUrl(60),
      chunkUrl(59),
      URLS.click,
      URLS.eis11,
      URLS.priceUnknown,
      URLS.gaz,
    ]);

    const stats = adapter.filterStats;
    expect(stats.sitemap).toMatchObject({ source: "сеть", chunks: 2, downloaded: 2, cached: 0, failed: 0 });
    // В окне 7 процедур (без sale и без записи старше 21 дня), по слову подошли 4.
    expect(stats).toMatchObject({ window: 7, candidates: 4, fetched: 4, cached: 0, kept: 3, failed: 0, deferred: 0 });
    // Газ: приём заявок закончился (этап «commission»).
    expect(stats.rejected).toEqual({ "приём заявок не идёт": 1 });
    expect(stats.budgetReached).toBeNull();
    expect(stats.blocked).toBeNull();
  });

  it("ни один запрос не содержит query-строки и не выходит за разрешённый набор адресов", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    await adapter.fetchTenders({ ...baseQuery, keywords: [] });
    await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"], regions: ["Бурятия"], minPrice: 1 });
    await adapter.fetchTenderById(URLS.eis11);

    expect(stub.calls.length).toBeGreaterThan(5);
    for (const call of stub.calls) {
      expect(call.url, call.url).not.toContain("?");
      expect(isEtpgpbUrlAllowed(call.url), call.url).toBe(true);
      expect(new URL(call.url).hostname).toBe("etpgpb.ru");
      // Редиректы разбираем сами: каждый шаг проходит проверку адреса.
      expect(call.init.redirect).toBe("manual");
    }
  });

  it("потолок числа кусков карты: лишние не качаются, но их число видно в статистике", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl, { maxChunks: 1 });
    await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(stub.urls().filter((url) => url.includes("/sitemap/procedures/"))).toEqual([chunkUrl(60)]);
    expect(adapter.filterStats.sitemap).toMatchObject({ chunks: 1, skipped: 1, downloaded: 1 });
  });

  it("заголовки как у остальных адаптеров: браузерный User-Agent, без cookie и авторизации", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    await adapter.fetchTenders({ ...baseQuery, keywords: ["поддон"] });
    const headers = stub.calls[0]?.init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/^Mozilla\/5\.0 .*Chrome\/120 Safari\/537\.36$/);
    expect(headers["Accept-Language"]).toBe("ru-RU,ru;q=0.9");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(["cookie", "authorization"]));
  });

  it("продажа имущества (sale) и запись старше окна не запрашиваются даже без ключевых слов", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);

    await adapter.fetchTenders({ ...baseQuery, keywords: [] });

    const requested = cardUrls(stub.urls());
    expect(requested).not.toContain(URLS.sale);
    expect(requested.some((url) => url.includes("/procedures/sale/"))).toBe(false);
    expect(requested).not.toContain(FILLER_OLD.url);
    // Остальные семь процедур окна запрошены, новейшие первыми.
    expect(requested).toHaveLength(7);
    expect(requested.slice(0, 4)).toEqual([URLS.click, URLS.eis11, URLS.priceUnknown, URLS.gaz]);
  });

  it("слово без совпадений в адресах — ни одного запроса карточки", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["экскаватор"] });
    expect(tenders).toEqual([]);
    expect(cardUrls(stub.urls())).toEqual([]);
    expect(adapter.filterStats).toMatchObject({ window: 7, candidates: 0, fetched: 0 });
  });

  it("площадка отдала по адресу страницу другой процедуры — она не принимается за запрошенную", async () => {
    const stub = stubFetch({ ...standardRoutes(), [URLS.commerce]: nuxtPage(ETPGPB_CARD_ETP_CLICK.table) });
    const { adapter } = makeAdapter(stub.impl);
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поддон"] });
    expect(tenders).toEqual([]);
    expect(adapter.filterStats.rejected).toEqual({ "карточка не разобрана": 1 });
  });

  it("закон: коммерческая закупка не проходит запрос только про 223-ФЗ", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    const tenders = await adapter.fetchTenders({ laws: ["FZ_223"], keywords: ["поставк"] });
    expect(regNumbers(tenders)).toEqual(["32616467295"]);
    expect(adapter.filterStats.rejected["закон"]).toBe(2);
  });

  it("activeOnly: false оставляет и закрытые процедуры", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl, { activeOnly: false });
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(regNumbers(tenders)).toContain("32616379968");
  });

  it("срок приёма заявок в прошлом — процедура отброшена, даже если площадка пишет «приём»", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter, clock } = makeAdapter(stub.impl);
    // 23.10.2026 12:00 МСК: у etp_click срок 20.10, у 11-значного 23.10 03:00, у «цена не указана» 23.10 12:00.
    clock.now = Date.parse("2026-10-23T09:00:00.000Z");
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(tenders).toEqual([]);
    expect(adapter.filterStats.rejected["срок приёма заявок истёк"]).toBe(3);
  });
});

describe("карта сайта скачивается один раз", () => {
  it("несколько вызовов подряд (профили и слова) делят одну загрузку и одни и те же карточки", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);

    await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    const afterFirst = stub.calls.length;
    await adapter.fetchTenders({ ...baseQuery, keywords: ["поддон"] });
    await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк", "строительств"] });
    await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"], regions: ["Бурятия"] });

    const urls = stub.urls();
    expect(urls.filter((url) => url === SITEMAP_INDEX_URL)).toHaveLength(1);
    expect(urls.filter((url) => url === PROCEDURES_SITEMAP_URL)).toHaveLength(1);
    expect(urls.filter((url) => url === chunkUrl(60))).toHaveLength(1);
    expect(urls.filter((url) => url === chunkUrl(59))).toHaveLength(1);
    // Карточки, прочитанные первым вызовом, второй и четвёртый берут из памяти прогона.
    for (const url of [URLS.click, URLS.eis11, URLS.priceUnknown, URLS.gaz]) {
      expect(urls.filter((u) => u === url), url).toHaveLength(1);
    }
    // Новые запросы — только карточки, которых ещё не было (commerce и заглушки по слову «строительств»).
    expect(stub.calls.slice(afterFirst).every((call) => !call.url.includes("sitemap"))).toBe(true);
    expect(adapter.filterStats.sitemap.source).toBe("память");
  });

  it("неудачная загрузка карты не запоминается: следующий вызов пробует снова", async () => {
    let attempts = 0;
    const routes = standardRoutes();
    const stub = stubFetch({
      ...routes,
      [SITEMAP_INDEX_URL]: () => {
        attempts += 1;
        return attempts === 1 ? 503 : SITEMAP_INDEX_XML;
      },
    });
    const { adapter } = makeAdapter(stub.impl);
    await expect(adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] })).rejects.toThrow(/HTTP 503/);
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(tenders.length).toBeGreaterThan(0);
    expect(attempts).toBe(2);
  });
});

describe("потолки запросов карточек", () => {
  it("на вызов: после предела карточки не читаются, число неосмотренных видно в статистике", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl, { maxCardsPerCall: 2 });

    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    expect(regNumbers(tenders)).toEqual(["ETPGPB-17793", "32616467295"]);
    expect(cardUrls(stub.urls())).toEqual([URLS.click, URLS.eis11]);
    expect(adapter.filterStats).toMatchObject({ fetched: 2, deferred: 2, budgetReached: "на вызов", kept: 2 });
  });

  it("на прогон: потолок общий для всех вызовов, а прочитанное остаётся доступным из памяти", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl, { maxCardsPerRun: 3 });

    const first = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(regNumbers(first)).toEqual(["ETPGPB-17793", "32616467295", "ETPGPB-АП125184"]);
    expect(adapter.filterStats).toMatchObject({ fetched: 3, deferred: 1, budgetReached: "на прогон" });

    // Второй вызов хочет карточку commerce, которой нет, а бюджет исчерпан: запроса нет.
    const second = await adapter.fetchTenders({ ...baseQuery, keywords: ["поддон"] });
    expect(second).toEqual([]);
    expect(adapter.filterStats).toMatchObject({ fetched: 0, deferred: 1, budgetReached: "на прогон" });
    expect(stub.urls()).not.toContain(URLS.commerce);

    // Третий вызов — те же слова, что у первого: всё из памяти, бюджет не нужен.
    const third = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(regNumbers(third)).toEqual(regNumbers(first));
    // Газовая карточка так и не прочитана — бюджет вышел раньше; остальные три — из памяти.
    expect(adapter.filterStats).toMatchObject({ fetched: 0, memoized: 3, deferred: 1, budgetReached: "на прогон" });
    expect(adapter.cardRequestsMade).toBe(3);
  });

  it("configureBudgets меняет потолки; нечисло и ноль игнорируются", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    adapter.configureBudgets({ perCall: 1 });
    adapter.configureBudgets({ perCall: 0, perRun: Number.NaN });
    await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(adapter.filterStats.fetched).toBe(1);
  });

  it("кэш на диске бюджет не тратит: прочитанные раньше карточки читаются без запроса", async () => {
    const first = makeAdapter(stubFetch(standardRoutes()).impl, { cacheDir: dir });
    await first.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    const stub = stubFetch(standardRoutes());
    const second = makeAdapter(stub.impl, { cacheDir: dir, maxCardsPerCall: 1, maxCardsPerRun: 1 });
    const tenders = await second.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    expect(regNumbers(tenders)).toEqual(["ETPGPB-17793", "32616467295", "ETPGPB-АП125184"]);
    expect(cardUrls(stub.urls())).toEqual([]);
    expect(second.adapter.filterStats).toMatchObject({ fetched: 0, cached: 4, deferred: 0, budgetReached: null });
  });
});

describe("лимит считается после локальных фильтров", () => {
  it("региональный профиль идёт по кандидатам, пока не наберёт лимит, и останавливается на нём", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"], regions: ["Бурятия"], limit: 1 });

    // Первый кандидат (Астрахань) не прошёл по региону — но лимит 1 не исчерпан, обход идёт дальше.
    expect(regNumbers(tenders)).toEqual(["32616467295"]);
    expect(tenders[0]?.region).toBe("Республика Бурятия");
    // Лимит набран на втором кандидате: остальные карточки не запрошены.
    expect(cardUrls(stub.urls())).toEqual([URLS.click, URLS.eis11]);
    expect(adapter.filterStats.rejected).toEqual({ регион: 1 });
  });

  it("лимит ограничивает выдачу и без региона", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"], limit: 2 });
    expect(regNumbers(tenders)).toEqual(["ETPGPB-17793", "32616467295"]);
    expect(cardUrls(stub.urls())).toEqual([URLS.click, URLS.eis11]);
  });

  it("нулевой лимит — пустая выдача без запросов карточек", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    expect(await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"], limit: 0 })).toEqual([]);
    expect(cardUrls(stub.urls())).toEqual([]);
  });
});

describe("локальные фильтры по прочитанной карточке", () => {
  /** Закупка для подсева кэша: карточка не читается, а фильтры работают по ней. */
  function seeded(overrides: Partial<Tender>): Tender {
    const card = parseEtpgpbCard(nuxtPage(ETPGPB_CARD_ETP_EIS11.table), ETPGPB_CARD_ETP_EIS11.url);
    const base = mapEtpgpbCard(card!)!;
    return { ...base, ...overrides, financial: { ...base.financial, ...(overrides.financial ?? {}) } };
  }

  async function run(tender: Tender, query: Partial<TenderSourceQuery>, options: EtpgpbAdapterOptions = {}) {
    const lastmodMs = Date.parse(LASTMOD.etpEis11);
    const cache = createEtpgpbCardCache({ dir });
    cache.set(URLS.eis11, { lastmodMs, fetchedAt: ETPGPB_NOW, accepting: true, tender });
    cache.flush(ETPGPB_NOW);
    const stub = stubFetch({
      [SITEMAP_INDEX_URL]: SITEMAP_INDEX_XML,
      [PROCEDURES_SITEMAP_URL]: PROCEDURES_SITEMAP_XML,
      [chunkUrl(60)]: urlset([{ url: URLS.eis11, lastmod: LASTMOD.etpEis11 }]),
      [chunkUrl(59)]: urlset([]),
    });
    const { adapter } = makeAdapter(stub.impl, { cacheDir: dir, ...options });
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"], ...query });
    expect(cardUrls(stub.urls())).toEqual([]);
    return { tenders, stats: adapter.filterStats };
  }

  it("цена: границы профиля применяются, неизвестная цена лимитом не отсекается", async () => {
    expect((await run(seeded({}), { minPrice: 3_000_000 })).stats.rejected).toEqual({ цена: 1 });
    expect((await run(seeded({}), { maxPrice: 1_000_000 })).stats.rejected).toEqual({ цена: 1 });
    expect((await run(seeded({}), { minPrice: 1_000_000, maxPrice: 3_000_000 })).tenders).toHaveLength(1);
    const unknown = seeded({ financial: { price: 0 } as Tender["financial"] });
    expect((await run(unknown, { minPrice: 3_000_000 })).tenders).toHaveLength(1);
    expect((await run(unknown, { maxPrice: 1_000_000 })).tenders).toHaveLength(1);
  });

  it("регион: подстрока без регистра; чужой — «регион»; неопределённый — отдельная причина", async () => {
    expect((await run(seeded({}), { regions: ["бурятия"] })).tenders).toHaveLength(1);
    expect((await run(seeded({}), { regions: ["Томская", "Республика Бурятия"] })).tenders).toHaveLength(1);
    expect((await run(seeded({}), { regions: ["Иркутская"] })).stats.rejected).toEqual({ регион: 1 });
    const unknown = seeded({ region: "Не указан" });
    expect((await run(unknown, { regions: ["Бурятия"] })).stats.rejected).toEqual({ "регион не определён": 1 });
    // Без региона в профиле неопределённый регион не мешает.
    expect((await run(unknown, {})).tenders).toHaveLength(1);
  });

  it("заказчик: только из списка ИНН профиля", async () => {
    expect((await run(seeded({}), { customerInns: ["0323054162"] })).tenders).toHaveLength(1);
    expect((await run(seeded({}), { customerInns: ["7700000000"] })).stats.rejected).toEqual({ заказчик: 1 });
    expect((await run(seeded({ customerInn: null }), { customerInns: ["0323054162"] })).stats.rejected).toEqual({ заказчик: 1 });
  });

  it("название из кэша проверяется по слову: slug мог совпасть случайно", async () => {
    const other = seeded({ subject: "Совсем другое название" });
    expect((await run(other, {})).stats.rejected).toEqual({ "название не подходит под слово": 1 });
  });

  it("срок: нет даты — «не указан», прошла — «истёк»", async () => {
    const none = seeded({ deadlines: { ...seeded({}).deadlines, submissionEnd: "" } });
    expect((await run(none, {})).stats.rejected).toEqual({ "срок приёма заявок не указан": 1 });
    const past = seeded({ deadlines: { ...seeded({}).deadlines, submissionEnd: "2026-10-18T00:00:00.000Z" } });
    expect((await run(past, {})).stats.rejected).toEqual({ "срок приёма заявок истёк": 1 });
  });
});

describe("кэш на диске между прогонами", () => {
  it("второй прогон не качает ни куски карты, ни карточки: только индекс и список кусков", async () => {
    const firstStub = stubFetch(standardRoutes());
    const first = makeAdapter(firstStub.impl, { cacheDir: dir });
    const before = await first.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    const stub = stubFetch(standardRoutes());
    const second = makeAdapter(stub.impl, { cacheDir: dir });
    const after = await second.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    expect(stub.urls()).toEqual([SITEMAP_INDEX_URL, PROCEDURES_SITEMAP_URL]);
    expect(regNumbers(after)).toEqual(regNumbers(before));
    expect(second.adapter.filterStats.sitemap).toMatchObject({ downloaded: 0, cached: 2 });
    // Закупки из кэша — те же, что прочитаны по сети.
    expect(after).toEqual(before);
  });

  it("кусок карты скачивается заново, когда его lastmod изменился, а остальные — нет", async () => {
    const first = makeAdapter(stubFetch(standardRoutes()).impl, { cacheDir: dir });
    await first.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    const changedList = urlset([
      { url: chunkUrl(59), lastmod: "2026-10-17T13:30:02.212+03:00" },
      { url: chunkUrl(60), lastmod: "2026-10-19T02:00:00.000+03:00" },
    ]);
    const stub = stubFetch({ ...standardRoutes(), [PROCEDURES_SITEMAP_URL]: changedList });
    const second = makeAdapter(stub.impl, { cacheDir: dir });
    await second.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    expect(stub.urls().filter((url) => url.includes("/sitemap/procedures/"))).toEqual([chunkUrl(60)]);
    expect(second.adapter.filterStats.sitemap).toMatchObject({ downloaded: 1, cached: 1 });
  });

  it("карточка читается заново, когда её lastmod в карте изменился", async () => {
    const first = makeAdapter(stubFetch(standardRoutes()).impl, { cacheDir: dir });
    await first.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    const bumped = urlset([
      { url: URLS.eis11, lastmod: "2026-10-18T10:00:00.000+03:00" },
      { url: URLS.priceUnknown, lastmod: LASTMOD.etpPriceUnknown },
      { url: URLS.click, lastmod: LASTMOD.etpClick },
    ]);
    const changedList = urlset([
      { url: chunkUrl(59), lastmod: "2026-10-17T13:30:02.212+03:00" },
      { url: chunkUrl(60), lastmod: "2026-10-19T02:00:00.000+03:00" },
    ]);
    const stub = stubFetch({ ...standardRoutes(), [PROCEDURES_SITEMAP_URL]: changedList, [chunkUrl(60)]: bumped });
    const second = makeAdapter(stub.impl, { cacheDir: dir });
    await second.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    expect(cardUrls(stub.urls())).toEqual([URLS.eis11]);
    expect(second.adapter.filterStats).toMatchObject({ fetched: 1, cached: 3 });
  });

  it("срок жизни карточки в кэше: по истечении читается заново", async () => {
    const first = makeAdapter(stubFetch(standardRoutes()).impl, { cacheDir: dir, cardTtlMs: 2 * HOUR });
    await first.adapter.fetchTenders({ ...baseQuery, keywords: ["поддон"] });

    const stub = stubFetch(standardRoutes());
    const fresh = makeAdapter(stub.impl, { cacheDir: dir, cardTtlMs: 2 * HOUR });
    fresh.clock.now = ETPGPB_NOW + HOUR;
    await fresh.adapter.fetchTenders({ ...baseQuery, keywords: ["поддон"] });
    expect(cardUrls(stub.urls())).toEqual([]);

    const stub2 = stubFetch(standardRoutes());
    const stale = makeAdapter(stub2.impl, { cacheDir: dir, cardTtlMs: 2 * HOUR });
    stale.clock.now = ETPGPB_NOW + 3 * HOUR;
    await stale.adapter.fetchTenders({ ...baseQuery, keywords: ["поддон"] });
    expect(cardUrls(stub2.urls())).toEqual([URLS.commerce]);
  });

  it("cardTtlMs = 0 выключает повторное использование карточек", async () => {
    const first = makeAdapter(stubFetch(standardRoutes()).impl, { cacheDir: dir, cardTtlMs: 0 });
    await first.adapter.fetchTenders({ ...baseQuery, keywords: ["поддон"] });
    const stub = stubFetch(standardRoutes());
    const second = makeAdapter(stub.impl, { cacheDir: dir, cardTtlMs: 0 });
    await second.adapter.fetchTenders({ ...baseQuery, keywords: ["поддон"] });
    expect(cardUrls(stub.urls())).toEqual([URLS.commerce]);
  });

  it("срок жизни из переменной окружения", () => {
    expect(etpgpbCardTtlMs(undefined)).toBe(72 * HOUR);
    expect(etpgpbCardTtlMs("")).toBe(72 * HOUR);
    expect(etpgpbCardTtlMs("12")).toBe(12 * HOUR);
    expect(etpgpbCardTtlMs("0")).toBe(0);
    expect(etpgpbCardTtlMs("-5")).toBe(72 * HOUR);
    expect(etpgpbCardTtlMs("много")).toBe(72 * HOUR);
  });
});

describe("карта сайта: сбои", () => {
  it("индекс не перечисляет карту процедур — ошибка о смене структуры сайта", async () => {
    const stub = stubFetch({
      [SITEMAP_INDEX_URL]: urlset([{ url: "https://etpgpb.ru/sitemap/pages.xml", lastmod: "2026-10-18" }]),
    });
    const { adapter } = makeAdapter(stub.impl);
    await expect(adapter.fetchTenders({ ...baseQuery })).rejects.toThrow(/структура сайта изменилась/);
  });

  it("не карта сайта вместо индекса — ошибка формата, а не пустая выдача", async () => {
    const stub = stubFetch({ [SITEMAP_INDEX_URL]: "<html>заглушка</html>" });
    const { adapter } = makeAdapter(stub.impl);
    await expect(adapter.fetchTenders({ ...baseQuery })).rejects.toThrow(/не разбирается/);
  });

  it("часть кусков не скачалась — работаем по остальным и считаем сбой", async () => {
    const stub = stubFetch({ ...standardRoutes(), [chunkUrl(60)]: 500 });
    const { adapter } = makeAdapter(stub.impl);
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(regNumbers(tenders)).toEqual([]);
    expect(adapter.filterStats.sitemap).toMatchObject({ downloaded: 1, failed: 1 });
    expect(adapter.filterStats.rejected).toEqual({ "приём заявок не идёт": 1 });
  });

  it("не скачался ни один кусок — ошибка источника, а не «найдено 0»", async () => {
    const stub = stubFetch({ ...standardRoutes(), [chunkUrl(60)]: 500, [chunkUrl(59)]: 500 });
    const { adapter } = makeAdapter(stub.impl);
    await expect(adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] })).rejects.toThrow(/HTTP 500/);
  });

  it("кусок не скачался, но есть в кэше прошлых прогонов — берётся устаревший", async () => {
    const first = makeAdapter(stubFetch(standardRoutes()).impl, { cacheDir: dir });
    await first.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    const changedList = urlset([
      { url: chunkUrl(59), lastmod: "2026-10-17T13:30:02.212+03:00" },
      { url: chunkUrl(60), lastmod: "2026-10-19T02:00:00.000+03:00" },
    ]);
    const stub = stubFetch({ ...standardRoutes(), [PROCEDURES_SITEMAP_URL]: changedList, [chunkUrl(60)]: 500 });
    const second = makeAdapter(stub.impl, { cacheDir: dir });
    const tenders = await second.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    expect(second.adapter.filterStats.sitemap).toMatchObject({ stale: 1, failed: 0, cached: 1 });
    expect(regNumbers(tenders)).toEqual(["ETPGPB-17793", "32616467295", "ETPGPB-АП125184"]);
  });
});

describe("запросы: повторы, редиректы, ограничение доступа", () => {
  it("5xx повторяется с нарастающей паузой и заканчивается успехом", async () => {
    let attempts = 0;
    const stub = stubFetch({
      ...standardRoutes(),
      [URLS.eis11]: () => {
        attempts += 1;
        return attempts < 3 ? 503 : nuxtPage(ETPGPB_CARD_ETP_EIS11.table);
      },
    });
    const { adapter, sleeps } = makeAdapter(stub.impl, { maxRetries: 3 });
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["бактериологическ"] });
    expect(regNumbers(tenders)).toEqual(["32616467295"]);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([300, 600]);
  });

  it("сбой сети повторяется; исчерпав повторы, карточка считается сбойной, а обход идёт дальше", async () => {
    const stub = stubFetch({ ...standardRoutes(), [URLS.click]: new Error("ECONNRESET") });
    const { adapter } = makeAdapter(stub.impl, { maxRetries: 1 });
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(regNumbers(tenders)).toEqual(["32616467295", "ETPGPB-АП125184"]);
    expect(stub.urls().filter((url) => url === URLS.click)).toHaveLength(2);
    expect(adapter.filterStats.failed).toBe(1);
    expect(adapter.filterStats.blocked).toBeNull();
  });

  it("HTTP 429: пауза по Retry-After, потолок 30 секунд", async () => {
    let attempts = 0;
    const stub = stubFetch({
      ...standardRoutes(),
      [URLS.eis11]: () => {
        attempts += 1;
        if (attempts === 1) return { status: 429, headers: { "retry-after": "2" } };
        if (attempts === 2) return { status: 429, headers: { "retry-after": "3600" } };
        return nuxtPage(ETPGPB_CARD_ETP_EIS11.table);
      },
    });
    const { adapter, sleeps } = makeAdapter(stub.impl, { maxRetries: 3 });
    await adapter.fetchTenders({ ...baseQuery, keywords: ["бактериологическ"] });
    expect(sleeps).toEqual([2000, 30_000]);
  });

  it("HTTP 403 — ограничение доступа: ни повторов, ни обхода; без найденного — ошибка", async () => {
    const stub = stubFetch({ ...standardRoutes(), [URLS.click]: 403 });
    const { adapter } = makeAdapter(stub.impl, { maxRetries: 3 });

    await expect(adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] })).rejects.toThrow(EtpgpbBlockedError);
    expect(stub.urls().filter((url) => url === URLS.click)).toHaveLength(1);
    expect(adapter.filterStats.blocked).toMatch(/ограничила доступ/);

    // После ограничения запросов к площадке больше нет вовсе — даже за другими карточками.
    const callsAfterBlock = stub.calls.length;
    await expect(adapter.fetchTenders({ ...baseQuery, keywords: ["поддон"] })).rejects.toThrow(/ограничила доступ/);
    expect(stub.calls.length).toBe(callsAfterBlock);
    await expect(adapter.fetchTenderById(URLS.eis11)).rejects.toThrow(EtpgpbBlockedError);
    expect(stub.calls.length).toBe(callsAfterBlock);
  });

  it("ограничение посреди обхода: уже найденное возвращается, причина — в статистике", async () => {
    const stub = stubFetch({ ...standardRoutes(), [URLS.eis11]: 403 });
    const { adapter } = makeAdapter(stub.impl);
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(regNumbers(tenders)).toEqual(["ETPGPB-17793"]);
    expect(adapter.filterStats.blocked).toMatch(/HTTP 403/);
    // Обход остановлен: карточки после запретившей не запрашивались.
    expect(cardUrls(stub.urls())).toEqual([URLS.click, URLS.eis11]);
  });

  it("многократный 429 — тоже ограничение доступа", async () => {
    const stub = stubFetch({ ...standardRoutes(), [URLS.click]: { status: 429 } });
    const { adapter } = makeAdapter(stub.impl, { maxRetries: 2 });
    await expect(adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] })).rejects.toThrow(EtpgpbBlockedError);
    expect(stub.urls().filter((url) => url === URLS.click)).toHaveLength(3);
  });

  it("страница с капчей вместо карточки — ограничение доступа, повторять её незачем", async () => {
    const stub = stubFetch({ ...standardRoutes(), [URLS.click]: "<html><body>Please solve the CAPTCHA</body></html>" });
    const { adapter } = makeAdapter(stub.impl, { maxRetries: 3 });
    await expect(adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] })).rejects.toThrow(EtpgpbBlockedError);
    expect(stub.urls().filter((url) => url === URLS.click)).toHaveLength(1);
  });

  it("страница не того формата без признаков защиты повторяется и в итоге считается сбоем карточки", async () => {
    const stub = stubFetch({ ...standardRoutes(), [URLS.click]: "<html>Технические работы</html>" });
    const { adapter } = makeAdapter(stub.impl, { maxRetries: 1 });
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(regNumbers(tenders)).toEqual(["32616467295", "ETPGPB-АП125184"]);
    expect(stub.urls().filter((url) => url === URLS.click)).toHaveLength(2);
    expect(adapter.filterStats.failed).toBe(1);
  });

  it("404 карточки — процедуры нет: не сбой и не повтор, результат запоминается", async () => {
    const stub = stubFetch({ ...standardRoutes(), [URLS.click]: 404 });
    const { adapter } = makeAdapter(stub.impl, { maxRetries: 3, cacheDir: dir });
    await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(stub.urls().filter((url) => url === URLS.click)).toHaveLength(1);
    expect(adapter.filterStats.failed).toBe(0);
    expect(adapter.filterStats.rejected["не закупка поставщика"]).toBe(1);

    // Следующий прогон не спрашивает снова.
    const again = stubFetch({ ...standardRoutes(), [URLS.click]: 404 });
    const next = makeAdapter(again.impl, { cacheDir: dir });
    await next.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(cardUrls(again.urls())).toEqual([]);
  });

  it("редирект на другую карточку площадки выполняется, каждый шаг — через проверку адреса", async () => {
    const moved = "https://etpgpb.ru/procedures/etp_click/2081479-postavka-igrushek-v-assortimente-novyy/";
    const stub = stubFetch({
      ...standardRoutes(),
      [URLS.click]: { status: 301, headers: { location: moved } },
      [moved]: nuxtPage(ETPGPB_CARD_ETP_CLICK.table),
    });
    const { adapter } = makeAdapter(stub.impl);
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["игрушек"] });
    expect(regNumbers(tenders)).toEqual(["ETPGPB-17793"]);
    expect(stub.urls()).toContain(moved);
  });

  it("относительный редирект разрешается от текущего адреса", async () => {
    const stub = stubFetch({
      ...standardRoutes(),
      [URLS.click]: { status: 302, headers: { location: new URL(URLS.click).pathname } },
    });
    // Редирект сам на себя: цепочка обрывается пределом, а не зацикливает адаптер.
    const { adapter } = makeAdapter(stub.impl);
    await adapter.fetchTenders({ ...baseQuery, keywords: ["игрушек"] });
    expect(stub.urls().filter((url) => url === URLS.click).length).toBeLessThanOrEqual(4);
    expect(adapter.filterStats.failed).toBe(1);
  });

  it.each([
    ["закрытый хост документов", "https://etp.gpb.ru/file/get/t/LotDocuments/id/1/name/x"],
    ["закрытый хост com.etpgpb.ru", "https://com.etpgpb.ru/api/public/gate/x"],
    ["адрес с query-строкой", "https://etpgpb.ru/procedures/etp_click/2081479-x/?utm=1"],
    ["постраничный список", "https://etpgpb.ru/procedures/page/2/"],
    ["внутренний API", "https://etpgpb.ru/api/v2/procedures/"],
    ["чужой сайт", "https://evil.example/etpgpb.ru/"],
  ])("редирект на %s не выполняется: запроса по такому адресу нет", async (_name, target) => {
    const stub = stubFetch({
      ...standardRoutes(),
      [URLS.click]: { status: 302, headers: { location: target } },
      [target]: "должно быть недостижимо",
    });
    const { adapter } = makeAdapter(stub.impl);
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["игрушек"] });
    expect(tenders).toEqual([]);
    expect(stub.urls()).not.toContain(target);
    expect(adapter.filterStats.failed).toBe(1);
    expect(adapter.filterStats.blocked).toBeNull();
  });

  it("точечный запрос по адресу с редиректом на закрытый хост бросает EtpgpbUrlNotAllowedError", async () => {
    const stub = stubFetch({
      [URLS.click]: { status: 302, headers: { location: "https://etp.gpb.ru/x" } },
    });
    const { adapter } = makeAdapter(stub.impl);
    await expect(adapter.fetchTenderById(URLS.click)).rejects.toThrow(EtpgpbUrlNotAllowedError);
    expect(stub.urls()).toEqual([URLS.click]);
  });

  it("темп по умолчанию — не чаще одного запроса в секунду", async () => {
    const stub = stubFetch(standardRoutes());
    const sleeps: number[] = [];
    const adapter = new EtpgpbTenderSourceAdapter({
      maxRetries: 0,
      nowProvider: () => new Date(ETPGPB_NOW),
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: stub.impl,
    });
    await adapter.fetchTenderById(URLS.click);
    await adapter.fetchTenderById(URLS.eis11);
    await adapter.fetchTenderById(URLS.priceUnknown);
    // Первый запрос идёт сразу, каждый следующий — на секунду позже предыдущего.
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThan(900);
    expect(sleeps[0]).toBeLessThanOrEqual(1000);
    expect(sleeps[1]).toBeGreaterThan(1900);
    expect(sleeps[1]).toBeLessThanOrEqual(2000);
  });
});

describe("fetchDocuments", () => {
  it("возвращает пустой список и не делает ни одного запроса", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    const before = stub.calls.length;

    expect(await adapter.fetchDocuments("32616467295")).toEqual([]);
    expect(await adapter.fetchDocuments("ETPGPB-АП125184")).toEqual([]);
    expect(await adapter.fetchDocuments(URLS.eis11)).toEqual([]);
    expect(stub.calls.length).toBe(before);
    // Ни одного обращения к хосту файлов.
    expect(stub.urls().some((url) => url.includes("etp.gpb.ru"))).toBe(false);
  });

  it("у свежесозданного адаптера — тоже без запроса", async () => {
    const stub = stubFetch({});
    const { adapter } = makeAdapter(stub.impl);
    expect(await adapter.fetchDocuments("x")).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it("закупки не несут документов и ссылок на закрытый хост", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(tenders.every((t) => t.documents.length === 0)).toBe(true);
    expect(JSON.stringify(tenders)).not.toMatch(/etp\.gpb\.ru|com\.etpgpb\.ru|file\/get/);
  });
});

describe("fetchTenderById и checkChanges", () => {
  it("по адресу карточки: читается по сети, закупка разобрана", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    const tender = await adapter.fetchTenderById(URLS.eis11);
    expect(tender?.regNumber).toBe("32616467295");
    expect(stub.urls()).toEqual([URLS.eis11]);
  });

  it("по ключу записи и по номеру площадки — после того как адаптер видел закупку", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    const before = stub.calls.length;

    expect((await adapter.fetchTenderById("ETPGPB-АП125184"))?.externalId).toBe("АП125184");
    expect((await adapter.fetchTenderById("АП125184"))?.regNumber).toBe("ETPGPB-АП125184");
    expect((await adapter.fetchTenderById("32616467295"))?.regNumber).toBe("32616467295");
    // Свежее чтение карточки по её адресу — по одному запросу на вызов, и только по её адресу.
    expect(stub.urls().slice(before)).toEqual([URLS.priceUnknown, URLS.priceUnknown, URLS.eis11]);
  });

  it("по ключу из кэша карточек на диске — в новом процессе", async () => {
    const first = makeAdapter(stubFetch(standardRoutes()).impl, { cacheDir: dir });
    await first.adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });

    const stub = stubFetch(standardRoutes());
    const second = makeAdapter(stub.impl, { cacheDir: dir });
    expect((await second.adapter.fetchTenderById("ETPGPB-17793"))?.regNumber).toBe("ETPGPB-17793");
    expect(stub.urls()).toEqual([URLS.click]);
  });

  it("по идентификатору etpgpb-<вид>-<номер> адрес находится в карте сайта", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    const tender = await adapter.fetchTenderById("etpgpb-etp-1298399");
    expect(tender?.regNumber).toBe("32616467295");
    expect(cardUrls(stub.urls())).toEqual([URLS.eis11]);
  });

  it("неизвестный номер — null и ни одного запроса карточки: адрес по номеру не угадать", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    expect(await adapter.fetchTenderById("ETPGPB-НЕТ-ТАКОГО")).toBeNull();
    expect(await adapter.fetchTenderById("")).toBeNull();
    expect(await adapter.fetchTenderById("etpgpb-etp-424242")).toBeNull();
    expect(cardUrls(stub.urls())).toEqual([]);
  });

  it("чужой и запрещённый адрес — null без запроса", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    expect(await adapter.fetchTenderById("https://etp.gpb.ru/procedures/etp/1-a/")).toBeNull();
    expect(await adapter.fetchTenderById("https://etpgpb.ru/procedures/etp/1-a/?x=1")).toBeNull();
    expect(stub.calls).toEqual([]);
  });

  it("продажа имущества по адресу — null: такие процедуры не берём", async () => {
    const stub = stubFetch({ [URLS.sale]: nuxtPage(ETPGPB_CARD_SALE.table) });
    const { adapter } = makeAdapter(stub.impl);
    expect(await adapter.fetchTenderById(URLS.sale)).toBeNull();
  });

  it("процедуры нет на площадке (404) — null", async () => {
    const stub = stubFetch({});
    const { adapter } = makeAdapter(stub.impl);
    expect(await adapter.fetchTenderById(URLS.click)).toBeNull();
  });

  it("checkChanges: изменение после даты — true, до неё — false", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    // date_last_update карточки 11-значной: 17.10.2026 18:32 МСК.
    expect(await adapter.checkChanges(URLS.eis11, "2026-10-17T00:00:00.000Z")).toBe(true);
    expect(await adapter.checkChanges(URLS.eis11, "2026-10-18T00:00:00.000Z")).toBe(false);
  });

  it("checkChanges: нечитаемая дата — false без запроса, неизвестная закупка — false", async () => {
    const stub = stubFetch(standardRoutes());
    const { adapter } = makeAdapter(stub.impl);
    expect(await adapter.checkChanges(URLS.eis11, "вчера")).toBe(false);
    expect(stub.calls).toEqual([]);
    expect(await adapter.checkChanges("ETPGPB-НЕТ", "2026-10-17T00:00:00.000Z")).toBe(false);
  });
});

describe("личные данные", () => {
  it("карточки с контактами: в закупках ни ключей, ни значений контактов, ни в кэше на диске", async () => {
    const withContacts = (fixture: { url: string; table: unknown[] }): string =>
      nuxtPage(withSyntheticContacts(fixture.table));
    const routes: Record<string, StubReply> = {
      ...standardRoutes(),
      [URLS.eis11]: withContacts(ETPGPB_CARD_ETP_EIS11),
      [URLS.priceUnknown]: withContacts(ETPGPB_CARD_ETP_PRICE_UNKNOWN),
      [URLS.click]: withContacts(ETPGPB_CARD_ETP_CLICK),
      [URLS.gaz]: withContacts(ETPGPB_CARD_GAZ_EIS_URL),
    };
    const stub = stubFetch(routes);
    const { adapter } = makeAdapter(stub.impl, { cacheDir: dir });

    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["поставк"] });
    expect(tenders).toHaveLength(3);
    const text = JSON.stringify(tenders);
    expect(text).not.toMatch(SYNTHETIC_CONTACT_PATTERN);
    expect(text).not.toMatch(/contact|e-?mail|phone|@/i);

    const { readFileSync } = await import("node:fs");
    const cacheText = readFileSync(join(dir, "etpgpb-card-cache.json"), "utf-8");
    expect(cacheText).not.toMatch(SYNTHETIC_CONTACT_PATTERN);
    expect(cacheText).not.toMatch(/contact_|email|phone|@/i);
  });
});
