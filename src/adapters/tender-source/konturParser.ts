/**
 * Нормализация ответов Контур.Закупок в доменные сущности ТендерФит.
 *
 * Схема ПОДТВЕРЖДЕНА: спецификация OpenAPI 3.0.4 «АПИ Закупок» v1.0.0 и живые
 * ответы, снятые тестовым ключом 2026-09-23 (сохранены в
 * `src/adapters/tender-source/konturTestFixtures.ts`). Имена полей — реальные,
 * в PascalCase; список кандидатов оставлен только там, где одно и то же
 * доменное значение лежит в разных полях поиска и карточки
 * (`OrderName` у поиска, `Title` у карточки).
 *
 * Две особенности источника, которые определяет этот модуль:
 *
 *  1. **Закрашенные значения.** Тестовый ключ отдаёт полную базу поиска, но
 *     заменяет часть полей символом U+2591 (`BlurredApiSchema`). Такое
 *     значение — не данные, а их отсутствие: оно превращается в null,
 *     `UNKNOWN_REGION` или пропуск документа, и попадает в диагностику.
 *     Иначе в базе появились бы регион «░░░░░» и ИНН «9102░░░░░░».
 *  2. **Документов отдельным методом нет.** Спецификация не содержит
 *     эндпоинта `/documents`: ссылки на документацию приходят полем `Docs`
 *     карточки закупки. Поэтому `fetchDocuments` адаптера читает карточку.
 *
 * Модуль чистый: ни сети, ни Date.now(), ни хранилища.
 */
import type { Tender, TenderDocument, TenderLot, TenderRequirement } from "@/domain/entities";
import { UNKNOWN_CUSTOMER, UNKNOWN_REGION, isRegionKnown } from "@/domain/entities";
import type { PlacingWay, RequirementKind, TenderDocumentType, TenderLaw } from "@/domain/enums";
import type { TenderSourceQuery } from "@/adapters/types";
import { regionFromAddresses } from "@/domain/regions";
import { isBlurredValue } from "@/adapters/tender-source/konturContract";
import { parsePlacingWay, parsePrice } from "@/adapters/tender-source/eisParser";
import { documentTypeFromText } from "@/adapters/tender-source/documentType";

/** Произвольный JSON-объект из ответа API. */
export type RawRecord = Record<string, unknown>;

export function isRawRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Реальные имена полей ответа. Ключ — доменное понятие, значение — имена в том
 * порядке, в котором их нужно пробовать: сначала поиск (`SearchResultItem`),
 * затем карточка (`ExternalApiPurchaseModel`).
 */
export const KONTUR_FIELDS = {
  /** Внутренний ID закупки в Контур.Закупках. Единственное поле, которое не закрашивается. */
  id: ["Id"],
  /** Номер закупки на ЭТП. Тестовым ключом закрашен частично («3261░░░░░░░»). */
  regNumber: ["NotificationNumber"],
  /** Наименование: `OrderName` в поиске, `Title` в карточке. */
  subject: ["OrderName", "Title"],
  /** Тип торгов числом (`ApiSearchLaw`) — только в поисковой выдаче. */
  lawCode: ["TypeOfTrading"],
  /** Тип торгов строкой («44-ФЗ», «223-ФЗ», «615 ПП», «Коммерческие») — в карточке. */
  lawName: ["NotificationType"],
  /** Способ отбора: `NotificationTypeDesc` в поиске, `NotificationPlacingWay` в карточке. */
  placingWay: ["NotificationTypeDesc", "NotificationPlacingWay"],
  /** НМЦ: `MaxPrice` в поиске, `InitialSum.Price` в карточке. */
  price: ["MaxPrice"],
  initialSum: ["InitialSum"],
  lotPrice: ["Price"],
  currency: ["Currency", "CurrencyCode"],
  /** Ссылка на карточку в Контур.Закупках — не закрашивается никогда. */
  link: ["Link"],
  /** Ссылка на ЭТП: `EpUri` в поиске, `EtpLink` в карточке. */
  etpLink: ["EpUri", "EtpLink"],
  eisLink: ["EisLink"],
  submissionEnd: ["ApplicationDeadline"],
  commissionDeadline: ["CommissionDeadline"],
  /** Дата публикации: `CreateDate` в поиске, `PublicationDateTimeUTC` в карточке. */
  publicationDate: ["CreateDate", "PublicationDateTimeUTC"],
  lastUpdateDate: ["UpdatedDatetime"],
  /** Места поставки: есть и в поиске, и в карточке (внутри заказчика лота). */
  deliveryPlaces: ["DeliveryPlaces"],
  /**
   * Одно место поставки. Опечатка («Deliery») — в самой спецификации вендора,
   * поле действительно называется так. Используется как запасной вариант,
   * когда коллекция пуста: регион без адреса становится «Не указан».
   */
  deliveryPlace: ["DelieryPlace"],
  inns: ["Inns"],
  customers: ["Customers"],
  /** Заявившиеся участники — приходят только с модификатором `SearchParticipants`. */
  participants: ["Participants"],
  organizer: ["Organizer"],
  contactPerson: ["ContactPerson"],
  smp: ["SMP"],
  documents: ["Docs"],
  lots: ["Lots"],
  objects: ["Objects"],
  jointObjects: ["JointObjects"],
  okpd2: ["Okpd2s", "Okdp2s"],
  okved2: ["Okved2s"],
  customerRequirements: ["CustomerRequirements"],
  tenderRequirements: ["TenderRequirements"],
  contractGuarantee: ["ContractGuarantee"],
  applicationGuarantee: ["ApplicationGuarantee"],
  advancePayment: ["AdvancePayment"],
  supportContract: ["SupportContractRequirement", "TypeSupportContract"],
  startContractDate: ["StartContractDate"],
  endContractDate: ["EndContractDate"],
  cancelReason: ["CancelReason"],
  fileName: ["FileName"],
  url: ["Url"],
  code: ["Code"],
  name: ["Name"],
  content: ["Content"],
  organization: ["Organization"],
  fullName: ["FullName"],
  inn: ["Inn"],
} as const;

/** Имена, по которым в ответе поиска лежит массив закупок. */
const ITEMS_KEYS = ["Items", "items", "data", "results", "list", "rows"] as const;

/** Имена, по которым в ответе поиска лежит общее число закупок. */
const TOTAL_KEYS = ["TotalCount", "total", "totalCount", "count"] as const;

/** Первое непустое и не закрашенное значение из списка имён. */
export function pick(raw: unknown, aliases: readonly string[]): unknown {
  if (!isRawRecord(raw)) return undefined;
  for (const alias of aliases) {
    const value = raw[alias];
    if (value === undefined || value === null || value === "") continue;
    // Закрашенное значение — отсутствие данных, а не данные.
    if (isBlurredValue(value)) continue;
    return value;
  }
  return undefined;
}

/**
 * Есть ли внутри значения закрашенные данные. Закрашенным может быть не только
 * само поле, но и элемент списка (`DeliveryPlaces`, `Inns`) или вложенный
 * объект (`Customers[].Kpp`).
 */
function containsBlur(value: unknown): boolean {
  if (isBlurredValue(value)) return true;
  if (Array.isArray(value)) return value.some(containsBlur);
  if (isRawRecord(value)) return Object.values(value).some(containsBlur);
  return false;
}

/** Присутствует ли поле, но закрашено (нужно для диагностики тестового ключа). */
export function isBlurredField(raw: unknown, aliases: readonly string[]): boolean {
  if (!isRawRecord(raw)) return false;
  return aliases.some((alias) => containsBlur(raw[alias]));
}

function trim(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Строковое значение (null, если поля нет, оно пустое или закрашено). */
export function pickString(raw: unknown, aliases: readonly string[]): string | null {
  const value = pick(raw, aliases);
  if (value === undefined) return null;
  const text = trim(String(value));
  return text.length > 0 ? text : null;
}

/** «1 320 332,00 ₽» и 1320332 → 1320332. */
export function parseKonturNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  return parsePrice(raw);
}

/** Числовое значение. */
export function pickNumber(raw: unknown, aliases: readonly string[]): number | null {
  return parseKonturNumber(pick(raw, aliases));
}

/** «Да»/«1»/true → true; «Нет»/«0»/false → false; остальное → null. */
export function parseKonturBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (["да", "true", "1", "y", "yes"].includes(text)) return true;
  if (["нет", "false", "0", "n", "no", ""].includes(text)) return false;
  return null;
}

/** Дата «21.09.2026 19:03» без часового пояса. */
const RU_DATETIME = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** ISO-дата/время без смещения: «2026-09-23T00:00:00» или «2026-09-23». */
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

/**
 * Дата ответа в ISO-8601 → UTC-строка. Три формата:
 *  - ISO со смещением (`ApplicationDeadline`, `PublicationDateTimeUTC`) — как есть;
 *  - ISO без смещения (`CreateDate` поисковой выдачи приходит именно таким) —
 *    трактуется как UTC: все остальные даты API отдают с «Z», а `new Date()`
 *    без суффикса посчитал бы значение локальным временем машины и сдвинул его
 *    на несколько часов;
 *  - «ДД.ММ.ГГГГ[ ЧЧ:ММ]» — московское время (UTC+3), так площадки отдают
 *    `PlannedPublishDate` и часть дат в документации.
 */
export function parseKonturDate(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const fromEpoch = new Date(raw);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch.toISOString();
  }
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || isBlurredValue(value)) return null;
  const ru = value.match(RU_DATETIME);
  if (ru) {
    const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = ru;
    const parsed = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+03:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const iso = NAIVE_ISO.test(value) ? new Date(`${value.replace(" ", "T")}Z`) : new Date(value);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

/** Дата по именам поля. */
export function pickDate(raw: unknown, aliases: readonly string[]): string | null {
  return parseKonturDate(pick(raw, aliases));
}

/** Вложенный объект по именам поля. */
export function pickRecord(raw: unknown, aliases: readonly string[]): RawRecord | null {
  const value = pick(raw, aliases);
  return isRawRecord(value) ? value : null;
}

/** Массив по именам поля (закрашенная строка списком не считается). */
export function pickArray(raw: unknown, aliases: readonly string[]): unknown[] {
  const value = pick(raw, aliases);
  return Array.isArray(value) ? value : [];
}

/** Массив объектов по именам поля. */
function pickRecords(raw: unknown, aliases: readonly string[]): RawRecord[] {
  return pickArray(raw, aliases).filter(isRawRecord);
}

/**
 * Тип торгов Контур.Закупок (`ApiSearchLaw`) → закон ТендерФит.
 * 1 — 44-ФЗ, 2 — 223-ФЗ, 3 — коммерческие и малые закупки, 5 — 615-ПП,
 * 8 — коммерческие, 9 — малые закупки.
 */
export const KONTUR_LAW_CODES = [1, 2, 3, 5, 8, 9] as const;

/** Законы, которыми Контур описывает коммерческие торги: агрегат и его части. */
const COMMERCIAL_LAW_CODES = [3, 8, 9] as const;

/** Наш закон → коды `Laws` для поискового запроса. */
export function mapLawToKonturCodes(law: TenderLaw): number[] {
  switch (law) {
    case "FZ_44":
      return [1];
    case "FZ_223":
      return [2];
    case "PP_RF_615":
      return [5];
    case "COMMERCIAL":
      return [...COMMERCIAL_LAW_CODES];
  }
}

/** Код типа торгов → наш закон. Неизвестный код — null, не догадка. */
export function mapKonturLawCode(code: unknown): TenderLaw | null {
  const value = parseKonturNumber(code);
  if (value === null) return null;
  if (value === 1) return "FZ_44";
  if (value === 2) return "FZ_223";
  if (value === 5) return "PP_RF_615";
  if ((COMMERCIAL_LAW_CODES as readonly number[]).includes(value)) return "COMMERCIAL";
  return null;
}

/** Наименование типа торгов из карточки → наш закон. */
export function mapKonturLawName(name: unknown): TenderLaw | null {
  const text = String(name ?? "").toLowerCase();
  if (!text.trim()) return null;
  if (text.includes("223")) return "FZ_223";
  if (text.includes("615")) return "PP_RF_615";
  if (text.includes("44")) return "FZ_44";
  if (text.includes("коммерч") || text.includes("мал") || text.includes("b2b")) {
    return "COMMERCIAL";
  }
  return null;
}

/**
 * Закон закупки: сначала числовой код из поиска, затем наименование из
 * карточки, затем упоминание в тексте предмета. Неизвестное значение
 * трактуется как 44-ФЗ — как и в парсере ЕИС: это самый частый случай,
 * а источник всегда виден в `dataSource`.
 */
export function mapKonturLaw(raw: unknown, subject = ""): TenderLaw {
  const byCode = mapKonturLawCode(pick(raw, KONTUR_FIELDS.lawCode));
  if (byCode) return byCode;
  const byName = mapKonturLawName(pick(raw, KONTUR_FIELDS.lawName));
  if (byName) return byName;
  const text = subject.toLowerCase();
  if (text.includes("223")) return "FZ_223";
  if (text.includes("615")) return "PP_RF_615";
  return "FZ_44";
}

/** Способ размещения: русские названия разбирает ЕИС-парсер, здесь добавлена латиница. */
export function mapKonturPlacingWay(raw: unknown): PlacingWay {
  const text = String(raw ?? "").trim();
  if (!text) return "OTHER";
  const lower = text.toLowerCase();
  if (lower.includes("auction")) return "ELECTRONIC_AUCTION";
  if (lower.includes("contest") || lower.includes("tender")) return "OPEN_CONTEST";
  if (lower.includes("quotation")) return "REQUEST_FOR_QUOTATION";
  if (lower.includes("proposal")) return "REQUEST_FOR_PROPOSALS";
  if (lower.includes("sole") || lower.includes("single")) return "SOLE_SUPPLIER";
  // «Запрос цен» — название из коммерческих закупок и 223-ФЗ; по составу
  // требований это запрос котировок, так его и показываем.
  if (lower.includes("запрос цен")) return "REQUEST_FOR_QUOTATION";
  return parsePlacingWay(text);
}

/**
 * Тип документа: поле типа из карточки и имя файла → доменный тип.
 *
 * Правила разбора текста общие для всех источников и живут в
 * `documentType.ts`; здесь к ним добавляется только собственное поле Контур.Закупок.
 */
export function mapKonturDocumentType(raw: unknown, fileName = ""): TenderDocumentType {
  return documentTypeFromText(`${String(raw ?? "")} ${fileName}`);
}
/** Массив закупок из ответа поиска: `SearchResultItemPagingModel.Items`. */
export function extractKonturItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRawRecord(raw)) return [];
  for (const key of ITEMS_KEYS) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
    // Вложенная обёртка вида { data: { Items: [...] } }.
    if (isRawRecord(value)) {
      const nested = extractKonturItems(value);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

/** Общее число найденных закупок (`TotalCount`), если API его отдал. */
export function extractKonturTotal(raw: unknown): number | null {
  if (!isRawRecord(raw)) return null;
  for (const key of TOTAL_KEYS) {
    const parsed = parseKonturNumber(raw[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Номер страницы из ответа поиска (`PageNumber`), null если его нет. */
export function extractKonturPageNumber(raw: unknown): number | null {
  if (!isRawRecord(raw)) return null;
  const parsed = parseKonturNumber(raw["PageNumber"]);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

/** Коды ОКПД2 из массива `ApiReferenceModel` ({Code, Name}). */
function extractReferenceCodes(raw: unknown, aliases: readonly string[]): string[] {
  const codes: string[] = [];
  for (const item of pickArray(raw, aliases)) {
    if (typeof item === "string") {
      const code = item.trim();
      if (code && !isBlurredValue(code)) codes.push(code);
      continue;
    }
    const code = pickString(item, KONTUR_FIELDS.code);
    if (code) codes.push(code);
  }
  return codes;
}

/** Места поставки, которые реально можно прочитать (закрашенные отброшены). */
function cleanDeliveryPlaces(raw: unknown): string[] {
  const places = pickArray(raw, KONTUR_FIELDS.deliveryPlaces)
    .filter((value): value is string => typeof value === "string" && !isBlurredValue(value))
    .map((value) => trim(value))
    .filter(Boolean);
  if (places.length > 0) return places;
  // Коллекция пуста, но единственное место поставки передано отдельным полем.
  const single = pickString(raw, KONTUR_FIELDS.deliveryPlace);
  return single ? [single] : [];
}

/**
 * Регион и адреса поставки закупки. На верхнем уровне карточки `DeliveryPlaces`
 * пуст — адреса лежат в условиях заказчика внутри лота. Поэтому сначала
 * разбираются лоты, а потом недостающие поля достраиваются из них: иначе
 * закупка уезжает в «Не указан» и выпадает из регионального отбора профиля.
 */
function extractTenderDelivery(lots: TenderLot[], raw: unknown): {
  region: string;
  places: string[];
} {
  const places = cleanDeliveryPlaces(raw);
  const region = regionFromAddresses(places);
  const lotRegion = lots.find((lot) => lot.deliveryRegion !== UNKNOWN_REGION)?.deliveryRegion;
  const lotPlaces = dedupe(
    lots.map((lot) => lot.deliveryAddress).filter((address) => address !== ""),
  );
  return {
    region: region !== UNKNOWN_REGION ? region : lotRegion ?? UNKNOWN_REGION,
    places: places.length > 0 ? places : lotPlaces,
  };
}

/**
 * Записи заказчиков из любого места ответа. В поисковой выдаче это верхний
 * уровень `Customers`, в карточке закупки заказчики лежат внутри лотов, а
 * верхнего уровня нет вовсе. Ищем в обоих: промах по заказчику стоит дорого —
 * профиль подбирает «своих» заказчиков по ИНН.
 */
function customerEntries(raw: RawRecord): RawRecord[] {
  const topLevel = pickRecords(raw, KONTUR_FIELDS.customers);
  if (topLevel.length > 0) return topLevel;
  return pickRecords(raw, KONTUR_FIELDS.lots).flatMap((lot) =>
    pickRecords(lot, KONTUR_FIELDS.customers),
  );
}

/**
 * Заказчик. В поиске — `Customers[{FullName, Inn, Kpp}]`, в карточке —
 * `Lots[].Customers[].Organization{Inn, Kpp, Name}`; запасной вариант —
 * организатор (`Organizer`) и список ИНН из поиска (`Inns`).
 */
function extractCustomer(raw: RawRecord): { name: string; inn: string | null } {
  const customers = customerEntries(raw);
  const first = customers[0] ?? null;
  // В карточке заказчик вложен в Organization, в поиске — поля лежат прямо.
  const organization = first ? pickRecord(first, KONTUR_FIELDS.organization) ?? first : null;
  const organizer = pickRecord(raw, KONTUR_FIELDS.organizer);

  const name =
    pickString(organization, KONTUR_FIELDS.fullName) ??
    pickString(organization, KONTUR_FIELDS.name) ??
    pickString(organizer, KONTUR_FIELDS.fullName) ??
    UNKNOWN_CUSTOMER;

  const innRaw =
    pickString(organization, KONTUR_FIELDS.inn) ??
    pickString(organizer, KONTUR_FIELDS.inn) ??
    pickArray(raw, KONTUR_FIELDS.inns).find(
      (value): value is string => typeof value === "string" && !isBlurredValue(value),
    ) ??
    null;
  const inn = innRaw ? innRaw.replace(/\D/g, "") : "";
  return { name, inn: /^\d{10,12}$/.test(inn) ? inn : null };
}

/** Срок исполнения контракта в днях, если заказчик указал обе даты. */
export function contractTermDays(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  return Math.round((to - from) / 86_400_000);
}

/** Лоты карточки закупки. Пустой массив, если API их не отдал (поиск). */
function extractLots(
  raw: unknown,
  tenderId: string,
  fallback: { subject: string; region: string; address: string },
): TenderLot[] {
  return pickRecords(raw, KONTUR_FIELDS.lots).map((lot, index) => {
    const price = pickRecord(lot, KONTUR_FIELDS.lotPrice);
    const customers = pickRecords(lot, KONTUR_FIELDS.customers);
    const places = customers.flatMap((customer) => {
      const requirements = pickRecord(customer, KONTUR_FIELDS.customerRequirements);
      return cleanDeliveryPlaces(requirements);
    });
    const objects = customers.flatMap((customer) =>
      pickRecords(customer, KONTUR_FIELDS.objects),
    );
    const region = regionFromAddresses(places);
    const start = pickDate(customers[0] ?? null, KONTUR_FIELDS.startContractDate);
    const end = pickDate(customers[0] ?? null, KONTUR_FIELDS.endContractDate);
    return {
      id: `${tenderId}-lot-${index + 1}`,
      number: index + 1,
      subject: pickString(lot, KONTUR_FIELDS.subject) ?? fallback.subject,
      price: pickNumber(price, ["Amount", "RubPrice"]) ?? 0,
      okpd2Codes: dedupe([
        ...extractReferenceCodes(lot, KONTUR_FIELDS.okpd2),
        ...objects.flatMap((object) => extractReferenceCodes(object, KONTUR_FIELDS.okpd2)),
        ...pickRecords(lot, KONTUR_FIELDS.jointObjects).flatMap((object) =>
          extractReferenceCodes(object, KONTUR_FIELDS.okpd2),
        ),
      ]),
      deliveryRegion: region === UNKNOWN_REGION ? fallback.region : region,
      deliveryAddress: places[0] ?? fallback.address,
      deliveryTermDays: contractTermDays(start, end),
    };
  });
}

/**
 * Условия заказчика `CustomerRequirements`: обеспечение заявки и контракта,
 * аванс, казначейское сопровождение. Лоты в одной закупке однотипны, поэтому
 * берётся первый заполненный блок.
 */
function extractCustomerRequirements(raw: RawRecord): RawRecord | null {
  return (
    customerEntries(raw)
      .map((customer) => pickRecord(customer, KONTUR_FIELDS.customerRequirements))
      .find((requirements): requirements is RawRecord => requirements !== null) ?? null
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Требование к участникам из `TenderRequirements.Requirements`. */
function requirementKind(title: string): RequirementKind {
  const text = title.toLowerCase();
  if (text.includes("сро") || text.includes("саморегул")) return "SRO";
  if (text.includes("лиценз")) return "LICENSE";
  if (text.includes("опыт") || text.includes("квалификац") || text.includes("исполнен")) {
    return "EXPERIENCE";
  }
  if (
    text.includes("кадр") ||
    text.includes("специалист") ||
    text.includes("персонал") ||
    text.includes("нрс") ||
    text.includes("работник")
  ) {
    return "QUALIFIED_PERSONNEL";
  }
  if (text.includes("оборудован") || text.includes("техническ")) return "EQUIPMENT";
  if (text.includes("финанс") || text.includes("устойчив") || text.includes("обеспечен")) {
    return "FINANCIAL_STABILITY";
  }
  if (text.includes("национальн") || text.includes("режим")) return "NATIONAL_REGIME";
  return "OTHER";
}

/** Ограничение из `TenderRequirements.Restrictions` (нацрежим, запреты, условия). */
function restrictionKind(title: string, npaName: string): RequirementKind {
  const text = `${title} ${npaName}`.toLowerCase();
  if (
    text.includes("национальн") ||
    text.includes("запрет") ||
    text.includes("ограничен") ||
    text.includes("услов") ||
    /\b(616|617|656|832|878|925|1224|1236|1268|1289|1746|1875)\b/.test(text) ||
    text.includes("пп") ||
    text.includes("постановлен")
  ) {
    return "NATIONAL_REGIME";
  }
  return "RESTRICTION";
}

/**
 * Требования заказчика из карточки: `Requirements` (требования к участникам),
 * `Restrictions` (ограничения и национальный режим) и `Privileges`
 * (преимущества). Второе значение результата — признак национального режима:
 * отдельного поля у API нет, он виден только в ограничениях заказчика.
 */
export function normalizeKonturRequirements(
  raw: unknown,
  tenderId: string,
): { requirements: TenderRequirement[]; nationalRegime: boolean } {
  const requirements: TenderRequirement[] = [];
  let nationalRegime = false;

  const lots = pickRecords(raw, KONTUR_FIELDS.lots);
  const sources = lots.length > 0 ? lots : [raw];

  sources.forEach((lot, lotIndex) => {
    const tenderRequirements = pickRecord(lot, KONTUR_FIELDS.tenderRequirements);
    if (!tenderRequirements) return;

    pickRecords(tenderRequirements, ["Requirements"]).forEach((item, index) => {
      const title = pickString(item, KONTUR_FIELDS.name) ?? "Требование к участникам";
      const content = pickString(item, KONTUR_FIELDS.content) ?? "";
      requirements.push({
        id: `${tenderId}-req-${lotIndex + 1}-${index + 1}`,
        kind: requirementKind(title),
        title,
        description: content,
        mandatory: true,
        requiredValue: null,
        evidenceId: null,
      });
    });

    pickRecords(tenderRequirements, ["Restrictions"]).forEach((item, index) => {
      const title = pickString(item, KONTUR_FIELDS.name) ?? "Ограничение";
      const npa = pickRecords(item, ["AddRestrictions"])
        .map((extra) => pickString(extra, ["NpaName"]))
        .filter((value): value is string => value !== null)
        .join("; ");
      const note = pickRecords(item, ["AddRestrictions"])
        .map((extra) => pickString(extra, ["Note"]))
        .filter((value): value is string => value !== null)
        .join("; ");
      const kind = restrictionKind(title, npa);
      if (kind === "NATIONAL_REGIME") nationalRegime = true;
      requirements.push({
        id: `${tenderId}-restr-${lotIndex + 1}-${index + 1}`,
        kind,
        title,
        description: [pickString(item, KONTUR_FIELDS.content), npa, note]
          .filter((value): value is string => value !== null && value.length > 0)
          .join(". "),
        mandatory: true,
        requiredValue: null,
        evidenceId: null,
      });
    });

    pickArray(tenderRequirements, ["Privileges"])
      .filter((value): value is string => typeof value === "string" && !isBlurredValue(value))
      .forEach((privilege, index) => {
        const title = trim(privilege);
        if (!title) return;
        requirements.push({
          id: `${tenderId}-priv-${lotIndex + 1}-${index + 1}`,
          kind: "OTHER",
          title: `Преимущество: ${title}`,
          description: "",
          mandatory: false,
          requiredValue: null,
          evidenceId: null,
        });
      });
  });

  return { requirements, nationalRegime };
}

/** Документ закупки из `Docs` карточки. Закрашенная ссылка — не документ. */
export function normalizeKonturDocument(
  raw: unknown,
  tenderId: string,
  index: number,
): TenderDocument | null {
  if (!isRawRecord(raw)) return null;
  const fileName = pickString(raw, KONTUR_FIELDS.fileName);
  const url = pickString(raw, KONTUR_FIELDS.url);
  // Без ссылки файл нельзя скачать, а имя без ссылки бесполезно: пайплайн
  // анализа документов работает по URL.
  if (!url) return null;
  const title = fileName ?? `document-${index + 1}`;
  return {
    id: `${tenderId}-doc-${index + 1}`,
    type: mapKonturDocumentType(null, title),
    title,
    fileName: title,
    url,
    // Текст загружается отдельным шагом пайплайна анализа документов.
    text: "",
    pageCount: null,
    lastModified: null,
  };
}

/** Документы закупки из карточки (`Docs`). */
export function normalizeKonturDocuments(raw: unknown, tenderId: string): TenderDocument[] {
  const items = Array.isArray(raw) ? raw : pickArray(raw, KONTUR_FIELDS.documents);
  const documents: TenderDocument[] = [];
  items.forEach((item, index) => {
    const document = normalizeKonturDocument(item, tenderId, index);
    if (document) documents.push(document);
  });
  return documents;
}

/** Сколько документов в карточке есть, но ссылку тестовый ключ закрасил. */
export function countBlurredDocuments(raw: unknown): number {
  const items = Array.isArray(raw) ? raw : pickArray(raw, KONTUR_FIELDS.documents);
  return items.filter(
    (item) => isRawRecord(item) && isBlurredField(item, KONTUR_FIELDS.url),
  ).length;
}

/** Документ карточки: имя есть всегда, ссылка — только если ключ её не закрасил. */
export interface KonturCardDocumentRef {
  fileName: string;
  /** null — ссылку закрасил тестовый ключ: файл перечислен, но не скачивается. */
  url: string | null;
  /** Ссылка есть в ответе, но закрашена: отличает тариф от truly пустого поля. */
  urlBlurred: boolean;
}

/**
 * Документы карточки (`Docs`) без потери имён.
 *
 * `normalizeKonturDocuments` возвращает только то, что можно скачать, — для
 * пайплайна анализа этого достаточно. Здесь задача другая: сказать партнёру,
 * что заказчик выложил файл, даже когда адрес закрыт тарифом. Живой пример
 * 23.09.2026, карточка `RQ0336300038526000037`: «МТЗ .docx» и
 * «ФАП ТЗ итог 23.09..docx» — имена настоящие, обе ссылки закрашены.
 */
export function konturCardDocumentRefs(raw: unknown): KonturCardDocumentRef[] {
  const items = Array.isArray(raw) ? raw : pickArray(raw, KONTUR_FIELDS.documents);
  const refs: KonturCardDocumentRef[] = [];
  for (const item of items) {
    if (!isRawRecord(item)) continue;
    const fileName = pickString(item, KONTUR_FIELDS.fileName);
    if (!fileName) continue;
    refs.push({
      fileName,
      url: pickString(item, KONTUR_FIELDS.url),
      urlBlurred: isBlurredField(item, KONTUR_FIELDS.url),
    });
  }
  return refs;
}

/**
 * Что именно скрыл тестовый ключ. Ключи, а не готовые подписи: текст для
 * журнала живёт в `src/lib/labels.ts` вместе с остальными справочниками.
 */
export type KonturBlurredField =
  | "regNumber"
  | "customerName"
  | "customerInn"
  | "deliveryPlaces"
  | "okpd2"
  | "etpLink"
  | "eisLink"
  | "contactPerson"
  | "documentUrl"
  | "applicationGuarantee"
  | "contractGuarantee"
  | "participants";

/** Итог диагностики одного ответа: скрытые поля и число документов без ссылки. */
export interface KonturBlurReport {
  fields: KonturBlurredField[];
  documents: number;
}

/**
 * Диагностика закрашенных значений одного ответа — записи поиска или карточки.
 * Нужна в журнале синхронизации: пустой регион или пустой ИНН из-за тестового
 * ключа и из-за ошибки разбора выглядят одинаково, а чинятся по-разному.
 *
 * Поля проверяются ровно там, где их читает парсер: заказчик в карточке лежит
 * в `Lots[].Customers[].Organization`, места поставки — в `CustomerRequirements`,
 * и обход «всего дерева» назвал бы их именами контейнеров, а не по сути.
 */
export function describeKonturBlur(raw: unknown): KonturBlurReport {
  if (!isRawRecord(raw)) return { fields: [], documents: 0 };

  const lots = pickRecords(raw, KONTUR_FIELDS.lots);
  const customers = customerEntries(raw);
  const organizations = customers.map((customer) =>
    pickRecord(customer, KONTUR_FIELDS.organization),
  );
  const requirements = customers
    .map((customer) => pickRecord(customer, KONTUR_FIELDS.customerRequirements))
    .filter((value): value is RawRecord => value !== null);
  const objects = [
    ...customers.flatMap((customer) => pickRecords(customer, KONTUR_FIELDS.objects)),
    ...lots.flatMap((lot) => pickRecords(lot, KONTUR_FIELDS.jointObjects)),
  ];
  const nameHolders = [raw, pickRecord(raw, KONTUR_FIELDS.organizer), ...customers, ...organizations];

  const fields = new Set<KonturBlurredField>();
  /** Отмечаем поле, если оно закрашено хотя бы в одном из мест, где его ищет парсер. */
  const watch = (
    label: KonturBlurredField,
    holders: readonly unknown[],
    aliases: readonly string[],
  ): void => {
    if (holders.some((holder) => isBlurredField(holder, aliases))) fields.add(label);
  };

  watch("regNumber", [raw], KONTUR_FIELDS.regNumber);
  watch("customerName", nameHolders, [...KONTUR_FIELDS.fullName, ...KONTUR_FIELDS.name]);
  watch("customerInn", [...nameHolders, raw], [...KONTUR_FIELDS.inn, ...KONTUR_FIELDS.inns]);
  watch("deliveryPlaces", [raw, ...requirements], KONTUR_FIELDS.deliveryPlaces);
  watch("okpd2", [raw, ...lots, ...objects], KONTUR_FIELDS.okpd2);
  watch("etpLink", [raw], KONTUR_FIELDS.etpLink);
  watch("eisLink", [raw], KONTUR_FIELDS.eisLink);
  watch("contactPerson", [raw], KONTUR_FIELDS.contactPerson);
  watch("documentUrl", pickRecords(raw, KONTUR_FIELDS.documents), KONTUR_FIELDS.url);
  watch("applicationGuarantee", requirements, KONTUR_FIELDS.applicationGuarantee);
  watch("contractGuarantee", requirements, KONTUR_FIELDS.contractGuarantee);
  watch("participants", [raw], KONTUR_FIELDS.participants);

  return { fields: [...fields].sort(), documents: countBlurredDocuments(raw) };
}

/** Причина, по которой запись не превратилась в закупку. */
export type KonturSkipReason =
  | "not-an-object"
  | "no-number"
  | "no-deadline"
  | "cancelled"
  | "abandoned";

export interface KonturNormalizeResult {
  tenders: Tender[];
  /** Отброшенные записи с причиной — нужны для диагностики схемы ответа. */
  skipped: KonturSkipReason[];
  /** Сырая запись по номеру закупки: кладётся в tenders.raw_data. */
  rawByRegNumber: Record<string, RawRecord>;
  /**
   * Поля, которые источник отдал закрашенными. Непустой список означает, что
   * ключ тестовой: данные есть, но часть значений скрыта, и это нужно показать
   * в журнале синхронизации, а не молча сохранить пустоту.
   */
  blurredFields: KonturBlurredField[];
  /** Документы, у которых закрашена ссылка на файл. */
  blurredDocuments: number;
}

/**
 * Номер извещения из внутреннего Id источника.
 *
 * `Id` у Контур.Закупок обычно и есть номер извещения: в живой выдаче
 * 23.09.2026 так было у 164 закупок из 168. У остальных к номеру добавлен
 * буквенный префикс — «RQ0328100002326000522», — а закрашенный тестовым ключом
 * `NotificationNumber` совпадает с его цифровой частью («0328░░░░░░░░░░░░░░░»).
 * Хранить такой Id в `reg_number` нельзя: ЕИС публикует то же извещение под
 * «0328100002326000522», и одна закупка легла бы двумя строками, а приоритет
 * источников сравнивает их именно по номеру.
 *
 * Префикс снимаем только тогда, когда остаток похож на номер извещения: 11
 * цифр у 223-ФЗ, 19 у 44-ФЗ и ПП РФ 615. В противном случае внутренний Id
 * остаётся ключом — он уникален, а придуманный номер хуже.
 */
export function regNumberFromExternalId(externalId: string | null): string | null {
  if (!externalId) return null;
  const prefixed = /^[A-Za-z]{1,4}(\d{11}|\d{19})$/.exec(externalId);
  return prefixed ? prefixed[1]! : externalId;
}

/**
 * Одна запись Контур.Закупок → доменная закупка. Разбирает и элемент поисковой
 * выдачи, и карточку закупки: имена полей различаются, доменная сущность одна.
 *
 * Отбрасываются записи:
 *  - без идентификатора (нечем хранить: `reg_number` в базе UNIQUE);
 *  - без срока подачи заявок (`submission_end` NOT NULL, а вердикт зависит от
 *    дедлайна — закупка без срока бесполезна);
 *  - отменённые и несостоявшиеся: участвовать в них нельзя, а место в выдаче
 *    они занимают. Причина фиксируется в `skipped`, а не исчезает молча.
 *
 * Сырой ответ при этом уже сохранён в kontur_raw_responses, так что данные не
 * теряются — их можно разобрать повторно.
 */
export function normalizeKonturTender(
  raw: unknown,
  now: string,
): { tender: Tender; skip: null } | { tender: null; skip: KonturSkipReason } {
  if (!isRawRecord(raw)) return { tender: null, skip: "not-an-object" };

  const externalId = pickString(raw, KONTUR_FIELDS.id);
  // Номер извещения — ключ записи: по нему же закупку хранят ЕИС и
  // Сбербанк-АСТ, и по нему работает приоритет источников. Закрашенный
  // тестовым ключом номер («3261░░░░░░░») ключом быть не может — две разные
  // закупки получили бы один reg_number, — поэтому восстанавливаем его из
  // внутреннего Id, который не закрашивается никогда.
  const regNumber =
    pickString(raw, KONTUR_FIELDS.regNumber) ?? regNumberFromExternalId(externalId);
  const identity = externalId ?? regNumber;
  if (!identity) return { tender: null, skip: "no-number" };

  if (parseKonturBoolean(pick(raw, ["IsCancelled"])) === true) {
    return { tender: null, skip: "cancelled" };
  }
  if (parseKonturBoolean(pick(raw, ["IsAbandoned"])) === true) {
    return { tender: null, skip: "abandoned" };
  }

  const subject = pickString(raw, KONTUR_FIELDS.subject) ?? "Предмет закупки не указан";
  const submissionEnd = pickDate(raw, KONTUR_FIELDS.submissionEnd);
  if (!submissionEnd) return { tender: null, skip: "no-deadline" };

  const id = `kontur-${identity}`;
  const customer = extractCustomer(raw);
  const publicationDate = pickDate(raw, KONTUR_FIELDS.publicationDate) ?? now;
  const initialSum = pickRecord(raw, KONTUR_FIELDS.initialSum);
  const price = pickNumber(raw, KONTUR_FIELDS.price) ?? pickNumber(initialSum, ["Price"]);
  const customerRequirements = extractCustomerRequirements(raw);
  const advance = pickNumber(customerRequirements, KONTUR_FIELDS.advancePayment);
  const contractGuarantee = pickRecord(customerRequirements, KONTUR_FIELDS.contractGuarantee);
  const { requirements, nationalRegime } = normalizeKonturRequirements(raw, id);
  const topPlaces = cleanDeliveryPlaces(raw);
  const lots = extractLots(raw, id, {
    subject,
    region: regionFromAddresses(topPlaces),
    address: topPlaces[0] ?? "",
  });
  const { region, places: deliveryPlaces } = extractTenderDelivery(lots, raw);
  const okpd2 = dedupe([
    ...lots.flatMap((lot) => lot.okpd2Codes),
    ...extractReferenceCodes(raw, KONTUR_FIELDS.okpd2),
  ]);

  return {
    tender: {
      id,
      regNumber: regNumber ?? identity,
      externalId,
      law: mapKonturLaw(raw, subject),
      placingWay: mapKonturPlacingWay(pick(raw, KONTUR_FIELDS.placingWay)),
      subject,
      customerName: customer.name,
      customerInn: customer.inn,
      region,
      deliveryAddress: deliveryPlaces[0] ?? "",
      financial: {
        price: price ?? 0,
        currency:
          pickString(raw, KONTUR_FIELDS.currency) ??
          pickString(initialSum, KONTUR_FIELDS.currency) ??
          "RUB",
        // `AdvancePayment` по спецификации — всегда проценты («Аванс в
        // процентах»), поэтому суммой аванса он не становится даже если
        // значение больше ста: это ошибка источника, а не рубли.
        advancePercent: advance !== null && advance >= 0 && advance <= 100 ? advance : null,
        advanceAmount: null,
        paymentTermDays: 0,
        postpaymentDays: null,
        bidSecurityAmount: pickNumber(customerRequirements, KONTUR_FIELDS.applicationGuarantee),
        bidSecurityPercent: null,
        // `ContractGuarantee` — это `ExternalApiPayInfo {Amount, Part}`. Берём
        // только `Amount`: что именно в `Part` (проценты или доля), по живым
        // ответам не проверить — в тестовых карточках объект пуст. Угаданное
        // число в финансовом поле дороже, чем пустое.
        contractSecurityAmount: pickNumber(contractGuarantee, ["Amount"]),
        contractSecurityPercent: null,
        treasurySupport:
          pickString(customerRequirements, KONTUR_FIELDS.supportContract) !== null,
        expectedMarginPercent: null,
      },
      deadlines: {
        submissionEnd,
        publicationDate,
        lastUpdateDate: pickDate(raw, KONTUR_FIELDS.lastUpdateDate) ?? publicationDate,
        deliveryTermDays: lots.find((lot) => lot.deliveryTermDays !== null)?.deliveryTermDays ?? null,
        warrantyMonths: null,
      },
      okpd2Codes: okpd2,
      lots,
      requirements,
      documents: normalizeKonturDocuments(raw, id),
      // Отдельного признака национального режима API не отдаёт: он виден только
      // в ограничениях заказчика, поэтому значение берётся из разбора требований.
      nationalRegime,
      onlyForSmp: parseKonturBoolean(pick(raw, KONTUR_FIELDS.smp)) ?? false,
      // Ссылка на карточку в Контур.Закупках не закрашивается; ссылка на ЕИС и
      // на ЭТП у тестового ключа скрыта.
      eisUrl:
        pickString(raw, KONTUR_FIELDS.eisLink) ??
        pickString(raw, KONTUR_FIELDS.etpLink) ??
        pickString(raw, KONTUR_FIELDS.link) ??
        "",
      dataSource: "KONTUR",
      changeLog: [],
    },
    skip: null,
  };
}

/** Ответ поиска → список закупок + диагностика. */
export function normalizeKonturSearchResults(
  raw: unknown,
  now: string,
): KonturNormalizeResult {
  const tenders: Tender[] = [];
  const skipped: KonturSkipReason[] = [];
  const rawByRegNumber: Record<string, RawRecord> = {};
  const blurred = new Set<KonturBlurredField>();
  let blurredDocuments = 0;

  for (const item of extractKonturItems(raw)) {
    // Запись-не-объект разбирается здесь же: дальше по коду item — объект,
    // и его можно сохранить в raw_data без приведения типа.
    if (!isRawRecord(item)) {
      skipped.push("not-an-object");
      continue;
    }
    const blur = describeKonturBlur(item);
    for (const field of blur.fields) blurred.add(field);
    blurredDocuments += blur.documents;
    const { tender, skip } = normalizeKonturTender(item, now);
    if (tender) {
      tenders.push(tender);
      rawByRegNumber[tender.regNumber] = item;
    } else if (skip) {
      skipped.push(skip);
    }
  }
  return {
    tenders,
    skipped,
    rawByRegNumber,
    blurredFields: [...blurred].sort(),
    blurredDocuments,
  };
}

/** Дополнительные фильтры Контур.Закупок, которых нет в общем порте источника. */
export interface KonturExtraFilters {
  /** Слова, которые должны отсутствовать в тексте закупки (`Exclude`). */
  excludeKeywords?: string[];
  /**
   * Идентификаторы регионов Контур.Закупок (`RegionIds`, UUID). Берутся из
   * каталога https://zakupki.kontur.ru/Region/Catalog; по наименованию
   * субъекта API не фильтрует — для этого есть `regions` общего порта,
   * который применяется уже к полученной выдаче.
   */
  regionIds?: string[];
  /** Способ отбора (`ApiSearchProcedure`): 0 аукцион, 1 котировки, 2 ед. поставщик, 3 конкурс, 5 мониторинг цен, 99 другие. */
  procedures?: number[];
  /** Идентификаторы ЭТП (`ElectronicPlaces`). */
  electronicPlaces?: number[];
  /** Этап (`ApiSearchPurchaseStatus`): 1 подача заявок, 2 работа комиссии, 3 завершены, 4 планируются, 5 отменены, 6 несостоявшиеся. */
  statuses?: number[];
  /** Только закупки для СМП (1) или без них (2); 0 — не учитывать. */
  smp?: 0 | 1 | 2;
  /** Точный поиск по фразе (`StrictSearch`). */
  strictSearch?: boolean;
  /** Искать также в тексте документов (`Attachments`). */
  attachments?: boolean;
  /** Включать закупки без НМЦ (`MaxPriceNone`). По умолчанию включаем: цену показывает карточка. */
  maxPriceNone?: boolean;
  /** Окно публикации, ISO-строки. Обязательное поле API. */
  publishDateFrom?: string | null;
  publishDateTo?: string | null;
  /** Окно окончания подачи заявок, ISO-строки. */
  deadlineFrom?: string | null;
  deadlineTo?: string | null;
}

/** Запрос источника, расширенный фильтрами Контур.Закупок. */
export type KonturSearchQuery = TenderSourceQuery & KonturExtraFilters;

/** Код ОКПД2 цифрами: «42.11.10.000» → «421110000». Нужен для сравнения префиксом. */
function okpd2Digits(code: string): string {
  return code.replace(/\D/g, "");
}

/**
 * Локальные фильтры Контур.Закупок — то, чего API принять не может.
 *
 * В `ExternalApiSearchArgs` нет ни наименований субъектов, ни кодов ОКПД2:
 * регион задаётся только через `RegionIds` (UUID из каталога, который закрыт
 * за авторизацией), а ОКПД2 не фильтруется вовсе. Молча игнорировать параметры
 * профиля нельзя: синхронизация тогда тащит закупки со всей России и тратит
 * на их разбор бюджет языковой модели. Поэтому отсеиваем уже полученную выдачу.
 *
 * Правило региона то же, что в `matchesSearchProfile`: «не определён» не равно
 * «другой». Тестовый ключ закрашивает места поставки, и регион оказывается
 * неизвестным почти у всей выдачи — отбросить её целиком значило бы потерять
 * данные, а не уточнить поиск.
 *
 * ОКПД2 сравнивается префиксом: в профиле обычно указывают класс («42»),
 * а источник отдаёт полный код («42.11.10.000»). Закупка без кодов проходит —
 * их отсутствие не означает несовпадение.
 */
export function matchesKonturLocalFilters(tender: Tender, query: KonturSearchQuery): boolean {
  const regions = (query.regions ?? []).map((region) => region.trim()).filter(Boolean);
  if (
    regions.length > 0 &&
    isRegionKnown(tender.region) &&
    !regions.includes(tender.region.trim())
  ) {
    return false;
  }

  const wanted = (query.okpd2Codes ?? []).map(okpd2Digits).filter((code) => code.length > 0);
  if (wanted.length > 0 && tender.okpd2Codes.length > 0) {
    const own = tender.okpd2Codes.map(okpd2Digits);
    if (!wanted.some((code) => own.some((value) => value.startsWith(code)))) return false;
  }

  return true;
}

/** Сколько суток публикации охватывает поиск, если окно не задано явно. */
export const DEFAULT_SEARCH_WINDOW_DAYS = 7;

function shiftDays(iso: string, days: number): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  return new Date(time - days * 86_400_000).toISOString();
}

/**
 * Округление границы окна вниз до часа.
 *
 * Ключ кэша считается от тела запроса (`konturCacheKey`), а границы окна по
 * умолчанию берутся из `now` — с точностью до миллисекунды. Без округления
 * каждый плановый прогон получал новый ключ, кэш в `kontur_raw_responses` не
 * срабатывал, и каждый прогон тратил платный запрос: живой прогон 23.09.2026
 * показал рост `requestsToday` до 2 на втором запуске того же поиска.
 *
 * Округляем вниз все четыре границы, включая явно заданные: панель и
 * `/api/kontur/sync` принимают даты из запроса, и секунды в них так же ломают
 * ключ. Последствия округления: `DateTimeTo` теряет до часа самых свежих
 * публикаций (они придут следующим прогоном), а `DateTimeFrom` и
 * `ApplicationDeadlineFrom` слегка расширяют окно — это безопасно.
 */
function floorToHour(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  return new Date(Math.floor(time / 3_600_000) * 3_600_000).toISOString();
}

/**
 * Тело POST-запроса поиска — `ExternalApiSearchArgs`.
 *
 * Обязательные поля API — `DateTimeFrom` и `DateTimeTo` (окно публикации):
 * без них сервер отвечает 400. Если вызывающий код окно не задал, берётся
 * последние `DEFAULT_SEARCH_WINDOW_DAYS` суток от `now`.
 *
 * `ApplicationDeadlineFrom` по умолчанию равен `now`: просроченная закупка не
 * должна попадать в выдачу и тем более получать вердикт RECOMMENDED.
 *
 * Нумерация страниц начинается с нуля, размер страницы фиксирован — 50
 * закупок: передаётся `PageNumber`, а не offset/limit.
 *
 * Все четыре временные границы выравниваются по часу (`floorToHour`): тело
 * запроса участвует в ключе кэша, и миллисекунды `now` делали бы каждый прогон
 * новым запросом к платному API.
 */
export function buildKonturSearchPayload(
  query: KonturSearchQuery,
  options: { pageNumber: number; now: string },
): RawRecord {
  const payload: RawRecord = {};

  const keywords = (query.keywords ?? []).map(trim).filter(Boolean);
  if (keywords.length > 0) payload["Text"] = keywords;
  const exclude = (query.excludeKeywords ?? []).map(trim).filter(Boolean);
  if (exclude.length > 0) payload["Exclude"] = exclude;

  const inns = (query.customerInns ?? []).map((inn) => inn.replace(/\D/g, "")).filter(Boolean);
  if (inns.length > 0) payload["IncludeInns"] = inns;

  payload["DateTimeFrom"] = floorToHour(
    query.publishDateFrom
      ? query.publishDateFrom
      : shiftDays(options.now, DEFAULT_SEARCH_WINDOW_DAYS),
  );
  payload["DateTimeTo"] = floorToHour(query.publishDateTo ?? options.now);

  const regionIds = (query.regionIds ?? []).map(trim).filter(Boolean);
  if (regionIds.length > 0) payload["RegionIds"] = regionIds;

  if (query.laws.length > 0) {
    const laws = [...new Set(query.laws.flatMap(mapLawToKonturCodes))].sort((a, b) => a - b);
    if (laws.length > 0) payload["Laws"] = laws;
  }

  const statuses = query.statuses ?? [1];
  if (statuses.length > 0) payload["PurchaseStatuses"] = [...statuses].sort((a, b) => a - b);

  const procedures = query.procedures ?? [];
  if (procedures.length > 0) payload["Procedures"] = [...procedures].sort((a, b) => a - b);
  const places = query.electronicPlaces ?? [];
  if (places.length > 0) payload["ElectronicPlaces"] = [...places].sort((a, b) => a - b);

  if (query.minPrice != null) payload["MaxPriceFrom"] = Math.round(query.minPrice);
  if (query.maxPrice != null) payload["MaxPriceTo"] = Math.round(query.maxPrice);
  payload["MaxPriceNone"] = query.maxPriceNone ?? true;

  if (query.smp != null && query.smp !== 0) payload["Smp"] = query.smp;
  if (query.strictSearch) payload["StrictSearch"] = true;
  if (query.attachments) payload["Attachments"] = true;

  const deadlineFrom = query.deadlineFrom ?? options.now;
  if (deadlineFrom) payload["ApplicationDeadlineFrom"] = floorToHour(deadlineFrom);
  if (query.deadlineTo) payload["ApplicationDeadlineTo"] = floorToHour(query.deadlineTo);

  payload["PageNumber"] = Math.max(0, Math.trunc(options.pageNumber));
  return payload;
}

/** Детерминированная сериализация: порядок ключей не влияет на результат. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as RawRecord;
  const keys = Object.keys(record).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",");
  return `{${body}}`;
}

/** FNV-1a, 32 бита: короткий стабильный ключ кэша без внешних зависимостей. */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Ключ кэша: вид запроса + его параметры. Одинаковый запрос → один ключ. */
export function konturCacheKey(kind: string, payload: unknown): string {
  return `${kind}:${fnv1aHex(stableStringify(payload))}`;
}

/* ==================== Суточные лимиты тарифа ==================== */

/**
 * Остаток суточного лимита по группе методов — `ExternalApiLimitModel` из
 * `GET /external/v1/limitGroups`. Ответ этого метода бесплатный, поэтому
 * остаток всегда берётся оттуда, а не пересчитывается по нашему журналу.
 */
export interface KonturLimitGroupInfo {
  /** Имя группы: `search`, `purchase`, `favorites`, `results`. */
  limitGroup: string;
  /** Подключённые модификаторы (например `Snippets`, `SearchParticipants`). */
  modifiers: string[];
  /** Сколько запросов осталось до обнуления счётчика. */
  availableRequests: number;
  /** Сколько запросов положено тарифом. */
  totalLimit: number;
  /** true — счётчик возобновляется в 00:00, false — лимит исчерпывается навсегда. */
  isPeriodic: boolean;
  subscriptionStart: string | null;
  /** До этой даты тариф действует. После — 401/403 на любой запрос. */
  subscriptionEnd: string | null;
}

/**
 * Ответ `/external/v1/limitGroups` — массив групп. Записи без имени группы
 * отбрасываются: без имени остаток не к чему отнести.
 */
export function normalizeKonturLimitGroups(raw: unknown): KonturLimitGroupInfo[] {
  const items = Array.isArray(raw) ? raw : pickArray(raw, ["LimitGroups"]);
  const groups: KonturLimitGroupInfo[] = [];
  for (const item of items) {
    if (!isRawRecord(item)) continue;
    const name = pickString(item, ["LimitGroup"]);
    if (!name) continue;
    groups.push({
      limitGroup: name,
      modifiers: pickArray(item, ["Modifiers"]).filter(
        (value): value is string => typeof value === "string",
      ),
      availableRequests: pickNumber(item, ["AvailableRequests"]) ?? 0,
      totalLimit: pickNumber(item, ["TotalLimit"]) ?? 0,
      isPeriodic: parseKonturBoolean(pick(item, ["IsPeriodic"])) ?? true,
      subscriptionStart: pickDate(item, ["SubscriptionStart"]),
      subscriptionEnd: pickDate(item, ["SubscriptionEnd"]),
    });
  }
  return groups;
}

/** Группы лимита, которые расходует синхронизация: поисковая выдача и карточка. */
export const KONTUR_BUDGET_GROUPS: readonly string[] = ["search", "purchase"];

/**
 * Группа с наименьшим остатком — именно она ограничивает синхронизацию.
 * `null`, если нужных групп у ключа нет: метод не подключён, и это не то же
 * самое, что «лимит бесконечен».
 */
export function konturTightestLimitGroup(
  groups: readonly KonturLimitGroupInfo[],
  needed: readonly string[] = KONTUR_BUDGET_GROUPS,
): KonturLimitGroupInfo | null {
  let tightest: KonturLimitGroupInfo | null = null;
  for (const group of groups) {
    if (!needed.includes(group.limitGroup)) continue;
    if (tightest === null || group.availableRequests < tightest.availableRequests) tightest = group;
  }
  return tightest;
}

/**
 * Сколько платных запросов ещё можно сделать: остаток самой узкой группы из
 * тех, что реально участвуют в синхронизации.
 */
export function konturAvailableBudget(
  groups: readonly KonturLimitGroupInfo[],
  needed: readonly string[] = KONTUR_BUDGET_GROUPS,
): number | null {
  return konturTightestLimitGroup(groups, needed)?.availableRequests ?? null;
}

/** Самая ранняя дата окончания тарифа среди групп (null — не передана). */
export function konturSubscriptionEnd(
  groups: readonly KonturLimitGroupInfo[],
): string | null {
  const ends = groups
    .map((group) => group.subscriptionEnd)
    .filter((value): value is string => value !== null);
  if (ends.length === 0) return null;
  return ends.slice().sort()[0] ?? null;
}
