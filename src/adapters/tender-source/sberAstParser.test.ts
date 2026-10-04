import { describe, expect, it } from "vitest";
import type { Tender } from "@/domain/entities";
import type { SberPurchaseSource } from "@/adapters/tender-source/sberAstParser";
import {
  SBER_COMMERCIAL_SOURCE_TERM,
  buildSberFilterBody,
  buildSberRequestBody,
  isSberPurchaseActive,
  isSberSale,
  mapSberPlacingWay,
  mapSberPurchase,
  mergeSberPurchases,
  parseSberAmount,
  parseSberDateTime,
  parseSberSearchPayload,
  sberBidKey,
  sberPurchaseCode,
} from "@/adapters/tender-source/sberAstParser";
import {
  TEST_NOW,
  activeSberPurchase,
  archivedSberPurchase,
  buildSberEmptyResponse,
  buildSberResponse,
  buildSberSingleResponse,
  cancelledSberPurchase,
  closedSberPurchase,
  finishedSberPurchase,
  noPriceSberPurchase,
  priceResearchSberPurchase,
  saleSberPurchase,
  siblingLotSberPurchase,
} from "@/adapters/tender-source/sberAstTestFixtures";

describe("buildSberFilterBody", () => {
  it("собирает XML с ключевым словом, секцией и периодом", () => {
    const body = buildSberFilterBody({
      keyword: "ноутбук",
      page: 0,
      pageSize: 50,
      dateFrom: new Date("2026-06-23T00:00:00Z"),
      dateTo: new Date("2026-09-21T00:00:00Z"),
    });
    expect(body).toContain("<targetPageCode>OTUnitedPurchaseList</targetPageCode>");
    expect(body).toContain(`<sourceTerm>${SBER_COMMERCIAL_SOURCE_TERM}</sourceTerm>`);
    expect(body).toContain("<searchBarType>anyWord</searchBarType>");
    expect(body).toContain("<mainInput>ноутбук</mainInput>");
    expect(body).toContain("<pagenum>0</pagenum>");
    expect(body).toContain("<pagesize>50</pagesize>");
    expect(body).toContain("<startPublicDate>23.06.2026</startPublicDate>");
    expect(body).toContain("<endPublicDate>21.09.2026 23:59:59</endPublicDate>");
  });

  it("экранирует спецсимволы XML в ключевом слове", () => {
    const body = buildSberFilterBody({
      keyword: 'ремонт & <обслуживание> "котельной"',
      dateFrom: new Date("2026-09-01T00:00:00Z"),
      dateTo: new Date("2026-09-21T00:00:00Z"),
    });
    expect(body).toContain("ремонт &amp; &lt;обслуживание&gt; &quot;котельной&quot;");
    expect(body).not.toContain("<обслуживание>");
  });

  it("не допускает отрицательных номера страницы и размера", () => {
    const body = buildSberFilterBody({
      page: -5,
      pageSize: 0,
      dateFrom: new Date("2026-09-01T00:00:00Z"),
      dateTo: new Date("2026-09-21T00:00:00Z"),
    });
    expect(body).toContain("<pagenum>0</pagenum>");
    expect(body).toContain("<pagesize>1</pagesize>");
  });
});

describe("buildSberRequestBody", () => {
  it("формирует тело запроса к Processing/main", () => {
    const body = buildSberRequestBody("<query/>");
    expect(body).toEqual({
      windowCode: "/EsOpenUnitedPurchaseList",
      actionType: "MONITOR",
      actionCode: "default",
      filterBody: "<query/>",
      parm: "es",
    });
  });
});

describe("parseSberAmount", () => {
  it("разбирает целую сумму строкой", () => {
    expect(parseSberAmount("8943377")).toBe(8943377);
  });
  it("разбирает дробную сумму", () => {
    expect(parseSberAmount("1093411.81")).toBe(1093411.81);
  });
  it("разбирает сумму с пробелами и запятой", () => {
    expect(parseSberAmount("1 093 411,81")).toBe(1093411.81);
  });
  it("возвращает null для пустых значений", () => {
    expect(parseSberAmount("")).toBeNull();
    expect(parseSberAmount(null)).toBeNull();
    expect(parseSberAmount(undefined)).toBeNull();
  });
  it("принимает число", () => {
    expect(parseSberAmount(2500000)).toBe(2500000);
  });
});

describe("parseSberDateTime", () => {
  it("переводит московское время в UTC", () => {
    expect(parseSberDateTime("21.09.2026 19:03")).toBe("2026-09-21T16:03:00.000Z");
  });
  it("поддерживает секунды", () => {
    expect(parseSberDateTime("24.09.2026 18:50:30")).toBe("2026-09-24T15:50:30.000Z");
  });
  it("дату без времени считает московской полночью", () => {
    expect(parseSberDateTime("25.09.2026")).toBe("2026-09-24T21:00:00.000Z");
  });
  it("возвращает null для пустых и нераспознанных значений", () => {
    expect(parseSberDateTime(null)).toBeNull();
    expect(parseSberDateTime("")).toBeNull();
    expect(parseSberDateTime("не дата")).toBeNull();
  });
  it("учитывает переданное смещение часового пояса", () => {
    expect(parseSberDateTime("21.09.2026 19:03", 0)).toBe("2026-09-21T19:03:00.000Z");
  });
});

describe("mapSberPlacingWay", () => {
  it("определяет запрос котировок", () => {
    expect(mapSberPlacingWay("Запрос котировок (закупка, с ЭП)")).toBe(
      "REQUEST_FOR_QUOTATION",
    );
  });
  it("определяет запрос предложений", () => {
    expect(mapSberPlacingWay("Запрос предложений (закупка, без ЭП)")).toBe(
      "REQUEST_FOR_PROPOSALS",
    );
  });
  it("определяет аукцион", () => {
    expect(mapSberPlacingWay("Открытый аукцион")).toBe("ELECTRONIC_AUCTION");
  });
  it("определяет конкурс", () => {
    expect(mapSberPlacingWay("Открытый конкурс")).toBe("OPEN_CONTEST");
  });
  it("определяет запрос цен как котировки", () => {
    expect(mapSberPlacingWay("Запрос цен")).toBe("REQUEST_FOR_QUOTATION");
  });
  it("определяет закупку у единственного поставщика", () => {
    expect(mapSberPlacingWay("Закупка у единственного поставщика")).toBe(
      "SOLE_SUPPLIER",
    );
  });
  it("обоснование НМЦ не является способом закупки", () => {
    expect(
      mapSberPlacingWay("Процедура обоснования начальной максимальной цены (с ЭП)"),
    ).toBe("OTHER");
  });
  it("пустое название даёт иной способ", () => {
    expect(mapSberPlacingWay(null)).toBe("OTHER");
  });
});

describe("isSberPurchaseActive", () => {
  it("приём заявок — активна", () => {
    expect(isSberPurchaseActive(activeSberPurchase, TEST_NOW)).toBe(true);
  });
  it("рассмотрение заявок — уже не активна", () => {
    expect(isSberPurchaseActive(closedSberPurchase, TEST_NOW)).toBe(false);
  });
  it("завершённая закупка — не активна", () => {
    expect(isSberPurchaseActive(finishedSberPurchase, TEST_NOW)).toBe(false);
  });
  it("отменённая закупка — не активна", () => {
    expect(isSberPurchaseActive(cancelledSberPurchase, TEST_NOW)).toBe(false);
  });
  it("обоснование НМЦ — не активна", () => {
    expect(isSberPurchaseActive(priceResearchSberPurchase, TEST_NOW)).toBe(false);
  });
  it("архивная закупка — не активна", () => {
    expect(isSberPurchaseActive(archivedSberPurchase, TEST_NOW)).toBe(false);
  });
  it("просроченный приём заявок — не активна", () => {
    expect(
      isSberPurchaseActive(activeSberPurchase, new Date("2026-09-25T00:00:00Z")),
    ).toBe(false);
  });
});

describe("sberPurchaseCode", () => {
  it("берёт код закупки без номера лота", () => {
    expect(sberPurchaseCode(activeSberPurchase)).toBe("SBR028-2609210061");
  });
  it("отбрасывает номер лота от purchCode, если кода закупки нет", () => {
    expect(
      sberPurchaseCode({ ...activeSberPurchase, PurchaseCodeNoBidTerm: null }),
    ).toBe("SBR028-2609210061");
  });
  it("оставляет код без лота как есть", () => {
    expect(
      sberPurchaseCode({
        ...activeSberPurchase,
        PurchaseCodeNoBidTerm: null,
        purchCode: "SBR028-2609210061",
      }),
    ).toBe("SBR028-2609210061");
  });
});

describe("sberBidKey", () => {
  it("ключом является номер лота", () => {
    const tender = mapSberPurchase(activeSberPurchase);
    expect(tender && sberBidKey(tender)).toBe("SBR028-2609210061.4");
  });

  it("разные лоты одной закупки дают разные ключи", () => {
    const a = mapSberPurchase(activeSberPurchase);
    const b = mapSberPurchase(siblingLotSberPurchase);
    if (!a || !b) throw new Error("Фикстуры должны маппиться");
    expect(sberBidKey(a)).toBe("SBR028-2609210061.4");
    expect(sberBidKey(b)).toBe("SBR028-2609210061.1");
  });
});

describe("mapSberPurchase", () => {
  const tender = mapSberPurchase(activeSberPurchase);

  it("заполняет идентификаторы и закон", () => {
    expect(tender?.id).toBe("sber-SBR028-2609210061");
    expect(tender?.regNumber).toBe("SBR028-2609210061");
    expect(tender?.externalId).toBe("4233572");
    expect(tender?.law).toBe("COMMERCIAL");
    expect(tender?.dataSource).toBe("SBER_AST");
  });

  it("переносит предмет, заказчика и регион", () => {
    expect(tender?.subject).toBe("Закупка ноутбуков - Срочно");
    expect(tender?.customerName).toBe('ООО "АЛГОРИТМИКА"');
    expect(tender?.customerInn).toBe("7704386240");
    expect(tender?.region).toBe("Москва");
    expect(tender?.deliveryAddress).toContain("ВАРШАВСКОЕ");
  });

  it("переносит сумму и валюту", () => {
    expect(tender?.financial.price).toBe(8943377);
    expect(tender?.financial.currency).toBe("RUB");
  });

  it("переносит сроки в ISO", () => {
    expect(tender?.deadlines.submissionEnd).toBe("2026-09-24T15:50:00.000Z");
    expect(tender?.deadlines.publicationDate).toBe("2026-09-21T16:03:00.000Z");
    expect(tender?.deadlines.lastUpdateDate).toBe("2026-09-21T16:15:00.000Z");
  });

  it("сохраняет ссылку на карточку площадки", () => {
    expect(tender?.eisUrl).toBe(
      "https://utp.sberbank-ast.ru/VIP/NBT/PurchaseView/48/0/0/4233572",
    );
  });

  it("создаёт один лот с номером и предметом из выдачи", () => {
    expect(tender?.lots).toHaveLength(1);
    expect(tender?.lots[0]?.id).toBe("SBR028-2609210061.4");
    expect(tender?.lots[0]?.number).toBe(4);
    expect(tender?.lots[0]?.price).toBe(8943377);
    expect(tender?.lots[0]?.subject).toContain("MacBook Air");
  });

  it("номер лота по умолчанию 1, если BidNo не число", () => {
    const mapped = mapSberPurchase({ ...activeSberPurchase, BidNo: null });
    expect(mapped?.lots[0]?.number).toBe(1);
  });

  it("берёт предмет из лота, если название закупки пустое", () => {
    const mapped = mapSberPurchase({ ...activeSberPurchase, purchName: "" });
    expect(mapped?.subject).toContain("MacBook Air");
  });

  it("возвращает null без номера лота", () => {
    expect(mapSberPurchase({ ...activeSberPurchase, purchCode: null })).toBeNull();
  });

  it("возвращает null без кода закупки", () => {
    expect(
      mapSberPurchase({
        ...activeSberPurchase,
        purchCode: null,
        PurchaseCodeNoBidTerm: null,
      }),
    ).toBeNull();
  });

  it("возвращает null без предмета", () => {
    expect(
      mapSberPurchase({
        ...activeSberPurchase,
        purchName: "",
        BidName: null,
        products: "",
      }),
    ).toBeNull();
  });

  it("цена null превращается в 0", () => {
    const mapped = mapSberPurchase(noPriceSberPurchase);
    expect(mapped?.financial.price).toBe(0);
    expect(mapped?.lots[0]?.price).toBe(0);
  });
});

describe("mergeSberPurchases", () => {
  const lots = [activeSberPurchase, siblingLotSberPurchase]
    .map((source) => mapSberPurchase(source))
    .filter((tender): tender is Tender => tender !== null);

  it("фикстуры — два лота одной закупки", () => {
    expect(lots).toHaveLength(2);
    expect(lots.every((t) => t.regNumber === "SBR028-2609210061")).toBe(true);
  });

  it("склеивает лоты одной закупки в одну карточку", () => {
    const merged = mergeSberPurchases(lots);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.regNumber).toBe("SBR028-2609210061");
    expect(merged[0]?.id).toBe("sber-SBR028-2609210061");
  });

  it("суммирует цены лотов", () => {
    const merged = mergeSberPurchases(lots);
    expect(merged[0]?.financial.price).toBe(8943377 + 2025093);
  });

  it("собирает все лоты и сортирует их по номеру", () => {
    const merged = mergeSberPurchases(lots);
    expect(merged[0]?.lots.map((lot) => lot.number)).toEqual([1, 4]);
    expect(merged[0]?.lots.map((lot) => lot.id)).toEqual([
      "SBR028-2609210061.1",
      "SBR028-2609210061.4",
    ]);
  });

  it("берёт самый ранний срок подачи заявок", () => {
    const merged = mergeSberPurchases(lots);
    expect(merged[0]?.deadlines.submissionEnd).toBe("2026-09-23T07:00:00.000Z");
  });

  it("берёт самое позднее обновление", () => {
    const merged = mergeSberPurchases(lots);
    expect(merged[0]?.deadlines.lastUpdateDate).toBe("2026-09-22T06:00:00.000Z");
  });

  it("не склеивает разные закупки", () => {
    const closed = mapSberPurchase(closedSberPurchase);
    const merged = mergeSberPurchases(closed ? [...lots, closed] : lots);
    expect(merged).toHaveLength(2);
    expect(merged.map((t) => t.regNumber)).toEqual([
      "SBR028-2609210061",
      "SBR028-2609200011",
    ]);
  });

  it("одиночная закупка остаётся без изменений", () => {
    const single = mapSberPurchase(activeSberPurchase);
    const merged = mergeSberPurchases(single ? [single] : []);
    expect(merged[0]?.financial.price).toBe(8943377);
    expect(merged[0]?.lots).toHaveLength(1);
  });
});

describe("parseSberSearchPayload", () => {
  it("оставляет только активные закупки", () => {
    const payload = buildSberResponse([
      activeSberPurchase,
      closedSberPurchase,
      finishedSberPurchase,
      cancelledSberPurchase,
      priceResearchSberPurchase,
      archivedSberPurchase,
    ]);
    const result = parseSberSearchPayload(payload, { now: TEST_NOW });
    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0]?.regNumber).toBe("SBR028-2609210061");
    expect(result.returned).toBe(6);
    expect(result.total).toBe(6);
  });

  it("лоты одной закупки отдаёт отдельными записями — склеивает их адаптер", () => {
    const payload = buildSberResponse([activeSberPurchase, siblingLotSberPurchase]);
    const result = parseSberSearchPayload(payload, { now: TEST_NOW });
    expect(result.tenders).toHaveLength(2);
    expect(result.tenders.every((t) => t.regNumber === "SBR028-2609210061")).toBe(true);
  });

  it("в режиме activeOnly=false отдаёт все закупки", () => {
    const payload = buildSberResponse([activeSberPurchase, finishedSberPurchase], 2);
    const result = parseSberSearchPayload(payload, { activeOnly: false });
    expect(result.tenders).toHaveLength(2);
  });

  it("разворачивает браузерную обёртку { data: \"…\" }", () => {
    const inner = buildSberResponse([activeSberPurchase], 1);
    const wrapped = JSON.stringify({ data: inner });
    const result = parseSberSearchPayload(wrapped, { now: TEST_NOW });
    expect(result.tenders).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("читает Total как число и как строку", () => {
    const payload = JSON.parse(buildSberResponse([activeSberPurchase], 390));
    payload["Total"] = "390";
    const result = parseSberSearchPayload(JSON.stringify(payload), { now: TEST_NOW });
    expect(result.total).toBe(390);
  });

  it("бросает ошибку на HTML вместо JSON", () => {
    expect(() => parseSberSearchPayload("<html>503 Service Unavailable</html>")).toThrow(
      /не JSON/,
    );
  });

  it("бросает ошибку на неожиданной форме ответа", () => {
    expect(() => parseSberSearchPayload('{"error":"access denied"}')).toThrow(
      /PurchaseList/,
    );
  });

  it("отбрасывает продажи имущества", () => {
    const payload = buildSberResponse([activeSberPurchase, saleSberPurchase]);
    const result = parseSberSearchPayload(payload, { now: TEST_NOW });
    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0]?.regNumber).toBe("SBR028-2609210061");
    expect(result.returned).toBe(2);
  });

  it("отбрасывает продажи и при activeOnly=false", () => {
    const payload = buildSberResponse([saleSberPurchase], 1);
    const result = parseSberSearchPayload(payload, { activeOnly: false });
    expect(result.tenders).toHaveLength(0);
  });

  it("читает PurchaseList объектом, когда результат один", () => {
    const result = parseSberSearchPayload(buildSberSingleResponse(activeSberPurchase), {
      now: TEST_NOW,
    });
    expect(result.tenders).toHaveLength(1);
    expect(result.tenders[0]?.regNumber).toBe("SBR028-2609210061");
    expect(result.returned).toBe(1);
    expect(result.total).toBe(1);
  });

  it("пустая выдача с PurchaseList: null даёт ноль закупок, а не ошибку", () => {
    const result = parseSberSearchPayload(buildSberEmptyResponse(), { now: TEST_NOW });
    expect(result.tenders).toHaveLength(0);
    expect(result.returned).toBe(0);
    expect(result.total).toBe(0);
  });
});

describe("isSberSale", () => {
  it("распознаёт продажу по PurchaseWayTerm", () => {
    expect(isSberSale(saleSberPurchase)).toBe(true);
  });

  it("закупка — не продажа", () => {
    expect(isSberSale(activeSberPurchase)).toBe(false);
  });

  it("без PurchaseWayTerm смотрит на группу торгов", () => {
    const source: SberPurchaseSource = {
      ...saleSberPurchase,
      PurchaseWayTerm: null,
      PurchaseGroupTerm: "На повышение (продажа) с применением электронной подписи",
      isIncrease: "false",
      PurchaseTypeName: "Аукцион в электронной форме",
    };
    expect(isSberSale(source)).toBe(true);
  });

  it("без группы торгов смотрит на признак повышения цены", () => {
    const source: SberPurchaseSource = {
      ...saleSberPurchase,
      PurchaseWayTerm: null,
      PurchaseGroupTerm: null,
      isIncrease: "true",
      PurchaseTypeName: "Аукцион в электронной форме",
    };
    expect(isSberSale(source)).toBe(true);
  });

  it("последний признак — название процедуры", () => {
    const source: SberPurchaseSource = {
      ...saleSberPurchase,
      PurchaseWayTerm: null,
      PurchaseGroupTerm: null,
      isIncrease: null,
      PurchaseTypeName: "Аукцион (продажа, с ЭП)",
    };
    expect(isSberSale(source)).toBe(true);
  });

  it("без признаков направления считает закупкой", () => {
    const source: SberPurchaseSource = {
      ...saleSberPurchase,
      PurchaseWayTerm: null,
      PurchaseGroupTerm: null,
      isIncrease: null,
      PurchaseTypeName: null,
    };
    expect(isSberSale(source)).toBe(false);
  });
});
