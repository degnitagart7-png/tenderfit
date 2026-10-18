/**
 * Маппер ЭТП ГПБ: очищенная карточка → доменный `Tender`.
 *
 * Карточка беднее карточек ЕИС и Фабриканта: нет обеспечений заявки и договора, срока
 * поставки, требований к участникам и кодов ОКПД2 (список `okpds` в замерах 19.10.2026
 * был пуст у всех девяти карточек), документов тоже нет — их файлы лежат на закрытом
 * `robots.txt` хосте. Что площадка не напечатала, остаётся пустым: пустое требование и
 * отсутствующее различаются в вердикте, и додумывать нельзя.
 *
 * Пять правил, которые стоит знать до чтения кода.
 *
 * 1. **Ключ записи — номер ЕИС, если он есть.** Из `eis_url` (`…regNumber=32616379968`),
 *    а если ссылки нет — из `registry_number`, когда это ровно 11 цифр (номер извещения
 *    223-ФЗ: у `fx-etp-0` площадка печатает его как свой номер, а ссылки на ЕИС нет).
 *    Так закупка совпадает с записью ЕИС и ТЭК-Торга (`tektorgRegNumber`), и приоритет
 *    источников решает, чья запись останется. Иначе — `ETPGPB-<registry_number>`.
 *
 * 2. **Закон.** Есть номер ЕИС — 223-ФЗ, иначе коммерческая закупка. Поле
 *    `legal_regulation` площадки всегда 0 и ничего не значит.
 *
 * 3. **Срок — московское время.** `application_reception_normal_date` печатается как
 *    «23.10.2026 03:00» без зоны; `time_before_end_registration` и `+03:00` в датах лотов
 *    показывают, что это Москва. У `etp_click` поля нет вовсе: срок приёма предложений —
 *    `response_date` лота.
 *
 * 4. **Заказчик — не организатор.** `relationships.company` — тот, кто проводит процедуру
 *    (ГСП ЦЕНТР), а покупает заказчик лота (ГСП Ремонт); у `commerce` и `etp_click`
 *    организатора нет вовсе. Берётся первый заказчик лота, потом организатор — как у
 *    ТЭК-Торга. Для совместной закупки (несколько заказчиков) это первый из них.
 *
 * 5. **Регион — сначала то, что ближе к месту работ.** Адрес поставки лота и
 *    `lot_regions`, потом название закупки, и только потом `region`/`regions` и адреса
 *    заказчика и организатора: последние описывают, где сидит организатор, а не где
 *    поставка (у `gaz-0` «Санкт-Петербург» — адрес «Газпром комплектации», а поставка —
 *    для филиала на Ямале). Порядок тот же, что у `mapTektorgProcedure`.
 *
 * Контактов здесь нет: на вход приходит `EtpgpbCard`, из которого они не выпускаются
 * (см. `etpgpbCard.ts`), а маппер читает только поля этой записи.
 */
import type { PlacingWay, TenderLaw } from "@/domain/enums";
import { UNKNOWN_CUSTOMER, UNKNOWN_REGION } from "@/domain/entities";
import type { Tender, TenderLot } from "@/domain/entities";
import { regionFromAddress, regionFromAddresses } from "@/domain/regions";
import type { EtpgpbCard, EtpgpbCompany, EtpgpbLot } from "@/adapters/tender-source/etpgpbCard";
import { ETPGPB_ORIGIN, isEtpgpbUrlAllowed } from "@/adapters/tender-source/etpgpbUrl";

/** Смещение Москвы: площадка печатает сроки без зоны, и это +03:00. */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface EtpgpbMappingOptions {
  /** Адрес, по которому карточку запросили: запасная ссылка, если путь из карточки не годится. */
  readonly cardUrl?: string;
  /** Метка партии синхронизации (`tenders.synced_at`). */
  readonly syncStartedAt?: string | null;
}

/** Номер извещения ЕИС из `eis_url` (`…?regNumber=32616379968`); null, если ссылки нет. */
function eisNumberFromUrl(eisUrl: string | null): string | null {
  if (eisUrl === null) return null;
  return /[?&]regNumber=(\d+)/i.exec(eisUrl)?.[1] ?? null;
}

/**
 * Номер извещения ЕИС, если у процедуры он есть: ссылка на ЕИС или 11-значный номер
 * площадки. Сравнение 11 цифр — как у остальных площадок: «19 цифр — 44-ФЗ, 11 цифр —
 * 223-ФЗ», а номер площадки из букв и цифр («АП123903») под него не подходит.
 */
export function etpgpbEisNumber(card: EtpgpbCard): string | null {
  const fromUrl = eisNumberFromUrl(card.eisUrl);
  if (fromUrl !== null) return fromUrl;
  return /^\d{11}$/.test(card.registryNumber) ? card.registryNumber : null;
}

/** Ключ записи в базе: номер ЕИС, иначе `ETPGPB-<номер площадки>`. */
export function etpgpbRegNumber(card: EtpgpbCard): string {
  const eis = etpgpbEisNumber(card);
  if (eis !== null) return eis;
  if (card.registryNumber !== "") return `ETPGPB-${card.registryNumber}`;
  return `ETPGPB-${card.kind}-${card.platformId}`;
}

/** Закон: есть номер ЕИС — 223-ФЗ, иначе коммерческая закупка. */
export function etpgpbLaw(card: EtpgpbCard): TenderLaw {
  return etpgpbEisNumber(card) === null ? "COMMERCIAL" : "FZ_223";
}

/** Идёт ли приём заявок по мнению площадки. Срок проверяется отдельно: см. адаптер. */
export function etpgpbIsAccepting(card: EtpgpbCard): boolean {
  return card.stage === "accepting";
}

/** Продажа и аренда имущества: поставщик там покупатель, такие процедуры не берём. */
export function etpgpbIsPropertySale(card: EtpgpbCard): boolean {
  return card.kind === "sale" || /продаж|аренд/i.test(`${card.platform} ${card.sectionDescription}`);
}

/**
 * «23.10.2026 03:00» (московское время) → момент в мс; нечитаемое — null.
 * Дата без времени считается началом суток по Москве.
 */
export function parseMoscowDateTime(text: string | null): number | null {
  if (text === null) return null;
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[\sT]+(\d{1,2}):(\d{2}))?/.exec(text.trim());
  if (match === null) return null;
  const [day, month, year, hour, minute] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute) - MSK_OFFSET_MS;
  // 31.02 не бывает: Date.UTC молча переносит такую дату на март, а срок не угадывают.
  const check = new Date(ms + MSK_OFFSET_MS);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) return null;
  return ms;
}

function isoMs(text: string | null): number | null {
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

function earliest(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/**
 * Срок приёма заявок, мс: поле процедуры (московское время), иначе самая ранняя дата
 * окончания приёма среди лотов, иначе самый ранний срок ответа лота (`etp_click`).
 */
export function etpgpbDeadlineMs(card: EtpgpbCard): number | null {
  return (
    parseMoscowDateTime(card.applicationEnd) ??
    earliest(card.lots.map((lot) => isoMs(lot.dateEndRegistration))) ??
    earliest(card.lots.map((lot) => isoMs(lot.responseDate)))
  );
}

/** Цена закупки: `amount`, если он положителен; иначе сумма цен лотов, когда она есть у всех. */
function etpgpbPrice(card: EtpgpbCard): number {
  if (card.amount !== null && card.amount > 0) return card.amount;
  if (card.lots.length === 0) return 0;
  const prices = card.lots.map((lot) => lot.startPrice);
  // Цена только у части лотов — сумма заняла бы цену закупки и прошла бы лимит профиля.
  if (prices.some((price) => price === null || price <= 0)) return 0;
  return prices.reduce((sum: number, price) => sum + (price ?? 0), 0);
}

/** Способ закупки: признаки площадки, потом ключевые слова названия способа, иначе `OTHER`. */
export function etpgpbPlacingWay(card: EtpgpbCard): PlacingWay {
  const name = card.procedureTypeName.toLowerCase().replace(/ё/g, "е");
  if (/единственн/.test(name)) return "SOLE_SUPPLIER";
  if (card.flags.auction || /аукцион/.test(name)) return "ELECTRONIC_AUCTION";
  if (card.flags.competition || /конкурс|конкурентн/.test(name)) return "OPEN_CONTEST";
  if (card.flags.requestQuotes || /котиров|ценов(ой|ая) запрос|запрос цен/.test(name)) {
    return "REQUEST_FOR_QUOTATION";
  }
  if (card.flags.requestOffers || /предложени|оферт/.test(name)) return "REQUEST_FOR_PROPOSALS";
  return "OTHER";
}

/** Заглушки в адресе поставки, которые адресом не являются. */
const ADDRESS_FILLERS = [
  "согласно закупочной документации",
  "согласно условиям контракта",
  "любой закрытый",
  "не указано",
];

/** «Согласно технического задания.», «В соответствии с ТЗ» — тоже заглушки, в любом падеже. */
// Не `\b`: в JavaScript граница слова видит только латиницу, и после «согласно» её нет.
const ADDRESS_FILLER_PREFIX = /^(согласно|в соответствии)(?=\s|$)/i;

/** Адрес поставки без заглушек и лишних запятых: «, Любой закрытый» → «». */
function cleanAddress(raw: string): string {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part !== "" &&
        !ADDRESS_FILLERS.includes(part.toLowerCase()) &&
        !ADDRESS_FILLER_PREFIX.test(part),
    )
    .join(", ");
}

/**
 * Адрес, в котором нет ничего, кроме названия субъекта или города: «Санкт-Петербург».
 *
 * У ЭТП ГПБ это чаще всего город организатора, а не место работ. Живая выдача 19.10.2026:
 * 44 из 121 открытой процедуры получили Санкт-Петербург, хотя это капремонты переходов
 * для «Газпром трансгаз Самара», «…Краснодар», «…Екатеринбург»: подрядчик ГСП из
 * Петербурга ставит свой город в место поставки лота, а `lot_regions` у той же карточки
 * — «Москва». Такой адрес слабее названия закупки, где место работ названо прямо.
 * Подробный адрес (индекс, улица, «Иркутская область, г. Братск, ул. Мира») остаётся
 * самым сильным признаком.
 */
function isBareRegionAddress(address: string): boolean {
  const parts = address.split(",").map((part) => part.trim()).filter((part) => part !== "");
  return (
    parts.length > 0 &&
    parts.every(
      (part) =>
        !/\d/.test(part) &&
        part.split(/\s+/).length <= 3 &&
        regionFromAddress(part) !== UNKNOWN_REGION,
    )
  );
}

/** Шестизначные индексы из адреса. */
function postcodes(address: string | null | undefined): string[] {
  return (address ?? "").match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
}

/**
 * Адрес поставки, который почти наверняка не место работ: голый город (см.
 * isBareRegionAddress) или адрес офиса заказчика/организатора — тот же индекс. Живая
 * карточка 19.10.2026: «Газпром сеть АЗС» ставит в место поставки свой офис на Большом
 * Сампсониевском, а работы — на АЗС Белгородской области, что сказано в названии.
 */
function isWeakDeliveryAddress(address: string, officeAddresses: readonly (string | null | undefined)[]): boolean {
  if (isBareRegionAddress(address)) return true;
  const own = postcodes(address);
  if (own.length === 0) return false;
  const offices = new Set(officeAddresses.flatMap(postcodes));
  return own.some((code) => offices.has(code));
}

/**
 * Дочерние общества «Газпрома», чьё название не содержит ни субъекта, ни города из
 * словаря регионов, — а на ЭТП ГПБ «для нужд ООО «Газпром трансгаз Чайковский»» в
 * названии бывает единственным указанием на место работ. Остальные дочки («…Самара»,
 * «…Краснодар», «…Уфа») словарь регионов узнаёт сам.
 */
const GAZPROM_SUBSIDIARY_REGIONS: readonly (readonly [RegExp, string])[] = [
  [/трансгаз\s+чайковский/i, "Пермский край"],
  [/трансгаз\s+сургут/i, "Ханты-Мансийский автономный округ — Югра"],
  [/трансгаз\s+югорск/i, "Ханты-Мансийский автономный округ — Югра"],
  [/трансгаз\s+ухта/i, "Республика Коми"],
  [/трансгаз\s+пятигорск/i, "Ставропольский край"],
  [/добыча\s+(надым|ямбург|уренгой|ноябрьск)/i, "Ямало-Ненецкий автономный округ"],
  [/добыча\s+кузнецк/i, "Кемеровская область — Кузбасс"],
  [/ковыктинск/i, "Иркутская область"],
  [/амурск(ий|ого)\s+(гпз|газоперерабатывающ)/i, "Амурская область"],
];

function gazpromSubsidiaryRegion(text: string): string | null {
  const normalized = text.replace(/ё/gi, "е").replace(/["«»]/g, " ");
  for (const [pattern, region] of GAZPROM_SUBSIDIARY_REGIONS) {
    if (pattern.test(normalized)) return region;
  }
  return null;
}

function companyName(company: EtpgpbCompany): string {
  return company.fullName || company.name || company.shortName;
}

/** Заказчик: первый заказчик лота, иначе организатор, иначе заглушка. */
function pickCustomer(card: EtpgpbCard): { name: string; inn: string | null; address: string } {
  const company = card.customers[0] ?? card.organizer;
  if (company === null || company === undefined) {
    return { name: UNKNOWN_CUSTOMER, inn: null, address: "" };
  }
  return { name: companyName(company) || UNKNOWN_CUSTOMER, inn: company.inn, address: company.address };
}

/** Субъект назван в названии прямо — «…области», «…края», «автономного округа», «Республики …». */
const EXPLICIT_SUBJECT_IN_TITLE = /област|кра[йяею]\b|кра[йяею]$|округ|республик/i;

/**
 * `lot_regions`, который просто повторяет регион офиса заказчика, — значение по
 * умолчанию, а не место работ, если название прямо называет другой субъект. Живая
 * карточка 19.10.2026: «Ремонт… ТРК на АЗС, расположенных в Белгородской области»,
 * заказчик «Газпром сеть АЗС» из Петербурга, адреса поставки нет, `lot_regions` —
 * «Санкт-Петербург». Прямое «…области/края» требуется нарочно: «для нужд ООО
 * „ГПН-Заполярье“» словарь читает как Мурманскую область, а там `lot_regions` = Омская
 * область (склад заказчика в Омске) верен.
 */
function lotRegionIsOfficeDefault(
  lotRegions: readonly string[],
  offices: readonly string[],
  titles: readonly (string | null | undefined)[],
): boolean {
  const lotRegion = regionFromAddresses(lotRegions);
  if (lotRegion === UNKNOWN_REGION || lotRegion !== regionFromAddresses(offices)) return false;
  return titles.some((title) => {
    if (!title || !EXPLICIT_SUBJECT_IN_TITLE.test(title)) return false;
    const region = regionFromAddress(title);
    return region !== UNKNOWN_REGION && region !== lotRegion;
  });
}

/** Адреса офисов заказчика и организатора — с ними сравнивается адрес поставки. */
function officeAddresses(card: EtpgpbCard, customer: { address: string }): string[] {
  return [
    customer.address,
    card.customerAddress,
    card.organizer?.address ?? "",
    ...card.customers.map((company) => company.address),
  ].filter((address) => address !== "");
}

/**
 * Регион процедуры. Подробный адрес поставки сильнее всего. Дальше порядок зависит от
 * того, стоит ли в месте поставки голый город или адрес офиса (см. isWeakDeliveryAddress):
 * - стоит — это город или офис организатора, и `lot_regions` у таких карточек тоже врёт
 *   («Москва» у ремонта в Самаре), поэтому раньше идут название и предметы лотов (и
 *   дочки «Газпрома» в них);
 * - не стоит — раньше идут `lot_regions`: название бывает обманчиво («для нужд ООО
 *   „ГПН-Заполярье“» словарь читает как Мурманскую область, а товар забирают со склада в
 *   Омске, и `lot_regions` = Омская область верен).
 * Потом регион карточки и адреса заказчика и организатора.
 */
function etpgpbRegion(card: EtpgpbCard, customer: { address: string }): string {
  const deliveries = card.lots.map((lot) => cleanAddress(lot.deliveryAddress)).filter((a) => a !== "");
  const titles = [card.title, ...card.lots.map((lot) => lot.subject)];
  const fromTitle = regionFromAddresses(titles);
  if (fromTitle === UNKNOWN_REGION) {
    for (const title of titles) {
      const subsidiary = title ? gazpromSubsidiaryRegion(title) : null;
      if (subsidiary !== null) {
        titles.push(subsidiary);
        break;
      }
    }
  }
  const offices = officeAddresses(card, customer);
  const bare = deliveries.filter((address) => isWeakDeliveryAddress(address, offices));
  const lotRegions = [...card.lotRegions, ...card.lots.map((lot) => lot.region)];
  const titleFirst = bare.length > 0 || lotRegionIsOfficeDefault(lotRegions, offices, titles);
  return regionFromAddresses([
    ...deliveries.filter((address) => !isWeakDeliveryAddress(address, offices)),
    // При голом городе в месте поставки `lot_regions` ещё ненадёжнее его: у ремонта на
    // ТЭЦ-21 «ТГК-1» (Петербург) в месте поставки «Санкт-Петербург», а `lot_regions` —
    // «Москва», как и у ремонта в Самаре. Город из места поставки идёт раньше.
    ...(bare.length > 0
      ? [...titles, ...bare, ...lotRegions]
      : titleFirst
        ? [...titles, ...lotRegions]
        : [...lotRegions, ...titles]),
    ...bare,
    ...card.regionNames,
    card.region,
    ...card.regions,
    card.customerAddress,
    customer.address,
    card.organizer?.address,
  ]);
}

function mapLot(lot: EtpgpbLot, index: number, card: EtpgpbCard, tenderRegion: string): TenderLot {
  const number = lot.number ?? index + 1;
  const delivery = cleanAddress(lot.deliveryAddress);
  // Голый адрес («Санкт-Петербург») — город организатора чаще, чем место работ, поэтому
  // лот с ним наследует регион процедуры, если в его предмете места нет.
  const resolved = isWeakDeliveryAddress(delivery, officeAddresses(card, pickCustomer(card)))
    ? regionFromAddresses([lot.title, lot.subject])
    : regionFromAddresses([delivery, lot.region, lot.title, lot.subject]);
  const region = resolved === tenderRegion || resolved === UNKNOWN_REGION ? tenderRegion : resolved;
  // Пустой предмет лота названием процедуры заменяется только у единственного лота:
  // у многолотовой закупки это выдало бы одинаковые предметы там, где площадка их
  // не опубликовала.
  const subject = lot.subject || lot.title || (card.lots.length === 1 ? card.title : "");
  return {
    id: lot.id !== "" ? lot.id : `${card.platformId}-${number}`,
    number,
    subject,
    price: lot.startPrice !== null && lot.startPrice > 0 ? lot.startPrice : 0,
    okpd2Codes: [],
    deliveryRegion: region,
    deliveryAddress: delivery !== "" ? delivery : region,
    deliveryTermDays: null,
  };
}

function iso(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toISOString();
}

/**
 * Карточка → `Tender`.
 *
 * null — это не закупка поставщика: продажа имущества, карточка без названия или без
 * номера. Записать такую строку значило бы показать владельцу пустую закупку.
 */
export function mapEtpgpbCard(card: EtpgpbCard, options: EtpgpbMappingOptions = {}): Tender | null {
  if (etpgpbIsPropertySale(card)) return null;
  if (card.title === "") return null;
  if (card.registryNumber === "" && card.platformId === "") return null;

  const customer = pickCustomer(card);
  const region = etpgpbRegion(card, customer);
  const deadline = etpgpbDeadlineMs(card);
  const published = isoMs(card.datePublished);
  const updated = isoMs(card.dateLastUpdate);

  const fromPath = `${ETPGPB_ORIGIN}${card.path}`;
  const link = card.path !== "" && isEtpgpbUrlAllowed(fromPath) ? fromPath : (options.cardUrl ?? "");

  const lotDelivery = card.lots.map((lot) => cleanAddress(lot.deliveryAddress)).find((a) => a !== "");

  return {
    id: `etpgpb-${card.kind}-${card.platformId}`,
    regNumber: etpgpbRegNumber(card),
    externalId: card.registryNumber === "" ? null : card.registryNumber,
    law: etpgpbLaw(card),
    placingWay: etpgpbPlacingWay(card),
    // Название бывает с переводом строки («…\n(совместный аукцион)») и пробелом в начале.
    subject: card.title.replace(/\s+/g, " ").trim(),
    customerName: customer.name,
    customerInn: customer.inn,
    region,
    deliveryAddress: lotDelivery ?? (card.customerAddress || region),
    financial: {
      price: etpgpbPrice(card),
      currency: card.currency || card.lots.find((lot) => lot.currency !== "")?.currency || "RUB",
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
      submissionEnd: iso(deadline),
      publicationDate: iso(published),
      lastUpdateDate: iso(updated ?? published),
      deliveryTermDays: null,
      warrantyMonths: null,
    },
    okpd2Codes: [...card.okpds],
    lots: card.lots.map((lot, index) => mapLot(lot, index, card, region)),
    requirements: [],
    // Файлы лежат на `etp.gpb.ru` и `com.etpgpb.ru`, где `robots.txt` запрещает всё:
    // `fetchDocuments` возвращает пустой список, причина — в каталоге источников.
    documents: [],
    nationalRegime: card.flags.nationalMode || card.lots.some((lot) => lot.nationalMode),
    onlyForSmp: card.flags.smsp,
    eisUrl: link,
    dataSource: "ETP_GPB",
    changeLog: [],
    syncedAt: options.syncStartedAt ?? null,
  };
}
