/**
 * Фикстуры Фабриканта: страница выдачи и карточка процедуры `/v2`.
 *
 * Обе технологии площадки воспроизведены здесь дословно, потому что они разные:
 *
 *  - **Выдача** — Next.js App Router. Данных в разметке нет вовсе: они лежат в
 *    RSC-payload внутри `self.__next_f.push([1,"…"])`, где аргумент — строковый
 *    литерал JSON. Кавычка внутри названия закупки поэтому arrives как `\\\"`, а
 *    структурная кавычка — как `\"`. Билдер собирает flight-текст настоящим
 *    `JSON.stringify`, а не склеивает строки вручную: ровно на этом месте
 *    зонд 02.10.2026 потерял 3 карточки из 40, когда разбирал выдачу регуляркой
 *    после одного прохода замены `\\"` → `"`.
 *
 *  - **Карточка** — легаси jQuery SSR. Каждое поле лежит в панели
 *    `<div class="panel-group panel-group-element-{ключ}">`, где ключ машинный и
 *    стабильный, а подпись рядом — человекочитаемая и не у всех процедур
 *    одинаковая (живой замер дал 30, 29 и 23 панели из 30 на трёх разных
 *    карточках). Каждый лот при этом живёт в своём контейнере
 *    `div.panel.panel-striped.lot_head_{id}`, внутри которого и заголовок
 *    «Лот №N», и все панели лота: на процедуре с 18 лотами страница держит 5
 *    контейнеров и 78 панелей — 13 процедурных и 13 на каждый лот.
 *
 * Персональных данных в фикстурах нет и быть не должно: живая карточка печатает
 * «Контактное лицо» и «Телефон», и они намеренно не входят ни в один билдер.
 * Значения заменены на вымышленные («Иванова Мария Петровна», «+7 000 000-00-00»,
 * «zakupki@example.test»), номера процедур и ИНН — на заведомо несуществующие.
 */

/** Момент, относительно которого живут все фикстуры: 02.10.2026 12:00 МСК. */
export const FABRIKANT_TEST_NOW = new Date("2026-10-02T09:00:00.000Z");

/** Что нужно, чтобы собрать одну карточку выдачи. */
export interface FabrikantCardFixture {
  /** Адрес карточки. null — площадка его не напечатала (так приходит «Маркет»). */
  readonly url?: string | null;
  readonly name: string;
  readonly lotId: number;
  readonly procedureNumber: number;
  /** Номер извещения ЕИС; null — закупка живёт только на площадке. */
  readonly purchaseOosNumber?: string | null;
  /**
   * Секция площадки. `undefined` кодируется в RSC строкой `"$undefined"` — это не
   * опечатка фикстуры, а буквально то, что приходит с площадки у «Маркета».
   */
  readonly sectionEnum?: string | null;
  readonly sequenceNumber?: number;
  readonly searchId?: string;
}

/**
 * Дословный объект карточки из живой выдачи секции 2 от 02.10.2026.
 *
 * Держим его отдельной константой, а не собираем билдером: в названии есть
 * вложенные кавычки, и это тот самый случай, на котором ломается наивный разбор.
 * Билдер знает только те поля, которые мы сами придумали, и молча пережил бы
 * изменение экранирования на площадке — этот фрагмент нет.
 */
export const FABRIKANT_VERBATIM_CARD_PROPS =
  '{"url":"https://fabrikant.ru/v2/trades/procedure/view/_unYlPv3XRGsQJMaFpC7Lg",' +
  '"name":"Строительно-монтажные работы по объекту \\"Склад сырьевой соли с узлом ' +
  'солерастворения\\", часть КМ","lotId":679704362,' +
  '"searchId":"76bd770e-4908-4bdf-84f1-c760f0201719","sectionEnum":"commercial",' +
  '"procedureNumber":5582388,"purchaseOosNumber":null,"sequenceNumber":1}';

/** Одна карточка выдачи в flight-тексте: объект props внутри RSC-обёртки. */
export function fabrikantCardProps(fixture: FabrikantCardFixture): string {
  const props: Record<string, unknown> = {
    url: fixture.url === undefined ? `https://fabrikant.ru/v2/trades/procedure/view/${fixture.lotId}` : fixture.url,
    name: fixture.name,
    lotId: fixture.lotId,
    searchId: fixture.searchId ?? "76bd770e-4908-4bdf-84f1-c760f0201719",
    // Площадка печатает "$undefined" строкой: так RSC кодирует JS-undefined.
    sectionEnum: fixture.sectionEnum === null || fixture.sectionEnum === undefined
      ? "$undefined"
      : fixture.sectionEnum,
    procedureNumber: fixture.procedureNumber,
    purchaseOosNumber: fixture.purchaseOosNumber ?? null,
    sequenceNumber: fixture.sequenceNumber ?? 1,
  };
  return `["$","$L72",null,${JSON.stringify(props)}]`;
}

/**
 * Объект-приманка, который площадка печатает рядом с каждой карточкой.
 *
 * В нём есть `url` и `lotId`, но нет `procedureNumber` — и это единственное, что
 * отличает его от карточки. В живой выдаче таких ровно столько же, сколько
 * карточек (80 вхождений `{"url":` на 40 закупок), поэтому разбор «по наявному
 * `url` и `lotId`» удвоил бы выдачу.
 */
export function fabrikantDecoyProps(lotId: number): string {
  return `["$","$L73",null,${JSON.stringify({ url: null, oosNumber: null, lotId })}]`;
}

/** Объект пагинации — единственный на страницу и единственный признак её конца. */
export function fabrikantPagination(total: number, pages: number, defaultLimit = 10): string {
  return `["$","$L15f",null,${JSON.stringify({
    keys: { page: "page_number", limit: "page_limit" },
    defaultLimit,
    total,
    pages,
  })}]`;
}

/** Что умеет собирать билдер страницы выдачи. */
export interface FabrikantPageFixture {
  /** Карточки выдачи по порядку. */
  readonly cards?: readonly FabrikantCardFixture[];
  /** Дословные фрагменты flight вместо собранных билдером (проверка экранирования). */
  readonly verbatimProps?: readonly string[];
  /** Объявленное площадкой число записей; null — объекта пагинации на странице нет. */
  readonly total?: number | null;
  /** Объявленное площадкой число страниц; null — объекта пагинации нет. */
  readonly pages?: number | null;
  /** Площадка напечатала «По вашему запросу ничего не найдено». */
  readonly noResults?: boolean;
  /**
   * Площадка нашла закупки, но не показала их анонимному посетителю: вместо
   * выдачи она печатает «Доступ к просмотру процедуры ограничен».
   */
  readonly restricted?: boolean;
}

/**
 * Страница выдачи целиком: HTML с flight-payload внутри `self.__next_f.push`.
 *
 * Кусков push несколько, как и в живом ответе (там их пять на 625 КБ): парсер
 * обязан собрать текст из всех, а не взять первый.
 */
export function buildFabrikantSearchPage(fixture: FabrikantPageFixture = {}): string {
  const parts: string[] = [];
  for (const card of fixture.cards ?? []) {
    parts.push(fabrikantCardProps(card));
    parts.push(fabrikantDecoyProps(card.lotId));
  }
  for (const verbatim of fixture.verbatimProps ?? []) {
    parts.push(verbatim);
  }
  if (fixture.noResults) {
    parts.push(
      '["$","p",null,{"className":"text-mine-shaft-500 text-center text-base",' +
        '"children":"По вашему запросу ничего не найдено"}]',
    );
  }
  if (fixture.restricted) {
    // Живая страница (замер 02.10.2026, запрос «МФУ») режет эту фразу на три
    // текстовых узла RSC. Фикстура повторяет разбивку: признак обязан находиться
    // по одной фразе площадки, а не по склеенному предложению.
    for (const piece of [
      "Доступ к просмотру процедуры ограничен",
      "Для ознакомления с извещением",
      "авторизуйтесь на ЭТП.",
    ]) {
      parts.push(
        '["$","p",null,{"className":"text-mine-shaft-500 text-center text-base",' +
          `"children":${JSON.stringify(piece)}}]`,
      );
    }
  }
  if (fixture.total !== null && fixture.total !== undefined && fixture.pages !== null && fixture.pages !== undefined) {
    parts.push(fabrikantPagination(fixture.total, fixture.pages));
  }
  const flight = parts.length > 0 ? `1:"$L1"\n2:${parts.join(",")}\n` : '1:"$L1"\n';
  // `JSON.stringify` строки даёт тот самый литерал с `\\\"` внутри, который
  // площадка присылает в HTML. Ручная замена кавычек здесь была бы ошибкой.
  return [
    "<!DOCTYPE html><html><body>",
    '<script>(self.__next_f=self.__next_f||[]).push([0])</script>',
    `<script>self.__next_f.push([1,${JSON.stringify(flight.slice(0, 20))}])</script>`,
    `<script>self.__next_f.push([1,${JSON.stringify(flight.slice(20))}])</script>`,
    "</body></html>",
  ].join("");
}

/** Одна панель карточки: машинный ключ, подпись и значение. */
export interface FabrikantPanelFixture {
  readonly key: string;
  readonly label: string;
  /** Значение разметкой. Строка без тегов оборачивается в текст как есть. */
  readonly value: string;
}

/** Панель целиком в разметке площадки. */
export function fabrikantPanel(panel: FabrikantPanelFixture): string {
  return `
\t\t\t\t\t\t<div class="panel-group panel-group-element-${panel.key}"
                                    >
\t\t\t\t\t<div class="row">
\t\t\t\t\t\t\t\t\t\t\t\t\t<div class="col-md-4">
                                ${panel.label}
                                                            </div>
\t\t\t\t\t\t\t\t\t\t\t\t<div class="col-md-8">
\t\t\t\t\t\t\t${panel.value}
\t\t\t\t\t\t</div>
\t\t\t\t\t</div>
\t\t\t\t</div>`;
}

/**
 * Составная панель «Информация об организаторе».
 *
 * Внутри неё площадка печатает и «Контактное лицо» с «Телефоном». Билдер кладёт их
 * в разметку намеренно — с вымышленными значениями: парсер обязан пройти мимо, и
 * тест это проверяет, а не надеется, что поля просто не оказалось в фикстуре.
 */
export function fabrikantOrganizerPanel(fixture: {
  readonly name: string;
  readonly address: string;
  readonly inn: string;
  readonly kpp?: string;
  readonly contactName?: string;
  readonly phone?: string;
}): string {
  const kpp = fixture.kpp === undefined ? "" : `
<div><strong>КПП</strong>



            ${fixture.kpp}
</div>`;
  return fabrikantPanel({
    key: "procedure_organizer",
    label: "Информация об организаторе",
    value: `
\t\t\t\t\t\t\t<div>
\t\t\t${fixture.name}\t</div><div><strong>Почтовый адрес</strong>



            ${fixture.address}
</div><div><strong>ИНН</strong>



            ${fixture.inn}
</div>${kpp}<div><strong>Контактное лицо</strong>
\t${fixture.contactName ?? "Иванова Мария Петровна"}</div><div><strong>Телефон</strong>



            ${fixture.phone ?? "+7 000 000-00-00"}
</div>`,
  });
}

/** Один лот карточки: заголовок «Лот №N» и панели этого лота. */
export function fabrikantLotBlock(fixture: {
  readonly number: number;
  readonly subject: string;
  /** Цена цифрами в формате площадки («7 940 042,87»). null — «Без указания цены». */
  readonly price?: string | null;
  readonly vatIncluded?: boolean;
  readonly currency?: string;
  readonly submissionEnd?: string;
  readonly deliveryRegion?: string | null;
  readonly deliveryDistrict?: string | null;
  readonly deliveryAddress?: string;
  readonly okpd2?: readonly string[];
  readonly bidSecurityAmount?: string | null;
  readonly contractSecurityAmount?: string | null;
  readonly contractSecurityPercent?: string | null;
  readonly onlyForSmp?: boolean;
}): string {
  const currency = fixture.currency ?? "Российский рубль (RUB)";
  const priceValue =
    fixture.price === undefined || fixture.price === null
      ? "Без указания цены"
      : `Цена ${fixture.vatIncluded === false ? "без" : "с"} НДС : ${fixture.price} ${currency}`;
  const panels: string[] = [
    fabrikantPanel({ key: "name", label: "Предмет договора", value: fixture.subject }),
    // Площадка кладёт внутрь панели цены скрипт смены валюты: живой замер показал
    // `$(document).ready(function () { … changeCurrency(…) });` прямо перед суммой.
    // Парсер обязан его вырезать, иначе «119 994 640,40» превратится в мусор.
    fabrikantPanel({
      key: "lot_price",
      label: "Начальная (максимальная) цена договора",
      value: `<script>$(document).ready(function () { if (typeof changeCurrency === 'function') { changeCurrency('${fixture.number}', '', '${currency}'); } });</script>
${priceValue}`,
    }),
    fabrikantPanel({ key: "lot_currency", label: "Валюта", value: currency }),
  ];
  if (fixture.submissionEnd !== undefined) {
    panels.push(
      fabrikantPanel({
        key: "proposal_date_stop",
        label: "Дата и время окончания приема заявок",
        value: fixture.submissionEnd,
      }),
    );
  }
  if (fixture.deliveryRegion !== null) {
    panels.push(
      fabrikantPanel({
        key: "lot_delivery_place",
        label: "Место поставки",
        value: `
<div><strong>Код региона по ОКАТО</strong> 40000000000</div>
<div><strong>Субъект РФ\\Федеральный округ</strong> ${fixture.deliveryDistrict ?? fixture.deliveryRegion ?? ""}</div>
<div><strong>Субъект РФ\\Регион</strong> ${fixture.deliveryRegion ?? ""}</div>
<div><strong>Место поставки товара, работ, услуг</strong> ${fixture.deliveryAddress ?? ""}</div>`,
      }),
    );
  }
  if (fixture.okpd2 !== undefined && fixture.okpd2.length > 0) {
    panels.push(
      fabrikantPanel({
        key: "1_lot_textarea6076c6e7473a3",
        label: "Требования к участникам закупки о представлении информации и документов",
        value: `<table><tr><td>${fixture.subject}</td><td>${fixture.okpd2
          .map((code) => `ОКПД2 ${code} Работы прочие`)
          .join("<br/>")}</td></tr></table>`,
      }),
    );
  }
  if (fixture.bidSecurityAmount !== undefined && fixture.bidSecurityAmount !== null) {
    panels.push(
      fabrikantPanel({
        key: "provision_type",
        label: "Обеспечение заявки",
        value: `Да Сумма ${fixture.bidSecurityAmount} Рубль (RUB)`,
      }),
    );
  }
  if (fixture.contractSecurityAmount !== undefined && fixture.contractSecurityAmount !== null) {
    panels.push(
      fabrikantPanel({
        key: "provision_contract",
        label: "Обеспечение исполнения договора",
        value: `Да Размер ${fixture.contractSecurityAmount}${
          fixture.contractSecurityPercent === undefined || fixture.contractSecurityPercent === null
            ? ""
            : ` (${fixture.contractSecurityPercent}% от НМЦД)`
        } Валюта ${currency}`,
      }),
    );
  }
  if (fixture.onlyForSmp) {
    panels.push(
      fabrikantPanel({
        key: "lot_msp",
        label: "Конкурентная закупка, участниками которой могут быть только субъекты МСП",
        value: "Да",
      }),
    );
  }
  // Контейнер лота воспроизведён с живой разметки: на странице процедуры каждый
  // лот лежит в своём `div.panel.panel-striped.lot_head_{id}`, и внутри него —
  // и заголовок «Лот №N», и все панели этого лота (замер 02.10.2026: 78 панелей
  // = 13 процедурных + 5×13 лотовых). Идентификатор в классе свой, не тот, что
  // `lotId` из выдачи: у процедуры 5581328 лоты в выдаче шли как 679661088…, а в
  // карточке контейнеры назывались `lot_head_803606`, `lot_head_803642`, …
  const containerId = 803600 + fixture.number;
  return `
<div class="panel panel-default panel-striped lot_head_${containerId}">
\t<div class="panel-heading clearfix" id="${containerId}">
\t\t<div class="row">
\t\t\t<div class="form_label">Лот №${fixture.number}. ${fixture.subject} - Прием заявок</div>
\t\t</div>
\t</div>
\t<div class="panel-body">
${panels.join("\n")}
\t</div>
</div>`;
}

/** Что умеет собирать билдер карточки. */
export interface FabrikantCardPageFixture {
  /** Объявленное площадкой число лотов во вкладке «Список лотов». */
  readonly declaredLotCount?: number | null;
  /** Панели уровня процедуры, до первого контейнера лота. */
  readonly procedurePanels?: readonly FabrikantPanelFixture[];
  /** Панель организатора; null — не печатать вовсе. */
  readonly organizer?: Parameters<typeof fabrikantOrganizerPanel>[0] | null;
  /** Лоты этой страницы. */
  readonly lots?: readonly Parameters<typeof fabrikantLotBlock>[0][];
  /** Номер закупки в ЕИС; null — панель не печатается. */
  readonly eisNumber?: string | null;
  /**
   * Какая вкладка открыта. По умолчанию «Список лотов», как и в живом ответе, но
   * сценарий с другой активной вкладкой доказывает, что счётчик лотов парсер
   * ищет по названию вкладки, а не по классу `active` и не по позиции.
   */
  readonly activeTab?: string;
}

/** Вкладки карточки в живом порядке; у «Прием заявок» счётчик «0/0». */
const CARD_TABS: readonly [title: string, counter: string][] = [
  ["Список лотов", ""],
  ["Документация", ""],
  ["Прием заявок", "0/0"],
  ["Протоколы", ""],
  ["Запросы разъяснений", "0"],
  ["Запросы уточнений", "0"],
  ["Переторжки и переговоры", "0/0"],
];

/**
 * Страница карточки `/v2/trades/procedure/view/{id}`.
 *
 * Вкладки и счётчик лотов воспроизведены дословно: именно по
 * `<span class="tab-counter">` у вкладки «Список лотов» парсер узнаёт, сколько
 * лотов в процедуре всего, и только сравнив это число с разобранным понимает,
 * можно ли публиковать цену. Счётчики есть и у других вкладок — «0/0» у приёма
 * заявок, «0» у запросов разъяснений, — поэтому читать первый попавшийся нельзя.
 */
export function buildFabrikantCardPage(fixture: FabrikantCardPageFixture = {}): string {
  const panels: string[] = [];
  for (const panel of fixture.procedurePanels ?? []) {
    panels.push(fabrikantPanel(panel));
  }
  if (fixture.organizer !== null) {
    panels.push(
      fabrikantOrganizerPanel(
        fixture.organizer ?? {
          name: 'АО "ПРИМЕР ОРГАНИЗАТОРА"',
          address: "423650, Россия, Республика Татарстан (Татарстан), Менделеевск, Пионерская, 2",
          inn: "1627000000",
          kpp: "162701001",
        },
      ),
    );
  }
  if (fixture.eisNumber !== undefined && fixture.eisNumber !== null) {
    panels.push(
      fabrikantPanel({
        key: "external_oos_number_url",
        label: "Номер закупки в ЕИС",
        value: fixture.eisNumber,
      }),
    );
  }
  const lots = (fixture.lots ?? []).map((lot) => fabrikantLotBlock(lot));
  const activeTab = fixture.activeTab ?? "Список лотов";
  const tabs = CARD_TABS.map(([title, counter]) => {
    const declared =
      title === "Список лотов" &&
      fixture.declaredLotCount !== null &&
      fixture.declaredLotCount !== undefined
        ? fixture.declaredLotCount
        : counter;
    const counterMarkup = declared === "" ? "" : `<span class="tab-counter">${declared}</span>`;
    return `<li class="${title === activeTab ? "active" : ""}">
<a href="/v2/trades/procedure/view/TESTID">
<span class="bottom-lined">${title}</span>${counterMarkup}</a></li>`;
  });
  return `<!DOCTYPE html><html><head><title>Карточка процедуры</title></head>
<body data-flexible="true">
<div class="breadcrumbs-new"><ol class="breadcrumb">
<li><a href="/">Главная страница</a></li><li><a href="/procedure/search/">Коммерческие процедуры</a></li>
</ol></div>
<ul class="nav nav-pills content-tabs col-md-9">
${tabs.join("\n")}
</ul>
<div class="col-md-9 col-content"><div class="row">
<div class="panel panel-default panel-striped">
<div class="panel-body js-protocol-form-panel-body">
${panels.join("\n")}
</div>
</div>
${lots.join("\n")}
</div></div>
</body></html>`;
}

/**
 * Коммерческая закупка без номера в ЕИС — основной положительный случай.
 *
 * Именно такие закупки и есть причина подключить площадку: в реестре ЕИС их нет,
 * и ни один другой источник их не приносит.
 */
export const FABRIKANT_COMMERCIAL_CARD = buildFabrikantCardPage({
  declaredLotCount: 1,
  eisNumber: null,
  procedurePanels: [
    { key: "type", label: "Тип процедуры", value: "Закупка" },
    { key: "purchase_category_custom", label: "Название процедуры на ЭТП", value: "Запрос предложений" },
    { key: "procedure_purchase_mode", label: "Режим проведения процедуры", value: "Открытая форма" },
    { key: "purchase_section", label: "Секция на торговой площадке", value: "Коммерческие процедуры" },
    {
      key: "procedure_common_name",
      label: "Общее наименование закупки",
      value: 'Строительно-монтажные работы по объекту "Склад сырьевой соли", часть КМ',
    },
    { key: "procedure_rnp", label: "Требование к отсутствию участника в РНП", value: "Да" },
    // Дата публикации в живой карточке идёт вперемешку с кнопками истории
    // изменений: «01.10.2026 16:32 Действия История изменений Закрыть
    // Продолжить». Значение панели поэтому сырое, а дату из него достаёт
    // `fabrikantDateTime` — взять первые 16 знаков значило бы положиться на то,
    // что кнопки всегда стоят после даты.
    {
      key: "date_publication",
      label: "Дата публикации",
      value: "02.10.2026 16:58 Действия История изменений Закрыть Продолжить",
    },
    { key: "proposal_date_start", label: "Дата и время начала приема заявок", value: "02.10.2026 16:58" },
    { key: "national_privilege_enabled", label: "Устанавливается преимущество", value: "Не установлено" },
  ],
  organizer: {
    name: 'АО "ПРИМЕР ОРГАНИЗАТОРА"',
    address: "423650, Россия, Республика Татарстан (Татарстан), Менделеевск, Пионерская, 2",
    inn: "1627000000",
    kpp: "162701001",
  },
  lots: [
    {
      number: 1,
      subject: 'Строительно-монтажные работы по объекту "Склад сырьевой соли", часть КМ',
      price: "1 500 000,00",
      vatIncluded: true,
      submissionEnd: "12.10.2026 17:00",
      deliveryRegion: "Республика Татарстан",
      deliveryDistrict: "Приволжский федеральный округ",
      deliveryAddress: "г. Менделеевск, ул. Пионерская, 2",
      okpd2: ["43.39.19.190"],
    },
  ],
});

/**
 * Закупка 223-ФЗ с номером извещения в ЕИС.
 *
 * Номер ЕИС важнее номера площадки: по нему запись совпадает с той, что приносит
 * адаптер реестра, и приоритет источника решает, чья версия останется в базе.
 */
export const FABRIKANT_FZ223_CARD = buildFabrikantCardPage({
  declaredLotCount: 1,
  eisNumber: "32616400001",
  procedurePanels: [
    { key: "type", label: "Тип процедуры", value: "Закупка" },
    {
      key: "purchase_category_custom",
      label: "Название процедуры на ЭТП",
      value:
        "Конкурс в электронной форме, участниками которого могут являться только субъекты малого и среднего предпринимательства",
    },
    { key: "purchase_section", label: "Секция на торговой площадке", value: "Закупки по 223-ФЗ" },
    {
      key: "procedure_common_name",
      label: "Общее наименование закупки",
      value: "Выполнение работ по текущему ремонту на объектах Заказчика",
    },
    { key: "date_publication", label: "Дата публикации", value: "02.10.2026 17:00" },
    { key: "national_privilege_enabled", label: "Устанавливается преимущество", value: "Установлено" },
  ],
  organizer: {
    name: 'СПБ ГБУ "ПРИМЕР ЗАКАЗЧИКА"',
    address: "190031, Россия, г. Санкт-Петербург, наб. Реки Фонтанки, д. 105, литера а",
    inn: "7838000000",
    kpp: "783801001",
  },
  lots: [
    {
      number: 1,
      subject: "Выполнение работ по текущему ремонту на объектах Заказчика",
      price: "119 994 640,40",
      vatIncluded: true,
      submissionEnd: "19.10.2026 09:00",
      deliveryRegion: "Санкт-Петербург",
      deliveryDistrict: "Северо-Западный федеральный округ",
      deliveryAddress: "В соответствии с закупочной документацией",
      okpd2: ["43.39.19.190"],
      bidSecurityAmount: "2 399 892,80",
      contractSecurityAmount: "5 999 732,02",
      contractSecurityPercent: "5",
      onlyForSmp: true,
    },
  ],
});

/**
 * Многолотовая процедура, у которой карточка отдала только первую страницу.
 *
 * Живой замер 02.10.2026: процедура с 18 лотами печатает по 5 лотов на страницу,
 * а вкладка «Список лотов» несёт счётчик 18. Сложить пять цен из восемнадцати
 * значит показать владельцу закупку втрое дешевле настоящей — та же ошибка, ради
 * которой у Росэлторга цена не публикуется при неполном наборе лотов.
 */
export const FABRIKANT_PARTIAL_LOTS_CARD = buildFabrikantCardPage({
  declaredLotCount: 18,
  eisNumber: null,
  procedurePanels: [
    { key: "purchase_category_custom", label: "Название процедуры на ЭТП", value: "Запрос предложений" },
    { key: "purchase_section", label: "Секция на торговой площадке", value: "Коммерческие процедуры" },
    { key: "date_publication", label: "Дата публикации", value: "01.10.2026 16:32" },
  ],
  organizer: {
    name: 'ООО "ПРИМЕР ПОСТАВЩИКА"',
    address: "443000, Россия, Самарская область, Самара, ул. Примерная, 1",
    inn: "6315000000",
  },
  lots: [1, 2, 3, 4, 5].map((number) => ({
    number,
    subject: `Поставка смазочных материалов, лот ${number}`,
    price: `${number} 000 000,00`,
    vatIncluded: false,
    submissionEnd: "15.10.2026 17:00",
    deliveryRegion: "Самарская область",
  })),
});

/** Закупка без опубликованной цены: площадка печатает «Без указания цены». */
export const FABRIKANT_NO_PRICE_CARD = buildFabrikantCardPage({
  declaredLotCount: 1,
  eisNumber: null,
  procedurePanels: [
    { key: "purchase_category_custom", label: "Название процедуры на ЭТП", value: "Запрос предложений" },
    { key: "purchase_section", label: "Секция на торговой площадке", value: "Коммерческие процедуры" },
    { key: "date_publication", label: "Дата публикации", value: "02.10.2026 10:00" },
  ],
  lots: [
    {
      number: 1,
      subject: "Оказание услуг по техническому обслуживанию",
      price: null,
      submissionEnd: "20.10.2026 12:00",
      deliveryRegion: null,
    },
  ],
});

/**
 * Карточка, у которой площадка не напечатала почти ничего.
 *
 * Живой замер: на трёх разных процедурах из 30 ожидаемых панелей нашлось 30, 29 и
 * 23. Обязательных полей у карточки нет, и парсер, который на отсутствующей
 * подписи упадёт, не доживёт до первой реальной процедуры.
 */
export const FABRIKANT_SPARSE_CARD = buildFabrikantCardPage({
  declaredLotCount: null,
  organizer: null,
  procedurePanels: [],
  lots: [],
});

/**
 * Та же коммерческая закупка, но класс `active` стоит на другой вкладке.
 *
 * Счётчиков на странице несколько: «0/0» у приёма заявок, «0» у запросов
 * разъяснений. Парсер обязан искать счётчик по названию вкладки «Список лотов»,
 * а не брать первый попавшийся и не ориентироваться на `active` — иначе число
 * лотов взялось бы из чужой вкладки, а вместе с ним и решение, публиковать цену.
 */
export const FABRIKANT_CARD_OTHER_TAB_ACTIVE = buildFabrikantCardPage({
  declaredLotCount: 1,
  activeTab: "Прием заявок",
  eisNumber: null,
  procedurePanels: [
    { key: "purchase_category_custom", label: "Название процедуры на ЭТП", value: "Запрос предложений" },
    { key: "purchase_section", label: "Секция на торговой площадке", value: "Коммерческие процедуры" },
    { key: "date_publication", label: "Дата публикации", value: "02.10.2026 16:58" },
  ],
  lots: [
    {
      number: 1,
      subject: "Поставка оборудования для склада",
      price: "2 400 000,00",
      vatIncluded: true,
      submissionEnd: "12.10.2026 17:00",
      deliveryRegion: "Республика Татарстан",
    },
  ],
});
