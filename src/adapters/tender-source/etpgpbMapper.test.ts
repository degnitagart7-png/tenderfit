import { describe, expect, it } from "vitest";
import { UNKNOWN_CUSTOMER, UNKNOWN_REGION } from "@/domain/entities";
import { parseEtpgpbCard } from "@/adapters/tender-source/etpgpbCard";
import type { EtpgpbCard, EtpgpbCompany, EtpgpbLot } from "@/adapters/tender-source/etpgpbCard";
import {
  ETPGPB_CARD_COMMERCE,
  ETPGPB_CARD_ETP_CLICK,
  ETPGPB_CARD_ETP_EIS11,
  ETPGPB_CARD_ETP_PRICE_UNKNOWN,
  ETPGPB_CARD_GAZ_EIS_URL,
  ETPGPB_CARD_SALE,
} from "@/adapters/tender-source/etpgpbCardFixtures";
import {
  etpgpbDeadlineMs,
  etpgpbEisNumber,
  etpgpbIsAccepting,
  etpgpbIsPropertySale,
  etpgpbLaw,
  etpgpbPlacingWay,
  etpgpbRegNumber,
  mapEtpgpbCard,
  parseMoscowDateTime,
} from "@/adapters/tender-source/etpgpbMapper";
import { SYNTHETIC_CONTACT_PATTERN, nuxtPage, withSyntheticContacts } from "@/adapters/tender-source/etpgpbTestFixtures";

function fixtureCard(fixture: { url: string; table: unknown[] }): EtpgpbCard {
  const card = parseEtpgpbCard(nuxtPage(fixture.table), fixture.url);
  if (card === null) throw new Error(`фикстура не разобрана: ${fixture.url}`);
  return card;
}

const company = (overrides: Partial<EtpgpbCompany> = {}): EtpgpbCompany => ({
  name: "ООО «ТЕСТ»",
  shortName: "ООО «ТЕСТ»",
  fullName: "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ «ТЕСТ»",
  inn: "7700000001",
  kpp: "770001001",
  address: "",
  ...overrides,
});

const lot = (overrides: Partial<EtpgpbLot> = {}): EtpgpbLot => ({
  id: "1",
  number: 1,
  title: "",
  subject: "Предмет лота",
  startPrice: null,
  currency: "",
  dateEndRegistration: null,
  responseDate: null,
  deliveryAddress: "",
  region: "",
  nationalMode: false,
  ...overrides,
});

/** Карточка из ничего: каждый тест задаёт только то, что проверяет. */
function makeCard(overrides: Partial<EtpgpbCard> = {}): EtpgpbCard {
  return {
    kind: "etp",
    platformId: "100",
    path: "/procedures/etp/100-test-protsedura/",
    registryNumber: "АП000001",
    title: "Тестовая процедура",
    stage: "accepting",
    amount: null,
    priceUnknown: false,
    currency: "RUB",
    region: "",
    regions: [],
    lotRegions: [],
    applicationEnd: null,
    datePublished: "2026-10-10T10:00:00.000+03:00",
    dateLastUpdate: null,
    eisUrl: null,
    procedureNumber: null,
    procedureTypeName: "",
    platform: "Закупки корпоративных заказчиков",
    sectionDescription: "Закупки корпоративных заказчиков",
    templateType: "common",
    customerAddress: "",
    flags: { auction: false, competition: false, requestOffers: false, requestQuotes: false, smsp: false, nationalMode: false },
    organizer: null,
    customers: [],
    lots: [],
    docs: [],
    regionNames: [],
    okpds: [],
    ...overrides,
  };
}

describe("ключ записи (regNumber)", () => {
  it("номер ЕИС из eis_url имеет приоритет над номером площадки", () => {
    const card = makeCard({
      registryNumber: "АП123903",
      eisUrl: "https://zakupki.gov.ru/223/purchase/public/purchase/info/common-info.html?regNumber=32616379968",
    });
    expect(etpgpbRegNumber(card)).toBe("32616379968");
    expect(etpgpbEisNumber(card)).toBe("32616379968");
  });

  it("11 цифр в номере площадки — это номер извещения ЕИС, и он идёт как есть", () => {
    expect(etpgpbRegNumber(makeCard({ registryNumber: "32616467295" }))).toBe("32616467295");
  });

  it("иначе — ETPGPB-<номер площадки>, как и у номеров с буквами и других длин", () => {
    expect(etpgpbRegNumber(makeCard({ registryNumber: "АП125184" }))).toBe("ETPGPB-АП125184");
    expect(etpgpbRegNumber(makeCard({ registryNumber: "КП000008835" }))).toBe("ETPGPB-КП000008835");
    expect(etpgpbRegNumber(makeCard({ registryNumber: "1026139" }))).toBe("ETPGPB-1026139");
    expect(etpgpbRegNumber(makeCard({ registryNumber: "17793" }))).toBe("ETPGPB-17793");
    // 10 и 12 цифр — не извещение 223-ФЗ.
    expect(etpgpbRegNumber(makeCard({ registryNumber: "3261646729" }))).toBe("ETPGPB-3261646729");
    expect(etpgpbRegNumber(makeCard({ registryNumber: "326164672951" }))).toBe("ETPGPB-326164672951");
  });

  it("у eis_url без номера ссылка не считается номером", () => {
    const card = makeCard({ eisUrl: "https://zakupki.gov.ru/epz/order/notice/", registryNumber: "АП1" });
    expect(etpgpbEisNumber(card)).toBeNull();
    expect(etpgpbRegNumber(card)).toBe("ETPGPB-АП1");
  });

  it("номера площадки нет совсем — вид и номер процедуры в адресе", () => {
    expect(etpgpbRegNumber(makeCard({ registryNumber: "", kind: "gaz", platformId: "259022" }))).toBe("ETPGPB-gaz-259022");
  });
});

describe("закон", () => {
  it("есть номер ЕИС (ссылка или 11 цифр) — 223-ФЗ, иначе коммерческая закупка", () => {
    expect(etpgpbLaw(makeCard({ registryNumber: "32616467295" }))).toBe("FZ_223");
    expect(etpgpbLaw(makeCard({ eisUrl: "https://zakupki.gov.ru/x?regNumber=32616379968", registryNumber: "АП1" }))).toBe("FZ_223");
    expect(etpgpbLaw(makeCard({ registryNumber: "АП1" }))).toBe("COMMERCIAL");
  });

  it("legal_regulation площадки не читается вовсе: она всегда 0", () => {
    // Поля в записи нет, а закон одинаков при любом её значении в карточке.
    expect("legalRegulation" in makeCard()).toBe(false);
  });
});

describe("срок приёма заявок", () => {
  it("московское время без зоны: 23.10.2026 03:00 → 23.10 00:00 UTC", () => {
    expect(parseMoscowDateTime("23.10.2026 03:00")).toBe(Date.UTC(2026, 9, 23, 0, 0));
    expect(parseMoscowDateTime("22.10.2026 00:00")).toBe(Date.UTC(2026, 9, 21, 21, 0));
    expect(parseMoscowDateTime("1.2.2026 9:05")).toBe(Date.UTC(2026, 1, 1, 6, 5));
  });

  it("дата без времени — начало суток по Москве; невозможная дата и мусор — null", () => {
    expect(parseMoscowDateTime("23.10.2026")).toBe(Date.UTC(2026, 9, 22, 21, 0));
    expect(parseMoscowDateTime("31.02.2026 10:00")).toBeNull();
    expect(parseMoscowDateTime("32.10.2026 10:00")).toBeNull();
    expect(parseMoscowDateTime("дата не указана")).toBeNull();
    expect(parseMoscowDateTime(null)).toBeNull();
  });

  it("поле процедуры приоритетнее лотов", () => {
    const card = makeCard({
      applicationEnd: "23.10.2026 03:00",
      lots: [lot({ dateEndRegistration: "2026-10-30T10:00:00.000+03:00" })],
    });
    expect(etpgpbDeadlineMs(card)).toBe(Date.UTC(2026, 9, 23, 0, 0));
  });

  it("иначе берётся самая ранняя дата окончания приёма среди лотов", () => {
    const card = makeCard({
      lots: [
        lot({ id: "1", dateEndRegistration: "2026-10-30T10:00:00.000+03:00" }),
        lot({ id: "2", dateEndRegistration: "2026-10-25T10:00:00.000+03:00" }),
        lot({ id: "3", dateEndRegistration: null }),
      ],
    });
    expect(etpgpbDeadlineMs(card)).toBe(Date.parse("2026-10-25T10:00:00.000+03:00"));
  });

  it("у etp_click срока приёма нет, срок — response_date лота", () => {
    const card = makeCard({ lots: [lot({ responseDate: "2026-10-20T12:00:00.000+03:00" })] });
    expect(etpgpbDeadlineMs(card)).toBe(Date.parse("2026-10-20T09:00:00.000Z"));
  });

  it("нигде нет — пустая строка, а не выдуманная дата", () => {
    expect(etpgpbDeadlineMs(makeCard())).toBeNull();
    expect(mapEtpgpbCard(makeCard({ lots: [lot()] }))?.deadlines.submissionEnd).toBe("");
  });
});

describe("цена", () => {
  const price = (overrides: Partial<EtpgpbCard>) => mapEtpgpbCard(makeCard(overrides))?.financial.price;

  it("amount больше нуля — цена закупки", () => {
    expect(price({ amount: 233573567.86, lots: [lot({ startPrice: 1 })] })).toBe(233573567.86);
  });

  it("amount «0.0» и отметка «цена не указана» — цена неизвестна (0), а не бесплатная закупка", () => {
    expect(price({ amount: 0, priceUnknown: true, lots: [lot()] })).toBe(0);
    expect(price({ amount: null, lots: [lot()] })).toBe(0);
  });

  it("amount пуст, у единственного лота есть цена — берётся она", () => {
    expect(price({ amount: 0, lots: [lot({ startPrice: 99000.5 })] })).toBe(99000.5);
  });

  it("цена у всех лотов — сумма; хотя бы у одного нет — неизвестна: часть не выдаётся за целое", () => {
    expect(price({ amount: null, lots: [lot({ id: "1", startPrice: 100 }), lot({ id: "2", startPrice: 250 })] })).toBe(350);
    expect(price({ amount: null, lots: [lot({ id: "1", startPrice: 100 }), lot({ id: "2", startPrice: null })] })).toBe(0);
    expect(price({ amount: null, lots: [lot({ id: "1", startPrice: 100 }), lot({ id: "2", startPrice: 0 })] })).toBe(0);
  });

  it("валюта: из карточки, иначе из лота, иначе рубль", () => {
    expect(mapEtpgpbCard(makeCard({ currency: "USD" }))?.financial.currency).toBe("USD");
    expect(mapEtpgpbCard(makeCard({ currency: "", lots: [lot({ currency: "CNY" })] }))?.financial.currency).toBe("CNY");
    expect(mapEtpgpbCard(makeCard({ currency: "" }))?.financial.currency).toBe("RUB");
  });
});

describe("регион", () => {
  const region = (overrides: Partial<EtpgpbCard>) => mapEtpgpbCard(makeCard(overrides))?.region;

  it("адрес поставки лота важнее региона организатора", () => {
    expect(
      region({ region: "Москва", regions: ["Москва"], lots: [lot({ deliveryAddress: "Иркутская область, г. Братск, ул. Мира, 1" })] }),
    ).toBe("Иркутская область");
  });

  it("регионы лота и название — до региона и адреса организатора", () => {
    expect(region({ region: "Москва", lotRegions: ["Республика Бурятия"] })).toBe("Республика Бурятия");
    expect(region({ region: "Москва", title: "Ремонт кровли, Иркутская область, г. Ангарск" })).toBe("Иркутская область");
  });

  it("регион и адрес заказчика — последний довод", () => {
    expect(region({ region: "Омская область" })).toBe("Омская область");
    expect(region({ customerAddress: "670031, РЕСПУБЛИКА БУРЯТИЯ, Г. УЛАН-УДЭ, УЛ. ПАВЛОВА, Д. 12" })).toBe("Республика Бурятия");
    expect(region({ organizer: company({ address: "644089, ОМСКАЯ ОБЛАСТЬ, Г. ОМСК" }) })).toBe("Омская область");
  });

  it("заглушки в адресе поставки («Любой закрытый») регионом не считаются", () => {
    expect(region({ lots: [lot({ deliveryAddress: ", Любой закрытый" })] })).toBe(UNKNOWN_REGION);
    expect(region({ lots: [lot({ deliveryAddress: "Согласно закупочной документации" })], lotRegions: ["Томская область"] })).toBe(
      "Томская область",
    );
  });

  it("регион не определился — «Не указан»", () => {
    expect(region({})).toBe(UNKNOWN_REGION);
  });
});

describe("регион: город организатора в месте поставки", () => {
  const mapped = (overrides: Partial<EtpgpbCard>) => mapEtpgpbCard(makeCard(overrides));

  it("голый «Санкт-Петербург» в месте поставки уступает названию закупки", () => {
    // Живая карточка 19.10.2026: ГСП Центр (Петербург) проводит ремонт для трансгаза
    // в Самаре, в месте поставки лота — «Санкт-Петербург, Согласно закупочной
    // документации», в lot_regions — «Москва».
    const tender = mapped({
      region: "Санкт-Петербург",
      lotRegions: ["Москва"],
      title: 'Выполнение работ по ремонту линейной части для нужд ООО "Газпром трансгаз Самара" в 2027 году',
      lots: [lot({ deliveryAddress: "Санкт-Петербург, Согласно закупочной документации" })],
    });
    expect(tender?.region).toBe("Самарская область");
    expect(tender?.lots[0]?.deliveryRegion).toBe("Самарская область");
  });

  it("дочка «Газпрома» без субъекта в названии находит регион по словарю", () => {
    expect(
      mapped({
        region: "Санкт-Петербург",
        title: 'Капитальный ремонт перехода через р. Иньва для нужд ООО "Газпром трансгаз Чайковский"',
        lots: [lot({ deliveryAddress: "Санкт-Петербург" })],
      })?.region,
    ).toBe("Пермский край");
    expect(mapped({ title: 'Ремонт антенной опоры для нужд ООО «Газпром добыча Надым»' })?.region).toBe(
      "Ямало-Ненецкий автономный округ",
    );
  });

  it("«Санкт-Петербург, Согласно технического задания.» — тоже голый город", () => {
    expect(
      mapped({
        title: "Выполнение СМР при подключении объекта по адресу г. Москва, Походный проезд",
        lotRegions: ["Санкт-Петербург"],
        lots: [lot({ deliveryAddress: "Санкт-Петербург, Согласно технического задания." })],
      })?.region,
    ).toBe("Москва");
  });

  it("адрес офиса заказчика в месте поставки уступает названию", () => {
    const office = "195277, Российская Федерация, г Санкт-Петербург, Большой Сампсониевский пр-кт, д 64";
    expect(
      mapped({
        title: "Ремонт и сервисное обслуживание ТРК на АЗС, расположенных в Белгородской области",
        customerAddress: office,
        lots: [lot({ deliveryAddress: office })],
      })?.region,
    ).toBe("Белгородская область");
  });

  it("lot_regions, повторяющий офис заказчика, уступает субъекту, прямо названному в названии", () => {
    const office = "195277, Российская Федерация, г Санкт-Петербург, Большой Сампсониевский пр-кт, д 64";
    expect(
      mapped({
        title: "Ремонт и сервисное обслуживание ТРК на АЗС, расположенных в Белгородской области",
        lotRegions: ["Санкт-Петербург"],
        customerAddress: office,
        organizer: company({ address: office }),
      })?.region,
    ).toBe("Белгородская область");
  });

  it("lot_regions = офис заказчика остаётся, если субъект в названии не назван прямо", () => {
    const office = "644089, ОМСКАЯ ОБЛАСТЬ, Г. ОМСК, УЛ. ДОКОВСКАЯ, Д. 23";
    expect(
      mapped({
        title: 'Запрос цен на поставку КИП для нужд ООО "ГПН-Заполярье"',
        lotRegions: ["Омская область"],
        customerAddress: office,
        lots: [lot({ deliveryAddress: ", Самовывоз со склада (FCA)" })],
      })?.region,
    ).toBe("Омская область");
  });

  it("подробный адрес поставки по-прежнему сильнее названия", () => {
    expect(
      mapped({
        title: "Ремонт кровли для нужд филиала в г. Москва",
        lots: [lot({ deliveryAddress: "Иркутская область, г. Братск, ул. Мира, 1" })],
      })?.region,
    ).toBe("Иркутская область");
  });

  it("голый город в месте поставки сильнее lot_regions, когда в названии места нет", () => {
    expect(
      mapped({
        title: "3734/ТЭР/КО - Ремонт тепловой изоляции на Северной ТЭЦ (ТЭЦ-21) филиала «Невский» ПАО «ТГК-1»",
        lotRegions: ["Москва"],
        lots: [lot({ deliveryAddress: "Санкт-Петербург, Согласно технического задания." })],
      })?.region,
    ).toBe("Санкт-Петербург");
  });

  it("голый адрес остаётся запасным, когда в названии места нет", () => {
    expect(
      mapped({ title: "Поставка канцелярских товаров", lots: [lot({ deliveryAddress: "Санкт-Петербург" })] })?.region,
    ).toBe("Санкт-Петербург");
  });
});

describe("заказчик", () => {
  it("первый заказчик лота, а не организатор: организатор лишь проводит процедуру", () => {
    const tender = mapEtpgpbCard(
      makeCard({
        organizer: company({ fullName: "ОРГАНИЗАТОР", inn: "7800000001" }),
        customers: [company({ fullName: "ЗАКАЗЧИК", inn: "7800000002" }), company({ fullName: "ВТОРОЙ ЗАКАЗЧИК", inn: "7800000003" })],
      }),
    );
    expect(tender?.customerName).toBe("ЗАКАЗЧИК");
    expect(tender?.customerInn).toBe("7800000002");
  });

  it("заказчиков лота нет — организатор; нет и его — заглушка без ИНН", () => {
    expect(mapEtpgpbCard(makeCard({ organizer: company({ fullName: "ОРГАНИЗАТОР", inn: "7800000001" }) }))?.customerInn).toBe("7800000001");
    const none = mapEtpgpbCard(makeCard());
    expect(none?.customerName).toBe(UNKNOWN_CUSTOMER);
    expect(none?.customerInn).toBeNull();
  });

  it("наименование: полное, иначе краткое, иначе короткое", () => {
    expect(mapEtpgpbCard(makeCard({ organizer: company({ fullName: "", name: "КРАТКОЕ", shortName: "ЕЩЁ КОРОЧЕ" }) }))?.customerName).toBe("КРАТКОЕ");
    expect(mapEtpgpbCard(makeCard({ organizer: company({ fullName: "", name: "", shortName: "ЕЩЁ КОРОЧЕ" }) }))?.customerName).toBe("ЕЩЁ КОРОЧЕ");
  });
});

describe("способ закупки", () => {
  const way = (procedureTypeName: string, flags: Partial<EtpgpbCard["flags"]> = {}) =>
    etpgpbPlacingWay(makeCard({ procedureTypeName, flags: { ...makeCard().flags, ...flags } }));

  it.each([
    ["Аукцион на понижение в электронной форме для СМСП", {}, "ELECTRONIC_AUCTION"],
    ["Ценовой запрос", {}, "REQUEST_FOR_QUOTATION"],
    ["Запрос котировок", {}, "REQUEST_FOR_QUOTATION"],
    ["Запрос предложений", {}, "REQUEST_FOR_PROPOSALS"],
    ["Конкурентный отбор", {}, "OPEN_CONTEST"],
    ["Открытый конкурс", {}, "OPEN_CONTEST"],
    ["Закупка у единственного поставщика", {}, "SOLE_SUPPLIER"],
    ["Попозиционная", {}, "OTHER"],
    ["", {}, "OTHER"],
    ["Что-то новое", { auction: true }, "ELECTRONIC_AUCTION"],
    ["Что-то новое", { requestQuotes: true }, "REQUEST_FOR_QUOTATION"],
  ] as const)("«%s» %j → %s", (name, flags, expected) => {
    expect(way(name, flags)).toBe(expected);
  });
});

describe("карточки-фикстуры целиком", () => {
  it("etp с номером ЕИС вместо номера площадки: дедупликация с ЕИС, Бурятия, срок по Москве", () => {
    const card = fixtureCard(ETPGPB_CARD_ETP_EIS11);
    const tender = mapEtpgpbCard(card);
    expect(tender).toMatchObject({
      id: "etpgpb-etp-1298399",
      regNumber: "32616467295",
      externalId: "32616467295",
      law: "FZ_223",
      placingWay: "ELECTRONIC_AUCTION",
      customerInn: "0323054162",
      region: "Республика Бурятия",
      dataSource: "ETP_GPB",
      onlyForSmp: true,
      documents: [],
      requirements: [],
    });
    expect(tender?.customerName).toContain("РЕСПУБЛИКАНСКАЯ КЛИНИЧЕСКАЯ БОЛЬНИЦА");
    expect(tender?.financial.price).toBe(2113390.4);
    // 23.10.2026 03:00 по Москве.
    expect(tender?.deadlines.submissionEnd).toBe("2026-10-23T00:00:00.000Z");
    expect(tender?.deadlines.publicationDate).toBe("2026-10-14T02:29:00.000Z");
    // Название с переводом строки («…\n(совместный аукцион)») записано одной строкой.
    expect(tender?.subject).not.toMatch(/\n/);
    expect(tender?.subject.endsWith("(совместный аукцион)")).toBe(true);
    expect(tender?.eisUrl).toBe(`https://etpgpb.ru${card.path}`);
    expect(tender?.lots).toHaveLength(1);
    expect(tender?.lots[0]).toMatchObject({ id: "2360953", number: 1, price: 2113390.4, deliveryRegion: "Республика Бурятия" });
    // «, Любой закрытый» адресом не является.
    expect(tender?.lots[0]?.deliveryAddress).toBe("Республика Бурятия");
    expect(etpgpbIsAccepting(card)).toBe(true);
  });

  it("цена не указана: ключ площадки, коммерческая закупка, цена 0, срок 12:00 по Москве", () => {
    const tender = mapEtpgpbCard(fixtureCard(ETPGPB_CARD_ETP_PRICE_UNKNOWN));
    expect(tender).toMatchObject({
      regNumber: "ETPGPB-АП125184",
      externalId: "АП125184",
      law: "COMMERCIAL",
      region: "Омская область",
      customerInn: "5501072608",
    });
    expect(tender?.financial.price).toBe(0);
    expect(tender?.deadlines.submissionEnd).toBe("2026-10-23T09:00:00.000Z");
  });

  it("commerce: организатора в карточке нет, заказчик взят из lotCustomers", () => {
    const card = fixtureCard(ETPGPB_CARD_COMMERCE);
    expect(card.organizer).toBeNull();
    const tender = mapEtpgpbCard(card);
    expect(tender?.customerInn).toBe("5752019857");
    expect(tender?.customerName).toContain("ФРИГОЛАЙН");
    expect(tender?.regNumber).toBe("ETPGPB-КП000008835");
    expect(tender?.placingWay).toBe("REQUEST_FOR_PROPOSALS");
    expect(tender?.region).toBe("Орловская область");
    expect(etpgpbIsAccepting(card)).toBe(false);
  });

  it("etp_click: срок — response_date лота, цена из amount", () => {
    const tender = mapEtpgpbCard(fixtureCard(ETPGPB_CARD_ETP_CLICK));
    expect(tender?.regNumber).toBe("ETPGPB-17793");
    expect(tender?.deadlines.submissionEnd).toBe("2026-10-20T09:00:00.000Z");
    expect(tender?.financial.price).toBe(142391.2);
    expect(tender?.placingWay).toBe("REQUEST_FOR_QUOTATION");
    expect(tender?.region).toBe("Астраханская область");
    expect(tender?.subject).toBe("Поставка игрушек в ассортименте");
    // Предмет единственного лота у etp_click пуст — подставлено название процедуры.
    expect(tender?.lots[0]?.subject).toBe("Поставка игрушек в ассортименте");
  });

  it("gaz: номер ЕИС из ссылки, заказчик — не организатор", () => {
    const tender = mapEtpgpbCard(fixtureCard(ETPGPB_CARD_GAZ_EIS_URL));
    expect(tender?.regNumber).toBe("32616379968");
    expect(tender?.law).toBe("FZ_223");
    expect(tender?.customerInn).toBe("7702211710");
    expect(tender?.customerName).toContain("ГАЗПРОМ ПИТАНИЕ");
  });

  it("продажа имущества — не закупка поставщика: null", () => {
    const card = fixtureCard(ETPGPB_CARD_SALE);
    expect(etpgpbIsPropertySale(card)).toBe(true);
    expect(mapEtpgpbCard(card)).toBeNull();
  });

  it("карточка без названия или без номеров — не закупка", () => {
    expect(mapEtpgpbCard(makeCard({ title: "" }))).toBeNull();
    expect(mapEtpgpbCard(makeCard({ registryNumber: "", platformId: "" }))).toBeNull();
  });

  it("ссылка на карточку: путь из карточки, запасной — адрес запроса", () => {
    expect(mapEtpgpbCard(makeCard())?.eisUrl).toBe("https://etpgpb.ru/procedures/etp/100-test-protsedura/");
    const bad = mapEtpgpbCard(makeCard({ path: "/procedures/page/1/" }), { cardUrl: "https://etpgpb.ru/procedures/etp/100-x/" });
    expect(bad?.eisUrl).toBe("https://etpgpb.ru/procedures/etp/100-x/");
  });

  it("метка партии пишется в syncedAt", () => {
    expect(mapEtpgpbCard(makeCard(), { syncStartedAt: "2026-10-19T10:00:00.000Z" })?.syncedAt).toBe("2026-10-19T10:00:00.000Z");
  });

  it("лот без номера получает порядковый, пустой предмет у многолотовой закупки не подменяется названием", () => {
    const tender = mapEtpgpbCard(makeCard({ lots: [lot({ id: "a", number: null, subject: "" }), lot({ id: "b", number: null, subject: "" })] }));
    expect(tender?.lots.map((l) => l.number)).toEqual([1, 2]);
    expect(tender?.lots.map((l) => l.subject)).toEqual(["", ""]);
  });
});

describe("в закупке нет контактов", () => {
  it("даже когда карточка их несёт: ни ключей, ни значений контактов в Tender", () => {
    const tenders = [
      ETPGPB_CARD_ETP_EIS11,
      ETPGPB_CARD_ETP_PRICE_UNKNOWN,
      ETPGPB_CARD_COMMERCE,
      ETPGPB_CARD_ETP_CLICK,
      ETPGPB_CARD_GAZ_EIS_URL,
    ].map((fixture) => {
      const card = parseEtpgpbCard(nuxtPage(withSyntheticContacts(fixture.table)), fixture.url);
      if (card === null) throw new Error("карточка не разобрана");
      return mapEtpgpbCard(card);
    });
    expect(tenders.every((tender) => tender !== null)).toBe(true);
    const text = JSON.stringify(tenders);
    expect(text).not.toMatch(SYNTHETIC_CONTACT_PATTERN);
    expect(text).not.toMatch(/contact|e-?mail|phone|@/i);
  });
});
