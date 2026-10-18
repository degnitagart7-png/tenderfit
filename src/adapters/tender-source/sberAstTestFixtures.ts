/**
 * Фикстуры ответов Сбербанк-АСТ для тестов.
 * Структура полей соответствует реальному ответу POST /api/Processing/main,
 * полученному 21.09.2026 по запросу «ноутбук» в секции коммерческих торгов.
 */
import type { SberPurchaseSource } from "@/adapters/tender-source/sberAstParser";

/** Закупка с идущим приёмом заявок (один лот). */
export const activeSberPurchase: SberPurchaseSource = {
  PurchaseId: "4233572",
  purchCode: "SBR028-2609210061.4",
  PurchaseCodeNoBidTerm: "SBR028-2609210061",
  BidNo: "4",
  purchName: "Закупка ноутбуков - Срочно",
  BidName: "MDH74 Ноутбук Apple MacBook Air 13 M5 10CPU/8GPU/16GB/512GB SSD Silver",
  products: "MDH74 Ноутбук Apple MacBook Air 13 M5 10CPU/8GPU/16GB/512GB SSD Silver",
  CustomerNickName: 'ООО "АЛГОРИТМИКА"',
  CustomerFullName: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "АЛГОРИТМИКА"',
  OrgName: 'ООО "АЛГОРИТМИКА"',
  CustomerInn: "7704386240",
  OrgInn: "7704386240",
  purchAmount: "8943377",
  purchAmountRUB: "8943377",
  purchCurrency: "RUB",
  RegionName: "Москва",
  orgContacts: "117105, Г.МОСКВА, Ш. ВАРШАВСКОЕ, Д. 1, СТР. 6, ПОМЕЩ. 18/2",
  PublicDate: "21.09.2026 19:03",
  RequestDate: "24.09.2026 18:50",
  RequestAcceptDate: "24.09.2026 18:50",
  RequestStartDate: "21.09.2026 19:15",
  EndDate: "25.09.2026",
  LastActionDt: "21.09.2026 19:15",
  purchUpdateAt: "21.09.2026 19:15",
  lastChange: "21.09.2026 19:03",
  PurchaseTypeName: "Запрос котировок (закупка, с ЭП)",
  PurchaseWayTerm: "Закупка",
  PurchaseGroupTerm: "На понижение (закупка) с применением электронной подписи",
  isIncrease: "false",
  PurchaseStageTerm: "Подача заявок",
  purchStateName: "Прием заявок",
  IsInArchive: "0",
  IsSMPTerm: "Нет",
  NationalRegimeType: null,
  objectHrefTerm: "https://utp.sberbank-ast.ru/VIP/NBT/PurchaseView/48/0/0/4233572",
  SourceTerm: "Торги коммерческих заказчиков",
};

/** Второй лот той же закупки: другая сумма и более ранний срок подачи. */
export const siblingLotSberPurchase: SberPurchaseSource = {
  ...activeSberPurchase,
  purchCode: "SBR028-2609210061.1",
  BidNo: "1",
  BidName: "Ноутбук Lenovo ThinkPad E14",
  purchAmount: "2025093",
  purchAmountRUB: "2025093",
  RequestDate: "23.09.2026 10:00",
  RequestAcceptDate: "23.09.2026 10:00",
  LastActionDt: "22.09.2026 09:00",
  purchUpdateAt: "22.09.2026 09:00",
};

/** Закупка, где заявки уже не принимают. */
export const closedSberPurchase: SberPurchaseSource = {
  ...activeSberPurchase,
  purchCode: "SBR028-2609200011.1",
  PurchaseCodeNoBidTerm: "SBR028-2609200011",
  BidNo: "1",
  purchName: "Поставка оргтехники",
  purchStateName: "Рассмотрение заявок",
  PurchaseStageTerm: "Определение победителя",
  RequestDate: "23.09.2026 10:00",
};

/** Завершённая закупка. */
export const finishedSberPurchase: SberPurchaseSource = {
  ...activeSberPurchase,
  purchCode: "SBR028-2608100022.1",
  PurchaseCodeNoBidTerm: "SBR028-2608100022",
  BidNo: "1",
  purchName: "Поставка серверов",
  purchStateName: "Завершен(-а)",
  PurchaseStageTerm: "Завершено",
};

/** Отменённая закупка. */
export const cancelledSberPurchase: SberPurchaseSource = {
  ...activeSberPurchase,
  purchCode: "SBR028-2608100033.1",
  PurchaseCodeNoBidTerm: "SBR028-2608100033",
  BidNo: "1",
  purchName: "Поставка мониторов",
  purchStateName: "Отменен(-а)",
  PurchaseStageTerm: "Отменено",
};

/** Процедура обоснования НМЦ — сбор цен, заявки не подаются. */
export const priceResearchSberPurchase: SberPurchaseSource = {
  ...activeSberPurchase,
  purchCode: "SBR028-2609190044.1",
  PurchaseCodeNoBidTerm: "SBR028-2609190044",
  BidNo: "1",
  purchName: "Обоснование НМЦ на поставку ноутбуков",
  PurchaseTypeName: "Процедура обоснования начальной максимальной цены (с ЭП)",
  purchStateName: "В процессе проведения",
  PurchaseStageTerm: "Определение победителя",
  RequestDate: null,
};

/** Архивная закупка. */
export const archivedSberPurchase: SberPurchaseSource = {
  ...activeSberPurchase,
  purchCode: "SBR028-2509200055.1",
  PurchaseCodeNoBidTerm: "SBR028-2509200055",
  BidNo: "1",
  purchName: "Поставка принтеров",
  IsInArchive: "1",
};

/** Закупка без опубликованной цены (часто у запросов предложений). */
export const noPriceSberPurchase: SberPurchaseSource = {
  ...activeSberPurchase,
  purchCode: "SBR028-2609210077.1",
  PurchaseCodeNoBidTerm: "SBR028-2609210077",
  BidNo: "1",
  purchName: "Открытый запрос предложений на ремонт помещения",
  purchAmount: null,
  purchAmountRUB: null,
};

/** «Момент времени» для детерминированных тестов. */
export const TEST_NOW = new Date("2026-09-21T12:00:00.000Z");

/**
 * Продажа имущества — аукцион «на повышение».
 * Форма полей взята из живой записи SBR028-2608280041 (продажа автомобиля).
 * В ленту поставщика такие записи попадать не должны.
 */
export const saleSberPurchase: SberPurchaseSource = {
  ...activeSberPurchase,
  PurchaseId: "4210037",
  purchCode: "SBR028-2608280041.1",
  PurchaseCodeNoBidTerm: "SBR028-2608280041",
  BidNo: "1",
  purchName: "Продажа транспортного средства - Audi A8L - XW8ZZZ4H4HG001810",
  BidName: "Продажа транспортного средства - Audi A8L - XW8ZZZ4H4HG001810",
  products: "Продажа транспортного средства - Audi A8L - XW8ZZZ4H4HG001810",
  purchAmount: "2110600",
  purchAmountRUB: "2110600",
  PurchaseTypeName: "Аукцион (продажа, с ЭП)",
  PurchaseWayTerm: "Продажа",
  PurchaseGroupTerm: "На повышение (продажа) с применением электронной подписи",
  isIncrease: "true",
  objectHrefTerm: "https://utp.sberbank-ast.ru/VIP/NBT/PurchaseView/43/0/0/4210037",
};

/** Собирает тело поискового ответа площадки из списка закупок. */
export function buildSberResponse(
  sources: SberPurchaseSource[],
  total: number = sources.length,
): string {
  return JSON.stringify({
    took: 12,
    timed_out: false,
    _shards: { total: 5, successful: 5, skipped: 0, failed: 0 },
    PurchState: { PurchStatusNameAggr: [] },
    PurchaseList: sources.map((source, i) => ({
      _id: `${source.purchCode ?? i}`,
      _source: source,
      highlight: {},
      sort: [i],
    })),
    Aggregation: {},
    Total: total,
  });
}

/**
 * Ответ с единственным результатом: площадка отдаёт PurchaseList объектом,
 * а не массивом из одного элемента (проверено на живом API).
 */
export function buildSberSingleResponse(source: SberPurchaseSource): string {
  return JSON.stringify({
    took: 189,
    timed_out: false,
    _shards: { total: 48, successful: 48, skipped: 0, failed: 0 },
    PurchState: { PurchStatusNameAggr: [] },
    PurchaseList: {
      _index: "purchase",
      _type: "_doc",
      _id: `${source.purchCode ?? ""}`,
      _score: null,
      _source: source,
      sort: [0],
    },
    Aggregation: {},
    Total: 1,
  });
}

/** Пустая выдача: площадка отдаёт PurchaseList: null (проверено на живом API). */
export function buildSberEmptyResponse(): string {
  return JSON.stringify({
    took: 7,
    timed_out: false,
    _shards: { total: 48, successful: 48, skipped: 0, failed: 0 },
    PurchState: { PurchStatusNameAggr: [] },
    PurchaseList: null,
    Aggregation: {},
    Total: 0,
  });
}
