import { baseUnitOf } from "@/domain/estimate/units";

/**
 * Шифры расценок ГЭСН из распознанного текста.
 *
 * Зачем. В смете заказчика напротив каждой работы стоит шифр расценки, и это
 * лучшая подсказка для подбора нормы: поиск по наименованию выбирает «похожую»,
 * шифр называет ту самую. Но смета часто приходит сканом, и распознавание портит
 * шифр так, что человек читает его без труда, а база — нет: «F9CH46-06-909-03»
 * вместо «ГЭСН46-06-009-03», «F3CH01-02-027-02» вместо «ГЭСН01-02-027-02».
 *
 * Что восстанавливается и чем это проверяется.
 *
 * Префикс — по таблице двойников: «F9CH», «F3CH», «ГЗСН», «I'ЭСН» читаются как
 * «ГЭСН». Это не догадка о содержании: префикс сам по себе ничего не решает,
 * решает код.
 *
 * Цифры — только против базы. Распознавание путает 0 и 9, 3 и 8, 5 и 6, 1 и 7, и
 * шифр 46-06-909-03 — это 46-06-009-03. Код сначала ищется как есть; не нашёлся —
 * пробуем замены в одной цифре, затем в двух. Принимается вариант, только если
 * он единственный и единица его нормы совпадает с единицей строки: два
 * подходящих кода — это уже выбор, а выбирать за сметчика молча нельзя.
 */

/** Книга ГЭСН, как она называется в базе. */
export type GesnBook = "ГЭСН" | "ГЭСНм" | "ГЭСНр" | "ГЭСНп" | "ГЭСНмр";

/** Шифр, прочитанный из текста: ещё не сверенный с базой. */
export interface NormCodeHint {
  /** Книга; null — префикс не прочитан или его нет. */
  readonly baseType: GesnBook | null;
  /** Код в виде «46-06-909-03» — как прочитан, без исправлений. */
  readonly code: string;
  /** Фрагмент текста, из которого шифр прочитан. */
  readonly raw: string;
  /**
   * Базисно-индексный метод: книга расценок, если шифр стоит с префиксом «ФЕР», «ФЕРм», «ФЕРр», «ФЕРп», «ФЕРмр» или «ТЕР…»:
   * `base` — «ФЕР» или «ТЕР», `book` — книга ФЕР-2020 (у ТЕР книга не нужна: расчёт идёт по ФЕР). Нет поля — префикс не ФЕР/ТЕР.
   */
  readonly fer?: { readonly base: "ФЕР" | "ТЕР"; readonly book: "ФЕР" | "ФЕРм" | "ФЕРр" | "ФЕРп" | "ФЕРмр" };
}

const FER_PREFIX = /(ФЕР|ТЕР)(мр|м|р|п)?[\s\-–]*$/u;

/** Код ГЭСН: четыре группы цифр «46-06-009-03». */
const GESN_CODE = /(?<!\d)(?<!\d-)(\d{2}-\d{2}-\d{3}-\d{2})(?!\d)(?!-\d)/;

/** Двойники букв префикса: латиница, цифры и значки, в которые превращаются «Г», «Э», «С», «Н». */
const PREFIX_FOLD: Readonly<Record<string, string>> = {
  F: "Г",
  I: "Г",
  "9": "Э",
  "3": "Э",
  З: "Э",
  C: "С",
  H: "Н",
  M: "М",
  P: "Р",
  E: "Е",
  T: "Т",
};

const BOOKS: Readonly<Record<string, GesnBook>> = {
  ГЭСН: "ГЭСН",
  ГЭСНМ: "ГЭСНм",
  ГЭСНР: "ГЭСНр",
  ГЭСНП: "ГЭСНп",
  ГЭСНМР: "ГЭСНмр",
};

/** Книга по префиксу, как его напечатали или исказило распознавание. null — не ГЭСН. */
export function gesnBookOfPrefix(rawPrefix: string): GesnBook | null {
  const letters = rawPrefix
    .toUpperCase()
    .replace(/[\s'’`"«».:;,\-–]/g, "");
  if (letters === "") return null;
  let folded = "";
  for (const char of letters) folded += PREFIX_FOLD[char] ?? char;
  return BOOKS[folded] ?? null;
}

/**
 * Шифр ГЭСН в тексте обоснования.
 *
 * Ищется код из четырёх групп цифр, а перед ним — приклеенный префикс. Префикс
 * не прочитан — книга остаётся неизвестной, и база решит по коду, если он есть
 * только в одной книге.
 */
export function parseNormCodeHint(text: string | undefined | null): NormCodeHint | null {
  if (text === undefined || text === null) return null;
  const match = GESN_CODE.exec(text);
  if (match === null) return null;

  const code = match[1] as string;
  const before = text.slice(0, match.index);
  const prefix = /(\S{1,8})[\s\-–]*$/.exec(before);
  const baseType = prefix === null ? null : gesnBookOfPrefix(prefix[1] as string);
  const rawStart = prefix !== null && baseType !== null ? prefix.index : match.index;

  const fer = baseType === null ? FER_PREFIX.exec(before) : null;
  const hint: NormCodeHint = {
    baseType,
    code,
    raw: text.slice(Math.max(0, rawStart), match.index + code.length).trim(),
  };
  if (fer === null) return hint;
  const suffix = (fer[2] ?? "") as "" | "м" | "р" | "п" | "мр";
  return { ...hint, fer: { base: fer[1] as "ФЕР" | "ТЕР", book: `ФЕР${suffix}` as "ФЕР" | "ФЕРм" | "ФЕРр" | "ФЕРп" | "ФЕРмр" } };
}

/** Цифры, которые распознавание путает между собой. Связь симметрична. */
const DIGIT_CONFUSIONS: Readonly<Record<string, readonly string[]>> = {
  "0": ["9", "8", "6"],
  "9": ["0", "8"],
  "8": ["3", "0", "9", "6"],
  "3": ["8"],
  "6": ["5", "0", "8"],
  "5": ["6"],
  "1": ["7"],
  "7": ["1"],
};

/** Все коды, получаемые заменой ровно `count` цифр на их двойников. Исходный код не входит. */
function substitutions(code: string, count: number): string[] {
  const positions: number[] = [];
  for (let index = 0; index < code.length; index += 1) {
    if (DIGIT_CONFUSIONS[code[index] as string] !== undefined) positions.push(index);
  }

  const result = new Set<string>();
  const walk = (from: number, left: number, current: string): void => {
    if (left === 0) {
      if (current !== code) result.add(current);
      return;
    }
    for (let at = from; at < positions.length; at += 1) {
      const position = positions[at] as number;
      for (const replacement of DIGIT_CONFUSIONS[code[position] as string] ?? []) {
        walk(
          at + 1,
          left - 1,
          current.slice(0, position) + replacement + current.slice(position + 1),
        );
      }
    }
  };
  walk(0, count, code);
  return [...result];
}

/** Норма, найденная в базе: достаточно того, что нужно для сверки. */
export interface CatalogNorm {
  readonly code: string;
  readonly baseType: string;
  readonly unit: string;
}

/** Каталог норм для сверки шифра. Подменяется в тестах «базой» из пары записей. */
export interface NormCatalog {
  /** Нормы с таким кодом; без книги — по всем книгам. */
  lookup(code: string, baseType: string | null): readonly CatalogNorm[];
}

export type NormCodeResolution =
  /** Код есть в базе как написан. */
  | { readonly status: "EXACT"; readonly norm: CatalogNorm }
  /** Код исправлен заменой цифр, вариант единственный, единица сошлась. */
  | {
      readonly status: "RESTORED";
      readonly norm: CatalogNorm;
      readonly from: string;
      readonly substitutions: number;
    }
  /** Подходящих вариантов несколько: выбирать за сметчика нельзя. */
  | { readonly status: "AMBIGUOUS"; readonly candidates: readonly string[] }
  | { readonly status: "NOT_FOUND" };

/**
 * Совпадает ли единица нормы с единицей строки: по основной величине, без
 * множителя. «100 м3 строительного объема» и «м3» — одна величина; «т» и «м3» —
 * нет.
 */
export function unitsCompatible(
  normUnit: string,
  rowUnits: readonly string[],
): boolean {
  const normBase = baseUnitOf(normUnit) ?? normUnit.trim().toLowerCase();
  return rowUnits.some((unit) => {
    const rowBase = baseUnitOf(unit) ?? unit.trim().toLowerCase();
    return rowBase === normBase;
  });
}

/**
 * Сверяет прочитанный шифр с базой и при необходимости исправляет цифры.
 *
 * `rowUnits` — единицы строки (у парного объёма их несколько). Без единиц
 * исправление цифр не делается вовсе: нечем отличить настоящий вариант от
 * случайно существующего кода.
 */
export function resolveNormCode(
  hint: Pick<NormCodeHint, "code"> & { readonly baseType: string | null },
  rowUnits: readonly string[],
  catalog: NormCatalog,
): NormCodeResolution {
  const exact = catalog.lookup(hint.code, hint.baseType);
  if (exact.length === 1) return { status: "EXACT", norm: exact[0] as CatalogNorm };
  if (exact.length > 1) {
    // Книга не прочитана, а код есть в нескольких: сужаем единицей строки.
    const narrowed = exact.filter((norm) => unitsCompatible(norm.unit, rowUnits));
    if (narrowed.length === 1) return { status: "EXACT", norm: narrowed[0] as CatalogNorm };
    return {
      status: "AMBIGUOUS",
      candidates: exact.map((norm) => `${norm.baseType} ${norm.code}`),
    };
  }

  if (rowUnits.length === 0) return { status: "NOT_FOUND" };

  for (const count of [1, 2]) {
    const found = new Map<string, CatalogNorm>();
    for (const variant of substitutions(hint.code, count)) {
      for (const norm of catalog.lookup(variant, hint.baseType)) {
        if (unitsCompatible(norm.unit, rowUnits)) {
          found.set(`${norm.baseType}|${norm.code}`, norm);
        }
      }
    }
    if (found.size === 1) {
      return {
        status: "RESTORED",
        norm: [...found.values()][0] as CatalogNorm,
        from: hint.code,
        substitutions: count,
      };
    }
    if (found.size > 1) {
      return {
        status: "AMBIGUOUS",
        candidates: [...found.values()].map((norm) => `${norm.baseType} ${norm.code}`),
      };
    }
  }
  return { status: "NOT_FOUND" };
}
