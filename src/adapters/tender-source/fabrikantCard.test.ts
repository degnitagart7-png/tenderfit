/**
 * Тесты разбора карточки процедуры Фабриканта. Сети нет: страницы дают фикстуры.
 */
import { describe, expect, it } from "vitest";

import {
  FABRIKANT_LOTS_PER_PAGE,
  fabrikantAmount,
  fabrikantCardPageCount,
  fabrikantCardPageUrl,
  fabrikantCardUrlKind,
  fabrikantCurrency,
  fabrikantDateTime,
  isFabrikantCardPage,
  isFabrikantCardUrl,
  parseFabrikantCard,
} from "./fabrikantCard";
import {
  FABRIKANT_CARD_OTHER_TAB_ACTIVE,
  FABRIKANT_COMMERCIAL_CARD,
  FABRIKANT_FZ223_CARD,
  FABRIKANT_NO_PRICE_CARD,
  FABRIKANT_PARTIAL_LOTS_CARD,
  FABRIKANT_PROCEDURE_DEADLINE_CARD,
  FABRIKANT_SPARSE_CARD,
  buildFabrikantCardPage,
  buildFabrikantSearchPage,
} from "./fabrikantTestFixtures";

describe("адрес карточки", () => {
  it("узнаёт адрес карточки /v2 на fabrikant.ru", () => {
    expect(
      isFabrikantCardUrl("https://fabrikant.ru/v2/trades/procedure/view/VEfh8dM8T7aBMwFbWZ4HXg"),
    ).toBe(true);
    expect(isFabrikantCardUrl("https://www.fabrikant.ru/v2/trades/procedure/view/ABC")).toBe(true);
  });

  it("не принимает за карточку другие поддомены площадки", () => {
    // «Маркет» ведёт на `market.fabrikant.ru`, страницы `/v2` у него нет.
    expect(
      isFabrikantCardUrl("https://market.fabrikant.ru/purchase_notice_es/view?id=01m3ycgche2yja"),
    ).toBe(false);
    // Секция 44-ФЗ ведёт на свой поддомен со своим путём.
    expect(
      isFabrikantCardUrl("https://44.fabrikant.ru/44/procedure/ezp21/0859200001126011816"),
    ).toBe(false);
    expect(isFabrikantCardUrl("https://example.test/v2/trades/procedure/view/ABC")).toBe(false);
    expect(isFabrikantCardUrl("")).toBe(false);
    expect(isFabrikantCardUrl("не адрес")).toBe(false);
  });

  it("различает, куда ведёт строка выдачи: ЕИС, «Маркет», секции и /v2", () => {
    // Живой замер 02.10.2026: из 79 строк выдачи без ключевого слова 47 вели на
    // `/v2`, 19 — в ЕИС, 9 — на «Маркет», 4 — в секцию Росатома. Одной причиной
    // эти группы не описать: строка в ЕИС не потеря вовсе, такую закупку приносит
    // адаптер реестра и вместе с документами.
    expect(fabrikantCardUrlKind("https://fabrikant.ru/v2/trades/procedure/view/ABC")).toBe("v2");
    expect(fabrikantCardUrlKind("https://www.fabrikant.ru/v2/trades/procedure/view/ABC")).toBe(
      "v2",
    );
    expect(
      fabrikantCardUrlKind(
        "https://zakupki.gov.ru/epz/order/extendedsearch/results.html?regNumber=012345",
      ),
    ).toBe("eis");
    expect(
      fabrikantCardUrlKind("https://market.fabrikant.ru/purchase_notice_es/view?id=01m3ycgche2yja"),
    ).toBe("market");
    expect(fabrikantCardUrlKind("https://market.fabrikant.ru/purchase_notice/view?id=1")).toBe(
      "market",
    );
    expect(fabrikantCardUrlKind("https://fabrikant.ru/trades/atom/PriceRequest/view/1")).toBe(
      "atom",
    );
    expect(
      fabrikantCardUrlKind("https://44.fabrikant.ru/44/procedure/ezp21/0859200001126011816"),
    ).toBe("fz44");
  });

  it("чужой хост, пустая строка и не адрес — прочее, а не одна из секций", () => {
    expect(fabrikantCardUrlKind("https://example.test/v2/trades/procedure/view/ABC")).toBe("other");
    // Протокол имеет значение: по http карточку не запрашиваем.
    expect(fabrikantCardUrlKind("http://fabrikant.ru/v2/trades/procedure/view/ABC")).toBe("other");
    expect(fabrikantCardUrlKind("")).toBe("other");
    expect(fabrikantCardUrlKind("не адрес")).toBe("other");
  });

  it("признание карточки — это ровно вид «/v2»", () => {
    // Два независимых решения об одном адресе разошлись бы молча: адаптер
    // пропускал бы строку с одной причиной, а вид считал бы другим.
    for (const url of [
      "https://fabrikant.ru/v2/trades/procedure/view/ABC",
      "https://market.fabrikant.ru/purchase_notice_es/view?id=1",
      "https://zakupki.gov.ru/epz/order/extendedsearch/results.html",
      "https://example.test/v2/trades/procedure/view/ABC",
      "",
    ]) {
      expect(isFabrikantCardUrl(url)).toBe(fabrikantCardUrlKind(url) === "v2");
    }
  });

  it("первая страница остаётся без параметра, остальные получают ?page=N", () => {
    const card = "https://fabrikant.ru/v2/trades/procedure/view/ABC";
    expect(fabrikantCardPageUrl(card, 1)).toBe(card);
    expect(fabrikantCardPageUrl(card, 0)).toBe(card);
    expect(fabrikantCardPageUrl(card, 2)).toBe(`${card}?page=2`);
    expect(fabrikantCardPageUrl(`${card}?tab=lots`, 3)).toBe(`${card}?tab=lots&page=3`);
  });

  it("лотов на страницу ровно пять, а страниц — с округлением вверх", () => {
    expect(FABRIKANT_LOTS_PER_PAGE).toBe(5);
    expect(fabrikantCardPageCount(null)).toBe(1);
    expect(fabrikantCardPageCount(0)).toBe(1);
    expect(fabrikantCardPageCount(1)).toBe(1);
    expect(fabrikantCardPageCount(5)).toBe(1);
    expect(fabrikantCardPageCount(6)).toBe(2);
    // Живой замер: у процедуры с 18 лотами вкладка показывает 18, а страница
    // отдаёт 5 — значит четыре запроса, и четвёртый приносит лоты 16–18.
    expect(fabrikantCardPageCount(18)).toBe(4);
    expect(fabrikantCardPageCount(-3)).toBe(1);
  });
});

describe("parseFabrikantCard: коммерческая закупка", () => {
  const card = parseFabrikantCard(FABRIKANT_COMMERCIAL_CARD);

  it("узнаёт разметку и читает объявленное число лотов", () => {
    expect(card.layoutRecognized).toBe(true);
    expect(card.declaredLotCount).toBe(1);
    expect(card.lotsOnPage).toBe(1);
  });

  it("оставляет панели уровня процедуры доступными по машинному ключу", () => {
    expect(card.panels["purchase_category_custom"]).toBe("Запрос предложений");
    expect(card.panels["purchase_section"]).toBe("Коммерческие процедуры");
    expect(card.panels["procedure_rnp"]).toBe("Да");
    expect(card.panels["national_privilege_enabled"]).toBe("Не установлено");
    // Значение сырое: дату из него достаёт fabrikantDateTime, а не обрезка.
    expect(card.panels["date_publication"]).toBe(
      "02.10.2026 16:58 Действия История изменений Закрыть Продолжить",
    );
    expect(fabrikantDateTime(card.panels["date_publication"] ?? "")).toBe(
      "2026-10-02T16:58:00+03:00",
    );
  });

  it("без номера в ЕИС — значит null, а не пустая строка", () => {
    expect(card.eisNumber).toBeNull();
  });

  it("разбирает организатора на имя, адрес и ИНН", () => {
    expect(card.organizer).toEqual({
      name: 'АО "ПРИМЕР ОРГАНИЗАТОРА"',
      postalAddress: "423650, Россия, Республика Татарстан (Татарстан), Менделеевск, Пионерская, 2",
      inn: "1627000000",
    });
  });

  it("разбирает единственный лот целиком", () => {
    expect(card.lots[0]).toEqual({
      number: 1,
      subject: 'Строительно-монтажные работы по объекту "Склад сырьевой соли", часть КМ',
      price: 1_500_000,
      vatIncluded: true,
      currency: "RUB",
      submissionEnd: "2026-10-12T17:00:00+03:00",
      deliveryRegion: "Республика Татарстан",
      deliveryDistrict: "Приволжский федеральный округ",
      deliveryAddress: "г. Менделеевск, ул. Пионерская, 2",
      okpd2Codes: ["43.39.19.190"],
      bidSecurityAmount: null,
      contractSecurityAmount: null,
      contractSecurityPercent: null,
      onlyForSmp: false,
    });
  });
});

describe("parseFabrikantCard: закупка 223-ФЗ", () => {
  const card = parseFabrikantCard(FABRIKANT_FZ223_CARD);

  it("номер извещения ЕИС читается из своей панели", () => {
    expect(card.eisNumber).toBe("32616400001");
    expect(card.panels["purchase_section"]).toBe("Закупки по 223-ФЗ");
  });

  it("цена, обеспечения и признак МСП доходят до лота", () => {
    expect(card.lots[0]?.price).toBe(119_994_640.4);
    expect(card.lots[0]?.vatIncluded).toBe(true);
    expect(card.lots[0]?.bidSecurityAmount).toBe(2_399_892.8);
    expect(card.lots[0]?.contractSecurityAmount).toBe(5_999_732.02);
    expect(card.lots[0]?.contractSecurityPercent).toBe(5);
    expect(card.lots[0]?.onlyForSmp).toBe(true);
  });

  it("город федерального значения приходит готовым названием субъекта", () => {
    expect(card.lots[0]?.deliveryRegion).toBe("Санкт-Петербург");
    expect(card.lots[0]?.deliveryDistrict).toBe("Северо-Западный федеральный округ");
    expect(card.organizer?.inn).toBe("7838000000");
  });
});

describe("parseFabrikantCard: многолотовая процедура", () => {
  const card = parseFabrikantCard(FABRIKANT_PARTIAL_LOTS_CARD);

  it("счётчик вкладки и число разобранных лотов — разные числа", () => {
    expect(card.declaredLotCount).toBe(18);
    expect(card.lotsOnPage).toBe(5);
    expect(card.lots).toHaveLength(5);
  });

  it("лоты идут по порядку и каждый несёт свою цену", () => {
    expect(card.lots.map((lot) => lot.number)).toEqual([1, 2, 3, 4, 5]);
    expect(card.lots.map((lot) => lot.price)).toEqual([
      1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000,
    ]);
    // Цена без НДС — отдельный факт, и он не должен потеряться.
    expect(card.lots.every((lot) => lot.vatIncluded === false)).toBe(true);
  });

  it("панели одного лота не протекают в соседний", () => {
    expect(card.lots.map((lot) => lot.subject)).toEqual([
      "Поставка смазочных материалов, лот 1",
      "Поставка смазочных материалов, лот 2",
      "Поставка смазочных материалов, лот 3",
      "Поставка смазочных материалов, лот 4",
      "Поставка смазочных материалов, лот 5",
    ]);
    // Процедурные панели не должны попасть ни в один лот.
    expect(card.lots.every((lot) => lot.deliveryRegion === "Самарская область")).toBe(true);
    expect(card.panels["date_publication"]).toBe("01.10.2026 16:32");
  });
});

describe("parseFabrikantCard: срок напечатан панелью процедуры", () => {
  const card = parseFabrikantCard(FABRIKANT_PROCEDURE_DEADLINE_CARD);

  it("панель срока у второго шаблона лежит на уровне процедуры", () => {
    // Исходная посылка теста: если площадка начнёт печатать срок в лоте, этот
    // тест скажет об этом, и правило наследования можно будет пересмотреть.
    expect(card.panels["proposal_date_stop"]).toBe("07.10.2026 10:00");
    expect(card.lotsOnPage).toBe(1);
  });

  it("лот получает срок процедуры, когда своего у него нет", () => {
    expect(card.lots[0]?.submissionEnd).toBe("2026-10-07T10:00:00+03:00");
  });

  it("остальные поля лота наследство не трогает", () => {
    expect(card.lots[0]?.price).toBe(3_850_000);
    expect(card.lots[0]?.deliveryRegion).toBe("Свердловская область");
    expect(card.lots[0]?.okpd2Codes).toEqual(["43.91.19.190"]);
  });

  it("собственный срок лота важнее срока процедуры", () => {
    const page = buildFabrikantCardPage({
      declaredLotCount: 1,
      organizer: null,
      procedurePanels: [
        {
          key: "proposal_date_stop",
          label: "Дата и время окончания приема заявок",
          value: "05.10.2026 10:00",
        },
      ],
      lots: [
        {
          number: 1,
          subject: "Поставка оборудования",
          price: "900 000,00",
          submissionEnd: "12.10.2026 17:00",
          deliveryRegion: null,
        },
      ],
    });
    expect(parseFabrikantCard(page).lots[0]?.submissionEnd).toBe("2026-10-12T17:00:00+03:00");
  });

  it("нечитаемый срок процедуры не превращается в срок лота", () => {
    // Выдуманная дата прошла бы проверку на просроченный срок и попала бы в
    // выдачу как живая. Пустая строка честнее: адаптер отбросит закупку со
    // счётчиком причины.
    const page = buildFabrikantCardPage({
      declaredLotCount: 1,
      organizer: null,
      procedurePanels: [
        {
          key: "proposal_date_stop",
          label: "Дата и время окончания приема заявок",
          value: "уточняется",
        },
      ],
      lots: [
        { number: 1, subject: "Поставка оборудования", price: "900 000,00", deliveryRegion: null },
      ],
    });
    expect(parseFabrikantCard(page).lots[0]?.submissionEnd).toBe("");
  });

  it("многолотовая процедура: срок достаётся каждому лоту страницы", () => {
    const page = buildFabrikantCardPage({
      declaredLotCount: 3,
      organizer: null,
      procedurePanels: [
        {
          key: "proposal_date_stop",
          label: "Дата и время окончания приема заявок",
          value: "07.10.2026 10:00",
        },
      ],
      lots: [1, 2, 3].map((number) => ({
        number,
        subject: `Поставка материалов, лот ${number}`,
        price: `${number}00 000,00`,
        deliveryRegion: null,
      })),
    });
    const parsed = parseFabrikantCard(page);
    expect(parsed.lots.map((lot) => lot.submissionEnd)).toEqual([
      "2026-10-07T10:00:00+03:00",
      "2026-10-07T10:00:00+03:00",
      "2026-10-07T10:00:00+03:00",
    ]);
  });
});

describe("parseFabrikantCard: цена не опубликована", () => {
  const card = parseFabrikantCard(FABRIKANT_NO_PRICE_CARD);

  it("«Без указания цены» даёт null, а не нуль", () => {
    expect(card.lots[0]?.price).toBeNull();
    expect(card.lots[0]?.currency).toBe("RUB");
    expect(card.lots[0]?.submissionEnd).toBe("2026-10-20T12:00:00+03:00");
  });

  it("нет панели места поставки — значит пустые строки, а не догадка", () => {
    expect(card.lots[0]?.deliveryRegion).toBe("");
    expect(card.lots[0]?.deliveryDistrict).toBe("");
    expect(card.lots[0]?.deliveryAddress).toBe("");
    expect(card.lots[0]?.okpd2Codes).toEqual([]);
  });
});

describe("parseFabrikantCard: пустая карточка", () => {
  const card = parseFabrikantCard(FABRIKANT_SPARSE_CARD);

  it("без панелей и лотов разметка считается неузнанной", () => {
    expect(card.layoutRecognized).toBe(false);
    expect(card.declaredLotCount).toBeNull();
    expect(card.lotsOnPage).toBe(0);
    expect(card.lots).toEqual([]);
    expect(card.organizer).toBeNull();
    expect(card.eisNumber).toBeNull();
    expect(card.panels).toEqual({});
  });

  it("страница при этом остаётся страницей площадки", () => {
    expect(isFabrikantCardPage(FABRIKANT_SPARSE_CARD)).toBe(true);
  });
});

describe("счётчик лотов ищется по названию вкладки", () => {
  const card = parseFabrikantCard(FABRIKANT_CARD_OTHER_TAB_ACTIVE);

  it("класс active на другой вкладке не меняет число лотов", () => {
    expect(card.declaredLotCount).toBe(1);
    expect(card.lotsOnPage).toBe(1);
    expect(card.lots[0]?.price).toBe(2_400_000);
  });
});

describe("личные данные не покидают парсер", () => {
  const cardWithContactPanel = buildFabrikantCardPage({
    declaredLotCount: 1,
    procedurePanels: [
      { key: "purchase_section", label: "Секция на торговой площадке", value: "Коммерческие процедуры" },
      {
        key: "procedure_personal_contact",
        label: "Контактное лицо",
        value: "Иванова Мария Петровна",
      },
    ],
    lots: [
      {
        number: 1,
        subject: "Поставка оборудования",
        price: "100 000,00",
        deliveryRegion: "Республика Татарстан",
      },
    ],
  });

  it("панель контактного лица не разбирается вовсе", () => {
    const card = parseFabrikantCard(cardWithContactPanel);
    expect(card.panels["procedure_personal_contact"]).toBeUndefined();
    expect(card.panels["purchase_section"]).toBe("Коммерческие процедуры");
  });

  it("в разборе нет ни имени, ни телефона, ни почты", () => {
    // Фикстура кладёт «Контактное лицо» и «Телефон» внутрь панели организатора
    // намеренно: проверить надо парсер, а не отсутствие поля в фикстуре.
    for (const html of [FABRIKANT_COMMERCIAL_CARD, FABRIKANT_FZ223_CARD, cardWithContactPanel]) {
      const dump = JSON.stringify(parseFabrikantCard(html));
      expect(dump).not.toContain("Иванова");
      expect(dump).not.toContain("Мария");
      expect(dump).not.toContain("000 000-00-00");
      expect(dump).not.toContain("example.test");
      expect(dump).not.toContain("Контактное лицо");
      expect(dump).not.toContain("Телефон");
    }
  });
});

describe("fabrikantAmount", () => {
  it("читает сумму с неразрывными пробелами и запятой вместо точки", () => {
    expect(fabrikantAmount("Цена с НДС : 119 994 640,40 Российский рубль (RUB)")).toBe(
      119_994_640.4,
    );
    expect(fabrikantAmount("Цена без НДС : 7 940 042,87 Российский рубль (RUB)")).toBe(
      7_940_042.87,
    );
    expect(fabrikantAmount("1\u00a0500\u00a0000,00")).toBe(1_500_000);
  });

  it("берёт первую сумму, а не процент за ней", () => {
    expect(fabrikantAmount("Да Размер 5 999 732,02 (5% от НМЦД) Валюта Российский рубль (RUB)")).toBe(
      5_999_732.02,
    );
    expect(fabrikantAmount("Да Сумма 2 399 892,80 Рубль (RUB)")).toBe(2_399_892.8);
  });

  it("без числа — null, а не нуль", () => {
    expect(fabrikantAmount("Без указания цены")).toBeNull();
    expect(fabrikantAmount("Не требуется")).toBeNull();
    expect(fabrikantAmount("")).toBeNull();
    expect(fabrikantAmount("цена по запросу")).toBeNull();
  });
});

describe("fabrikantDateTime", () => {
  it("дата и время в ISO с явным московским смещением", () => {
    expect(fabrikantDateTime("15.10.2026 17:00")).toBe("2026-10-15T17:00:00+03:00");
    expect(fabrikantDateTime("15.10.2026 в 17:00")).toBe("2026-10-15T17:00:00+03:00");
    expect(fabrikantDateTime("01.10.2026 16:32 Действия История изменений")).toBe(
      "2026-10-01T16:32:00+03:00",
    );
    expect(fabrikantDateTime("01.10.2026")).toBe("2026-10-01T00:00:00+03:00");
  });

  it("нечитаемая дата даёт пустую строку, а не «сегодня»", () => {
    expect(fabrikantDateTime("")).toBe("");
    expect(fabrikantDateTime("не указано")).toBe("");
    expect(fabrikantDateTime("99.99.9999 10:00")).toBe("");
    expect(fabrikantDateTime("01.10.2026 25:00")).toBe("");
  });
});

describe("fabrikantCurrency", () => {
  it("код валюты читается из скобок", () => {
    expect(fabrikantCurrency("Российский рубль (RUB)")).toBe("RUB");
    expect(fabrikantCurrency("Рубль (RUB)")).toBe("RUB");
    expect(fabrikantCurrency("Доллар США (USD)")).toBe("USD");
    expect(fabrikantCurrency("Евро (EUR)")).toBe("EUR");
    expect(fabrikantCurrency("Белорусский рубль (BYN)")).toBe("BYN");
  });

  it("незнакомая валюта остаётся пустой строкой: угадывать нечем", () => {
    expect(fabrikantCurrency("Условные единицы")).toBe("");
    expect(fabrikantCurrency("")).toBe("");
  });
});

describe("isFabrikantCardPage", () => {
  it("узнаёт карточку процедуры", () => {
    expect(isFabrikantCardPage(FABRIKANT_COMMERCIAL_CARD)).toBe(true);
    expect(isFabrikantCardPage(FABRIKANT_FZ223_CARD)).toBe(true);
  });

  it("не принимает за карточку антибот, пустоту и страницу выдачи", () => {
    expect(isFabrikantCardPage("")).toBe(false);
    expect(isFabrikantCardPage("<html><body>Доступ ограничен</body></html>")).toBe(false);
    expect(
      isFabrikantCardPage(
        buildFabrikantSearchPage({
          cards: [{ name: "Поставка", lotId: 1, procedureNumber: 1 }],
          total: 1,
          pages: 1,
        }),
      ),
    ).toBe(false);
  });
});
