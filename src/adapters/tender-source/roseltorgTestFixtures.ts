/**
 * Фикстуры поисковой выдачи Росэлторга.
 *
 * Разметка снята с живого ответа `www.roseltorg.ru/procedures/search_ajax`
 * 02.10.2026 и воспроизводится здесь дословно: парсер читает её cheerio по
 * BEM-классам `.search-results__*`, и расхождение между фикстурой и площадкой
 * означало бы, что тесты проверяют нашу фантазию, а не чужой HTML.
 *
 * Персональных данных в выдаче списка нет — только организатор, его ИНН, регион
 * и цена. Контактные лица и адреса почты Росэлторг печатает в карточке процедуры,
 * куда адаптер не ходит.
 */

/** Момент, относительно которого живут все фикстуры: 02.10.2026 12:00 МСК. */
export const ROSELTORG_TEST_NOW = new Date("2026-10-02T09:00:00.000Z");

/**
 * Дословный фрагмент строки выдачи «Портала Поставщиков».
 *
 * Держим его отдельной константой, а не собираем билдером: билдер знает только те
 * классы, которые мы сами придумали, и молча пережил бы переименование на
 * площадке. Тест, который разбирает эту строку, ломается сразу.
 */
export const ROSELTORG_VERBATIM_ITEM = `
<div class="search-results__item autoload-post"
       data-feature-favorite-lots="lot"
       data-feature-favorite-lots-lot-number="11"
       data-feature-favorite-lots-procedure-number="SP10087155"
       data-feature-favorite-lots-favorite-lot-id=""
       data-feature-favorite-lots-favorite-lot-labels=''
  >
        <div class="search-results__info">
        <div class="search-results__subject">
                                <a href="/procedure/SP10087155/11"
               class="search-results__link search-results__link--description">Швабра с флаундером 40 см с <b class="g-highlighted">насадкой</b> МОП, черенок 85-140 см, <b class="g-highlighted">насадка</b> МОП (608414), YORK «Pepita», 81302</a>
                  </div>
        <div class="search-results__header">
          <div class="search-results__platform-url">
            <img src="/themes/etp/images/platform/sp.svg" alt="изображение площадки"/>
          </div>
          <div class="search-results__lot">
                                      <a href="/procedure/SP10087155/11"
                 class="search-results__link">SP10087155
                (Лот 11)</a>
                      </div>
          <div class="search-results__lot-dot"></div>
          <div class="search-results__section">
            <p class="search-results__tooltip" rel="tooltip"
               title="Торговая секция">Портал Поставщиков</p>
          </div>
        </div>
      <div class="search-results__region">
                                                                                                <p class="search-results__tooltip" rel="tooltip"
                     title="Регион заказчика">77. г. Москва</p>
                                                                              </div>
      <div class="search-results__customer">
        <div class="search-results__title search-results__title--small">Организатор</div>
                  <p class="search-results__tooltip" rel="tooltip" title="управа Нижегородского района города Москвы <span class='tooltip__inn'>ИНН 7722275279</span>">
            <a href="/companies/resolve/7722275279/0/772201001" class="link_primary_active link_size_sm">
              управа Нижегородского района города Москвы
            </a>
          </p>
                      </div>
      <div class="search-results__info-item--row-gap" data-feature-favorite-lots="favorite-lot-labels" style="display: none;"></div>
          </div>
        <div class="search-results__data ">
      <div class="search-results__statuses">
        <div class="search-results__status status__icon--acceptance">
          <div class="search-results__status-dot"></div>
          Прием заявок
                  </div>
                      </div>
                    <div class="search-results__data-col search-results__data-col--left">
                      <div class="search-results__sum-wrapper">
              <div class="search-results__sum">
                                  <p class="desktop">
                                          986<sub>,23</sub> &#8381;
                                      </p>
                  <p class="mobile">
                                          986<sub>,23</sub> &#8381;
                                      </p>
                  <p class="tablet">
                                          986<sub>,23</sub> &#8381;
                                      </p>
                  <span class="search-results__currency" rel="tooltip"
                        title="">
                                                      <span class="lot-item__nds">С учетом НДС</span>
                                                  </span>
                                              </div>
              <i
                class="price__icon "></i>
            </div>
                  </div>
            <p class="search-results__type">Аукцион</p>
      <div class="search-results__data-col search-results__data-col--right">
                                      <div class="search-results__timing">
              <p class="search-results__inline-title">Окончание приема заявок</p>
              <time class="search-results__time">01.12.2025 в 08:42
              </time>
            </div>
                              </div>
                </div>
    <div class="search-results__widgets">
      <div data-feature-favorite-lots="favorite-lot-widget"></div>
    </div>
  </div>`;

/** Что нужно, чтобы собрать одну строку выдачи. */
export interface RoseltorgItemFixture {
  readonly procedureNumber: string;
  readonly lotNumber: number;
  readonly subject: string;
  /** Название торговой секции, как его печатает строка выдачи. */
  readonly sectionTitle: string;
  /** Регион заказчика в формате площадки: «77. г. Москва». */
  readonly region: string;
  readonly organizerName: string;
  readonly organizerInn: string;
  /**
   * Цена цифрами в формате площадки («3 500 000,00»). null — блок цены в строке
   * отсутствует целиком: так Росэлторг печатает закупки без опубликованной НМЦ.
   */
  readonly price?: string | null;
  /** Признак НДС; null — строка без него. */
  readonly vat?: string | null;
  /** Способ размещения, как его печатает площадка. */
  readonly placingWayTitle: string;
  readonly statusTitle?: string;
  /** Срок окончания приёма заявок в формате площадки: «19.10.2026 в 07:00». */
  readonly deadline: string;
  /** Слово, которое площадка подсветила в предмете: проверяем снятие `<b>`. */
  readonly highlight?: string;
}

/** Одна строка выдачи в разметке площадки. */
export function roseltorgItem(fixture: RoseltorgItemFixture): string {
  const subject = highlightIn(fixture.subject, fixture.highlight);
  const priceBlock =
    fixture.price === undefined || fixture.price === null
      ? ""
      : `
                    <div class="search-results__data-col search-results__data-col--left">
                      <div class="search-results__sum-wrapper">
              <div class="search-results__sum">
                                  <p class="desktop">
                                          ${priceMarkup(fixture.price)} &#8381;
                                      </p>
                  <span class="search-results__currency" rel="tooltip"
                        title="">
                    ${fixture.vat === null || fixture.vat === undefined ? "" : `<span class="lot-item__nds">${fixture.vat}</span>`}
                                                  </span>
                                              </div>
              <i class="price__icon "></i>
            </div>
                  </div>`;
  const status = fixture.statusTitle ?? "Прием заявок";
  return `
<div class="search-results__item autoload-post"
       data-feature-favorite-lots="lot"
       data-feature-favorite-lots-lot-number="${fixture.lotNumber}"
       data-feature-favorite-lots-procedure-number="${fixture.procedureNumber}"
  >
        <div class="search-results__info">
        <div class="search-results__subject">
                                <a href="/procedure/${fixture.procedureNumber}/${fixture.lotNumber}"
               class="search-results__link search-results__link--description">${subject}</a>
                  </div>
        <div class="search-results__header">
          <div class="search-results__lot">
                                      <a href="/procedure/${fixture.procedureNumber}/${fixture.lotNumber}"
                 class="search-results__link">${fixture.procedureNumber}
                (Лот ${fixture.lotNumber})</a>
                      </div>
          <div class="search-results__section">
            <p class="search-results__tooltip" rel="tooltip"
               title="Торговая секция">${fixture.sectionTitle}</p>
          </div>
        </div>
      <div class="search-results__region">
                     <p class="search-results__tooltip" rel="tooltip"
                     title="Регион заказчика">${fixture.region}</p>
      </div>
      <div class="search-results__customer">
        <div class="search-results__title search-results__title--small">Организатор</div>
                  <p class="search-results__tooltip" rel="tooltip" title="${fixture.organizerName} <span class='tooltip__inn'>ИНН ${fixture.organizerInn}</span>">
            <a href="/companies/resolve/${fixture.organizerInn}/0/772201001" class="link_primary_active link_size_sm">
              ${fixture.organizerName}
            </a>
          </p>
                      </div>
          </div>
        <div class="search-results__data ">
      <div class="search-results__statuses">
        <div class="search-results__status status__icon--acceptance">
          <div class="search-results__status-dot"></div>
          ${status}
                  </div>
                      </div>${priceBlock}
            <p class="search-results__type">${fixture.placingWayTitle}</p>
      <div class="search-results__data-col search-results__data-col--right">
                                      <div class="search-results__timing">
              <p class="search-results__inline-title">Окончание приема заявок</p>
              <time class="search-results__time">${fixture.deadline}
              </time>
            </div>
                              </div>
                </div>
  </div>`;
}

/** Что умеет собирать билдер страницы. */
export interface RoseltorgPageFixture {
  /** Строки выдачи по порядку. */
  readonly items: readonly string[];
  /** Есть ли кнопка «дальше»: по ней адаптер решает, продолжать ли обход. */
  readonly hasNextPage?: boolean;
  /** Номер следующей страницы в `data-href` кнопки. */
  readonly nextPage?: number;
  /** Площадка напечатала «Нет результатов» вместо списка. */
  readonly noResults?: boolean;
}

/** Страница выдачи целиком — тот самый фрагмент, который возвращает `search_ajax`. */
export function buildRoseltorgSearchPage(fixture: RoseltorgPageFixture): string {
  if (fixture.noResults) {
    return `
<div class="search-autocomplete__no-result">
  <p class="search-autocomplete__no-result-text">Нет результатов, соответствующих всем условиям. Измените настройки поиска или измените поисковый запрос.</p>
</div>`;
  }
  const pagination = fixture.hasNextPage
    ? `
<div class="pagination">
  <a href="#" class="pagination__link" data-href="?page=${fixture.nextPage ?? 1}" title="Страница: ${fixture.nextPage ?? 1}">${fixture.nextPage ?? 1}</a>
  <span class="pagination__separator"></span>
  <a href="#" class="pagination__btn pagination__btn--next" data-href="?page=${fixture.nextPage ?? 1}">Далее</a>
</div>`
    : "";
  return `<div class="search-results">${fixture.items.join("\n")}</div>${pagination}`;
}

/**
 * Цена в разметке площадки: копейки вынесены в `<sub>`, разряды разделены
 * неразрывным пробелом. Парсер обязан собрать из этого число, а не строку.
 */
function priceMarkup(value: string): string {
  const [whole, fraction] = value.split(",");
  const grouped = (whole ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return fraction === undefined ? grouped : `${grouped}<sub>,${fraction}</sub>`;
}

/** Подсветка совпадения: площадка оборачивает найденное слово в `<b>`. */
function highlightIn(subject: string, highlight: string | undefined): string {
  if (!highlight) return subject;
  const index = subject.toLowerCase().indexOf(highlight.toLowerCase());
  if (index < 0) return subject;
  const found = subject.slice(index, index + highlight.length);
  return (
    subject.slice(0, index) +
    `<b class="g-highlighted">${found}</b>` +
    subject.slice(index + found.length)
  );
}

/**
 * Строка корпоративной секции с ценой и сроком в будущем — основной положительный
 * случай: такие закупки в ЕИС не публикуются и приходят только отсюда.
 */
export const ROSELTORG_COMMERCIAL_ITEM = roseltorgItem({
  procedureNumber: "B0210261118005",
  lotNumber: 1,
  subject: "Пропан",
  sectionTitle: "Росэлторг.Бизнес",
  region: "51. Мурманская область",
  organizerName: 'ФИЛИАЛ "35 СУДОРЕМОНТНЫЙ ЗАВОД"',
  organizerInn: "2902060361",
  price: null,
  placingWayTitle: "Процедура по закупке с выбором победителя",
  deadline: "08.10.2026 в 07:45",
});

/** Строка с опубликованной ценой: конкурс МСП крупного заказчика. */
export const ROSELTORG_PRICED_ITEM = roseltorgItem({
  procedureNumber: "32616431971",
  lotNumber: 1,
  subject:
    "Выполнение строительно-монтажных, пусконаладочных работ с поставкой материалов и оборудования",
  sectionTitle: "Корпоративные закупки и закупки субъектов 223-ФЗ (включая МСП)",
  region: "34. Волгоградская область",
  organizerName: 'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "РОССЕТИ ЮГ"',
  organizerInn: "6164266561",
  price: "1363671,13",
  vat: "С учетом НДС",
  placingWayTitle: "Конкурс МСП",
  deadline: "12.10.2026 в 11:00",
});

/**
 * Многолотовая процедура: три строки с одним номером.
 *
 * Именно так выглядит главная ловушка площадки — поиск по слову возвращает лоты,
 * а не закупки, и сумма совпавших лотов не равна цене закупки.
 */
export const ROSELTORG_MULTI_LOT_ITEMS: readonly string[] = [1, 2, 3].map((lot) =>
  roseltorgItem({
    procedureNumber: "B2509261618185",
    lotNumber: lot,
    subject: lot === 2 ? "Насадка МОП, комплект" : `Позиция каталога №${lot}`,
    sectionTitle: "Росэлторг.Бизнес",
    region: "77. г. Москва",
    organizerName: 'АКЦИОНЕРНОЕ ОБЩЕСТВО "ТОРГОВАЯ ПЛОЩАДКА"',
    organizerInn: "7736035485",
    price: lot === 1 ? "280000,00" : "250,00",
    vat: "С учетом НДС",
    placingWayTitle: "Закупка с полки (закупка в электронном магазине)",
    deadline: "20.10.2026 в 10:00",
    highlight: lot === 2 ? "Насадка" : undefined,
  }),
);

/**
 * Строка «Портала Поставщиков» со сроком, который давно прошёл, и статусом
 * «Прием заявок»: вечный лот перезапуска. Адаптер обязан её отбросить.
 */
export const ROSELTORG_STALE_ITEM = roseltorgItem({
  procedureNumber: "SP10044694",
  lotNumber: 3,
  subject: "Поставка хозяйственных товаров",
  sectionTitle: "Портал Поставщиков",
  region: "77. г. Москва",
  organizerName: "ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ УЧРЕЖДЕНИЕ ГОРОДА МОСКВЫ",
  organizerInn: "7722275279",
  price: "1500,00",
  vat: "С учетом НДС",
  placingWayTitle: "Аукцион",
  deadline: "17.09.2025 в 08:00",
});

/** Регион не указан: «99. Не указан» — заявление площадки, а не сбой разбора. */
export const ROSELTORG_UNKNOWN_REGION_ITEM = roseltorgItem({
  procedureNumber: "ATOM02102600184",
  lotNumber: 1,
  subject: "Мониторинг цен в электронной форме на патрон токарный",
  sectionTitle: "ГК «Росатом»",
  region: "99. Не указан",
  organizerName: 'Акционерное общество "Производственное объединение"',
  organizerInn: "3329051460",
  price: "0,00",
  placingWayTitle: "Мониторинг цен",
  deadline: "13.10.2026 в 23:59",
});

/** Номер извещения ЕИС: 11 знаков с ведущей тройкой — это 223-ФЗ. */
export const ROSELTORG_FZ223_ITEM = roseltorgItem({
  procedureNumber: "32616431984",
  lotNumber: 1,
  subject: "Поставка канцелярской продукции",
  sectionTitle: "Корпоративные закупки и закупки субъектов 223-ФЗ (включая МСП)",
  region: "78. г. Санкт-Петербург",
  organizerName: "ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ УЧРЕЖДЕНИЕ КУЛЬТУРЫ",
  organizerInn: "7830002409",
  price: "9927,20",
  vat: "Без учета НДС",
  placingWayTitle: "Запрос котировок МСП",
  deadline: "08.10.2026 в 10:00",
});

/** Девятнадцатизначный номер — извещение 44-ФЗ, оно уже приходит из ЕИС. */
export const ROSELTORG_FZ44_ITEM = roseltorgItem({
  procedureNumber: "0373200045226001469",
  lotNumber: 1,
  subject: "Поставка спектрофотометра микропланшетного",
  sectionTitle: "Государственные закупки (44-ФЗ)",
  region: "77. г. Москва",
  organizerName: "ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ УЧРЕЖДЕНИЕ",
  organizerInn: "7714061756",
  price: "3500000,00",
  vat: "С учетом НДС",
  placingWayTitle: "Аукцион",
  deadline: "19.10.2026 в 07:00",
});
