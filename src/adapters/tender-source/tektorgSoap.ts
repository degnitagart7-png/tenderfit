import { decodeXmlEntities, parseXmlAttributes } from "@/lib/fsnb/xmlTokenizer";

/**
 * Транспорт и разбор SOAP-экспорта ТЭК-Торга.
 *
 * Площадка отдаёт закупки вместе с адресами документов без ключа и без регистрации
 * (проверено живыми запросами 01.10.2026, см. `docs/REFERENCE_TEK_TORG_API.md`).
 * Форма ответа сверена с живой WSDL `https://api.tektorg.ru/procedures/wsdl`.
 *
 * Две особенности, из-за которых этот файл выглядит непривычно:
 *
 * 1. Успешный ответ приходит с `Content-Type: text/html`. Отличить выдачу от
 *    страницы входа или от ошибки по заголовку нельзя — только по телу, поэтому
 *    проверка конверта здесь обязательна, а не декоративна.
 * 2. Ответ большой (сто процедур — примерно 660 КБ), а нужен он весь сразу.
 *    Разбор идёт по срезам текста регулярными выражениями: новый XML-парсер не
 *    добавляем, а сущности и атрибуты читаем готовым токенайзером из `lib/fsnb`.
 */

/** Адреса площадки. Оба без авторизации. */
export const TEKTORG_ENDPOINTS = {
  /** Официальный экспорт процедур: SOAP, ключа не требует. */
  procedures: "https://api.tektorg.ru/procedures/soap",
  /**
   * Байты документов: `{documents}/{id документа}`, поддерживает Range.
   *
   * Последний сегмент — идентификатор документа, а не процедуры, несмотря на слово
   * `procedure` в пути. Адрес всё равно приходит готовым в элементе `<file>`,
   * собирать его самому не нужно.
   */
  documents: "https://api.tektorg.ru/open-api/documents/procedure",
} as const;

/**
 * Заголовки запроса. `SOAPAction` обязателен: без него площадка не понимает, какую
 * операцию вызывают, и отвечает ошибкой.
 */
export const TEKTORG_REQUEST_HEADERS = {
  "Content-Type": "text/xml; charset=utf-8",
  SOAPAction: "urn:procedures",
} as const;

/** Площадка сообщила об ошибке вместо выдачи. */
export class TektorgSoapFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TektorgSoapFaultError";
  }
}

/**
 * Тело ответа не удалось разобрать: пришёл не конверт, конверт оборван или в нём нет
 * списка процедур. Молча вернуть ноль закупок здесь нельзя — оператор увидел бы
 * «новых закупок нет» вместо «площадка ответила ерундой».
 */
export class TektorgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TektorgParseError";
  }
}

/**
 * Параметры запроса экспорта. Все необязательные: пустой запрос площадка тоже
 * принимает и отдаёт секцию `44fz` целиком.
 *
 * Имена полей — ровно как в `exportRequestType` из WSDL. Оба ИНН допускают
 * `maxOccurs="1"`, поэтому это строки, а не списки: несколько заказчиков означают
 * несколько запросов.
 */
export interface TektorgProceduresQuery {
  /** Окно публикации: `startDate`/`endDate`. */
  readonly startDate?: string;
  readonly endDate?: string;
  /** Окно изменения: `startUpdateAt`/`endUpdateAt`. */
  readonly startUpdateAt?: string;
  readonly endUpdateAt?: string;
  /** Секция площадки: `zakupki` (223-ФЗ и коммерческие), `44fz`, секции РЖД и др. */
  readonly sectionCode?: string;
  readonly registryNumber?: string;
  readonly eisRegistryNumber?: string;
  readonly typeId?: number;
  readonly organizerINN?: string;
  readonly customerINN?: string;
  readonly limitPage?: number;
  readonly page?: number;
}

/** Документ процедуры. */
export interface TektorgDocument {
  /** Идентификатор документа на площадке: он же последний сегмент адреса байт. */
  readonly id: string;
  /**
   * Имя файла из ответа площадки. Брать его за настоящее нельзя: в заголовке
   * `content-disposition` площадка отдаёт имя через `filename*=utf-8''…`, и оно
   * отличается от транслита в выгрузке.
   */
  readonly filename: string;
  /** Адрес байт; null, если документ снят с публикации. */
  readonly url: string | null;
  /** Документ снят с публикации: вместо `<file>` площадка прислала `<removed>`. */
  readonly removed: boolean;
}

/** Лот процедуры. */
export interface TektorgLot {
  /** Атрибут `id` элемента `<lot>` — внутренний идентификатор площадки. */
  readonly id: string;
  /** Номер лота из элемента `<number>`. Строка: площадка печатает и «1», и «1.1». */
  readonly number: string | null;
  readonly subject: string;
  /** Цена лота; null, если её не существует (например, запрос ценовой информации). */
  readonly startPrice: number | null;
  /** «Приём заявок», «Работа комиссии», «Архив», «Отменён». */
  readonly status: string | null;
  readonly customerInn: string | null;
  readonly customerName: string | null;
  readonly okpd2Codes: readonly string[];
  readonly okved2Codes: readonly string[];
  /** Адреса поставки из `<deliveryPlaces>`: часто «В соответствии с ТЗ». */
  readonly deliveryAddresses: readonly string[];
}

/** Процедура — то, что у других площадок называется закупкой или извещением. */
export interface TektorgProcedure {
  /** Атрибут `id` элемента `<procedure>`; равен `<remoteId>`. */
  readonly id: string;
  /** Номер на площадке, например «ЗП610102». */
  readonly registryNumber: string | null;
  /** Номер извещения в ЕИС. Отсутствует у чисто коммерческих закупок. */
  readonly eisRegistryNumber: string | null;
  readonly title: string;
  /** Адрес карточки на площадке: единственная рабочая ссылка для закупки вне ЕИС. */
  readonly urlToShowcase: string | null;
  readonly datePublished: string | null;
  readonly dateUpdated: string | null;
  readonly dateEndRegistration: string | null;
  /** Числовой код способа размещения из `<procedureType><id>`. */
  readonly procedureTypeId: number | null;
  /**
   * Название способа размещения, как его печатает площадка. Иногда вместо названия
   * приходит заглушка вроде «TYPE_30» — словарь типов площадка пополняет.
   */
  readonly procedureTypeTitle: string | null;
  readonly currency: string | null;
  readonly organizerFullName: string | null;
  readonly organizerInn: string | null;
  /**
   * Регион из `<organizer><legal><region>`. Заполнен примерно у трёх записей из
   * десяти, а когда заполнен, может оказаться формой из ФИАС («Город Москва столица
   * Российской Федерации город федерального значения»). Поэтому рядом лежит адрес.
   */
  readonly region: string | null;
  /**
   * Юридический адрес организатора одной строкой. Когда `<region>` пуст, весь адрес
   * приезжает в `<house>` — и регион всё равно находится через
   * `regionFromAddresses` из домена.
   */
  readonly organizerAddress: string;
  readonly documents: readonly TektorgDocument[];
  readonly lots: readonly TektorgLot[];
  /**
   * Собственный обрезок XML процедуры. Кладётся в `tenders.raw_data`, чтобы строку
   * можно было пересобрать без нового запроса к площадке.
   */
  readonly raw: string;
}

/** Страница ответа экспорта: счётчики нужны адаптеру, чтобы понять, есть ли следующая. */
export interface TektorgProceduresPage {
  readonly totalProcedures: number | null;
  readonly currentPage: number | null;
  readonly totalPage: number | null;
  readonly limitProceduresInPage: number | null;
  readonly sectionCode: string | null;
  readonly sectionName: string | null;
  readonly procedures: readonly TektorgProcedure[];
}

/** Порядок полей в `exportRequestType` — как в схеме. */
const REQUEST_FIELDS = [
  "startDate",
  "endDate",
  "startUpdateAt",
  "endUpdateAt",
  "sectionCode",
  "registryNumber",
  "eisRegistryNumber",
  "typeId",
  "organizerINN",
  "customerINN",
  "limitPage",
  "page",
] as const;

/** Экранирует значение для подстановки в XML. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Собирает конверт запроса.
 *
 * Не заданное поле в конверт не попадает вовсе: пустой тег площадка трактует как
 * фильтр «равно пустой строке», а не как «не задано», и вместо всей выдачи возвращает
 * ноль процедур.
 */
export function buildProceduresRequest(query: TektorgProceduresQuery): string {
  const values: Record<string, string> = {};
  for (const field of REQUEST_FIELDS) {
    const value = query[field];
    if (value === undefined || value === "") continue;
    values[field] =
      typeof value === "number" ? String(value) : escapeXml(value);
  }

  const body = REQUEST_FIELDS.filter((field) => values[field] !== undefined)
    .map((field) => `        <${field}>${values[field]}</${field}>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:tns="https://api.tektorg.ru/procedures/soap"
                  soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <soapenv:Body>
    <tns:procedures>
      <symbol>
${body}
      </symbol>
    </tns:procedures>
  </soapenv:Body>
</soapenv:Envelope>
`;
}

const ENVELOPE_OPEN = /<[\w.-]*:?Envelope[\s>]/;
const ENVELOPE_CLOSE = /<\/[\w.-]*:?Envelope\s*>/;
const FAULT_OPEN = /<[\w.-]*:?Fault[\s>]/;
const SELF_CLOSED_PROCEDURES = /<procedures(?:\s[^>]*)?\/>/;

interface Cut {
  /** Содержимое блока; null, если блока нет или он не закрыт. */
  readonly inner: string | null;
  /** Текст без этого блока. */
  readonly rest: string;
}

/**
 * Вырезает блок `<name>…</name>` из текста.
 *
 * Тег ищется строго по имени: `<file…>` не матчит `<filename>`, а `<document…>` не
 * матчит `<documents>`. Именно на этом спотыкался наивный разбор — вместо адреса
 * документа получалось имя файла, и скачивание падало в 404.
 * самоуплотнённый тег (`<region/>`) блоком не считается: содержимого у него нет.
 */
function cutBlock(xml: string, name: string): Cut {
  const open = new RegExp(`<${name}(?:\\s[^>]*)?>`).exec(xml);
  if (open === null) return { inner: null, rest: xml };
  const closeTag = `</${name}>`;
  const closeAt = xml.indexOf(closeTag, open.index + open[0].length);
  if (closeAt === -1) return { inner: null, rest: xml };
  return {
    inner: xml.slice(open.index + open[0].length, closeAt),
    rest: xml.slice(0, open.index) + xml.slice(closeAt + closeTag.length),
  };
}

/**
 * Распаковывает текст элемента: содержимое CDATA остаётся дословным, всё остальное
 * проходит через расшифровку сущностей.
 *
 * Разделять эти два случая важно: внутри CDATA последовательность `&amp;` — это
 * буквально текст, а не сущность.
 */
function decodeContent(raw: string): string {
  let out = "";
  let cursor = 0;
  for (const match of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    const start = match.index ?? 0;
    out += decodeXmlEntities(raw.slice(cursor, start));
    out += match[1] ?? "";
    cursor = start + match[0].length;
  }
  out += decodeXmlEntities(raw.slice(cursor));
  return out.trim();
}

/** Значение первого элемента `<name>`; null, если элемента нет или он самоуплотнён. */
function text(xml: string, name: string): string | null {
  const match = new RegExp(
    `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,
  ).exec(xml);
  const body = match?.[1];
  return body === undefined ? null : decodeContent(body);
}

/** То же, что `text`, но отсутствие элемента даёт пустую строку. */
function textOrEmpty(xml: string, name: string): string {
  return text(xml, name) ?? "";
}

/** Все значения повторяющегося элемента, без повторов и без пустых. */
function allTexts(xml: string, name: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(
    `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,
    "g",
  );
  for (const match of xml.matchAll(pattern)) {
    const body = match[1];
    if (body === undefined) continue;
    const value = decodeContent(body);
    if (value !== "" && !found.includes(value)) found.push(value);
  }
  return found;
}

/**
 * Число из элемента.
 *
 * Площадка отдаёт числа с точкой, но запятую как десятичный разделитель тоже
 * понимаем: цена, у которой молча отбросили копейки, хуже отсутствующей.
 */
function numberOrNull(xml: string, name: string): number | null {
  const raw = text(xml, name);
  if (raw === null) return null;
  const cleaned = raw.replace(/\s+/g, "");
  if (cleaned === "") return null;
  const normalized = /^-?\d+,\d+$/.test(cleaned)
    ? cleaned.replace(",", ".")
    : cleaned;
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Юридический или почтовый адрес одной строкой, в порядке частей из WSDL. */
function addressLine(block: string | null): string {
  if (block === null) return "";
  return ["index", "region", "settlement", "city", "street", "house"]
    .map((name) => text(block, name))
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");
}

function parseDocument(chunk: string): TektorgDocument {
  const removed = text(chunk, "removed") === "true";
  return {
    id: textOrEmpty(chunk, "id"),
    filename: textOrEmpty(chunk, "filename"),
    url: removed ? null : text(chunk, "file"),
    removed,
  };
}

function parseLot(chunk: string): TektorgLot {
  const attributes = parseXmlAttributes(chunk.slice(0, chunk.indexOf(">") + 1));
  const customers = cutBlock(chunk, "customers").inner;
  const customer =
    customers === null ? null : cutBlock(customers, "customer").inner;

  return {
    id: attributes["id"] ?? "",
    number: text(chunk, "number"),
    subject: textOrEmpty(chunk, "subject"),
    startPrice: numberOrNull(chunk, "startPrice"),
    status: text(chunk, "status"),
    customerInn: customer === null ? null : text(customer, "inn"),
    customerName: customer === null ? null : text(customer, "fullName"),
    okpd2Codes: allTexts(chunk, "okpd2_code"),
    okved2Codes: allTexts(chunk, "okved2_code"),
    deliveryAddresses: allTexts(chunk, "address"),
  };
}

/** Режет список на элементы по открывающему тегу, отбрасывая хвост обёртки. */
function splitElements(block: string, name: string): string[] {
  const closeTag = `</${name}>`;
  return block
    .split(new RegExp(`(?=<${name}[ >])`))
    .filter((chunk) => new RegExp(`^<${name}[ >]`).test(chunk))
    .map((chunk) => {
      const end = chunk.indexOf(closeTag);
      return end === -1 ? chunk : chunk.slice(0, end + closeTag.length);
    });
}

function parseProcedure(chunk: string): TektorgProcedure {
  const attributes = parseXmlAttributes(chunk.slice(0, chunk.indexOf(">") + 1));

  // Вложенные блоки вырезаются по очереди: после этого в остатке лежат только
  // скаляры уровня процедуры, и общий `<id>` или `<title>` способа размещения не
  // может попасть в поля процедуры.
  const type = cutBlock(chunk, "procedureType");
  const organizer = cutBlock(type.rest, "organizer");
  const documents = cutBlock(organizer.rest, "documents");
  const lots = cutBlock(documents.rest, "lots");
  const scalars = lots.rest;

  const legal =
    organizer.inner === null ? null : cutBlock(organizer.inner, "legal").inner;

  return {
    id: attributes["id"] ?? "",
    registryNumber: text(scalars, "registryNumber"),
    eisRegistryNumber: text(scalars, "eisRegistryNumber"),
    title: textOrEmpty(scalars, "title"),
    urlToShowcase: text(scalars, "url_to_showcase"),
    datePublished: text(scalars, "datePublished"),
    dateUpdated: text(scalars, "dateUpdated"),
    dateEndRegistration: text(scalars, "dateEndRegistration"),
    procedureTypeId: numberOrNull(type.inner ?? "", "id"),
    procedureTypeTitle: text(type.inner ?? "", "title"),
    currency: text(scalars, "currency"),
    organizerFullName: text(organizer.inner ?? "", "fullName"),
    organizerInn: text(organizer.inner ?? "", "inn"),
    region: text(legal ?? "", "region"),
    organizerAddress: addressLine(legal),
    documents:
      documents.inner === null
        ? []
        : splitElements(documents.inner, "document").map(parseDocument),
    lots:
      lots.inner === null ? [] : splitElements(lots.inner, "lot").map(parseLot),
    raw: chunk,
  };
}

/**
 * Разбирает ответ экспорта процедур.
 *
 * Порядок проверок важен: сначала убеждаемся, что это вообще конверт SOAP, потом —
 * что площадка не вернула Fault, и только затем считаем выдачу.
 */
export function parseProceduresResponse(xml: string): TektorgProceduresPage {
  if (!ENVELOPE_OPEN.test(xml)) {
    throw new TektorgParseError(
      "Ответ ТЭК-Торга не похож на ответ SOAP-экспорта: в теле нет конверта Envelope. " +
        `Начало тела: ${xml.slice(0, 200).trim() || "(пусто)"}`,
    );
  }
  if (!ENVELOPE_CLOSE.test(xml)) {
    throw new TektorgParseError(
      "Конверт ответа ТЭК-Торга не закрыт: соединение оборвалось, выдача неполная. " +
        "Принимать её за полную нельзя.",
    );
  }

  const fault = FAULT_OPEN.exec(xml);
  if (fault !== null) {
    const reason = text(xml, "faultstring");
    throw new TektorgSoapFaultError(
      reason === null || reason === ""
        ? "ТЭК-Торг вернул SOAP Fault без описания причины."
        : `ТЭК-Торг вернул ошибку: ${reason}`,
    );
  }

  const list = cutBlock(xml, "procedures");
  if (list.inner === null && !SELF_CLOSED_PROCEDURES.test(xml)) {
    throw new TektorgParseError(
      "В ответе ТЭК-Торга нет списка процедур: конверт целый, а элемента <procedures> не нашли.",
    );
  }

  return {
    totalProcedures: numberOrNull(list.rest, "totalProcedures"),
    currentPage: numberOrNull(list.rest, "currentPage"),
    totalPage: numberOrNull(list.rest, "totalPage"),
    limitProceduresInPage: numberOrNull(list.rest, "limitProceduresInPage"),
    sectionCode: text(list.rest, "sectionCode"),
    sectionName: text(list.rest, "sectionName"),
    procedures:
      list.inner === null
        ? []
        : splitElements(list.inner, "procedure").map(parseProcedure),
  };
}
