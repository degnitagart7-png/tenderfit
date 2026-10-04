import { describe, expect, it, vi } from "vitest";
import { TektorgSoapFaultError, TektorgParseError } from "@/adapters/tender-source/tektorgSoap";
import {
  TEKTORG_EMPTY_PAGE,
  TEKTORG_FAULT,
  TEKTORG_LIVE_RESPONSE,
  TEKTORG_REMOVED_DOCUMENT,
  TEKTORG_TRUNCATED,
} from "@/adapters/tender-source/tektorgTestFixtures";
import {
  TektorgTenderSourceAdapter,
  tektorgDateTime,
} from "@/adapters/tender-source/tektorgTenderSourceAdapter";
import type { TenderSourceQuery } from "@/adapters/types";
import { describeError } from "@/lib/errors";

/**
 * Момент «сейчас» для детерминированных тестов: 12:00 UTC = 15:00 МСК.
 * Площадка печатает даты со смещением +03:00, поэтому окно в запросе тоже московское.
 */
const TEST_NOW = new Date("2026-10-01T12:00:00.000Z");

/** Один ответ заглушки: тело, HTTP-код или ошибка сети. */
type StubResponse = string | number | Error;

interface StubCall {
  url: string;
  init: RequestInit;
}

/**
 * Заглушка fetch: отдаёт подготовленные ответы по порядку, последний повторяет.
 * Площадка отвечает `Content-Type: text/html` и при успехе, и при ошибке, поэтому
 * заглушка не изображает заголовки — адаптер обязан смотреть на тело.
 */
function stubFetch(responses: readonly StubResponse[]) {
  const calls: StubCall[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const response = responses[Math.min(calls.length - 1, responses.length - 1)] ?? 500;
    if (response instanceof Error) throw response;
    if (typeof response === "number") {
      return { ok: false, status: response, text: async () => "" } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => response } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const baseQuery: TenderSourceQuery = { laws: ["FZ_223", "COMMERCIAL"], limit: 10 };

function makeAdapter(fetchImpl: typeof fetch, overrides: object = {}) {
  return new TektorgTenderSourceAdapter({
    rateLimitPerSec: 1000,
    maxRetries: 0,
    timeoutMs: 5000,
    pageSize: 500,
    maxPages: 3,
    lookbackDays: 1,
    nowProvider: () => TEST_NOW,
    fetchImpl,
    ...overrides,
  });
}

/** Тело первого запроса текстом — по нему проверяем конверт. */
function firstBody(calls: readonly StubCall[]): string {
  return String(calls[0]?.init.body ?? "");
}

describe("tektorgDateTime", () => {
  it("печатает момент в московском времени площадки, без миллисекунд", () => {
    expect(tektorgDateTime(TEST_NOW)).toBe("2026-10-01T15:00:00+03:00");
  });

  it("переносит дату назад, когда московские сутки ещё не начались", () => {
    expect(tektorgDateTime(new Date("2026-10-01T21:30:00.000Z"))).toBe(
      "2026-10-02T00:30:00+03:00",
    );
  });
});

describe("TektorgTenderSourceAdapter.fetchTenders", () => {
  it("зовёт экспорт процедур с окном публикации, секцией и размером страницы", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.tektorg.ru/procedures/soap");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toMatchObject({
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "urn:procedures",
    });

    const body = firstBody(calls);
    expect(body).toContain("<sectionCode>zakupki</sectionCode>");
    expect(body).toContain("<limitPage>500</limitPage>");
    expect(body).toContain("<startDate>2026-09-30T15:00:00+03:00</startDate>");
    expect(body).toContain("<endDate>2026-10-01T15:00:00+03:00</endDate>");
    expect(tenders).toHaveLength(3);
    expect(tenders.every((t) => t.dataSource === "TEK_TORG")).toBe(true);
  });

  it("берёт окно публикации, а не окно изменений: архив площадки уже закрыт", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders(baseQuery);

    const body = firstBody(calls);
    expect(body).not.toContain("<startUpdateAt>");
    expect(body).not.toContain("<endUpdateAt>");
  });

  it("передаёт сигнал таймаута в fetch", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl, { timeoutMs: 1234 });

    await adapter.fetchTenders(baseQuery);

    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("отбирает по ключевым словам на своей стороне: у площадки такого параметра нет", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, keywords: ["кузовному"] });

    expect(firstBody(calls)).not.toContain("кузовному");
    expect(tenders.map((t) => t.externalId)).toEqual(["ЗП610102"]);
  });

  it("ищет слово и в предмете лота, а не только в названии процедуры", async () => {
    // Название процедуры заменено: слово осталось только в предметах лотов.
    const withoutTitle = TEKTORG_LIVE_RESPONSE.replace(
      /<title>Поставка электро-бензоинструмента[^<]*<\/title>/,
      "<title>Поставка оборудования</title>",
    );
    const { impl } = stubFetch([withoutTitle]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      ...baseQuery,
      keywords: ["электро-бензоинструмента"],
    });

    expect(tenders.map((t) => t.externalId)).toEqual(["ЗП6082206"]);
  });

  it("считает отклонения по причинам: журнал прогона не должен гадать", async () => {
    const { impl } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ laws: ["COMMERCIAL"], limit: 10 });

    expect(tenders).toHaveLength(1);
    expect(adapter.filterStats).toEqual({
      fetched: 3,
      kept: 1,
      rejected: { закон: 2 },
    });
  });

  it("отбирает по региону на своей стороне", async () => {
    const { impl } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const ulyanovsk = await adapter.fetchTenders({
      ...baseQuery,
      regions: ["Ульяновская область"],
    });
    const moscow = await adapter.fetchTenders({ ...baseQuery, regions: ["Москва"] });

    expect(ulyanovsk.map((t) => t.externalId)).toEqual(["ЗП6091269"]);
    expect(moscow.map((t) => t.externalId)).toEqual(["ЗП6082206", "ЗП610102"]);
  });

  it("не отсеивает закупку без опубликованной цены: ноль значит «не указана»", async () => {
    const { impl } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, minPrice: 200000 });

    // ЗП6091269 (137 640 ₽) отсечена, ЗП610102 без цены осталась.
    expect(tenders.map((t) => t.externalId)).toEqual(["ЗП6082206", "ЗП610102"]);
  });

  it("отбирает по закону из профиля", async () => {
    const { impl } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ laws: ["COMMERCIAL"], limit: 10 });

    expect(tenders.map((t) => t.externalId)).toEqual(["ЗП610102"]);
  });

  it("уходящие в конверт ИНН заказчиков дают по запросу на каждый", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE, TEKTORG_EMPTY_PAGE]);
    const adapter = makeAdapter(impl);

    await adapter.fetchTenders({
      ...baseQuery,
      customerInns: ["7304004049", "2203002720"],
    });

    expect(calls).toHaveLength(2);
    expect(firstBody(calls)).toContain("<customerINN>7304004049</customerINN>");
    expect(String(calls[1]?.init.body)).toContain("<customerINN>2203002720</customerINN>");
  });

  it("склеивает закупки нескольких заказчиков без повторов", async () => {
    const { impl } = stubFetch([TEKTORG_LIVE_RESPONSE, TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({
      ...baseQuery,
      customerInns: ["7304004049", "2203002720"],
    });

    expect(tenders).toHaveLength(3);
  });

  it("обрезает выдачу по limit после отбора, а не до", async () => {
    const { impl } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const tenders = await adapter.fetchTenders({ ...baseQuery, limit: 2 });

    expect(tenders).toHaveLength(2);
  });

  it("пустая выдача — это ноль закупок, а не ошибка", async () => {
    const { impl } = stubFetch([TEKTORG_EMPTY_PAGE]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchTenders(baseQuery)).resolves.toEqual([]);
  });

  it("идёт на вторую страницу, пока площадка говорит, что она есть", async () => {
    const pageOne = TEKTORG_LIVE_RESPONSE.replace(
      "<totalPage>1</totalPage>",
      "<totalPage>2</totalPage>",
    );
    const pageTwo = TEKTORG_LIVE_RESPONSE.replace(
      "<currentPage>1</currentPage>",
      "<currentPage>2</currentPage>",
    );
    const { impl, calls } = stubFetch([pageOne, pageTwo]);
    const adapter = makeAdapter(impl, { pageSize: 2 });

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.init.body)).toContain("<page>2</page>");
    // Одна и та же процедура на двух страницах не должна стать двумя закупками.
    expect(tenders).toHaveLength(3);
  });

  it("не выходит за maxPages, даже если площадка обещает больше", async () => {
    const manyPages = TEKTORG_LIVE_RESPONSE.replace(
      "<totalPage>1</totalPage>",
      "<totalPage>99</totalPage>",
    );
    const { impl, calls } = stubFetch([manyPages]);
    const adapter = makeAdapter(impl, { pageSize: 2, maxPages: 2 });

    await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(2);
  });
});

describe("TektorgTenderSourceAdapter: повторы и отказы", () => {
  it("повторяет HTTP 500 maxRetries раз и затем бросает", async () => {
    const { impl, calls } = stubFetch([500]);
    const adapter = makeAdapter(impl, { maxRetries: 2 });

    await expect(adapter.fetchTenders(baseQuery)).rejects.toThrow(/500/);
    expect(calls).toHaveLength(3);
  });

  it("повторяет сбой сети и отдаёт выдачу, когда площадка ответила", async () => {
    const { impl, calls } = stubFetch([new Error("fetch failed"), TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl, { maxRetries: 2 });

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(2);
    expect(tenders).toHaveLength(3);
  });

  it("повторяет оборванный ответ: это сбой транспорта, а не отказ площадки", async () => {
    const { impl, calls } = stubFetch([TEKTORG_TRUNCATED, TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl, { maxRetries: 1 });

    const tenders = await adapter.fetchTenders(baseQuery);

    expect(calls).toHaveLength(2);
    expect(tenders).toHaveLength(3);
  });

  it("бросает TektorgParseError, когда все повторы вернули обрыв", async () => {
    const { impl, calls } = stubFetch([TEKTORG_TRUNCATED]);
    const adapter = makeAdapter(impl, { maxRetries: 1 });

    await expect(adapter.fetchTenders(baseQuery)).rejects.toBeInstanceOf(TektorgParseError);
    expect(calls).toHaveLength(2);
  });

  it("не повторяет SOAP Fault: отказ площадки повтор не починит", async () => {
    const { impl, calls } = stubFetch([TEKTORG_FAULT]);
    const adapter = makeAdapter(impl, { maxRetries: 3 });

    await expect(adapter.fetchTenders(baseQuery)).rejects.toBeInstanceOf(
      TektorgSoapFaultError,
    );
    expect(calls).toHaveLength(1);
  });

  it("ошибки читаются в журнале человеком, а не «[object Object]»", async () => {
    const http = makeAdapter(stubFetch([503]).impl, { maxRetries: 0 });
    const fault = makeAdapter(stubFetch([TEKTORG_FAULT]).impl);
    const truncated = makeAdapter(stubFetch([TEKTORG_TRUNCATED]).impl, { maxRetries: 0 });

    const [httpText, faultText, truncatedText] = await Promise.all([
      http.fetchTenders(baseQuery).then(() => null, (err: unknown) => describeError(err)),
      fault.fetchTenders(baseQuery).then(() => null, (err: unknown) => describeError(err)),
      truncated.fetchTenders(baseQuery).then(() => null, (err: unknown) => describeError(err)),
    ]);

    expect(httpText).toContain("503");
    expect(httpText).toContain("ТЭК-Торг");
    expect(faultText).toContain("Некорректный период обновления");
    // Текст начинается с заглавной: «Конверт ответа ТЭК-Торга не закрыт…».
    expect(truncatedText?.toLowerCase()).toContain("конверт");
  });

  it("выдерживает паузу между запросами", async () => {
    const { impl, calls } = stubFetch([TEKTORG_EMPTY_PAGE]);
    const adapter = makeAdapter(impl, { rateLimitPerSec: 10 });

    const started = Date.now();
    await adapter.fetchTenders({
      ...baseQuery,
      customerInns: ["7304004049", "2203002720"],
    });
    const elapsed = Date.now() - started;

    expect(calls).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });
});

describe("TektorgTenderSourceAdapter.fetchDocuments", () => {
  it("возвращает документ на каждый адрес из ответа карточки", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const documents = await adapter.fetchDocuments("tektorg-ЗП6082206");

    expect(firstBody(calls)).toContain("<registryNumber>ЗП6082206</registryNumber>");
    expect(documents).toHaveLength(3);
    expect(documents[0]).toMatchObject({
      id: "20236402",
      fileName: "Извещение_инструмент_2_лота.docx",
      url: "https://api.tektorg.ru/open-api/documents/procedure/20236402",
      type: "NOTICE",
      text: "",
    });
  });

  it("определяет тип по имени файла: ТЗ — это техническая документация", async () => {
    const { impl } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const documents = await adapter.fetchDocuments("ЗП610102");

    expect(documents.map((d) => d.type)).toEqual(["TECHNICAL_SPEC", "OTHER"]);
  });

  it("принимает и внутренний id, и номер с префиксом", async () => {
    const { impl } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchDocuments("tektorg-ЗП6091269")).resolves.toHaveLength(1);
    await expect(adapter.fetchDocuments("TEKTORG-ЗП6091269")).resolves.toHaveLength(1);
  });

  it("не отдаёт документ, снятый с публикации: адреса у него нет", async () => {
    const { impl } = stubFetch([TEKTORG_REMOVED_DOCUMENT]);
    const adapter = makeAdapter(impl);

    const documents = await adapter.fetchDocuments("ЗП6082206");

    expect(documents).toHaveLength(1);
    expect(documents[0]?.id).toBe("20499347");
  });

  it("возвращает пустой список для номера ЕИС: площадка игнорирует eisRegistryNumber", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const documents = await adapter.fetchDocuments("32616377511");

    expect(documents).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("возвращает пустой список, когда процедура не нашлась", async () => {
    const { impl } = stubFetch([TEKTORG_EMPTY_PAGE]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchDocuments("ЗП9999999")).resolves.toEqual([]);
  });
});

describe("TektorgTenderSourceAdapter.readDocumentList", () => {
  it("перечисляет и документ, снятый с публикации: загрузчику нужен сам факт", async () => {
    const { impl } = stubFetch([TEKTORG_REMOVED_DOCUMENT]);
    const adapter = makeAdapter(impl);

    const documents = await adapter.readDocumentList("tektorg-ЗП6082206");

    expect(documents).toHaveLength(2);
    expect(documents[0]).toMatchObject({
      id: "20499346",
      filename: "Снятый_с_публикации_документ.docx",
      url: null,
      removed: true,
    });
    expect(documents[1]).toMatchObject({
      id: "20499347",
      filename: "Приложение_№_2_Рекомендуемая_форма_ТКП_ЛадаЛаргус.xlsx",
      removed: false,
      url: "https://api.tektorg.ru/open-api/documents/procedure/20499347",
    });
  });

  it("не ходит в сеть по номеру ЕИС: точечного поиска по нему у площадки нет", async () => {
    const { impl, calls } = stubFetch([TEKTORG_REMOVED_DOCUMENT]);
    const adapter = makeAdapter(impl);

    await expect(adapter.readDocumentList("32616377511")).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("возвращает пустой список, когда процедура не нашлась", async () => {
    const { impl } = stubFetch([TEKTORG_EMPTY_PAGE]);
    const adapter = makeAdapter(impl);

    await expect(adapter.readDocumentList("ЗП9999999")).resolves.toEqual([]);
  });
});

describe("TektorgTenderSourceAdapter.fetchTenderById", () => {
  it("ищет по номеру площадки и возвращает закупку", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const tender = await adapter.fetchTenderById("tektorg-ЗП610102");

    expect(firstBody(calls)).toContain("<registryNumber>ЗП610102</registryNumber>");
    expect(tender?.regNumber).toBe("TEKTORG-ЗП610102");
    expect(tender?.law).toBe("COMMERCIAL");
  });

  it("возвращает null для процедуры, которой нет в ответе, а не бросает", async () => {
    const { impl } = stubFetch([TEKTORG_EMPTY_PAGE]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchTenderById("ЗП9999999")).resolves.toBeNull();
  });

  it("возвращает null, если процедура есть, но под другим номером", async () => {
    const { impl } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchTenderById("ЗП0000001")).resolves.toBeNull();
  });

  it("возвращает null для номера ЕИС: точечного поиска по нему у площадки нет", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    await expect(adapter.fetchTenderById("32616377511")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("TektorgTenderSourceAdapter.checkChanges", () => {
  it("спрашивает дельту изменений от переданной даты", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    const changed = await adapter.checkChanges("ЗП6091269", "2026-09-20T00:00:00+03:00");

    const body = firstBody(calls);
    expect(body).toContain("<startUpdateAt>2026-09-20T00:00:00+03:00</startUpdateAt>");
    expect(body).toContain("<endUpdateAt>2026-10-01T15:00:00+03:00</endUpdateAt>");
    expect(body).toContain("<registryNumber>ЗП6091269</registryNumber>");
    expect(changed).toBe(true);
  });

  it("возвращает false, когда в дельте процедуры нет", async () => {
    const { impl } = stubFetch([TEKTORG_EMPTY_PAGE]);
    const adapter = makeAdapter(impl);

    await expect(
      adapter.checkChanges("ЗП6091269", "2026-09-20T00:00:00+03:00"),
    ).resolves.toBe(false);
  });

  it("возвращает false для номера ЕИС: спросить площадку нечего", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    await expect(
      adapter.checkChanges("32616377511", "2026-09-20T00:00:00+03:00"),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("возвращает false для даты, которую не удалось прочитать", async () => {
    const { impl, calls } = stubFetch([TEKTORG_LIVE_RESPONSE]);
    const adapter = makeAdapter(impl);

    await expect(adapter.checkChanges("ЗП6091269", "не дата")).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});
