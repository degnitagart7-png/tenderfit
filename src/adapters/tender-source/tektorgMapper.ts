import type { PlacingWay, TenderLaw } from "@/domain/enums";
import { UNKNOWN_CUSTOMER } from "@/domain/entities";
import type { Tender, TenderLot } from "@/domain/entities";
import { regionFromAddresses } from "@/domain/regions";
import type { TektorgLot, TektorgProcedure } from "@/adapters/tender-source/tektorgSoap";

/**
 * Секция экспорта, в которую ходит адаптер.
 *
 * Передавать `sectionCode` обязательно: если его не задать, площадка по умолчанию отдаёт
 * секцию `44fz` («Государственные закупки», 408 процедур за 01.10.2026) вместо
 * коммерческих. Значения подтверждены зондом 02.10.2026.
 */
export const TEKTORG_ZAKUPKI_SECTION = "zakupki";

/** Секция государственных закупок: 44-ФЗ. */
export const TEKTORG_FZ44_SECTION = "44fz";

/**
 * Способы размещения по секциям площадки.
 *
 * Словарь у каждой секции свой, и это не перестраховка: `typeId=2` в `zakupki` —
 * «Аукцион», а в `44fz` — «Запрос котировок в электронной форме». Одна общая таблица
 * перепутала бы способы размещения целиком.
 *
 * Числа и названия сняты с живого ответа за 01–02.10.2026 (105 процедур `zakupki` окна
 * изменений и 100 процедур `44fz` окна публикации); в комментарии — сколько раз тип
 * встретился.
 */
export const TEKTORG_PLACING_WAYS: Readonly<
  Record<string, Readonly<Record<number, PlacingWay>>>
> = {
  /** 223-ФЗ и коммерческие закупки. */
  [TEKTORG_ZAKUPKI_SECTION]: {
    2: "ELECTRONIC_AUCTION", // Аукцион ×22
    3: "OPEN_CONTEST", // Конкурс ×8
    4: "REQUEST_FOR_PROPOSALS", // Запрос предложений ×7
    5: "REQUEST_FOR_QUOTATION", // Запрос цен ×5
    18: "REQUEST_FOR_QUOTATION", // Запрос котировок ×42
    /**
     * Запрос предоставления ценовой информации ×19 — не котировки. Процедура собирает
     * цены, чтобы обосновать НМЦК, и договором не заканчивается: положить её в
     * `REQUEST_FOR_QUOTATION` значило бы засорить фильтр котировок закупками, где
     * нечего выигрывать.
     */
    21: "OTHER",
    22: "REQUEST_FOR_PROPOSALS", // Запрос оферт ×4
    /** Площадка сама не знает названия этого типа и печатает заглушку «TYPE_30» ×1. */
    30: "OTHER",
  },
  /** Государственные закупки. */
  [TEKTORG_FZ44_SECTION]: {
    0: "ELECTRONIC_AUCTION", // Аукцион ×41
    1: "OPEN_CONTEST", // Открытый конкурс ×1
    2: "REQUEST_FOR_QUOTATION", // Запрос котировок в электронной форме ×19
    /** «Закупка товаров» ×39 — название площадки не соответствует ни одному способу 44-ФЗ. */
    6: "OTHER",
  },
} as const;

/** Что мапперу нужно знать о процедуре сверх самого разбора. */
export interface TektorgMappingOptions {
  /**
   * Код секции экспорта, из которой пришла процедура. От него зависят закон, ключ
   * дедупликации и словарь способов размещения. Не задан — считаем `zakupki`: адаптер
   * ходит только в неё.
   */
  readonly sectionCode?: string | null;
  /** Метка партии синхронизации (`tenders.synced_at`). */
  readonly syncStartedAt?: string | null;
}

/**
 * Отображает процедуру экспорта ТЭК-Торга в доменный объект Tender.
 *
 * Экспорт площадки беднее карточки: в нём нет требований к участникам, национального
 * режима, признака закупки для СМП и истории изменений. Эти поля остаются пустыми —
 * пустое требование и отсутствующее различаются в вердикте, и додумывать их нельзя.
 */
export function mapTektorgProcedure(
  procedure: TektorgProcedure,
  options?: TektorgMappingOptions,
): Tender {
  const sectionCode = options?.sectionCode?.trim() || TEKTORG_ZAKUPKI_SECTION;
  const platformNumber = procedure.registryNumber?.trim() ?? "";
  const eisNumber = procedure.eisRegistryNumber?.trim() ?? "";

  // Площадка отдаёт лоты и в обратном порядке: в живом ответе лот 2 лежит раньше лота 1.
  const orderedLots = sortLots(procedure.lots);
  // Место поставки ближе к сути закупки, чем адрес организатора, поэтому идёт первым:
  // «В соответствии с ТЗ» регион не даёт, и тогда он находится из названия. Адрес
  // организатора — последний: головной офис в Москве не делает закупку московской.
  // Живая выдача 02.10.2026: из 75 процедур у 8 место поставки стоит заглушкой,
  // <region> пуст, а субъект назван в названии — и все восемь без этого правила
  // получали Москву, хотя работы шли на Сахалине, в Рязани, Башкортостане, Самарской
  // и Тюменской областях.
  const region = regionFromAddresses([
    ...orderedLots.flatMap((lot) => lot.deliveryAddresses),
    procedure.region,
    procedure.title,
    ...orderedLots.map((lot) => lot.subject),
    procedure.organizerAddress,
  ]);
  const deliveryAddress =
    orderedLots.flatMap((lot) => lot.deliveryAddresses).find(isFilled) ??
    procedure.organizerAddress ??
    region;
  const customer = tektorgCustomer(procedure, orderedLots);

  return {
    id: `tektorg-${platformNumber || procedure.id}`,
    regNumber: tektorgRegNumber(sectionCode, platformNumber, eisNumber),
    externalId: platformNumber || null,
    law: tektorgLaw(sectionCode, eisNumber),
    placingWay: tektorgPlacingWay(sectionCode, procedure.procedureTypeId),
    subject: procedure.title,
    customerName: customer.name,
    customerInn: customer.inn,
    region,
    deliveryAddress,
    financial: {
      price: tektorgPrice(orderedLots),
      currency: procedure.currency?.trim() || "RUB",
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
      submissionEnd: procedure.dateEndRegistration ?? "",
      publicationDate: procedure.datePublished ?? "",
      lastUpdateDate: procedure.dateUpdated ?? procedure.datePublished ?? "",
      deliveryTermDays: null,
      warrantyMonths: null,
    },
    okpd2Codes: uniqueInOrder(orderedLots.flatMap((lot) => [...lot.okpd2Codes])),
    lots: orderedLots.map((lot, index) => mapTektorgLot(lot, index, region, procedure)),
    requirements: [],
    // Документы отдаёт fetchDocuments адаптера: список процедур несёт только их адреса.
    documents: [],
    nationalRegime: false,
    onlyForSmp: false,
    eisUrl: procedure.urlToShowcase ?? "",
    dataSource: "TEK_TORG",
    changeLog: [],
    syncedAt: options?.syncStartedAt ?? null,
  };
}

/**
 * Ключ записи в базе.
 *
 * В `zakupki` номер ЕИС лежит в `eisRegistryNumber`, а `registryNumber` — номер площадки
 * («ЗП6082206»). В `44fz` наоборот: `eisRegistryNumber` нет ни у одной из ста проверенных
 * процедур, а `registryNumber` у всех — 19-значный номер ЕИС, поэтому префикс площадки
 * там сломал бы дедупликацию с еисовской записью.
 */
function tektorgRegNumber(
  sectionCode: string,
  platformNumber: string,
  eisNumber: string,
): string {
  if (eisNumber) return eisNumber;
  if (sectionCode === TEKTORG_FZ44_SECTION && platformNumber) return platformNumber;
  return platformNumber ? `TEKTORG-${platformNumber}` : "";
}

/** Закон процедуры: секция 44-ФЗ, иначе признак публикации в ЕИС, иначе коммерческая. */
function tektorgLaw(sectionCode: string, eisNumber: string): TenderLaw {
  if (sectionCode === TEKTORG_FZ44_SECTION) return "FZ_44";
  return eisNumber ? "FZ_223" : "COMMERCIAL";
}

/**
 * Способ размещения. Неизвестный тип, отсутствующий тип и неизвестная секция дают `OTHER`,
 * а не ошибку: словарь площадка пополняет, и в живой выдаче встретился тип, название
 * которого она сама печатает заглушкой «TYPE_30».
 */
function tektorgPlacingWay(sectionCode: string, typeId: number | null): PlacingWay {
  if (typeId === null) return "OTHER";
  return TEKTORG_PLACING_WAYS[sectionCode]?.[typeId] ?? "OTHER";
}

/**
 * Цена закупки — сумма цен лотов, но только когда цена есть у всех.
 *
 * Нуль означает «цена не опубликована», а не бесплатную закупку (`isPriceKnown`):
 * запросы ценовой информации выходят без цены примерно в четверти случаев. Занижать цену
 * закупки из-за одного лота без цены нельзя — она прошла бы фильтр по лимиту профиля.
 */
function tektorgPrice(lots: readonly TektorgLot[]): number {
  if (lots.length === 0) return 0;
  if (lots.some((lot) => lot.startPrice === null)) return 0;
  return lots.reduce((sum, lot) => sum + (lot.startPrice ?? 0), 0);
}

/**
 * Заказчик закупки.
 *
 * Организатор проводит процедуру, а покупает заказчик: у ЗП6082206 это разные лица
 * (ООО «РГ-СНАБЖЕНИЕ» против АО «РЕГИОНГАЗ-ИНВЕСТ»). Поэтому сначала смотрим в лоты и
 * только потом на организатора.
 */
function tektorgCustomer(
  procedure: TektorgProcedure,
  lots: readonly TektorgLot[],
): { name: string; inn: string | null } {
  const fromLot = lots.find((lot) => isFilled(lot.customerName) || isFilled(lot.customerInn));
  const name =
    fromLot?.customerName?.trim() || procedure.organizerFullName?.trim() || UNKNOWN_CUSTOMER;
  const inn = fromLot?.customerInn?.trim() || procedure.organizerInn?.trim() || null;
  return { name, inn };
}

/** Один лот экспорта в доменный лот. */
function mapTektorgLot(
  lot: TektorgLot,
  index: number,
  tenderRegion: string,
  procedure: TektorgProcedure,
): TenderLot {
  // Порядок тот же, что и у региона закупки, но свои признаки лота идут первыми:
  // у многолотовой закупки лоты бывают в разных субъектах, и общий регион закупки
  // здесь был бы грубее, чем название самого лота.
  const deliveryRegion = regionFromAddresses([
    ...lot.deliveryAddresses,
    lot.subject,
    procedure.region,
    procedure.title,
    procedure.organizerAddress,
  ]);
  return {
    id: lot.id,
    number: lotNumber(lot.number, index),
    // Пустой предмет лота названием процедуры не заменяется: у многолотовой закупки
    // это выдало бы два одинаковых предмета там, где площадка их не опубликовала.
    subject: lot.subject,
    price: lot.startPrice ?? 0,
    okpd2Codes: [...lot.okpd2Codes],
    deliveryRegion: deliveryRegion === tenderRegion ? tenderRegion : deliveryRegion,
    deliveryAddress:
      lot.deliveryAddresses.find(isFilled) ?? procedure.organizerAddress ?? deliveryRegion,
    // Экспорт срока поставки не содержит.
    deliveryTermDays: null,
  };
}

/** Номер лота: площадка печатает и «1», и «1.1», а при отсутствии номера спасает порядок. */
function lotNumber(raw: string | null, index: number): number {
  const parsed = Number.parseFloat(raw?.trim() ?? "");
  return Number.isFinite(parsed) ? parsed : index + 1;
}

/** Лоты по возрастанию номера: площадка отдаёт их и в обратном порядке. */
function sortLots(lots: readonly TektorgLot[]): TektorgLot[] {
  return [...lots].sort((a, b) => lotNumber(a.number, 0) - lotNumber(b.number, 0));
}

/** Непустая строка. */
function isFilled(value: string | null | undefined): value is string {
  return (value ?? "").trim().length > 0;
}

/** Значения без повторов, порядок первого вхождения сохранён. */
function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
