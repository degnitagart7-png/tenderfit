/**
 * Единицы измерения ведомости объёмов: распознавание, в том числе после OCR.
 *
 * Зачем отдельный модуль. Локальную смету заказчика часто присылают сканом, и
 * распознавание искажает единицу так, что человек её читает без труда, а
 * таблица синонимов — нет: «100 m3» с латинской «m», «мз» вместо «м3», «1тгруза»
 * вместо «1 т груза». Каждая такая строка раньше выбывала с причиной
 * UNKNOWN_UNIT, и на закупке 0134600012126000001 из сметы заказчика выпали все
 * главные работы: разборка здания, планировка, вывоз и размещение мусора.
 *
 * Принцип прежний: список написаний закрытый и ведётся руками, единицу «по
 * похожести» не угадываем. «т» и «тыс.» отличаются одной буквой и тысячей раз —
 * ошибка здесь стоит сметы, завышенной на три порядка. Новое — только то, что
 * восстанавливается без догадки: латинская буква на месте кириллической той же
 * формы, «з» на месте тройки в слове из двух знаков «м?», описательный хвост
 * («груза», «строительного объема»), который единицей не является.
 */

/** Единица, приведённая к виду ФСНБ, и множитель «100», «1000» перед ней. */
export interface ParsedUnit {
  readonly unit: string;
  readonly multiplier: number;
}

/*
  Написания единиц, которые встречаются в ведомостях.

  Чего здесь нет, то отправляется в отказ с причиной UNKNOWN_UNIT и видно
  человеку.
*/
const UNIT_ALIASES: ReadonlyMap<string, string> = new Map([
  ["м3", "м3"],
  ["м³", "м3"],
  ["куб.м", "м3"],
  ["куб м", "м3"],
  ["кубм", "м3"],
  ["м.куб.", "м3"],
  ["м куб", "м3"],
  // OCR: тройка распознана как «з»: «мз», «мЗ», «м з». Только как вся единица.
  ["мз", "м3"],
  ["м2", "м2"],
  ["м²", "м2"],
  ["кв.м", "м2"],
  ["кв м", "м2"],
  ["квм", "м2"],
  ["м.кв.", "м2"],
  ["м", "м"],
  ["пм", "м"],
  ["п.м.", "м"],
  ["пог.м", "м"],
  ["пог м", "м"],
  ["погм", "м"],
  ["м.п.", "м"],
  ["мп", "м"],
  ["км", "км"],
  ["шт", "шт"],
  ["шт.", "шт"],
  ["штук", "шт"],
  ["штука", "шт"],
  ["т", "т"],
  ["тн", "т"],
  ["тонн", "т"],
  ["тонна", "т"],
  ["кг", "кг"],
  ["компл", "компл"],
  ["компл.", "компл"],
  // OCR съедает «л»: «комп.».
  ["комп", "компл"],
  ["комп.", "компл"],
  ["комплект", "компл"],
  ["м2поверхности", "м2"],
  ["место", "шт"],
  ["ед", "шт"],
  ["ед.", "шт"],
]);

/**
 * Единицы, которые умеет разбирать расчёт, в каноническом написании и без повторов:
 * список для выбора единицы при правке ведомости. Берётся из той же таблицы синонимов,
 * поэтому всё, что человек выберет, `parseUnit` узнает.
 */
export const SUPPORTED_UNITS: readonly string[] = [...new Set(UNIT_ALIASES.values())];

/** Те же ключи без точек, дефисов и пробелов: «куб.м» и «куб. м» — одно написание. */
const DOTLESS_ALIASES: ReadonlyMap<string, string> = (() => {
  const result = new Map<string, string>();
  for (const [key, unit] of UNIT_ALIASES) {
    const dotless = key.replace(/[.\-\s]/g, "");
    if (dotless !== "" && !result.has(dotless)) result.set(dotless, unit);
  }
  return result;
})();

/*
  Описательные хвосты единицы. В ФСНБ они есть у нормы («100 м3 строительного
  объема», «т груза»), а в смете заказчика после распознавания приклеиваются к
  единице («1тгруза»). Хвост единицей не является: объём и в том, и в другом
  случае считается в основной величине. Список закрытый.
*/
const UNIT_DESCRIPTORS: readonly string[] = [
  "горизонтальной проекции",
  "строительного объема",
  "строительного объёма",
  "площади застройки",
  "поверхности",
  "траншеи",
  "грунта",
  "груза",
].sort((a, b) => b.length - a.length);

/**
 * Латинские буквы, неотличимые на скане от кириллических. Применяется только к
 * короткой строке единицы: в тексте документа чужая буква могла бы быть чужой.
 */
const LATIN_LOOKALIKES: Readonly<Record<string, string>> = {
  a: "а",
  b: "в",
  c: "с",
  e: "е",
  h: "н",
  k: "к",
  m: "м",
  o: "о",
  p: "р",
  t: "т",
  x: "х",
  y: "у",
};

/** Заменяет латинские двойники кириллических букв. Регистр на входе должен быть нижним. */
export function foldLookalikes(lowerText: string): string {
  let result = "";
  for (const char of lowerText) result += LATIN_LOOKALIKES[char] ?? char;
  return result;
}

/** «маш.-ч» и «чел.-ч» с искажениями: «маш.ч», «чел-ч», «маш.-4». */
const HOURS_UNIT = /^(маш|чел)[\s.\-–—]*(?:ч|4|час|часов)\.?$/;

/** Приводит единицу к виду ФСНБ и отделяет множитель «100», «1000». */
export function parseUnit(raw: string): ParsedUnit | null {
  const lowered = raw
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (lowered === "") return null;

  let cleaned = foldLookalikes(lowered);
  for (const descriptor of UNIT_DESCRIPTORS) {
    if (cleaned.length > descriptor.length && cleaned.endsWith(descriptor)) {
      cleaned = cleaned.slice(0, cleaned.length - descriptor.length).trim();
      break;
    }
  }

  const withMultiplier = /^(\d[\d\s]*)\s*(.+)$/.exec(cleaned);
  const multiplierRaw = withMultiplier?.[1]?.replace(/\s/g, "");
  const rest = withMultiplier?.[2] ?? cleaned;
  const multiplier =
    multiplierRaw === undefined ? 1 : Number.parseInt(multiplierRaw, 10);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;

  const hours = HOURS_UNIT.exec(rest);
  if (hours !== null) return { unit: `${hours[1] as string}.-ч`, multiplier };

  const key = rest.replace(/\s+/g, "");
  const unit =
    UNIT_ALIASES.get(key) ??
    UNIT_ALIASES.get(rest) ??
    UNIT_ALIASES.get(key.replace(/[.,;:]+$/, "")) ??
    DOTLESS_ALIASES.get(key.replace(/[.\-,;:]/g, ""));
  if (unit === undefined) return null;

  return { unit, multiplier };
}

/**
 * Парная единица: «м3/т», «м2/м3/т». Части — через косую черту, каждая
 * распознаётся отдельно; хоть одна не узнана — вся единица не парная.
 *
 * Особый случай: «м/т». В таблицах «объём и вес мусора» распознавание теряет
 * тройку у «м3», а пары «погонные метры / тонны» в таких таблицах не бывает. Это
 * единственная подстановка цифры, и она держится на словах «м/т» целиком.
 */
export function parseUnitPair(raw: string): ParsedUnit[] | null {
  if (!raw.includes("/")) return null;
  const parts = raw.split("/").map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => part === "")) return null;

  const normalized = parts.map((part) => foldLookalikes(part.toLowerCase()));
  const fixed =
    normalized.length === 2 && normalized[0] === "м" && normalized[1] === "т"
      ? ["м3", "т"]
      : normalized;

  const parsed: ParsedUnit[] = [];
  for (const part of fixed) {
    const unit = parseUnit(part);
    if (unit === null) return null;
    parsed.push(unit);
  }
  return parsed;
}

/**
 * Единица, которой задана вся работа целиком: «Условная единица», «усл. ед.»,
 * «объект». Объём «1 усл. ед.» — это не количество работы, а ярлык на всю
 * позицию: умножать расценку не на что.
 */
export function isWholeWorkUnit(raw: string): boolean {
  const cleaned = raw.replace(/\s+/g, " ").trim().toLowerCase();
  return /^(?:усл(?:овн\p{L}*)?\.?\s*ед(?:иниц\p{L}*)?\.?|объект)$/u.test(cleaned);
}

/*
  Денежные единицы.

  В договоре есть таблицы «нарушение — штраф — рублей», и модель принимает их за
  ведомость: по форме это то же «наименование, число, единица». Отдельная
  причина отказа нужна, чтобы человек в отчёте видел «это сумма, а не работа», а
  не думал, что разбор не знает единицу «рублей».
*/
const MONEY_UNITS: ReadonlySet<string> = new Set([
  "руб",
  "руб.",
  "рубль",
  "рублей",
  "рубля",
  "₽",
  "тыс.руб",
  "тыс.руб.",
  "тысруб",
  "млнруб",
  "%",
  "процент",
  "процентов",
]);

/** Денежная ли единица: такую строку считать объёмом нельзя. */
export function isMoneyUnit(raw: string): boolean {
  // `\s` в JS покрывает и неразрывный пробел, отдельной замены не нужно.
  return MONEY_UNITS.has(raw.replace(/\s+/g, "").toLowerCase());
}

/**
 * Делитель перевода объёма ведомости в единицу нормы.
 *
 * «м3» в ведомости и «100 м3» в норме дают 100: объём делится на сто. Разные
 * базовые единицы дают null — перевод между «м2» и «т» существует только через
 * плотность и толщину, которых в ведомости нет, и догадываться о них нельзя.
 */
export function deriveUnitDivisor(
  billUnit: string,
  normUnit: string,
): number | null {
  const bill = parseUnit(billUnit);
  const norm = parseUnit(normUnit);
  if (bill === null || norm === null) return null;
  if (bill.unit !== norm.unit) return null;
  return norm.multiplier / bill.multiplier;
}

/** Кратные единицы одной величины: во сколько базовых единиц (кг, м) входит единица. Только точные соотношения. */
const SCALED_UNITS: ReadonlyArray<Readonly<Record<string, number>>> = [
  { т: 1000, кг: 1 },
  { км: 1000, м: 1 },
];

/**
 * Делитель объёма поставки (материал, оборудование) в единицу цены справочника.
 *
 * Шире `deriveUnitDivisor`: к масштабу «1000 м», «100 шт» добавляет перевод внутри одной величины, где соотношение
 * точное — «кг» ↔ «т», «м» ↔ «км». Цена поставки — одна цена на объём, и «т» против «кг» без перевода — ошибка в тысячу раз.
 * Разные величины («м2» и «т») по-прежнему null: через плотность и толщину не переводим.
 */
export function deriveSupplyDivisor(billUnit: string, priceUnit: string): number | null {
  const direct = deriveUnitDivisor(billUnit, priceUnit);
  if (direct !== null) return direct;
  const bill = parseUnit(billUnit);
  const price = parseUnit(priceUnit);
  if (bill === null || price === null) return null;
  for (const scale of SCALED_UNITS) {
    const billScale = scale[bill.unit];
    const priceScale = scale[price.unit];
    if (billScale === undefined || priceScale === undefined) continue;
    return (price.multiplier * priceScale) / (bill.multiplier * billScale);
  }
  return null;
}

/** Базовая единица без множителя и хвоста: «100 м3 строительного объема» → «м3». */
export function baseUnitOf(raw: string): string | null {
  return parseUnit(raw)?.unit ?? null;
}
