import { describe, expect, it } from "vitest";
import {
  TEKTORG_ENDPOINTS,
  TEKTORG_REQUEST_HEADERS,
  TektorgParseError,
  TektorgSoapFaultError,
  buildProceduresRequest,
  parseProceduresResponse,
} from "@/adapters/tender-source/tektorgSoap";
import {
  TEKTORG_EMPTY_PAGE,
  TEKTORG_FAULT,
  TEKTORG_LIVE_RESPONSE,
  TEKTORG_REMOVED_DOCUMENT,
  TEKTORG_TRUNCATED,
} from "@/adapters/tender-source/tektorgTestFixtures";

/** Ответ разобран один раз: дальше проверки берут процедуры из него. */
const page = parseProceduresResponse(TEKTORG_LIVE_RESPONSE);
const multiLot = page.procedures[0]!;
const commercial = page.procedures[1]!;
const withRegion = page.procedures[2]!;

describe("конверт запроса экспорта процедур", () => {
  it("зовёт операцию procedures в пространстве имён площадки", () => {
    const body = buildProceduresRequest({
      sectionCode: "zakupki",
      startDate: "2026-10-01T00:00:00+03:00",
      endDate: "2026-10-01T23:59:59+03:00",
      limitPage: 100,
      page: 1,
    });

    expect(body).toContain(
      'xmlns:tns="https://api.tektorg.ru/procedures/soap"',
    );
    expect(body).toContain("<tns:procedures>");
    // Имя части запроса по WSDL — symbol; без него площадка не находит операцию.
    expect(body).toContain("<symbol>");
    expect(body).toContain("<sectionCode>zakupki</sectionCode>");
    expect(body).toContain("<startDate>2026-10-01T00:00:00+03:00</startDate>");
    expect(body).toContain("<endDate>2026-10-01T23:59:59+03:00</endDate>");
    expect(body).toContain("<limitPage>100</limitPage>");
    expect(body).toContain("<page>1</page>");
  });

  it("не передаёт поле, которое не задано: пустой тег площадка читает как фильтр", () => {
    const body = buildProceduresRequest({ sectionCode: "zakupki" });

    expect(body).toContain("<sectionCode>zakupki</sectionCode>");
    for (const absent of [
      "startDate",
      "endDate",
      "startUpdateAt",
      "endUpdateAt",
      "registryNumber",
      "eisRegistryNumber",
      "organizerINN",
      "customerINN",
      "typeId",
      "limitPage",
      "page",
    ]) {
      expect(body, absent).not.toContain(`<${absent}`);
    }
  });

  it("экранирует значение, а не подставляет его в XML как есть", () => {
    const body = buildProceduresRequest({
      sectionCode: "zakupki",
      registryNumber: "ЗП-1 & <2>",
    });

    expect(body).toContain(
      "<registryNumber>ЗП-1 &amp; &lt;2&gt;</registryNumber>",
    );
    expect(body).not.toContain("& <2>");
  });

  it("ИНН заказчика — одна строка: схема допускает maxOccurs=1, список сюда не передать", () => {
    const body = buildProceduresRequest({
      sectionCode: "zakupki",
      customerINN: "7708503727",
      organizerINN: "2203002720",
    });

    expect(body).toContain("<customerINN>7708503727</customerINN>");
    expect(body).toContain("<organizerINN>2203002720</organizerINN>");
  });
});

describe("адреса и заголовки площадки", () => {
  it("экспорт процедур и байты документов живут на одном хосте и не требуют ключа", () => {
    expect(TEKTORG_ENDPOINTS.procedures).toBe(
      "https://api.tektorg.ru/procedures/soap",
    );
    expect(TEKTORG_ENDPOINTS.documents).toBe(
      "https://api.tektorg.ru/open-api/documents/procedure",
    );
    for (const url of Object.values(TEKTORG_ENDPOINTS)) {
      expect(url).toMatch(/^https:\/\/api\.tektorg\.ru\//);
    }
  });

  it("заголовки запроса заданы явно: без SOAPAction площадка не находит операцию", () => {
    expect(TEKTORG_REQUEST_HEADERS.SOAPAction).toBe("urn:procedures");
    expect(TEKTORG_REQUEST_HEADERS["Content-Type"]).toBe(
      "text/xml; charset=utf-8",
    );
  });
});

describe("разбор страницы ответа", () => {
  it("читает счётчики страницы и секцию — по ним адаптер понимает, что страница не последняя", () => {
    expect(page.totalProcedures).toBe(3);
    expect(page.currentPage).toBe(1);
    expect(page.totalPage).toBe(1);
    expect(page.limitProceduresInPage).toBe(100);
    expect(page.sectionCode).toBe("zakupki");
    expect(page.sectionName).toBe("223-ФЗ и Коммерческие закупки");
  });

  it("находит все процедуры в порядке площадки", () => {
    expect(page.procedures).toHaveLength(3);
    expect(page.procedures.map((p) => p.registryNumber)).toEqual([
      "ЗП6082206",
      "ЗП610102",
      "ЗП6091269",
    ]);
  });

  it("номер ЕИС есть не у каждой процедуры: без него закупка чисто коммерческая", () => {
    expect(multiLot.eisRegistryNumber).toBe("32616329240");
    expect(commercial.eisRegistryNumber).toBeNull();
  });

  it("читает служебные поля процедуры", () => {
    expect(multiLot.id).toBe("228142");
    expect(multiLot.title).toBe(
      "Поставка электро-бензоинструмента (лот 1, лот 2) АО «Регионгаз-инвест»",
    );
    expect(multiLot.urlToShowcase).toBe(
      "https://www.tektorg.ru/223-fz/procedures/19786237",
    );
    expect(multiLot.datePublished).toBe("2026-08-27T14:54:11+03:00");
    expect(multiLot.dateUpdated).toBe("2026-09-21T07:31:02+03:00");
    expect(multiLot.dateEndRegistration).toBe("2026-09-04T13:00:00+03:00");
    expect(multiLot.currency).toBe("RUB");
  });

  it("способ размещения приходит парой «id + название», и название площадка иногда не знает", () => {
    expect(multiLot.procedureTypeId).toBe(18);
    expect(multiLot.procedureTypeTitle).toBe("Запрос котировок");
    expect(commercial.procedureTypeId).toBe(21);
    expect(commercial.procedureTypeTitle).toBe(
      "Запрос предоставления ценовой информации",
    );
  });

  it("лоты идут в порядке площадки, а их номера читаются из <number>, а не из атрибута id", () => {
    expect(multiLot.lots).toHaveLength(2);
    // Площадка отдала лот 2 раньше лота 1: атрибут id убывает, номер растёт.
    expect(multiLot.lots[0]?.id).toBe("23097734");
    expect(multiLot.lots[0]?.number).toBe("2");
    expect(multiLot.lots[1]?.id).toBe("23097733");
    expect(multiLot.lots[1]?.number).toBe("1");
    expect(multiLot.lots[1]?.subject).toBe(
      "Поставка электро-бензоинструмента (лот 1) АО «Регионгаз-инвест»",
    );
  });

  it("цена лота — число, а отсутствующая цена остаётся отсутствующей, а не нулём", () => {
    expect(multiLot.lots[0]?.startPrice).toBe(2070487.88);
    expect(multiLot.lots[1]?.startPrice).toBe(1227415.87);
    expect(commercial.lots[0]?.startPrice).toBeNull();
  });

  it("заказчик лота читается вместе с ИНН", () => {
    expect(commercial.lots[0]?.customerInn).toBe("5001110252");
    expect(commercial.lots[0]?.customerName).toContain("ОРГЭНЕРГОКАПИТАЛ");
  });

  it("коды ОКПД2 и ОКВЭД2 лота видны: по ним закупку можно отнести к профилю", () => {
    expect(multiLot.lots[0]?.okpd2Codes).toEqual(["28.24.12.190"]);
    expect(multiLot.lots[0]?.okved2Codes).toEqual(["28.24"]);
    expect(commercial.lots[0]?.okpd2Codes).toEqual(["45.20.11.111"]);
  });

  it("статус лота сохраняется: по нему архив отличается от приёма заявок", () => {
    expect(commercial.lots[0]?.status).toBe("Приём заявок");
    expect(multiLot.lots[0]?.status).toBe("Архив");
  });

  it("не путает <file> с <filename>: адресом документа остаётся адрес", () => {
    expect(multiLot.documents).toHaveLength(3);
    expect(multiLot.documents[0]?.url).toBe(
      "https://api.tektorg.ru/open-api/documents/procedure/20236402",
    );
    expect(multiLot.documents[0]?.filename).toBe(
      "Извещение_инструмент_2_лота.docx",
    );
    for (const doc of multiLot.documents) {
      expect(doc.url, doc.filename).toMatch(
        /^https:\/\/api\.tektorg\.ru\/open-api\/documents\//,
      );
      expect(doc.removed).toBe(false);
    }
  });

  it("документ, снятый с публикации, адреса не имеет", () => {
    const removed = parseProceduresResponse(TEKTORG_REMOVED_DOCUMENT)
      .procedures[0]!;

    expect(removed.documents).toHaveLength(2);
    expect(removed.documents[0]?.removed).toBe(true);
    expect(removed.documents[0]?.url).toBeNull();
    expect(removed.documents[1]?.removed).toBe(false);
    expect(removed.documents[1]?.url).toBe(
      "https://api.tektorg.ru/open-api/documents/procedure/20499347",
    );
  });

  it("CDATA в названии организации распаковывается вместе с кавычками внутри", () => {
    expect(multiLot.organizerFullName).toBe(
      'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РГ-СНАБЖЕНИЕ"',
    );
    expect(multiLot.organizerInn).toBe("2203002720");
    expect(withRegion.organizerFullName).toContain("ДОМ ДОБРА И ПОМОЩИ");
  });

  it("регион организатора: заполненный читается, пустой тег остаётся null", () => {
    expect(withRegion.region).toBe("Ульяновская область");
    // У семи записей из десяти регион пуст, а весь адрес уезжает в <house>.
    expect(commercial.region).toBeNull();
    expect(multiLot.region).toBeNull();
  });

  it("адрес организатора собран из частей: по нему регион находится, когда <region> пуст", () => {
    expect(commercial.organizerAddress).toContain("Г.МОСКВА");
    expect(commercial.organizerAddress).toContain("БОЛЬШАЯ ПОЛЯНКА");
    expect(withRegion.organizerAddress).toBe(
      "433741, Ульяновская область, Барышский район, УЛ. КРАСНАЯ, Д.21А",
    );
  });

  it("место поставки лота видно: доставка важнее юридического адреса организатора", () => {
    expect(commercial.lots[0]?.deliveryAddresses).toEqual([
      "В соответствии с ТЗ",
    ]);
    expect(multiLot.lots[0]?.deliveryAddresses).toEqual([
      "В соответствии с документацией о закупке",
    ]);
  });

  it("XML-сущности в названии расшифровываются", () => {
    const parsed = parseProceduresResponse(
      TEKTORG_LIVE_RESPONSE.replace(
        "<title>Яйцо куринное</title>",
        "<title>Яйцо &amp; курица &lt;шт&gt;</title>",
      ),
    );
    expect(parsed.procedures[2]?.title).toBe("Яйцо & курица <шт>");
  });

  it("в raw процедуры остаётся её собственный обрезок XML", () => {
    expect(multiLot.raw.startsWith("<procedure ")).toBe(true);
    expect(multiLot.raw.endsWith("</procedure>")).toBe(true);
    expect(multiLot.raw).toContain("ЗП6082206");
    expect(multiLot.raw).not.toContain("ЗП610102");
  });

  it("пустая страница — ноль процедур, а не ошибка", () => {
    const empty = parseProceduresResponse(TEKTORG_EMPTY_PAGE);

    expect(empty.procedures).toEqual([]);
    expect(empty.totalProcedures).toBe(0);
    expect(empty.sectionCode).toBe("zakupki");
  });
});

describe("ответ, который нельзя принять за выдачу", () => {
  it("Fault — ошибка площадки, а не пустая выдача", () => {
    expect(() => parseProceduresResponse(TEKTORG_FAULT)).toThrow(
      TektorgSoapFaultError,
    );
    expect(() => parseProceduresResponse(TEKTORG_FAULT)).toThrow(
      /Некорректный период/,
    );
  });

  it("страница входа вместо конверта — ошибка разбора: успех нельзя проверить по заголовку", () => {
    expect(() =>
      parseProceduresResponse(
        "<html><body>Вход в личный кабинет</body></html>",
      ),
    ).toThrow(TektorgParseError);
    expect(() =>
      parseProceduresResponse("<html>страница входа</html>"),
    ).toThrow(/не похож на ответ/);
  });

  it("оборванный конверт — ошибка, а не половина выдачи", () => {
    expect(() => parseProceduresResponse(TEKTORG_TRUNCATED)).toThrow(
      TektorgParseError,
    );
    expect(() => parseProceduresResponse(TEKTORG_TRUNCATED)).toThrow(
      /не закрыт/,
    );
  });

  it("пустая строка — тоже ошибка разбора", () => {
    expect(() => parseProceduresResponse("")).toThrow(TektorgParseError);
  });
});
