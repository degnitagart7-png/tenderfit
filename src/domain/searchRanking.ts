import type { MatchResult, ParsedQuery, SearchScope } from "@/domain/textSearch";

/**
 * Ранжирование выдачи и объяснение каждой позиции.
 *
 * Принятая архитектура — «Контур отбирает, мы ранжируем»: внешний агрегатор
 * приносит кандидатов, а порядок в выдаче и причину «почему эта закупка здесь»
 * считаем мы, на своих данных и бесплатно. Отсюда требование к модулю: он
 * должен уметь объяснить любую позицию одним-двумя предложениями, иначе
 * сортировка «Наиболее подходящие» превратится в непроверяемую магию.
 *
 * Модуль чистый: ни сети, ни времени, ни хранилища. На вход — результат
 * сопоставления из textSearch и Fit Score из анализа, на выход — балл и список
 * причин.
 */

/** Почему закупка оказалась в выдаче. Порядок перечисления = порядок важности. */
export type RelevanceReasonCode =
  | "phrase"
  | "subject"
  | "items"
  | "documents"
  | "okpd2"
  | "partial";

export interface RelevanceReason {
  code: RelevanceReasonCode;
  /** Готовая к показу фраза на русском. */
  label: string;
  /**
   * Что именно совпало. Для текстовых областей — слова запроса, для кода —
   * сам код: подсказка раскрывается по наведению и снимает вопрос «где тут
   * моё слово?».
   */
  detail?: string;
}

export interface Relevance {
  /** 0..100. Чем выше, тем ближе закупка к запросу. */
  score: number;
  /** Причины в порядке важности; пустой список — когда запроса не было. */
  reasons: RelevanceReason[];
  /**
   * Доля совпавших слов запроса, 0..1.
   *
   * Запрос без слов (только код или только фраза) даёт 1: делить нечего,
   * а показывать «совпало 0 из 0» было бы бессмыслицей на экране.
   */
  termCoverage: number;
}

/* ============================== Веса ============================== */

/**
 * Вклад области поиска. Совпадение в названии — самый сильный сигнал: предмет
 * закупки формулирует сам заказчик. Номенклатура слабее: там слово может
 * оказаться в позиции «расходные материалы к основному предмету». Документация
 * слабее всего: в извещении на 200 страниц слово встречается почти всегда,
 * поэтому поиск по документам в Контуре и вынесен отдельным переключателем.
 */
export const SCOPE_WEIGHTS: Record<SearchScope, number> = {
  subject: 40,
  items: 26,
  documents: 18,
};

/**
 * Потолок суммы областей. Без него закупка, где слово встретилось и в названии,
 * и в лотах, и в документации, получила бы 84 балла только за текст и оставила
 * бы позади точное совпадение по классификатору.
 */
export const SCOPE_SCORE_CAP = 70;

/** Дословная фраза из кавычек: человек искал именно это сочетание. */
export const PHRASE_WEIGHT = 18;

/**
 * Совпадение по ОКПД2. Вес сравним с совпадением в названии: код вводит человек,
 * который знает классификатор, и ложных срабатываний у него почти нет.
 */
export const CODE_WEIGHT = 45;

/**
 * Как баллы смешиваются в сортировке «Наиболее подходящие».
 *
 * Релевантность перевешивает Fit Score: сначала закупка должна отвечать запросу,
 * и только среди отвечающих имеет смысл выбирать подходящие компании. Обратный
 * порядок выдал бы на запрос «вентиля» идеальную по профилю закупку бетона —
 * ровно ту жалобу, с которой начинается эта работа.
 */
export const RELEVANCE_WEIGHT = 0.6;
export const FIT_WEIGHT = 0.4;

/** Округляет балл до целого: доли процента на экране только шумят. */
function round(value: number): number {
  return Math.round(value);
}

/** Ограничивает значение пределами 0..100. */
function clampScore(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/* ============================== Подписи областей ============================== */

/**
 * Подписи областей в родительном падеже: из них собираются и причины, и
 * переключатели областей поиска в панели фильтров. Один источник строк — иначе
 * «Объекты закупки» в фильтре и «номенклатуре» в подсказке разъедутся.
 */
export const scopeNouns: Record<SearchScope, string> = {
  subject: "названии закупки",
  items: "номенклатуре",
  documents: "документации",
};

/** Короткое название области для переключателя. */
export const scopeShortLabels: Record<SearchScope, string> = {
  subject: "Название",
  items: "Объекты закупки",
  documents: "Документация",
};

/* ============================== Оценка ============================== */

export interface ScoreRelevanceInput {
  match: MatchResult;
  query: ParsedQuery;
}

/**
 * Считает балл релевантности и собирает причины.
 *
 * Текстовая часть умножается на долю совпавших слов: закупка, где нашлось два
 * слова из трёх, обязана стоять ниже той, где нашлись все три. Совпадение по
 * коду и по фразе не умножается — это самостоятельные сигналы.
 *
 * Отсеянная минус-словом закупка (`excludedHit`) получает 0 и пустой список
 * причин: она не должна попасть в выдачу вообще, а если всё же попала, нулевой
 * балл опустит её в конец вместо того, чтобы показывать «совпадение».
 */
export function scoreRelevance(input: ScoreRelevanceInput): Relevance {
  const { match, query } = input;

  if (match.excludedHit || !match.matched) {
    return { score: 0, reasons: [], termCoverage: 0 };
  }

  const termCoverage =
    query.terms.length > 0 ? match.matchedTerms.length / query.terms.length : 1;

  const scopeSum = match.scopes.reduce(
    (sum, scope) => sum + SCOPE_WEIGHTS[scope],
    0,
  );
  const textScore = Math.min(SCOPE_SCORE_CAP, scopeSum) * termCoverage;
  const phraseScore = match.phraseMatched ? PHRASE_WEIGHT : 0;
  const codeScore = match.matchedCodes.length > 0 ? CODE_WEIGHT : 0;

  const score = round(clampScore(textScore + phraseScore + codeScore));
  const reasons = buildReasons(match, query, termCoverage);

  return { score, reasons, termCoverage };
}

/**
 * Собирает причины в фиксированном порядке важности: сначала дословная фраза,
 * затем области от сильной к слабой, затем классификатор, и в конце — честное
 * признание, что совпала только часть слов.
 */
function buildReasons(
  match: MatchResult,
  query: ParsedQuery,
  termCoverage: number,
): RelevanceReason[] {
  const reasons: RelevanceReason[] = [];
  const terms = match.matchedTerms.join(", ");

  if (match.phraseMatched && query.phrase !== null) {
    reasons.push({
      code: "phrase",
      label: `Фраза «${query.phrase}» найдена целиком`,
      detail: query.phrase,
    });
  }

  for (const scope of ["subject", "items", "documents"] as const) {
    if (!match.scopes.includes(scope)) continue;
    reasons.push({
      code: scope,
      label: `Совпадение в ${scopeNouns[scope]}`,
      ...(terms.length > 0 ? { detail: terms } : {}),
    });
  }

  if (match.matchedCodes.length > 0) {
    const codes = match.matchedCodes.join(", ");
    reasons.push({ code: "okpd2", label: `ОКПД2 ${codes}`, detail: codes });
  }

  // «Совпало 2 из 3 слов» показываем только когда это правда: при полном
  // совпадении строка была бы лишней, а при запросе без слов — бессмысленной.
  if (query.terms.length > 0 && termCoverage > 0 && termCoverage < 1) {
    reasons.push({
      code: "partial",
      label: `Совпало ${match.matchedTerms.length} из ${query.terms.length} слов`,
      detail: terms.length > 0 ? terms : undefined,
    });
  }

  return reasons;
}

/* ============================== Смешивание с Fit Score ============================== */

/**
 * Итоговый балл сортировки «Наиболее подходящие».
 *
 * Оба слагаемых живут в шкале 0..100, поэтому результат тоже в ней. Когда
 * запроса нет, релевантность равна нулю у всех закупок и порядок полностью
 * определяется Fit Score — то есть сортировка деградирует в привычную, а не
 * ломается.
 */
export function combineRelevanceAndFit(
  relevanceScore: number,
  fitScore: number,
): number {
  return round(
    clampScore(
      relevanceScore * RELEVANCE_WEIGHT + fitScore * FIT_WEIGHT,
    ),
  );
}

/* ============================== Сортировка выдачи ============================== */

/** Строка выдачи с посчитанной релевантностью. */
export interface RankedRow<T> {
  row: T;
  relevance: Relevance;
  /** `combineRelevanceAndFit(relevance.score, fitScore)` — по нему сортируем. */
  combined: number;
  /** Fit Score закупки, сохранён для объяснения и для запасной сортировки. */
  fitScore: number;
}

/**
 * Ранжирует строки по убыванию смешанного балла.
 *
 * Совпадения баллов разрешаются сначала по релевантности, затем по Fit Score —
 * иначе порядок двух одинаковых закупок зависел бы от их положения в исходном
 * массиве, а выдача «прыгала» бы при каждом обновлении.
 */
export function rankRows<T>(
  rows: T[],
  relevanceOf: (row: T) => Relevance,
  fitOf: (row: T) => number,
): RankedRow<T>[] {
  const ranked: RankedRow<T>[] = rows.map((row) => {
    const relevance = relevanceOf(row);
    const fitScore = fitOf(row);
    return {
      row,
      relevance,
      fitScore,
      combined: combineRelevanceAndFit(relevance.score, fitScore),
    };
  });

  ranked.sort((a, b) => {
    if (a.combined !== b.combined) return b.combined - a.combined;
    if (a.relevance.score !== b.relevance.score) {
      return b.relevance.score - a.relevance.score;
    }
    return b.fitScore - a.fitScore;
  });

  return ranked;
}
