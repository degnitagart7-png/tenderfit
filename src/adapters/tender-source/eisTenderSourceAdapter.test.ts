import { describe, expect, it, vi } from "vitest";
import { EisTenderSourceAdapter } from "@/adapters/tender-source/eisTenderSourceAdapter";

/**
 * Тесты поиска по конкретному заказчику (параметр customerIdOrg).
 *
 * Именно так проект получает закупки площадок вроде rzd.rts-tender.ru:
 * сама площадка закрыта SSO и robots.txt, но все закупки 223-ФЗ по закону
 * публикуются в ЕИС, где их можно отфильтровать по ИНН заказчика.
 * Сеть в тестах не используется — fetch подменяется заглушкой.
 */

const RZD_INN = "7708503727";
const RZD_KPP = "770801001";
const RZD_ORG_ID = "1037739877295";
const RZD_TITLE = 'ОТКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "РОССИЙСКИЕ ЖЕЛЕЗНЫЕ ДОРОГИ"';
const RZD_CUSTOMER_ID_ORG = `-1:${RZD_TITLE}zZzZzZzZ${RZD_INN}zZzZ${RZD_KPP}zZ${RZD_ORG_ID}`;

const OTHER_INN = "1234567890";
const OTHER_CUSTOMER_ID_ORG = `-1:ООО ВТОРОЙ ЗАКАЗЧИКzZzZzZzZ${OTHER_INN}zZzZzZ42`;

/** Кодирует значение так же, как ЕИС: пробелы — «+». */
function encodeEis(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/** Выдача /epz/organization/search/results.html со ссылками на закупки заказчика. */
function orgSearchPage(values: string[]): string {
  const links = values
    .map(
      (v) =>
        `<a href="/epz/order/extendedsearch/results.html?fz223=on&customerIdOrg=${encodeEis(v)}">Закупки</a>`,
    )
    .join("\n");
  return `<html><body><div class="searchResult">${links}</div></body></html>`;
}

/** Выдача /epz/order/extendedsearch/results.html с карточками закупок. */
function resultsPage(cards: { regNumber: string; inn: string | null }[]): string {
  const blocks = cards
    .map(
      (c) => `
<div class="search-registry-entry-block">
  <div class="registry-entry__header-top__title">223-ФЗ Запрос котировок в электронной форме</div>
  <div class="registry-entry__header-mid__number">
    <a href="/epz/order/notice/zk20/view/common-info.html?regNumber=${c.regNumber}">№ ${c.regNumber}</a>
  </div>
  <div class="registry-entry__header-mid__title">Подача заявок</div>
  <div class="registry-entry__body-block">
    <div class="registry-entry__body-title">Объект закупки</div>
    <div class="registry-entry__body-value">Поставка серверного оборудования</div>
  </div>
  <div class="registry-entry__body-block">
    <div class="registry-entry__body-title">Заказчик</div>
    <div class="registry-entry__body-href">
      <a href="/epz/organization/view223/info.html?&inn=${c.inn ?? ""}&kpp=1">Заказчик</a>
    </div>
  </div>
  <div class="price-block__value">1 500 000,00 ₽</div>
  <div class="data-block">
    <div class="data-block__title">Размещено</div><div class="data-block__value">15.09.2026</div>
    <div class="data-block__title">Обновлено</div><div class="data-block__value">18.09.2026</div>
    <div class="data-block__title">Окончание подачи заявок</div><div class="data-block__value">25.09.2026</div>
  </div>
</div>`,
    )
    .join("\n");
  return `<html><body>${blocks}</body></html>`;
}

/** Заглушка fetch: ответ выбирается по подстроке в URL. */
function stubFetch(routes: { match: string; body: string }[]) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    return {
      ok: true,
      status: 200,
      text: async () => route?.body ?? "",
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function makeAdapter(fetchImpl: typeof fetch) {
  return new EisTenderSourceAdapter({
    rateLimitPerSec: 1000,
    maxRetries: 0,
    fetchImpl,
  });
}

const rzdCards = [
  { regNumber: "32008939617", inn: RZD_INN },
  { regNumber: "31908283537", inn: RZD_INN },
];

describe("EisTenderSourceAdapter.fetchTenders по ИНН заказчика", () => {
  it("сначала находит заказчика в ЕИС, затем запрашивает его закупки", async () => {
    const { impl, calls } = stubFetch([
      { match: "/epz/organization/search/", body: orgSearchPage([RZD_CUSTOMER_ID_ORG]) },
      { match: "/epz/order/extendedsearch/", body: resultsPage(rzdCards) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      laws: ["FZ_223"],
      customerInns: [RZD_INN],
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(`/epz/organization/search/results.html?searchString=${RZD_INN}`);
    expect(calls[1]).toContain("/epz/order/extendedsearch/results.html");
    expect(calls[1]).toContain("customerIdOrg=");
    expect(calls[1]).toContain("fz223=on");

    expect(tenders).toHaveLength(2);
    expect(tenders.map((t) => t.regNumber)).toEqual(["32008939617", "31908283537"]);
    expect(tenders.every((t) => t.customerInn === RZD_INN)).toBe(true);
    expect(tenders[0]?.law).toBe("FZ_223");
  });

  it("передаёт найденное значение customerIdOrg в запрос без искажений", async () => {
    const { impl, calls } = stubFetch([
      { match: "/epz/organization/search/", body: orgSearchPage([RZD_CUSTOMER_ID_ORG]) },
      { match: "/epz/order/extendedsearch/", body: resultsPage(rzdCards) },
    ]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders({ laws: ["FZ_223"], customerInns: [RZD_INN] });

    const param = new URL(calls[1] ?? "").searchParams.get("customerIdOrg");
    expect(param).toBe(RZD_CUSTOMER_ID_ORG);
  });

  it("кэширует карточку заказчика: повторный поиск не запрашивает организацию", async () => {
    const { impl, calls } = stubFetch([
      { match: "/epz/organization/search/", body: orgSearchPage([RZD_CUSTOMER_ID_ORG]) },
      { match: "/epz/order/extendedsearch/", body: resultsPage(rzdCards) },
    ]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders({ laws: ["FZ_223"], customerInns: [RZD_INN] });
    await adapter.fetchTenders({ laws: ["FZ_223"], customerInns: [RZD_INN] });

    expect(calls).toHaveLength(3);
    expect(calls.filter((u) => u.includes("/epz/organization/search/"))).toHaveLength(1);
  });

  it("если заказчик не найден — запрос закупок не выполняется", async () => {
    const { impl, calls } = stubFetch([
      { match: "/epz/organization/search/", body: orgSearchPage([]) },
      { match: "/epz/order/extendedsearch/", body: resultsPage(rzdCards) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      laws: ["FZ_223"],
      customerInns: ["9999999999"],
    });

    expect(calls).toHaveLength(1);
    expect(tenders).toEqual([]);
  });

  it("объединяет закупки нескольких заказчиков и убирает дубликаты", async () => {
    const { impl, calls } = stubFetch([
      { match: `searchString=${RZD_INN}`, body: orgSearchPage([RZD_CUSTOMER_ID_ORG]) },
      { match: `searchString=${OTHER_INN}`, body: orgSearchPage([OTHER_CUSTOMER_ID_ORG]) },
      {
        match: `customerIdOrg=${encodeEis(RZD_CUSTOMER_ID_ORG)}`,
        body: resultsPage(rzdCards),
      },
      {
        match: `customerIdOrg=${encodeEis(OTHER_CUSTOMER_ID_ORG)}`,
        // Один номер повторяет карточку РЖД — должен быть отброшен как дубликат.
        body: resultsPage([
          { regNumber: "32008939617", inn: OTHER_INN },
          { regNumber: "32111014833", inn: OTHER_INN },
        ]),
      },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      laws: ["FZ_223"],
      customerInns: [RZD_INN, OTHER_INN],
    });

    expect(calls).toHaveLength(4);
    expect(tenders.map((t) => t.regNumber)).toEqual([
      "32008939617",
      "31908283537",
      "32111014833",
    ]);
    expect(tenders[2]?.customerInn).toBe(OTHER_INN);
  });

  it("соблюдает limit", async () => {
    const { impl } = stubFetch([
      { match: "/epz/organization/search/", body: orgSearchPage([RZD_CUSTOMER_ID_ORG]) },
      { match: "/epz/order/extendedsearch/", body: resultsPage(rzdCards) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      laws: ["FZ_223"],
      customerInns: [RZD_INN],
      limit: 1,
    });

    expect(tenders).toHaveLength(1);
  });

  it("без ИНН заказчика работает обычный поиск (один запрос)", async () => {
    const { impl, calls } = stubFetch([
      { match: "/epz/order/extendedsearch/", body: resultsPage(rzdCards) },
    ]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ laws: ["FZ_223"], keywords: ["сервер"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("customerIdOrg");
    expect(calls[0]).toContain("searchString=");
    expect(tenders).toHaveLength(2);
  });
});

describe("EisTenderSourceAdapter.resolveCustomer", () => {
  it("возвращает реквизиты заказчика из выдачи поиска организаций", async () => {
    const { impl } = stubFetch([
      {
        match: "/epz/organization/search/",
        body: orgSearchPage([OTHER_CUSTOMER_ID_ORG, RZD_CUSTOMER_ID_ORG]),
      },
    ]);
    const adapter = makeAdapter(impl);

    const ref = await adapter.resolveCustomer(RZD_INN);

    expect(ref?.inn).toBe(RZD_INN);
    expect(ref?.kpp).toBe(RZD_KPP);
    expect(ref?.orgId).toBe(RZD_ORG_ID);
    expect(ref?.title).toBe(RZD_TITLE);
  });

  it("возвращает null для пустого ИНН и не ходит в сеть", async () => {
    const { impl, calls } = stubFetch([]);
    const adapter = makeAdapter(impl);

    expect(await adapter.resolveCustomer("  ")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

/**
 * Глубина выдачи ЕИС в живом поиске.
 *
 * Адаптер читал только первую страницу из десяти закупок, а лимит лишь
 * обрезал её. Плановому профилю с лимитом 10 этого хватало; живой поиск с
 * лимитом 25 получал те же десять, и «найдено 10» выглядело как «больше
 * нет», хотя ЕИС отдавала сотни.
 */
describe("EisTenderSourceAdapter.fetchTenders — глубина выдачи", () => {
  function manyCards(count: number): { regNumber: string; inn: string | null }[] {
    return Array.from({ length: count }, (_, i) => ({
      regNumber: String(32616000000 + i),
      inn: null,
    }));
  }

  it("лимит 25 просит страницу на 50 и отдаёт ровно 25", async () => {
    const { impl, calls } = stubFetch([{ match: "extendedsearch", body: resultsPage(manyCards(50)) }]);

    const tenders = await makeAdapter(impl).fetchTenders({ laws: ["FZ_44", "FZ_223"], keywords: ["юристы"], limit: 25 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("recordsPerPage=_50");
    expect(tenders).toHaveLength(25);
  });

  it("лимит 10 остаётся прежним: страница без параметра размера", async () => {
    const { impl, calls } = stubFetch([{ match: "extendedsearch", body: resultsPage(manyCards(10)) }]);

    const tenders = await makeAdapter(impl).fetchTenders({ laws: ["FZ_44", "FZ_223"], keywords: ["юристы"], limit: 10 });

    expect(calls[0]).not.toContain("recordsPerPage");
    expect(tenders).toHaveLength(10);
  });

  it("maxPages листает страницы по сто, пока выдача не кончится, и собирает без повторов", async () => {
    const page = (from: number, count: number) =>
      resultsPage(Array.from({ length: count }, (_, i) => ({ regNumber: String(32616000000 + from + i), inn: null })));
    const { impl, calls } = stubFetch([
      { match: "pageNumber=3", body: page(200, 40) },
      { match: "pageNumber=2", body: page(100, 100) },
      { match: "extendedsearch", body: page(0, 100) },
    ]);

    const tenders = await makeAdapter(impl).fetchTenders({
      laws: ["FZ_44", "FZ_223"],
      keywords: ["юристы"],
      limit: 300,
      maxPages: 5,
    });

    expect(calls).toHaveLength(3);
    expect(calls.every((url) => url.includes("recordsPerPage=_100"))).toBe(true);
    expect(tenders).toHaveLength(240);
    expect(new Set(tenders.map((t) => t.regNumber)).size).toBe(240);
  });

  it("maxPages не больше запрошенного: третья страница не читается", async () => {
    const page = (from: number) =>
      resultsPage(Array.from({ length: 100 }, (_, i) => ({ regNumber: String(32616000000 + from + i), inn: null })));
    const { impl, calls } = stubFetch([
      { match: "pageNumber=3", body: page(200) },
      { match: "pageNumber=2", body: page(100) },
      { match: "extendedsearch", body: page(0) },
    ]);

    const tenders = await makeAdapter(impl).fetchTenders({
      laws: ["FZ_44", "FZ_223"],
      keywords: ["юристы"],
      limit: 300,
      maxPages: 2,
    });

    expect(calls).toHaveLength(2);
    expect(tenders).toHaveLength(200);
  });

  it("первая страница короче сотни — вторая не запрашивается", async () => {
    const { impl, calls } = stubFetch([{ match: "extendedsearch", body: resultsPage(manyCards(30)) }]);

    const tenders = await makeAdapter(impl).fetchTenders({
      laws: ["FZ_44", "FZ_223"],
      keywords: ["юристы"],
      limit: 300,
      maxPages: 3,
    });

    expect(calls).toHaveLength(1);
    expect(tenders).toHaveLength(30);
  });

  describe("регион заказчика", () => {
    it("регион из запроса уходит в ЕИС кодом, а закупкам проставляется этот регион", async () => {
      const { impl, calls } = stubFetch([{ match: "extendedsearch", body: resultsPage(manyCards(3)) }]);

      const tenders = await makeAdapter(impl).fetchTenders({
        laws: ["FZ_44", "FZ_223"],
        keywords: ["строительство"],
        regions: ["Бурятия"],
        limit: 25,
      });

      expect(calls).toHaveLength(1);
      const url = new URL(calls[0]!);
      expect(url.searchParams.get("customerPlace")).toBe("03000000000");
      expect(url.searchParams.get("customerPlaceCodes")).toBe("03000000000");
      expect(tenders.map((t) => t.region)).toEqual(Array(3).fill("Республика Бурятия"));
    });

    it("два региона — два запроса, закупки без повторов и со своим регионом", async () => {
      const bur = resultsPage([{ regNumber: "32616000001", inn: null }]);
      const msk = resultsPage([
        { regNumber: "32616000002", inn: null },
        { regNumber: "32616000001", inn: null },
      ]);
      const { impl, calls } = stubFetch([
        { match: "customerPlace=77000000000", body: msk },
        { match: "customerPlace=03000000000", body: bur },
      ]);

      const tenders = await makeAdapter(impl).fetchTenders({
        laws: ["FZ_44", "FZ_223"],
        keywords: ["строительство"],
        regions: ["Республика Бурятия", "Москва"],
        limit: 25,
      });

      expect(calls).toHaveLength(2);
      expect(tenders.map((t) => t.regNumber).sort()).toEqual(["32616000001", "32616000002"]);
      expect(tenders.find((t) => t.regNumber === "32616000002")?.region).toBe("Москва");
    });

    it("название, которое не удалось опознать, не даёт поиск по чужому коду: ищем по всей России", async () => {
      const { impl, calls } = stubFetch([{ match: "extendedsearch", body: resultsPage(manyCards(2)) }]);

      const tenders = await makeAdapter(impl).fetchTenders({
        laws: ["FZ_44"],
        keywords: ["x"],
        regions: ["Нарния"],
        limit: 10,
      });

      expect(new URL(calls[0]!).searchParams.has("customerPlace")).toBe(false);
      expect(tenders.every((t) => t.region !== "Нарния")).toBe(true);
    });

    it("публикация за последние N дней уходит датой в формате ЕИС", async () => {
      const { impl, calls } = stubFetch([{ match: "extendedsearch", body: resultsPage(manyCards(1)) }]);

      await makeAdapter(impl).fetchTenders({
        laws: ["FZ_44"],
        keywords: [],
        regions: ["Бурятия"],
        publishedWithinDays: 30,
        nowMs: Date.parse("2026-10-05T12:00:00Z"),
        limit: 10,
      });

      const url = new URL(calls[0]!);
      expect(url.searchParams.get("publishDateFrom")).toBe("05.09.2026");
      expect(url.searchParams.has("searchString")).toBe(false);
    });

    it("не больше трёх регионов за запрос: каждый стоит страницы выдачи", async () => {
      const { impl, calls } = stubFetch([{ match: "extendedsearch", body: resultsPage(manyCards(1)) }]);

      await makeAdapter(impl).fetchTenders({
        laws: ["FZ_44"],
        keywords: ["x"],
        regions: ["Бурятия", "Москва", "Свердловская область", "Приморский край", "Крым"],
        limit: 10,
      });

      expect(calls).toHaveLength(3);
    });
  });

  it("лимита нет — обычная страница", async () => {
    const { impl, calls } = stubFetch([{ match: "extendedsearch", body: resultsPage(manyCards(10)) }]);

    await makeAdapter(impl).fetchTenders({ laws: ["FZ_44", "FZ_223"], keywords: ["юристы"] });

    expect(calls[0]).not.toContain("recordsPerPage");
  });
});


/*
  Временная блокировка частых запросов (05.10.2026): после нескольких прогонов
  подряд ЕИС отвечала 403 на все запросы, а через несколько минут тому же адресу
  снова 200. Короткая пауза в четыре секунды её не пережидала, и прогон
  возвращался пустым. На 403 и 429 адаптер ждёт дольше и пробует снова.
*/
describe("EisTenderSourceAdapter: временная блокировка (403/429)", () => {
  function flaky(statuses: number[], okBody: string) {
    const calls: number[] = [];
    let i = 0;
    const impl = vi.fn(async () => {
      const status = statuses[i] ?? 200;
      i += 1;
      calls.push(status);
      return { ok: status === 200, status, text: async () => (status === 200 ? okBody : "Forbidden") } as unknown as Response;
    });
    return { impl: impl as unknown as typeof fetch, calls };
  }

  function adapterWith(fetchImpl: typeof fetch, retries = 3) {
    return new EisTenderSourceAdapter({
      rateLimitPerSec: 1000,
      maxRetries: retries,
      blockedBackoffMs: 1,
      fetchImpl,
    });
  }

  it("403, затем 200 — выдача получена, блокировка пережидается", async () => {
    const { impl, calls } = flaky([403, 403], resultsPage(manyCardsForBlock(3)));

    const tenders = await adapterWith(impl).fetchTenders({ laws: ["FZ_44"], keywords: ["x"], limit: 10 });

    expect(tenders).toHaveLength(3);
    expect(calls).toEqual([403, 403, 200]);
  });

  it("429 тоже пережидается", async () => {
    const { impl } = flaky([429], resultsPage(manyCardsForBlock(2)));

    expect(await adapterWith(impl).fetchTenders({ laws: ["FZ_44"], keywords: ["x"], limit: 10 })).toHaveLength(2);
  });

  it("блокировка не кончается — ошибка с кодом, а не пустая выдача", async () => {
    const { impl } = flaky([403, 403, 403, 403, 403], "");

    await expect(
      adapterWith(impl, 2).fetchTenders({ laws: ["FZ_44"], keywords: ["x"], limit: 10 }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

function manyCardsForBlock(count: number): { regNumber: string; inn: string | null }[] {
  return Array.from({ length: count }, (_, i) => ({ regNumber: String(32616100000 + i), inn: null }));
}
