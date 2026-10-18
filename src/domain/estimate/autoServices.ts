/**
 * Сметные цены услуг автомобильного транспорта по ценовой зоне (ФГИС ЦС): перевозка
 * грузов и погрузочно-разгрузочные работы.
 *
 * Зачем. В смете заказчика перевозка мусора («02-15-1-01-0047», 619,94 ₽/т) и погрузка
 * («49-1», 94,64 ₽/т) идут отдельными строками, у которых нет нормы ГЭСН: их цену
 * Минстрой публикует открытыми таблицами. До этого модуля такие строки входили в расчёт
 * по цене заказчика и не проверялись. Теперь цена берётся из таблицы зоны.
 *
 * Модуль чистый: ни сети, ни диска. Он разбирает строки выгрузок (xlsx уже прочитан
 * вызывающим кодом), сериализует их в JSONL, сопоставляет шифр или наименование позиции
 * с ценой.
 *
 * ## Выгрузка перевозки (`Services/Export/TransportationByAutoPortal`)
 *
 * Лист «Выходная форма»: шапка (тип дорог, перечень типов ТС и грузоподъёмностей, период),
 * затем строки «км | код 1-го класса | цена | код 2-го | цена | код 3-го | цена | код 4-го |
 * цена». Класса может не быть — в ячейках «-».
 *
 * Код `02-15-1-01-0047` читается слева направо:
 *  1. `02` — тип автотранспортного средства (группа кодов);
 *  2. `15` — грузоподъёмность: «до 15 т» (для `06`, `08`, `16` — «до N м3»);
 *  3. `1`  — класс груза (1–4);
 *  4. `01` — тип дорог;
 *  5. `0047` — расстояние перевозки, км.
 *
 * Проверено по смете заказчика закупки 0134600012126000001: `02-15-1-01-0047` — перевозка
 * грузов I класса автомобилями-самосвалами до 15 т по дорогам с усовершенствованным
 * покрытием на 47 км, 619,94 ₽/т. Из выгрузки зоны 246 (3 кв. 2026) видно, что один
 * лист несёт все три типа дорог (01, 02, 03) и десять сочетаний «тип ТС — грузоподъёмность»
 * с километражем 1…1500 (у `05-06` — 1…100), а цены растут от `01` к `03`.
 *
 * Что подтверждено, а что нет. Подтверждено только то, что видно в данных или в смете
 * заказчика: `02` — самосвалы (в сметах и в примечании к таблице «автомобили-самосвалы
 * грузоподъёмностью 30 т» — это `02-30`), `01` — усовершенствованное покрытие. Названия
 * остальных типов ТС и дорог выгрузка не сопоставляет с кодами (шапка перечисляет
 * названия списком, без привязки), поэтому для них по наименованию цена не ищется —
 * только по шифру. Если в выгрузке встретится блок с одним типом дорог или ТС и своим
 * заголовком, соответствие выводится из блока.
 *
 * Расстояние больше максимума таблицы: правила «свыше N км — на каждый следующий км» в
 * примечаниях выгрузки нет, поэтому цены нет, а не экстраполяция.
 *
 * ## Выгрузка погрузки (`Services/Export/LoadWorksByAutoPortal`)
 *
 * Строки «группа груза | код погрузки | цена | код разгрузки | цена», код вида `49-1`
 * (погрузка) и `49-2` (разгрузка), число — номер группы груза. Нулевая цена (разгрузка
 * шлака, глины) — «отдельно не оплачивается»: такая запись не сохраняется, потому что ноль
 * нельзя отличить от отсутствия цены.
 *
 * НР и СП на перевозку и ПРР не начисляются — как и в смете заказчика по Методике 421/пр:
 * это стоимость услуг по сметным ценам, а не работа по расценке с фондом оплаты труда.
 */

import { foldLookalikes, parseUnit } from "@/domain/estimate/units";

/** Шифр перевозки: «02-15-1-01-0047». */
export const TRANSPORT_CODE_PATTERN = /(?<![\d.-])\d\d-\d\d-\d-\d\d-\d{4}(?![\d-])/;
const TRANSPORT_CODE_EXACT = /^(\d\d)-(\d\d)-([1-4])-(\d\d)-(\d{4})$/;
/** Шифр погрузки или разгрузки: «49-1», «42-2». */
const LOAD_CODE_EXACT = /^(\d{1,3})-([12])$/;
/** Шифр погрузки в обосновании строки: вся строка обоснования — и есть шифр. */
const LOAD_CODE_ALONE = /^\s*(\d{1,3}-[12])\s*$/;

/** Один тип ТС и одна грузоподъёмность, один класс груза и тип дорог: цены по километрам. */
export interface TransportSeries {
  /** Начало шифра без километров: «02-15-1-01». */
  readonly prefix: string;
  /** Тип ТС — первая группа шифра: «02». */
  readonly vehicle: string;
  /** Грузоподъёмность — вторая группа шифра: 15. */
  readonly capacity: number;
  /** Единица грузоподъёмности по шапке выгрузки; null — шапка неоднозначна. */
  readonly capacityUnit: "т" | "м3" | null;
  /** Класс груза 1–4. */
  readonly cls: 1 | 2 | 3 | 4;
  /** Тип дорог — четвёртая группа шифра: «01». */
  readonly road: string;
  /** Название типа ТС, если оно подтверждено. */
  readonly vehicleName: string | null;
  /** Название типа дорог, если оно подтверждено. */
  readonly roadName: string | null;
  /** Цена ₽/т: индекс i — расстояние i + 1 км; null — для этого километра цены нет. */
  readonly prices: readonly (number | null)[];
}

/** Цена погрузки или разгрузки группы груза. */
export interface LoadPrice {
  /** «49-1». */
  readonly code: string;
  /** Номер группы груза. */
  readonly group: number;
  /** Название группы: «Мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3». */
  readonly groupName: string;
  readonly operation: "LOAD" | "UNLOAD";
  /** ₽/т. */
  readonly price: number;
}

/** Всё, что собрано из двух выгрузок зоны; любая из частей может отсутствовать. */
export interface ZoneAutoServices {
  readonly transport: ReadonlyMap<string, TransportSeries>;
  readonly load: ReadonlyMap<string, LoadPrice>;
}

export function emptyAutoServices(): ZoneAutoServices {
  return { transport: new Map(), load: new Map() };
}

/** Есть ли в наборе хоть одна цена. */
export function hasAutoServices(services: ZoneAutoServices | null | undefined): services is ZoneAutoServices {
  return services !== null && services !== undefined && (services.transport.size > 0 || services.load.size > 0);
}

/* ------------------------------ Названия по коду ------------------------------ */

/** Типы ТС, подтверждённые данными. Остальные коды выгрузка с названиями не связывает. */
const KNOWN_VEHICLES: ReadonlyMap<string, string> = new Map([["02", "Автомобили-самосвалы"]]);
/** Типы дорог, подтверждённые сметой заказчика. */
const KNOWN_ROADS: ReadonlyMap<string, string> = new Map([
  ["01", "усовершенствованное (асфальтобетонное, цементобетонное, железобетонное, обработанное органическим вяжущим) дорожное покрытие"],
]);

/* ------------------------------ Разбор выгрузки перевозки ------------------------------ */

export interface TransportParseResult {
  readonly series: readonly TransportSeries[];
  /** Сколько цен (ячеек код-цена) принято. */
  readonly prices: number;
  /** Ячейки, пропущенные из-за нечитаемой цены, чужого километра или повтора. */
  readonly skipped: number;
  /** Период из шапки: «3 квартал 2026 года»; null — не найден. */
  readonly period: string | null;
  /** Зона из шапки: «Иркутская область (1 зона), г. Иркутск»; null — не найдена. */
  readonly zone: string | null;
}

interface BlockHeader {
  roadTitle: string | null;
  vehicles: string[];
  capacities: { value: number; unit: "т" | "м3" }[];
}

interface BlockStats {
  roads: Set<string>;
  vehicles: Set<string>;
  header: BlockHeader;
}

function text(cell: unknown): string {
  return typeof cell === "string" ? cell.replace(/\s+/g, " ").trim() : "";
}

function number(cell: unknown): number | null {
  if (typeof cell === "number" && Number.isFinite(cell)) return cell;
  if (typeof cell === "string") {
    const parsed = Number.parseFloat(cell.replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(parsed) && /^-?[\d\s]+([.,]\d+)?$/.test(cell.trim())) return parsed;
  }
  return null;
}

function parseCapacityList(value: string): BlockHeader["capacities"] {
  const result: BlockHeader["capacities"] = [];
  for (const part of value.split(",")) {
    const match = /(\d+(?:[.,]\d+)?)\s*(т|м3|м³)/i.exec(part);
    if (match === null) continue;
    const unit = (match[2] as string).toLowerCase() === "т" ? "т" : "м3";
    result.push({ value: Number.parseFloat((match[1] as string).replace(",", ".")), unit });
  }
  return result;
}

/**
 * Строки листа выгрузки перевозки → серии цен по километрам.
 *
 * Блоки: шапка встречается и в начале листа, и (если портал отдаёт отдельные таблицы по
 * типам дорог) перед каждым следующим блоком. Всё, что не строка данных, — шапка или
 * примечание и в цены не попадает.
 */
export function parseTransportAutoRows(rows: Iterable<readonly unknown[]>): TransportParseResult {
  type Draft = {
    vehicle: string;
    capacity: number;
    cls: 1 | 2 | 3 | 4;
    road: string;
    prices: (number | null)[];
    capacityUnit: "т" | "м3" | null;
  };
  const drafts = new Map<string, Draft>();
  const learnedRoads = new Map<string, string>();
  const learnedVehicles = new Map<string, string>();

  let previousText = "";
  let zone: string | null = null;
  let period: string | null = null;
  let prices = 0;
  let skipped = 0;

  let header: BlockHeader = { roadTitle: null, vehicles: [], capacities: [] };
  let block: BlockStats = { roads: new Set(), vehicles: new Set(), header };

  const closeBlock = (): void => {
    if (block.roads.size === 1 && block.header.roadTitle !== null) {
      learnedRoads.set([...block.roads][0] as string, block.header.roadTitle);
    }
    if (block.vehicles.size === 1 && block.header.vehicles.length === 1) {
      learnedVehicles.set([...block.vehicles][0] as string, block.header.vehicles[0] as string);
    }
  };
  const openBlock = (): void => {
    if (block.roads.size > 0 || block.vehicles.size > 0) closeBlock();
    header = { roadTitle: null, vehicles: [], capacities: [] };
    block = { roads: new Set(), vehicles: new Set(), header };
  };
  let blockHasData = false;

  for (const row of rows) {
    const first = row[0];
    const km = number(first);
    const pairs = [1, 3, 5, 7];

    // Строка данных: км — целое, и в первой паре стоит шифр перевозки.
    const isData =
      km !== null && Number.isInteger(km) && km >= 1 && pairs.some((index) => TRANSPORT_CODE_EXACT.test(text(row[index])));
    if (isData) {
      blockHasData = true;
      for (const index of pairs) {
        const code = text(row[index]);
        const match = TRANSPORT_CODE_EXACT.exec(code);
        if (match === null) continue;
        const price = number(row[index + 1]);
        const codeKm = Number.parseInt(match[5] as string, 10);
        if (price === null || !(price > 0) || codeKm !== km) {
          skipped += 1;
          continue;
        }
        const vehicle = match[1] as string;
        const capacity = Number.parseInt(match[2] as string, 10);
        const cls = Number.parseInt(match[3] as string, 10) as 1 | 2 | 3 | 4;
        const road = match[4] as string;
        const key = `${vehicle}-${match[2] as string}-${String(cls)}-${road}`;
        let draft = drafts.get(key);
        if (draft === undefined) {
          const units = new Set(header.capacities.filter((item) => item.value === capacity).map((item) => item.unit));
          draft = {
            vehicle,
            capacity,
            cls,
            road,
            prices: [],
            capacityUnit: units.size === 1 ? ([...units][0] as "т" | "м3") : null,
          };
          drafts.set(key, draft);
        }
        if (draft.prices[km - 1] !== undefined && draft.prices[km - 1] !== null) {
          skipped += 1;
          continue;
        }
        draft.prices[km - 1] = price;
        prices += 1;
        block.roads.add(road);
        block.vehicles.add(vehicle);
      }
      continue;
    }

    const label = text(first);
    if (label === "") continue;
    if (/^\(?\s*тип дорог\s*\)?$/i.test(label)) {
      // Заголовок типа дорог стоит строкой выше «(тип дорог)»; новый блок — после данных.
      if (blockHasData) {
        openBlock();
        blockHasData = false;
      }
      header.roadTitle = previousText === "" ? null : previousText;
    } else if (/^тип автотранспортного средства\s*:/i.test(label)) {
      header.vehicles = label
        .replace(/^тип автотранспортного средства\s*:/i, "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");
    } else if (/^грузоподъемность автотранспортного средства\s*:/i.test(label)) {
      header.capacities = parseCapacityList(label.replace(/^грузоподъемность автотранспортного средства\s*:/i, ""));
    } else if (/^период действия\s*:/i.test(label)) {
      period = label.replace(/^период действия\s*:/i, "").trim() || period;
    } else if (zone === null && label.length < 200 && /\(\s*\d+\s*зона\s*\)/u.test(label)) {
      zone = label;
    }
    previousText = label;
  }
  closeBlock();

  const series: TransportSeries[] = [];
  for (const [key, draft] of [...drafts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const filled = Array.from({ length: draft.prices.length }, (_, index) => draft.prices[index] ?? null);
    series.push({
      prefix: key,
      vehicle: draft.vehicle,
      capacity: draft.capacity,
      capacityUnit: draft.capacityUnit,
      cls: draft.cls,
      road: draft.road,
      vehicleName: learnedVehicles.get(draft.vehicle) ?? KNOWN_VEHICLES.get(draft.vehicle) ?? null,
      roadName: learnedRoads.get(draft.road) ?? KNOWN_ROADS.get(draft.road) ?? null,
      prices: filled,
    });
  }
  return { series, prices, skipped, period, zone };
}

/* ------------------------------ Разбор выгрузки погрузки ------------------------------ */

export interface LoadParseResult {
  readonly prices: readonly LoadPrice[];
  /** Нулевые цены («отдельно не оплачивается») и нечитаемые строки: в файл не пишутся. */
  readonly skipped: number;
  readonly period: string | null;
  readonly zone: string | null;
}

/** Строки листа выгрузки погрузки: «группа | код погрузки | цена | код разгрузки | цена». */
export function parseLoadAutoRows(rows: Iterable<readonly unknown[]>): LoadParseResult {
  const prices: LoadPrice[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let zone: string | null = null;
  let period: string | null = null;

  for (const row of rows) {
    const name = text(row[0]);
    const cells: readonly (readonly [number, "LOAD" | "UNLOAD"])[] = [
      [1, "LOAD"],
      [3, "UNLOAD"],
    ];
    let isData = false;
    for (const [index, operation] of cells) {
      const code = text(row[index]);
      const match = LOAD_CODE_EXACT.exec(code);
      if (match === null || name === "") continue;
      // Код операции обязан соответствовать колонке: «-1» — погрузка, «-2» — разгрузка.
      if ((match[2] === "1") !== (operation === "LOAD")) continue;
      isData = true;
      const price = number(row[index + 1]);
      if (price === null || !(price > 0) || seen.has(code)) {
        skipped += 1;
        continue;
      }
      seen.add(code);
      prices.push({ code, group: Number.parseInt(match[1] as string, 10), groupName: name, operation, price });
    }
    if (isData) continue;
    if (/^период действия\s*:/i.test(name)) period = name.replace(/^период действия\s*:/i, "").trim() || period;
    else if (zone === null && /\(\s*\d+\s*зона\s*\)/u.test(name)) zone = name;
  }
  return { prices, skipped, period, zone };
}

/* ------------------------------ JSONL ------------------------------ */

/** Строка `transport-auto.jsonl`: серия цен по километрам одного шифра без километров. */
export function transportSeriesLine(series: TransportSeries): string {
  return JSON.stringify({
    c: series.prefix,
    vt: series.vehicle,
    cap: series.capacity,
    ...(series.capacityUnit === null ? {} : { cu: series.capacityUnit }),
    cls: series.cls,
    road: series.road,
    ...(series.vehicleName === null ? {} : { vn: series.vehicleName }),
    ...(series.roadName === null ? {} : { rn: series.roadName }),
    p: series.prices,
  });
}

export function parseTransportSeriesRecord(value: unknown): TransportSeries | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { c, vt, cap, cls, road, p } = record;
  if (typeof c !== "string" || typeof vt !== "string" || typeof cap !== "number" || typeof road !== "string") return null;
  if (cls !== 1 && cls !== 2 && cls !== 3 && cls !== 4) return null;
  if (!Array.isArray(p)) return null;
  const prices = p.map((item) => (typeof item === "number" && Number.isFinite(item) && item > 0 ? item : null));
  const unit = record.cu === "т" || record.cu === "м3" ? record.cu : null;
  return {
    prefix: c,
    vehicle: vt,
    capacity: cap,
    capacityUnit: unit,
    cls,
    road,
    vehicleName: typeof record.vn === "string" ? record.vn : null,
    roadName: typeof record.rn === "string" ? record.rn : null,
    prices,
  };
}

/** Строка `load-auto.jsonl`: цена погрузки или разгрузки группы груза. */
export function loadPriceLine(price: LoadPrice): string {
  return JSON.stringify({ c: price.code, g: price.group, n: price.groupName, k: price.operation === "LOAD" ? "load" : "unload", p: price.price });
}

export function parseLoadPriceRecord(value: unknown): LoadPrice | null {
  if (typeof value !== "object" || value === null) return null;
  const { c, g, n, k, p } = value as Record<string, unknown>;
  if (typeof c !== "string" || typeof g !== "number" || typeof n !== "string" || typeof p !== "number" || !(p > 0)) return null;
  if (!LOAD_CODE_EXACT.test(c) || (k !== "load" && k !== "unload")) return null;
  return { code: c, group: g, groupName: n, operation: k === "load" ? "LOAD" : "UNLOAD", price: p };
}

export function servicesFromRecords(
  transport: readonly TransportSeries[],
  load: readonly LoadPrice[],
): ZoneAutoServices {
  return {
    transport: new Map(transport.map((series) => [series.prefix, series] as const)),
    load: new Map(load.map((price) => [price.code, price] as const)),
  };
}

/* ------------------------------ Поиск цены ------------------------------ */

/** Цена услуги, найденная для позиции. */
export interface ServicePrice {
  readonly kind: "TRANSPORT" | "LOAD" | "UNLOAD";
  /** Шифр: «02-15-1-01-0047» или «49-1». */
  readonly code: string;
  /** ₽ за тонну. */
  readonly price: number;
  /** Расстояние, км — только у перевозки. */
  readonly km: number | null;
  /** Описание по таблице: что именно оплачивается. */
  readonly description: string;
}

/** Ответ поиска: цена или причина, по которой цены нет. */
export type ServiceLookup =
  | { readonly ok: true; readonly price: ServicePrice }
  | { readonly ok: false; readonly reason: string };

const miss = (reason: string): ServiceLookup => ({ ok: false, reason });

function formatNumber(value: number): string {
  return String(value).replace(".", ",");
}

function describeTransport(series: TransportSeries, km: number): string {
  const vehicle = series.vehicleName ?? `тип ТС ${series.vehicle}`;
  const road = series.roadName === null ? `тип дорог ${series.road}` : `дороги: ${series.roadName}`;
  const unit = series.capacityUnit ?? "т";
  return `Перевозка грузов ${String(series.cls)} класса, ${vehicle}, до ${String(series.capacity)} ${unit}, ${road}, ${String(km)} км`;
}

/** Цена перевозки по шифру «02-15-1-01-0047». */
export function transportPriceByCode(services: ZoneAutoServices, code: string): ServiceLookup {
  const match = TRANSPORT_CODE_EXACT.exec(code.trim());
  if (match === null) return miss(`«${code}» не шифр перевозки`);
  const prefix = `${match[1] as string}-${match[2] as string}-${match[3] as string}-${match[4] as string}`;
  const km = Number.parseInt(match[5] as string, 10);
  const series = services.transport.get(prefix);
  if (series === undefined) return miss(`шифра ${prefix}-… нет в таблице перевозки зоны`);
  if (km < 1) return miss(`расстояние ${String(km)} км: в таблице километры считаются с 1`);
  if (km > series.prices.length) {
    return miss(
      `расстояние ${String(km)} км больше таблицы перевозки зоны (${String(series.prices.length)} км), а правила для большего расстояния в таблице нет`,
    );
  }
  const price = series.prices[km - 1];
  if (price === null || price === undefined) return miss(`в таблице перевозки зоны нет цены ${prefix}-${String(km).padStart(4, "0")}`);
  return {
    ok: true,
    price: { kind: "TRANSPORT", code: `${prefix}-${String(km).padStart(4, "0")}`, price, km, description: describeTransport(series, km) },
  };
}

/** Цена погрузки или разгрузки по шифру «49-1». */
export function loadPriceByCode(services: ZoneAutoServices, code: string): ServiceLookup {
  const match = LOAD_CODE_EXACT.exec(code.trim());
  if (match === null) return miss(`«${code}» не шифр погрузки`);
  // В таблице группы 1–9 записаны с нулём («01-1»), в смете их печатают и так, и без нуля.
  const trimmed = `${String(Number.parseInt(match[1] as string, 10)).padStart(2, "0")}-${match[2] as string}`;
  const found = services.load.get(trimmed);
  if (found === undefined) return miss(`в таблице погрузочно-разгрузочных работ зоны нет цены ${trimmed}`);
  const verb = found.operation === "LOAD" ? "Погрузка" : "Разгрузка";
  return {
    ok: true,
    price: {
      kind: found.operation,
      code: found.code,
      price: found.price,
      km: null,
      description: `${verb}: ${found.groupName}`,
    },
  };
}

/** Шифр услуги по коду в обосновании или цитате строки: «02-15-1-01-0047» или «49-1». */
export function serviceCodeFromText(justification: string | undefined | null, quote?: string | null): string | null {
  if (justification !== undefined && justification !== null) {
    const transport = TRANSPORT_CODE_PATTERN.exec(justification);
    if (transport !== null) return transport[0];
    const load = LOAD_CODE_ALONE.exec(justification);
    if (load !== null) return load[1] as string;
  }
  if (quote !== undefined && quote !== null) {
    const transport = TRANSPORT_CODE_PATTERN.exec(quote);
    if (transport !== null) return transport[0];
  }
  return null;
}

/* ------------------------------ Строка-услуга в смете заказчика ------------------------------ */

/**
 * Что в обосновании строки говорит, что перед нами услуга перевозки или погрузки-разгрузки по сметной цене, а не работа по расценке.
 *
 * Зачем. В ЛСР заказчика такие строки идут без шифра расценки ГЭСН: «03-1 Погрузка в автотранспортное средство: изделия из сборного
 * железобетона», «02-15-1-01-0047 Перевозка грузов I класса …», «ФССЦпг-…», подстрока «ФСБЦ-02.2.04.03-0013_02-15» (перевозка
 * материала). Шифр у них свой, из сборников сметных цен на перевозку и погрузочно-разгрузочные работы. Поиск нормы по наименованию
 * их принимал за расценку ГЭСН («Погрузка и выгрузка вручную: …», 184 790 ₽ вместо 30 714,92 ₽ на закупке 32616401076).
 *
 * `service` — строка услуга. `code` — шифр, по которому можно искать цену в таблицах зоны (`priceByServiceCode`); null — шифр у строки
 * есть, но таблиц под него нет («ФССЦпг-…», «…_02-15» без километров): цену даст наименование или цена заказчика.
 */
export interface ServiceRowCode {
  readonly service: boolean;
  readonly code: string | null;
}

/** Короткий шифр сборника погрузки-разгрузки: «03-1», «49-2», с нулём или без. */
const SHORT_SERVICE_CODE = /^\d{1,3}-\d{1,2}$/;
/** Шифр сметной цены на перевозку и погрузку в ФССЦпг: «ФССЦпг-01-01-01-045», «ФССЦпг03-21-01-043». */
const PG_SERVICE_CODE = /^ФС[СБ]Цпг[\s-]*\d{1,3}(?:-\d{1,4}){1,5}$/iu;
/** Материал с хвостом класса груза: «ФСБЦ-02.2.04.03-0013_02-15» — перевозка этого материала, а не его поставка. */
const MATERIAL_TRANSPORT_CODE = /^(?:ФС[СБ]Ц-?)?\d{2}\.\d\.\d{2}\.\d{2}-\d{4}_\d{2}-\d{2}$/iu;

/** Распознаёт шифр услуги в первой строке обоснования («03-1», «02-15-1-01-0047», «ФССЦпг-…», «ФСБЦ-…_02-15»). */
export function serviceRowCodeOf(justification: string | undefined | null): ServiceRowCode {
  const first = ((justification ?? "").split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  if (first === "") return { service: false, code: null };
  if (TRANSPORT_CODE_EXACT.test(first)) return { service: true, code: first };
  if (SHORT_SERVICE_CODE.test(first)) return { service: true, code: first };
  if (PG_SERVICE_CODE.test(first) || MATERIAL_TRANSPORT_CODE.test(first)) return { service: true, code: null };
  return { service: false, code: null };
}

/** Наименование услуги: «Погрузка …», «Разгрузка …», «Перевозка грузов …». Другая «Перевозка» (рабочих, оборудования) — не она. */
const SERVICE_NAME = /^\s*(?:(?:погрузк|разгрузк|выгрузк)\p{L}*|перевозк\p{L}*\s+грузов)/iu;

export function isServiceName(name: string): boolean {
  return SERVICE_NAME.test(name);
}

/**
 * Строка ведомости — услуга перевозки или погрузки: признак из ЛСР (`serviceRow`), найденный шифр или наименование. К расценке по
 * наименованию такая строка не подбирается (`BillOfWorkItem.serviceRow`).
 */
export function isServiceItem(item: { readonly serviceRow?: boolean; readonly serviceCode?: string | null; readonly workName: string }): boolean {
  return item.serviceRow === true || (item.serviceCode ?? null) !== null || isServiceName(item.workName);
}

/** Шифр по коду: перевозка, погрузка или не услуга. */
export function priceByServiceCode(services: ZoneAutoServices, code: string): ServiceLookup {
  const trimmed = code.trim();
  if (TRANSPORT_CODE_EXACT.test(trimmed)) return transportPriceByCode(services, trimmed);
  if (LOAD_CODE_EXACT.test(trimmed)) return loadPriceByCode(services, trimmed);
  return miss(`«${code}» не шифр услуги перевозки или погрузки`);
}

/* ------------------------------ Разбор наименования ------------------------------ */

function fold(textValue: string): string {
  return textValue
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Класс груза в тексте: «I», «1», «1-го», «II» → 1…4. Скан «|» вместо «I» не принимается: он неоднозначен. */
function classOf(token: string): 1 | 2 | 3 | 4 | null {
  const cleaned = token
    .replace(/і/g, "i")
    .replace(/[-–]?го$/, "")
    .replace(/х/g, "x");
  const map: Readonly<Record<string, 1 | 2 | 3 | 4>> = { i: 1, ii: 2, iii: 3, iv: 4, "1": 1, "2": 2, "3": 3, "4": 4 };
  return map[cleaned] ?? null;
}

/** Типы ТС, названия которых однозначно связаны с кодом. */
const VEHICLE_WORDS: readonly { readonly pattern: RegExp; readonly code: string }[] = [{ pattern: /самосвал/, code: "02" }];
/** Типы дорог, названия которых однозначно связаны с кодом. */
const ROAD_WORDS: readonly { readonly pattern: RegExp; readonly code: string }[] = [{ pattern: /усовершенствован/, code: "01" }];

export interface TransportName {
  readonly cls: 1 | 2 | 3 | 4;
  readonly vehicle: string;
  readonly capacity: number;
  readonly capacityUnit: "т" | "м3";
  readonly road: string;
  readonly km: number;
}

/**
 * Разбор наименования перевозки: «Перевозка грузов I класса автомобилями-самосвалами
 * грузоподъёмностью до 15 т по дорогам с усовершенствованным покрытием на расстояние 47 км».
 *
 * Каждый из пяти признаков (класс, тип ТС, грузоподъёмность, тип дорог, расстояние) обязан
 * читаться однозначно; иначе — причина. Тип ТС и тип дорог сопоставляются только с теми
 * кодами, которые подтверждены (самосвалы, усовершенствованное покрытие).
 */
export function parseTransportName(raw: string): { ok: true; name: TransportName } | { ok: false; reason: string } {
  const lowered = fold(raw);
  if (!/^перевозк/.test(lowered)) return { ok: false, reason: "наименование не начинается со слова «Перевозка»" };

  const classMatch = /грузов\s+((?:[iіvх]+|[1-4])(?:[-–]?го)?)\s*класс/.exec(lowered);
  const cls = classMatch === null ? null : classOf(classMatch[1] as string);
  if (cls === null) return { ok: false, reason: "класс груза в наименовании не читается" };

  const vehicles = VEHICLE_WORDS.filter((item) => item.pattern.test(lowered));
  if (vehicles.length !== 1) {
    return { ok: false, reason: "тип автотранспортного средства не сопоставлен с кодами таблицы" };
  }

  const capacityMatch = /грузоподъемност\p{L}*\s+(?:до\s+)?(\d+(?:[.,]\d+)?)\s*(т|тонн\p{L}*|м3|м³)/u.exec(lowered);
  if (capacityMatch === null) return { ok: false, reason: "грузоподъёмность в наименовании не читается" };
  const capacity = Number.parseFloat((capacityMatch[1] as string).replace(",", "."));
  const capacityUnit = (capacityMatch[2] as string).startsWith("т") ? "т" : "м3";
  if (!Number.isInteger(capacity)) return { ok: false, reason: "грузоподъёмность не целая" };

  const roads = ROAD_WORDS.filter((item) => item.pattern.test(lowered));
  if (roads.length !== 1) return { ok: false, reason: "тип дорог не сопоставлен с кодами таблицы" };

  const kmMatch = /на\s+расстояни[ея]\s+(\d+(?:[.,]\d+)?)\s*км/.exec(lowered);
  if (kmMatch === null) return { ok: false, reason: "расстояние перевозки в наименовании не указано" };
  const km = Number.parseFloat((kmMatch[1] as string).replace(",", "."));
  if (!Number.isInteger(km) || km < 1) return { ok: false, reason: `расстояние ${formatNumber(km)} км не целое: таблица по целым километрам` };

  return {
    ok: true,
    name: {
      cls,
      vehicle: (vehicles[0] as { code: string }).code,
      capacity,
      capacityUnit,
      road: (roads[0] as { code: string }).code,
      km,
    },
  };
}

/** Цена перевозки по наименованию позиции. */
export function transportPriceByName(services: ZoneAutoServices, raw: string): ServiceLookup {
  const parsed = parseTransportName(raw);
  if (!parsed.ok) return miss(parsed.reason);
  const { name } = parsed;
  const prefix = `${name.vehicle}-${String(name.capacity).padStart(2, "0")}-${String(name.cls)}-${name.road}`;
  const series = services.transport.get(prefix);
  if (series === undefined) return miss(`в таблице перевозки зоны нет сочетания ${prefix}-… (тип ТС, грузоподъёмность, класс, дороги)`);
  if (series.capacityUnit !== null && series.capacityUnit !== name.capacityUnit) {
    return miss(`грузоподъёмность в наименовании в «${name.capacityUnit}», а в таблице ${prefix}-… — в «${series.capacityUnit}»`);
  }
  return transportPriceByCode(services, `${prefix}-${String(name.km).padStart(4, "0")}`);
}

/** Операция по наименованию: «Погрузка в автотранспортное средство: …» и «Разгрузка из автотранспортного средства: …». */
const LOAD_PREFIX = /^\s*погрузк\p{L}*(?:\s+в\s+автотранспортн\p{L}*\s+средств\p{L}*)?\s*[:\-–]\s*(.+)$/isu;
const UNLOAD_PREFIX = /^\s*(?:разгрузк|выгрузк)\p{L}*(?:\s+из\s+автотранспортн\p{L}*\s+средств\p{L}*)?\s*[:\-–]\s*(.+)$/isu;

/** Главная часть названия группы груза: до скобки, без пробелов и знаков, латиница «m3» → «м3». */
function cargoHead(value: string): string {
  const head = value.replace(/\(.*$/s, "");
  const lowered = fold(head)
    .replace(/[“”"«»]/g, "")
    .replace(/[.,;:]+(?=\s|$)/g, "")
    .replace(/(?<![\p{L}\d])[mм]\s*[3³з](?![\p{L}\d])/gu, "м3");
  return foldLookalikes(lowered)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Цена погрузки или разгрузки по наименованию: «Погрузка в автотранспортное средство:
 * мусор строительный с погрузкой экскаваторами емкостью ковша до 0,5 м3».
 *
 * Группа груза ищется среди групп таблицы зоны: совпасть должна главная часть названия
 * (до скобки) — целиком или как начало ровно одной группы. «Мусор строительный» без способа
 * погрузки подходит трём группам — это неоднозначность, цены нет.
 */
export function loadPriceByName(services: ZoneAutoServices, raw: string): ServiceLookup {
  const load = LOAD_PREFIX.exec(raw);
  const unload = load === null ? UNLOAD_PREFIX.exec(raw) : null;
  const operation = load !== null ? "LOAD" : unload !== null ? "UNLOAD" : null;
  const cargo = (load ?? unload)?.[1];
  if (operation === null || cargo === undefined) return miss("наименование не начинается с «Погрузка…:» или «Разгрузка…:»");

  const wanted = cargoHead(cargo);
  if (wanted.length < 4) return miss("группа груза в наименовании не читается");

  const groups = new Map<number, { name: string; head: string }>();
  for (const price of services.load.values()) {
    if (!groups.has(price.group)) groups.set(price.group, { name: price.groupName, head: cargoHead(price.groupName) });
  }
  const exact = [...groups.entries()].filter(([, group]) => group.head === wanted);
  const candidates =
    exact.length > 0
      ? exact
      : [...groups.entries()].filter(([, group]) => group.head.startsWith(`${wanted} `) || group.head.startsWith(`${wanted},`));
  if (candidates.length === 0) return miss(`группа груза «${cargo.trim()}» в таблице погрузки зоны не найдена`);
  if (candidates.length > 1) {
    return miss(`наименованию «${cargo.trim()}» подходит несколько групп груза (${candidates.map(([group]) => String(group)).join(", ")}) — выбирать нельзя`);
  }
  const [group] = candidates[0] as [number, { name: string; head: string }];
  return loadPriceByCode(services, `${String(group)}-${operation === "LOAD" ? "1" : "2"}`);
}

/**
 * Цена услуги для позиции: по шифру, если он есть, иначе по наименованию.
 *
 * `null` — позиция не похожа на услугу перевозки или погрузки, и вызывающий код считает её
 * как обычно. `ok: false` — похожа, но цены нет, причина в `reason`.
 */
export function resolveServicePrice(
  services: ZoneAutoServices,
  input: { readonly serviceCode?: string | null; readonly workName: string; readonly quantityUnit: string; readonly quantity: number },
): ServiceLookup | null {
  const code = input.serviceCode ?? null;
  const byName = (): ServiceLookup | null => {
    if (/^\s*перевозк/i.test(input.workName)) return transportPriceByName(services, input.workName);
    if (/^\s*(?:погрузк|разгрузк|выгрузк)/i.test(input.workName)) return loadPriceByName(services, input.workName);
    return null;
  };
  let outcome: ServiceLookup | null = null;

  if (code !== null) {
    outcome = priceByServiceCode(services, code);
    /*
      Шифр погрузки есть, а цены с таким шифром в таблице зоны нет (нумерация групп сборников у заказчика и у зоны могла разойтись):
      единственный другой признак — наименование, и его принимаем, если оно читается однозначно. Шифр перевозки так не заменяется:
      в нём зашито расстояние, и наименование с другим километражем — это противоречие, а не вторая подсказка.
    */
    if (!outcome.ok && !TRANSPORT_CODE_EXACT.test(code.trim())) {
      const named = byName();
      if (named !== null && named.ok) outcome = named;
    }
  } else {
    outcome = byName();
  }
  if (outcome === null) return null;
  if (!outcome.ok) return outcome;

  // Цена за тонну: объём обязан быть в тоннах.
  const unit = parseUnit(input.quantityUnit);
  if (unit === null || unit.unit !== "т" || unit.multiplier !== 1) {
    return miss(`цена услуги ${outcome.price.code} — за тонну, а объём позиции в «${input.quantityUnit}»`);
  }
  if (!(input.quantity > 0)) return miss("объём позиции не положителен");
  return outcome;
}
