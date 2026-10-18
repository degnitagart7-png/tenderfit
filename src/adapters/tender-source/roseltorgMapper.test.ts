import { describe, expect, it } from "vitest";
import { UNKNOWN_REGION } from "@/domain/entities";
import {
  ROSELTORG_PLACING_WAYS,
  mapRoseltorgRows,
  roseltorgLaw,
  roseltorgPlacingWay,
  roseltorgRegNumber,
} from "./roseltorgMapper";
import type { RoseltorgLotRow } from "./roseltorgSearch";
import { parseRoseltorgSearch } from "./roseltorgSearch";
import {
  ROSELTORG_COMMERCIAL_ITEM,
  ROSELTORG_FZ223_ITEM,
  ROSELTORG_FZ44_ITEM,
  ROSELTORG_MULTI_LOT_ITEMS,
  ROSELTORG_PRICED_ITEM,
  ROSELTORG_UNKNOWN_REGION_ITEM,
  buildRoseltorgSearchPage,
} from "./roseltorgTestFixtures";

/** Разобрать фикстуру в строки выдачи — так тесты работают с настоящим HTML. */
function rowsOf(...items: readonly string[]): RoseltorgLotRow[] {
  return [...parseRoseltorgSearch(buildRoseltorgSearchPage({ items })).rows];
}

describe("roseltorgLaw", () => {
  it("девятнадцатизначный номер — извещение 44-ФЗ", () => {
    expect(roseltorgLaw("0373200045226001469")).toBe("FZ_44");
  });

  it("одиннадцать знаков с ведущей тройкой — 223-ФЗ", () => {
    expect(roseltorgLaw("32616431984")).toBe("FZ_223");
  });

  it("номер площадки — коммерческая закупка", () => {
    expect(roseltorgLaw("B0210261118005")).toBe("COMMERCIAL");
    expect(roseltorgLaw("COM02102600102")).toBe("COMMERCIAL");
    expect(roseltorgLaw("ATOM02102600184")).toBe("COMMERCIAL");
    expect(roseltorgLaw("SP10087155")).toBe("COMMERCIAL");
  });

  it("закон выводится из номера, а не из названия секции", () => {
    // В строках списка площадка печатает «закупки субъектов 223-ФЗ», а в фильтре —
    // «закупки по 223-ФЗ». Сверять с названием значит сломаться на первой правке
    // вёрстки; номер формы не зависит.
    const [row] = rowsOf(ROSELTORG_FZ223_ITEM);
    expect(row?.sectionTitle).toContain("субъектов 223-ФЗ");
    expect(roseltorgLaw(row?.procedureNumber ?? "")).toBe("FZ_223");
  });

  it("пустой и обрезанный номер не дают закона регулируемой закупки", () => {
    expect(roseltorgLaw("")).toBe("COMMERCIAL");
    expect(roseltorgLaw("  123  ")).toBe("COMMERCIAL");
  });
});

describe("roseltorgRegNumber", () => {
  it("номер извещения ЕИС остаётся собой: по нему запись склеивается с еисовской", () => {
    expect(roseltorgRegNumber("0373200045226001469")).toBe("0373200045226001469");
    expect(roseltorgRegNumber("32616431984")).toBe("32616431984");
  });

  it("номер площадки получает префикс: в реестре такого номера нет", () => {
    expect(roseltorgRegNumber("B0210261118005")).toBe("ROSELTORG-B0210261118005");
  });
});

describe("roseltorgPlacingWay", () => {
  it("словарь покрывает способы, которые площадка напечатала в живой выдаче", () => {
    expect(roseltorgPlacingWay("Аукцион")).toBe("ELECTRONIC_AUCTION");
    expect(roseltorgPlacingWay("Конкурс МСП")).toBe("OPEN_CONTEST");
    expect(roseltorgPlacingWay("Запрос котировок МСП")).toBe("REQUEST_FOR_QUOTATION");
    expect(roseltorgPlacingWay("Запрос предложений")).toBe("REQUEST_FOR_PROPOSALS");
    expect(roseltorgPlacingWay("Мониторинг цен")).toBe("OTHER");
    expect(roseltorgPlacingWay("Запрос о предоставлении ценовой информации")).toBe("OTHER");
  });

  it("ключи словаря нормализованы: сравнение идёт по приведённому названию", () => {
    for (const key of Object.keys(ROSELTORG_PLACING_WAYS)) {
      expect(key).toBe(key.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim());
    }
  });

  it("сравнение нечувствительно к регистру, «ё» и лишним пробелам", () => {
    expect(roseltorgPlacingWay("  аукцион  ")).toBe("ELECTRONIC_AUCTION");
    expect(roseltorgPlacingWay("ЭЛЕКТРОННЫЙ  АУКЦИОН")).toBe("ELECTRONIC_AUCTION");
    expect(roseltorgPlacingWay("Запрос котировок в электронной форме")).toBe(
      "REQUEST_FOR_QUOTATION",
    );
  });

  it("незнакомое название разбирается по ключевому слову", () => {
    expect(roseltorgPlacingWay("Открытый конкурс в электронной форме")).toBe("OPEN_CONTEST");
    expect(roseltorgPlacingWay("Запрос оферт")).toBe("REQUEST_FOR_PROPOSALS");
    expect(roseltorgPlacingWay("Запрос цен среди квалифицированных участников")).toBe(
      "REQUEST_FOR_QUOTATION",
    );
  });

  it("сбор цен не становится способом, которым заключается договор", () => {
    expect(roseltorgPlacingWay("Сравнение цен в электронной форме")).toBe("OTHER");
    expect(roseltorgPlacingWay("Процедура по закупке с выбором победителя")).toBe("OTHER");
    expect(roseltorgPlacingWay("Закупка с полки (закупка в электронном магазине)")).toBe("OTHER");
    expect(roseltorgPlacingWay("")).toBe("OTHER");
    expect(roseltorgPlacingWay("Неизвестный площадке способ")).toBe("OTHER");
  });
});

describe("mapRoseltorgRows — одна строка", () => {
  const [tender] = mapRoseltorgRows(rowsOf(ROSELTORG_PRICED_ITEM));

  it("заполняет ключевые поля закупки", () => {
    expect(tender?.id).toBe("roseltorg-32616431971");
    expect(tender?.regNumber).toBe("32616431971");
    expect(tender?.externalId).toBe("32616431971");
    expect(tender?.law).toBe("FZ_223");
    expect(tender?.dataSource).toBe("ROSELTORG");
    expect(tender?.placingWay).toBe("OPEN_CONTEST");
  });

  it("берёт предмет, заказчика, регион и цену из строки выдачи", () => {
    expect(tender?.subject).toBe(
      "Выполнение строительно-монтажных, пусконаладочных работ с поставкой материалов и оборудования",
    );
    expect(tender?.customerName).toBe('ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "РОССЕТИ ЮГ"');
    expect(tender?.customerInn).toBe("6164266561");
    expect(tender?.region).toBe("Волгоградская область");
    expect(tender?.financial.price).toBe(1363671.13);
    expect(tender?.financial.currency).toBe("RUB");
  });

  it("признак закупки только для СМП читает из способа размещения", () => {
    expect(tender?.onlyForSmp).toBe(true);
  });

  it("ссылка ведёт на карточку лота площадки", () => {
    expect(tender?.eisUrl).toBe("https://www.roseltorg.ru/procedure/32616431971/1");
  });

  it("не выдумывает поля, которых в списке нет", () => {
    expect(tender?.okpd2Codes).toEqual([]);
    expect(tender?.requirements).toEqual([]);
    expect(tender?.documents).toEqual([]);
    expect(tender?.deadlines.publicationDate).toBe("");
    expect(tender?.deadlines.lastUpdateDate).toBe("");
    expect(tender?.deadlines.submissionEnd).toBe("2026-10-12T11:00:00+03:00");
    expect(tender?.changeLog).toEqual([]);
    expect(tender?.nationalRegime).toBe(false);
  });

  it("пишет метку партии синхронизации, когда она задана", () => {
    const [marked] = mapRoseltorgRows(rowsOf(ROSELTORG_PRICED_ITEM), {
      syncStartedAt: "2026-10-02T09:00:00.000Z",
    });
    expect(marked?.syncedAt).toBe("2026-10-02T09:00:00.000Z");
    expect(tender?.syncedAt).toBeNull();
  });
});

describe("mapRoseltorgRows — цена и лоты", () => {
  it("строка без блока цены даёт «цена не опубликована», а не нуль бюджета", () => {
    const [tender] = mapRoseltorgRows(rowsOf(ROSELTORG_COMMERCIAL_ITEM));
    expect(tender?.financial.price).toBe(0);
    expect(tender?.lots[0]?.price).toBe(0);
  });

  it("суммирует лоты, когда цена есть у всех и набор полный", () => {
    const [tender] = mapRoseltorgRows(rowsOf(...ROSELTORG_MULTI_LOT_ITEMS));
    expect(tender?.lots).toHaveLength(3);
    expect(tender?.financial.price).toBe(280_500);
    expect(tender?.subject).toBe("Позиция каталога №1");
  });

  it("не публикует цену, если набор лотов неполный: сумма была бы занижена", () => {
    const [tender] = mapRoseltorgRows(rowsOf(...ROSELTORG_MULTI_LOT_ITEMS), {
      incompleteProcedures: new Set(["B2509261618185"]),
    });
    expect(tender?.lots).toHaveLength(3);
    expect(tender?.financial.price).toBe(0);
  });

  it("один лот без цены обнуляет цену закупки", () => {
    const rows = rowsOf(...ROSELTORG_MULTI_LOT_ITEMS).map((row, index) =>
      index === 1 ? { ...row, price: null } : row,
    );
    const [tender] = mapRoseltorgRows(rows);
    expect(tender?.financial.price).toBe(0);
    expect(tender?.lots.map((lot) => lot.price)).toEqual([280_000, 0, 250]);
  });

  it("лоты в разных валютах не складываются", () => {
    const rows = rowsOf(...ROSELTORG_MULTI_LOT_ITEMS).map((row, index) =>
      index === 1 ? { ...row, currency: "USD" } : row,
    );
    const [tender] = mapRoseltorgRows(rows);
    expect(tender?.financial.price).toBe(0);
    expect(tender?.financial.currency).toBe("RUB");
  });

  it("предмет закупки — предмет совпавшего лота, а не первого по порядку", () => {
    // Поиск по слову нашёл лот 2; первый лот к запросу отношения не имеет, и
    // карточка, начинающаяся с него, не объяснила бы владельцу, почему закупка
    // в выдаче.
    const rows = rowsOf(...ROSELTORG_MULTI_LOT_ITEMS);
    const [tender] = mapRoseltorgRows(rows, { matchedLots: [rows[1]!] });
    expect(tender?.subject).toBe("Насадка МОП, комплект");
    expect(tender?.lots).toHaveLength(3);
  });

  it("лоты идут по возрастанию номера, даже если выдача пришла в обратном порядке", () => {
    const rows = rowsOf(...ROSELTORG_MULTI_LOT_ITEMS).reverse();
    const [tender] = mapRoseltorgRows(rows);
    expect(tender?.lots.map((lot) => lot.number)).toEqual([1, 2, 3]);
  });

  it("срок закупки — самый ранний из сроков лотов", () => {
    const rows = rowsOf(...ROSELTORG_MULTI_LOT_ITEMS);
    rows[0] = { ...rows[0]!, submissionEnd: "2026-11-01T10:00:00+03:00" };
    const [tender] = mapRoseltorgRows(rows);
    expect(tender?.deadlines.submissionEnd).toBe("2026-10-20T10:00:00+03:00");
  });

  it("строки разных процедур дают разные закупки", () => {
    const tenders = mapRoseltorgRows(
      rowsOf(ROSELTORG_PRICED_ITEM, ROSELTORG_COMMERCIAL_ITEM, ROSELTORG_FZ44_ITEM),
    );
    expect(tenders).toHaveLength(3);
    expect(tenders.map((t) => t.regNumber)).toEqual([
      "32616431971",
      "ROSELTORG-B0210261118005",
      "0373200045226001469",
    ]);
  });
});

describe("mapRoseltorgRows — регион и заказчик", () => {
  it("регион заказчика площадка печатает в формате, который наш словарь понимает", () => {
    const [tender] = mapRoseltorgRows(rowsOf(ROSELTORG_FZ223_ITEM));
    expect(tender?.region).toBe("Санкт-Петербург");
    expect(tender?.deliveryAddress).toBe("Санкт-Петербург");
  });

  it("«99. Не указан» остаётся неизвестностью, а не другим регионом", () => {
    const [tender] = mapRoseltorgRows(rowsOf(ROSELTORG_UNKNOWN_REGION_ITEM));
    expect(tender?.region).toBe(UNKNOWN_REGION);
  });

  it("без организатора закупка не становится безымянной", () => {
    const rows = rowsOf(ROSELTORG_PRICED_ITEM).map((row) => ({
      ...row,
      organizerName: "  ",
      organizerInn: null,
    }));
    const [tender] = mapRoseltorgRows(rows);
    expect(tender?.customerName).toBe("Заказчик не указан");
    expect(tender?.customerInn).toBeNull();
  });

  it("пустой список строк не даёт ни одной закупки", () => {
    expect(mapRoseltorgRows([])).toEqual([]);
  });
});
