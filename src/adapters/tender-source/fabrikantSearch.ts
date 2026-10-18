/**
 * Поиск Фабриканта: адрес запроса, словари площадки и разбор страницы выдачи.
 *
 * Площадка держит публичный серверный поиск на
 * `www.fabrikant.ru/procedure/search/purchases`. Ключа, токена и cookies не
 * просит; за живой замер 02.10.2026 ни один ответ не превысил 1,05 с.
 * `robots.txt` хоста состоит из 164 строк `Disallow` и ни одной `Allow`, но
 * каждое правило про торги требует параметра `?actions=`, а каждое правило про
 * карточку — `?action=`; ни наш путь поиска, ни путь карточки `/v2/trades/
 * procedure/view/{id}` под них не подпадают (проверено 02.10.2026, см.
 * `docs/REFERENCE_PLATFORM_PROBES.md`).
 *
 * Особенности площадки, из-за которых модуль устроен именно так:
 *
 * 1. **Выдача — это Next.js App Router.** В разметке данных нет вовсе: они лежат
 *    в RSC-payload внутри `self.__next_f.push([1,"…"])`, где аргумент — строковый
 *    литерал JSON, а таких кусков на страницу пять. Кавычка внутри названия
 *    закупки приходит как `\\\"`, структурная — как `\"`, поэтому одного прохода
 *    замены недостаточно: зонд 02.10.2026 потерял на этом 3 карточки из 40.
 *    Разбор идёт через `JSON.parse` аргумента целиком и только потом — поиском
 *    сбалансированных скобок.
 *
 * 2. **Строка выдачи — это лот, а не закупка.** Первая страница секции 2 дала 40
 *    строк на 23 процедуры, причём у одной процедуры 18 лотов. Адрес карточки при
 *    этом общий на процедуру: все 18 строк несут один и тот же `/v2/.../view/{id}`.
 *    Адаптер поэтому группирует строки по номеру процедуры и делает один запрос
 *    карточки на процедуру, а не на строку.
 *
 * 3. **Рядом с каждой карточкой площадка печатает объект-приманку**
 *    `{"url":null,"oosNumber":null,"lotId":…}` — в живой выдаче 80 вхождений
 *    `{"url":` на 40 закупок. От карточки его отличает только отсутствие
 *    `procedureNumber`, и разбор обязан требовать оба поля.
 *
 * 4. **Конец обхода определяет только объект пагинации.** Он на страницу один и
 *    несёт `total` и `pages`, где `pages = ceil(total / page_limit)` (проверено
 *    на 179→5, 92→3 и 332→9 при `page_limit=40`). Поле `defaultLimit` всегда
 *    равно 10 и на действительный размер страницы не влияет. На пустой выдаче
 *    объекта нет вовсе. Останавливать обход по длине страницы здесь нельзя:
 *    страница из 40 лотов может относиться к трём процедурам.
 *
 * 5. **В строке выдачи нет ни даты, ни цены.** `date_publication` и `price`
 *    встречаются на страницу по разу — это виджеты фильтра, а не данные карточки.
 *    Выдача пригодна только для обнаружения процедур; всё остальное берётся из
 *    карточки.
 *
 * 6. **Фильтр `customer_region_ids[]` намеренно не используется.** Он отсеивает
 *    по региону заказчика, а не по региону поставки: закупка московского
 *    заказчика с поставкой в Самару исчезла бы молча, а `ux-legal` требует,
 *    чтобы отфильтрованная закупка показывала причину. Регион берётся из
 *    карточки, а фильтр по региону применяет адаптер.
 *
 * 7. **Секция 14 («Капитальный ремонт») на `/purchases` молча игнорируется** —
 *    вместе с идентификаторами 1, 4, 7, 9, 10, 11, 13, 32, 33 и 34 площадка
 *    возвращает выдачу всего сайта. В набор по умолчанию такие не входят.
 *
 * 8. **Личных полей парсер не касается.** В строке выдачи их нет, но правило
 *    записано здесь, потому что карточка печатает «Контактное лицо» и «Телефон»:
 *    ни одно из этих полей не разбирается и не попадает ни в базу, ни в журнал.
 */

/** Публичный хост площадки: поиск и карточки `/v2` живут здесь, файлы — на `storage.`. */
export const FABRIKANT_BASE_URL = "https://www.fabrikant.ru";

/** Путь страницы выдачи. */
const SEARCH_PATH = "/procedure/search/purchases";

/**
 * Размер страницы. Площадка принимает 10, 20 и 40; 40 — наибольший из
 * проверенных, и он же делит `total` на `pages` в объекте пагинации.
 */
export const FABRIKANT_PAGE_LIMIT = 40;

/**
 * Секции площадки: значение фильтра `section_ids[]` → название из формы.
 *
 * Словарь снят с живого замера по всем идентификаторам от 1 до 34, а не с
 * разметки: у пустых и неизвестных секций площадка возвращает выдачу всего
 * сайта, и отличить «в секции ничего нет» от «идентифатор проигнорирован»
 * можно только запросом. Числа в скобках — сколько закупок в секции во всех
 * статусах на 02.10.2026.
 */
export const FABRIKANT_SECTIONS: Readonly<Record<number, string>> = {
  2: "Коммерческие закупки (339 194)",
  3: "ГК «Росатом» (224 399)",
  5: "Закупки по 223-ФЗ (337 924)",
  8: "Коммерческие продажи",
  12: "Закупки по 44-ФЗ (502 297)",
  14: "Капитальный ремонт",
  16: "Маркет (5 845)",
  17: "ГК «Новапорт» (9 006)",
  21: "ФГП ВО ЖДТ России (3 149)",
  24: "АО «Силовые машины» (26 514)",
  25: "ПАО «Форвард Энерго» (5 635)",
  26: "Корпорация «Технониколь» (10 308)",
  27: "EN+ (2 957)",
  28: "ПАО «Татнефть» (72)",
  30: "АО «Гознак» (20 680)",
  31: "ГК «Роскосмос» (3 475)",
};

/**
 * Секции, которые адаптер опрашивает по умолчанию. Порядок — по убыванию
 * открытых закупок на 02.10.2026: чем раньше секция, тем больше шансов, что
 * бюджет обхода достанется именно ей.
 *
 * Вне набора, каждая по своей причине:
 *  - 12 — закупки по 44-ФЗ: чистое зеркало ЕИС, 40 из 40 открытых несут номер
 *    извещения. Наш адаптер реестра их уже видит, а две строки об одной закупке
 *    в базе не нужны;
 *  - 16 — Маркет: карточки живут на `market.fabrikant.ru`, страницы `/v2` у них
 *    нет вовсе, разбирать нечего;
 *  - 14 — капитальный ремонт: идентификатор на `/purchases` молча игнорируется,
 *    и вместо секции адаптер получил бы весь сайт;
 *  - 8 — коммерческие продажи, а не закупки: на `/purchases` секция пуста;
 *  - 21, 26, 27, 28 — открытых закупок на момент замера ноль.
 */
export const FABRIKANT_DEFAULT_SECTIONS: readonly number[] = [
  2, 5, 3, 24, 17, 31, 25, 30,
];

/**
 * Статусы, при которых заявку ещё можно подать: 1 — приём заявок, 5 — ожидание
 * приёма.
 *
 * Полный словарь площадки: 2 работа комиссии, 4 завершённые, 6 отменённые.
 * Статус 5 добавляет к выдаче единицы, но без него закупка, опубликованная
 * сегодня с приёмом завтра, пропала бы из обхода на сутки.
 */
export const FABRIKANT_OPEN_STATUSES: readonly number[] = [1, 5];

/** Что фильтр умеет принять. */
export interface FabrikantSearchParams {
  /** Номер страницы, с единицы. */
  readonly page?: number;
  /** Размер страницы; по умолчанию `FABRIKANT_PAGE_LIMIT`. */
  readonly limit?: number;
  /** Секции (`section_ids[]`). Пусто — фильтр не отправляется вовсе. */
  readonly sections?: readonly number[];
  /** Статусы (`statuses[]`). Пусто — все, включая завершённые и отменённые. */
  readonly statuses?: readonly number[];
  /** Ключевое слово (`query`). */
  readonly query?: string;
  /** Нижняя граница цены (`price_from`); null и undefined — не отправлять. */
  readonly priceFrom?: number | null;
  /** Верхняя граница цены (`price_to`); null и undefined — не отправлять. */
  readonly priceTo?: number | null;
  /**
   * Регионы заказчика (`customer_region_ids[]`) — коды из справочника площадки
   * (`parseFabrikantRegions`). Пусто — фильтр не отправляется.
   */
  readonly customerRegionIds?: readonly string[];
}

/**
 * Адрес страницы выдачи.
 *
 * Наборы по умолчанию сюда не подставляются: пустой `sections` значит «фильтр не
 * отправлен», а не «отправлен весь словарь». Подставлять значения по умолчанию
 * должен адаптер — иначе адрес нельзя было бы проверить на точность, и опечатка
 * в порядке параметров осталась бы незамеченной.
 *
 * Параметры собирает `URLSearchParams`, поэтому кириллица кодируется всегда
 * одинаково и не зависит от локали машины.
 */
export function fabrikantSearchUrl(
  params: FabrikantSearchParams = {},
  baseUrl: string = FABRIKANT_BASE_URL,
): string {
  const search = new URLSearchParams();
  search.set("page_number", String(params.page ?? 1));
  search.set("page_limit", String(params.limit ?? FABRIKANT_PAGE_LIMIT));
  for (const section of params.sections ?? []) {
    search.append("section_ids[]", String(section));
  }
  for (const status of params.statuses ?? []) {
    search.append("statuses[]", String(status));
  }
  const query = params.query?.trim() ?? "";
  if (query !== "") search.set("query", query);
  if (params.priceFrom !== null && params.priceFrom !== undefined) {
    search.set("price_from", String(params.priceFrom));
  }
  if (params.priceTo !== null && params.priceTo !== undefined) {
    search.set("price_to", String(params.priceTo));
  }
  for (const id of params.customerRegionIds ?? []) {
    search.append("customer_region_ids[]", id);
  }
  search.set("sort_order", "date_publication");
  search.set("sort_direction", "desc");
  return `${baseUrl}${SEARCH_PATH}?${search.toString()}`;
}

/** Одна строка выдачи — один лот. */
export interface FabrikantLotRow {
  /** Номер процедуры строкой: площадка печатает его числом, а в базе он текст. */
  readonly procedureNumber: string;
  /** Внутренний номер лота на площадке. */
  readonly lotId: string;
  /** Порядковый номер лота внутри процедуры; 0 — площадка его не напечатала. */
  readonly sequenceNumber: number;
  /** Предмет лота, с восстановленными вложенными кавычками. */
  readonly subject: string;
  /**
   * Секция площадки машинным словом: `commercial`, `223fz`, `44fz`, `rosatom`.
   * Пустая строка — RSC прислал `"$undefined"` (так бывает у «Маркета»), и закон
   * по такой строке не выводится.
   */
  readonly sectionEnum: string;
  /** Номер извещения в ЕИС; null — закупка живёт только на площадке. */
  readonly eisNumber: string | null;
  /** Адрес карточки. Пустая строка — площадка его не напечатала. */
  readonly cardUrl: string;
}

/** Страница выдачи. */
export interface FabrikantSearchPage {
  readonly rows: readonly FabrikantLotRow[];
  /** Площадка напечатала «По вашему запросу ничего не найдено». */
  readonly noResults: boolean;
  /**
   * Площадка напечатала «Доступ к просмотру процедуры ограничен».
   *
   * Третий исход, отличный и от выдачи, и от честной пустоты: закупки по запросу
   * нашлись, но анонимному посетителю площадка их не показывает и просит войти
   * на ЭТП. Строк, пагинации и отметки «ничего не найдено» на такой странице нет
   * (живой замер 02.10.2026, запрос «МФУ»: HTTP 200, 198 747 байт, три куска
   * flight и ни одного `lotId`).
   */
  readonly restricted: boolean;
  /** Объявленное число записей; null — объекта пагинации на странице нет. */
  readonly total: number | null;
  /** Объявленное число страниц; null — объекта пагинации нет. */
  readonly pages: number | null;
}

/** Признак пустой выдачи. Дословно тот, что печатает площадка. */
const NO_RESULTS_MARKER = "По вашему запросу ничего не найдено";

/**
 * Признак закрытой от анонимного посетителя выдачи. Тоже дословный.
 *
 * Фразу площадка режет на несколько текстовых узлов RSC: рядом с признаком в
 * живом ответе лежат «Для ознакомления с извещением», «авторизуйтесь» и «на ЭТП.».
 * Поэтому признаком служит ровно тот кусок, который площадка печатает целиком, —
 * склеенного предложения в flight-тексте нет и искать его нельзя.
 */
const RESTRICTED_MARKER = "Доступ к просмотру процедуры ограничен";

/**
 * Собирает flight-текст из всех кусков `self.__next_f.push([1,"…"])`.
 *
 * Аргумент каждого куска — строковый литерал JSON, и разбирается он настоящим
 * `JSON.parse`, а не заменой `\\"` → `"`: внутри названия закупки встречаются
 * собственные кавычки, и после одного прохода замены они становятся
 * структурными. Кусок, который разобрать не удалось, пропускается, а не роняет
 * весь разбор — потерять одну карточку лучше, чем весь прогон.
 */
export function fabrikantFlightText(html: string): string {
  // Регулярка создаётся на вызов, а не живёт в модуле: у флага `g` состояние
  // `lastIndex` общее, и забытый после сброса индекс молча съел бы куски.
  const pushStart = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*"/g;
  const chunks: string[] = [];
  for (let match = pushStart.exec(html); match !== null; match = pushStart.exec(html)) {
    let index = match.index + match[0].length;
    const bodyStart = index;
    while (index < html.length) {
      const char = html[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') break;
      index += 1;
    }
    const body = html.slice(bodyStart, index);
    pushStart.lastIndex = index + 1;
    const decoded = parseJsonString(body);
    if (decoded !== null) chunks.push(decoded);
  }
  return chunks.join("");
}

/**
 * Разбирает страницу выдачи.
 *
 * Пустой ответ, «ничего не найдено» и «доступ ограничен» различаются: первое
 * значит сбой транспорта или страницу антибота, второе — что по фильтру
 * действительно ничего нет, третье — что закупки есть, но площадка не показывает
 * их без входа. Подмена одного другим заставила бы журнал прогона врать о
 * причине: «нет таких закупок» и «нам их не показали» — разные факты.
 */
export function parseFabrikantSearch(html: string): FabrikantSearchPage {
  const flight = fabrikantFlightText(html);
  const rows: FabrikantLotRow[] = [];

  for (const card of scanJsonObjects(flight, '{"url":')) {
    const lotId = numberAsText(card["lotId"]);
    const procedureNumber = numberAsText(card["procedureNumber"]);
    // Приманка отличается от карточки ровно отсутствием номера процедуры.
    if (lotId === "" || procedureNumber === "") continue;
    rows.push({
      procedureNumber,
      lotId,
      sequenceNumber: finiteNumber(card["sequenceNumber"]) ?? 0,
      subject: text(card["name"]),
      sectionEnum: sectionWord(card["sectionEnum"]),
      eisNumber: eisNumber(card["purchaseOosNumber"]),
      cardUrl: text(card["url"]),
    });
  }

  let total: number | null = null;
  let pages: number | null = null;
  for (const pagination of scanJsonObjects(flight, '{"keys":')) {
    const declaredTotal = finiteNumber(pagination["total"]);
    const declaredPages = finiteNumber(pagination["pages"]);
    if (declaredTotal === null || declaredPages === null) continue;
    total = declaredTotal;
    pages = declaredPages;
    break;
  }

  return {
    rows,
    noResults: flight.includes(NO_RESULTS_MARKER),
    restricted: flight.includes(RESTRICTED_MARKER),
    total,
    pages,
  };
}

/**
 * Есть ли следующая страница.
 *
 * Единственный признак — объявленное площадкой число страниц. Длина текущей
 * страницы признаком не считается: 40 лотов могут относиться к трём процедурам,
 * и короткая страница с живым продолжением в выдаче встречается.
 */
export function fabrikantHasNextPage(page: FabrikantSearchPage, requestedPage: number): boolean {
  if (page.noResults) return false;
  // Закрытая выдача не листается: строк на ней нет ни на первой странице, ни на
  // остальных, а объявленного числа страниц площадка не печатает вовсе.
  if (page.restricted) return false;
  if (page.pages === null) return false;
  return requestedPage < page.pages;
}

/**
 * Похож ли ответ на страницу выдачи Фабриканта.
 *
 * Нужна ровно для того, чтобы отличить выдачу от страницы антибота, заглушки
 * провайдера и чужого HTML с тем же RSC-загрузчиком: flight в ответе есть, но ни
 * карточек, ни пагинации, ни слов площадки в нём нет. Слова площадки — это её
 * собственные отметки исхода поиска: «ничего не найдено» и «доступ к просмотру
 * процедуры ограничен». Вторая обязательна: страница с ней исправна, пуста и
 * принадлежит Фабриканту, а без этого признания адаптер тратит повторы на
 * исправный ответ HTTP 200 и роняет весь профиль поиска.
 */
export function isFabrikantSearchPage(html: string): boolean {
  if (fabrikantFlightText(html) === "") return false;
  const page = parseFabrikantSearch(html);
  return page.rows.length > 0 || page.pages !== null || page.noResults || page.restricted;
}

/**
 * Ищет в тексте объекты, начинающиеся с `needle`, и разбирает каждый.
 *
 * Границы объекта определятся подсчётом фигурных скобок с учётом строк и
 * экранирования, а не регуляркой: внутри `name` бывают и скобки, и кавычки.
 */
function scanJsonObjects(text: string, needle: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(needle, cursor);
    if (start === -1) break;
    const end = endOfJsonObject(text, start);
    if (end === -1) {
      cursor = start + needle.length;
      continue;
    }
    const parsed = parseJsonObject(text.slice(start, end + 1));
    if (parsed !== null) found.push(parsed);
    cursor = end + 1;
  }
  return found;
}

/** Индекс закрывающей скобки объекта, начинающегося в `start`; -1, если её нет. */
function endOfJsonObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** `JSON.parse` строкового литерала без `any` наружу; null — разобрать не вышло. */
function parseJsonString(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(`"${body}"`);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** `JSON.parse` объекта без `any` наружу; null — это не объект или не JSON. */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Строковое поле; всё, что не строка, — пустая строка. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Числовое поле; конечное число или null. */
function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/**
 * Номер строкой.
 *
 * `procedureNumber` и `lotId` площадка печатает числами, а в базе и в адресе
 * карточки они живут текстом. Строковое поле тоже принимается: если площадка
 * когда-нибудь начнёт печатать номер с ведущим нулём, число его бы съело.
 */
function numberAsText(value: unknown): string {
  const fromNumber = finiteNumber(value);
  if (fromNumber !== null) return String(fromNumber);
  return text(value).trim();
}

/** Секция машинным словом. `"$undefined"` — это кодировка JS-undefined в RSC. */
function sectionWord(value: unknown): string {
  const word = text(value);
  return word === "$undefined" ? "" : word;
}

/** Номер извещения ЕИС: строка либо null, пустая строка тоже null. */
function eisNumber(value: unknown): string | null {
  const printed = text(value).trim();
  return printed === "" ? null : printed;
}

/** Регион из справочника фильтра площадки. */
export interface FabrikantRegion {
  readonly id: string;
  readonly name: string;
}

/**
 * Справочник регионов фильтра «Регион заказчика» со страницы выдачи.
 *
 * Коды у площадки непрозрачные («YePdgZyJgYOQ8-G_xJBuQQ» — Республика Бурятия) и
 * в документации не описаны, поэтому берутся с самой страницы, а не записываются
 * здесь: перевыпуск справочника у площадки не должен ломать отбор. Справочник
 * лежит в RSC-потоке с экранированными кавычками; федеральные округа — узлы
 * дерева, а не регионы, и отбрасываются.
 */
export function parseFabrikantRegions(text: string): FabrikantRegion[] {
  const plain = text.replace(/\\"/g, '"');
  const seen = new Set<string>();
  const regions: FabrikantRegion[] = [];
  for (const match of plain.matchAll(/"region_id":"([A-Za-z0-9_-]+)","region_name":"([^"]+)"/g)) {
    const id = match[1] ?? "";
    const name = (match[2] ?? "").trim();
    if (id === "" || name === "" || seen.has(id)) continue;
    if (/федеральн\S* округ/i.test(name)) continue;
    seen.add(id);
    regions.push({ id, name });
  }
  return regions;
}
