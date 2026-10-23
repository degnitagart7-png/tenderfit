/**
 * Парсер HTML-выдачи ЕИС (zakupki.gov.ru).
 * Страница результатов серверно рендерится и кодируется в UTF-8,
 * поэтому данные можно получать обычным HTTP-запросом без браузера и ЭЦП.
 */
import type { PlacingWay, TenderLaw } from "@/domain/enums";
import { kladrId } from "@/domain/regionCodes";
import type { EisOkpd2Ref } from "@/adapters/tender-source/eisOkpdTree";

/** URL поисковой выдачи ЕИС с GET-параметрами.
 *
 * Регионального параметра здесь нет намеренно: единственная найденная на живом
 * сайте возможность — `oktmoIds` (коды ОКТМО субъектов РФ), но её полнота
 * непроверяема и непредсказуема, см. docs/ACCESS_EIS.md, раздел «Регион».
 */
export function buildEisSearchUrl(params: {
  baseUrl?: string;
  searchString?: string;
  /** Законы ЕИС. COMMERCIAL игнорируется — в ЕИС коммерческих торгов нет. */
  laws?: TenderLaw[];
  minPrice?: number | null;
  maxPrice?: number | null;
  /**
   * Позиции ОКПД2 с номерами справочника ЕИС (см. eisOkpdTree). Голые коды ЕИС
   * не понимает: параметр `okpd2=41` она молча игнорирует.
   */
  okpd2?: readonly EisOkpd2Ref[];
  /** Составной идентификатор заказчика (см. buildCustomerIdOrg). */
  customerIdOrg?: string;
  offset?: number;
  /**
   * Размер страницы выдачи: 10, 20, 50 или 100. Обычный размер (10) параметр
   * не передаёт — так было и работало.
   */
  recordsPerPage?: number;
  orderBy?: string;
  /**
   * Только закупки, где ещё идёт подача заявок (фильтр «Подача заявок», `af`).
   * Без него выдача, отсортированная по дате, наполовину состоит из закрытых
   * закупок, и лимит на слово кончается раньше, чем доходит до открытых.
   */
  onlyOpen?: boolean;
  /** Номер страницы выдачи, с единицы. Первая страница параметра не передаёт. */
  pageNumber?: number;
  /**
   * Регион заказчика, код из двух цифр («03» — Бурятия).
   *
   * ЕИС принимает его в формате КЛАДР сразу в двух параметрах: `customerPlace`
   * и `customerPlaceCodes`. Один из них без второго выдачу не сужает
   * (проверено 05.10.2026).
   */
  customerRegionCode?: string;
  /**
   * Размещены не раньше этой даты (ДД.ММ.ГГГГ). ЕИС держит давние извещения
   * (2014, 2021) со статусом «Подача заявок», и без этой границы они занимали
   * почти всю выдачу региона: из 300 строк по «ремонту» в Бурятии открытых
   * было 15 (проверено 05.10.2026).
   */
  publishedFrom?: string;
}): string {
  const base = params.baseUrl ?? "https://zakupki.gov.ru";
  const url = new URL("/epz/order/extendedsearch/results.html", base);
  if (params.searchString) url.searchParams.set("searchString", params.searchString);
  const laws = params.laws ?? ["FZ_44", "FZ_223"];
  if (laws.includes("FZ_44")) url.searchParams.set("fz44", "on");
  if (laws.includes("FZ_223")) url.searchParams.set("fz223", "on");
  if (laws.includes("PP_RF_615")) url.searchParams.set("fz615", "on");
  if (params.minPrice != null)
    url.searchParams.set("priceMin", String(params.minPrice));
  if (params.maxPrice != null)
    url.searchParams.set("priceMax", String(params.maxPrice));
  if (params.okpd2 && params.okpd2.length > 0) {
    url.searchParams.set("okpd2Ids", params.okpd2.map((ref) => String(ref.id)).join(","));
    url.searchParams.set("okpd2IdsCodes", params.okpd2.map((ref) => ref.code).join(","));
    // Без вложенных позиций раздел «41» находит только закупки с кодом ровно «41»: ноль.
    url.searchParams.set("okpd2IdsWithNested", "on");
  }
  if (params.customerIdOrg)
    url.searchParams.set("customerIdOrg", params.customerIdOrg);
  // Морфология включена всегда: без неё «юридические» не находит «юридических»,
  // а словоформа в названии — норма.
  url.searchParams.set("morphology", "on");
  if (params.onlyOpen === true) url.searchParams.set("af", "on");
  url.searchParams.set(
    "orderBy",
    params.orderBy ?? (params.onlyOpen === true ? "PUBLISH_DATE" : "UPDATE_DATE"),
  );
  url.searchParams.set("sortDirection", "false");
  url.searchParams.set("offset", String(params.offset ?? 0));
  if (params.publishedFrom) url.searchParams.set("publishDateFrom", params.publishedFrom);
  if (params.customerRegionCode) {
    const kladr = kladrId(params.customerRegionCode);
    url.searchParams.set("customerPlace", kladr);
    url.searchParams.set("customerPlaceCodes", kladr);
  }
  if (params.pageNumber !== undefined && params.pageNumber > 1) {
    url.searchParams.set("pageNumber", String(params.pageNumber));
  }
  // ЕИС принимает размер страницы только с подчёркиванием: `_50`, а не `50`.
  if (params.recordsPerPage !== undefined && params.recordsPerPage > 10) {
    url.searchParams.set("recordsPerPage", `_${String(params.recordsPerPage)}`);
  }
  return url.toString();
}

/**
 * Размер страницы выдачи под нужное число закупок.
 *
 * Адаптер листал выдачу параметром `offset`, и ЕИС его игнорирует: проверено
 * 04.10.2026 на живом сайте — `offset=0`, `10`, `20`, `30` вернули одни и те же
 * десять закупок. Лимит при этом только обрезал первую страницу, поэтому живой
 * поиск с лимитом 25 получал 10. Настоящие параметры — `pageNumber` и
 * `recordsPerPage` (`_10`, `_20`, `_50`, `_100`): размер страницы один запрос
 * берёт целиком, без цикла по страницам и без лишних обращений к сайту.
 *
 * Берётся наименьший допустимый размер, не меньший лимита; выше ста ЕИС не
 * отдаёт. Нет лимита — обычная страница: безлимитный обход ЕИС не нужен.
 */
export function recordsPerPageFor(limit: number | undefined): 10 | 20 | 50 | 100 {
  if (limit === undefined || !Number.isFinite(limit)) return 10;
  if (limit <= 10) return 10;
  if (limit <= 20) return 20;
  if (limit <= 50) return 50;
  return 100;
}

/** Составной идентификатор заказчика для параметра customerIdOrg.
 * Формат ЕИС: `-1:<наименование>zZzZzZzZ<ИНН>zZzZ<КПП>zZ<id организации>`. */
export function buildCustomerIdOrg(customer: {
  title: string;
  inn: string;
  kpp: string | null;
  orgId: string;
}): string {
  return `-1:${customer.title}zZzZzZzZ${customer.inn}zZzZ${customer.kpp ?? ""}zZ${customer.orgId}`;
}

/** Ссылка на организацию из выдачи поиска организаций ЕИС. */
export interface EisCustomerRef {
  title: string;
  inn: string;
  kpp: string | null;
  orgId: string;
  /** Готовое значение параметра customerIdOrg. */
  customerIdOrg: string;
}

/**
 * Разбор выдачи /epz/organization/search/results.html: из ссылок вида
 * «/epz/order/extendedsearch/results.html?...&customerIdOrg=...» извлекает
 * готовые составные идентификаторы заказчика. Ссылки на реестр контрактов
 * (/epz/contract/...) игнорируются — у них тот же параметр, но с лишними
 * внутренними идентификаторами.
 * Формат значения: `-1:<наименование>zZzZzZzZ<ИНН>zZzZ<КПП>zZ<id организации>`,
 * где пробелы в наименовании закодированы как «+».
 */
export function parseCustomerRefsFromOrgSearch(html: string): EisCustomerRef[] {
  const refs: EisCustomerRef[] = [];
  const re =
    /\/epz\/order\/extendedsearch\/results\.html[^"]*?customerIdOrg=([^&"\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(m[1] ?? "");
    } catch {
      continue;
    }
    const body = decoded.startsWith("-1:") ? decoded.slice(3) : decoded;
    const parts = body.split("zZzZ");
    const title = (parts[0] ?? "").replace(/\+/g, " ").trim();
    const inn = (parts[2] ?? "").trim();
    // Хвост после КПП отделён одиночным «zZ»: «<КПП>zZ<id>».
    const tail = (parts[3] ?? "").split("zZ");
    const kpp = (tail[0] ?? "").trim() || null;
    const orgId = (tail[1] ?? "").trim();
    if (!title || !/^\d{10,12}$/.test(inn) || !orgId) continue;
    if (refs.some((r) => r.inn === inn)) continue;
    refs.push({
      title,
      inn,
      kpp,
      orgId,
      // Пересобираем значение из нормализованных частей: при повторном
      // кодировании в URL пробелы снова станут «+», как в канонической ссылке ЕИС.
      customerIdOrg: buildCustomerIdOrg({ title, inn, kpp, orgId }),
    });
  }
  return refs;
}

/** «327 148 627,57 ₽» → 327148627.57. Учитывает неразрывный пробел U+00A0. */
export function parsePrice(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[₽\s\u00a0]/g, "")
    .replace(/\u2009|\u202f/g, "")
    .replace(",", ".");
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

/** «15.09.2026» → ISO-строка (дата, время 00:00 UTC). */
export function parseRuDate(raw: string): string | null {
  const m = raw.trim().match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
}

/** Определяет закон по тексту заголовка карточки («44-ФЗ ...», «223-ФЗ ...»). */
export function parseLaw(
  headerText: string,
): "FZ_44" | "FZ_223" | "PP_RF_615" {
  const t = headerText.toLowerCase();
  if (t.includes("223")) return "FZ_223";
  if (t.includes("615")) return "PP_RF_615";
  return "FZ_44";
}

/** Сопоставляет русский способ определения поставщика с PlacingWay. */
export function parsePlacingWay(headerText: string): PlacingWay {
  const t = headerText.toLowerCase();
  if (t.includes("аукцион")) return "ELECTRONIC_AUCTION";
  if (t.includes("конкурс")) return "OPEN_CONTEST";
  if (t.includes("котиров")) return "REQUEST_FOR_QUOTATION";
  if (t.includes("предложен")) return "REQUEST_FOR_PROPOSALS";
  if (t.includes("единствен")) return "SOLE_SUPPLIER";
  return "OTHER";
}

/** Извлекает ИНН из ссылки на организацию. */
export function parseInnFromHref(href: string): string | null {
  const m = href.match(/(?:inn|organizationCode)=(\d{10,12})/);
  return m ? (m[1] as string) : null;
}
