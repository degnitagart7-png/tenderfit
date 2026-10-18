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

/**
 * Порог доверия к подбору по одному наименованию (без кода расценки).
 *
 * Выбран по замеру на локальных данных: на 37 вручную размеченных наименованиях
 * ведомостей (закупки 001 и типовой ВОР фасада, 27 неверных подборов и 10 верных)
 * покрытие запроса <0,5 или строгое покрытие <0,4 отсекает 13 из 27 неверных и ни
 * одного верного; на 560 позициях реальных ЛСР (наименование позиции → её же
 * таблица ГЭСН) отсекается 3,4 % (19 позиций). Ниже порога норма подбирается по
 * случайному слову («погрузка» → изоляторы стеклянные), и деньги за ней — выдумка.
 * Порог не ловит неверные подборы с высоким покрытием («Демонтаж наружных стен» →
 * опалубка, 0,79): это остаётся на сверке сметчика.
 */
export const MIN_NAME_COVERAGE = 0.5;
export const MIN_NAME_STRICT_COVERAGE = 0.4;

/** Можно ли доверять подбору по наименованию: слов запроса в норме достаточно. */
export function trustedByName(match: NormMatch): boolean {
  return match.coverage >= MIN_NAME_COVERAGE && match.strictCoverage >= MIN_NAME_STRICT_COVERAGE;
}

/**
 * Порог «проверьте»: подбор по наименованию ещё принимается в расчёт, но человеку его стоит
 * посмотреть. Ниже `MIN_NAME_COVERAGE` подбор вообще не принимается; между этими порогами норма
 * входит в смету, а в таблице «Ведомость и нормы» подсвечена. Так же выбран на разметке закупок:
 * неверные подборы с высоким покрытием («Демонтаж наружных стен» → опалубка, 0,79) порог не ловит —
 * они остаются на сверке человека, но всё, что ниже, он обязан увидеть.
 */
export const REVIEW_NAME_COVERAGE = 0.7;
export const REVIEW_NAME_STRICT_COVERAGE = 0.55;

/** Слабый ли подбор по наименованию: слов запроса в норме мало — подсветить «проверьте». */
export function needsReview(match: Pick<NormMatch, "coverage" | "strictCoverage">): boolean {
  return match.coverage < REVIEW_NAME_COVERAGE || match.strictCoverage < REVIEW_NAME_STRICT_COVERAGE;
}

/*
  Второй сигнал «проверьте»: в норме есть значимые слова, которых нет в работе.

  Покрытие отвечает на вопрос «все ли слова работы нашлись в норме». Обратный вопрос — «нет ли в
  норме лишнего» — оно не задаёт. «Демонтаж наружных стен» целиком лежит в «Монтаж и демонтаж
  крупнощитовой опалубки стен» (покрытие 0,79 — порог его пропускает), «Кладка стен из кирпича» — в
  «Кладка стен из бутового камня…» (1,00: «кирпича» нашлось в названии сборника), «Монтаж
  металлоконструкций» — в «…из алюминиевых сплавов…» (1,00). Лишнее слово — «опалубки», «бутового
  камня», «алюминиевых» — и выдаёт неверный подбор.

  Что считается словом нормы: слова её наименования без служебных, без чисел и единиц, без коротких
  (до пяти букв) и без общих слов сметной лексики («монтаж», «устройство», «стен», «наружных»,
  «ручным»…): они есть в тысячах норм и о предмете работы ничего не говорят. Вес слова — тот же IDF,
  что в самом подборе (`tokenWeight`): редкое слово весит много, частое мало.

  Слова сравниваются по общему началу (не короче пяти букв), а не по основам подбора: основа
  «кирпича» — «кирпи», а «кирпичных» — «кирпичн», и по ним слово работы «не нашлось» бы в норме.

  Два признака, любого достаточно (сигнал только подсвечивает «проверьте», подбор не отменяет):

  1. Материал или предмет нормы, которого в работе нет. Закрытый перечень семейств (`MATERIAL_FAMILIES`:
     алюминий, опалубка, бутовый камень, кирпич, бетон, дерево, пластик, стекло…): «опалубки» для
     «Демонтаж наружных стен», «алюминиевых» для «Монтаж металлоконструкций», «бутового камня» для
     «Кладка стен из кирпича». Семейство работы и семейство нормы сравниваются как семейства:
     «металлических» и «стальных» — один металл, «кирпичных» и «бутовых» — разные материалы.
  2. Подбор держится только на общих словах: ни одного значимого слова работы в норме нет, а значимые
     слова нормы есть («Установка стоек» → «Установка анкеров…» по слову «установка»).

  Чистая «доля веса чужих слов нормы» (первый вариант сигнала) на разметке не работает: у верных норм
  длинные наименования с уточнениями («обрешетки из брусков с прозорами», «с отбивкой штукатурки в
  откосах»), и доля чужих слов у них 0,6–0,9, как у неверных. Поэтому вес слов используется для
  отбора («чужое» слово весит не меньше `MIN_FOREIGN_WEIGHT`), а решает признак.
*/

/**
 * Общие слова сметной лексики: виды работ и уточнения, которые в норме и в работе пишут по-разному
 * и которые предмет работы не называют. Слово считается общим, если оно начинается с одного из них.
 */
const GENERIC_WORD_STARTS: readonly string[] = [
  // виды работ
  "монтаж", "демонтаж", "устройств", "разборк", "разработк", "установк", "укладк", "снос", "ремонт", "замен",
  "смен", "сборк", "прокладк", "изготовлен", "обустройств", "нанесен", "заделк", "очистк", "перевозк", "погрузк",
  "выгрузк", "примен", "добавл", "учитыв", "включ", "выполнен", "работ", "кладк", "засыпк", "окраск", "покраск",
  "штукатурк", "облицовк", "демонт", "обработк", "подготовк", "уплотнен", "планировк",
  // части и места
  "стен", "перекрыт", "конструкц", "элемент", "детал", "поверхност", "здани", "сооружен", "помещен", "участк",
  "места", "мест", "основан",
  // уточнения
  "наружн", "внутренн", "простых", "простой", "простая", "простое", "сложн", "ручн", "вручн", "механизирован",
  "высот", "толщин", "глубин", "диаметр", "ширин", "длин", "площад", "объем", "вместимост", "грузоподъемност",
  "мощност", "группа", "групп", "категори", "класс", "типа", "типов", "видов", "вид", "количеств", "размер",
  "отдельн", "каждый", "каждые", "каждая", "каждое", "свыше", "более", "менее", "кроме", "также", "прочих", "прочие",
  "одноковш", "самоходн", "стационарн", "переносн", "подвесн", "горизонтальн", "вертикальн", "наклонн", "однослойн",
  "двухслойн", "многослойн", "условиях", "условия", "применением", "способом", "методом", "помощью", "массой", "весом",
];

/**
 * Семейства материалов и предметов. Слово нормы из семейства, которого нет среди семейств работы,
 * — «чужое»: оно говорит о другом материале или другой конструкции. Слово относится к семейству, если
 * начинается с одного из начал.
 */
const MATERIAL_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  "алюминий": ["алюмин"],
  "металл": ["металл", "стальн", "сталь", "оцинкован", "нержавеющ", "стале"],
  "чугун": ["чугун"],
  "медь": ["медн", "медь"],
  "опалубка": ["опалуб"],
  "бутовый камень": ["бутов", "бутобетон", "камня", "камни", "камнем"],
  "кирпич": ["кирпич"],
  "бетон": ["бетон", "железобетон", "железобетонн", "цементн", "цемент"],
  "дерево": ["деревян", "древесин", "бруск", "досчат", "брусчат"],
  "пластик": ["пластмасс", "пластик", "полиэтилен", "полипропилен", "поливинилхлорид", "пвх", "стеклопласт"],
  "стекло": ["стеклян", "стеклопакет", "остеклен", "стекло"],
  "гипс": ["гипс", "гипсокартон"],
  "керамика": ["керамическ", "керамзит", "керамогранит"],
  "асфальт": ["асфальт", "битум", "рубероид"],
  "асбест": ["асбест", "шифер"],
  "трамбовка": ["трамбов", "трамбующ"],
};

function familyOf(token: string): string | null {
  for (const [family, starts] of Object.entries(MATERIAL_FAMILIES)) {
    if (starts.some((start) => token.startsWith(start))) return family;
  }
  return null;
}

/** Слово нормы, которого нет в работе, и его вес. */
export interface ForeignWord {
  readonly word: string;
  readonly weight: number;
  /** Слово — материал или предмет из `MATERIAL_FAMILIES`, а в работе такого семейства нет. */
  readonly material: boolean;
}

export interface ForeignWords {
  /** «Чужие» слова, тяжёлые первыми. */
  readonly words: readonly ForeignWord[];
  /** Вес значимых слов нормы, которые есть и в работе. */
  readonly sharedWeight: number;
  /** Вес «чужих» слов. */
  readonly foreignWeight: number;
  /** Доля веса «чужих» слов в весе всех значимых слов нормы, 0–1 (справочно: решает не она). */
  readonly share: number;
}

const MIN_WORD_LENGTH = 5;
const MIN_COMMON_PREFIX = 5;

/**
 * «Чужое» слово весит не меньше этого (IDF по базе норм): слова, которые встречаются в десятках
 * тысяч норм, ни о чём не говорят. Подобрано по разметке вместе с `GENERIC_WORD_STARTS`.
 */
export const MIN_FOREIGN_WEIGHT = 6;

function sameWord(left: string, right: string): boolean {
  if (left === right) return true;
  const limit = Math.min(left.length, right.length);
  if (limit < MIN_COMMON_PREFIX) return false;
  let common = 0;
  while (common < limit && left[common] === right[common]) common += 1;
  return common >= MIN_COMMON_PREFIX;
}

function isGenericWord(token: string): boolean {
  return GENERIC_WORD_STARTS.some((start) => token.startsWith(start));
}

/** Значимые слова наименования: без служебных, чисел, единиц, коротких и общих. */
function significantWords(name: string): string[] {
  return uniqueTokens(name).filter(
    (token) => /^[а-я]+$/u.test(token) && token.length >= MIN_WORD_LENGTH && !isGenericWord(token),
  );
}

/**
 * Значимые слова нормы, которых нет в наименовании работы.
 * Всегда считается по наименованию самой нормы (без названия сборника).
 */
export function foreignWords(index: NormSearchIndex, workName: string, norm: NormRecord): ForeignWords {
  const queryWords = uniqueTokens(workName);
  const queryFamilies = new Set(queryWords.flatMap((word) => familyOf(word) ?? []));
  let shared = 0;
  let total = 0;
  const foreign: ForeignWord[] = [];
  for (const word of significantWords(norm.fullName)) {
    // Слово, которого нет ни в одной другой норме, весит как самое редкое: тот же приём, что в strictCoverage.
    const weight = tokenWeight(index, stem(word)) || Math.log(1 + index.size);
    total += weight;
    if (queryWords.some((query) => sameWord(query, word))) {
      shared += weight;
      continue;
    }
    const family = familyOf(word);
    foreign.push({ word, weight, material: family !== null && !queryFamilies.has(family) });
  }
  foreign.sort((a, b) => Number(b.material) - Number(a.material) || b.weight - a.weight);
  const lost = foreign.reduce((sum, item) => sum + item.weight, 0);
  return { words: foreign, sharedWeight: shared, foreignWeight: lost, share: total > 0 ? lost / total : 0 };
}

/** Результат оценки подбора по наименованию: подсветить ли и почему. */
export interface ReviewVerdict {
  readonly review: boolean;
  /** Почему: «в норме есть «опалубки», в работе — нет»; null, если подсвечивать нечего. */
  readonly reason: string | null;
}

/**
 * «Чужие» слова, о которых стоит сказать: материалы и предметы из перечня (их слова частые, поэтому
 * вес не смотрим) и редкие слова нормы (вес не меньше `MIN_FOREIGN_WEIGHT`).
 */
function notable(foreign: ForeignWords): ForeignWord[] {
  return foreign.words.filter((item) => item.material || item.weight >= MIN_FOREIGN_WEIGHT);
}

/** Признак «чужих» слов: материал нормы, которого нет в работе, или совпадение только по общим словам. */
export function hasForeignSignal(foreign: ForeignWords): boolean {
  if (foreign.words.some((item) => item.material)) return true;
  return foreign.sharedWeight === 0 && notable(foreign).length > 0;
}

/**
 * Нужно ли человеку проверить подбор по наименованию: «чужие» слова в норме или слабое покрытие слов
 * работы. Подбор по шифру из документа сюда не приходит — шифр назвал документ.
 */
export function reviewVerdict(
  index: NormSearchIndex,
  workName: string,
  match: Pick<NormMatch, "norm" | "coverage" | "strictCoverage">,
): ReviewVerdict {
  const foreign = foreignWords(index, workName, match.norm);
  if (hasForeignSignal(foreign)) {
    const materials = foreign.words.filter((item) => item.material);
    const named = (materials.length > 0 ? materials : notable(foreign)).slice(0, 2).map((item) => `«${item.word}»`);
    return { review: true, reason: `в норме есть ${named.join(", ")}, в работе — нет` };
  }
  if (needsReview(match)) {
    return { review: true, reason: "в норме нашлась лишь часть слов работы" };
  }
  return { review: false, reason: null };
}

/** Один кандидат на роль расценки. */
export interface NormMatch {
  readonly norm: NormRecord;
  /** Чем выше, тем ближе. Абсолютного смысла не имеет — важен порядок. */
  readonly score: number;
  /** Почему норма предложена. Показывается пользователю целиком. */
  readonly reasons: readonly string[];
  /**
   * Доля веса слов запроса, совпавших со словами нормы, от 0 до 1. Слова, которых в
   * базе нет вовсе, в знаменатель не входят. Для нормы, найденной по коду, — 1.
   */
  readonly coverage: number;
  /**
   * То же, но слово запроса, которого нет ни в одной норме («подсыпка»), входит в
   * знаменатель весом самого редкого слова: незнакомое слово — это часть работы,
   * которую подобранная норма не описывает. По этому числу решается, можно ли
   * доверять подбору по наименованию без кода.
   */
  readonly strictCoverage: number;
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
  const unknownStems = queryStems.filter((token) => tokenWeight(index, token) === 0).length;
  const strictTotal = totalWeight + unknownStems * Math.log(1 + index.size);

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

    matches.push({
      norm,
      score: Math.round(score * 1000) / 1000,
      reasons,
      coverage,
      strictCoverage: strictTotal > 0 ? rawScore / strictTotal : 0,
    });
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
        coverage: 0,
        strictCoverage: 0,
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
        coverage: 1,
        strictCoverage: 1,
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
      coverage: 0,
      strictCoverage: 0,
      reasons: [
        `Код ${canonical} в базе не найден, показаны строки таблицы ${table} книги ${norm.baseType}`,
      ],
    }));
}

function exactMatch(norm: NormRecord): NormMatch {
  return {
    norm,
    score: EXACT_CODE_SCORE,
    coverage: 1,
    strictCoverage: 1,
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
