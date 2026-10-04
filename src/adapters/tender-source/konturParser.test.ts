/**
 * Тесты разбора ответов Контур.Закупок.
 *
 * Фикстуры — реальные ответы API, снятые тестовым ключом 23.09.2026
 * (`POST /external/v1/search`, `GET /external/v1/testpurchases/{id}`,
 * `GET /external/v1/limitGroups`), поэтому ожидаемые значения не выдуманы, а
 * прочитаны из того, что источник отдаёт на самом деле. Исключение помечено
 * отдельно: блок `TenderRequirements` в тестовых карточках пуст, и его разбор
 * проверен на структуре из спецификации.
 */
import { describe, expect, it } from "vitest";
import {
  KONTUR_FIELDS,
  buildKonturSearchPayload,
  countBlurredDocuments,
  describeKonturBlur,
  extractKonturItems,
  extractKonturPageNumber,
  extractKonturTotal,
  fnv1aHex,
  isBlurredField,
  konturAvailableBudget,
  konturCacheKey,
  konturCardDocumentRefs,
  konturSubscriptionEnd,
  konturTightestLimitGroup,
  mapKonturDocumentType,
  mapKonturLaw,
  mapKonturLawCode,
  mapKonturLawName,
  mapKonturPlacingWay,
  mapLawToKonturCodes,
  matchesKonturLocalFilters,
  normalizeKonturDocuments,
  normalizeKonturLimitGroups,
  normalizeKonturRequirements,
  normalizeKonturSearchResults,
  normalizeKonturTender,
  parseKonturBoolean,
  parseKonturDate,
  parseKonturNumber,
  pick,
  pickString,
  regNumberFromExternalId,
  stableStringify,
  type KonturSearchQuery,
} from "@/adapters/tender-source/konturParser";
import {
  KONTUR_NOW,
  buildKonturSearchPage,
  konturCard223NoDeadline,
  konturCard44,
  konturCard615,
  konturCardCommercial,
  konturLimitGroupsResponse,
  konturSearchItem223,
  konturSearchItemAbandoned,
  konturSearchItemCancelled,
  konturSearchItemNoPrice,
} from "@/adapters/tender-source/konturTestFixtures";

/** Разобрать запись и отдать закупку, упав с понятным сообщением вместо null. */
function mustParse(raw: unknown) {
  const { tender, skip } = normalizeKonturTender(raw, KONTUR_NOW);
  if (!tender) throw new Error(`ожидалась закупка, получено skip=${String(skip)}`);
  return tender;
}

describe("чтение полей-кандидатов", () => {
  it("берёт первое непустое значение из списка имён", () => {
    // В карточке заказчик лежит в Lots[].Customers[].Organization{Inn},
    // в поисковой выдаче — прямо в Customers[]{Inn}. Имена разные, домен один.
    expect(pickString({ Inn: "", customerInn: "7700000001" }, KONTUR_FIELDS.inn)).toBeNull();
    expect(pickString({ Inn: "7700000001" }, KONTUR_FIELDS.inn)).toBe("7700000001");
    expect(pick(null, ["Id"])).toBeUndefined();
    expect(pick("строка", ["Id"])).toBeUndefined();
    expect(pick({ Id: "" }, KONTUR_FIELDS.id)).toBeUndefined();
  });

  it("закрашенное значение — отсутствие данных, а не данные", () => {
    // Реальный ответ тестового ключа: номер извещения скрыт частично.
    const blurred = { NotificationNumber: "3261░░░░░░░", Id: "32616401973" };
    expect(pick(blurred, KONTUR_FIELDS.regNumber)).toBeUndefined();
    expect(isBlurredField(blurred, KONTUR_FIELDS.regNumber)).toBe(true);
    // Зато внутренний Id не закрашивается никогда — на нём держится идентификация.
    expect(pick(blurred, KONTUR_FIELDS.id)).toBe("32616401973");
    // Закрашенным бывает и элемент списка.
    expect(isBlurredField({ DeliveryPlaces: ["░░░░░"] }, KONTUR_FIELDS.deliveryPlaces)).toBe(true);
  });

  it("разбирает цену и число в разных форматах", () => {
    expect(parseKonturNumber("1 320 332,00 ₽")).toBe(1320332);
    expect(parseKonturNumber(2511590.84)).toBe(2511590.84);
    expect(parseKonturNumber("много")).toBeNull();
    expect(parseKonturNumber(undefined)).toBeNull();
  });

  it("разбирает булевы значения источника", () => {
    expect(parseKonturBoolean("Да")).toBe(true);
    expect(parseKonturBoolean("0")).toBe(false);
    expect(parseKonturBoolean(true)).toBe(true);
    expect(parseKonturBoolean("неизвестно")).toBeNull();
  });

  it("приводит даты к ISO: ISO, «ДД.ММ.ГГГГ ЧЧ:ММ» (MSK) и epoch", () => {
    expect(parseKonturDate("2026-09-25T10:00:00+03:00")).toBe("2026-09-25T07:00:00.000Z");
    expect(parseKonturDate("24.09.2026 18:50")).toBe("2026-09-24T15:50:00.000Z");
    expect(parseKonturDate("21.09.2026")).toBe("2026-09-20T21:00:00.000Z");
    expect(parseKonturDate(1790000000000)).toBe(new Date(1790000000000).toISOString());
    expect(parseKonturDate("не дата")).toBeNull();
    expect(parseKonturDate("")).toBeNull();
    // Формат карточки Контур.Закупок — без миллисекунд и без смещения.
    expect(parseKonturDate("2022-01-11T07:00:00Z")).toBe("2022-01-11T07:00:00.000Z");
  });
});

describe("маппинг справочников", () => {
  it("переводит код типа торгов (`ApiSearchLaw`) в закон", () => {
    expect(mapKonturLawCode(1)).toBe("FZ_44");
    expect(mapKonturLawCode(2)).toBe("FZ_223");
    expect(mapKonturLawCode(5)).toBe("PP_RF_615");
    // Коммерческие торги источник описывает тремя кодами: агрегат и его части.
    expect(mapKonturLawCode(3)).toBe("COMMERCIAL");
    expect(mapKonturLawCode(8)).toBe("COMMERCIAL");
    expect(mapKonturLawCode(9)).toBe("COMMERCIAL");
    // Неизвестный код — null, а не догадка.
    expect(mapKonturLawCode(7)).toBeNull();
    expect(mapKonturLawCode("строка")).toBeNull();
  });

  it("переводит наименование типа торгов из карточки в закон", () => {
    expect(mapKonturLawName("44-ФЗ")).toBe("FZ_44");
    expect(mapKonturLawName("223-ФЗ")).toBe("FZ_223");
    expect(mapKonturLawName("615 ПП")).toBe("PP_RF_615");
    expect(mapKonturLawName("Коммерческие")).toBe("COMMERCIAL");
    expect(mapKonturLawName("")).toBeNull();
  });

  it("определяет закон по коду поиска, затем по наименованию карточки", () => {
    expect(mapKonturLaw({ TypeOfTrading: 2 })).toBe("FZ_223");
    expect(mapKonturLaw({ NotificationType: "615 ПП" })).toBe("PP_RF_615");
    // Ни кода, ни наименования — самый частый случай, как и в парсере ЕИС.
    expect(mapKonturLaw(undefined)).toBe("FZ_44");
  });

  it("раскладывает закон обратно в коды для поиска", () => {
    expect(mapLawToKonturCodes("FZ_44")).toEqual([1]);
    expect(mapLawToKonturCodes("PP_RF_615")).toEqual([5]);
    expect(mapLawToKonturCodes("COMMERCIAL")).toEqual([3, 8, 9]);
  });

  it("определяет способ отбора из реальных значений источника", () => {
    expect(mapKonturPlacingWay("Электронный аукцион")).toBe("ELECTRONIC_AUCTION");
    expect(mapKonturPlacingWay("Запрос предложений в электронной форме")).toBe(
      "REQUEST_FOR_PROPOSALS",
    );
    expect(mapKonturPlacingWay("Запрос котировок в электронной форме")).toBe(
      "REQUEST_FOR_QUOTATION",
    );
    // «Запрос цен» — название коммерческих закупок; по составу требований это котировки.
    expect(mapKonturPlacingWay("Запрос цен")).toBe("REQUEST_FOR_QUOTATION");
    expect(
      mapKonturPlacingWay("223-ФЗ Закупка у единственного поставщика (подрядчика, исполнителя)"),
    ).toBe("SOLE_SUPPLIER");
    // Названий «Тендер» и «Предварительный отбор» в словаре нет: OTHER честнее
    // догадки, а источник всегда виден в dataSource.
    expect(mapKonturPlacingWay("Тендер")).toBe("OTHER");
    expect(mapKonturPlacingWay("Предварительный отбор")).toBe("OTHER");
    expect(mapKonturPlacingWay("")).toBe("OTHER");
  });

  it("определяет тип документа по имени файла из карточки", () => {
    expect(mapKonturDocumentType(null, "Раздел №3 Типовой проект ГПД  Бурзян Рыба.docx")).toBe(
      "DRAFT_CONTRACT",
    );
    expect(mapKonturDocumentType(null, "Типовой контракт продукты 44-ФЗ.DOCX")).toBe(
      "DRAFT_CONTRACT",
    );
    expect(mapKonturDocumentType(null, "Прил 3 ПСД обычные новый формат.docx")).toBe(
      "PROJECT_DOCUMENTATION",
    );
    expect(mapKonturDocumentType(null, "Извещение о проведении.docx")).toBe("NOTICE");
    expect(mapKonturDocumentType(null, "Техническое задание.pdf")).toBe("TECHNICAL_SPEC");
    expect(mapKonturDocumentType(null, "Обоснование НМЦК.xlsx")).toBe("COST_JUSTIFICATION");
    expect(mapKonturDocumentType(null, "Декларация_ст.31.doc")).toBe("OTHER");
    expect(mapKonturDocumentType(null, "описание молоко.XLS")).toBe("OTHER");
    // «ГПД» распознаётся только как отдельное слово: «ГПДрыба» — не проект контракта.
    expect(mapKonturDocumentType(null, "ГПДрыба.docx")).toBe("OTHER");
  });
});

describe("карточка закупки 44-ФЗ (реальный ответ /testpurchases)", () => {
  const tender = mustParse(konturCard44);

  it("читает идентификатор, закон, предмет и заказчика", () => {
    expect(tender.id).toBe("kontur-0301300335621000492");
    expect(tender.regNumber).toBe("0301300335621000492");
    expect(tender.externalId).toBe("0301300335621000492");
    expect(tender.law).toBe("FZ_44");
    expect(tender.placingWay).toBe("ELECTRONIC_AUCTION");
    expect(tender.dataSource).toBe("KONTUR");
    expect(tender.subject).toContain("Рыба");
    expect(tender.onlyForSmp).toBe(true);
    // Заказчик берётся из лота, а не из организатора: у закупки два заказчика,
    // и оба они — реальные получатели товара.
    expect(tender.customerInn).toBe("0218000351");
    expect(tender.customerName).toContain("Бурзянская Центральная Районная Больница");
  });

  it("читает цену, обеспечение заявки и сроки", () => {
    expect(tender.financial.price).toBe(365426.6);
    expect(tender.financial.currency).toBe("RUB");
    expect(tender.financial.bidSecurityAmount).toBe(3654.27);
    // `DeliveryGuarantee` и `ServiceGuarantee` в ответе пусты, а `ContractGuarantee`
    // отсутствует: обеспечение контракта остаётся неизвестным, а не нулевым.
    expect(tender.financial.contractSecurityAmount).toBeNull();
    expect(tender.financial.advancePercent).toBeNull();
    expect(tender.deadlines.submissionEnd).toBe("2022-01-11T07:00:00.000Z");
    expect(tender.deadlines.publicationDate).toBe("2021-12-30T07:43:31.681Z");
    // UpdatedDatetime совпадает с датой публикации — так в ответе и есть.
    expect(tender.deadlines.lastUpdateDate).toBe("2021-12-30T07:43:31.681Z");
  });

  it("восстанавливает регион из адреса поставки заказчика в лоте", () => {
    // На верхнем уровне карточки DeliveryPlaces нет вовсе: адрес лежит в
    // CustomerRequirements внутри лота. Без этого закупка уехала бы в «Не указан»
    // и выпала из регионального отбора профиля.
    expect(tender.region).toBe("Республика Башкортостан");
    expect(tender.deliveryAddress).toContain("село Старосубхангулово");
    expect(tender.lots).toHaveLength(1);
    expect(tender.lots[0]?.deliveryRegion).toBe("Республика Башкортостан");
    expect(tender.lots[0]?.price).toBe(365426.6);
    expect(tender.okpd2Codes).toEqual(["10.20.13.122"]);
  });

  it("разбирает все семь документов из поля Docs", () => {
    expect(tender.documents).toHaveLength(7);
    expect(tender.documents[0]?.id).toBe("kontur-0301300335621000492-doc-1");
    expect(tender.documents[0]?.url).toContain("zakupki.gov.ru");
    // «Типовой проект ГПД» — это проект контракта, а не «прочее».
    const drafts = tender.documents.filter((doc) => doc.type === "DRAFT_CONTRACT");
    expect(drafts.map((doc) => doc.fileName)).toEqual([
      "Раздел №3 Типовой проект ГПД Бурзян Рыба.docx",
      "Раздел №3 Типовой проект ГПД Белорецк.docx",
    ]);
  });

  it("отдаёт ссылку на ЕИС, а не на ЭТП или на карточку Контур.Закупок", () => {
    expect(tender.eisUrl).toBe(
      "https://zakupki.gov.ru/epz/order/notice/ea44/view/common-info.html?regNumber=0301300335621000492",
    );
  });

  it("не находит закрашенных значений: карточка тестового набора чистая", () => {
    expect(describeKonturBlur(konturCard44)).toEqual({ fields: [], documents: 0 });
  });
});

describe("карточки прочих режимов", () => {
  it("коммерческая закупка: внутренний Id не совпадает с номером извещения", () => {
    const tender = mustParse(konturCardCommercial);
    expect(tender.id).toBe("kontur-IS28675728");
    expect(tender.regNumber).toBe("4390628");
    expect(tender.externalId).toBe("IS28675728");
    expect(tender.law).toBe("COMMERCIAL");
    expect(tender.financial.price).toBe(452010);
    // Единственная ссылка в ответе — на ЭТП; ЕИС у коммерческих закупок нет.
    expect(tender.eisUrl).toBe("https://novobl-zmo.rts-tender.ru/Trade/ViewTrade?id=4390628");
    expect(tender.documents).toHaveLength(2);
    expect(tender.customerInn).toBe("5410131768");
    expect(tender.region).toBe("Новосибирская область");
  });

  it("615-ПП без цены, без ОКПД2 и без условий заказчика всё равно разбирается", () => {
    const tender = mustParse(konturCard615);
    expect(tender.law).toBe("PP_RF_615");
    // `InitialSum.Price` = null: цена не «неизвестна», а отсутствует — в базе 0.
    expect(tender.financial.price).toBe(0);
    expect(tender.okpd2Codes).toEqual([]);
    expect(tender.customerInn).toBe("4345421582");
    // Региона в ответе действительно нет: «Не указан», а не выдуманный субъект.
    expect(tender.region).toBe("Не указан");
    expect(tender.deliveryAddress).toBe("");
    expect(tender.documents[0]?.type).toBe("PROJECT_DOCUMENTATION");
  });

  it("отбрасывает запись без срока подачи заявок с указанием причины", () => {
    // submission_end в базе NOT NULL, а вердикт зависит от дедлайна.
    expect(normalizeKonturTender(konturCard223NoDeadline, KONTUR_NOW).skip).toBe("no-deadline");
  });

  it("отбрасывает запись без идентификатора и не-объект", () => {
    expect(normalizeKonturTender({ Title: "без номера и срока" }, KONTUR_NOW).skip).toBe(
      "no-number",
    );
    expect(normalizeKonturTender("мусор", KONTUR_NOW).skip).toBe("not-an-object");
    expect(normalizeKonturTender(null, KONTUR_NOW).skip).toBe("not-an-object");
  });
});

describe("закрашенные значения тестового ключа", () => {
  const tender = mustParse(konturSearchItem223);

  it("номер берётся из незакрытого Id, а не из частично скрытого извещения", () => {
    // «3261░░░░░░░» как reg_number означало бы, что разные закупки collide
    // по одному ключу: reg_number в базе UNIQUE.
    expect(tender.regNumber).toBe("32616401973");
    expect(tender.id).toBe("kontur-32616401973");
  });

  it("скрытый заказчик и регион не превращаются в данные", () => {
    expect(tender.customerName).toBe("Заказчик не указан");
    expect(tender.customerInn).toBeNull();
    expect(tender.region).toBe("Не указан");
    expect(tender.deliveryAddress).toBe("");
    // Ссылка на карточку в Контур.Закупках не закрашивается — она и остаётся.
    expect(tender.eisUrl).toBe("https://zakupki.kontur.ru/32616401973");
  });

  it("чистые поля при этом читаются как обычно", () => {
    expect(tender.financial.price).toBe(2511590.84);
    expect(tender.law).toBe("FZ_223");
    expect(tender.placingWay).toBe("REQUEST_FOR_PROPOSALS");
    expect(tender.deadlines.submissionEnd).toBe("2026-10-01T05:00:00.000Z");
    expect(tender.deadlines.publicationDate).toBe("2026-09-23T00:00:00.000Z");
  });

  it("диагностика перечисляет скрытые поля доменными именами", () => {
    expect(describeKonturBlur(konturSearchItem223)).toEqual({
      fields: ["customerInn", "customerName", "deliveryPlaces", "etpLink", "regNumber"],
      documents: 0,
    });
    // Пустой список мест поставки — не закрашенность: скрывать нечего.
    expect(describeKonturBlur(konturSearchItemNoPrice).fields).toEqual([
      "customerInn",
      "customerName",
      "etpLink",
      "regNumber",
    ]);
  });

  it("документ с закрашенной ссылкой отбрасывается и считается в диагностике", () => {
    const raw = {
      Docs: [
        { FileName: "скрытый.docx", Url: "░░░░░░░░░░░░" },
        { FileName: "видимый.docx", Url: "https://zakupki.gov.ru/file?id=1" },
      ],
    };
    expect(countBlurredDocuments(raw)).toBe(1);
    expect(describeKonturBlur(raw)).toEqual({ fields: ["documentUrl"], documents: 1 });
    expect(normalizeKonturDocuments(raw, "kontur-1").map((doc) => doc.fileName)).toEqual([
      "видимый.docx",
    ]);
  });

  it("документ без ссылки бесполезен: пайплайн анализа работает по URL", () => {
    expect(normalizeKonturDocuments({ Docs: [{ FileName: "без-ссылки.pdf" }] }, "t-1")).toEqual([]);
  });

  /**
   * Список документов карточки читается иначе, чем normalizeKonturDocuments:
   * он обязан сохранить имя даже тогда, когда ссылку закрасил тариф. Имя — это
   * единственное, что партнёр может увидеть о «МТЗ .docx», пока боевого ключа
   * нет. Форма ответа — живая карточка RQ0336300038526000037 от 23.09.2026:
   * тестовый тариф отдаёт `FileName` целиком, а `Url` закрашивает.
   */
  it("список документов карточки различает закрашенную ссылку и пустое поле", () => {
    const raw = {
      Docs: [
        { FileName: "МТЗ .docx", Url: "░░░░░░░░░░░░░░░░░░░░" },
        { FileName: "видимый.docx", Url: "https://zakupki.gov.ru/44fz/filestore?uid=AA01" },
        { FileName: "без-адреса.pdf" },
      ],
    };

    expect(konturCardDocumentRefs(raw)).toEqual([
      { fileName: "МТЗ .docx", url: null, urlBlurred: true },
      {
        fileName: "видимый.docx",
        url: "https://zakupki.gov.ru/44fz/filestore?uid=AA01",
        urlBlurred: false,
      },
      { fileName: "без-адреса.pdf", url: null, urlBlurred: false },
    ]);
  });

  it("без имени файла строки списка нет: именовать нечего", () => {
    expect(konturCardDocumentRefs({ Docs: [{ Url: "https://zakupki.gov.ru/x" }] })).toEqual([]);
    expect(konturCardDocumentRefs({})).toEqual([]);
    expect(konturCardDocumentRefs(null)).toEqual([]);
  });
});

describe("номер извещения как ключ записи", () => {
  /**
   * Живая выдача 23.09.2026: из 168 закупок у четырёх `Id` начинается с «RQ»,
   * а закрашенный `NotificationNumber` совпадает с его цифровой частью
   * («RQ0328100002326000522» против «0328░░░░░░░░░░░░░░░»). ЕИС публикует эти
   * же извещения под номером без префикса, поэтому ключом записи обязан быть
   * номер извещения: иначе одна закупка легла бы двумя строками, а правило
   * «одна закупка — одна строка» сравнивает источники именно по `reg_number`.
   */
  it("снимает буквенный префикс внутреннего Id, когда номер извещения закрашен", () => {
    const tender = mustParse(konturSearchItemNoPrice);
    expect(tender.regNumber).toBe("0328100002326000522");
    // Внутренний Id не искажаем: по нему открывается карточка источника.
    expect(tender.externalId).toBe("RQ0328100002326000522");
    expect(tender.eisUrl).toBe("https://zakupki.kontur.ru/RQ0328100002326000522");
  });

  it("читаемый номер извещения важнее внутреннего Id", () => {
    const tender = mustParse({
      ...konturSearchItemNoPrice,
      NotificationNumber: "0328100002326000522",
    });
    expect(tender.regNumber).toBe("0328100002326000522");
    expect(tender.externalId).toBe("RQ0328100002326000522");
  });

  it("Id без похожего на номер остатка остаётся ключом записи", () => {
    // Префикс снимаем, только если остаток похож на номер извещения: 11 цифр
    // у 223-ФЗ, 19 у 44-ФЗ и ПП РФ 615. Иначе лучше уникальный внутренний Id,
    // чем выдуманный номер.
    expect(regNumberFromExternalId("RQ123")).toBe("RQ123");
    expect(regNumberFromExternalId("32616401973")).toBe("32616401973");
    expect(regNumberFromExternalId("AB12345678901")).toBe("12345678901");
    expect(regNumberFromExternalId(null)).toBeNull();
  });
});

describe("поисковая выдача", () => {
  const page = buildKonturSearchPage(
    [konturSearchItem223, konturSearchItemNoPrice, konturSearchItemCancelled, konturSearchItemAbandoned],
    { total: 379, pageNumber: 0 },
  );

  it("разбирает страницу `SearchResultItemPagingModel`", () => {
    const result = normalizeKonturSearchResults(JSON.parse(page), KONTUR_NOW);
    expect(result.tenders.map((tender) => tender.regNumber)).toEqual([
      "32616401973",
      "0328100002326000522",
    ]);
    // Отменённая и несостоявшаяся закупки не участвуют — но причина видна.
    expect(result.skipped).toEqual(["cancelled", "abandoned"]);
    expect(Object.keys(result.rawByRegNumber)).toEqual([
      "32616401973",
      "0328100002326000522",
    ]);
    expect(result.blurredFields).toEqual([
      "customerInn",
      "customerName",
      "deliveryPlaces",
      "etpLink",
      "regNumber",
    ]);
    expect(result.blurredDocuments).toBe(0);
  });

  it("закупка без НМЦ остаётся в выдаче с нулевой ценой", () => {
    const tender = mustParse(konturSearchItemNoPrice);
    expect(tender.financial.price).toBe(0);
    expect(tender.law).toBe("FZ_44");
    expect(tender.placingWay).toBe("REQUEST_FOR_QUOTATION");
    expect(tender.deadlines.submissionEnd).toBe("2026-09-29T14:00:00.000Z");
  });

  it("пустая выдача — нормальный результат, а не ошибка", () => {
    const result = normalizeKonturSearchResults(
      JSON.parse(buildKonturSearchPage([], { total: 0 })),
      KONTUR_NOW,
    );
    expect(result.tenders).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("находит массив закупок в корне и во вложенных обёртках", () => {
    expect(extractKonturItems([1, 2])).toEqual([1, 2]);
    expect(extractKonturItems({ Items: [{ Id: 1 }] })).toHaveLength(1);
    expect(extractKonturItems({ data: { Items: [{ Id: 1 }] } })).toHaveLength(1);
    expect(extractKonturItems({ message: "ok" })).toEqual([]);
    expect(extractKonturItems(null)).toEqual([]);
  });

  it("читает общее число закупок и номер страницы", () => {
    expect(extractKonturTotal(JSON.parse(page))).toBe(379);
    expect(extractKonturTotal({ Items: [] })).toBeNull();
    expect(extractKonturPageNumber(JSON.parse(page))).toBe(0);
    expect(extractKonturPageNumber({ PageNumber: "3" })).toBe(3);
    expect(extractKonturPageNumber({ Items: [] })).toBeNull();
  });
});

describe("требования заказчика", () => {
  /**
   * Структура из спецификации (`ExternalApiTenderRequirements`): в карточках
   * тестового набора блок `TenderRequirements` пуст, поэтому здесь она
   * собрана по схеме, а не по живому ответу.
   */
  const raw = {
    Lots: [
      {
        TenderRequirements: {
          Requirements: [
            { Name: "Членство в СРО", Content: "Требуется выписка" },
            { Name: "Наличие лицензии МЧС", Content: "" },
            { Name: "Опыт исполнения договоров", Content: "не менее 3" },
            { Name: "Кадровый состав", Content: "11 человек" },
            { Name: "Наличие оборудования", Content: "" },
            { Name: "Финансовая устойчивость", Content: "" },
          ],
          Restrictions: [
            {
              Name: "Запрет допуска товаров",
              Content: null,
              AddRestrictions: [{ NpaName: "Постановление 616", Note: "кроме" }],
            },
          ],
          Privileges: ["Субъектам малого предпринимательства", "░░░░░"],
        },
      },
    ],
  };

  it("распознаёт вид требования по наименованию", () => {
    const { requirements } = normalizeKonturRequirements(raw, "kontur-1");
    expect(requirements.map((item) => item.kind)).toEqual([
      "SRO",
      "LICENSE",
      "EXPERIENCE",
      "QUALIFIED_PERSONNEL",
      "EQUIPMENT",
      "FINANCIAL_STABILITY",
      "NATIONAL_REGIME",
      "OTHER",
    ]);
    expect(requirements[0]).toMatchObject({
      id: "kontur-1-req-1-1",
      title: "Членство в СРО",
      description: "Требуется выписка",
      mandatory: true,
    });
  });

  it("национальный режим виден только в ограничениях заказчика", () => {
    const { requirements, nationalRegime } = normalizeKonturRequirements(raw, "kontur-1");
    expect(nationalRegime).toBe(true);
    const restriction = requirements.find((item) => item.kind === "NATIONAL_REGIME");
    expect(restriction?.description).toBe("Постановление 616. кроме");
  });

  it("закрашенное преимущество не становится требованием", () => {
    const { requirements } = normalizeKonturRequirements(raw, "kontur-1");
    const privileges = requirements.filter((item) => item.id.includes("-priv-"));
    expect(privileges).toHaveLength(1);
    expect(privileges[0]?.title).toBe("Преимущество: Субъектам малого предпринимательства");
    expect(privileges[0]?.mandatory).toBe(false);
  });

  it("в реальных тестовых карточках требований нет — и это не ошибка", () => {
    expect(normalizeKonturRequirements(konturCard44, "kontur-1")).toEqual({
      requirements: [],
      nationalRegime: false,
    });
  });
});

describe("тело поиска (ExternalApiSearchArgs)", () => {
  it("собирает все фильтры под реальными именами полей API", () => {
    const payload = buildKonturSearchPayload(
      {
        laws: ["FZ_44", "COMMERCIAL"],
        keywords: [" капитальный ремонт ", ""],
        excludeKeywords: ["б/у"],
        regionIds: ["7700000000000"],
        customerInns: ["7700000001", "мусор"],
        minPrice: 100_000,
        maxPrice: 90_000_000,
        procedures: [3, 0],
        electronicPlaces: [2],
        statuses: [1, 2],
        smp: 1,
        strictSearch: true,
        attachments: true,
        maxPriceNone: false,
        publishDateFrom: "2026-09-01T00:00:00.000Z",
        publishDateTo: "2026-09-20T00:00:00.000Z",
        deadlineTo: "2026-10-01T00:00:00.000Z",
        limit: 20,
      },
      { pageNumber: 2, now: KONTUR_NOW },
    );

    expect(payload).toEqual({
      Text: ["капитальный ремонт"],
      Exclude: ["б/у"],
      IncludeInns: ["7700000001"],
      DateTimeFrom: "2026-09-01T00:00:00.000Z",
      DateTimeTo: "2026-09-20T00:00:00.000Z",
      RegionIds: ["7700000000000"],
      Laws: [1, 3, 8, 9],
      PurchaseStatuses: [1, 2],
      Procedures: [0, 3],
      ElectronicPlaces: [2],
      MaxPriceFrom: 100_000,
      MaxPriceTo: 90_000_000,
      MaxPriceNone: false,
      Smp: 1,
      StrictSearch: true,
      Attachments: true,
      ApplicationDeadlineFrom: KONTUR_NOW,
      ApplicationDeadlineTo: "2026-10-01T00:00:00.000Z",
      PageNumber: 2,
    });
  });

  it("без фильтров отправляет только обязательное: окно публикации и этап", () => {
    const payload = buildKonturSearchPayload({ laws: [] }, { pageNumber: 0, now: KONTUR_NOW });
    expect(payload).toEqual({
      // DateTimeFrom/DateTimeTo обязательны: без них поиск отвечает 400.
      DateTimeFrom: "2026-09-16T12:00:00.000Z",
      DateTimeTo: KONTUR_NOW,
      // По умолчанию — только закупки на этапе подачи заявок.
      PurchaseStatuses: [1],
      // Закупки без НМЦ не теряются: цену показывает карточка.
      MaxPriceNone: true,
      // Просроченная закупка не должна получать вердикт RECOMMENDED.
      ApplicationDeadlineFrom: KONTUR_NOW,
      PageNumber: 0,
    });
  });

  it("не отправляет фильтры, которых у API нет", () => {
    // Регионы применяются к полученной выдаче, а коды ОКПД2 API не фильтрует:
    // обещать их в запросе значило бы молча искать не то.
    const payload = buildKonturSearchPayload(
      { laws: ["FZ_44"], regions: ["Москва"], okpd2Codes: ["26.20"] },
      { pageNumber: 0, now: KONTUR_NOW },
    );
    expect(payload).not.toHaveProperty("regions");
    expect(payload).not.toHaveProperty("okpd2Codes");
    expect(payload).not.toHaveProperty("Regions");
    expect(payload["Laws"]).toEqual([1]);
  });

  it("номер страницы не бывает отрицательным", () => {
    expect(buildKonturSearchPayload({ laws: [] }, { pageNumber: -3, now: KONTUR_NOW })["PageNumber"]).toBe(0);
    expect(buildKonturSearchPayload({ laws: [] }, { pageNumber: 1.7, now: KONTUR_NOW })["PageNumber"]).toBe(1);
  });

  it("smp = 0 означает «не учитывать» и в запрос не попадает", () => {
    const payload = buildKonturSearchPayload({ laws: [], smp: 0 }, { pageNumber: 0, now: KONTUR_NOW });
    expect(payload).not.toHaveProperty("Smp");
  });

  it("выравнивает окно по часу: один и тот же поиск в разных минутах даёт один ключ кэша", () => {
    // Ключ кэша считается от тела запроса, а `DateTimeTo` и
    // `ApplicationDeadlineFrom` по умолчанию берутся из `now`. Без выравнивания
    // каждый прогон получал новый ключ и тратил платный запрос: живой прогон
    // 23.09.2026 показал, что второй запуск того же поиска увеличил
    // requestsToday до 2, хотя ответ уже лежал в kontur_raw_responses.
    const query: KonturSearchQuery = { laws: ["FZ_44"], keywords: ["капитальный ремонт"] };
    const first = buildKonturSearchPayload(query, { pageNumber: 0, now: "2026-09-23T14:13:34.849Z" });
    const second = buildKonturSearchPayload(query, { pageNumber: 0, now: "2026-09-23T14:59:07.123Z" });

    expect(first["DateTimeTo"]).toBe("2026-09-23T14:00:00.000Z");
    expect(first["ApplicationDeadlineFrom"]).toBe("2026-09-23T14:00:00.000Z");
    expect(first["DateTimeFrom"]).toBe("2026-09-16T14:00:00.000Z");
    expect(konturCacheKey("search", second)).toBe(konturCacheKey("search", first));
  });

  it("явно заданные границы окна тоже выравниваются", () => {
    // Панель и API-роут принимают даты из запроса; если оставить секунды, ключ
    // снова начнёт «плавать» между вызовами.
    const payload = buildKonturSearchPayload(
      {
        laws: [],
        publishDateFrom: "2026-09-01T08:37:12.500Z",
        publishDateTo: "2026-09-20T17:05:00.000Z",
        deadlineFrom: "2026-09-23T14:22:01.000Z",
        deadlineTo: "2026-10-01T09:59:59.000Z",
      },
      { pageNumber: 0, now: KONTUR_NOW },
    );

    expect(payload["DateTimeFrom"]).toBe("2026-09-01T08:00:00.000Z");
    expect(payload["DateTimeTo"]).toBe("2026-09-20T17:00:00.000Z");
    expect(payload["ApplicationDeadlineFrom"]).toBe("2026-09-23T14:00:00.000Z");
    expect(payload["ApplicationDeadlineTo"]).toBe("2026-10-01T09:00:00.000Z");
  });

  it("нечитаемая дата остаётся как есть, а не превращается в Invalid Date", () => {
    const payload = buildKonturSearchPayload(
      { laws: [], publishDateTo: "не дата" },
      { pageNumber: 0, now: KONTUR_NOW },
    );
    expect(payload["DateTimeTo"]).toBe("не дата");
  });
});

describe("суточные лимиты тарифа", () => {
  const groups = normalizeKonturLimitGroups(konturLimitGroupsResponse);

  it("разбирает ответ /external/v1/limitGroups", () => {
    expect(groups.map((group) => group.limitGroup)).toEqual(["search", "purchase", "results"]);
    expect(groups[0]).toEqual({
      limitGroup: "search",
      // Модификаторы объясняют, почему в выдаче есть Snippets и Participants.
      modifiers: ["SearchParticipants", "Snippets"],
      availableRequests: 199,
      totalLimit: 200,
      isPeriodic: true,
      subscriptionStart: "2026-09-23T08:14:27.229Z",
      subscriptionEnd: "2026-09-30T18:59:00.000Z",
    });
  });

  it("бюджет — остаток самой узкой группы из тех, что расходует синхронизация", () => {
    // `results` не участвует в синхронизации, поэтому его 200 не должны
    // выглядеть доступным бюджетом.
    expect(konturAvailableBudget(groups)).toBe(199);
    expect(konturTightestLimitGroup(groups)?.limitGroup).toBe("search");
    expect(konturAvailableBudget(groups, ["results"])).toBe(200);
    // Нужной группы у ключа нет — это не «лимит бесконечен».
    expect(konturAvailableBudget(groups, ["favorites"])).toBeNull();
    expect(konturTightestLimitGroup([])).toBeNull();
  });

  it("читает срок действия тарифа", () => {
    expect(konturSubscriptionEnd(groups)).toBe("2026-09-30T18:59:00.000Z");
    expect(konturSubscriptionEnd([])).toBeNull();
  });

  it("запись без имени группы отбрасывается: остаток не к чему отнести", () => {
    expect(
      normalizeKonturLimitGroups([{ AvailableRequests: 5, TotalLimit: 200 }, "мусор"]),
    ).toEqual([]);
  });

  it("ответ-объект тоже разбирается", () => {
    expect(normalizeKonturLimitGroups({ LimitGroups: konturLimitGroupsResponse })).toHaveLength(3);
  });
});

describe("ключ кэша", () => {
  it("не зависит от порядка ключей и различает разные запросы", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(fnv1aHex("a")).toHaveLength(8);
    expect(konturCacheKey("search", { a: 1, b: 2 })).toBe(konturCacheKey("search", { b: 2, a: 1 }));
    expect(konturCacheKey("search", { a: 1 })).not.toBe(konturCacheKey("search", { a: 2 }));
    expect(konturCacheKey("card", { a: 1 })).not.toBe(konturCacheKey("search", { a: 1 }));
  });

  it("одинаковый логический запрос даёт одинаковый ключ — на этом держится cache-first", () => {
    const query = { laws: ["FZ_44"] as const, keywords: ["ремонт"] };
    const first = buildKonturSearchPayload({ laws: [...query.laws], keywords: query.keywords }, {
      pageNumber: 0,
      now: KONTUR_NOW,
    });
    const second = buildKonturSearchPayload(
      { laws: [...query.laws], keywords: query.keywords },
      { pageNumber: 0, now: KONTUR_NOW },
    );
    expect(konturCacheKey("search", first)).toBe(konturCacheKey("search", second));
    // Другая страница — другой ключ: кэш не должен отдавать чужую выдачу.
    const third = buildKonturSearchPayload(
      { laws: [...query.laws], keywords: query.keywords },
      { pageNumber: 1, now: KONTUR_NOW },
    );
    expect(konturCacheKey("search", first)).not.toBe(konturCacheKey("search", third));
  });
});

describe("локальные фильтры (регион и ОКПД2)", () => {
  const bashkiria = mustParse(konturCard44);
  const novisibirsk = mustParse(konturCardCommercial);
  const noRegion = mustParse(konturCard615);

  it("без фильтров проходит вся выдача", () => {
    for (const tender of [bashkiria, novisibirsk, noRegion]) {
      expect(matchesKonturLocalFilters(tender, { laws: ["FZ_44"] })).toBe(true);
    }
  });

  it("отсекает другой субъект, оставляет свой", () => {
    const query: KonturSearchQuery = { laws: ["FZ_44"], regions: ["Республика Башкортостан"] };
    expect(matchesKonturLocalFilters(bashkiria, query)).toBe(true);
    expect(matchesKonturLocalFilters(novisibirsk, query)).toBe(false);
  });

  it("неизвестный регион не отсекается: «не определён» не равно «другой»", () => {
    // Тестовый ключ закрашивает места поставки, и регион «Не указан» почти у
    // всей выдачи. Отбросить её целиком — значит потерять данные, а не уточнить
    // поиск. Правило то же, что в matchesSearchProfile.
    expect(matchesKonturLocalFilters(noRegion, { laws: [], regions: ["Москва"] })).toBe(true);
    expect(noRegion.region).toBe("Не указан");
  });

  it("пустые строки в списке регионов не отсекают всё", () => {
    expect(matchesKonturLocalFilters(novisibirsk, { laws: [], regions: ["", "   "] })).toBe(true);
  });

  it("ОКПД2 сравнивается префиксом: класс профиля находит полный код", () => {
    expect(bashkiria.okpd2Codes).toEqual(["10.20.13.122"]);
    expect(matchesKonturLocalFilters(bashkiria, { laws: [], okpd2Codes: ["10.20"] })).toBe(true);
    expect(matchesKonturLocalFilters(bashkiria, { laws: [], okpd2Codes: ["10"] })).toBe(true);
    expect(matchesKonturLocalFilters(bashkiria, { laws: [], okpd2Codes: ["42.11"] })).toBe(false);
  });

  it("закупка без кодов ОКПД2 проходит фильтр кодов", () => {
    expect(noRegion.okpd2Codes).toEqual([]);
    expect(matchesKonturLocalFilters(noRegion, { laws: [], okpd2Codes: ["10.20"] })).toBe(true);
  });

  it("регион и ОКПД2 должны совпасть вместе, а не по отдельности", () => {
    expect(
      matchesKonturLocalFilters(bashkiria, {
        laws: [],
        regions: ["Республика Башкортостан"],
        okpd2Codes: ["42.11"],
      }),
    ).toBe(false);
    expect(
      matchesKonturLocalFilters(bashkiria, {
        laws: [],
        regions: ["Республика Башкортостан"],
        okpd2Codes: ["10.20.13"],
      }),
    ).toBe(true);
  });
});
