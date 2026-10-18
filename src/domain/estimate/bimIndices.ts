import bundledQ3y2026 from "./normativesData/bim-indices-2026q3.json";
import type {
  BimBase,
  BimElement,
  BimElementRecord,
  BimIndicesData,
  BimLetterInfo,
  BimSmrRecord,
} from "@/domain/estimate/bimIndicesTypes";
import { resolveSubject } from "@/domain/estimate/bimSubjects";

/**
 * Справочник индексов БИМ: поиск индекса письма Минстроя по кварталу, субъекту (зоне), объекту строительства и базе
 * расценок, и определение объекта строительства по наименованию стройки.
 *
 * Что здесь решено явно, а не по умолчанию:
 * - квартал — часть ключа: смета в ценах II квартала сверяется с письмом II квартала, а не с последним; нет письма за
 *   этот квартал — ответ «нет письма», а не индекс другого квартала;
 * - зона: у субъекта несколько зон — нужна одна из них; зона не названа, а в письме зоны есть, — это неоднозначность,
 *   которая возвращается вместе со списком зон, а не выбор первой;
 * - объект строительства определяется только однозначно: «жилой дом» без материала стен подходит четырём объектам,
 *   и тогда объект не назначается, а кандидаты возвращаются для справки.
 */

export const BUNDLED_BIM_INDICES: readonly BimIndicesData[] = [bundledQ3y2026 as unknown as BimIndicesData];

export interface BimQuarterKey {
  readonly year: number;
  readonly quarter: number;
}

export const quarterKey = (quarter: BimQuarterKey): string => `${String(quarter.year)}q${String(quarter.quarter)}`;

export function quarterLabel(quarter: BimQuarterKey): string {
  const roman = ["", "I", "II", "III", "IV"][quarter.quarter] ?? String(quarter.quarter);
  return `${roman} кв. ${String(quarter.year)}`;
}

/** Одно письмо вместе с кварталом: для ссылки в находке («письмо № 46728-ИФ/09 от 30.07.2026»). */
export interface BimLetterRef {
  readonly info: BimLetterInfo;
  readonly quarter: BimQuarterKey;
}

export interface BimIndexBook {
  readonly quarters: readonly BimQuarterKey[];
  /** Все справочники по кварталам. */
  readonly byQuarter: ReadonlyMap<string, BimIndicesData>;
  elements(quarter: BimQuarterKey): readonly BimElementRecord[];
  letter(quarter: BimQuarterKey, id: string): BimLetterRef | null;
}

/** Книга индексов из справочников; для квартала с несколькими справочниками (встроенный и серверный) побеждает последний в списке: серверный идёт после встроенного. */
export function createBimIndexBook(datasets: readonly BimIndicesData[]): BimIndexBook {
  const byQuarter = new Map<string, BimIndicesData>();
  // Серверный файл квартала идёт после встроенного и заменяет его целиком: он собран из свежего набора писем.
  for (const dataset of datasets) byQuarter.set(quarterKey(dataset.quarter), dataset);
  const quarters = [...byQuarter.values()]
    .map((dataset) => ({ year: dataset.quarter.year, quarter: dataset.quarter.quarter }))
    .sort((a, b) => b.year - a.year || b.quarter - a.quarter);

  const indexed = new Map<string, readonly BimElementRecord[]>();
  return {
    quarters,
    byQuarter,
    elements: (quarter) => {
      const key = quarterKey(quarter);
      let list = indexed.get(key);
      if (list === undefined) {
        list = byQuarter.get(key)?.elements ?? [];
        indexed.set(key, list);
      }
      return list;
    },
    letter: (quarter, id) => {
      const dataset = byQuarter.get(quarterKey(quarter));
      const info = dataset?.letters.find((letter) => letter.id === id);
      return info === undefined ? null : { info, quarter: { year: quarter.year, quarter: quarter.quarter } };
    },
  };
}

export const bundledBimIndexBook = (): BimIndexBook => createBimIndexBook(BUNDLED_BIM_INDICES);

/** Письмо словами: «письмо Минстроя России от 30.07.2026 № 46728-ИФ/09». */
export function describeLetter(info: BimLetterInfo): string {
  const [year, month, day] = info.date.split("-");
  return `письмо Минстроя России от ${day ?? "??"}.${month ?? "??"}.${year ?? "????"} № ${info.number}`;
}

export type BimIndexLookup =
  | {
      readonly status: "FOUND";
      readonly record: BimElementRecord;
      readonly letter: BimLetterRef | null;
      /** Значение берётся из ТЕР, а искали ФЕР (или наоборот): индексы к ТЕР у субъекта могут отсутствовать. */
      readonly base: BimBase;
    }
  | { readonly status: "NO_QUARTER"; readonly available: readonly BimQuarterKey[] }
  | { readonly status: "NO_SUBJECT" }
  | { readonly status: "NO_OBJECT"; readonly objects: readonly string[] }
  | { readonly status: "ZONE_AMBIGUOUS"; readonly zones: readonly number[] }
  | { readonly status: "NO_BASE" }
  | { readonly status: "NO_VALUES" };

export interface BimIndexQuery {
  readonly quarter: BimQuarterKey;
  /** Название субъекта или зоны в любой форме: «Иркутская область (1 зона)», «г. Москва». */
  readonly subject: string;
  readonly zone: number | null;
  readonly object: string;
  readonly base: BimBase;
}

/** Нормализация названия объекта для сравнения: без регистра, «ё» и пунктуации. */
export function objectKey(object: string): string {
  return object.toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z0-9]+/g, " ").trim();
}

/**
 * Индексы по элементам для объекта. Точное имя объекта (как в справочнике) или одноименный по ключу; запись ищется по
 * базе: ФЕР — верхняя строка письма, ТЕР — нижняя; записи нужной базы нет — `NO_BASE`, выбирать другую за вызывающего нельзя.
 */
export function findElementIndex(book: BimIndexBook, query: BimIndexQuery): BimIndexLookup {
  const key = quarterKey(query.quarter);
  if (!book.byQuarter.has(key)) return { status: "NO_QUARTER", available: book.quarters };
  const subject = resolveSubject(query.subject);
  if (subject === null) return { status: "NO_SUBJECT" };

  const records = book.elements(query.quarter).filter((record) => record.subject === subject);
  if (records.length === 0) return { status: "NO_SUBJECT" };

  const wanted = objectKey(query.object);
  const ofObject = records.filter((record) => objectKey(record.object) === wanted);
  if (ofObject.length === 0) return { status: "NO_OBJECT", objects: [...new Set(records.map((record) => record.object))] };

  const ofBase = ofObject.filter((record) => record.base === query.base);
  if (ofBase.length === 0) return { status: "NO_BASE" };

  const zones = [...new Set(ofBase.map((record) => record.zone))];
  let candidates = ofBase;
  if (query.zone !== null) {
    const exact = ofBase.filter((record) => record.zone === query.zone);
    // Письмо без зон для субъекта с одной зоной: зона из сметы игнорируется.
    candidates = exact.length > 0 ? exact : ofBase.filter((record) => record.zone === null);
    if (candidates.length === 0) return { status: "ZONE_AMBIGUOUS", zones: zones.filter((zone): zone is number => zone !== null) };
  } else if (zones.length > 1 || zones[0] !== null) {
    const unzoned = ofBase.filter((record) => record.zone === null);
    if (unzoned.length === 0) return { status: "ZONE_AMBIGUOUS", zones: zones.filter((zone): zone is number => zone !== null) };
    candidates = unzoned;
  }

  // Несколько писем с одной записью (в справочнике уже слиты; здесь — страховка): берём любую, значения у слитых одинаковы.
  const record = candidates[0] as BimElementRecord;
  if (record.labour === null && record.materials === null && record.machines === null) return { status: "NO_VALUES" };
  return { status: "FOUND", record, letter: book.letter(query.quarter, record.letter), base: record.base };
}

export const ELEMENT_OF_RECORD: Readonly<Record<BimElement, keyof Pick<BimElementRecord, "labour" | "materials" | "machines">>> = {
  LABOUR: "labour",
  MATERIALS: "materials",
  MACHINES: "machines",
};

/** Индекс СМР в целом (ж/д, дороги, СМР и ПНР) по субъекту/зоне/объекту, если есть. */
export function findSmrIndex(
  book: BimIndexBook,
  query: { readonly quarter: BimQuarterKey; readonly subject: string; readonly zone: number | null; readonly object: string; readonly base: BimBase },
): BimSmrRecord | null {
  const dataset = book.byQuarter.get(quarterKey(query.quarter));
  const subject = resolveSubject(query.subject);
  if (dataset === undefined || subject === null) return null;
  const wanted = objectKey(query.object);
  return (
    dataset.smr.find(
      (record) =>
        record.subject === subject &&
        record.base === query.base &&
        objectKey(record.object) === wanted &&
        (record.zone === query.zone || (record.zone === null && query.zone === null)),
    ) ?? null
  );
}

/* ------------------------------ Объект строительства по наименованию ------------------------------ */

export interface BimObjectRule {
  readonly object: string;
  /** Достаточно любого из выражений. */
  readonly patterns: readonly RegExp[];
}

/**
 * Объекты справочника писем и слова, по которым стройку к ним относят. «Прочие» (прочие жилые дома, прочие школы) и
 * «Прочие объекты» сюда не входят: прочее — это то, что ни под одно слово не подошло, и назначать его по наименованию значило
 * бы угадывать.
 */
export const BIM_OBJECT_RULES: readonly BimObjectRule[] = [
  { object: "Многоквартирные жилые дома: Кирпичные", patterns: [/(?:многоквартирн|жил[а-я]+\s+дом|жил[а-я]+\s+здан|жилой\s+комплекс|(?<![а-яё])МКД(?![а-яё]))[^.;]{0,60}кирпич|кирпичн[а-я]+\s+(?:многоквартирн|жил)/iu] },
  { object: "Многоквартирные жилые дома: Панельные", patterns: [/(?:многоквартирн|жил[а-я]+\s+дом|жил[а-я]+\s+здан|(?<![а-яё])МКД(?![а-яё]))[^.;]{0,60}панел|панельн[а-я]+\s+(?:многоквартирн|жил)/iu] },
  { object: "Многоквартирные жилые дома: Монолитные", patterns: [/(?:многоквартирн|жил[а-я]+\s+дом|жил[а-я]+\s+здан|(?<![а-яё])МКД(?![а-яё]))[^.;]{0,60}монолит|монолитн[а-я]+\s+(?:многоквартирн|жил)/iu] },
  { object: "Объекты образования: Школы", patterns: [/(?<![а-яё])(?:общеобразовательн[а-я]+\s+)?школ[а-яё]*(?![а-яё])|общеобразовательн/iu] },
  { object: "Объекты образования: Детские сады", patterns: [/детск[а-яё]+\s+сад|(?<![а-яё])ДОУ(?![а-яё])|дошкольн[а-я]+\s+(?:образовательн|учрежден|организаци)/iu] },
  { object: "Объекты здравоохранения: Поликлиники", patterns: [/поликлиник|амбулатори/iu] },
  { object: "Объекты здравоохранения: Больницы", patterns: [/больниц|госпитал|стационар|родильн|медицинск[а-я]+\s+центр/iu] },
  { object: "Административные здания", patterns: [/административн[а-я]+\s+здани|офисн[а-я]+\s+здани|здание\s+администрации/iu] },
  { object: "Объекты спортивного назначения", patterns: [/спортивн|стадион|физкультурно|ледов[а-я]+\s+арен|бассейн/iu] },
  { object: "Объекты культуры", patterns: [/дом[а-я]*\s+культуры|(?<![а-яё])клуб|театр|музе[йя]|библиотек|кинотеатр/iu] },
  { object: "Котельные", patterns: [/котельн/iu] },
  { object: "Очистные сооружения", patterns: [/очистн[а-я]+\s+сооружен|(?<![а-яё])КОС(?![а-яё])|(?<![а-яё])БОС(?![а-яё])/iu] },
  { object: "Внешние инженерные сети теплоснабжения", patterns: [/тепловы[а-я]+\s+сет|теплосет|теплоснабжени/iu] },
  { object: "Внешние инженерные сети водопровода", patterns: [/водопровод|водоснабжени/iu] },
  { object: "Внешние инженерные сети канализации", patterns: [/канализаци|водоотведени/iu] },
  { object: "Внешние инженерные сети газоснабжения", patterns: [/газопровод|газоснабжени/iu] },
  { object: "Сети наружного освещения", patterns: [/наружн[а-я]+\s+освещени/iu] },
];

export interface DetectedObject {
  /** Объект справочника, если подошёл ровно один. */
  readonly object: string | null;
  /** Все подошедшие объекты: для справки, когда однозначно не вышло. */
  readonly candidates: readonly string[];
  /** Слова наименования, по которым объект подобран. */
  readonly matched: string | null;
  /** Почему не назначен. */
  readonly reason: string | null;
}

/** Группы, по которым «жилой дом» без материала стен не назначается, но кандидаты называются. */
const GENERIC_HOUSING = /(?:многоквартирн[а-я]+\s+)?жил[а-я]+\s+(?:дом|здани)|(?<![а-яё])МКД(?![а-яё])/iu;

/**
 * Объект строительства по наименованию стройки (и, если нужно, названию сметы). Назначается только один однозначный
 * объект; иначе `object: null` с причиной — вывод по индексам тогда не делается, остаётся справка.
 */
export function detectBimObject(text: string): DetectedObject {
  const matches: Array<{ object: string; matched: string }> = [];
  for (const rule of BIM_OBJECT_RULES) {
    for (const pattern of rule.patterns) {
      const found = pattern.exec(text);
      if (found !== null) {
        matches.push({ object: rule.object, matched: found[0].replace(/\s+/g, " ").trim() });
        break;
      }
    }
  }
  const objects = [...new Set(matches.map((match) => match.object))];
  if (objects.length === 1) {
    return { object: objects[0] as string, candidates: objects, matched: (matches[0] as { matched: string }).matched, reason: null };
  }
  if (objects.length > 1) {
    return {
      object: null,
      candidates: objects,
      matched: null,
      reason: `в наименовании названо несколько объектов (${objects.join("; ")}) — какой из них главный, по тексту не определить`,
    };
  }
  if (GENERIC_HOUSING.test(text)) {
    return {
      object: null,
      candidates: [
        "Многоквартирные жилые дома: Кирпичные",
        "Многоквартирные жилые дома: Панельные",
        "Многоквартирные жилые дома: Монолитные",
        "Многоквартирные жилые дома: Прочие",
      ],
      matched: null,
      reason: "жилой дом назван без материала стен (кирпичные, панельные, монолитные) — индексы у них разные",
    };
  }
  return { object: null, candidates: [], matched: null, reason: "по наименованию стройки объект строительства из писем Минстроя не определяется" };
}
