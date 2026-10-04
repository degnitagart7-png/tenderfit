import { describe, expect, it } from "vitest";
import { isPriceKnown } from "@/domain/entities";
import {
  TEKTORG_PLACING_WAYS,
  mapTektorgProcedure,
} from "@/adapters/tender-source/tektorgMapper";
import { parseProceduresResponse } from "@/adapters/tender-source/tektorgSoap";
import { TEKTORG_LIVE_RESPONSE } from "@/adapters/tender-source/tektorgTestFixtures";

/** Ответ разобран один раз: дальше проверки берут процедуры из него. */
const page = parseProceduresResponse(TEKTORG_LIVE_RESPONSE);
/** ЗП6082206: номер ЕИС есть, два лота с ценой, лоты пришли в обратном порядке. */
const withEis = page.procedures[0]!;
/** ЗП610102: коммерческая, номера ЕИС нет, цены нет, регион пуст (адрес уехал в <house>). */
const commercial = page.procedures[1]!;
/** ЗП6091269: <region> заполнен, один лот с ценой. */
const withRegion = page.procedures[2]!;

const ZAKUPKI = { sectionCode: "zakupki" } as const;

/**
 * Номер процедуры 44-ФЗ таким, каким его отдаёт секция `44fz`: 19 цифр и без
 * `eisRegistryNumber`. Зонд 02.10.2026: из 100 процедур этой секции номер ЕИС лежит в
 * `registryNumber` у всех ста, а отдельного поля нет ни у одной.
 */
const FZ44_NUMBER = "0321300070226000115";

describe("ключ дедупликации", () => {
  it("номер ЕИС становится reg_number: запись схлопывается с еисовской", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).regNumber).toBe("32616329240");
  });

  it("без номера ЕИС reg_number получает префикс площадки", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).regNumber).toBe("TEKTORG-ЗП610102");
  });

  it("external_id всегда равен номеру площадки: по нему работают карточка и документы", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).externalId).toBe("ЗП6082206");
    expect(mapTektorgProcedure(commercial, ZAKUPKI).externalId).toBe("ЗП610102");
  });

  it("в секции 44fz номер площадки и есть номер ЕИС — префикс сломал бы дедупликацию", () => {
    const fz44 = { ...commercial, registryNumber: FZ44_NUMBER };
    expect(mapTektorgProcedure(fz44, { sectionCode: "44fz" }).regNumber).toBe(FZ44_NUMBER);
  });

  it("id детерминированный: повторный прогон не плодит записи", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).id).toBe("tektorg-ЗП610102");
  });
});

describe("закон", () => {
  it("попадание в ЕИС означает 223-ФЗ", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).law).toBe("FZ_223");
  });

  it("процедура без номера ЕИС — коммерческая", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).law).toBe("COMMERCIAL");
  });

  it("секция 44fz даёт 44-ФЗ независимо от номера ЕИС", () => {
    const fz44 = { ...commercial, registryNumber: FZ44_NUMBER };
    expect(mapTektorgProcedure(fz44, { sectionCode: "44fz" }).law).toBe("FZ_44");
  });

  it("секция не задана — считаем закупочной: адаптер ходит только в неё", () => {
    expect(mapTektorgProcedure(commercial).law).toBe("COMMERCIAL");
  });
});

describe("цена", () => {
  it("один лот с ценой — берём её", () => {
    expect(mapTektorgProcedure(withRegion, ZAKUPKI).financial.price).toBe(137640);
  });

  it("несколько лотов, цена у всех — берём сумму", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).financial.price).toBe(3297903.75);
  });

  it("хотя бы у одного лота цены нет — цена неизвестна, а не занижена", () => {
    const t = mapTektorgProcedure(
      {
        ...withEis,
        lots: [
          ...withEis.lots,
          { ...withEis.lots[0]!, id: "9", number: "3", startPrice: null },
        ],
      },
      ZAKUPKI,
    );
    expect(t.financial.price).toBe(0);
  });

  it("нуль цены — это «не опубликована», и isPriceKnown её отличает", () => {
    const price = mapTektorgProcedure(commercial, ZAKUPKI).financial.price;
    expect(price).toBe(0);
    expect(isPriceKnown(price)).toBe(false);
  });

  it("валюта берётся из ответа площадки", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).financial.currency).toBe("RUB");
  });
});

describe("предмет, лоты и заказчик", () => {
  it("предмет закупки — название процедуры", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).subject).toBe(
      "Поставка электро-бензоинструмента (лот 1, лот 2) АО «Регионгаз-инвест»",
    );
  });

  it("лоты приходят в обратном порядке — сортируем по номеру", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).lots.map((l) => l.number)).toEqual([1, 2]);
  });

  it("пустой предмет лота не заменяется названием процедуры", () => {
    const t = mapTektorgProcedure(
      { ...commercial, lots: [{ ...commercial.lots[0]!, subject: "" }] },
      ZAKUPKI,
    );
    expect(t.lots[0]?.subject).toBe("");
  });

  it("заказчик — из лота: организатор проводит процедуру, а покупает заказчик", () => {
    const t = mapTektorgProcedure(withEis, ZAKUPKI);
    expect(t.customerName).toContain("РЕГИОНГАЗ-ИНВЕСТ");
    expect(t.customerInn).toBe("6659075136");
  });

  it("когда заказчика в лоте нет, остаётся организатор", () => {
    const t = mapTektorgProcedure(
      {
        ...commercial,
        lots: [{ ...commercial.lots[0]!, customerName: null, customerInn: null }],
      },
      ZAKUPKI,
    );
    expect(t.customerName).toContain("РГ-СНАБЖЕНИЕ");
    expect(t.customerInn).toBe("2203002720");
  });

  it("регион — из адреса организатора, когда <region> пуст", () => {
    // Название этой процедуры региона не содержит («в г. Ангарск» — город, а не
    // субъект, словарь регионов его не знает), поэтому остаётся адрес организатора.
    expect(mapTektorgProcedure(commercial, ZAKUPKI).region).toBe("Москва");
  });

  it("регион — из <region>, когда он заполнен", () => {
    expect(mapTektorgProcedure(withRegion, ZAKUPKI).region).toBe("Ульяновская область");
  });

  it("регион — из названия, когда место поставки стоит заглушкой", () => {
    // Живая выдача 02.10.2026: у 8 процедур из 75 место поставки — «В соответствии
    // с документацией о закупке», <region> пуст, а регион назван в названии. Без
    // этого правила все восемь получали Москву по адресу головного офиса заказчика,
    // хотя работы на Сахалине, в Рязани, Башкортостане, Самарской и Тюменской областях.
    const sakhalin = mapTektorgProcedure(
      {
        ...commercial,
        title:
          "Оказание услуг автотранспортными средствами на о. Сахалин " +
          "для нужд ООО «Оргэнергокапитал»",
      },
      ZAKUPKI,
    );
    expect(sakhalin.region).toBe("Сахалинская область");
  });

  it("название не перекрывает ни место поставки, ни <region>", () => {
    const sakhalinTitle = "...на о. Сахалин для нужд ООО «Оргэнергокапитал»";
    // Место поставки заполнено настоящим адресом — он точнее названия.
    expect(
      mapTektorgProcedure({ ...withRegion, title: sakhalinTitle }, ZAKUPKI).region,
    ).toBe("Ульяновская область");
    // Места поставки нет, но площадка сама указала регион — берём его.
    expect(
      mapTektorgProcedure(
        { ...commercial, region: "Ульяновская область", title: sakhalinTitle },
        ZAKUPKI,
      ).region,
    ).toBe("Ульяновская область");
  });

  it("регион поставки лота — из предмета лота, когда адрес лота пуст", () => {
    const t = mapTektorgProcedure(
      {
        ...commercial,
        lots: [{ ...commercial.lots[0]!, subject: "Услуги автотранспортом на о. Сахалин" }],
      },
      ZAKUPKI,
    );
    expect(t.lots[0]?.deliveryRegion).toBe("Сахалинская область");
  });

  it("коды ОКПД2 поднимаются из лотов на уровень закупки без повторов", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).okpd2Codes).toEqual(["28.24.12.190"]);
  });
});

describe("способ размещения", () => {
  it("аукцион секции zakupki ложится в ELECTRONIC_AUCTION", () => {
    expect(mapTektorgProcedure({ ...withEis, procedureTypeId: 2 }, ZAKUPKI).placingWay).toBe(
      "ELECTRONIC_AUCTION",
    );
  });

  it("запрос котировок ложится в REQUEST_FOR_QUOTATION", () => {
    expect(mapTektorgProcedure(withEis, ZAKUPKI).placingWay).toBe("REQUEST_FOR_QUOTATION");
  });

  it("тот же typeId в другой секции значит другое: 2 в 44fz — запрос котировок", () => {
    expect(
      mapTektorgProcedure({ ...withEis, procedureTypeId: 2 }, { sectionCode: "44fz" })
        .placingWay,
    ).toBe("REQUEST_FOR_QUOTATION");
  });

  it("запрос ценовой информации — не котировки: это сбор цен, а не закупка", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).placingWay).toBe("OTHER");
  });

  it("неизвестный typeId — OTHER, а не ошибка: словарь площадка пополняет", () => {
    expect(mapTektorgProcedure({ ...withEis, procedureTypeId: 999 }, ZAKUPKI).placingWay).toBe(
      "OTHER",
    );
    expect(() =>
      mapTektorgProcedure({ ...withEis, procedureTypeId: null }, ZAKUPKI),
    ).not.toThrow();
  });

  it("словарь перечисляет типы, снятые с живого ответа", () => {
    expect(TEKTORG_PLACING_WAYS.zakupki?.[18]).toBe("REQUEST_FOR_QUOTATION");
    expect(TEKTORG_PLACING_WAYS["44fz"]?.[0]).toBe("ELECTRONIC_AUCTION");
  });
});

describe("служебные поля", () => {
  it("источник — TEK_TORG, ссылка ведёт на карточку площадки", () => {
    const t = mapTektorgProcedure(commercial, ZAKUPKI);
    expect(t.dataSource).toBe("TEK_TORG");
    expect(t.eisUrl).toBe("https://www.tektorg.ru/223-fz/procedures/19911463");
  });

  it("срок подачи переносится из dateEndRegistration", () => {
    expect(mapTektorgProcedure(commercial, ZAKUPKI).deadlines.submissionEnd).toBe(
      "2026-10-12T12:00:00+03:00",
    );
  });

  it("метка партии — syncedAt, когда она передана", () => {
    const t = mapTektorgProcedure(commercial, {
      sectionCode: "zakupki",
      syncStartedAt: "2026-10-01T03:00:00.000Z",
    });
    expect(t.syncedAt).toBe("2026-10-01T03:00:00.000Z");
  });

  it("требования, история изменений и документы пусты: экспорт их не содержит", () => {
    const t = mapTektorgProcedure(withEis, ZAKUPKI);
    expect(t.requirements).toEqual([]);
    expect(t.changeLog).toEqual([]);
    expect(t.documents).toEqual([]);
    expect(t.nationalRegime).toBe(false);
    expect(t.onlyForSmp).toBe(false);
  });
});
