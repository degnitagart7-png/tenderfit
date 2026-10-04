/**
 * Парсер ответов площадки Сбербанк-АСТ (www.sberbank-ast.ru / utp.sberbank-ast.ru).
 *
 * Площадка отдаёт результаты поиска обычным JSON (Elasticsearch-подобный ответ)
 * через открытый эндпоинт POST /api/Processing/main — без авторизации и КЭП.
 * Реестр закупок и карточки публичны; КЭП нужна только для подачи заявки.
 *
 * Формат запроса (проверен на живом API):
 *   { windowCode: "/EsOpenUnitedPurchaseList", actionType: "MONITOR",
 *     actionCode: "default", filterBody: "<query>…</query>", parm: "es" }
 *
 * Формат ответа:
 *   { took, timed_out, _shards, PurchState, PurchaseList: [{ _id, _source }],
 *     Aggregation, Total }
 *
 * В браузере площадка оборачивает этот JSON в { data: "<строка JSON>" },
 * поэтому parseSberSearchPayload умеет разворачивать такую обёртку.
 */
import type { PlacingWay } from "@/domain/enums";
import type { Tender } from "@/domain/entities";
import { UNKNOWN_REGION } from "@/domain/entities";

/** Секция площадки: торги коммерческих заказчиков (группа VIP). */
export const SBER_COMMERCIAL_SOURCE_TERM = "Торги коммерческих заказчиков";

/** Смещение Москвы относительно UTC: даты площадки указаны в московском времени. */
export const SBER_TZ_OFFSET_HOURS = 3;

/** Параметры фильтра поиска, из которых собирается XML `filterBody`. */
export interface SberFilterParams {
  /** Ключевые слова (площадка ищет «любое слово», searchBarType=anyWord). */
  keyword?: string;
  /** Секция площадки. По умолчанию — торги коммерческих заказчиков. */
  sourceTerm?: string;
  /** Номер страницы, начиная с 0. */
  page?: number;
  /** Размер страницы (проверено до 100). */
  pageSize?: number;
  /** Начало периода размещения. */
  dateFrom: Date;
  /** Конец периода размещения. */
  dateTo: Date;
}

/** Тело POST-запроса к /api/Processing/main. */
export interface SberRequestBody {
  windowCode: string;
  actionType: string;
  actionCode: string;
  filterBody: string;
  parm: string;
}

/** Поля `_source` одной закупки в ответе поиска. Всё, что реально встречается. */
export interface SberPurchaseSource {
  PurchaseId?: string | null;
  purchCode?: string | null;
  PurchaseCodeNoBidTerm?: string | null;
  BidNo?: string | null;
  purchName?: string | null;
  BidName?: string | null;
  products?: string | null;
  CustomerNickName?: string | null;
  CustomerFullName?: string | null;
  OrgName?: string | null;
  CustomerInn?: string | null;
  OrgInn?: string | null;
  purchAmount?: string | number | null;
  purchAmountRUB?: string | number | null;
  purchCurrency?: string | null;
  RegionName?: string | null;
  orgContacts?: string | null;
  PublicDate?: string | null;
  RequestDate?: string | null;
  RequestAcceptDate?: string | null;
  RequestStartDate?: string | null;
  EndDate?: string | null;
  LastActionDt?: string | null;
  purchUpdateAt?: string | null;
  lastChange?: string | null;
  PurchaseTypeName?: string | null;
  PurchaseTypeNameTerm?: string | null;
  /** «Закупка» или «Продажа» — направление торгов. */
  PurchaseWayTerm?: string | null;
  /** «На понижение (закупка) …» / «На повышение (продажа) …». */
  PurchaseGroupTerm?: string | null;
  /** "true" — цена растёт вверх (продажа), "false" — снижается (закупка). */
  isIncrease?: string | null;
  PurchaseStageTerm?: string | null;
  purchStateName?: string | null;
  IsInArchive?: string | null;
  IsSMPTerm?: string | null;
  NationalRegimeType?: string | null;
  objectHrefTerm?: string | null;
  SourceTerm?: string | null;
}

/** Одна запись списка закупок. */
export interface SberPurchaseHit {
  _id?: string | null;
  _source?: SberPurchaseSource | null;
}

/** Разобранный ответ поиска. */
export interface SberSearchResult {
  /** Закупки, прошедшие фильтр актуальности и маппинг. */
  tenders: Tender[];
  /** Сколько записей вернула площадка на этой странице (до фильтрации). */
  returned: number;
  /** Общее число записей по всему запросу (поле Total). */
  total: number;
}

/** Экранирует символы, недопустимые в XML-тексте. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Date → «21.09.2026» (формат дат в filterBody). */
export function formatSberDate(value: Date): string {
  const dd = String(value.getUTCDate()).padStart(2, "0");
  const mm = String(value.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${value.getUTCFullYear()}`;
}

/** Собирает XML `filterBody` для поискового запроса к площадке. */
export function buildSberFilterBody(params: SberFilterParams): string {
  const keyword = escapeXml((params.keyword ?? "").trim());
  const sourceTerm = escapeXml(
    params.sourceTerm ?? SBER_COMMERCIAL_SOURCE_TERM,
  );
  const page = Math.max(0, params.page ?? 0);
  const pageSize = Math.max(1, params.pageSize ?? 50);
  return (
    "<query>" +
    "<targetPageCode>OTUnitedPurchaseList</targetPageCode>" +
    "<searchbyorg>1</searchbyorg>" +
    `<sourceTerm>${sourceTerm}</sourceTerm>` +
    "<searchBarType>anyWord</searchBarType>" +
    `<mainInput>${keyword}</mainInput>` +
    `<pagenum>${page}</pagenum>` +
    `<pagesize>${pageSize}</pagesize>` +
    "<publicDate>" +
    `<startPublicDate>${formatSberDate(params.dateFrom)}</startPublicDate>` +
    `<endPublicDate>${formatSberDate(params.dateTo)} 23:59:59</endPublicDate>` +
    "</publicDate>" +
    "</query>"
  );
}

/** Собирает тело POST-запроса к /api/Processing/main. */
export function buildSberRequestBody(filterBody: string): SberRequestBody {
  return {
    windowCode: "/EsOpenUnitedPurchaseList",
    actionType: "MONITOR",
    actionCode: "default",
    filterBody,
    parm: "es",
  };
}

/** «8943377» / «1 093 411,81» → число. Пустые и нечисловые значения → null. */
export function parseSberAmount(
  raw: string | number | null | undefined,
): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const cleaned = raw
    .replace(/[₽\s\u00a0\u2009\u202f]/g, "")
    .replace(",", ".");
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * «21.09.2026 19:03» → ISO-строка в UTC. Время площадка отдаёт по Москве,
 * поэтому по умолчанию применяется смещение +3 ч. Дата без времени
 * трактуется как 00:00 московского времени.
 */
export function parseSberDateTime(
  raw: string | null | undefined,
  tzOffsetHours: number = SBER_TZ_OFFSET_HOURS,
): string | null {
  if (!raw) return null;
  const m = raw
    .trim()
    .match(
      /(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/,
    );
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const hh = m[4] != null ? Number(m[4]) : 0;
  const min = m[5] != null ? Number(m[5]) : 0;
  const ss = m[6] != null ? Number(m[6]) : 0;
  const date = new Date(Date.UTC(yyyy, mm - 1, dd, hh - tzOffsetHours, min, ss));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Способ определения поставщика по названию процедуры площадки. */
export function mapSberPlacingWay(
  purchaseTypeName: string | null | undefined,
): PlacingWay {
  const t = (purchaseTypeName ?? "").toLowerCase();
  // Процедура обоснования НМЦ — это сбор цен, а не закупка: заявки не подаются.
  if (t.includes("обоснован")) return "OTHER";
  if (t.includes("аукцион")) return "ELECTRONIC_AUCTION";
  if (t.includes("конкурс")) return "OPEN_CONTEST";
  if (t.includes("котиров")) return "REQUEST_FOR_QUOTATION";
  if (t.includes("запрос цен") || t.includes("запроса цен")) {
    return "REQUEST_FOR_QUOTATION";
  }
  if (t.includes("единствен")) return "SOLE_SUPPLIER";
  if (t.includes("предложен")) return "REQUEST_FOR_PROPOSALS";
  return "OTHER";
}

const INACTIVE_STATE_PARTS = [
  "завершен",
  "отменен",
  "не состоялся",
  "прекращен",
  "архив",
];

/**
 * Признак того, что закупка актуальна: идёт приём заявок и она не в архиве.
 *
 * Площадка в поисковой выдаче смешивает завершённые, отменённые процедуры
 * и «обоснование НМЦ» (сбор цен без подачи заявок), поэтому фильтрация
 * по состоянию обязательна — иначе в ленту попадает мусор.
 */
export function isSberPurchaseActive(
  source: SberPurchaseSource,
  now: Date = new Date(),
): boolean {
  if (source.IsInArchive === "1") return false;

  const typeName = (source.PurchaseTypeName ?? "").toLowerCase();
  if (typeName.includes("обоснован")) return false;

  const state = (source.purchStateName ?? "").toLowerCase();
  const stage = (source.PurchaseStageTerm ?? "").toLowerCase();
  if (INACTIVE_STATE_PARTS.some((part) => state.includes(part))) return false;
  if (stage.includes("заверш") || stage.includes("отмен")) return false;

  const accepting =
    stage.includes("подача заявок") ||
    state.includes("прием заявок") ||
    state.includes("в процессе");
  if (!accepting) return false;

  const deadline =
    parseSberDateTime(source.RequestDate) ??
    parseSberDateTime(source.RequestAcceptDate);
  if (deadline && new Date(deadline).getTime() < now.getTime()) return false;

  return true;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Признак продажи имущества, а не закупки.
 *
 * Секция «Торги коммерческих заказчиков» смешивает два направления: закупки
 * («на понижение») и продажи («на повышение») — например «Продажа транспортного
 * средства Audi A8L». Поставщику продажи не подходят: там он покупатель,
 * а не участник, подающий заявку. Площадка помечает направление явно
 * (PurchaseWayTerm «Продажа», PurchaseGroupTerm «На повышение (продажа) …»,
 * isIncrease "true"), поэтому распознавание не зависит от формулировки предмета.
 */
export function isSberSale(source: SberPurchaseSource): boolean {
  const way = cleanText(source.PurchaseWayTerm).toLowerCase();
  if (way) return way.includes("продаж");

  const group = cleanText(source.PurchaseGroupTerm).toLowerCase();
  if (group) return group.includes("продаж") || group.includes("на повышение");

  if (cleanText(source.isIncrease).toLowerCase() === "true") return true;

  return cleanText(source.PurchaseTypeName).toLowerCase().includes("продаж");
}

/**
 * Код закупки без номера лота.
 *
 * Площадка отдаёт отдельную запись на каждый лот: purchCode «SBR028-2609210061.4»,
 * где «.4» — номер лота, а PurchaseCodeNoBidTerm «SBR028-2609210061» — код закупки.
 * В ленте нужна одна карточка на закупку, поэтому ключом является код без лота.
 */
export function sberPurchaseCode(source: SberPurchaseSource): string {
  const whole = cleanText(source.PurchaseCodeNoBidTerm);
  if (whole) return whole;
  const purchCode = cleanText(source.purchCode);
  return purchCode.replace(/\.\d+$/, "");
}

/** Ключ уникальности записи выдачи — номер лота (у закупки лотов может быть много). */
export function sberBidKey(tender: Tender): string {
  return tender.lots[0]?.id ?? tender.regNumber;
}

/**
 * Отображает `_source` записи выдачи (один лот) в доменный объект Tender.
 * regNumber — код закупки без номера лота, поэтому записи одной закупки
 * дополнительно склеиваются функцией mergeSberPurchases.
 * Возвращает null, если нет номера закупки или предмета.
 */
export function mapSberPurchase(source: SberPurchaseSource): Tender | null {
  const regNumber = sberPurchaseCode(source);
  const purchCode = cleanText(source.purchCode);
  if (!regNumber || !purchCode) return null;

  const subject =
    cleanText(source.purchName) ||
    cleanText(source.BidName) ||
    cleanText(source.products);
  if (!subject) return null;

  const customerName =
    cleanText(source.CustomerNickName) ||
    cleanText(source.OrgName) ||
    cleanText(source.CustomerFullName);
  const customerInn = cleanText(source.CustomerInn) || cleanText(source.OrgInn);
  const region = cleanText(source.RegionName) || UNKNOWN_REGION;
  const deliveryAddress = cleanText(source.orgContacts) || region;
  const publishedAt = parseSberDateTime(source.PublicDate) ?? new Date().toISOString();
  const submissionEnd =
    parseSberDateTime(source.RequestDate) ??
    parseSberDateTime(source.RequestAcceptDate) ??
    parseSberDateTime(source.EndDate) ??
    publishedAt;
  const lastUpdate =
    parseSberDateTime(source.LastActionDt) ??
    parseSberDateTime(source.purchUpdateAt) ??
    parseSberDateTime(source.lastChange) ??
    publishedAt;
  const price =
    parseSberAmount(source.purchAmountRUB) ?? parseSberAmount(source.purchAmount);
  const lotNumber = Number.parseInt(cleanText(source.BidNo), 10);

  return {
    id: `sber-${regNumber}`,
    regNumber,
    externalId: cleanText(source.PurchaseId) || null,
    law: "COMMERCIAL",
    placingWay: mapSberPlacingWay(source.PurchaseTypeName),
    subject,
    customerName,
    customerInn: customerInn || null,
    region,
    deliveryAddress,
    financial: {
      price: price ?? 0,
      currency: cleanText(source.purchCurrency) || "RUB",
      advancePercent: null,
      advanceAmount: null,
      paymentTermDays: 0,
      postpaymentDays: null,
      bidSecurityAmount: null,
      bidSecurityPercent: null,
      contractSecurityAmount: null,
      contractSecurityPercent: null,
      treasurySupport: false,
      expectedMarginPercent: null,
    },
    deadlines: {
      submissionEnd,
      publicationDate: publishedAt,
      lastUpdateDate: lastUpdate,
      deliveryTermDays: null,
      warrantyMonths: null,
    },
    // В поисковой выдаче площадка не отдаёт коды ОКПД2 — они есть в карточке.
    okpd2Codes: [],
    lots: [
      {
        id: purchCode,
        number: Number.isFinite(lotNumber) ? lotNumber : 1,
        subject: cleanText(source.BidName) || cleanText(source.products) || subject,
        price: price ?? 0,
        okpd2Codes: [],
        deliveryRegion: region,
        deliveryAddress,
        deliveryTermDays: null,
      },
    ],
    requirements: [],
    documents: [],
    nationalRegime: Boolean(cleanText(source.NationalRegimeType)),
    onlyForSmp: cleanText(source.IsSMPTerm).toLowerCase() === "да",
    eisUrl: cleanText(source.objectHrefTerm),
    dataSource: "SBER_AST",
    changeLog: [],
  };
}

/** Ранняя ISO-дата из двух (лексикографически ISO-8601 совпадает с хронологией). */
function earliest(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

/** Поздняя ISO-дата из двух. */
function latest(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * Склейка двух лотов одной закупки в одну карточку:
 * сумма лотов становится ценой закупки, сроки — самые ранние/поздние.
 */
export function mergeSberTenders(a: Tender, b: Tender): Tender {
  const lots = [...a.lots, ...b.lots].sort((x, y) => x.number - y.number);
  return {
    ...a,
    subject: a.subject || b.subject,
    customerName: a.customerName || b.customerName,
    customerInn: a.customerInn ?? b.customerInn,
    deliveryAddress: a.deliveryAddress || b.deliveryAddress,
    eisUrl: a.eisUrl || b.eisUrl,
    externalId: a.externalId ?? b.externalId,
    financial: {
      ...a.financial,
      price: a.financial.price + b.financial.price,
      currency: a.financial.currency || b.financial.currency,
    },
    deadlines: {
      submissionEnd: earliest(a.deadlines.submissionEnd, b.deadlines.submissionEnd),
      publicationDate: earliest(a.deadlines.publicationDate, b.deadlines.publicationDate),
      lastUpdateDate: latest(a.deadlines.lastUpdateDate, b.deadlines.lastUpdateDate),
      deliveryTermDays: a.deadlines.deliveryTermDays,
      warrantyMonths: a.deadlines.warrantyMonths,
    },
    lots,
    onlyForSmp: a.onlyForSmp || b.onlyForSmp,
    nationalRegime: a.nationalRegime || b.nationalRegime,
  };
}

/** Группирует записи выдачи по коду закупки (одна карточка на закупку). */
export function mergeSberPurchases(tenders: Tender[]): Tender[] {
  const byCode = new Map<string, Tender>();
  for (const tender of tenders) {
    const existing = byCode.get(tender.regNumber);
    byCode.set(
      tender.regNumber,
      existing ? mergeSberTenders(existing, tender) : tender,
    );
  }
  return [...byCode.values()];
}

/**
 * Разворачивает браузерную обёртку { data: "<json>" } и возвращает объект
 * поискового ответа. Бросает ошибку, если ответ не похож на результат поиска.
 */
function unwrapPayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Неожиданный формат ответа Сбербанк-АСТ");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["data"] === "string") {
    return unwrapPayload(JSON.parse(obj["data"]));
  }
  if (!("PurchaseList" in obj)) {
    throw new Error("Неожиданный формат ответа Сбербанк-АСТ: нет PurchaseList");
  }
  return obj;
}

/**
 * Записи выдачи. Площадка меняет форму поля PurchaseList:
 * массив при нескольких результатах, одиночный объект при одном
 * и null при пустой выдаче.
 */
function readHits(payload: Record<string, unknown>): SberPurchaseHit[] {
  const raw = payload["PurchaseList"];
  if (Array.isArray(raw)) return raw as SberPurchaseHit[];
  if (typeof raw === "object" && raw !== null) return [raw as SberPurchaseHit];
  return [];
}

function readTotal(payload: Record<string, unknown>): number {
  const total = payload["Total"];
  const num = typeof total === "string" ? Number.parseFloat(total) : total;
  return typeof num === "number" && Number.isFinite(num) ? num : 0;
}

/**
 * Разбирает тело HTTP-ответа площадки в список закупок.
 *
 * Продажи имущества (аукционы «на повышение») отбрасываются всегда: поставщик
 * в них покупатель, а не участник. См. isSberSale.
 *
 * @param text тело ответа POST /api/Processing/main
 * @param options.activeOnly оставить только закупки с идущим приёмом заявок (по умолчанию true)
 */
export function parseSberSearchPayload(
  text: string,
  options: { activeOnly?: boolean; now?: Date } = {},
): SberSearchResult {
  const activeOnly = options.activeOnly ?? true;
  const now = options.now ?? new Date();

  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    throw new Error("Сбербанк-АСТ вернула не JSON (возможно, страница ошибки)");
  }
  const payload = unwrapPayload(JSON.parse(trimmed));
  const hits = readHits(payload);

  const tenders: Tender[] = [];
  for (const hit of hits) {
    const source = hit?._source;
    if (!source) continue;
    if (isSberSale(source)) continue;
    if (activeOnly && !isSberPurchaseActive(source, now)) continue;
    const tender = mapSberPurchase(source);
    if (tender) tenders.push(tender);
  }

  return { tenders, returned: hits.length, total: readTotal(payload) };
}
