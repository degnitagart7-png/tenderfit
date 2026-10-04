import { describe, expect, it } from "vitest";
import { UNKNOWN_CUSTOMER, UNKNOWN_REGION } from "@/domain/entities";
import {
  FABRIKANT_PLACING_WAYS,
  fabrikantLaw,
  fabrikantLawFromRow,
  fabrikantPlacingWay,
  fabrikantRegNumber,
  mapFabrikantProcedure,
} from "./fabrikantMapper";
import type { FabrikantCard } from "./fabrikantCard";
import { parseFabrikantCard } from "./fabrikantCard";
import type { FabrikantLotRow } from "./fabrikantSearch";
import {
  FABRIKANT_COMMERCIAL_CARD,
  FABRIKANT_FZ223_CARD,
  FABRIKANT_NO_PRICE_CARD,
  FABRIKANT_PARTIAL_LOTS_CARD,
  FABRIKANT_SPARSE_CARD,
  buildFabrikantCardPage,
} from "./fabrikantTestFixtures";

/** Одна страница карточки, разобранная настоящим парсером. */
function cardOf(page: string): FabrikantCard {
  return parseFabrikantCard(page);
}

/** Несколько страниц одной процедуры. */
function cardsOf(...pages: readonly string[]): FabrikantCard[] {
  return pages.map((page) => parseFabrikantCard(page));
}

/** Строка выдачи, которая привела к карточке. */
function rowOf(fixture: Partial<FabrikantLotRow> = {}): FabrikantLotRow {
  return {
    procedureNumber: "5582388",
    lotId: "679704362",
    sequenceNumber: 1,
    subject: "Строительно-монтажные работы по объекту",
    sectionEnum: "commercial",
    eisNumber: null,
    cardUrl: "https://fabrikant.ru/v2/trades/procedure/view/_unYlPv3XRGsQJMaFpC7Lg",
    ...fixture,
  };
}

describe("fabrikantLaw", () => {
  it("девятнадцатизначный номер ЕИС — извещение 44-ФЗ", () => {
    expect(
      fabrikantLaw({ eisNumber: "0373200045226001469", sectionEnum: "", purchaseSection: "" }),
    ).toBe("FZ_44");
  });

  it("одиннадцать знаков с ведущей тройкой — 223-ФЗ", () => {
    expect(fabrikantLaw({ eisNumber: "32616400001", sectionEnum: "", purchaseSection: "" })).toBe(
      "FZ_223",
    );
  });

  it("номер ЕИС важнее слова секции", () => {
    expect(
      fabrikantLaw({ eisNumber: "32616400001", sectionEnum: "commercial", purchaseSection: "" }),
    ).toBe("FZ_223",);
  });

  it("слово секции 223fz — 223-ФЗ", () => {
    expect(fabrikantLaw({ eisNumber: null, sectionEnum: "223fz", purchaseSection: "" })).toBe(
      "FZ_223",
    );
  });

  it("секция Росатома — 223-ФЗ", () => {
    expect(fabrikantLaw({ eisNumber: null, sectionEnum: "rosatom", purchaseSection: "" })).toBe(
      "FZ_223",
    );
  });

  it("слово секции commercial — коммерческая закупка", () => {
    expect(fabrikantLaw({ eisNumber: null, sectionEnum: "commercial", purchaseSection: "" })).toBe(
      "COMMERCIAL",
    );
  });

  it("пустое слово секции: закон берётся из названия секции в карточке", () => {
    // Живой замер 02.10.2026: в секции «Закупки по 223-ФЗ» из 40 строк 17 пришли
    // со словом `"$undefined"` — так RSC кодирует JS-undefined. Название секции
    // из панели карточки остаётся единственным признаком.
    expect(
      fabrikantLaw({ eisNumber: null, sectionEnum: "", purchaseSection: "Закупки по 223-ФЗ" }),
    ).toBe("FZ_223");
    expect(
      fabrikantLaw({ eisNumber: null, sectionEnum: "", purchaseSection: "Закупки по 44-ФЗ" }),
    ).toBe("FZ_44");
    expect(
      fabrikantLaw({ eisNumber: null, sectionEnum: "", purchaseSection: "Коммерческие процедуры" }),
    ).toBe("COMMERCIAL");
  });

  it("капитальный ремонт — ППРФ 615", () => {
    expect(
      fabrikantLaw({
        eisNumber: null,
        sectionEnum: "",
        purchaseSection: "Капитальный ремонт (ППРФ №615)",
      }),
    ).toBe("PP_RF_615");
  });

  it("ни номера, ни секции — коммерческая закупка", () => {
    expect(fabrikantLaw({ eisNumber: null, sectionEnum: "", purchaseSection: "" })).toBe(
      "COMMERCIAL",
    );
  });

  it("нечитаемый номер ЕИС законом не считается", () => {
    expect(fabrikantLaw({ eisNumber: "12345", sectionEnum: "223fz", purchaseSection: "" })).toBe(
      "FZ_223",
    );
  });
});

/**
 * Закон по одной строке выдачи.
 *
 * Отдельная функция нужна адаптеру: закон видно до запроса карточки, и платить
 * запросом за извещение 44-ФЗ, которое профиль всё равно отбросит, незачем. Но
 * строка — не карточка: в 17 из 40 живых строк секции 223-ФЗ площадка присылает
 * `"$undefined"` вместо слова секции, и по такой строке закон НЕ выводится.
 * `null` здесь значит «не решай по строке, спроси карточку», а не «коммерческая».
 */
describe("fabrikantLawFromRow", () => {
  it("номер извещения ЕИС решает даже против слова секции", () => {
    expect(fabrikantLawFromRow(rowOf({ sectionEnum: "commercial", eisNumber: "0344300000026000001" }))).toBe(
      "FZ_44",
    );
    expect(fabrikantLawFromRow(rowOf({ sectionEnum: "", eisNumber: "32616433843" }))).toBe("FZ_223");
  });

  it("слово секции решает, когда номера ЕИС нет", () => {
    expect(fabrikantLawFromRow(rowOf({ sectionEnum: "223fz", eisNumber: null }))).toBe("FZ_223");
    expect(fabrikantLawFromRow(rowOf({ sectionEnum: "commercial", eisNumber: null }))).toBe(
      "COMMERCIAL",
    );
    expect(fabrikantLawFromRow(rowOf({ sectionEnum: "44fz", eisNumber: null }))).toBe("FZ_44");
    expect(fabrikantLawFromRow(rowOf({ sectionEnum: "rosatom", eisNumber: null }))).toBe("FZ_223");
  });

  it("нечитаемый номер ЕИС законом не считается, но секция остаётся в силе", () => {
    expect(fabrikantLawFromRow(rowOf({ sectionEnum: "223fz", eisNumber: "12345" }))).toBe("FZ_223");
  });

  it("пустая секция без номера ЕИС — закон не выводится", () => {
    expect(fabrikantLawFromRow(rowOf({ sectionEnum: "", eisNumber: null }))).toBeNull();
    expect(fabrikantLawFromRow(rowOf({ sectionEnum: "  ", eisNumber: "" }))).toBeNull();
  });

  it("незнакомое слово секции законом не считается", () => {
    expect(fabrikantLawFromRow(rowOf({ sectionEnum: "market", eisNumber: null }))).toBeNull();
  });
});

describe("fabrikantRegNumber", () => {
  it("номер извещения ЕИС остаётся собой", () => {
    expect(fabrikantRegNumber("5582388", "32616400001")).toBe("32616400001");
  });

  it("номер площадки получает префикс", () => {
    expect(fabrikantRegNumber("5582388", null)).toBe("FABRIKANT-5582388");
  });

  it("пустой номер процедуры — пустой ключ", () => {
    expect(fabrikantRegNumber("  ", "32616400001")).toBe("32616400001");
    expect(fabrikantRegNumber("", null)).toBe("");
  });
});

describe("fabrikantPlacingWay", () => {
  it("названия, снятые с живых карточек 02.10.2026", () => {
    expect(fabrikantPlacingWay("Запрос предложений")).toBe("REQUEST_FOR_PROPOSALS");
    expect(fabrikantPlacingWay("Запрос котировок 223-ФЗ")).toBe("REQUEST_FOR_QUOTATION");
    expect(fabrikantPlacingWay("Конкурс (заявка в 2х частях)")).toBe("OPEN_CONTEST");
    expect(
      fabrikantPlacingWay(
        "Конкурс в электронной форме, участниками которого могут являться только субъекты малого и среднего предпринимательства",
      ),
    ).toBe("OPEN_CONTEST");
  });

  it("«не указано» — прочерк, а не догадка", () => {
    expect(fabrikantPlacingWay("не указано")).toBe("OTHER");
  });

  it("регистр и лишние пробелы роли не играют", () => {
    expect(fabrikantPlacingWay("  ЗАПРОС   КОТИРОВОК ")).toBe("REQUEST_FOR_QUOTATION");
  });

  it("незнакомое название разбирается запасным классификатором по слову", () => {
    expect(fabrikantPlacingWay("Аукцион в электронной форме")).toBe("ELECTRONIC_AUCTION");
    expect(fabrikantPlacingWay("Открытый конкурс")).toBe("OPEN_CONTEST");
    expect(fabrikantPlacingWay("Запрос оферт")).toBe("REQUEST_FOR_PROPOSALS");
  });

  it("сбор информации победителя не выбирает — это OTHER", () => {
    expect(fabrikantPlacingWay("Мониторинг цен")).toBe("OTHER");
    expect(fabrikantPlacingWay("Запрос о предоставлении ценовой информации")).toBe("OTHER");
    expect(fabrikantPlacingWay("Маркет")).toBe("OTHER");
  });

  it("пустое название — OTHER", () => {
    expect(fabrikantPlacingWay("")).toBe("OTHER");
    expect(fabrikantPlacingWay("   ")).toBe("OTHER");
  });

  it("в словаре нет способа, которого нет в домене", () => {
    const known = [
      "ELECTRONIC_AUCTION",
      "OPEN_CONTEST",
      "REQUEST_FOR_QUOTATION",
      "REQUEST_FOR_PROPOSALS",
      "SOLE_SUPPLIER",
      "OTHER",
    ];
    for (const way of Object.values(FABRIKANT_PLACING_WAYS)) {
      expect(known).toContain(way);
    }
  });
});

describe("mapFabrikantProcedure: коммерческая закупка", () => {
  const mapped = mapFabrikantProcedure("5582388", [cardOf(FABRIKANT_COMMERCIAL_CARD)], {
    row: rowOf(),
    lotsComplete: true,
    syncStartedAt: "2026-10-02T09:00:00.000Z",
  });

  it("закупка собрана", () => {
    expect(mapped).not.toBeNull();
  });

  it("ключи и закон", () => {
    expect(mapped?.id).toBe("fabrikant-5582388");
    expect(mapped?.regNumber).toBe("FABRIKANT-5582388");
    expect(mapped?.externalId).toBe("5582388");
    expect(mapped?.law).toBe("COMMERCIAL");
    expect(mapped?.dataSource).toBe("FABRIKANT");
  });

  it("способ размещения и предмет", () => {
    expect(mapped?.placingWay).toBe("REQUEST_FOR_PROPOSALS");
    expect(mapped?.subject).toBe(
      'Строительно-монтажные работы по объекту "Склад сырьевой соли", часть КМ',
    );
  });

  it("заказчик из панели организатора", () => {
    expect(mapped?.customerName).toBe('АО "ПРИМЕР ОРГАНИЗАТОРА"');
    expect(mapped?.customerInn).toBe("1627000000");
  });

  it("регион и адрес поставки", () => {
    expect(mapped?.region).toBe("Республика Татарстан");
    expect(mapped?.deliveryAddress).toBe("г. Менделеевск, ул. Пионерская, 2");
  });

  it("деньги", () => {
    expect(mapped?.financial.price).toBe(1_500_000);
    expect(mapped?.financial.currency).toBe("RUB");
    expect(mapped?.financial.bidSecurityAmount).toBeNull();
    expect(mapped?.financial.contractSecurityAmount).toBeNull();
    expect(mapped?.financial.contractSecurityPercent).toBeNull();
  });

  it("сроки", () => {
    expect(mapped?.deadlines.submissionEnd).toBe("2026-10-12T17:00:00+03:00");
    expect(mapped?.deadlines.publicationDate).toBe("2026-10-02T16:58:00+03:00");
    expect(mapped?.deadlines.lastUpdateDate).toBe("");
  });

  it("один лот со своими кодами и местом поставки", () => {
    expect(mapped?.lots).toHaveLength(1);
    expect(mapped?.lots[0]).toEqual({
      id: "5582388-1",
      number: 1,
      subject: 'Строительно-монтажные работы по объекту "Склад сырьевой соли", часть КМ',
      price: 1_500_000,
      okpd2Codes: ["43.39.19.190"],
      deliveryRegion: "Республика Татарстан",
      deliveryAddress: "г. Менделеевск, ул. Пионерская, 2",
      deliveryTermDays: null,
    });
    expect(mapped?.okpd2Codes).toEqual(["43.39.19.190"]);
  });

  it("преимущество «Не установлено» — не национальный режим", () => {
    expect(mapped?.nationalRegime).toBe(false);
    expect(mapped?.onlyForSmp).toBe(false);
  });

  it("адрес карточки и метка партии", () => {
    expect(mapped?.eisUrl).toBe(
      "https://fabrikant.ru/v2/trades/procedure/view/_unYlPv3XRGsQJMaFpC7Lg",
    );
    expect(mapped?.syncedAt).toBe("2026-10-02T09:00:00.000Z");
  });

  it("документов источник не отдаёт", () => {
    expect(mapped?.documents).toEqual([]);
    expect(mapped?.requirements).toEqual([]);
    expect(mapped?.changeLog).toEqual([]);
  });
});

describe("mapFabrikantProcedure: закупка 223-ФЗ", () => {
  const mapped = mapFabrikantProcedure("5590001", [cardOf(FABRIKANT_FZ223_CARD)], {
    // Строка выдачи номера ЕИС не несёт: он виден только в панели карточки.
    row: rowOf({ procedureNumber: "5590001", sectionEnum: "" }),
    lotsComplete: true,
  });

  it("номер ЕИС из карточки становится ключом записи", () => {
    expect(mapped?.regNumber).toBe("32616400001");
    expect(mapped?.law).toBe("FZ_223");
  });

  it("номер ЕИС из строки выдачи спасает, когда панели в карточке нет", () => {
    const card = buildFabrikantCardPage({
      declaredLotCount: 1,
      eisNumber: null,
      lots: [
        {
          number: 1,
          subject: "Выполнение работ",
          price: "100 000,00",
          submissionEnd: "19.10.2026 09:00",
        },
      ],
    });
    const fromRow = mapFabrikantProcedure("5590020", [cardOf(card)], {
      row: rowOf({ procedureNumber: "5590020", sectionEnum: "", eisNumber: "32616400002" }),
      lotsComplete: true,
    });
    expect(fromRow?.regNumber).toBe("32616400002");
    expect(fromRow?.law).toBe("FZ_223");
  });

  it("цена, обеспечения и признак МСП", () => {
    expect(mapped?.financial.price).toBe(119_994_640.4);
    expect(mapped?.financial.bidSecurityAmount).toBe(2_399_892.8);
    expect(mapped?.financial.contractSecurityAmount).toBe(5_999_732.02);
    expect(mapped?.financial.contractSecurityPercent).toBe(5);
    expect(mapped?.onlyForSmp).toBe(true);
  });

  it("установленное преимущество — национальный режим", () => {
    expect(mapped?.nationalRegime).toBe(true);
  });

  it("регион города федерального значения", () => {
    expect(mapped?.region).toBe("Санкт-Петербург");
    expect(mapped?.customerInn).toBe("7838000000");
  });

  it("метка партии не выдумывается", () => {
    expect(mapped?.syncedAt).toBeNull();
  });
});

describe("mapFabrikantProcedure: цена публикуется только когда она осмысленна", () => {
  it("неполный набор лотов — цены нет", () => {
    const mapped = mapFabrikantProcedure("5581328", [cardOf(FABRIKANT_PARTIAL_LOTS_CARD)], {
      lotsComplete: false,
    });
    expect(mapped?.financial.price).toBe(0);
    expect(mapped?.lots).toHaveLength(5);
    expect(mapped?.lots.map((lot) => lot.price)).toEqual([
      1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000,
    ]);
  });

  it("восемнадцать лотов на четырёх страницах складываются", () => {
    const pages: string[] = [];
    for (let number = 1; number <= 18; number += 5) {
      const onPage: number[] = [];
      for (let offset = 0; offset < 5 && number + offset <= 18; offset += 1) {
        onPage.push(number + offset);
      }
      pages.push(
        buildFabrikantCardPage({
          declaredLotCount: 18,
          eisNumber: null,
          lots: onPage.map((lotNumber) => ({
            number: lotNumber,
            subject: `Поставка смазочных материалов, лот ${lotNumber}`,
            price: `${lotNumber} 000 000,00`,
            submissionEnd: "15.10.2026 17:00",
            deliveryRegion: "Самарская область",
          })),
        }),
      );
    }
    const mapped = mapFabrikantProcedure("5581328", cardsOf(...pages), { lotsComplete: true });
    expect(mapped?.lots.map((lot) => lot.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    expect(mapped?.financial.price).toBe(171_000_000);
    expect(mapped?.region).toBe("Самарская область");
  });

  it("«Без указания цены» — нуль, а не бесплатная закупка", () => {
    const mapped = mapFabrikantProcedure("5590002", [cardOf(FABRIKANT_NO_PRICE_CARD)], {
      lotsComplete: true,
    });
    expect(mapped?.financial.price).toBe(0);
    expect(mapped?.lots[0]?.price).toBe(0);
    expect(mapped?.deadlines.submissionEnd).toBe("2026-10-20T12:00:00+03:00");
  });

  it("лоты в разных валютах не складываются", () => {
    const card = buildFabrikantCardPage({
      declaredLotCount: 2,
      eisNumber: null,
      lots: [
        {
          number: 1,
          subject: "Поставка оборудования",
          price: "1 000 000,00",
          currency: "Российский рубль (RUB)",
          submissionEnd: "15.10.2026 17:00",
        },
        {
          number: 2,
          subject: "Поставка комплектующих",
          price: "20 000,00",
          currency: "Доллар США (USD)",
          submissionEnd: "15.10.2026 17:00",
        },
      ],
    });
    const mapped = mapFabrikantProcedure("5590003", [cardOf(card)], { lotsComplete: true });
    expect(mapped?.financial.price).toBe(0);
    expect(mapped?.financial.currency).toBe("RUB");
    expect(mapped?.lots.map((lot) => lot.price)).toEqual([1_000_000, 20_000]);
  });

  it("незнакомая валюта не публикуется рублями", () => {
    // Пустая валюта в домене считается рублём (`isRub`), поэтому сумма в
    // «условных единицах», оставленная как есть, уехала бы в ленту подписанной
    // рублями и прошла бы диапазон профиля. Цена не публикуется вовсе.
    const card = buildFabrikantCardPage({
      declaredLotCount: 1,
      eisNumber: null,
      lots: [
        {
          number: 1,
          subject: "Поставка оборудования",
          price: "20 000,00",
          currency: "Условные единицы",
          submissionEnd: "15.10.2026 17:00",
        },
      ],
    });
    const mapped = mapFabrikantProcedure("5590014", [cardOf(card)], { lotsComplete: true });
    expect(mapped?.financial.currency).toBe("");
    expect(mapped?.financial.price).toBe(0);
    expect(mapped?.lots[0]?.price).toBe(20_000);
  });

  it("обеспечение — самое большое среди лотов, а не первое попавшееся", () => {
    const card = buildFabrikantCardPage({
      declaredLotCount: 2,
      eisNumber: null,
      lots: [
        {
          number: 1,
          subject: "Первый лот",
          price: "1 000 000,00",
          submissionEnd: "15.10.2026 17:00",
          bidSecurityAmount: "10 000,00",
          contractSecurityAmount: "50 000,00",
          contractSecurityPercent: "5",
        },
        {
          number: 2,
          subject: "Второй лот",
          price: "9 000 000,00",
          submissionEnd: "15.10.2026 17:00",
          bidSecurityAmount: "90 000,00",
          contractSecurityAmount: "450 000,00",
          contractSecurityPercent: "5",
        },
      ],
    });
    const mapped = mapFabrikantProcedure("5590004", [cardOf(card)], { lotsComplete: true });
    expect(mapped?.financial.bidSecurityAmount).toBe(90_000);
    expect(mapped?.financial.contractSecurityAmount).toBe(450_000);
    expect(mapped?.financial.contractSecurityPercent).toBe(5);
  });
});

describe("mapFabrikantProcedure: то, чего карточка не сказала", () => {
  /** Карточка без организатора и без региона поставки: все три признака пусты. */
  const bareCard = buildFabrikantCardPage({
    declaredLotCount: 1,
    eisNumber: null,
    organizer: null,
    lots: [
      {
        number: 1,
        subject: "Оказание услуг по техническому обслуживанию",
        price: "500 000,00",
        submissionEnd: "20.10.2026 12:00",
        deliveryRegion: null,
      },
    ],
  });

  it("не узнанная разметка — не закупка", () => {
    expect(
      mapFabrikantProcedure("5590005", [cardOf(FABRIKANT_SPARSE_CARD)], { lotsComplete: true }),
    ).toBeNull();
  });

  it("пустой список страниц — не закупка", () => {
    expect(mapFabrikantProcedure("5590005", [], { lotsComplete: true })).toBeNull();
  });

  it("карточка без лотов — не закупка", () => {
    const card = buildFabrikantCardPage({
      declaredLotCount: null,
      eisNumber: null,
      procedurePanels: [
        { key: "purchase_section", label: "Секция", value: "Коммерческие процедуры" },
      ],
      lots: [],
    });
    expect(
      mapFabrikantProcedure("5590015", [cardOf(card)], { lotsComplete: true }),
    ).toBeNull();
  });

  it("регион остаётся не указанным, когда его нет ни у лота, ни у организатора", () => {
    const mapped = mapFabrikantProcedure("5590006", [cardOf(bareCard)], { lotsComplete: true });
    expect(mapped?.region).toBe(UNKNOWN_REGION);
    expect(mapped?.deliveryAddress).toBe(UNKNOWN_REGION);
    expect(mapped?.customerName).toBe(UNKNOWN_CUSTOMER);
    expect(mapped?.customerInn).toBeNull();
  });

  it("почтовый адрес организатора спасает регион", () => {
    const card = buildFabrikantCardPage({
      declaredLotCount: 1,
      eisNumber: null,
      organizer: {
        name: 'АО "ПРИМЕР ОРГАНИЗАТОРА"',
        address: "443000, Россия, Самарская область, Самара, ул. Примерная, 1",
        inn: "6315000000",
      },
      lots: [
        {
          number: 1,
          subject: "Оказание услуг",
          price: "500 000,00",
          submissionEnd: "20.10.2026 12:00",
          deliveryRegion: null,
        },
      ],
    });
    const mapped = mapFabrikantProcedure("5590007", [cardOf(card)], { lotsComplete: true });
    expect(mapped?.region).toBe("Самарская область");
  });

  it("предмет берётся из совпавшего лота выдачи, когда общего наименования нет", () => {
    const card = buildFabrikantCardPage({
      declaredLotCount: 3,
      eisNumber: null,
      lots: [1, 2, 3].map((number) => ({
        number,
        subject: `Позиция каталога №${number}`,
        price: "100 000,00",
        submissionEnd: "20.10.2026 12:00",
      })),
    });
    const mapped = mapFabrikantProcedure("5590008", [cardOf(card)], {
      row: rowOf({ procedureNumber: "5590008", subject: "Поставка насадок для экструдера" }),
      lotsComplete: true,
    });
    expect(mapped?.subject).toBe("Поставка насадок для экструдера");
    expect(mapped?.lots[0]?.subject).toBe("Позиция каталога №1");
  });

  it("без строки выдачи предмет — предмет первого лота", () => {
    const mapped = mapFabrikantProcedure("5590009", [cardOf(FABRIKANT_NO_PRICE_CARD)], {
      lotsComplete: true,
    });
    expect(mapped?.subject).toBe("Оказание услуг по техническому обслуживанию");
  });

  it("общее наименование закупки важнее предмета лота", () => {
    const mapped = mapFabrikantProcedure("5582388", [cardOf(FABRIKANT_COMMERCIAL_CARD)], {
      row: rowOf({ subject: "Совершенно другой предмет из выдачи" }),
      lotsComplete: true,
    });
    expect(mapped?.subject).toBe(
      'Строительно-монтажные работы по объекту "Склад сырьевой соли", часть КМ',
    );
  });

  it("срок — самый ранний из лотов", () => {
    const card = buildFabrikantCardPage({
      declaredLotCount: 2,
      eisNumber: null,
      lots: [
        {
          number: 1,
          subject: "Первый лот",
          price: "100 000,00",
          submissionEnd: "25.10.2026 12:00",
        },
        {
          number: 2,
          subject: "Второй лот",
          price: "200 000,00",
          submissionEnd: "15.10.2026 09:30",
        },
      ],
    });
    const mapped = mapFabrikantProcedure("5590010", [cardOf(card)], { lotsComplete: true });
    expect(mapped?.deadlines.submissionEnd).toBe("2026-10-15T09:30:00+03:00");
  });

  it("дата публикации берётся из панели, а не выдумывается", () => {
    const mapped = mapFabrikantProcedure("5590016", [cardOf(bareCard)], { lotsComplete: true });
    expect(mapped?.deadlines.publicationDate).toBe("");
  });

  it("коды ОКПД2 всех лотов объединяются без повторов", () => {
    const card = buildFabrikantCardPage({
      declaredLotCount: 2,
      eisNumber: null,
      lots: [
        {
          number: 1,
          subject: "Первый лот",
          price: "100 000,00",
          submissionEnd: "20.10.2026 12:00",
          okpd2: ["43.39.19.190", "20.59.42.000"],
        },
        {
          number: 2,
          subject: "Второй лот",
          price: "200 000,00",
          submissionEnd: "20.10.2026 12:00",
          okpd2: ["43.39.19.190"],
        },
      ],
    });
    const mapped = mapFabrikantProcedure("5590011", [cardOf(card)], { lotsComplete: true });
    expect(mapped?.okpd2Codes).toEqual(["43.39.19.190", "20.59.42.000"]);
    expect(mapped?.lots[1]?.okpd2Codes).toEqual(["43.39.19.190"]);
  });

  it("номер лота из заголовка, а не порядковый", () => {
    const mapped = mapFabrikantProcedure("5590012", [cardOf(bareCard)], { lotsComplete: true });
    expect(mapped?.lots[0]?.number).toBe(1);
    expect(mapped?.lots[0]?.id).toBe("5590012-1");
  });

  it("признак МСП виден и в названии процедуры", () => {
    const card = buildFabrikantCardPage({
      declaredLotCount: 1,
      eisNumber: null,
      procedurePanels: [
        {
          key: "purchase_category_custom",
          label: "Название процедуры на ЭТП",
          value:
            "Конкурс в электронной форме, участниками которого могут являться только субъекты малого и среднего предпринимательства",
        },
      ],
      lots: [
        {
          number: 1,
          subject: "Выполнение работ",
          price: "100 000,00",
          submissionEnd: "19.10.2026 09:00",
        },
      ],
    });
    const mapped = mapFabrikantProcedure("5590017", [cardOf(card)], { lotsComplete: true });
    expect(mapped?.onlyForSmp).toBe(true);
  });

  it("личные данные не попадают в закупку", () => {
    const commercial = JSON.stringify(
      mapFabrikantProcedure("5582388", [cardOf(FABRIKANT_COMMERCIAL_CARD)], {
        lotsComplete: true,
      }),
    );
    const fz223 = JSON.stringify(
      mapFabrikantProcedure("5590001", [cardOf(FABRIKANT_FZ223_CARD)], { lotsComplete: true }),
    );
    for (const printed of [commercial, fz223]) {
      for (const forbidden of [
        "Иванова",
        "Мария",
        "000 000-00-00",
        "Контактное лицо",
        "Телефон",
        "example.test",
      ]) {
        expect(printed).not.toContain(forbidden);
      }
    }
  });
});
