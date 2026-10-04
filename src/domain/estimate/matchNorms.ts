import {
  discriminativeWord,
  normalizeNormCode,
  normalizeText,
  stem,
  tableCodeOf,
  uniqueTokens,
} from "@/domain/estimate/normalize";
import type { NormRecord } from "@/domain/estimate/types";

/**
 * Детерминированный подбор норм ГЭСН под работу из ведомости объёмов работ.
 *
 * Принцип, из-за которого этот модуль существует: модель не может выдумать
 * расценку. Она выбирает из замкнутого набора кодов, которые физически есть в
 * нашей копии ФСНБ-2022. Для сравнения — облачный подбор расценок отдаёт
 * готовый текст, и проверить, существует ли названный код, пользователь не
 * может. Здесь каждый результат — ссылка на реальную запись нормы.
 *
 * Ранжирование: покрытие запроса с весами обратно пропорциональными частоте
 * токена, бонус за различающие глаголы («разработка» против «разборка»),
 * бонус за дословное вхождение фразы. Тай-брейк — по книге и коду нормы, чтобы
 * одинаковый вход всегда давал одинаковый порядок.
 *
 * Норма опознаётся парой «книга + код», а не кодом: 2 784 кода из 53 228
 * встречаются больше чем в одной книге, и словарь по коду молча вернул бы одну
 * из четырёх разных работ с одним номером.
 */

/** Один кандидат на роль расценки. */
export interface NormMatch {
  readonly norm: NormRecord;
  /** Чем выше, тем ближе. Абсолютного смысла не имеет — важен порядок. */
  readonly score: number;
  /** Почему норма предложена. Показывается пользователю целиком. */
  readonly reasons: readonly string[];
}

/** Запрос подбора. */
export interface NormSearchRequest {
  /** Наименование работы из ведомости объёмов работ. */
  readonly workName: string;
  /** Код нормы, если он уже назначен вручную или найден в документации. */
  readonly normCode?: string | null;
  /**
   * Книга нормы: «ГЭСН», «ГЭСНм», «ГЭСНр», «ГЭСНп», «ГЭСНмр».
   *
   * Без неё код неоднозначен. Перепись пяти книг выгрузки ФГИС ЦС даёт 56 242
   * элемента Work и 53 228 различных кодов: 2 784 кода встречаются больше
   * одного раза. «01-01-001-01» — это экскаватор-драглайн в ГЭСН, токарный
   * станок в ГЭСНм, синхронный генератор в ГЭСНп и замок двери шахты лифта
   * в ГЭСНмр. Если книга не указана, подбор возвращает все найденные книги
   * сразу и пишет об этом в объяснении: выбрать за сметчика молча значило бы
   * посчитать земляные работы как монтаж станка.
   */
  readonly normBaseType?: string | null;
  /** Ограничить сборником, например «09» — металлические конструкции. */
  readonly collectionCode?: string | null;
  /** Сколько кандидатов вернуть. По умолчанию 8. */
  readonly limit?: number;
}

/** Предвычисленный индекс по массиву норм. */
export interface NormSearchIndex {
  readonly size: number;
  /** Норма по паре «книга + код». Единственный однозначный ключ. */
  readonly byKey: ReadonlyMap<string, NormRecord>;
  /** Нормы одного кода во всех книгах, в порядке загрузки. */
  readonly byCode: ReadonlyMap<string, NormRecord[]>;
  /** Строки одной таблицы одной книги. */
  readonly byTable: ReadonlyMap<string, NormRecord[]>;
  /** Обратный индекс: основа токена → позиции норм в массиве. */
  readonly postings: ReadonlyMap<string, number[]>;
  /** В скольких нормах встречается основа токена — для весов. */
  readonly documentFrequency: ReadonlyMap<string, number>;
  /** Основы токенов каждой нормы, в порядке массива. */
  readonly stemsByPosition: readonly (readonly string[])[];
  /** Нормализованное полное наименование каждой нормы. */
  readonly namesByPosition: readonly string[];
  readonly norms: readonly NormRecord[];
}

const DEFAULT_LIMIT = 8;
/** Точное совпадение кода должно быть выше любого текстового совпадения. */
const EXACT_CODE_SCORE = 10_000;
const PHRASE_BONUS = 6;
const DISCRIMINATIVE_BONUS = 1.5;

/** Ключ нормы: код уникален только внутри книги. */
export function normKey(baseType: string, code: string): string {
  return `${baseType.trim()}|${normalizeNormCode(code)}`;
}

/**
 * Подходит ли книга нормы под ограничение запроса.
 *
 * Пустая строка, null и undefined означают «книга не задана» — тогда проходят
 * все пять. Сравнение без учёта регистра: «ГЭСНм» и «гэснм» — одна книга, а
 * «ГЭСНм» и «ГЭСНмр» разные, и приведение регистра их не смешивает.
 */
function baseTypeAccepted(requested: string | null | undefined, actual: string): boolean {
  const wanted = (requested ?? "").trim().toLowerCase();
  if (wanted.length === 0) return true;
  return wanted === actual.trim().toLowerCase();
}

/** Ключ таблицы: строки таблиц разных книг не смешиваются. */
function tableKey(baseType: string, tableCode: string): string {
  return `${baseType.trim()}|${tableCode}`;
}

/** Сортировка, которая делает порядок выдачи независимым от порядка загрузки. */
function compareNorms(a: NormRecord, b: NormRecord): number {
  const byBase = a.baseType.localeCompare(b.baseType, "ru");
  if (byBase !== 0) return byBase;
  return a.code.localeCompare(b.code, "ru");
}

/** Строит индекс. Вызывается один раз на загрузку базы. */
export function createNormSearchIndex(norms: readonly NormRecord[]): NormSearchIndex {
  const byKey = new Map<string, NormRecord>();
  const byCode = new Map<string, NormRecord[]>();
  const byTable = new Map<string, NormRecord[]>();
  const postings = new Map<string, number[]>();
  const documentFrequency = new Map<string, number>();
  const stemsByPosition: string[][] = [];
  const namesByPosition: string[] = [];

  norms.forEach((norm, position) => {
    byKey.set(normKey(norm.baseType, norm.code), norm);

    const code = normalizeNormCode(norm.code);
    const codeBucket = byCode.get(code);
    if (codeBucket === undefined) byCode.set(code, [norm]);
    else codeBucket.push(norm);

    const table = tableKey(norm.baseType, tableCodeOf(norm.code));
    const tableBucket = byTable.get(table);
    if (tableBucket === undefined) byTable.set(table, [norm]);
    else tableBucket.push(norm);

    const stems = uniqueStems(`${norm.fullName} ${norm.collectionName}`);
    stemsByPosition.push(stems);
    namesByPosition.push(normalizeText(norm.fullName));

    const seenHere = new Set<string>();
    for (const token of stems) {
      if (seenHere.has(token)) continue;
      seenHere.add(token);
      const bucket = postings.get(token);
      if (bucket === undefined) postings.set(token, [position]);
      else bucket.push(position);
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  });

  return {
    size: norms.length,
    byKey,
    byCode,
    byTable,
    postings,
    documentFrequency,
    stemsByPosition,
    namesByPosition,
    norms,
  };
}

/**
 * Ищет нормы под запрос. Всегда возвращает только записи, которые есть в
 * индексе: придумать код функция не может по построению.
 */
export function findNorms(
  index: NormSearchIndex,
  request: NormSearchRequest,
): NormMatch[] {
  const limit = request.limit ?? DEFAULT_LIMIT;
  const requestedCode = request.normCode?.trim() ?? "";

  if (requestedCode.length > 0) {
    const byCodeResult = findByCode(index, request, requestedCode, limit);
    if (byCodeResult !== null) return byCodeResult;
  }

  const workName = request.workName;
  if (workName.trim().length === 0) return [];

  const queryStems = uniqueStems(workName);
  if (queryStems.length === 0) return [];
  const normalizedQuery = normalizeText(workName);
  const totalWeight = queryStems.reduce((sum, token) => sum + tokenWeight(index, token), 0);

  // Считаем только нормы, где встретился хотя бы один токен запроса.
  const candidates = new Map<number, number>();
  for (const token of queryStems) {
    const positions = index.postings.get(token);
    if (positions === undefined) continue;
    const weight = tokenWeight(index, token);
    for (const position of positions) {
      candidates.set(position, (candidates.get(position) ?? 0) + weight);
    }
  }

  const matches: NormMatch[] = [];
  for (const [position, rawScore] of candidates) {
    const norm = index.norms[position];
    if (norm === undefined) continue;
    if (request.collectionCode !== null && request.collectionCode !== undefined) {
      if (normalizeNormCode(request.collectionCode) !== norm.collectionCode) continue;
    }
    // Книга ограничивает и текстовый поиск, а не только разбор кода. Один и тот
    // же сборник 08 есть и в ГЭСН («Конструкции из кирпича и блоков»), и в ГЭСНм
    // («Электротехнические установки»), и без этого фильтра запрос «прокладка
    // кабеля» с указанной книгой молча вернул бы строки из четырёх остальных.
    if (!baseTypeAccepted(request.normBaseType, norm.baseType)) continue;

    const reasons: string[] = [];
    const normStems = index.stemsByPosition[position] ?? [];
    const matchedTokens = queryStems.filter((token) => normStems.includes(token));
    if (matchedTokens.length === 0) continue;

    const coverage = totalWeight > 0 ? rawScore / totalWeight : 0;
    let score = coverage * 10;

    const discriminative = matchedTokens.flatMap((token) => {
      const word = discriminativeWord(token);
      return word === null ? [] : [word];
    });
    if (discriminative.length > 0) {
      score += DISCRIMINATIVE_BONUS * discriminative.length;
      reasons.push(`Совпал вид работ: ${discriminative.join(", ")}`);
    }

    const normName = index.namesByPosition[position] ?? "";
    if (normalizedQuery.length >= 12 && normName.includes(normalizedQuery)) {
      score += PHRASE_BONUS;
      reasons.push("Наименование работы совпало с наименованием нормы дословно");
    } else if (normName.length >= 12 && normalizedQuery.includes(normName)) {
      score += PHRASE_BONUS / 2;
      reasons.push("Наименование нормы целиком вошло в описание работы");
    }

    const shared = matchedTokens.slice(0, 5).join(", ");
    reasons.push(`Совпали слова: ${shared}`);
    reasons.push(
      `Покрытие запроса ${formatPercent(coverage)} · книга ${norm.baseType}, ` +
        `сборник ${norm.collectionCode} «${norm.collectionName}»`,
    );

    matches.push({ norm, score: Math.round(score * 1000) / 1000, reasons });
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return compareNorms(a.norm, b.norm);
  });

  return matches.slice(0, limit);
}

/**
 * Разбор запроса с явно заданным кодом.
 *
 * Возвращает null, когда кода в запросе нет и нужно искать текстом. Пустой
 * массив означает «кода в базе нет и соседей по таблице тоже».
 */
function findByCode(
  index: NormSearchIndex,
  request: NormSearchRequest,
  requestedCode: string,
  limit: number,
): NormMatch[] | null {
  const canonical = normalizeNormCode(requestedCode);
  const baseType = request.normBaseType?.trim() ?? "";

  if (baseType.length > 0) {
    const exact = index.byKey.get(normKey(baseType, canonical));
    if (exact !== undefined) return [exactMatch(exact)];

    const siblings = index.byTable.get(tableKey(baseType, tableCodeOf(canonical))) ?? [];
    if (siblings.length === 0) return [];
    return [...siblings]
      .sort(compareNorms)
      .slice(0, limit)
      .map((norm) => ({
        norm,
        score: EXACT_CODE_SCORE / 2,
        reasons: [
          `Код ${canonical} в книге ${baseType} не найден, показаны строки таблицы ${tableCodeOf(canonical)}`,
        ],
      }));
  }

  const found = index.byCode.get(canonical) ?? [];
  if (found.length === 1) {
    const only = found[0];
    return only === undefined ? [] : [exactMatch(only)];
  }

  if (found.length > 1) {
    const books = [...found].sort(compareNorms).map((norm) => norm.baseType).join(", ");
    return [...found]
      .sort(compareNorms)
      .slice(0, limit)
      .map((norm) => ({
        norm,
        score: EXACT_CODE_SCORE,
        reasons: [
          `Код ${canonical} есть в нескольких книгах: ${books}. Книга не указана — показаны все, выберите нужную`,
          `Книга ${norm.baseType}, сборник ${norm.collectionCode} «${norm.collectionName}»`,
        ],
      }));
  }

  // Кода нет ни в одной книге. Чаще всего ошибка в последней паре цифр,
  // поэтому показываем соседние строки той же таблицы во всех книгах.
  const table = tableCodeOf(canonical);
  const siblings = index.norms.filter(
    (norm) => tableCodeOf(norm.code) === table && norm.code !== canonical,
  );
  if (siblings.length === 0) return [];
  return siblings
    .sort(compareNorms)
    .slice(0, limit)
    .map((norm) => ({
      norm,
      score: EXACT_CODE_SCORE / 2,
      reasons: [
        `Код ${canonical} в базе не найден, показаны строки таблицы ${table} книги ${norm.baseType}`,
      ],
    }));
}

function exactMatch(norm: NormRecord): NormMatch {
  return {
    norm,
    score: EXACT_CODE_SCORE,
    reasons: [
      `Код нормы ${norm.code} задан явно, книга ${norm.baseType}, сборник ${norm.collectionCode} «${norm.collectionName}»`,
    ],
  };
}

/**
 * Все строки одной таблицы — нужно, чтобы показать пользователю выбор строк.
 * Без `baseType` возвращает строки всех книг, в которых такая таблица есть.
 */
export function tableRows(
  index: NormSearchIndex,
  codeOrTable: string,
  baseType?: string | null,
): NormRecord[] {
  const canonical = normalizeNormCode(codeOrTable);
  const table = tableCodeOf(canonical);
  const book = baseType?.trim() ?? "";
  if (book.length > 0) return index.byTable.get(tableKey(book, table)) ?? [];

  const rows: NormRecord[] = [];
  for (const norm of index.norms) {
    if (tableCodeOf(norm.code) === table) rows.push(norm);
  }
  return rows.sort(compareNorms);
}

/** Вес токена: чем реже встречается в базе, тем он различительнее. */
function tokenWeight(index: NormSearchIndex, token: string): number {
  const frequency = index.documentFrequency.get(token) ?? 0;
  if (frequency === 0) return 0;
  return Math.log(1 + index.size / frequency);
}

/** Основы токенов без повторов — то, по чему реально идёт сопоставление. */
function uniqueStems(input: string): string[] {
  const tokens = uniqueTokens(input);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    const base = stem(token);
    if (seen.has(base)) continue;
    seen.add(base);
    result.push(base);
  }
  return result;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)} %`;
}
