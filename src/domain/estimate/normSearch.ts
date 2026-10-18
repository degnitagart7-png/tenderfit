import { gesnBookOfPrefix } from "@/domain/estimate/normCodes";
import { findNorms, type NormSearchIndex } from "@/domain/estimate/matchNorms";
import { normalizeNormCode, tableCodeOf } from "@/domain/estimate/normalize";
import type { NormRecord } from "@/domain/estimate/types";
import { deriveUnitDivisor } from "@/domain/estimate/units";

/**
 * Поиск нормы по базе ФСНБ-2022 для правки ведомости: человек вводит шифр или слова.
 *
 * Тот же поиск, что подбирает нормы в расчёте (`findNorms`), поэтому выдача — только записи,
 * которые есть в базе: придумать код он не может по построению. Что разбирается как шифр, а что
 * как слова, решает вид запроса:
 *
 * - полный шифр («ГЭСН 06-01-001-01», «06-01-001-01») — точная норма; нет в базе — соседние строки
 *   той же таблицы с пометкой, что точной нет;
 * - код таблицы («06-01-001») или его начало («06-01») — строки этой таблицы или раздела;
 * - всё остальное — слова: поиск по наименованию с ранжированием по покрытию.
 *
 * Пустой и слишком короткий запрос — пустая выдача, а не ошибка: поле ввода посылает запрос на
 * каждое нажатие, и «ничего не нашлось» — штатное состояние.
 */

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 30;
/** Короче этого запрос не ищем: два символа — уже слово («бур», «ПВХ»), один — шум. */
export const MIN_QUERY_LENGTH = 2;

export type NormSearchMode = "EMPTY" | "CODE" | "TABLE" | "WORDS";

/** Одна норма в выдаче поиска. */
export interface NormSearchHit {
  readonly code: string;
  readonly baseType: string;
  readonly name: string;
  readonly unit: string;
  readonly collectionCode: string;
  readonly collectionName: string;
  /** Покрытие запроса, 0–1; у поиска по шифру — null. */
  readonly coverage: number | null;
  /** Шифр совпал полностью. */
  readonly exact: boolean;
}

export interface NormSearchResult {
  readonly query: string;
  readonly mode: NormSearchMode;
  readonly items: readonly NormSearchHit[];
  /** Пояснение к выдаче: «шифра нет в базе — показаны соседние строки». */
  readonly note: string | null;
}

export interface NormSearchInput {
  readonly query: string;
  readonly limit?: number;
  /** Ограничить книгой: «ГЭСН», «ГЭСНм», «ГЭСНр», «ГЭСНп», «ГЭСНмр» (у базисно-индексного метода — «ФЕР», «ФЕРм» …). */
  readonly baseType?: string | null;
}

const FULL_CODE = /^\d{2}-\d{2}-\d{3}-\d{2}$/u;
const TABLE_CODE = /^\d{2}-\d{2}-\d{3}$/u;
/** Начало шифра: «06», «06-01», «06-01-0». Должно быть хотя бы «06-0»: «06» совпала бы с половиной базы. */
const CODE_PREFIX = /^\d{2}-\d{1,2}(?:-\d{1,3})?$/u;
const BOOK_WORD = /^\s*((?:ГЭСН|ФЕР)(?:МР|[МРП])?)(?![\p{L}])/iu;
const FER_BOOKS: Readonly<Record<string, string>> = { ФЕР: "ФЕР", ФЕРМ: "ФЕРм", ФЕРР: "ФЕРр", ФЕРП: "ФЕРп", ФЕРМР: "ФЕРмр" };

/** Книга ФЕР-2020 по слову запроса («ФЕРм», «ФЕР»); не ФЕР — null. */
function ferBookOfWord(word: string): string | null {
  return FER_BOOKS[word.toUpperCase()] ?? null;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT);
}

function hitOf(norm: NormRecord, coverage: number | null, exact: boolean): NormSearchHit {
  return {
    code: norm.code,
    baseType: norm.baseType,
    name: norm.fullName,
    unit: norm.unit,
    collectionCode: norm.collectionCode,
    collectionName: norm.collectionName,
    coverage,
    exact,
  };
}

function byBookAndCode(left: NormRecord, right: NormRecord): number {
  return left.baseType.localeCompare(right.baseType, "ru") || left.code.localeCompare(right.code, "ru");
}

export function searchNorms(index: NormSearchIndex, input: NormSearchInput): NormSearchResult {
  const query = input.query.trim().replace(/\s+/gu, " ");
  const limit = clampLimit(input.limit);
  const requestedBook = input.baseType?.trim() ?? "";
  const empty = (note: string | null): NormSearchResult => ({ query, mode: "EMPTY", items: [], note });

  if (query.length < MIN_QUERY_LENGTH) return empty(null);

  // Книга в начале запроса («ГЭСНм 08-01-001-01») важнее параметра: она часть шифра.
  const bookWord = BOOK_WORD.exec(query)?.[1];
  const book = bookWord === undefined ? requestedBook : (gesnBookOfPrefix(bookWord) ?? ferBookOfWord(bookWord) ?? requestedBook);
  const canonical = normalizeNormCode(query);

  if (FULL_CODE.test(canonical)) {
    const found = findNorms(index, { workName: "", normCode: canonical, normBaseType: book === "" ? null : book, limit });
    if (found.length === 0) return { query, mode: "CODE", items: [], note: `Шифра ${canonical} в базе нет` };
    const exact = found.every((match) => match.coverage === 1);
    return {
      query,
      mode: "CODE",
      items: found.map((match) => hitOf(match.norm, null, exact)),
      note: exact
        ? found.length > 1
          ? `Шифр ${canonical} есть в нескольких книгах — выберите нужную`
          : null
        : `Шифра ${canonical} в базе нет — показаны соседние строки той же таблицы`,
    };
  }

  if (TABLE_CODE.test(canonical)) {
    const rows = index.norms
      .filter((norm) => tableCodeOf(norm.code) === canonical && (book === "" || norm.baseType === book))
      .sort(byBookAndCode);
    return {
      query,
      mode: "TABLE",
      items: rows.slice(0, limit).map((norm) => hitOf(norm, null, false)),
      note: rows.length > limit ? `В таблице ${canonical} строк: ${String(rows.length)}, показаны первые ${String(limit)}` : null,
    };
  }

  if (CODE_PREFIX.test(canonical)) {
    const rows = index.norms
      .filter((norm) => normalizeNormCode(norm.code).startsWith(canonical) && (book === "" || norm.baseType === book))
      .sort(byBookAndCode);
    return {
      query,
      mode: "TABLE",
      items: rows.slice(0, limit).map((norm) => hitOf(norm, null, false)),
      note: rows.length > limit ? `Нашлось норм: ${String(rows.length)}, показаны первые ${String(limit)} — уточните шифр` : null,
    };
  }

  const found = findNorms(index, { workName: query, normBaseType: book === "" ? null : book, limit });
  return {
    query,
    mode: "WORDS",
    items: found.map((match) => hitOf(match.norm, match.coverage, false)),
    note: found.length === 0 ? "По этим словам норм не нашлось — попробуйте другие слова или шифр" : null,
  };
}

/** Сходится ли единица нормы с единицей позиции: иначе позиция в расчёт не войдёт. */
export function unitFits(positionUnit: string, normUnit: string): boolean {
  return deriveUnitDivisor(positionUnit, normUnit) !== null;
}
