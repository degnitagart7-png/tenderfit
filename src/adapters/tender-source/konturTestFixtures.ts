/**
 * Фикстуры ответов Контур.Закупок для тестов.
 *
 * Это НЕ синтетика: тела фикстур — реальные ответы API, снятые тестовым ключом
 * 23.09.2026 (`POST /external/v1/search`, `GET /external/v1/testpurchases/{id}`,
 * `GET /external/v1/limitGroups`). Схема подтверждена спецификацией OpenAPI
 * 3.0.4 «АПИ Закупок» v1.0.0, полученной от вендора.
 *
 * Что изменено по сравнению с сырыми ответами и почему:
 *  - `ContactPerson` заменён на «см. документацию»: в реальном ответе там
 *    фамилия, личный e-mail и мобильный телефон конкретного человека, а
 *    персональные данные в репозиторий не попадают. Значение не выдумано —
 *    так поле заполнено в части настоящих карточек;
 *  - у производных записей (отменённая, несостоявшаяся) изменён `Id`, чтобы
 *    они не пересекались с оригиналом в пределах одной фикстуры;
 *  - всё остальное — структура, имена полей, даты, цены, коды ОКПД2, ссылки,
 *    наименования заказчиков и адреса поставки — без изменений. Закупки
 *    тестового набора публичны и относятся к 2021–2022 годам.
 *
 * Вторая особенность этих ответов сохранена намеренно: в поисковой выдаче
 * часть значений закрашена символом U+2591 (`BlurredApiSchema`). Так вёл себя
 * тестовый тариф; боевой ключ с 24.09.2026 отдаёт те же поля целиком (зонд не
 * нашёл ни одного маркера). Фикстуры оставлены как есть: они проверяют, что
 * парсер принимает закрашенное значение за отсутствие данных, а не за данные,
 * то есть работают тренировкой на случай понижения тарифа.
 */

/** Фиксированное «сейчас» для тестов — момент снятия ответов. */
export const KONTUR_NOW = "2026-09-23T12:00:00.000Z";

/* ==================== Поисковая выдача (закрашена тестовым ключом) ==================== */

/**
 * Запись выдачи 223-ФЗ (`SearchResultItemWithSnippets`). Закрашены номер
 * извещения, ссылка на ЭТП, места поставки, ИНН и наименование заказчика —
 * то есть всё, что идентифицирует участника. Чистыми остались `Id`, предмет,
 * цена, срок подачи и ссылка на карточку в Контур.Закупках.
 */
export const konturSearchItem223: Record<string, unknown> = {
  "Snippets": [
    "Работы по капитальному ремонту помещений Алуштинского"
  ],
  "Id": "32616401973",
  "NotificationNumber": "3261░░░░░░░",
  "OrderName": "Работы по капитальному ремонту помещений Алуштинского РЭС Южных ЭС",
  "NotificationTypeDesc": "Запрос предложений в электронной форме",
  "TypeOfTrading": 2,
  "MaxPrice": 2511590.84,
  "Currency": "RUB",
  "EpUri": "░░░░░░░░░░░░░░░░░░░░░░░░░",
  "Link": "https://zakupki.kontur.ru/32616401973",
  "ApplicationDeadline": "2026-10-01T05:00:00Z",
  "IsCancelled": false,
  "CreateDate": "2026-09-23T00:00:00",
  "DeliveryPlaces": [
    "░░░░░░░░░░░░░░░░░░░░░░░░░"
  ],
  "Inns": [
    "9102░░░░░░"
  ],
  "Participants": [],
  "Customers": [
    {
      "FullName": "ГУП Респ░░░░░░░░░░░░░░░░░░░░░░░░",
      "Inn": "9102░░░░░░",
      "Kpp": "9102░░░░░"
    }
  ],
  "CommissionDeadline": "2026-10-06T21:00:00Z",
  "IsAbandoned": false,
  "IsPlanning": false
};

/**
 * Запись без НМЦ: поле `MaxPrice` отсутствует вовсе (не null), а список мест
 * поставки пуст. Такую закупку показываем с пометкой «цена не указана» —
 * решение зафиксировано в docs/REFERENCE_KONTUR_API.md.
 */
export const konturSearchItemNoPrice: Record<string, unknown> = {
  "Snippets": [
    "подготовкой проектной документации, выполнением работ по капитальному",
    "ремонту с поставкой оборудования необходимого для"
  ],
  "Id": "RQ0328100002326000522",
  "NotificationNumber": "0328░░░░░░░░░░░░░░░",
  "OrderName": "Выполнение работ, связанных с одновременным выполнением инженерных изысканий, подготовкой проектной документации, выполнением работ по капитальному ремонту с поставкой оборудования необходимого для обеспечения эксплуатации объектов: \r\n- Лабораторный корпус 2, 1-й этаж, лаборатория профилактики болезней свиней, расположенный по адресу: г. Владимир, микрорайон Юрьевец, улица Гвардейская, дом 6 корпус 2;\r\n - Лабораторный корпус 6 , 1-й этаж, лаборатория профилактики болезней птиц, расположенный по адресу: г. Владимир, микрорайон Юрьевец, улица Гвардейская, дом 6 корпус 6.",
  "NotificationTypeDesc": "Запрос цен",
  "TypeOfTrading": 1,
  "Currency": "RUB",
  "EpUri": "░░░░░░░░░░░░░░░░░░░░░░░░░",
  "Link": "https://zakupki.kontur.ru/RQ0328100002326000522",
  "ApplicationDeadline": "2026-09-29T14:00:00Z",
  "IsCancelled": false,
  "CreateDate": "2026-09-23T00:00:00",
  "DeliveryPlaces": [],
  "Inns": [
    "3327░░░░░░"
  ],
  "Participants": [],
  "Customers": [
    {
      "FullName": "Федераль░░░░░░░░░░░░░░░░░░░░░░░░░░",
      "Inn": "3327░░░░░░",
      "Kpp": "3327░░░░░"
    }
  ],
  "CommissionDeadline": "2026-09-29T14:00:00Z",
  "IsAbandoned": false,
  "IsPlanning": false
};

/** Отменённая закупка: участвовать нельзя, запись отбрасывается с причиной. */
export const konturSearchItemCancelled: Record<string, unknown> = {
  "Snippets": [
    "Работы по капитальному ремонту помещений Алуштинского"
  ],
  "Id": "32616401973-cancel",
  "NotificationNumber": "3261░░░░░░░",
  "OrderName": "Работы по капитальному ремонту помещений Алуштинского РЭС Южных ЭС",
  "NotificationTypeDesc": "Запрос предложений в электронной форме",
  "TypeOfTrading": 2,
  "MaxPrice": 2511590.84,
  "Currency": "RUB",
  "EpUri": "░░░░░░░░░░░░░░░░░░░░░░░░░",
  "Link": "https://zakupki.kontur.ru/32616401973",
  "ApplicationDeadline": "2026-10-01T05:00:00Z",
  "IsCancelled": true,
  "CreateDate": "2026-09-23T00:00:00",
  "DeliveryPlaces": [
    "░░░░░░░░░░░░░░░░░░░░░░░░░"
  ],
  "Inns": [
    "9102░░░░░░"
  ],
  "Participants": [],
  "Customers": [
    {
      "FullName": "ГУП Респ░░░░░░░░░░░░░░░░░░░░░░░░",
      "Inn": "9102░░░░░░",
      "Kpp": "9102░░░░░"
    }
  ],
  "CommissionDeadline": "2026-10-06T21:00:00Z",
  "IsAbandoned": false,
  "IsPlanning": false
};

/** Несостоявшаяся закупка: тоже отбрасывается, но с другой причиной. */
export const konturSearchItemAbandoned: Record<string, unknown> = {
  "Snippets": [
    "Капитальный ремонт асфальтобетонных дорожек, площадок"
  ],
  "Id": "0843500000226005450-abandon",
  "NotificationNumber": "0843░░░░░░░░░░░░░░░",
  "OrderName": "Капитальный ремонт асфальтобетонных дорожек, площадок на территории Муниципальное бюджетное учреждение «Санаторный оздоровительный лагерь круглогодичного действия» Лесная Республика",
  "NotificationTypeDesc": "Запрос котировок в электронной форме",
  "TypeOfTrading": 1,
  "MaxPrice": 1587500,
  "Currency": "RUB",
  "EpUri": "░░░░░░░░░░░░░░░░░░░░░░░░░",
  "Link": "https://zakupki.kontur.ru/0843500000226005450",
  "ApplicationDeadline": "2026-09-30T02:00:00Z",
  "IsCancelled": false,
  "CreateDate": "2026-09-23T00:00:00",
  "DeliveryPlaces": [
    "░░░░░░░░░░░░░░░░░░░░░░░░░"
  ],
  "Inns": [
    "4501░░░░░░",
    "4508░░░░░░"
  ],
  "Participants": [],
  "Customers": [
    {
      "FullName": "МБУ «Сан░░░░░░░░░░░░░░░░░░░░░░░░░░",
      "Inn": "4508░░░░░░",
      "Kpp": "4508░░░░░"
    }
  ],
  "CommissionDeadline": "2026-10-01T21:00:00Z",
  "IsAbandoned": true,
  "IsPlanning": false
};

/** Страница выдачи: `SearchResultItemPagingModel` — Items, TotalCount, PageNumber. */
export function buildKonturSearchPage(
  items: Record<string, unknown>[],
  options: { total?: number; pageNumber?: number } = {},
): string {
  return JSON.stringify({
    PageNumber: options.pageNumber ?? 0,
    TotalCount: options.total ?? items.length,
    Items: items,
  });
}

/** Пустая выдача — нормальный результат, а не ошибка. */
export const konturSearchEmptyPage = buildKonturSearchPage([]);

/* ==================== Карточки закупки (чистые: /testpurchases) ==================== */

/**
 * Карточка 44-ФЗ, электронная закупка для СМП. Самая полная из тестовых:
 * организатор, семь документов, один лот с двумя заказчиками, обеспечение
 * заявки, места поставки и позиции с кодами ОКПД2.
 */
export const konturCard44: Record<string, unknown> = {
  "UpdatedDatetime": "2021-12-30T07:43:31.681Z",
  "InitialSum": {
    "Price": 365426.6,
    "Currency": "RUB"
  },
  "NotificationType": "44-ФЗ",
  "NotificationPlacingWay": "Электронный аукцион",
  "AuctionDateTime": "2022-01-12T21:00:00Z",
  "Docs": [
    {
      "FileName": "Декларация_ст.31.doc",
      "Url": "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=D458E2605929E670E05334548D0AFC89"
    },
    {
      "FileName": "Лист утверждения дат.doc",
      "Url": "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=D4583B35FF1546CDE05334548D0A2BAF"
    },
    {
      "FileName": "Декларация_СМП.doc",
      "Url": "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=D4567166F3C9DBE3E05334548D0AADF4"
    },
    {
      "FileName": "Раздел №3 Типовой проект ГПД  Бурзян Рыба.docx",
      "Url": "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=D455E6058036DCA0E05334548D0A1AAD"
    },
    {
      "FileName": "Рыба откорректированная ( Минтай+скумбрия).xlsx",
      "Url": "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=D4583503AE6547CAE05334548D0A4C76"
    },
    {
      "FileName": "Раздел №3 Типовой проект ГПД  Белорецк.docx",
      "Url": "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=D458E261F322E5C2E05334548D0A5956"
    },
    {
      "FileName": "Раздел 1,2.docx",
      "Url": "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=D45834C8D59C4833E05334548D0A7321"
    }
  ],
  "EtpLink": "https://www.roseltorg.ru/procedure/0301300335621000492",
  "EisLink": "https://zakupki.gov.ru/epz/order/notice/ea44/view/common-info.html?regNumber=0301300335621000492",
  "Link": "https://zakupki.kontur.ru/0301300335621000492",
  "Organizer": {
    "FullName": "ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ УЧРЕЖДЕНИЕ ЗДРАВООХРАНЕНИЯ РЕСПУБЛИКИ БАШКОРТОСТАН БЕЛОРЕЦКАЯ ЦЕНТРАЛЬНАЯ РАЙОННАЯ КЛИНИЧЕСКАЯ БОЛЬНИЦА",
    "Inn": "0256017557",
    "Kpp": "025601001"
  },
  "Id": "0301300335621000492",
  "NotificationNumber": "0301300335621000492",
  "Title": "Закупка продуктов питания ( Рыба ) в 1 полугодии 2022 года",
  "SMP": true,
  "PublicationDateTimeUTC": "2021-12-30T07:43:31.681Z",
  "ApplicationDeadline": "2022-01-11T07:00:00Z",
  "CommissionDeadline": "2022-01-13T00:00:00Z",
  "ContactPerson": {
    "Name": "см. документацию",
    "Email": "см. документацию",
    "Phone": "см. документацию"
  },
  "Lots": [
    {
      "Title": "Лот",
      "Price": {
        "Amount": 365426.6,
        "CurrencyCode": "RUB"
      },
      "Okdp2s": [],
      "Okved2s": [],
      "JointObjects": [],
      "Customers": [
        {
          "Organization": {
            "Inn": "0218000351",
            "Kpp": "021801001",
            "Name": "Государственное бюджетное учреждение Здравоохранения Республики Башкортостан Бурзянская Центральная Районная Больница"
          },
          "CustomerRequirements": {
            "DelieryPlace": "Республика Башкортостан, Бурзянский район, село Старосубхангулово, ул Уральская, д 7",
            "DeliveryPlaces": [
              "Республика Башкортостан, Бурзянский район, село Старосубхангулово, ул Уральская, д 7"
            ],
            "ApplicationGuarantee": 3654.27,
            "DeliveryGuarantee": {},
            "ServiceGuarantee": {}
          },
          "Objects": [
            {
              "Name": "Рыба морская мороженая (кроме сельди)",
              "Okpd2s": [
                {
                  "Code": "10.20.13.122",
                  "Name": "Рыба морская мороженая (кроме сельди)"
                }
              ],
              "Quantity": 380,
              "Okei": "кг",
              "ItemPrice": 135.67,
              "PositionPrice": 160090.6
            }
          ]
        },
        {
          "Organization": {
            "Inn": "0256017557",
            "Kpp": "025601001",
            "Name": "Государственное бюджетное учреждение Здравоохранения Республики Башкортостан Белорецкая Центральная Районная Клиническая Больница"
          },
          "CustomerRequirements": {
            "DelieryPlace": "453500,Российская Федерация, Республика Башкортостан, г. Белорецк,  ул. М. Гафури , 142а и     453500,Российская Федерация, Республика Башкортостан, г. Белорецк,  ул. М. Гафури , 142.",
            "DeliveryPlaces": [
              "453500,Российская Федерация, Республика Башкортостан, г. Белорецк,  ул. М. Гафури , 142а и     453500,Российская Федерация, Республика Башкортостан, г. Белорецк,  ул. М. Гафури , 142."
            ],
            "ApplicationGuarantee": 3654.27,
            "DeliveryGuarantee": {},
            "ServiceGuarantee": {}
          },
          "Objects": [
            {
              "Name": "Рыба морская мороженая (кроме сельди)",
              "Okpd2s": [
                {
                  "Code": "10.20.13.122",
                  "Name": "Рыба морская мороженая (кроме сельди)"
                }
              ],
              "Quantity": 800,
              "Okei": "кг",
              "ItemPrice": 135.67,
              "PositionPrice": 160090.6
            },
            {
              "Name": "Рыба морская мороженая (кроме сельди)",
              "Okpd2s": [
                {
                  "Code": "10.20.13.122",
                  "Name": "Рыба морская мороженая (кроме сельди)"
                }
              ],
              "Quantity": 800,
              "Okei": "кг",
              "ItemPrice": 256.67,
              "PositionPrice": 205336
            }
          ]
        }
      ]
    }
  ]
};

/**
 * Карточка 223-ФЗ без срока подачи заявок: поле `ApplicationDeadline`
 * отсутствует. `submission_end` в базе NOT NULL, а вердикт зависит от
 * дедлайна, поэтому запись отбрасывается — но причина фиксируется, а не
 * исчезает молча.
 */
export const konturCard223NoDeadline: Record<string, unknown> = {
  "UpdatedDatetime": "2022-04-04T10:20:42Z",
  "InitialSum": {
    "Price": 600000,
    "Currency": "RUB"
  },
  "NotificationType": "223-ФЗ",
  "NotificationPlacingWay": "223-ФЗ Закупка у единственного поставщика (подрядчика, исполнителя)",
  "Docs": [
    {
      "FileName": "обложка пз.pdf",
      "Url": "https://zakupki.gov.ru/223/purchase/public/download/download.html?id=78177095"
    }
  ],
  "EtpLink": "https://zakupki.gov.ru/epz/order/extendedsearch/results.html?searchString=32211281804",
  "EisLink": "https://zakupki.gov.ru/epz/order/extendedsearch/results.html?searchString=32211281804",
  "Link": "https://zakupki.kontur.ru/32211281804",
  "Organizer": {
    "FullName": "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ ГОСТИНИЦА \"БАШКОРТОСТАН\"",
    "Inn": "0269042945",
    "Kpp": "026901001"
  },
  "Id": "32211281804",
  "NotificationNumber": "32211281804",
  "Title": "поставка молочной, кисломолочной продукции",
  "SMP": false,
  "PublicationDateTimeUTC": "2022-04-04T05:20:42Z",
  "ContactPerson": {
    "Name": "см. документацию",
    "Email": "см. документацию",
    "Phone": "см. документацию"
  },
  "Lots": [
    {
      "Title": "поставка молочной, кисломолочной продукции",
      "Price": {
        "Amount": 600000,
        "CurrencyCode": "RUB"
      },
      "Okdp2s": [],
      "Okved2s": [],
      "JointObjects": [],
      "Customers": [
        {
          "Organization": {
            "Inn": "0269042945",
            "Kpp": "026901001",
            "Name": "Общество с ограниченной ответственностью Гостиница «Башкортостан»"
          },
          "CustomerRequirements": {
            "DelieryPlace": "Приволжский федеральный округ, Башкортостан Респ, 452750, Р.Б., г.Туймазы, пл.Октября д.2",
            "DeliveryPlaces": [
              "Приволжский федеральный округ, Башкортостан Респ, 452750, Р.Б., г.Туймазы, пл.Октября д.2"
            ],
            "ContractGuarantee": {
              "Amount": 0
            }
          },
          "Objects": [
            {
              "Okpd2s": [
                {
                  "Code": "10.51.52.130",
                  "Name": "Ряженка и варенец"
                }
              ],
              "Okved2s": [
                {
                  "Code": "46.33.1",
                  "Name": "Торговля оптовая молочными продуктами"
                }
              ]
            },
            {
              "Okpd2s": [
                {
                  "Code": "10.51.52.110",
                  "Name": "Йогурт"
                }
              ],
              "Okved2s": [
                {
                  "Code": "46.33.1",
                  "Name": "Торговля оптовая молочными продуктами"
                }
              ]
            },
            {
              "Okpd2s": [
                {
                  "Code": "10.51.11.150",
                  "Name": "Молоко питьевое прочее, не включенное в другие группировки"
                }
              ],
              "Okved2s": [
                {
                  "Code": "46.33.1",
                  "Name": "Торговля оптовая молочными продуктами"
                }
              ]
            },
            {
              "Okpd2s": [
                {
                  "Code": "10.51.52.200",
                  "Name": "Сметана"
                }
              ],
              "Okved2s": [
                {
                  "Code": "46.33.1",
                  "Name": "Торговля оптовая молочными продуктами"
                }
              ]
            },
            {
              "Okpd2s": [
                {
                  "Code": "10.51.40.300",
                  "Name": "Творог"
                }
              ],
              "Okved2s": [
                {
                  "Code": "46.33.1",
                  "Name": "Торговля оптовая молочными продуктами"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
};

/**
 * Коммерческая закупка с площадки-партнёра. Внутренний `Id` («IS28675728»)
 * не совпадает с номером извещения («4390628») — проверка правила
 * идентификации записи.
 */
export const konturCardCommercial: Record<string, unknown> = {
  "UpdatedDatetime": "2022-04-04T09:52:44Z",
  "InitialSum": {
    "Price": 452010,
    "Currency": "RUB"
  },
  "NotificationType": "Коммерческие",
  "NotificationPlacingWay": "Тендер",
  "Docs": [
    {
      "FileName": "Типовой контракт продукты 44-ФЗ.DOCX",
      "Url": "https://market-api.rts-tender.ru/files/FileDownloadHandler.ashx?FileGuid=8fd30004-5954-4162-bbf6-8a545fce2b9f"
    },
    {
      "FileName": "описание молоко.XLS",
      "Url": "https://market-api.rts-tender.ru/files/FileDownloadHandler.ashx?FileGuid=09d9235d-ae91-45b1-9c86-19518c08f03b"
    }
  ],
  "EtpLink": "https://novobl-zmo.rts-tender.ru/Trade/ViewTrade?id=4390628",
  "Link": "https://zakupki.kontur.ru/IS28675728",
  "Id": "IS28675728",
  "NotificationNumber": "4390628",
  "Title": "продукты питания",
  "SMP": false,
  "PublicationDateTimeUTC": "2022-04-04T08:18:27Z",
  "ApplicationDeadline": "2022-04-07T07:00:00Z",
  "ContactPerson": {
    "Name": "см. документацию",
    "Email": "см. документацию",
    "Phone": "см. документацию"
  },
  "Lots": [
    {
      "Title": "продукты питания",
      "Price": {
        "Amount": 452010,
        "CurrencyCode": "RUB"
      },
      "Okdp2s": [],
      "Okved2s": [],
      "JointObjects": [],
      "Customers": [
        {
          "Organization": {
            "Inn": "5410131768",
            "Kpp": "541001001",
            "Name": "Муниципальное казенное Дошкольное Образовательное учреждение г. Новосибирска «Детский Сад № 122 Комбинированного Вида «Золотая Рыбка»"
          },
          "CustomerRequirements": {
            "DelieryPlace": "г Новосибирск, ул Курчатова, д 11/5",
            "DeliveryPlaces": [
              "г Новосибирск, ул Курчатова, д 11/5"
            ]
          },
          "Objects": [
            {
              "Name": "продукты питания",
              "Okpd2s": [
                {
                  "Code": "10.51.11.141",
                  "Name": "Молоко питьевое коровье стерилизованное"
                }
              ],
              "Ktrus": [],
              "Quantity": 1,
              "Okei": "усл. ед",
              "ItemPrice": 452010,
              "PositionPrice": 452010
            }
          ]
        }
      ]
    }
  ]
};

/**
 * Карточка 615-ПП (капитальный ремонт): цена не задана (`InitialSum.Price`
 * = null), коды ОКПД2 пусты, требования заказчика отсутствуют — минимальный
 * состав полей, который всё равно должен разбираться.
 */
export const konturCard615: Record<string, unknown> = {
  "UpdatedDatetime": "2021-12-02T14:24:50.503Z",
  "InitialSum": {
    "Price": null,
    "Currency": "RUB"
  },
  "NotificationType": "615 ПП",
  "NotificationPlacingWay": "Предварительный отбор",
  "Docs": [
    {
      "FileName": "Прил 3 ПСД обычные новый формат.docx",
      "Url": "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=D22AC209C7C78DA2E05334548D0A81F0"
    }
  ],
  "EtpLink": "https://www.rts-tender.ru/poisk/poisk-615-pp?keywords=014020000452100021",
  "EisLink": "https://zakupki.gov.ru/epz/order/notice/po615/view/common-info.html?regNumber=014020000452100021",
  "Link": "https://zakupki.kontur.ru/014020000452100021",
  "Id": "014020000452100021",
  "NotificationNumber": "014020000452100021",
  "Title": "Предварительный отбор подрядных организаций на оказание услуг и (или) выполнение работ по оценке технического состояния многоквартирного дома, разработке проектной документации на проведение капитального ремонта общего имущества многоквартирных домов, в том числе на ремонт (замену, модернизацию) лифтов",
  "SMP": false,
  "PublicationDateTimeUTC": "2021-12-02T14:24:50.503Z",
  "ApplicationDeadline": "2021-12-24T09:00:00Z",
  "CommissionDeadline": "2021-12-30T00:00:00Z",
  "ContactPerson": {
    "Name": "см. документацию",
    "Email": "см. документацию",
    "Phone": "см. документацию"
  },
  "Lots": [
    {
      "Title": "Выполнение работ и (или) оказание услуг по оценке технического состояния,  разработке проектной документации на проведение капитального ремонта общего имущества многоквартирных домов, в том числе по ремонту (замене, модернизации) лифтов",
      "Okdp2s": [],
      "Okved2s": [],
      "JointObjects": [],
      "Customers": [
        {
          "Organization": {
            "Inn": "4345421582",
            "Kpp": "434501001",
            "Name": "Министерство Энергетики и Жилищно-Коммунального Хозяйства Кировской обл."
          },
          "Objects": []
        }
      ]
    }
  ]
};

/* ==================== Суточные лимиты тарифа ==================== */

/**
 * Ответ `GET /external/v1/limitGroups` — `ExternalApiLimitModel[]`.
 * Снят после одного платного поиска и одной платной карточки: счётчики
 * `search` и `purchase` показывают 199 из 200, а `results` не тронут.
 * Группы `favorites` нет ни у тестового, ни у боевого ключа.
 *
 * Это снимок тестового тарифа 23.09.2026. Боевой ключ 24.09.2026 отдаёт те же
 * три группы, но с лимитом 30 запросов в сутки на каждую — форму ответа
 * смена тарифа не меняет, поэтому фикстура остаётся пригодной для парсера.
 */
export const konturLimitGroupsResponse = [
  {
    "LimitGroup": "search",
    "Modifiers": [
      "SearchParticipants",
      "Snippets"
    ],
    "AvailableRequests": 199,
    "TotalLimit": 200,
    "IsPeriodic": true,
    "SubscriptionStart": "2026-09-23T08:14:27.229Z",
    "SubscriptionEnd": "2026-09-30T18:59:00Z"
  },
  {
    "LimitGroup": "purchase",
    "AvailableRequests": 199,
    "TotalLimit": 200,
    "IsPeriodic": true,
    "SubscriptionStart": "2026-09-23T08:14:27.229Z",
    "SubscriptionEnd": "2026-09-30T18:59:00Z"
  },
  {
    "LimitGroup": "results",
    "AvailableRequests": 200,
    "TotalLimit": 200,
    "IsPeriodic": true,
    "SubscriptionStart": "2026-09-23T08:14:27.229Z",
    "SubscriptionEnd": "2026-09-30T18:59:00Z"
  }
];

/* ==================== Ответы с ошибками ==================== */

/** Страница входа вместо JSON — типичный ответ при неверном пути. */
export const konturHtmlInsteadOfJson =
  "<!DOCTYPE html><html><head><title>Вход</title></head><body>Войдите в систему</body></html>";
