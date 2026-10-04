/**
 * Поиск Росэлторга: адрес запроса, словари площадки и разбор фрагмента выдачи.
 *
 * Площадка держит публичный серверный поиск на `www.roseltorg.ru/procedures/search`;
 * форма отправляется на `/procedures/search_ajax?page=N` и возвращает **фрагмент**
 * списка — 59 КБ вместо 426 КБ полной страницы, за 0,09 с. Ключа и токена не
 * просит. `robots.txt` хоста содержит `Allow: /procedures/search?page=` и
 * `Allow: /search/*?page=`; ни `search_ajax`, ни карточка `/procedure/{номер}/{лот}`
 * им не запрещены (проверено 02.10.2026, см. `docs/REFERENCE_PLATFORM_PROBES.md`,
 * раздел «Третья волна»).
 *
 * Три особенности площадки, из-за которых модуль устроен именно так:
 *
 * 1. **Строка выдачи — это лот, а не закупка.** Поиск по ключевому слову возвращает
 *    совпавшие лоты: слово «насадка» находит лоты 196 и 197 процедуры, в которой их
 *    больше сотни. Складывать цены найденного подмножества нельзя — закупка за
 *    миллионы выглядела бы закупкой за 220 ₽. Поэтому парсер отдаёт строки как есть,
 *    а полный набор лотов адаптер добирает отдельным запросом по номеру процедуры.
 *
 * 2. **Фильтр секций обязателен.** Без `source[]` выдача на 10 из 10 состоит из
 *    «Портала Поставщиков» — секция 25 забивает список московскими микрозакупками.
 *
 * 3. **Даты фильтрами не задаются.** `start_date_published` и `end_date_published`
 *    по GET площадкой игнорируются: ответ байт в байт совпадает с выдачей без них.
 *    Отсеивать закрытое приходится по сроку приёма заявок в самой строке.
 *
 * 4. **Размер страницы не настраивается.** Площадка отдаёт 10 строк и на `page=0`,
 *    и на `page=200`; на `page=5000` — ноль строк, «Нет результатов» и никакой
 *    кнопки «Далее». Конец обхода поэтому определяется только этими двумя
 *    признаками, а не длиной страницы: короткие страницы с живой кнопкой в живой
 *    выдаче не встречались, но считать их концом значило бы решить за площадку.
 */
import * as cheerio from "cheerio";

/** Публичный хост площадки: поиск и карточки живут здесь, файлы — на `com.`. */
export const ROSELTORG_BASE_URL = "https://www.roseltorg.ru";

/** Путь фрагмента выдачи — тот, на который отправляется форма поиска. */
const SEARCH_PATH = "/procedures/search_ajax";

/**
 * Торговые секции площадки: значение фильтра `source[]` → название из формы.
 *
 * Словарь снят с разметки формы поиска целиком, а не с выдачи: в строках списка
 * площадка печатает названия иначе («Корпоративные закупки и закупки субъектов
 * 223-ФЗ» против «Закупки по 223-ФЗ» в фильтре), поэтому сверять закон с названием
 * секции нельзя — закон выводится из формы номера.
 */
export const ROSELTORG_SECTIONS: Readonly<Record<number, string>> = {
  1: "Государственные закупки (44-ФЗ)",
  2: "Коммерческие закупки и закупки по 223-ФЗ",
  3: "ГК «Росатом»",
  6: "ПАО «Ростелеком» и подведомственные организации",
  8: "Группа ВТБ",
  12: "Холдинг «Росгео»",
  13: "Отраслевая секция региональных операторов ФКР МКД (ППРФ №615)",
  14: "Группа «РусГидро»",
  18: "ПАО «Россети»",
  20: "Корпоративный интернет-магазин",
  21: "Корпоративный интернет-магазин ПАО «Интер РАО»",
  24: "Росэлторг.Бизнес",
  25: "Портал Поставщиков",
  28: "Корпоративные закупки и закупки по 223-ФЗ (включая МСП)",
  29: "ПАО «Интер РАО»",
};

/**
 * Секции, которые адаптер опрашивает по умолчанию.
 *
 * Вне набора, каждая по своей причине:
 *  - 1 и 13 — 44-ФЗ и ППРФ №615: зеркало ЕИС, наш адаптер реестра их уже видит,
 *    а две строки об одной закупке в базе не нужны;
 *  - 20 и 21 — корпоративные интернет-магазины: это не конкурентные процедуры,
 *    победителя в них не выбирают;
 *  - 25 — Портал Поставщиков: московские микрозакупки, у которых статус «Прием
 *    заявок» сочетается со сроком десять месяцев назад (вечные лоты перезапуска).
 *    Проверено 02.10.2026 на `SP10087155` (01.12.2025), `SP10044694` (17.09.2025)
 *    и `SP10208401` (25.05.2026).
 */
export const ROSELTORG_DEFAULT_SECTIONS: readonly number[] = [
  2, 28, 24, 3, 6, 8, 12, 14, 18, 29,
];

/**
 * Статусы, при которых заявку ещё можно подать: 5 — ожидание приёма, 0 — приём.
 *
 * Полный словарь площадки: 1 работа комиссии, 2 процедура отменена,
 * 3 приостановлена, 4 завершена.
 */
export const ROSELTORG_OPEN_STATUSES: readonly number[] = [5, 0];

/** Что фильтр умеет принять. */
export interface RoseltorgSearchParams {
  /** Номер страницы, с нуля. */
  readonly page?: number;
  /** Торговые секции (`source[]`). Пусто — весь сайт, включая Портал Поставщиков. */
  readonly sections?: readonly number[];
  /** Статусы (`status[]`). Пусто — все, включая завершённые и отменённые. */
  readonly statuses?: readonly number[];
  /** `query_field`: ключевое слово или номер процедуры. */
  readonly query?: string;
}

/**
 * Адрес запроса фрагмента выдачи.
 *
 * Параметры собирает `URLSearchParams`, поэтому кириллица кодируется всегда
 * одинаково и не зависит от локали машины: зонд 02.10.2026 получил «Нет
 * результатов» ровно потому, что слово, переданное через `curl --data-urlencode`,
 * доехало до площадки искажённым.
 */
export function roseltorgSearchUrl(
  params: RoseltorgSearchParams = {},
  baseUrl: string = ROSELTORG_BASE_URL,
): string {
  const search = new URLSearchParams();
  search.set("page", String(params.page ?? 0));
  for (const section of params.sections ?? []) {
    search.append("source[]", String(section));
  }
  for (const status of params.statuses ?? []) {
    search.append("status[]", String(status));
  }
  const query = params.query?.trim() ?? "";
  if (query !== "") search.set("query_field", query);
  return `${baseUrl}${SEARCH_PATH}?${search.toString()}`;
}

/** Одна строка выдачи — один лот. */
export interface RoseltorgLotRow {
  /** Номер процедуры. Пустая строка — разметка изменилась, адаптер её считает отдельно. */
  readonly procedureNumber: string;
  /** Номер лота; null, если площадка его не напечатала. */
  readonly lotNumber: number | null;
  /** Предмет лота, без подсветки совпадения. */
  readonly subject: string;
  /** Название торговой секции, как его печатает строка. */
  readonly sectionTitle: string;
  /** Регион заказчика в формате площадки: «77. г. Москва», «99. Не указан». */
  readonly region: string;
  readonly organizerName: string;
  readonly organizerInn: string | null;
  /**
   * Цена лота. null — цена не опубликована: у «Росэлторг.Бизнес» блока суммы в
   * строке нет вовсе, а мониторинг цен печатает «0,00 ₽», и это разные факты.
   */
  readonly price: number | null;
  readonly currency: string;
  /** С учётом НДС или без; null — площадка признак не напечатала. */
  readonly vatIncluded: boolean | null;
  /** Способ размещения строкой площадки. */
  readonly placingWayTitle: string;
  /** Статус без счётчика дней: «Прием заявок», «Работа комиссии». */
  readonly statusTitle: string;
  /** Срок окончания приёма заявок в ISO с московским смещением; "" — не напечатан. */
  readonly submissionEnd: string;
  /** Абсолютный адрес карточки лота. */
  readonly url: string;
}

/** Страница фрагмента выдачи. */
export interface RoseltorgSearchPage {
  readonly rows: readonly RoseltorgLotRow[];
  /** Площадка напечатала «Далее»: страницы ещё есть. */
  readonly hasNextPage: boolean;
  /** Площадка напечатала «Нет результатов» — это не пустая страница, а ответ. */
  readonly noResults: boolean;
}

/**
 * Разбирает фрагмент выдачи.
 *
 * Пустой ответ и «Нет результатов» различаются: первое значит сбой транспорта или
 * конец обхода, второе — что по фильтру ничего не найдено. Подменять одно другим
 * значит заставить журнал прогона врать о причине.
 */
export function parseRoseltorgSearch(html: string): RoseltorgSearchPage {
  const $ = cheerio.load(html);
  const rows: RoseltorgLotRow[] = [];

  $(".search-results__item").each((_index, element) => {
    const item = $(element);
    const subjectLink = item.find(".search-results__subject a").first();
    const lotText = cleanText(item.find(".search-results__lot a").first().text());
    const fromAttribute = cleanText(
      item.attr("data-feature-favorite-lots-procedure-number") ?? "",
    );
    const sumText = item.find(".search-results__sum").first().text();
    const vatText = cleanText(item.find(".lot-item__nds").first().text());
    const statusText = cleanText(item.find(".search-results__status").first().text());
    const customerHref = item.find(".search-results__customer a").first().attr("href") ?? "";
    const customerTitle = item.find(".search-results__customer p").first().attr("title") ?? "";

    // Срок приёма заявок: блоков времени в строке может быть несколько — площадка
    // печатает и дату аукциона. Берём тот, у которого подпись про окончание приёма,
    // и только за неимением такого — первый попавшийся. Разбор оставлен здесь, а не
    // вынесен в функцию-помощник: cheerio не экспортирует тип своего узла, а
    // выдуманная подпись помощника перестала бы проверяться компилятором.
    let submissionDeadline = "";
    let firstTiming = "";
    item.find(".search-results__timing").each((_timingIndex, timingElement) => {
      const block = $(timingElement);
      const time = block.find(".search-results__time").first().text();
      if (firstTiming === "") firstTiming = time;
      const title = cleanText(block.find(".search-results__inline-title").first().text());
      if (
        submissionDeadline === "" &&
        time.trim() !== "" &&
        title.toLowerCase().includes("окончание приема")
      ) {
        submissionDeadline = time;
      }
    });
    if (submissionDeadline === "") {
      submissionDeadline =
        firstTiming !== "" ? firstTiming : item.find(".search-results__time").first().text();
    }

    rows.push({
      procedureNumber: fromAttribute || (lotText.split(/\s+/)[0] ?? ""),
      lotNumber: lotNumberOf(item.attr("data-feature-favorite-lots-lot-number")),
      subject: cleanText(subjectLink.text()),
      sectionTitle: cleanText(item.find(".search-results__section p").first().text()),
      region: cleanText(item.find(".search-results__region p").first().text()),
      organizerName: cleanText(item.find(".search-results__customer a").first().text()),
      organizerInn: innFromCustomer(customerHref, customerTitle),
      price: parseRoseltorgAmount(item.find(".search-results__sum p.desktop").first().text()),
      currency: roseltorgCurrency(sumText),
      vatIncluded: vatFlag(vatText),
      placingWayTitle: cleanText(item.find(".search-results__type").first().text()),
      statusTitle: statusTitle(statusText),
      submissionEnd: parseRoseltorgDeadline(submissionDeadline),
      url: absoluteUrl(subjectLink.attr("href")),
    });
  });

  const noResults = $(".search-autocomplete__no-result-text").length > 0;
  return {
    rows,
    hasNextPage: !noResults && $(".pagination__btn--next").length > 0,
    noResults,
  };
}

/**
 * Цена из разметки площадки.
 *
 * Площадка печатает её частями: разряды разделены неразрывным пробелом, копейки
 * вынесены в `<sub>`, знак валюты стоит рядом HTML-сущностью. «-» и пустой блок
 * означают «цена не опубликована» и дают null, а не нуль: нуль в домене значит
 * то же самое, но отличить «площадка напечатала 0,00 ₽» от «площадка ничего не
 * напечатала» полезно при разборе.
 */
export function parseRoseltorgAmount(value: string): number | null {
  const withoutEntities = value.replace(/&#x?[0-9a-f]+;|&[a-z]+;/gi, " ");
  const cleaned = withoutEntities
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\d,.\-]/g, "")
    .replace(/,/g, ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Срок приёма заявок в формате площадки («01.12.2025 в 08:42») → ISO в Москве.
 *
 * Смещение +03:00 ставится явно, а не выводится из локальной зоны: прогон живёт на
 * сервере в России, а тесты — где угодно, и срок не должен разъезжаться на час.
 * Нечитаемая дата даёт пустую строку, а не «сегодня»: выдуманная дата прошла бы
 * проверку на просроченный срок и попала бы в выдачу.
 */
export function parseRoseltorgDeadline(value: string): string {
  const text = cleanText(value.replace(/<[^>]*>/g, " "));
  const match = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+в\s+(\d{1,2}):(\d{2}))?/.exec(text);
  if (!match) return "";
  const [, day, month, year, hours, minutes] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const probe = new Date(Date.UTC(Number(year), monthNumber - 1, dayNumber));
  // «99.99.9999» Date любезно превратит в следующий год; такая дата — не дата.
  if (probe.getUTCMonth() !== monthNumber - 1 || probe.getUTCDate() !== dayNumber) return "";
  const hh = (hours ?? "00").padStart(2, "0");
  const mm = minutes ?? "00";
  if (Number(hh) > 23 || Number(mm) > 59) return "";
  return `${year}-${month}-${day}T${hh}:${mm}:00+03:00`;
}

/** Валюта строки. Незнакомый знак трактуем как рубль — см. комментарий в теле. */
export function roseltorgCurrency(sumText: string): string {
  if (sumText.includes("$")) return "USD";
  if (sumText.includes("€")) return "EUR";
  // В живой выдаче из 60 строк все цены были в рублях (знак приходит сущностью
  // `&#8381;`). Незнакомый символ принимаем за рубль: лимиты профиля заданы в
  // рублях, а угадывать валюту, которой мы ни разу не видели, всё равно нечем.
  return "RUB";
}

/** Текст с одним пробелом вместо любых переводов строк и неразрывных пробелов. */
function cleanText(value: string): string {
  return value.replace(/[\s\u00a0]+/g, " ").trim();
}

/** Номер лота из атрибута строки. */
function lotNumberOf(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Признак НДС: «С учетом НДС» / «Без учета НДС» / не напечатан. */
function vatFlag(text: string): boolean | null {
  const value = text.toLowerCase();
  if (value.includes("без")) return false;
  if (value.includes("учет")) return true;
  return null;
}

/**
 * Статус без счётчика.
 *
 * Площадка печатает остаток срока прямо в статусе: «Прием заявок 5 д», «Прием
 * заявок 16». Счётчик — не часть названия, и оставить его значило бы получить
 * бесконечное множество статусов вместо шести.
 */
function statusTitle(text: string): string {
  return text.replace(/\s*\d+(?:\s*(?:д|дн\.|ч|мин))?$/u, "").trim();
}

/**
 * ИНН организатора.
 *
 * Сначала из адреса карточки `/companies/resolve/{ИНН}/0/{ОКАТО}` — он машинный и
 * не зависит от вёрстки тултипа. Тултип запасной: в живой разметке он приходит
 * HTML-сущностями и вложенным `<span class='tooltip__inn'>`.
 */
function innFromCustomer(href: string, title: string): string | null {
  const fromHref = /\/companies\/resolve\/(\d{10,12})\//.exec(href);
  if (fromHref?.[1]) return fromHref[1];
  const fromTitle = /ИНН\s*(\d{10,12})/.exec(cleanText(title));
  return fromTitle?.[1] ?? null;
}

/** Абсолютный адрес карточки лота; пустой href остаётся пустым. */
function absoluteUrl(href: string | undefined): string {
  const value = (href ?? "").trim();
  if (value === "") return "";
  if (value.startsWith("http")) return value;
  return `${ROSELTORG_BASE_URL}${value.startsWith("/") ? "" : "/"}${value}`;
}
