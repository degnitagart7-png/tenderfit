/**
 * Маппер Фабриканта: страницы одной карточки → доменный `Tender`.
 *
 * На входе — не строки выдачи, а разобранные страницы карточки. Выдача
 * Фабриканта несёт только номер процедуры, предмет лота и адрес: ни цены, ни
 * срока, ни заказчика в ней нет (см. `fabrikantSearch.ts`). Поэтому одна
 * процедура собирается из одной или нескольких страниц `/v2/trades/procedure/
 * view/{id}` — карточка печатает по 5 лотов на страницу, и у процедуры с 18
 * лотами их четыре.
 *
 * Четыре решения, которые модуль принимает осознанно:
 *
 * 1. **Закон определяется по трём признакам сразу, а не по одному.** Номер
 *    извещения ЕИС важнее всего: 19 знаков — 44-ФЗ, 11 с ведущей тройкой —
 *    223-ФЗ. Дальше машинное слово секции (`commercial`, `223fz`, `rosatom`),
 *    и только потом название секции из панели карточки. Третий признак не
 *    запасной ради красоты: живой замер 02.10.2026 в секции «Закупки по
 *    223-ФЗ» дал 17 строк из 40 со словом `"$undefined"` — так RSC кодирует
 *    JS-undefined, и закона в такой строке нет вовсе.
 *
 * 2. **Цена публикуется только тогда, когда она осмысленна.** Нуль в домене
 *    значит «цена не опубликована» (`isPriceKnown`), а не бесплатную закупку.
 *    Четыре причины не публиковать: набор лотов неполный, хотя бы у одного
 *    лота цены нет, лоты в разных валютах, валюта незнакомая. Последнее —
 *    отдельная ловушка: `isRub("")` в `priceVisibility.ts` считает пустую
 *    строку рублём, поэтому сумма в «условных единицах», оставленная как есть,
 *    уехала бы в ленту подписанной рублями и прошла бы диапазон профиля.
 *
 * 3. **Обеспечения берутся максимальные среди лотов.** В домене одно поле на
 *    процедуру, а лоты бывают с разными обеспечениями. Первое попавшееся
 *    занизило бы обязательство: владелец решил бы, что на заявку хватит 10
 *    тысяч, когда второй лот требует 90.
 *
 * 4. **Личных данных здесь нет и появиться не может.** Парсер карточки
 *    вырезает «Контактное лицо» и «Телефон» из дерева до чтения текста, а
 *    маппер берёт из панели организатора только наименование, почтовый адрес и
 *    ИНН — три поля, а не весь её текст. Сырые панели в `Tender` не кладутся
 *    нигде.
 */
import type { PlacingWay, TenderLaw } from "@/domain/enums";
import type { Tender, TenderLot } from "@/domain/entities";
import { UNKNOWN_CUSTOMER, isRegionKnown } from "@/domain/entities";
import { regionFromAddress, regionFromAddresses } from "@/domain/regions";
import type { FabrikantCard, FabrikantCardLot } from "./fabrikantCard";
import { fabrikantDateTime } from "./fabrikantCard";
import type { FabrikantLotRow } from "./fabrikantSearch";

/**
 * Способы размещения Фабриканта: название процедуры из панели
 * `purchase_category_custom` → способ из домена.
 *
 * Ключи — названия, снятые с живых карточек 02.10.2026, после `normalizeTitle`,
 * поэтому регистр, «ё» и лишние пробелы роли не играют. В словарь положены и те
 * названия, которых в замере не было: площадки правят формулировки, и разница
 * между «не угадали» и «упали» здесь ровно одна строка.
 *
 * «Мониторинг цен», «Запрос о предоставлении ценовой информации» и «Маркет»
 * лежат в `OTHER` не потому, что мы их отбрасываем — в выдачу они попадают, у
 * них настоящий срок приёма заявок, — а потому, что положить их в «Запрос
 * котировок» значило бы засорить фильтр котировок процедурами, где нечего
 * выигрывать.
 */
export const FABRIKANT_PLACING_WAYS: Readonly<Record<string, PlacingWay>> = {
  "запрос предложений": "REQUEST_FOR_PROPOSALS",
  "запрос предложений мсп": "REQUEST_FOR_PROPOSALS",
  "запрос оферт": "REQUEST_FOR_PROPOSALS",
  "запрос котировок": "REQUEST_FOR_QUOTATION",
  "запрос котировок мсп": "REQUEST_FOR_QUOTATION",
  "запрос котировок 223-фз": "REQUEST_FOR_QUOTATION",
  "запрос цен": "REQUEST_FOR_QUOTATION",
  "запрос цен мсп": "REQUEST_FOR_QUOTATION",
  "конкурс": "OPEN_CONTEST",
  "открытый конкурс": "OPEN_CONTEST",
  "конкурс мсп": "OPEN_CONTEST",
  "конкурс (заявка в 2х частях)": "OPEN_CONTEST",
  "конкурс в электронной форме": "OPEN_CONTEST",
  "конкурс в электронной форме, участниками которого могут являться только субъекты малого и среднего предпринимательства":
    "OPEN_CONTEST",
  "аукцион": "ELECTRONIC_AUCTION",
  "аукцион мсп": "ELECTRONIC_AUCTION",
  "электронный аукцион": "ELECTRONIC_AUCTION",
  "аукцион в электронной форме": "ELECTRONIC_AUCTION",
  "мониторинг цен": "OTHER",
  "запрос о предоставлении ценовой информации": "OTHER",
  "маркет": "OTHER",
  "не указано": "OTHER",
};

/**
 * Запасной классификатор по ключевому слову.
 *
 * Порядок имеет значение: «Запрос о предоставлении ценовой информации»
 * содержит «цен», но до правила про «запрос цен» не доходит — оно требует всей
 * фразы целиком.
 */
const PLACING_WAY_KEYWORDS: readonly [pattern: RegExp, way: PlacingWay][] = [
  [/аукцион/, "ELECTRONIC_AUCTION"],
  [/конкурс/, "OPEN_CONTEST"],
  [/котиров/, "REQUEST_FOR_QUOTATION"],
  [/запрос цен/, "REQUEST_FOR_QUOTATION"],
  [/предложени|оферт/, "REQUEST_FOR_PROPOSALS"],
];

/**
 * Машинное слово секции → закон.
 *
 * Слово приходит из RSC-объекта карточки выдачи. Значения сняты замером
 * 02.10.2026 по восьми секциям из набора по умолчанию: `commercial` у
 * коммерческих и корпоративных секций, `223fz` у закупок по 223-ФЗ, `rosatom`
 * у секции Росатома (его закупки живут в 223-ФЗ). Секция Росатома не вынесена
 * в отдельный закон потому, что отдельного закона нет.
 */
const SECTION_LAWS: Readonly<Record<string, TenderLaw>> = {
  "44fz": "FZ_44",
  "223fz": "FZ_223",
  "rosatom": "FZ_223",
  "commercial": "COMMERCIAL",
};

/** Панель с общим наименованием закупки. */
const COMMON_NAME_PANEL = "procedure_common_name";

/** Панель с названием секции на площадке. */
const PURCHASE_SECTION_PANEL = "purchase_section";

/** Панель с названием процедуры на ЭТП — из неё берётся способ размещения. */
const CATEGORY_PANEL = "purchase_category_custom";

/** Панель с датой публикации. */
const PUBLICATION_PANEL = "date_publication";

/** Панель с признаком установленного преимущества. */
const NATIONAL_PRIVILEGE_PANEL = "national_privilege_enabled";

/** Формулировка названия процедуры, которая означает закупку только для МСП. */
const SMP_ONLY_TITLE = "только субъекты малого и среднего предпринимательства";

/**
 * Аббревиатура «МСП» как отдельное слово.
 *
 * Границы свои, а не `\b`: в JS `\w` — это только латиница, цифры и
 * подчёркивание, поэтому `\bмсп\b` на кириллице не сработал бы никогда.
 */
const SMP_ABBREVIATION = /(^|[^а-яё0-9])мсп([^а-яё0-9]|$)/;

/** Признаки закона, которые видит маппер. */
export interface FabrikantLawEvidence {
  /** Номер извещения в ЕИС; null — закупка живёт только на площадке. */
  readonly eisNumber?: string | null;
  /** Машинное слово секции из строки выдачи. */
  readonly sectionEnum?: string | null;
  /** Название секции из панели карточки. */
  readonly purchaseSection?: string | null;
}

/**
 * Закон закупки.
 *
 * Порядок: форма номера ЕИС → машинное слово секции → название секции в
 * карточке → коммерческая закупка. Коммерческая — не «догадка по умолчанию», а
 * утверждение площадки: секции, которые мы обходим, кроме 44-ФЗ и 223-ФЗ,
 * содержат коммерческие процедуры, и у закупки без номера в ЕИС другого закона
 * просто нет.
 *
 * Нечитаемый номер ЕИС законом не считается: «12345» не похож ни на извещение
 * 44-ФЗ, ни на 223-ФЗ, и вывести из него что-либо значило бы придумать факт.
 */
export function fabrikantLaw(evidence: FabrikantLawEvidence): TenderLaw {
  const byNumber = lawFromEisNumber(evidence.eisNumber ?? null);
  if (byNumber !== null) return byNumber;

  const bySection = SECTION_LAWS[normalizeTitle(evidence.sectionEnum ?? "")];
  if (bySection !== undefined) return bySection;

  const printed = normalizeTitle(evidence.purchaseSection ?? "");
  if (printed.includes("615") || printed.includes("капитальн")) return "PP_RF_615";
  if (printed.includes("44-фз") || printed.includes("44 фз")) return "FZ_44";
  if (printed.includes("223-фз") || printed.includes("223 фз")) return "FZ_223";
  return "COMMERCIAL";
}

/**
 * Закон по одной строке выдачи — или `null`, когда строка его не называет.
 *
 * Отдельная от `fabrikantLaw` функция нужна адаптеру: закон часто виден до
 * запроса карточки, и платить запросом за извещение 44-ФЗ, которое профиль всё
 * равно отбросит, незачем.
 *
 * `null` здесь значит «не решай по строке, спроси карточку», а не «коммерческая
 * закупка». Различать эти два ответа обязательно: живой замер 02.10.2026 дал 17
 * строк из 40 в секции 223-ФЗ, где RSC присылает `"$undefined"` вместо слова
 * секции. Считать такую строку коммерческой значило бы отбросить закупку 223-ФЗ
 * до того, как мы её увидели, — молча и без следа в журнале.
 */
export function fabrikantLawFromRow(row: FabrikantLotRow): TenderLaw | null {
  const byNumber = lawFromEisNumber(row.eisNumber);
  if (byNumber !== null) return byNumber;
  return SECTION_LAWS[normalizeTitle(row.sectionEnum)] ?? null;
}

/** Форма извещения 44-ФЗ: 19 цифр. */
const EIS_44_NUMBER = /^\d{19}$/;

/** Форма номера 223-ФЗ в ЕИС: 11 цифр, первая — 3. */
const EIS_223_NUMBER = /^3\d{10}$/;

/** Закон по форме номера ЕИС; `null` — номер не похож ни на один из двух. */
function lawFromEisNumber(eisNumber: string | null): TenderLaw | null {
  const number = (eisNumber ?? "").trim();
  if (EIS_44_NUMBER.test(number)) return "FZ_44";
  if (EIS_223_NUMBER.test(number)) return "FZ_223";
  return null;
}

/**
 * Ключ записи в базе.
 *
 * Номер извещения ЕИС остаётся собой: такую закупку принесёт и адаптер
 * реестра, и двух строк об одном предмете в базе быть не должно — чья версия
 * останется, решает приоритет источника в `src/domain/sources.ts`. Номер
 * площадки получает префикс `FABRIKANT-`, потому что в реестре его нет, а голый
 * `5582388` мог бы столкнуться с номером другой площадки.
 */
export function fabrikantRegNumber(procedureNumber: string, eisNumber: string | null): string {
  const published = (eisNumber ?? "").trim();
  if (published !== "") return published;
  const number = procedureNumber.trim();
  return number === "" ? "" : `FABRIKANT-${number}`;
}

/** Способ размещения: сначала словарь, потом ключевое слово, потом `OTHER`. */
export function fabrikantPlacingWay(title: string): PlacingWay {
  const normalized = normalizeTitle(title);
  const known = FABRIKANT_PLACING_WAYS[normalized];
  if (known !== undefined) return known;
  for (const [pattern, way] of PLACING_WAY_KEYWORDS) {
    if (pattern.test(normalized)) return way;
  }
  return "OTHER";
}

/** То, что о процедуре знает вызывающий, но не знает карточка. */
export interface FabrikantProcedureContext {
  /**
   * Строка выдачи, которая привела к этой карточке.
   *
   * Из неё берутся два факта, которых в карточке может не оказаться: адрес
   * процедуры и номер извещения ЕИС как запасной. Предмет лота из выдачи
   * используется только когда общего наименования закупки в карточке нет.
   */
  readonly row?: FabrikantLotRow | null;
  /**
   * Все ли лоты процедуры получены.
   *
   * Решает адаптер, а не маппер: только он знает, сколько страниц запрошено и
   * не упёрся ли обход в потолок бюджета. Неполный набор лотов — причина не
   * публиковать цену.
   */
  readonly lotsComplete: boolean;
  /** Метка партии синхронизации (`tenders.synced_at`). */
  readonly syncStartedAt?: string | null;
}

/**
 * Одна процедура Фабриканта в доменный объект `Tender`.
 *
 * Возвращает null в трёх случаях, и каждый из них — не закупка, а не «закупка с
 * пустыми полями»: страниц нет вовсе, разметка не узнана (антибот, заглушка,
 * незнакомый шаблон), лотов на всех страницах ноль. Записать такую строку в базу
 * значило бы показать владельцу закупку без предмета и без цены.
 */
export function mapFabrikantProcedure(
  procedureNumber: string,
  cards: readonly FabrikantCard[],
  context: FabrikantProcedureContext,
): Tender | null {
  if (cards.length === 0) return null;
  if (!cards.some((card) => card.layoutRecognized)) return null;

  const panels = mergePanels(cards);
  const lots = mergeLots(cards);
  if (lots.length === 0) return null;

  const organizer = cards.find((card) => card.organizer !== null)?.organizer ?? null;
  const row = context.row ?? null;
  const number = procedureNumber.trim();

  const eisNumber = firstFilled(cards.map((card) => card.eisNumber)) ?? row?.eisNumber ?? null;
  const category = panels[CATEGORY_PANEL] ?? "";

  const region = regionFromAddresses([
    ...lots.map((lot) => lot.deliveryRegion),
    organizer?.postalAddress ?? "",
  ]);

  return {
    id: `fabrikant-${number}`,
    regNumber: fabrikantRegNumber(number, eisNumber),
    externalId: number === "" ? null : number,
    law: fabrikantLaw({
      eisNumber,
      sectionEnum: row?.sectionEnum ?? "",
      purchaseSection: panels[PURCHASE_SECTION_PANEL] ?? "",
    }),
    placingWay: fabrikantPlacingWay(category),
    subject: procedureSubject(panels, row, number, lots),
    // Площадка печатает организатора процедуры. У корпоративных секций это
    // обычно и есть заказчик, но подменять понятия нельзя — поле так и называется.
    customerName: organizer?.name.trim() || UNKNOWN_CUSTOMER,
    customerInn: organizer?.inn ?? null,
    region,
    // Места поставки у процедуры как целого нет: оно есть у каждого лота, и на
    // уровень закупки поднимается адрес первого названного.
    deliveryAddress: firstFilled(lots.map((lot) => lot.deliveryAddress)) ?? region,
    financial: {
      price: procedurePrice(lots, context.lotsComplete),
      // Валюта первого лота, а не рубль по умолчанию: пустая строка значит
      // «площадка валюту не назвала», и домен прочитает её как рубли.
      currency: lots[0]?.currency ?? "",
      advancePercent: null,
      advanceAmount: null,
      paymentTermDays: 0,
      postpaymentDays: null,
      bidSecurityAmount: maxOf(lots.map((lot) => lot.bidSecurityAmount)),
      bidSecurityPercent: null,
      contractSecurityAmount: maxOf(lots.map((lot) => lot.contractSecurityAmount)),
      contractSecurityPercent: maxOf(lots.map((lot) => lot.contractSecurityPercent)),
      treasurySupport: false,
      expectedMarginPercent: null,
    },
    deadlines: {
      submissionEnd: earliestDeadline(lots),
      // Значение панели приходит вперемешку с кнопками истории изменений
      // («01.10.2026 16:32 Действия История изменений Закрыть Продолжить»),
      // поэтому дату из него достаёт `fabrikantDateTime`, а не обрезка.
      publicationDate: fabrikantDateTime(panels[PUBLICATION_PANEL] ?? ""),
      // Даты последнего изменения карточка не печатает; пустая строка
      // форматируется прочерком.
      lastUpdateDate: "",
      deliveryTermDays: null,
      warrantyMonths: null,
    },
    okpd2Codes: unionOfCodes(lots),
    lots: lots.map((lot, index) => mapFabrikantLot(lot, index, number, region)),
    requirements: [],
    // Документы площадки лежат на `storage.fabrikant.ru`, где robots запрещает
    // всё: пустой список и причина в каталоге источников.
    documents: [],
    nationalRegime: nationalRegimeOf(panels[NATIONAL_PRIVILEGE_PANEL] ?? ""),
    onlyForSmp:
      lots.some((lot) => lot.onlyForSmp) || smpOnlyTitle(normalizeTitle(category)),
    eisUrl: row?.cardUrl.trim() ?? "",
    dataSource: "FABRIKANT",
    changeLog: [],
    syncedAt: context.syncStartedAt ?? null,
  };
}

/** Один лот карточки в доменный лот. */
function mapFabrikantLot(
  lot: FabrikantCardLot,
  index: number,
  procedureNumber: string,
  tenderRegion: string,
): TenderLot {
  // Номер берётся из заголовка «Лот №N», а не из порядка на странице: страницы
  // карточки нумеруют лоты сквозной нумерацией площадки, и порядковый номер
  // внутри одной страницы совпал бы с настоящим только случайно.
  const lotNumber = lot.number ?? index + 1;
  const resolved = regionFromAddress(lot.deliveryRegion);
  const deliveryRegion = isRegionKnown(resolved) ? resolved : tenderRegion;
  return {
    id: `${procedureNumber}-${lotNumber}`,
    number: lotNumber,
    subject: lot.subject,
    price: lot.price ?? 0,
    // `TenderLot.okpd2Codes` изменяемый, а у парсера — `readonly`: копия, а не
    // ссылка, иначе вызывающий код мог бы править разобранный лот.
    okpd2Codes: [...lot.okpd2Codes],
    deliveryRegion,
    deliveryAddress: lot.deliveryAddress.trim() === "" ? deliveryRegion : lot.deliveryAddress.trim(),
    deliveryTermDays: null,
  };
}

/**
 * Цена закупки — сумма цен лотов, и только когда сумма осмысленна.
 *
 * Нуль значит «цена не опубликована», и лента показывает её с пометкой, а не
 * как бесплатную закупку.
 */
function procedurePrice(lots: readonly FabrikantCardLot[], complete: boolean): number {
  if (!complete || lots.length === 0) return 0;
  if (lots.some((lot) => lot.price === null)) return 0;
  if (new Set(lots.map((lot) => lot.currency)).size > 1) return 0;
  if (lots.some((lot) => lot.currency === "")) return 0;
  return lots.reduce((sum, lot) => sum + (lot.price ?? 0), 0);
}

/**
 * Предмет закупки.
 *
 * Порядок: общее наименование из карточки → предмет совпавшего лота выдачи →
 * предмет первого лота. Общее наименование важнее потому, что в процедуре с
 * восемнадцатью лотами предмет одного лота не объясняет, что закупается.
 *
 * Строка выдачи используется только когда её номер процедуры совпал с
 * разбираемым: выдача группировалась по номеру, и чужой предмет попал бы в
 * карточку молча.
 */
function procedureSubject(
  panels: Readonly<Record<string, string>>,
  row: FabrikantLotRow | null,
  procedureNumber: string,
  lots: readonly FabrikantCardLot[],
): string {
  const common = (panels[COMMON_NAME_PANEL] ?? "").trim();
  if (common !== "") return common;
  if (row !== null && (procedureNumber === "" || row.procedureNumber.trim() === procedureNumber)) {
    const fromRow = row.subject.trim();
    if (fromRow !== "") return fromRow;
  }
  return lots[0]?.subject ?? "";
}

/** Признак МСП виден и в названии процедуры, а не только в панели лота. */
function smpOnlyTitle(normalizedCategory: string): boolean {
  if (normalizedCategory === "") return false;
  return (
    normalizedCategory.includes(SMP_ONLY_TITLE) || SMP_ABBREVIATION.test(normalizedCategory)
  );
}

/**
 * Национальный режим: преимущество установлено.
 *
 * «Не установлено» проверяется первым — оно содержит «установлено», и обратный
 * порядок дал бы признак ровно наоборот.
 */
function nationalRegimeOf(value: string): boolean {
  const normalized = normalizeTitle(value);
  if (normalized === "") return false;
  if (normalized.includes("не установлено") || normalized.includes("не устанавливается")) {
    return false;
  }
  return normalized.includes("установлено") || normalized.includes("устанавливается");
}

/**
 * Панели всех страниц в один словарь: первое непустое значение по каждому ключу.
 *
 * Страницы карточки различаются: процедурные панели площадка печатает на
 * каждой, но намеренно держаться этого нельзя — живой замер дал 30, 29 и 23
 * панели из 30 ожидаемых на трёх разных процедурах.
 */
function mergePanels(cards: readonly FabrikantCard[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const card of cards) {
    for (const [key, value] of Object.entries(card.panels)) {
      const existing = merged[key];
      if (existing === undefined || existing === "") merged[key] = value;
    }
  }
  return merged;
}

/**
 * Лоты всех страниц одним списком, по возрастанию номера.
 *
 * Повтор номера отбрасывается: если площадка на второй странице вернула первую
 * (такое бывает на сбое пагинации), сумма удвоилась бы и опубликовалась как
 * настоящая цена. Лоты без прочитанного номера сохраняются все — отбрасывать их
 * значило бы потерять закупку из-за непонятного заголовка.
 */
function mergeLots(cards: readonly FabrikantCard[]): FabrikantCardLot[] {
  const merged: FabrikantCardLot[] = [];
  const seen = new Set<number>();
  for (const card of cards) {
    for (const lot of card.lots) {
      if (lot.number !== null) {
        if (seen.has(lot.number)) continue;
        seen.add(lot.number);
      }
      merged.push(lot);
    }
  }
  return merged.sort(
    (a, b) => (a.number ?? Number.POSITIVE_INFINITY) - (b.number ?? Number.POSITIVE_INFINITY),
  );
}

/** Коды ОКПД2 всех лотов без повторов, в порядке появления. */
function unionOfCodes(lots: readonly FabrikantCardLot[]): string[] {
  const codes: string[] = [];
  for (const lot of lots) {
    for (const code of lot.okpd2Codes) {
      if (!codes.includes(code)) codes.push(code);
    }
  }
  return codes;
}

/**
 * Самый ранний срок приёма заявок из всех лотов.
 *
 * У многолотовой процедуры сроки бывают разными, и владельцу важен тот, до
 * которого ещё можно успеть подать заявку, а не самый поздний из них.
 */
function earliestDeadline(lots: readonly FabrikantCardLot[]): string {
  let earliest = "";
  let earliestAt = Number.POSITIVE_INFINITY;
  for (const lot of lots) {
    const value = lot.submissionEnd;
    if (value === "") continue;
    const at = new Date(value).getTime();
    if (Number.isNaN(at)) continue;
    if (at < earliestAt) {
      earliestAt = at;
      earliest = value;
    }
  }
  return earliest;
}

/** Наибольшее из непустых значений; null, когда значения нет ни у одного лота. */
function maxOf(values: readonly (number | null)[]): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

/** Первое непустое значение. */
function firstFilled(values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/** Название к сравнению: нижний регистр, «ё» → «е», пробелы в один. */
function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}
