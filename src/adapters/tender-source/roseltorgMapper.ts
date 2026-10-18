import type { PlacingWay, TenderLaw } from "@/domain/enums";
import { UNKNOWN_CUSTOMER } from "@/domain/entities";
import type { Tender, TenderLot } from "@/domain/entities";
import { regionFromAddress } from "@/domain/regions";
import type { RoseltorgLotRow } from "@/adapters/tender-source/roseltorgSearch";

/**
 * Способы размещения Росэлторга: название из строки выдачи → способ из домена.
 *
 * Словарь снят с живой выдачи 02.10.2026 (60 строк, 15 различных названий).
 * Ключи сравниваются после `normalizeTitle`, поэтому регистр, «ё» и лишние
 * пробелы роли не играют.
 *
 * Названия у площадок свои, и часть из них описывает не способ заключения
 * договора, а сбор информации: «Мониторинг цен» и «Запрос о предоставлении
 * ценовой информации» лежат в `OTHER` не потому, что мы их отбрасываем (в выдачу
 * они попадают — у них есть настоящий срок приёма заявок), а потому, что
 * положить их в «Запрос котировок» значило бы засорить фильтр котировок
 * процедурами, где нечего выигрывать.
 */
export const ROSELTORG_PLACING_WAYS: Readonly<Record<string, PlacingWay>> = {
  "аукцион": "ELECTRONIC_AUCTION",
  "аукцион мсп": "ELECTRONIC_AUCTION",
  "электронный аукцион": "ELECTRONIC_AUCTION",
  "конкурс": "OPEN_CONTEST",
  "конкурс мсп": "OPEN_CONTEST",
  "открытый конкурс": "OPEN_CONTEST",
  "запрос котировок": "REQUEST_FOR_QUOTATION",
  "запрос котировок мсп": "REQUEST_FOR_QUOTATION",
  "электронный запрос котировок": "REQUEST_FOR_QUOTATION",
  "запрос цен": "REQUEST_FOR_QUOTATION",
  "запрос предложений": "REQUEST_FOR_PROPOSALS",
  "запрос предложений мсп": "REQUEST_FOR_PROPOSALS",
  "запрос оферт": "REQUEST_FOR_PROPOSALS",
  "мониторинг цен": "OTHER",
  "запрос о предоставлении ценовой информации": "OTHER",
  "сравнение цен в электронной форме": "OTHER",
  "процедура по закупке с выбором победителя": "OTHER",
  "процедура по закупке без выбора победителя": "OTHER",
  "закупка с полки (закупка в электронном магазине)": "OTHER",
};

/**
 * Запасной классификатор по ключевому слову.
 *
 * Порядок имеет значение: «Запрос о предоставлении ценовой информации» содержит
 * «цен», но до правила про «запрос цен» не доходит — оно требует всей фразы.
 * Проверено на всех 15 названиях живой выдачи.
 */
const PLACING_WAY_KEYWORDS: readonly [pattern: RegExp, way: PlacingWay][] = [
  [/аукцион/, "ELECTRONIC_AUCTION"],
  [/конкурс/, "OPEN_CONTEST"],
  [/котиров/, "REQUEST_FOR_QUOTATION"],
  [/запрос цен/, "REQUEST_FOR_QUOTATION"],
  [/предложени|оферт/, "REQUEST_FOR_PROPOSALS"],
];

/** Что мапперу нужно знать сверх самих строк. */
export interface RoseltorgMappingOptions {
  /**
   * Лоты, которые нашёл поиск по ключевому слову.
   *
   * Предмет закупки берётся из совпавшего лота, а не из первого по порядку: в
   * процедуре `B2509261618185` больше сотни лотов, и карточка, начинающаяся с
   * «Позиция каталога №1», не объяснила бы владельцу, почему закупка вообще в
   * выдаче по слову «насадка».
   */
  readonly matchedLots?: readonly RoseltorgLotRow[];
  /**
   * Номера процедур, у которых набор лотов получен не полностью.
   *
   * Цена такой закупки не публикуется (нуль = «не указана»): сумма части лотов
   * занижена, а заниженная цена прошла бы фильтр по лимиту профиля и показала бы
   * владельцу закупку-миллионник как мелкую.
   */
  readonly incompleteProcedures?: ReadonlySet<string>;
  /** Метка партии синхронизации (`tenders.synced_at`). */
  readonly syncStartedAt?: string | null;
}

/**
 * Строки выдачи в закупки: одна запись на процедуру, лоты склеены.
 *
 * Порядок процедур сохраняется по первому появлению в выдаче — площадка
 * сортирует список по сроку приёма заявок, и переставлять его значит потерять
 * это упорядочивание.
 */
export function mapRoseltorgRows(
  rows: readonly RoseltorgLotRow[],
  options: RoseltorgMappingOptions = {},
): Tender[] {
  const groups = new Map<string, RoseltorgLotRow[]>();
  for (const row of rows) {
    const number = row.procedureNumber.trim();
    if (number === "") continue;
    const group = groups.get(number);
    if (group) {
      group.push(row);
      continue;
    }
    groups.set(number, [row]);
  }

  const matched = new Map<string, string>();
  for (const lot of options.matchedLots ?? []) {
    const number = lot.procedureNumber.trim();
    if (number === "" || matched.has(number)) continue;
    matched.set(number, lot.subject);
  }

  const tenders: Tender[] = [];
  for (const [number, group] of groups) {
    tenders.push(
      mapRoseltorgProcedure(number, group, {
        subject: matched.get(number),
        lotsComplete: !(options.incompleteProcedures?.has(number) ?? false),
        syncStartedAt: options.syncStartedAt,
      }),
    );
  }
  return tenders;
}

/** Параметры одной процедуры, которые знает только вызывающий. */
interface ProcedureMappingContext {
  /** Предмет закупки, если он отличается от предмета первого лота. */
  readonly subject?: string;
  /** Все ли лоты процедуры получены. */
  readonly lotsComplete: boolean;
  readonly syncStartedAt?: string | null;
}

/** Одна процедура площадки в доменный объект Tender. */
export function mapRoseltorgProcedure(
  procedureNumber: string,
  rows: readonly RoseltorgLotRow[],
  context: ProcedureMappingContext,
): Tender {
  const lots = sortLots(rows);
  const first = lots[0];
  const region = regionFromAddress(first?.region ?? "");
  const placingWayTitle = first?.placingWayTitle ?? "";
  const customerName = firstFilled(lots.map((lot) => lot.organizerName)) ?? UNKNOWN_CUSTOMER;
  const customerInn = firstFilled(lots.map((lot) => lot.organizerInn));

  return {
    id: `roseltorg-${procedureNumber}`,
    regNumber: roseltorgRegNumber(procedureNumber),
    externalId: procedureNumber || null,
    law: roseltorgLaw(procedureNumber),
    placingWay: roseltorgPlacingWay(placingWayTitle),
    subject: context.subject?.trim() || first?.subject || "",
    // Список выдачи печатает организатора, а не заказчика: у корпоративных секций
    // это обычно одно лицо, но подменять понятия нельзя — поле так и называется.
    customerName,
    customerInn,
    region,
    // Места поставки в списке нет вовсе, поэтому адрес — регион заказчика.
    deliveryAddress: region,
    financial: {
      price: procedurePrice(lots, context.lotsComplete),
      currency: first?.currency ?? "RUB",
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
      submissionEnd: earliestDeadline(lots),
      // Даты публикации и последнего изменения в списке площадки нет; пустая
      // строка форматируется прочерком, а лента сортируется по сроку подачи.
      publicationDate: "",
      lastUpdateDate: "",
      deliveryTermDays: null,
      warrantyMonths: null,
    },
    // Кодов ОКПД2 поиск Росэлторга не отдаёт: пустой список, а не догадка.
    okpd2Codes: [],
    lots: lots.map((lot, index) => mapRoseltorgLot(lot, index, procedureNumber, region)),
    requirements: [],
    // Документы лежат на `com.roseltorg.ru`, где robots запрещает всё: пустой
    // список и причина в каталоге источников.
    documents: [],
    nationalRegime: false,
    onlyForSmp: lots.some((lot) => normalizeTitle(lot.placingWayTitle).includes("мсп")),
    eisUrl: first?.url ?? "",
    dataSource: "ROSELTORG",
    changeLog: [],
    syncedAt: context.syncStartedAt ?? null,
  };
}

/**
 * Закон закупки по форме номера.
 *
 * Росэлторг, как и ЕИС, печатает номер извещения без префикса: 19 знаков — 44-ФЗ,
 * 11 знаков с ведущей тройкой — 223-ФЗ. Всё остальное (`B…`, `COM…`, `ATOM…`,
 * `CORP…`, `SP…`) — номер площадки, и это коммерческая закупка. Из 60 строк живой
 * выдачи 44 несли номер площадки: именно их в ЕИС нет, и ради них источник
 * подключают.
 *
 * Название секции для вывода не используется намеренно: в строках списка площадка
 * печатает «Корпоративные закупки и закупки субъектов 223-ФЗ», а в фильтре —
 * «Закупки по 223-ФЗ», и сверка с названием сломалась бы на первой правке вёрстки.
 */
export function roseltorgLaw(procedureNumber: string): TenderLaw {
  const number = procedureNumber.trim();
  if (/^\d{19}$/.test(number)) return "FZ_44";
  if (/^3\d{10}$/.test(number)) return "FZ_223";
  return "COMMERCIAL";
}

/**
 * Ключ записи в базе.
 *
 * Номер извещения ЕИС остаётся собой: такую закупку наш адаптер реестра принесёт
 * тоже, и две строки об одном предмете в базе не должно быть — кто из источников
 * главнее, решает приоритет в `src/domain/sources.ts`. Номер площадки получает
 * префикс, потому что в реестре его нет и голый `B0210261118005` мог бы
 * столкнуться с номером другой площадки.
 */
export function roseltorgRegNumber(procedureNumber: string): string {
  const number = procedureNumber.trim();
  if (number === "") return "";
  return roseltorgLaw(number) === "COMMERCIAL" ? `ROSELTORG-${number}` : number;
}

/** Способ размещения: сначала словарь, потом ключевое слово, потом `OTHER`. */
export function roseltorgPlacingWay(title: string): PlacingWay {
  const normalized = normalizeTitle(title);
  const known = ROSELTORG_PLACING_WAYS[normalized];
  if (known) return known;
  for (const [pattern, way] of PLACING_WAY_KEYWORDS) {
    if (pattern.test(normalized)) return way;
  }
  return "OTHER";
}

/**
 * Цена закупки — сумма цен лотов, и только когда сумма осмысленна.
 *
 * Три причины не публиковать цену вместо того, чтобы напечатать заниженную:
 * набор лотов неполный, хотя бы у одного лота цены нет, лоты в разных валютах.
 * Нуль в домене значит «цена не опубликована» (`isPriceKnown`), и лента показывает
 * её с пометкой, а не как бесплатную закупку.
 */
function procedurePrice(lots: readonly RoseltorgLotRow[], complete: boolean): number {
  if (!complete || lots.length === 0) return 0;
  if (lots.some((lot) => lot.price === null)) return 0;
  if (new Set(lots.map((lot) => lot.currency)).size > 1) return 0;
  return lots.reduce((sum, lot) => sum + (lot.price ?? 0), 0);
}

/** Один лот выдачи в доменный лот. */
function mapRoseltorgLot(
  lot: RoseltorgLotRow,
  index: number,
  procedureNumber: string,
  tenderRegion: string,
): TenderLot {
  return {
    id: `${procedureNumber}-${lot.lotNumber ?? index + 1}`,
    number: lot.lotNumber ?? index + 1,
    subject: lot.subject,
    price: lot.price ?? 0,
    okpd2Codes: [],
    // Место поставки лота площадка в списке не печатает.
    deliveryRegion: tenderRegion,
    deliveryAddress: tenderRegion,
    deliveryTermDays: null,
  };
}

/**
 * Самый ранний срок приёма заявок из всех лотов.
 *
 * У многолотовой процедуры сроки бывают разными, и владельцу важен тот, до
 * которого ещё можно успеть подать заявку, а не самый поздний из них.
 */
function earliestDeadline(lots: readonly RoseltorgLotRow[]): string {
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

/** Лоты по возрастанию номера: площадка отдаёт их и в обратном порядке. */
function sortLots(rows: readonly RoseltorgLotRow[]): RoseltorgLotRow[] {
  return [...rows].sort((a, b) => {
    const left = a.lotNumber ?? Number.POSITIVE_INFINITY;
    const right = b.lotNumber ?? Number.POSITIVE_INFINITY;
    return left - right;
  });
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
