import type { Tender } from "@/domain/entities";

/**
 * Полнотекстовый поиск по закупкам в духе Контур.Закупок.
 *
 * Поведение скопировано с живого кабинета zakupki.kontur.ru (см.
 * docs/REFERENCE_SEARCH_KONTUR_TENDERPLAN.md, раздел «Что делает выдачу
 * Контура точной»): сопоставление по основе слова, а не посимвольное,
 * коды ОКПД2 в одной строке со словами, минус-слова, дословные фразы,
 * области поиска и сниппет из найденного.
 *
 * Модуль намеренно чистый: одинаковый вход → одинаковый выход, без сети,
 * времени и хранилища. Он не знает ни про React, ни про репозитории —
 * только про текст и сущность Tender.
 */

/** Где именно ищем совпадение. */
export type SearchScope = "subject" | "items" | "documents";

/**
 * Канонический порядок областей. Единый массив на домен: порядок результата
 * matchCorpus не должен зависеть от того, в каком порядке области перечислил
 * вызывающий код, иначе один и тот же запрос даст разный список scopes.
 */
/**
 * Все области поиска в порядке важности.
 *
 * Порядок общий для сопоставления и для интерфейса: список областей в фильтре,
 * подписи в чипах и разбор параметров адреса обязаны перечислять области
 * одинаково, иначе ссылка на выдачу перестанет совпадать с тем, что на экране.
 */
export const ALL_SCOPES: readonly SearchScope[] = ["subject", "items", "documents"];

/** Разобранная строка запроса. */
export interface ParsedQuery {
  /**
   * Слова строки поиска. Совпасть обязаны все.
   *
   * «Юридические услуги» — одно понятие из двух слов, и ни одно из них по
   * отдельности запроса не выражает. Пока хватало любого, запрос возвращал
   * транспортировку отходов и лизинг автомобилей: в них есть слово «услуги».
   */
  terms: string[];
  /**
   * Ключевые слова профиля поиска: достаточно любого из них.
   *
   * Каждое ключевое слово — отдельная группа, внутри которой слова
   * складываются по «и»: «Юридические услуги» — это группа из двух слов, и
   * срабатывает она, только когда нашлись оба. Группа, а не плоский список,
   * потому что иначе «услуги» становилось самостоятельным ключевым словом и
   * возвращало всю ленту.
   *
   * Строка поиска и группы — альтернативы: подходит закупка, где сошлась
   * строка ИЛИ хотя бы одна группа. Так читается и ссылка, сохранённая до
   * появления групп, где `q` несёт первое слово профиля, а `q2` — остальные.
   */
  anyGroups: string[][];
  /** Слова-исключения. */
  excluded: string[];
  /** Коды ОКПД2, выделенные из строки (например «36.40.11.133», «30.01»). */
  codes: string[];
  /** Фраза в двойных кавычках — ищется дословно; null, если кавычек не было. */
  phrase: string | null;
}

/** Текст закупки, разложенный по областям поиска. */
export interface SearchCorpus {
  /** Предмет закупки + название заказчика + адрес поставки. */
  subject: string;
  /** Номенклатура: лоты и требования (то, что в Контуре называется «Объекты»). */
  items: string;
  /** Тексты документов закупки; пусто, если документы не загружены. */
  documents: string;
  /** Коды ОКПД2 закупки. */
  codes: string[];
}

export interface MatchOptions {
  /** Точное соответствие: без приведения к основе, ищем дословное вхождение. */
  exact?: boolean;
  /** Области поиска; пусто или не задано = все три. */
  scopes?: SearchScope[];
}

export interface MatchResult {
  matched: boolean;
  /** В каких областях найдено совпадение. */
  scopes: SearchScope[];
  /** Какие слова запроса сработали — нужны для сниппета и для объяснения пользователю. */
  matchedTerms: string[];
  /**
   * Какие коды ОКПД2 из запроса совпали с кодами закупки.
   *
   * Коды живут отдельно от текстовых областей: у Контура строка классификатора
   * вводится в том же поле, что и слова, но матчится по справочнику, а не по
   * тексту. Ранжированию и объяснению нужно знать, сработал ли именно код,
   * иначе закупка, найденная только по ОКПД2, выглядела бы совпадением по тексту.
   */
  matchedCodes: string[];
  /**
   * Совпала ли дословная фраза из кавычек.
   *
   * Отдельный признак нужен потому, что `scopes` отвечает только «где нашлось
   * хоть что-то»: закупка могла попасть в выдачу по одному слову, тогда как
   * человек искал точное сочетание. Ранжирование поднимает дословные совпадения
   * выше, а объяснение говорит «фраза найдена целиком».
   */
  phraseMatched: boolean;
  /** Сработало ли исключённое слово; если да — matched обязан быть false. */
  excludedHit: boolean;
}

/* ============================== Нормализация и стемминг ============================== */

/**
 * Минимальная длина основы. Без неё короткие слова («он», «у», «я») схлопнутся
 * в пустоту или в один символ, и сопоставление по основе даст ложные совпадения
 * между совершенно разными словами.
 */
const MIN_STEM_LENGTH = 3;

/**
 * Список русских окончаний из технического задания. Дубликаты и опечатка
 * «лa» (латинская a) не страшны: ниже список уменьшается через Set и
 * сортируется от длинных окончаний к коротким.
 */
const RU_ENDINGS_RAW: readonly string[] = [
  // Прилагательные: «ие», «ого», «его», «ому», «ему» в исходном списке не было.
  // Без них «юридические», «юридического» и «юридическому» давали три разные
  // основы, ни одна из которых не была началом другой, и запрос с одной формой
  // не находил текст с другой — см. тесты «основы прилагательных».
  "ого", "его", "ому", "ему", "ие",
  "иями", "ями", "ами", "ости", "ности", "иями", "иях", "ях", "ах",
  "ов", "ев", "ий", "ей", "ом", "ем", "ам", "ям", "ыми", "ими", "ых", "их",
  "ым", "им", "ой", "ай", "ый", "ий", "ые", "ая", "яя", "ое", "ее", "ую",
  "юю", "ла", "ло", "ли", "ла", "ти", "ть", "ешь", "ете", "ет", "ем", "ут",
  "ют", "ат", "ят", "ишь", "ите", "ит", "им", "на", "но", "ны", "ы", "и",
  "у", "ю", "а", "я", "е", "о", "ь", "й", "м", "х", "т", "н", "в",
];

/**
 * Окончания, отсортированные от длинных к коротким: снимать нужно самое длинное
 * подходящее, иначе «вентилей» потеряет только «й» и основа не совпадёт с
 * «вентиль». Совпадение ищется за один проход — первое (самое длинное) из
 * подходящих окончаний.
 *
 * Списка из задания достаточно для целевого равенства «вентиль / вентиля /
 * вентилей» → «вентил»: «ь» и «я» снимаются по одному символу, «ей» — по два,
 * и во всех трёх формах остаётся корень «вентил». Расширять список не пришлось.
 */
const RU_ENDINGS: readonly string[] = Array.from(new Set(RU_ENDINGS_RAW)).sort(
  (a, b) => b.length - a.length,
);

/** Приводит текст к нижнему регистру и заменяет «ё» на «е». */
function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

/**
 * Кэш основ.
 *
 * Поиск пересчитывается на каждый символ ввода, а слова в закупках повторяются
 * массово: «поставка», «услуги», «выполнение», «ремонт» встречаются почти в
 * каждой карточке. Без кэша каждый keystroke заново прогонял бы десятки тысяч
 * слов по списку окончаний.
 *
 * Ограничение размера обязательно: словарь закупочной лексики большой, а
 * неограниченный Map в долгоживущей вкладке — это утечка. При переполнении
 * кэш просто очищается целиком: потеря тёплых данных дешевле, чем поиск по
 * словарю на 500 000 слов, и следующий же проход наберёт его заново.
 */
const STEM_CACHE_LIMIT = 20_000;
const stemCache = new Map<string, string>();

/**
 * Основа русского слова: отбрасывает окончание, сохраняя корень.
 *
 * Латиница и цифры возвращаются как есть (после нормализации регистра): ни одно
 * окончание из списка им не соответствует, поэтому «samsung» и «2026» не меняются.
 */
export function stemRu(word: string): string {
  const base = normalize(word);
  const cached = stemCache.get(base);
  if (cached !== undefined) return cached;

  let stem = base;
  for (const suffix of RU_ENDINGS) {
    if (base.endsWith(suffix)) {
      const candidate = base.slice(0, base.length - suffix.length);
      stem = candidate.length >= MIN_STEM_LENGTH ? candidate : base;
      break;
    }
  }

  if (stemCache.size >= STEM_CACHE_LIMIT) stemCache.clear();
  stemCache.set(base, stem);
  return stem;
}

/**
 * Разбивает текст на слова: только буквы и цифры, всё остальное — разделители.
 * Точки внутри кодов ОКПД2 здесь теряются намеренно — коды разбираются отдельно,
 * до вызова этой функции, поэтому «36.40.11.133» в слова не попадает.
 */
function splitWords(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/** Убирает дубликаты, сохраняя порядок первого вхождения. */
function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}

/* ============================== Разбор запроса ============================== */

/**
 * Код ОКПД2 — токен только из цифр и точек, не короче 5 символов и хотя бы с
 * одной точкой. Обычные числа без точек («2026») кодом не считаются и остаются
 * словами: иначе год публикации превратился бы в классификатор.
 */
function isOkpd2Code(token: string): boolean {
  return /^[\d.]+$/.test(token) && token.length >= 5 && token.includes(".");
}

/** Выделяет код ОКПД2 из токена, отсекая случайные точки по краям. */
function extractCode(token: string): string | null {
  const cleaned = token.replace(/^\.+|\.+$/g, "");
  return isOkpd2Code(cleaned) ? cleaned : null;
}

/** Ведущий дефис/минус — признак минус-слова. Включены дефис, тире и знак минуса. */
const LEADING_MINUS = /^[-\u2013\u2014\u2212]/;
const LEADING_MINUS_ALL = /^[-\u2013\u2014\u2212]+/;

interface QueryAccumulator {
  terms: string[];
  excluded: string[];
  codes: string[];
}

/** Раскладывает кусок строки (без кавычек) на слова, минус-слова и коды. */
function classifyChunk(chunk: string, acc: QueryAccumulator): void {
  for (const coarse of chunk.split(/[\s,]+/)) {
    const token = coarse.trim();
    if (token.length === 0) continue;

    let body = token;
    let isExcluded = false;
    if (LEADING_MINUS.test(body)) {
      isExcluded = true;
      body = body.replace(LEADING_MINUS_ALL, "");
    }
    if (body.length === 0) continue;

    // Код ищем только у обычных слов: минус-код — противоречие, считаем его словом.
    if (!isExcluded) {
      const code = extractCode(body);
      if (code !== null) {
        acc.codes.push(code);
        continue;
      }
    }

    for (const word of splitWords(body)) {
      if (isExcluded) acc.excluded.push(word);
      else acc.terms.push(word);
    }
  }
}

/**
 * Разбирает строку запроса: слова, минус-слова, коды ОКПД2, фразу в кавычках.
 *
 * Кавычки поддерживаются и прямые ("), и типографские («»), потому что пользователи
 * копируют запросы из разных мест. Фраз несколько — берём первую дословно, а слова
 * остальных возвращаем в общий список: так строка не теряет смысл, даже если человек
 * заключил в кавычки не то, что нужно.
 */
export function parseSearchInput(input: string): ParsedQuery {
  const acc: QueryAccumulator = { terms: [], excluded: [], codes: [] };
  let phrase: string | null = null;

  // Регулярка создаётся локально: глобальный /g-флаг хранит lastIndex, а чистая
  // функция не должна оставлять состояние между вызовами.
  const quoteRe = /"([^"]*)"|«([^»]*)»/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = quoteRe.exec(input)) !== null) {
    classifyChunk(input.slice(cursor, match.index), acc);
    const content = (match[1] ?? match[2] ?? "").trim();
    if (content.length > 0) {
      if (phrase === null) {
        // Первая фраза — дословно, в нижнем регистре, без разбиения на слова.
        phrase = content.toLowerCase();
      } else {
        for (const word of splitWords(content)) acc.terms.push(word);
      }
    }
    cursor = match.index + (match[0]?.length ?? 0);
  }
  classifyChunk(input.slice(cursor), acc);

  return {
    terms: dedupe(acc.terms),
    // Разбор одной строки не знает о ключевых словах профиля: их собирает
    // `buildTextQuery`, складывая каждое в свою группу.
    anyGroups: [],
    excluded: dedupe(acc.excluded),
    codes: dedupe(acc.codes),
    phrase,
  };
}

/**
 * Разбирает отдельное поле «Исключать слова»: слова через запятую или пробел.
 * Минус здесь не нужен — поле и так про исключения, а ведущий дефис смоется как
 * служебный символ.
 */
export function parseExcluded(input: string): string[] {
  return dedupe(splitWords(input));
}

/* ============================== Сборка корпуса ============================== */

/** Собирает непустые строки, игнорируя отсутствующие и пустые значения. */
function nonEmpty(...values: (string | undefined | null)[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) result.push(value);
  }
  return result;
}

/**
 * Кэши корпусов по объекту закупки — отдельно для поиска и для сниппета.
 *
 * WeakMap, а не Map: ключ — сам объект Tender, поэтому запись исчезает вместе с
 * ним и чистить кэш вручную не нужно. Лента пересчитывает выдачу на каждое
 * нажатие клавиши, но объекты закупок между нажатиями те же — именно то окно, в
 * котором пересчёт корпуса дороже всего.
 *
 * Оговорка, которую нужно помнить: если кто-то изменит поля закупки
 * непосредственно в объекте, кэш об этом не узнает. В этом проекте сущности
 * собираются заново из строк БД (`dbRowToTender`) и не мутируются на месте.
 */
const corpusCache = new WeakMap<Tender, SearchCorpus>();
const snippetCorpusCache = new WeakMap<Tender, SearchCorpus>();

/**
 * Собирает поисковый корпус из сущности Tender.
 *
 * В область «Название» кроме предмета закупки попадают реестровые поля: по ним
 * ищут (чаще всего — по номеру извещения), но в сниппете их не показывают.
 * Разбор полей — в `collectParts`, кэш — в `corpusCache`.
 */
export function buildCorpus(tender: Tender): SearchCorpus {
  const cached = corpusCache.get(tender);
  if (cached !== undefined) return cached;

  const parts = collectParts(tender);
  const corpus: SearchCorpus = {
    // Реестровые поля склеиваются с предметом закупки намеренно: номер
    // извещения копируют в строку поиска чаще, чем формулируют предмет словами,
    // и потерять такую выдачу — значит сломать привычный сценарий. Контур номер
    // тоже ищет. В сниппет эти поля не попадают — см. `buildSnippetCorpus`.
    subject: nonEmpty(parts.subjectHead, parts.registry).join("\n"),
    items: parts.items,
    documents: parts.documents,
    codes: parts.codes,
  };
  corpusCache.set(tender, corpus);
  return corpus;
}

/**
 * Корпус для сниппета: те же области поиска, но только тот текст, который
 * уместно цитировать человеку.
 *
 * Заказчик, номер извещения и адрес поставки участвуют в поиске, но в таблице
 * у них свои колонки — повторять их под предметом закупки значит превратить
 * подсказку в шум. Отдельная функция, а не флаг у `buildCorpus`: индекс и
 * сниппет живут в разных кэшах и меняются по разным причинам.
 */
export function buildSnippetCorpus(tender: Tender): SearchCorpus {
  const cached = snippetCorpusCache.get(tender);
  if (cached !== undefined) return cached;

  const parts = collectParts(tender);
  const corpus: SearchCorpus = {
    subject: parts.subjectHead,
    items: parts.items,
    documents: parts.documents,
    codes: [],
  };
  snippetCorpusCache.set(tender, corpus);
  return corpus;
}

/** Поля закупки, из которых собираются оба корпуса. */
interface CorpusParts {
  /** Предмет закупки — единственное, что уместно показывать в сниппете. */
  subjectHead: string;
  /** Заказчик, номер извещения, внешний идентификатор, адрес поставки. */
  registry: string;
  /** Номенклатура: лоты и требования. */
  items: string;
  /** Заголовки и распознанный текст вложений. */
  documents: string;
  /** Коды ОКПД2 из шапки закупки и из лотов, без повторов. */
  codes: string[];
}

/**
 * Раскладывает закупку по полям корпуса.
 *
 * Все массивы и строки могут отсутствовать или быть пустыми (неполные данные из
 * ЕИС, старые записи в localStorage) — поэтому каждое обращение защищено, а
 * пустые поля просто не попадают в корпус. Падение на одной закупке обрушило бы
 * весь поиск, чего быть не должно.
 *
 * Коды ОКПД2 берём и из шапки закупки, и из лотов: у многолотовых закупок
 * классификатор часто лежит только в лоте, и без него поиск по коду промахнётся.
 */
function collectParts(tender: Tender): CorpusParts {
  const itemParts: string[] = [];
  for (const lot of tender.lots ?? []) {
    itemParts.push(...nonEmpty(lot?.subject));
  }
  for (const requirement of tender.requirements ?? []) {
    itemParts.push(...nonEmpty(requirement?.title, requirement?.description));
  }

  const documentParts: string[] = [];
  for (const document of tender.documents ?? []) {
    documentParts.push(...nonEmpty(document?.title, document?.text));
  }

  const lotCodes = (tender.lots ?? []).flatMap((lot) => lot?.okpd2Codes ?? []);

  return {
    subjectHead: nonEmpty(tender.subject).join("\n"),
    registry: nonEmpty(
      tender.customerName,
      tender.regNumber,
      tender.externalId,
      tender.deliveryAddress,
    ).join("\n"),
    items: itemParts.join("\n"),
    documents: documentParts.join("\n"),
    codes: dedupe(nonEmpty(...(tender.okpd2Codes ?? []), ...lotCodes)),
  };
}

/* ============================== Индекс корпуса ============================== */

/**
 * Минимальная длина слова для сопоставления по префиксу.
 *
 * Поиск по основе ловит словоформы («вентиля» → «вентиль»), но не ловит недобор:
 * человек печатает «вент» и ждёт выдачу, а основы «вен» и «вентил» не равны.
 * Префиксное сопоставление закрывает этот случай — и заодно сохраняет прежнее
 * поведение поиска, где работала любая подстрока.
 *
 * Ограничение длины нужно, чтобы огрызки из одной-двух букв не тянули в выдачу
 * всё подряд: «об» нашло бы и «оборудование», и «обслуживание», и «обувь».
 */
const MIN_PREFIX_LENGTH = 3;

/**
 * Сколько букв основа слова текста может не дотягивать до основы запроса.
 *
 * Нужно для словоформ с разным хвостом: «вентиляционные» (основа
 * «вентиляционн») должно находить «вентиляция» («вентиляци») — разница три
 * буквы. Больше трёх — уже другое слово, а не другая форма того же.
 */
const MAX_TAIL_DIFFERENCE = 3;

/**
 * Основа слова текста подходит к основе слова запроса.
 *
 * Правило направленное, потому что случаев два и риск у них разный.
 *
 * Первый: запрос набран не до конца — «вент» должно находить «вентиль». Здесь
 * запрос короче слова текста, и ограничения хватает на длину запроса: не
 * короче `MIN_PREFIX_LENGTH`.
 *
 * Второй: слово текста короче запроса — «вентиляция» в тексте, «вентиляционные»
 * в запросе. Это словоформа, и допустима, только если слово текста почти
 * целиком совпадает с запросом: не короче четырёх букв и не короче основы
 * запроса больше чем на `MAX_TAIL_DIFFERENCE`.
 *
 * Раньше правило было симметричным: хватало любого трёхбуквенного слова. Тогда
 * предлог «под» находил «подстанция», «при» — «приобретение», «без» —
 * «безопасность», а основа «рек» от «реку» — «реклама». На живой базе
 * «подстанция» нашла три закупки, и ни в одной этого слова не было.
 */
function prefixMatch(wordStem: string, queryStem: string): boolean {
  if (wordStem.length === 0 || queryStem.length === 0) return false;

  // Запрос набран не до конца.
  if (queryStem.length >= MIN_PREFIX_LENGTH && wordStem.startsWith(queryStem)) {
    return true;
  }

  // Слово текста — усечённая форма слова запроса.
  return (
    wordStem.length > MIN_PREFIX_LENGTH &&
    queryStem.startsWith(wordStem) &&
    queryStem.length - wordStem.length <= MAX_TAIL_DIFFERENCE
  );
}

/**
 * Идиомы, где «юридический» — не про право: «юридическое лицо» во всех
 * падежах и парах с «физическим», а также «юридический адрес».
 *
 * Слово «юридический» в закупках почти всегда значит именно её: на живой базе
 * из 275 закупок оно встретилось в 24, а о юридических услугах — в трёх.
 * «Услуги юридическому лицу», «страхование имущества юридических лиц»,
 * «проверка юридических и физических лиц» — тот же корень, другой смысл, и
 * запрос «юридические услуги» возвращал их все.
 *
 * Порядок альтернатив важен: пары с «физическим» идут раньше голого
 * «юридическому лицу», иначе «физических» осталось бы в тексте сиротой.
 * Окончания «лица» перечислены, а не `лиц[а-я]*`: иначе под идиому попадала
 * бы «юридическая лицензия».
 */
const LEGAL_ENTITY_IDIOM =
  /физическ[а-я]*\s*(?:,|и|или)?\s*юридическ[а-я]*\s+лиц(?:о|а|у|ом|е|ам|ами|ах)?(?![а-я])|юридическ[а-я]*\s*(?:,|и|или)?\s*(?:физическ[а-я]*\s+)?лиц(?:о|а|у|ом|е|ам|ами|ах)?(?![а-я])|юридическ[а-я]*\s+адрес[а-я]*/g;

/**
 * «Лицо» или «адрес» в запросе: человек сам ищет юридических лиц или
 * юридический адрес, идиому не трогаем.
 */
const LEGAL_ENTITY_WORD = /^(?:лиц(?:о|а|у|ом|е|ам|ами|ах)?|адрес[а-я]*)$/;

/** Слово запроса — «юридический» или его начало, набранное не до конца. */
function isLegalWord(word: string): boolean {
  const norm = normalize(word);
  return norm.length >= 4 && ("юридическ".startsWith(norm) || norm.startsWith("юридическ"));
}

/**
 * Нужно ли читать «юридическ…» в смысле права, а не лица.
 *
 * Да, когда в запросе есть «юридическ…» и нет «лица»: человек, набравший
 * «юридическому лицу», ищет именно их, и вычёркивать идиому у него нельзя.
 */
function readsLegalSense(words: readonly string[]): boolean {
  return (
    words.some((word) => isLegalWord(word)) &&
    !words.some((word) => LEGAL_ENTITY_WORD.test(normalize(word)))
  );
}

/** Разобранный текст одной области поиска. */
export interface ScopeIndex {
  /** Нормализованный текст — для дословного поиска и фраз. */
  normText: string;
  /**
   * Тот же текст с вычеркнутой идиомой «юридическое лицо»; `null`, если её в
   * тексте не было, — тогда читается обычный. Строится только там, где
   * идиома есть: это около десятой доли закупок, и считать основы второй раз
   * для остальных незачем.
   */
  legalSense: ScopeStems | null;
  /** Основы всех слов области — для быстрой проверки равенства. */
  stems: Set<string>;
  /**
   * Те же основы списком.
   *
   * Нужны отдельно от Set, потому что префиксное сопоставление перебором не
   * делается через `has`: «вентиляционные» обязано находить «вентиляция», а их
   * основы различаются хвостом.
   */
  stemList: string[];
}

/**
 * Корпус вместе с разобранным текстом.
 *
 * Разделение нужно из-за скорости: разбор на слова и основы — самая дорогая
 * часть сопоставления, а запрос человек меняет чаще, чем меняется закупка.
 * Индекс строится один раз и переиспользуется на каждый символ ввода.
 */
export interface SearchIndex {
  corpus: SearchCorpus;
  scopes: Record<SearchScope, ScopeIndex>;
}

/** Разбор текста в основы — общая часть полного и «очищенного» вариантов. */
export interface ScopeStems {
  normText: string;
  stems: Set<string>;
  stemList: string[];
}

function stemsOf(text: string): ScopeStems {
  const stemList = dedupe(splitWords(text).map((word) => stemRu(word)));
  return { normText: normalize(text), stems: new Set(stemList), stemList };
}

function indexScope(text: string): ScopeIndex {
  const full = stemsOf(text);
  const cleaned = full.normText.replace(LEGAL_ENTITY_IDIOM, " ");
  return {
    ...full,
    legalSense: cleaned === full.normText ? null : stemsOf(cleaned),
  };
}

/** Строит индекс из готового корпуса. Не кэшируется. */
export function indexCorpus(corpus: SearchCorpus): SearchIndex {
  return {
    corpus,
    scopes: {
      subject: indexScope(corpus.subject),
      items: indexScope(corpus.items),
      documents: indexScope(corpus.documents),
    },
  };
}

/** Кэш индексов по объекту закупки — оговорка та же, что у `corpusCache`. */
const indexCache = new WeakMap<Tender, SearchIndex>();

/**
 * Индекс закупки: корпус плюс разобранный текст, кэшируется на объекте.
 *
 * Это точка входа для ленты: `filterRows` вызывает её на каждой строке при
 * каждом пересчёте, и без кэша ввод одного слова в строку поиска стоил бы
 * десятков тысяч повторных разборов текста.
 */
export function buildSearchIndex(tender: Tender): SearchIndex {
  const cached = indexCache.get(tender);
  if (cached !== undefined) return cached;
  const index = indexCorpus(buildCorpus(tender));
  indexCache.set(tender, index);
  return index;
}

/* ============================== Сопоставление ============================== */

/** Код запроса совпадает с кодом закупки по префиксу, но только на границе сегментов. */
function codeMatches(queryCode: string, corpusCode: string): boolean {
  const q = queryCode.trim();
  const c = corpusCode.trim();
  if (q.length === 0 || c.length === 0) return false;
  // «30.01» подходит к «30.01.24.190», но не к «30.012»: точка не даёт
  // склеить сегменты и принять более короткий код за более длинный.
  return c === q || c.startsWith(`${q}.`);
}

/**
 * Слово запроса найдено в области: сначала по основе (точный и дешёвый путь),
 * затем по префиксу основы (дороже, поэтому только если основа не совпала).
 *
 * Префикс сравнивается именно между основами, а не между словами целиком.
 * Иначе «вентиляционные» не нашло бы закупку про «вентиляция»: основы
 * расходятся хвостом, и `startsWith` на полных словах не срабатывает ни в одну
 * сторону. По основам совпадение симметрично и работает в обоих случаях.
 */
function termHitsScope(index: ScopeStems, stem: string): boolean {
  if (index.stems.has(stem)) return true;
  if (stem.length < MIN_PREFIX_LENGTH) return false;
  return index.stemList.some((wordStem) => prefixMatch(wordStem, stem));
}

/**
 * Сопоставляет индекс закупки с разобранным запросом.
 *
 * Слова строки поиска складываются по «и»: «юридические услуги» — одно
 * понятие, и по отдельности ни одно из слов запроса не выражает. Пока хватало
 * любого, запрос возвращал всё, где есть слово «услуги».
 *
 * Ключевые слова профиля — группы: внутри группы «и», между группами «или».
 * Строка поиска и группы — альтернативы. Коды ОКПД2 — тоже альтернатива
 * словам: подходит закупка с нужным кодом, даже если слов в ней нет.
 *
 * Фраза в кавычках отбором не управляет, когда есть слова: она поднимает
 * закупку в ранжировании (`phraseMatched`). Одна, без слов и кодов, она и
 * есть запрос.
 *
 * Исключения проверяются до вывода о совпадении и перекрывают любой
 * позитивный сигнал. Пустой запрос подходит всегда: поиск без ключевых слов
 * не должен отфильтровать выдачу целиком.
 */
export function matchIndex(
  index: SearchIndex,
  query: ParsedQuery,
  options: MatchOptions = {},
): MatchResult {
  const exact = options.exact ?? false;
  const phrase =
    query.phrase !== null && query.phrase.length > 0
      ? normalize(query.phrase)
      : null;

  const hasQuery =
    query.terms.length > 0 ||
    query.anyGroups.length > 0 ||
    phrase !== null ||
    query.codes.length > 0;
  if (!hasQuery) {
    return {
      matched: true,
      scopes: [],
      matchedTerms: [],
      matchedCodes: [],
      phraseMatched: false,
      excludedHit: false,
    };
  }

  // Пустой список областей = все три; иначе — только запрошенные, но в
  // каноническом порядке и без дубликатов.
  const requested: readonly SearchScope[] =
    options.scopes && options.scopes.length > 0 ? options.scopes : ALL_SCOPES;
  const searchScopes: SearchScope[] = ALL_SCOPES.filter((scope) =>
    requested.includes(scope),
  );

  const toPair = (term: string) => ({
    term,
    normTerm: normalize(term),
    stem: stemRu(term),
  });
  const termPairs = query.terms.map(toPair);
  const groupPairs = query.anyGroups
    .filter((group) => group.length > 0)
    .map((group) => group.map(toPair));

  // «Юридическ…» читается как право, а не как лицо, пока человек не набрал
  // «лицо» сам. Решение одно на весь запрос: у слов одной строки не может
  // быть разных смыслов.
  const legalSense = readsLegalSense([
    ...query.terms,
    ...query.anyGroups.flat(),
    ...(query.phrase !== null ? splitWords(query.phrase) : []),
  ]);
  const view = (data: ScopeIndex): ScopeStems =>
    legalSense && data.legalSense !== null ? data.legalSense : data;

  const hits = (data: ScopeStems, pair: (typeof termPairs)[number]): boolean =>
    exact
      ? data.normText.includes(pair.normTerm)
      : termHitsScope(data, pair.stem);

  const matchedScopes: SearchScope[] = [];
  const matchedTermSet = new Set<string>();
  let phraseMatched = false;
  for (const scope of searchScopes) {
    const data = view(index.scopes[scope]);
    let scopeHit = false;
    for (const pair of [...termPairs, ...groupPairs.flat()]) {
      if (hits(data, pair)) {
        matchedTermSet.add(pair.term);
        scopeHit = true;
      }
    }
    if (phrase !== null && data.normText.includes(phrase)) {
      phraseMatched = true;
      scopeHit = true;
    }
    if (scopeHit) matchedScopes.push(scope);
  }

  // Коды ОКПД2 — отдельный классификатор, а не текстовая область: они матчатся
  // независимо от выбранных областей и не добавляют scope в результат.
  const corpusCodes = index.corpus.codes ?? [];
  const matchedCodes = query.codes.filter((queryCode) =>
    corpusCodes.some((corpusCode) => codeMatches(queryCode, corpusCode)),
  );

  // Исключения проверяются по всем просматриваемым областям, до вывода о совпадении.
  const excludedPairs = query.excluded.map(toPair);
  let excludedHit = false;
  for (const scope of searchScopes) {
    if (excludedHit) break;
    const data = index.scopes[scope];
    for (const pair of excludedPairs) {
      if (hits(data, pair)) {
        excludedHit = true;
        break;
      }
    }
  }

  const boxOk =
    termPairs.length > 0 && termPairs.every((pair) => matchedTermSet.has(pair.term));
  const groupsOk = groupPairs.some((group) =>
    group.every((pair) => matchedTermSet.has(pair.term)),
  );
  const textApplicable = termPairs.length > 0 || groupPairs.length > 0;
  const textOk = boxOk || groupsOk;
  const codesApplicable = query.codes.length > 0;
  const codesOk = matchedCodes.length > 0;

  let signalOk: boolean;
  if (textApplicable && codesApplicable) signalOk = textOk || codesOk;
  else if (textApplicable) signalOk = textOk;
  else if (codesApplicable) signalOk = codesOk;
  else signalOk = phraseMatched;

  const matched = signalOk && !excludedHit;
  const matchedTerms = query.terms.filter((term) => matchedTermSet.has(term));

  return {
    matched,
    scopes: matchedScopes,
    matchedTerms,
    matchedCodes,
    phraseMatched,
    excludedHit,
  };
}

/**
 * Сопоставляет корпус закупки с запросом.
 *
 * Обёртка над `matchIndex` для разовых вызовов: тесты, скрипты, разбор одной
 * закупки. Ленте нужен `buildSearchIndex` — он переиспользует разбор текста.
 */
export function matchCorpus(
  corpus: SearchCorpus,
  query: ParsedQuery,
  options: MatchOptions = {},
): MatchResult {
  return matchIndex(indexCorpus(corpus), query, options);
}

/* ============================== Сниппет ============================== */

/** Длина сниппета по умолчанию — как в выдаче Контур.Закупок. */
const DEFAULT_SNIPPET_CHARS = 220;

/**
 * Проверяет, что токен содержит одно из слов запроса.
 *
 * Правило обязано совпадать с `termHitsScope`: если сниппет ищет только по
 * основе, а закупка попала в выдачу по префиксу, строка таблицы окажется без
 * пояснения — человек увидит результат и не поймёт, что именно в нём нашлось.
 */
function tokenMatchesTerms(token: string, terms: string[]): boolean {
  const runStems: string[] = [];
  for (const run of token.matchAll(/[\p{L}\p{N}]+/gu)) {
    runStems.push(stemRu(run[0] ?? ""));
  }
  if (runStems.length === 0) return false;

  for (const term of terms) {
    const stem = stemRu(term);
    for (const runStem of runStems) {
      // Равенство проверено первым: оно единственный путь для огрызков короче
      // `MIN_PREFIX_LENGTH`, а заодно дешёвый быстрый случай для всех прочих.
      if (runStem === stem) return true;
      if (prefixMatch(runStem, stem)) return true;
    }
  }
  return false;
}

/**
 * Фрагмент текста вокруг первого совпадения, как в выдаче Контур.Закупок.
 *
 * Сниппет строится из целых токенов (кусков без пробелов), поэтому никогда не
 * режет слово или код ОКПД2 пополам. Пробелы и переводы строк схлопываются в
 * один: документация содержит мусорные переносы, и сниппет из них нечитаем.
 * Если текст обрезан с края — добавляется многоточие «…».
 */
export function makeSnippet(
  text: string,
  terms: string[],
  maxChars: number = DEFAULT_SNIPPET_CHARS,
): string | null {
  const cleanTerms = terms.map((term) => term.trim()).filter(Boolean);
  if (text.trim().length === 0 || cleanTerms.length === 0) return null;

  const tokens: { value: string; start: number }[] = [];
  for (const token of text.matchAll(/\S+/g)) {
    tokens.push({ value: token[0] ?? "", start: token.index ?? 0 });
  }
  if (tokens.length === 0) return null;

  // Ищем токен с первым совпадением: основной путь — по основе (как в нечётком
  // поиске), запасной — дословная подстрока (пригодится для exact-режима, где
  // слово могло совпасть лишь частью более длинного токена).
  let matchedIndex = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token && tokenMatchesTerms(token.value, cleanTerms)) {
      matchedIndex = i;
      break;
    }
  }
  if (matchedIndex < 0) {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!token) continue;
      const normalized = normalize(token.value);
      if (cleanTerms.some((term) => normalized.includes(normalize(term)))) {
        matchedIndex = i;
        break;
      }
    }
  }
  if (matchedIndex < 0) return null;

  // Короткий текст возвращаем целиком: обрезать нечего, значит и многоточий нет.
  const collapsedAll = text.replace(/\s+/g, " ").trim();
  if (collapsedAll.length <= maxChars) return collapsedAll;

  const limit = Math.max(1, maxChars);
  const matchedToken = tokens[matchedIndex];
  if (!matchedToken) return null;

  // Расширяем окно вокруг совпадения целыми токенами, не превышая бюджет.
  let lo = matchedIndex;
  let hi = matchedIndex;
  let length = matchedToken.value.length;
  let grew = true;
  while (grew) {
    grew = false;
    const right = tokens[hi + 1];
    if (right && length + 1 + right.value.length <= limit) {
      length += 1 + right.value.length;
      hi += 1;
      grew = true;
    }
    const left = tokens[lo - 1];
    if (left && length + 1 + left.value.length <= limit) {
      length += 1 + left.value.length;
      lo -= 1;
      grew = true;
    }
  }

  const fragment = tokens
    .slice(lo, hi + 1)
    .map((token) => token.value)
    .join(" ");
  const prefix = lo > 0 ? "…" : "";
  const suffix = hi < tokens.length - 1 ? "…" : "";
  return `${prefix}${fragment}${suffix}`;
}

/**
 * Порядок областей для сниппета: название важнее номенклатуры, а та важнее
 * документации. Документация последняя потому, что извещение на двести страниц
 * содержит почти любое слово, и фрагмент из него объясняет совпадение хуже.
 */
const SNIPPET_SCOPE_ORDER: readonly SearchScope[] = [
  "subject",
  "items",
  "documents",
];

/**
 * Сниппет по результату сопоставления.
 *
 * Текст берётся из первой совпавшей области в порядке важности. Слова для
 * подсветки — совпавшие; если совпадение дал только код ОКПД2 (слов нет),
 * ищем по самим кодам, иначе сниппет оказался бы пустым ровно у тех закупок,
 * которые человек нашёл по классификатору.
 */
export function snippetForMatch(
  corpus: SearchCorpus,
  match: MatchResult,
  query: ParsedQuery,
  maxChars: number = DEFAULT_SNIPPET_CHARS,
): string | null {
  if (!match.matched) return null;

  const terms =
    match.matchedTerms.length > 0
      ? match.matchedTerms
      : match.matchedCodes.length > 0
        ? match.matchedCodes
        : query.phrase !== null
          ? [query.phrase]
          : query.terms;
  if (terms.length === 0) return null;

  const scopes =
    match.scopes.length > 0
      ? SNIPPET_SCOPE_ORDER.filter((scope) => match.scopes.includes(scope))
      : SNIPPET_SCOPE_ORDER;

  for (const scope of scopes) {
    const snippet = makeSnippet(corpus[scope], terms, maxChars);
    if (snippet !== null) return snippet;
  }
  return null;
}

/** Текст в виде сниппета: одиночные пробелы, без регистра. */
function collapseText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Сниппет дословно повторяет текст, который уже показан целиком.
 *
 * Совпадение в коротком названии даёт сниппет, равный этому названию: на экране
 * оно напечатано дважды, и вторая копия ничего не объясняет. У длинного названия
 * таблица обрезает текст, а сниппет показывает окно вокруг совпадения — такие
 * строки не равны, и сниппет остаётся полезным.
 */
export function snippetIsRedundant(
  snippet: string | null,
  visibleText: string,
): boolean {
  if (snippet === null) return true;
  return collapseText(snippet) === collapseText(visibleText);
}
