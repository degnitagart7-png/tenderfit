import {
  findNorms,
  normKey,
  tableRows,
  type NormMatch,
  type NormSearchIndex,
} from "@/domain/estimate/matchNorms";
import { normalizeText, tableCodeOf } from "@/domain/estimate/normalize";
import type { NormRecord } from "@/domain/estimate/types";
import { deriveUnitDivisor } from "@/domain/estimate/units";

/**
 * Кандидаты на роль нормы для «ИИ-сметчика».
 *
 * Зачем модуль. Подбор по наименованию (`findNorms` + порог `trustedByName`) ищет по словам, а ведомость и
 * ФСНБ называют одну работу по-разному: «Демонтаж профлиста» у заказчика — «Замена облицовки … из металлического
 * сайдинга» (ГЭСНр 63-03-007), «Снятие ветрозащитной мембраны» — «Устройство ветро-гидрозащиты вентилируемого фасада»
 * (ГЭСН 26-01-066), «Монтаж стыковочной планки» — «Установка нащельников» (ГЭСН 09-05-009). Общих слов нет, поиск находит
 * бурильные установки по слову «демонтаж» или ничего. Выбрать по смыслу умеет модель, но выбирать ей разрешено только
 * из списка, который собрал код: придумать расценку она не может, а каждый ответ сверяется с этим списком.
 *
 * Как собирается список (чистая функция, без сети и без модели):
 * 1. Поиск по наименованию как есть и по вариантам запроса: глагол заменяется синонимами («демонтаж» ↔ «разборка» ↔
 *    «снятие»), предмет — словами из справочника ниже («профлист» → «облицовка металлического сайдинга»). Для работ на
 *    разборку дополнительно ищется отдельно в ГЭСНр и в сборнике ГЭСН 46: общий поиск по слову «демонтаж» уходит в
 *    демонтаж оборудования других сборников.
 * 2. Результаты запросов сводятся по рангу (reciprocal rank fusion): норма, которую нашли несколько формулировок, выше
 *    той, что нашла одна. Вес запроса тем выше, чем ближе он к исходному наименованию.
 * 3. К лучшим таблицам добавляются соседние строки: толщина, высота, диаметр, площадь «в одном месте» различают строки
 *    одной таблицы, и без них модель выбрала бы между строками вслепую.
 * 4. Строки, единица которых не переводится в единицу позиции, отбрасываются: такая норма в расчёт не войдёт (`units.ts`),
 *    предлагать её бессмысленно.
 *
 * На каждого кандидата уходит книга, шифр, наименование таблицы и строки, единица, сборник и короткий «Состав работ»
 * (первые ~200 знаков): состав часто решает, что норма включает демонтаж или водоотлив. Промпт сгруппирован по таблицам, чтобы
 * название и состав не повторялись у каждой строки.
 */

/** Сколько строк-кандидатов уходит модели на одну позицию. */
export const MAX_CANDIDATES = 25;
/** Сколько таблиц участвует в выдаче. */
export const MAX_TABLES = 8;
/** Сколько знаков «Состава работ» уходит модели. */
export const SUMMARY_CHARS = 200;
/** Наименование строки длиннее обрезается: хвосты вроде «с устройством водоотлива оконного из оцинкованной стали…» раздувают промпт. */
const ROW_NAME_CHARS = 140;
/** Лимит строк таблицы по месту таблицы в рейтинге: у лучших таблиц соседей больше, у остальных — только найденные строки. */
const ROWS_BY_TABLE_RANK: readonly number[] = [8, 8, 5, 5, 3, 3, 3, 3];
/** Константа reciprocal rank fusion: чем больше, тем мягче разница между рангами. */
const RRF_K = 8;
/**
 * Сколько результатов берётся с обычного запроса и с запроса-варианта — после отсева по единице. Поиск идёт с запасом
 * (`SEARCH_DEPTH`): норма в «м3», найденная раньше нужной в «100 м2», не должна занимать её место.
 */
const PRIMARY_LIMIT = 10;
const VARIANT_LIMIT = 6;
const SEARCH_DEPTH = 40;
/** Предел вариантов запроса: каждый — отдельный проход по индексу. */
const MAX_QUERIES = 22;

/* ------------------------------ справочник синонимов ------------------------------ */

/** Вид действия в наименовании работы. */
export type ActionKind = "DISMANTLE" | "INSTALL" | "REPLACE";

interface ActionGroup {
  readonly kind: ActionKind;
  /** Начала слов (после нормализации), по которым действие узнаётся в наименовании. */
  readonly triggers: readonly string[];
  /** Формулировки нормативной базы для того же действия; первая — основная. */
  readonly forms: readonly string[];
}

/**
 * Глаголы и отглагольные существительные. ФСНБ-2022 говорит «Разборка» и «Устройство», ведомость — «Демонтаж», «Снятие»,
 * «Монтаж». Начало слова вместо основы: «демонтажа», «демонтаже» совпадают с «демонтаж» без стемминга.
 */
export const ACTION_GROUPS: readonly ActionGroup[] = [
  {
    kind: "DISMANTLE",
    triggers: ["демонтаж", "разборк", "разбор", "снятие", "снятия", "снять", "снос", "удален", "вскрыти"],
    forms: ["разборка", "демонтаж", "снятие"],
  },
  {
    kind: "INSTALL",
    triggers: ["монтаж", "устройств", "установк", "укладк", "навеск", "прокладк", "крепление", "крепления"],
    forms: ["устройство", "установка", "монтаж", "укладка"],
  },
  {
    kind: "REPLACE",
    triggers: ["замен", "смен", "ремонт", "восстановлен"],
    forms: ["замена", "смена", "ремонт"],
  },
];

/** Группа слов-предметов: чем предмет ведомости называется в ФСНБ. */
export interface ObjectGroup {
  readonly id: string;
  /** Начала слов (после нормализации) в наименовании работы. */
  readonly triggers: readonly string[];
  /** Как тот же предмет называет ФСНБ-2022 (ГЭСН, ГЭСНр). Первые идут в поиск первыми. */
  readonly phrases: readonly string[];
}

/**
 * Предметы работ и их названия в ФСНБ. Таблица небольшая намеренно: каждая строка — ошибка, которую поймал разбор реальной
 * ведомости (закупка 0134300025826000377, фасад). Дополняется по итогам бенчмарка; лишняя строка стоит только лишнего запроса
 * к индексу, а не лишних слов в ответе.
 */
export const OBJECT_GROUPS: readonly ObjectGroup[] = [
  {
    id: "insulation",
    triggers: ["утеплител", "теплоизол", "минват", "минераловат", "пенопласт", "пеноплекс", "пенополистирол", "эппс"],
    phrases: [
      "изоляция стен изделиями из минераловатных плит",
      "тепловая изоляция",
      "утепление наружных стен зданий",
      "теплоизоляция плитами",
      "изоляция из ваты минеральной",
    ],
  },
  {
    id: "profiled-sheet",
    triggers: ["профлист", "профнастил", "профилирован", "металлосайдинг", "оцинкованн"],
    phrases: [
      "облицовка стен из металлического сайдинга",
      "профилированный лист",
      "обшивка стен профилированным листом",
      "кровля из профилированного листа",
      "облицовка наружных стен металлическими листами",
    ],
  },
  {
    id: "membrane",
    triggers: ["мембран", "ветрозащит", "гидроветр", "ветро", "пароизоляц", "паробарьер", "гидробарьер"],
    phrases: [
      "ветро-гидрозащита вентилируемого фасада",
      "ветрозащита",
      "гидроизоляция пленкой полимерной",
      "пароизоляция",
    ],
  },
  {
    id: "slope",
    triggers: ["откос"],
    phrases: [
      "облицовка оконных проемов откосной планкой",
      "облицовка откосов оконных проемов",
      "отделка откосов оконных и дверных проемов",
    ],
  },
  {
    id: "flashing",
    triggers: ["планк", "нащельник", "отлив", "слив", "водоотлив", "капельник", "карниз", "парапетн"],
    phrases: ["нащельники", "установка нащельников", "планка", "водоотлив оконный", "отливы"],
  },
  {
    id: "facade",
    triggers: ["сайдинг", "облицовк", "обшивк", "кассет", "фасадн", "навесн", "вентфасад", "вентилируем"],
    phrases: ["облицовка наружных стен", "сайдинг", "система навесного вентилируемого фасада", "облицовка фасада"],
  },
  {
    id: "window",
    triggers: ["окн", "оконн", "подоконник"],
    phrases: ["блоки оконные", "заполнение оконных проемов", "подоконные доски", "окна"],
  },
  {
    id: "door",
    triggers: ["двер", "дверн"],
    phrases: ["блоки дверные", "заполнение дверных проемов", "двери"],
  },
  {
    id: "drain",
    triggers: ["водосточн", "водосток", "желоб", "воронк"],
    phrases: ["трубы водосточные", "желоба подвесные", "звенья водосточных труб", "воронки водосточные"],
  },
  {
    id: "paint",
    triggers: ["окраск", "покраск", "краск", "грунтовк"],
    phrases: ["окраска", "покраска поверхностей", "грунтование поверхностей"],
  },
  {
    id: "tile",
    triggers: ["плитк", "керамогранит"],
    phrases: ["облицовка стен плитками керамическими", "облицовка поверхностей плиткой", "устройство покрытий из плиток"],
  },
  {
    id: "scaffold",
    triggers: ["лес", "подмост", "люльк"],
    phrases: ["леса строительные", "установка лесов", "подмости"],
  },
  {
    id: "sealant",
    triggers: ["герметик", "герметизац", "монтажн", "заделк"],
    phrases: ["герметизация швов", "заделка швов", "заполнение швов монтажной пеной"],
  },
  {
    id: "roof",
    triggers: ["кровл", "кровельн", "ендов", "конек", "коньк"],
    phrases: ["кровля", "устройство кровель", "покрытие кровли", "коньки"],
  },
];

/** Слова нормализованного текста. */
function wordsOf(text: string): string[] {
  return normalizeText(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

/** Вид действия: первое слово наименования, с которого начинается триггер группы. */
export function actionOf(text: string): { kind: ActionKind; word: string } | null {
  for (const word of wordsOf(text)) {
    for (const group of ACTION_GROUPS) {
      if (group.triggers.some((trigger) => word.startsWith(trigger))) return { kind: group.kind, word };
    }
  }
  return null;
}

/** Группы предметов, упомянутых в тексте, в порядке справочника. */
export function objectGroupsOf(text: string): ObjectGroup[] {
  const words = wordsOf(text);
  return OBJECT_GROUPS.filter((group) => words.some((word) => group.triggers.some((trigger) => word.startsWith(trigger))));
}

/** Один запрос к индексу норм. */
export interface QueryVariant {
  readonly text: string;
  /** Вес в сводке: исходное наименование — 1, варианты — меньше. */
  readonly weight: number;
  /** Запрос на разборку: для него добавляются поиски в ГЭСНр и сборнике ГЭСН 46. */
  readonly dismantle: boolean;
}

/** Наименование без скобок и чисел с единицами: «Монтаж утеплителя (2 слоя 150+50 мм)» → «Монтаж утеплителя». */
function stripped(workName: string): string {
  return workName
    .replace(/\([^)]*\)/gu, " ")
    .replace(/\d[\d.,+×x*/-]*\s*(?:мм|см|м2|м3|м|шт|кг|т)?(?![\p{L}])/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Варианты запроса под наименование работы.
 *
 * Порядок — по убыванию доверия, ограничение — `MAX_QUERIES`. Действие берётся из наименования, а когда там его нет
 * («Утеплитель» в разделе «Демонтажные работы»), из заголовка раздела ведомости: без него «Утеплитель» искался бы как
 * монтаж.
 */
export function queryVariants(workName: string, sectionHint: string | null = null): QueryVariant[] {
  const name = workName.replace(/\s+/gu, " ").trim();
  if (name === "") return [];

  const own = actionOf(name);
  const fromSection = own === null && sectionHint !== null ? actionOf(sectionHint) : null;
  const action = own?.kind ?? fromSection?.kind ?? null;
  const dismantle = action === "DISMANTLE";
  const group = ACTION_GROUPS.find((candidate) => candidate.kind === action);

  const queries: QueryVariant[] = [];
  const seen = new Set<string>();
  const add = (text: string, weight: number, isDismantle = dismantle): void => {
    const cleaned = text.replace(/\s+/gu, " ").trim();
    const key = normalizeText(cleaned);
    if (key === "" || seen.has(key) || queries.length >= MAX_QUERIES) return;
    seen.add(key);
    queries.push({ text: cleaned, weight, dismantle: isDismantle });
  };

  add(name, 1);
  const bare = stripped(name);
  if (bare !== name) add(bare, 0.9);

  // Действие из раздела, которого нет в наименовании: «Утеплитель» → «разборка утеплитель».
  if (own === null && group !== undefined) add(`${group.forms[0] ?? ""} ${bare === "" ? name : bare}`, 0.8);

  // Другие формулировки того же действия: «Демонтаж профлиста» → «разборка профлиста», «снятие профлиста».
  const rest = own === null ? bare : stripped(name.replace(new RegExp(own.word, "iu"), " "));
  if (group !== undefined && own !== null) {
    for (const form of group.forms) {
      if (own.word.startsWith(form.slice(0, 6))) continue;
      add(`${form} ${rest}`, 0.85);
    }
  }

  // Предметы: «профлист» называется в ФСНБ иначе, поэтому ищется и по названиям ФСНБ, с действием и без него.
  // Формулировки идут кругами по группам: иначе первая группа занимает все места, и вторая («планка» → «нащельники»)
  // остаётся без запросов.
  const objects = objectGroupsOf(bare === "" ? name : bare).slice(0, 3);
  const verb = group?.forms[0] ?? "";
  for (let round = 0; round < 4; round += 1) {
    for (const object of objects) {
      const phrase = object.phrases[round];
      if (phrase === undefined) continue;
      add(phrase, 0.6);
      if (round < 2 && verb !== "") add(`${verb} ${phrase}`, 0.75);
    }
  }
  return queries;
}

/* ------------------------------ поиск ------------------------------ */

/** Один кандидат: всё, что видит модель про одну строку нормы. */
export interface NormPickCandidate {
  /** «книга|шифр», например «ГЭСНр|66-01-024-02» — тот, что модель вернёт в ответе. */
  readonly key: string;
  readonly book: string;
  readonly code: string;
  readonly tableCode: string;
  /** Наименование таблицы (полное наименование без окончания строки); у таблицы из одной строки — всё наименование. */
  readonly tableName: string;
  /** Окончание строки: чем строка отличается от соседних («в два слоя общей толщиной 150 мм»). */
  readonly rowName: string;
  readonly unit: string;
  /** Сборник и подраздел: «Отделочные работы / наружная облицовка фасадов». */
  readonly collection: string;
  /** «Состав работ», первые ~200 знаков; пусто, если в норме его нет. */
  readonly summary: string;
}

/** Что известно о позиции ведомости при поиске кандидатов. */
export interface CandidateSearchInput {
  readonly workName: string;
  /** Единица ведомости и единицы других величин той же строки («м3/т»). Пусто — единицы не фильтруют. */
  readonly units: readonly string[];
  /** Заголовок раздела ведомости: подсказывает действие, если наименование его не содержит. */
  readonly section?: string | null;
}

/** Обрезка по границе слова с многоточием. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/u, "")}…`;
}

function tableNameOf(norm: NormRecord): string {
  const full = norm.fullName.replace(/\s+/gu, " ").trim();
  const end = norm.endName.replace(/\s+/gu, " ").trim();
  if (end === "" || end === full || !full.endsWith(end)) return full;
  const head = full.slice(0, full.length - end.length).replace(/[\s:]+$/u, "").trim();
  return head === "" ? full : head;
}

/** Строка нормы в виде, пригодном для промпта. */
export function candidateOf(norm: NormRecord): NormPickCandidate {
  const tableName = tableNameOf(norm);
  const end = norm.endName.replace(/\s+/gu, " ").trim();
  const rowName = tableName === norm.fullName.replace(/\s+/gu, " ").trim() ? "" : clip(end, ROW_NAME_CHARS);
  const place = (norm.subsectionName.trim() !== "" ? norm.subsectionName : norm.sectionName).trim().toLowerCase();
  return {
    key: normKey(norm.baseType, norm.code),
    book: norm.baseType,
    code: norm.code,
    tableCode: tableCodeOf(norm.code),
    tableName: clip(tableName, 220),
    rowName,
    unit: norm.unit,
    collection: clip(place === "" ? norm.collectionName : `${norm.collectionName} / ${place}`, 110),
    summary: clip(norm.content.join(" "), SUMMARY_CHARS),
  };
}

/** Кэш поиска на индекс: одни и те же фразы справочника ищутся для каждой позиции ведомости. */
const SEARCH_CACHE = new WeakMap<NormSearchIndex, Map<string, readonly NormMatch[]>>();

function cachedSearch(
  index: NormSearchIndex,
  request: { workName: string; limit: number; normBaseType?: string; collectionCode?: string },
): readonly NormMatch[] {
  let bucket = SEARCH_CACHE.get(index);
  if (bucket === undefined) {
    bucket = new Map();
    SEARCH_CACHE.set(index, bucket);
  }
  const key = `${request.normBaseType ?? ""}|${request.collectionCode ?? ""}|${String(request.limit)}|${request.workName}`;
  const hit = bucket.get(key);
  if (hit !== undefined) return hit;
  const found = findNorms(index, request);
  // Кэш ограничен: ведомость на тысячу строк не должна растить его бесконечно.
  if (bucket.size > 4000) bucket.clear();
  bucket.set(key, found);
  return found;
}

/** Сколько норм кандидата внутри одной таблицы окно соседей берёт вокруг лучшей строки. */
function windowAround<T>(rows: readonly T[], centre: number, size: number): T[] {
  if (rows.length <= size) return [...rows];
  const start = Math.min(Math.max(centre - Math.floor(size / 2), 0), rows.length - size);
  return rows.slice(start, start + size);
}

/**
 * Кандидаты на роль нормы под позицию ведомости: до `MAX_CANDIDATES` строк, сгруппированных по таблицам (таблицы — в порядке
 * убывания релевантности, строки внутри таблицы — по шифру).
 */
export function collectNormCandidates(index: NormSearchIndex, input: CandidateSearchInput): NormPickCandidate[] {
  const queries = queryVariants(input.workName, input.section ?? null);
  if (queries.length === 0) return [];

  const fitsUnit = (norm: NormRecord): boolean =>
    input.units.length === 0 || input.units.some((unit) => deriveUnitDivisor(unit, norm.unit) !== null);

  const scores = new Map<string, { norm: NormRecord; score: number }>();
  /*
    Вклад нормы в сводку — вес запроса, ранг и квадрат покрытия: запрос «ветро-гидрозащита вентилируемого фасада» находит нужную
    таблицу с покрытием 1,0, а общая фраза — десяток случайных с 0,6, и без покрытия консенсус случайных побеждал бы точное попадание.
  */
  const credit = (matches: readonly NormMatch[], weight: number, limit: number): void => {
    matches
      .filter((match) => fitsUnit(match.norm))
      .slice(0, limit)
      .forEach((match, rank) => {
        const key = normKey(match.norm.baseType, match.norm.code);
        const gain = (weight * Math.max(match.coverage, 0.05) ** 2) / (RRF_K + rank);
        const entry = scores.get(key);
        if (entry === undefined) scores.set(key, { norm: match.norm, score: gain });
        else entry.score += gain;
      });
  };

  queries.forEach((query, position) => {
    credit(cachedSearch(index, { workName: query.text, limit: SEARCH_DEPTH }), query.weight, position === 0 ? PRIMARY_LIMIT : VARIANT_LIMIT);
    if (!query.dismantle || position > 7) return;
    // Разборка в ГЭСНр и сборнике ГЭСН 46: общий поиск по слову «демонтаж» уходит в демонтаж оборудования.
    credit(cachedSearch(index, { workName: query.text, limit: SEARCH_DEPTH, normBaseType: "ГЭСНр" }), query.weight * 0.9, VARIANT_LIMIT);
    credit(cachedSearch(index, { workName: query.text, limit: SEARCH_DEPTH, normBaseType: "ГЭСН", collectionCode: "46" }), query.weight * 0.6, 4);
  });

  // Таблицы: оценка — лучшая строка и небольшая надбавка за число найденных строк.
  const tables = new Map<string, { book: string; tableCode: string; best: number; bestKey: string; hits: number }>();
  for (const [key, entry] of scores) {
    if (!fitsUnit(entry.norm)) continue;
    const tableCode = tableCodeOf(entry.norm.code);
    const id = `${entry.norm.baseType}|${tableCode}`;
    const table = tables.get(id);
    if (table === undefined) {
      tables.set(id, { book: entry.norm.baseType, tableCode, best: entry.score, bestKey: key, hits: 1 });
    } else {
      table.hits += 1;
      if (entry.score > table.best) {
        table.best = entry.score;
        table.bestKey = key;
      }
    }
  }

  const ranked = [...tables.values()]
    .map((table) => ({ table, score: table.best * (1 + 0.05 * Math.min(table.hits, 5)) }))
    .sort((a, b) => b.score - a.score || a.table.book.localeCompare(b.table.book, "ru") || a.table.tableCode.localeCompare(b.table.tableCode, "ru"))
    .slice(0, MAX_TABLES);

  const result: NormPickCandidate[] = [];
  for (const [place, { table }] of ranked.entries()) {
    if (result.length >= MAX_CANDIDATES) break;
    const siblings = tableRows(index, table.tableCode, table.book)
      .filter(fitsUnit)
      .sort((a, b) => a.code.localeCompare(b.code, "ru"));
    const centre = Math.max(
      siblings.findIndex((norm) => normKey(norm.baseType, norm.code) === table.bestKey),
      0,
    );
    const room = Math.min(ROWS_BY_TABLE_RANK[place] ?? 3, MAX_CANDIDATES - result.length);
    for (const norm of windowAround(siblings, centre, room)) result.push(candidateOf(norm));
  }
  return result;
}
