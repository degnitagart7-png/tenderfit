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
