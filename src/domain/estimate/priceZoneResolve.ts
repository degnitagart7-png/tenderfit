import { UNKNOWN_REGION } from "@/domain/entities";
import { matchStems, stemsOf } from "@/domain/estimate/municipalityMatch";
import {
  northClassOfUnit,
  northSubjectOf,
  resolveNorth,
  resolveNorthByText,
  type NorthBasis,
} from "@/domain/estimate/north";
import type { NorthZone } from "@/domain/estimate/overheadNormatives";
import { isSameRegion, regionCodeOf } from "@/domain/regionCodes";
import { normalizeRegionText, REGION_CAPITALS, regionFromAddress } from "@/domain/regions";

/**
 * Какую ценовую зону брать для закупки.
 *
 * Зачем. Цены ресурсов зависят от ценовой зоны: у одного субъекта их бывает до
 * восьми (Бурятия: 232–239), и смета по Заиграевскому району в ценах Северобайкальска
 * (8 зона, Север) отличается на десятки процентов. До этого вся база считала в
 * амурских ценах, и «молча посчитать в чужой зоне» было ошибкой по умолчанию.
 *
 * Правило, как во всём домене: не угадывать. Зона выбирается по явным признакам,
 * и каждый называется в ответе (`basis`, `matched`), чтобы человек видел, почему
 * выбрана именно она и мог её поменять:
 * - у субъекта одна зона → `SINGLE_ZONE`;
 * - в адресе, названии заказчика или другом тексте найден муниципалитет из списка
 *   зоны → `MUNICIPALITY`;
 * - иначе зона, в которую входит столица субъекта → `CAPITAL` (самое слабое
 *   основание: закупка может быть в любом районе, поэтому оно так и называется);
 * - субъект не определён или зону назвать нельзя → `UNKNOWN_REGION`, зона `null`.
 * `USER`, `CUSTOMER_ESTIMATE` (зона из шапки сметы заказчика) и `CUSTOMER_PRICES` (зона по ставкам из его ресурсных строк) ставит
 * тот, кто принял выбор человека или смету (`chooseEstimateZone`): сам разбор их не выдаёт.
 *
 * Модуль чистый: ни сети, ни диска — он работает и в браузере (предвыбор в
 * интерфейсе), и на сервере (воркер) и даёт один и тот же ответ.
 */

/** Ценовая зона из `zones.jsonl` (price-zones.csv ФГИС ЦС). */
export interface PriceZoneRecord {
  readonly subjectCode: string;
  readonly subjectName: string;
  readonly zoneName: string;
  readonly center: string;
  readonly municipalities: string;
}

export type PriceZoneBasis =
  | "SINGLE_ZONE"
  | "MUNICIPALITY"
  | "CAPITAL"
  | "USER"
  /** Зона названа в шапке локальной сметы заказчика («Республика Бурятия (5 зона)»). */
  | "CUSTOMER_ESTIMATE"
  /**
   * Зона узнана по ценам сметы заказчика: ставки оплаты труда рабочих и машинистов в его ЛСР совпали до копейки с реестром ставок
   * этой зоны и не совпали ни с какой другой зоной субъекта (`identifyZoneByWages`). Шапка сметы о зоне молчала.
   */
  | "CUSTOMER_PRICES"
  | "UNKNOWN_REGION";

export interface PriceZoneQuery {
  /** Регион закупки, как он записан в базе («Республика Бурятия»). */
  readonly region: string;
  readonly address?: string | null;
  readonly customerName?: string | null;
  readonly extraText?: string | null;
}

export interface PriceZoneAlternative {
  readonly priceZoneId: number;
  readonly zoneName: string;
}

export interface PriceZoneResolution {
  readonly priceZoneId: number | null;
  readonly zoneName: string | null;
  readonly subject: string | null;
  readonly basis: PriceZoneBasis;
  /** Что совпало: «Кабанский р-н», «г. Северобайкальск», «Улан-Удэ»; null — для других оснований. */
  readonly matched: string | null;
  /** Цены этой зоны собраны. */
  readonly built: boolean;
  readonly northZone: NorthZone;
  /** Как определена северность (для допущений расчёта). */
  readonly northBasis: NorthBasis;
  /** Остальные собранные зоны того же субъекта. */
  readonly alternatives: readonly PriceZoneAlternative[];
}

/* ------------------------ Муниципалитеты зон ------------------------ */

interface Municipality {
  /** Как показывать: «Кабанский р-н», «г. Улан-Удэ». */
  readonly label: string;
  /** Нормализованное «тип + название» — ключ таблицы Севера. */
  readonly key: string;
  readonly type: string;
  /** Название без типа: «Баунтовский эвенкийский». */
  readonly name: string;
  /** Слова названия и их основы для сравнения. */
  readonly stems: readonly { readonly stem: string; readonly exact: boolean }[];
  /** Сколько букв в основах: нижняя граница против ложных совпадений. */
  readonly letters: number;
}

/** Типы записей, которые считаются городами и районами: для них порог основы ниже. */
const TOWN_TYPES: ReadonlySet<string> = new Set(["г", "пгт", "рп", "р-н"]);

/** Минимум букв в основе: у города 4 («Кяхт»), у посёлка и села 5 — короткие имена дают ложные совпадения. */
const MIN_STEM_LETTERS_TOWN = 4;
const MIN_STEM_LETTERS_SETTLEMENT = 5;

const parsedMunicipalities = new WeakMap<PriceZoneRecord, readonly Municipality[]>();

function municipalitiesOf(zone: PriceZoneRecord): readonly Municipality[] {
  const cached = parsedMunicipalities.get(zone);
  if (cached !== undefined) return cached;

  const result: Municipality[] = [];
  const seen = new Set<string>();
  // В списке встречается «п/ст. Хужир ,п. Усановка» — запятая без пробела.
  for (const raw of `${zone.center},${zone.municipalities}`.split(/\s*,\s*/u)) {
    const entry = /^([а-яё/-]+)\.\s*(.+)$/iu.exec(raw.trim());
    if (entry === null) continue;
    const type = (entry[1] as string).toLowerCase();
    const name = (entry[2] as string).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (name === "") continue;
    const stems = stemsOf(name);
    const letters = stems.reduce((sum, item) => sum + item.stem.length, 0);
    const min = TOWN_TYPES.has(type) ? MIN_STEM_LETTERS_TOWN : MIN_STEM_LETTERS_SETTLEMENT;
    if (stems.length === 0 || letters < min) continue;

    const key = `${type} ${normalizeRegionText(name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      label: type === "р-н" ? `${name} р-н` : `${type}. ${name}`,
      key,
      type,
      name,
      stems,
      letters,
    });
  }
  parsedMunicipalities.set(zone, result);
  return result;
}

/**
 * Длина совпадения муниципалитета с текстом (буквы совпавших слов), 0 — нет.
 * Слово текста должно начинаться с основы и быть не длиннее основы + 4 буквы:
 * «Кабанск» находит «Кабанского», «Кабанском», но не «Кабанскиеполя». Начало слова
 * обязательно — граница слева даётся разбором по словам.
 */
function matchLength(municipality: Municipality, words: readonly string[]): number {
  return matchStems(municipality.stems, words)?.length ?? 0;
}

/* ---------------------------- Север ---------------------------- */

/**
 * Северность зоны целиком. Субъект северный целиком — любая его зона. Иначе зона считается
 * северной, только если ВСЕ её муниципалитеты верхнего уровня (районы «р-н.», города
 * «г.») относятся к одному виду по перечню (`north.ts`, постановление Правительства РФ N 1946):
 * населённые пункты внутри них (пгт, п., с.) северность не меняют — они лежат в тех же районах.
 * Смешанная зона — обычная территория: назвать Севером всю зону значило бы начислить лишнее.
 *
 * Нужна, когда зону выбрал человек и по закупке муниципалитет не определить, и для населённых
 * пунктов зоны, которых нет в перечне по названию.
 */
export function northOfZone(zone: PriceZoneRecord): { northZone: NorthZone; northBasis: NorthBasis } {
  const subjectNorth = northSubjectOf(zone.subjectName);
  if (subjectNorth === null) return { northZone: "TERRITORY", northBasis: "NONE" };
  if (subjectNorth.whole !== null) {
    return { northZone: subjectNorth.whole === "RKS" ? "RKS" : "MPRKS", northBasis: "SUBJECT" };
  }
  // Разбор без порога длины имени: короткое название района не должно выпасть из проверки.
  const districts: (NorthZone | null)[] = [];
  const cities: (NorthZone | null)[] = [];
  for (const raw of `${zone.center},${zone.municipalities}`.split(/\s*,\s*/u)) {
    const entry = /^([а-яё/-]+)\.\s*(.+)$/iu.exec(raw.trim());
    if (entry === null) continue;
    const type = (entry[1] as string).toLowerCase();
    // Тип «у.» в списках зон — улус-посёлок (Бурятия) или улус-район (Якутия, субъект целиком в перечне): районом не считается.
    if (type !== "р-н" && type !== "г") continue;
    const name = (entry[2] as string).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    (type === "г" ? cities : districts).push(northClassOfUnit(zone.subjectName, type === "г" ? "city" : "district", name));
  }
  // Города в зоне — часто посёлки городского типа внутри района (Бодайбо в Бодайбинском районе): решают районы;
  // города судят, только когда районов в зоне нет.
  const kinds = districts.length > 0 ? districts : cities;
  const first = kinds[0];
  // Список исчерпывающий: все районы зоны вне перечня — обычная территория (определённо), смесь, неизвестный
  // город или пустой список — неизвестно.
  if (first !== undefined && first !== null && kinds.every((kind) => kind === first)) return { northZone: first, northBasis: "ZONE" };
  return { northZone: "TERRITORY", northBasis: "UNDETERMINED" };
}

export function northZoneOfZone(zone: PriceZoneRecord): NorthZone {
  return northOfZone(zone).northZone;
}

/** Северность для выбранной зоны: перечень по тексту закупки, потом по совпавшему муниципалитету, потом по зоне. */
function northFor(
  subject: string,
  words: readonly string[],
  municipality: Municipality | null,
  zone: PriceZoneRecord,
): { northZone: NorthZone; northBasis: NorthBasis } {
  const subjectNorth = northSubjectOf(subject);
  if (subjectNorth === null) return { northZone: "TERRITORY", northBasis: "NONE" };
  if (subjectNorth.whole !== null) {
    return { northZone: subjectNorth.whole === "RKS" ? "RKS" : "MPRKS", northBasis: "SUBJECT" };
  }
  const byText = resolveNorthByText(subject, words);
  if (byText !== null) return { northZone: byText.zone, northBasis: "MUNICIPALITY" };
  if (municipality !== null && (municipality.type === "р-н" || municipality.type === "г")) {
    const unit = northClassOfUnit(subject, municipality.type === "г" ? "city" : "district", municipality.name);
    // Город вне перечня может лежать внутри северного района: тогда судим по зоне.
    if (unit !== null) return { northZone: unit, northBasis: "MUNICIPALITY" };
  }
  return northOfZone(zone);
}

/* ---------------------------- Выбор ---------------------------- */

function subjectNameFor(query: PriceZoneQuery, zones: readonly PriceZoneRecord[]): string | null {
  const names = [...new Set(zones.map((zone) => zone.subjectName))];
  const find = (region: string): string | null => {
    if (region.trim() === "" || region === UNKNOWN_REGION) return null;
    return names.find((name) => isSameRegion(region, name)) ?? null;
  };

  const direct = find(query.region);
  if (direct !== null) return direct;
  // Регион в базе не определён (у половины закупок): пробуем по адресу, но только
  // если регион действительно неизвестен, а не назван и просто не нашёл зон.
  if (regionCodeOf(query.region) !== null) return null;
  const fromAddress = regionFromAddress(query.address ?? "");
  return fromAddress === UNKNOWN_REGION ? null : find(fromAddress);
}

export function resolvePriceZone(
  query: PriceZoneQuery,
  zones: readonly PriceZoneRecord[],
  built: readonly number[],
  zoneIds: ReadonlyMap<string, number>,
): PriceZoneResolution {
  const subject = subjectNameFor(query, zones);
  const unknown = (name: string | null): PriceZoneResolution => ({
    priceZoneId: null,
    zoneName: null,
    subject: name,
    basis: "UNKNOWN_REGION",
    matched: null,
    built: false,
    northZone: "TERRITORY",
    northBasis: "NONE",
    alternatives: alternativesOf(name === null ? [] : zones.filter((zone) => zone.subjectName === name), built, zoneIds, null),
  });
  if (subject === null) return unknown(null);

  const subjectZones = zones.filter((zone) => zone.subjectName === subject);
  if (subjectZones.length === 0) return unknown(subject);

  const answer = (
    zone: PriceZoneRecord,
    basis: PriceZoneBasis,
    matched: string | null,
    north: { northZone: NorthZone; northBasis: NorthBasis },
  ): PriceZoneResolution => {
    const priceZoneId = zoneIds.get(zone.zoneName) ?? null;
    return {
      priceZoneId,
      zoneName: zone.zoneName,
      subject,
      basis,
      matched,
      built: priceZoneId !== null && built.includes(priceZoneId),
      northZone: north.northZone,
      northBasis: north.northBasis,
      alternatives: alternativesOf(subjectZones, built, zoneIds, priceZoneId),
    };
  };

  // Муниципалитет в адресе, названии заказчика или другом тексте.
  const words = normalizeRegionText(
    [query.address, query.customerName, query.extraText].filter((part) => (part ?? "") !== "").join(" . "),
  )
    .split(" ")
    .filter((word) => word !== "");

  const only = subjectZones[0];
  if (subjectZones.length === 1 && only !== undefined) {
    // Одна зона на субъект (Якутия, Мурманская область): северность — по перечню, а не «обычная территория».
    const north = resolveNorth(subject, words);
    return answer(only, "SINGLE_ZONE", null, {
      northZone: north.zone,
      northBasis: north.basis,
    });
  }
  if (words.length > 0) {
    const hits: { zone: PriceZoneRecord; municipality: Municipality; length: number }[] = [];
    for (const zone of subjectZones) {
      let best: { municipality: Municipality; length: number } | null = null;
      for (const municipality of municipalitiesOf(zone)) {
        const length = matchLength(municipality, words);
        if (length > 0 && (best === null || length > best.length)) best = { municipality, length };
      }
      if (best !== null) hits.push({ zone, ...best });
    }
    const longest = Math.max(0, ...hits.map((hit) => hit.length));
    const top = hits.filter((hit) => hit.length === longest);
    // Две зоны с одинаково длинным совпадением (одно и то же село в разных зонах) — не выбираем.
    if (longest > 0 && top.length === 1 && top[0] !== undefined) {
      const { zone, municipality } = top[0];
      return answer(zone, "MUNICIPALITY", municipality.label, northFor(subject, words, municipality, zone));
    }
  }

  // Столица субъекта: зона, в чьём центре или муниципалитетах она есть.
  const capital = capitalOf(subject);
  if (capital !== null) {
    const capitalWords = normalizeRegionText(capital).split(" ");
    const capitalName = capitalWords.join(" ");
    for (const zone of subjectZones) {
      /*
        Сначала точное совпадение с центром зоны: короткие столицы («Чита», «Уфа»)
        отсекаются порогом длины основы в списке муниципалитетов, а центр зоны —
        это ровно то название, которое нужно, и сравнивать его можно целиком.
      */
      const centerName = normalizeRegionText(zone.center.replace(/^[а-яё/-]+\.\s*/iu, ""));
      const inZone =
        centerName === capitalName ||
        municipalitiesOf(zone).some((municipality) => {
          const names = municipality.stems.length;
          return names === capitalWords.length && matchLength(municipality, capitalWords) > 0;
        });
      if (inZone) {
        const subjectNorth = northSubjectOf(subject);
        const capitalNorth =
          subjectNorth === null
            ? ({ northZone: "TERRITORY", northBasis: "NONE" } as const)
            : subjectNorth.whole !== null
              ? ({ northZone: subjectNorth.whole === "RKS" ? "RKS" : "MPRKS", northBasis: "SUBJECT" } as const)
              : (() => {
                  const unit = northClassOfUnit(subject, "city", capital);
                  return unit === null ? northOfZone(zone) : ({ northZone: unit, northBasis: "MUNICIPALITY" } as const);
                })();
        return answer(zone, "CAPITAL", capital, capitalNorth);
      }
    }
  }

  return unknown(subject);
}

/*
  Столицы, которых намеренно нет в REGION_CAPITALS: там они дали бы ложный регион
  при разборе адреса («Благовещенск» есть и в Башкортостане). Здесь субъект уже
  известен, и двусмысленности нет. Без этой строки амурская закупка без адреса
  оставалась без зоны, хотя раньше считалась в ценах 1 зоны.
*/
const PRICE_ZONE_CAPITALS: readonly { readonly subject: string; readonly capital: string }[] = [
  { subject: "Амурская область", capital: "Благовещенск" },
];

function capitalOf(subject: string): string | null {
  const override = PRICE_ZONE_CAPITALS.find((item) => isSameRegion(item.subject, subject));
  if (override !== undefined) return override.capital;
  const entry = REGION_CAPITALS.find((item) => isSameRegion(item.canonical, subject));
  return entry?.aliases[0] ?? null;
}

function alternativesOf(
  subjectZones: readonly PriceZoneRecord[],
  built: readonly number[],
  zoneIds: ReadonlyMap<string, number>,
  exclude: number | null,
): PriceZoneAlternative[] {
  const result: PriceZoneAlternative[] = [];
  for (const zone of subjectZones) {
    const id = zoneIds.get(zone.zoneName);
    if (id === undefined || id === exclude || !built.includes(id)) continue;
    result.push({ priceZoneId: id, zoneName: zone.zoneName });
  }
  return result;
}

/* ------------------------- Подписи для пользователя ------------------------- */

/** Основание выбора зоны словами: «по муниципалитету: Кабанский р-н», «по столице субъекта». */
export function describePriceZoneBasis(choice: {
  readonly basis: PriceZoneBasis;
  readonly matched: string | null;
}): string {
  switch (choice.basis) {
    case "SINGLE_ZONE":
      return "в субъекте одна зона";
    case "MUNICIPALITY":
      return choice.matched === null ? "по муниципалитету" : `по муниципалитету: ${choice.matched}`;
    case "CAPITAL":
      return "по столице субъекта";
    case "USER":
      return "выбрана вручную";
    case "CUSTOMER_ESTIMATE":
      return "по смете заказчика";
    case "CUSTOMER_PRICES":
      return "по ценам сметы заказчика";
    case "UNKNOWN_REGION":
      return "регион закупки не определён";
  }
}

/** «Республика Бурятия (5 зона)» → [«Республика Бурятия», 5]; зона без номера → номер null. */
function splitZoneName(zoneName: string, subject: string): { readonly base: string; readonly number: number | null } {
  const match = /^(.*?)\s*\((\d+)\s*зона\)\s*$/u.exec(zoneName);
  if (match === null) return { base: zoneName.trim() === "" ? subject : zoneName.trim(), number: null };
  return { base: (match[1] as string).trim(), number: Number.parseInt(match[2] as string, 10) };
}

/**
 * Собранные зоны одной фразой: «Республика Бурятия (1–8 зона), Амурская область
 * (1 зона)». Номера подряд сворачиваются в диапазон, остальные перечисляются.
 */
export function describeBuiltZones(zones: readonly { readonly zoneName: string; readonly subject: string }[]): string {
  if (zones.length === 0) return "ни одной";
  const groups = new Map<string, number[]>();
  const order: string[] = [];
  for (const zone of zones) {
    const { base, number } = splitZoneName(zone.zoneName, zone.subject);
    if (!groups.has(base)) {
      groups.set(base, []);
      order.push(base);
    }
    if (number !== null) (groups.get(base) as number[]).push(number);
  }
  return order
    .map((base) => {
      const numbers = [...new Set(groups.get(base) as number[])].sort((a, b) => a - b);
      if (numbers.length === 0) return base;
      const parts: string[] = [];
      for (let i = 0; i < numbers.length; ) {
        let j = i;
        while (j + 1 < numbers.length && (numbers[j + 1] as number) === (numbers[j] as number) + 1) j += 1;
        parts.push(j - i >= 2 ? `${String(numbers[i])}–${String(numbers[j])}` : numbers.slice(i, j + 1).join(", "));
        i = j + 1;
      }
      return `${base} (${parts.join(", ")} зона)`;
    })
    .join(", ");
}
