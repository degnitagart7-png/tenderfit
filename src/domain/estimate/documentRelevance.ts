import type { VolumeSourceLevel } from "@/domain/estimate/types";
import {
  LEVEL_LABEL,
  classifyDocument,
  classifyHeading,
  documentHeadings,
  hasBillSignal,
  stripHeadingPrefix,
} from "@/domain/estimate/volumeSource";

/**
 * Какие документы закупки стоит читать моделью, а какие заведомо без объёмов.
 *
 * Зачем. Извлечение ведомости (`extractBillOfWork`) отправляло в модель каждый документ, который не прочитал код:
 * проект контракта, требования к составу заявки, инструкцию участникам, формы, анкеты, протоколы. Это 60–70 % расхода на
 * смету (одна смета 15–19 ₽, бенчмарк из десяти закупок 120–190 ₽), а строк ведомости в таких документах нет: в проекте
 * контракта есть «срок выполнения работ — 90 дней», но нет «Окраска стен — 125 м2». Каждый круг бенчмарка при этом
 * перечитывал те же самые документы.
 *
 * Принцип: пропускается только то, что ЗАВЕДОМО без объёмов, и только когда объёмов в тексте не видно. Решение принимается
 * по четырём ступеням, и первая сработавшая заканчивает разбор:
 *   1. Уровень документа не ТЗ (ведомость, смета заказчика, смета контракта — `classifyDocument`): читается всегда.
 *   2. Признаки объёмов в тексте (см. ниже): читается, какое бы имя ни было у файла.
 *   3. Имя файла или заголовок первых строк называет безобъёмный документ (проект контракта, требования к заявке, …) и
 *      в имени нет слов «ТЗ», «спецификация», «ведомость», «смета»: пропускается.
 *   4. Всё остальное (имя ничего не говорит) читается: цена ошибки «не прочли ТЗ» — потерянная смета, цена лишнего чтения —
 *      полтора рубля. Поэтому незнакомое не пропускается никогда.
 *
 * Признаки объёмов (ступень 2):
 *   — сильные: `hasBillSignal` (имя или заголовок «Ведомость объёмов работ», дефектная ведомость, ВОР) и заголовок сметы
 *     (локальный сметный расчёт, смета контракта). Читаются сами по себе: приложенный к проекту контракта лист «Ведомость
 *     объёмов работ» — это ведомость;
 *   — плотность строк с количеством: строки, где число стоит рядом со строительной единицей (м2, м3, п.м, шт, т, кг, компл,
 *     100 м2, маш.-ч, …). Порог — не меньше 5 строк ИЛИ не реже одной на 2000 знаков (но не меньше двух). Подбор: в проекте
 *     контракта случайные «5 т», «10 шт.» бывают единицами, а ТЗ с таблицей работ даёт десятки строк, поэтому 5 отсекает
 *     случайные упоминания, а «одна на 2000» ловит короткие ТЗ из трёх-четырёх позиций без таблицы;
 *   — слабые: заголовок «Техническое задание», «Описание объекта закупки», «Спецификация», «Смета», «Объём работ»,
 *     «Перечень работ», «Ведомость …». Слабые читаются только вместе с двумя строками с количеством ПОД заголовком: ссылка
 *     «Приложение № 1 — Техническое задание» есть в каждом проекте контракта, и без этой оговорки он читался бы всегда.
 *
 * Файлы архива. Текст архива — несколько файлов подряд под метками «=== имя ===» (так же метятся листы книги). Каждая часть
 * решается отдельно, в модель уходит текст только нужных частей: метки читаемых частей сохраняются, а раз разбор заголовков,
 * разделов и цитат ведётся по тому же урезанному тексту, смещения и проверка цитат не нарушаются. Ничего решающего в имени
 * листа нет, поэтому лист с неузнанным именем читается.
 *
 * Как проверить пороги: `scripts/estimate-doc-filter-eval.ts` печатает решение по каждому документу закупок без вызова модели.
 */

/** Переменная окружения: «1» возвращает чтение всех документов (диагностика). */
export const READ_ALL_DOCUMENTS_ENV = "ESTIMATE_READ_ALL_DOCUMENTS";

/** Строк с количеством достаточно для чтения само по себе. */
export const QUANTITY_LINES_MIN = 5;
/** Или хотя бы одна такая строка на столько знаков (но не меньше `QUANTITY_LINES_FLOOR`). */
export const QUANTITY_LINE_PER_CHARS = 2_000;
export const QUANTITY_LINES_FLOOR = 2;
/** Слабый заголовок («Техническое задание») читает документ вместе с этим числом строк с количеством. */
export const WEAK_HEADING_MIN_LINES = 2;

export interface ReadDecision {
  readonly read: boolean;
  /** Человеческая причина решения: попадает в отчёт расчёта. */
  readonly reason: string;
}

/** Решение по одному файлу (части архива) или по документу целиком. */
export interface PartDecision extends ReadDecision {
  readonly name: string;
  readonly level: VolumeSourceLevel;
  /** Размер текста части в знаках. */
  readonly chars: number;
  /** Сколько строк с количеством нашлось (см. `countQuantityLines`). */
  readonly quantityLines: number;
}

export interface SkippedDocument {
  readonly name: string;
  readonly reason: string;
  readonly chars: number;
}

export interface DocumentSelection {
  /** Текст для модели: исходный, если читается всё; только читаемые части, если часть архива пропущена; пустой, если пропущено всё. */
  readonly text: string;
  readonly read: boolean;
  readonly reason: string;
  readonly parts: readonly PartDecision[];
  /** Пропущенное: документ целиком или файл архива — с причиной. */
  readonly skipped: readonly SkippedDocument[];
}

/* ------------------------------ Строки с количеством ------------------------------ */

function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

/** Приводит текст к виду для поиска единиц: нижний регистр, «ё» → «е», «м²» → «м2», неразрывный пробел → пробел. */
function foldUnits(text: string): string {
  return fold(text).replace(/²/g, "2").replace(/³/g, "3").replace(/ /g, " ");
}

/**
 * Единицы строительных объёмов. Однобуквенные «т», «л», «м» не принимаются, если за ними точка и буква: «т.е.», «т.к.», «л.с.»,
 * «м.п.» разбирается отдельной веткой. «Ед. изм.» — подпись колонки, а не единица.
 */
const UNIT_FORWARD = String.raw`(?:кв\.?\s?м|куб\.?\s?м|пог\.?\s?м|п\.\s?м|м\.\s?п|маш\.?\s?[-–]?\s?ч|чел\.?\s?[-–]?\s?ч|[мm][23]|комплект\p{L}*|компл|шт|тн|кг|км|га|ед(?!\.?\s?изм)|т(?!\.\p{L})|л(?!\.\p{L})|м(?!\.\p{L}))`;
/** Единица ПЕРЕД числом (колонки «ед. | объём»): только многобуквенные, иначе «т 5» и «м 3» из обычного текста дают ложные строки. */
const UNIT_REVERSE = String.raw`(?:кв\.?\s?м|куб\.?\s?м|пог\.?\s?м|п\.\s?м|м\.\s?п|[мm][23]|комплект\p{L}*|компл|шт|тн|кг|км|га)`;
const NUMBER = String.raw`\d+(?:[ ]\d{3})*(?:[.,]\d+)?`;

const QUANTITY_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d.,/])${NUMBER}[\s|;\t]{0,3}${UNIT_FORWARD}(?![\p{L}\d])|(?<![\p{L}\d])${UNIT_REVERSE}(?![\p{L}\d])[\s|;\t]{1,3}${NUMBER}(?![\d])`,
  "gu",
);

/** Два засчитанных вхождения не ближе этого друг к другу: «1 шт 10 м» в одной строке — одна строка, а не две. */
const MIN_MATCH_GAP = 30;

/**
 * Сколько строк текста содержат число рядом со строительной единицей: «125,5 м2», «100 м2 | 0,899», «м3 | 1 240,5», «12 шт.».
 *
 * Считаются вхождения, а не переводы строк: таблицы из PDF нередко приходят одной длинной строкой, и подсчёт по строкам дал бы
 * единицу на всю ведомость. Вхождения ближе 30 знаков друг к другу — одна строка.
 */
export function countQuantityLines(text: string): number {
  const folded = foldUnits(text);
  let count = 0;
  let last = -MIN_MATCH_GAP;
  for (const match of folded.matchAll(QUANTITY_PATTERN)) {
    if (match.index - last >= MIN_MATCH_GAP) {
      count += 1;
      last = match.index;
    }
  }
  return count;
}

/** Достаточно ли строк с количеством для чтения: ≥ 5 или не реже одной на 2000 знаков (но не меньше двух). */
export function isDenseInQuantities(quantityLines: number, chars: number): boolean {
  if (quantityLines >= QUANTITY_LINES_MIN) return true;
  return quantityLines >= QUANTITY_LINES_FLOOR && quantityLines * QUANTITY_LINE_PER_CHARS >= chars;
}

/* ------------------------------ Заголовки объёмов ------------------------------ */

const MAX_WEAK_HEADING_LINE = 160;

/** Слабые заголовки: начало строки после «Приложение № N», «Раздел N», номера пункта (`stripHeadingPrefix`). */
const WEAK_HEADINGS: readonly RegExp[] = [
  /^ведомост\p{L}*(?![\p{L}])/u,
  /^объ[её]м\p{L}*\s+(?:работ|выполн)/u,
  /^техническ\p{L}*\s+задани/u,
  /^тз(?![\p{L}])/u,
  /^описани\p{L}*\s+объект\p{L}*\s+закупк/u,
  /^спецификаци/u,
  /^смет\p{L}*(?![\p{L}])/u,
  /^дефектн\p{L}*/u,
  /^перечень\s+(?:работ|материал|товар)/u,
];

/** Слабый заголовок: его текст и где он стоит. */
interface WeakHeading {
  readonly title: string;
  readonly offset: number;
}

/** Слабые заголовки объёмов в тексте, по порядку. Заголовки таблиц-не-работ («Ведомость потребности машин») не считаются. */
function findWeakHeadings(text: string): WeakHeading[] {
  const found: WeakHeading[] = [];
  let position = 0;
  while (position <= text.length) {
    const newline = text.indexOf("\n", position);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(position, lineEnd);
    if (line.length > 0 && line.length <= MAX_WEAK_HEADING_LINE) {
      const stripped = stripHeadingPrefix(line);
      if (stripped !== "" && classifyHeading(line) !== "NON_WORK" && WEAK_HEADINGS.some((pattern) => pattern.test(stripped))) {
        found.push({ title: line.trim(), offset: position });
      }
    }
    if (newline < 0) break;
    position = newline + 1;
  }
  return found;
}

/** Заголовок сметы в тексте (локальный сметный расчёт, смета контракта): сильный признак, ведомость проверяет `hasBillSignal`. */
function findEstimateHeading(text: string): string | null {
  const heading = documentHeadings(text).find(
    (item) => item.kind === "CUSTOMER_ESTIMATE" || item.kind === "CONTRACT_ESTIMATE",
  );
  return heading === undefined ? null : heading.title;
}

/* ------------------------------ Безобъёмные документы ------------------------------ */

interface Category {
  readonly label: string;
  /** Фраза: ищется в любом месте имени файла и в начале заголовка. Длинные однозначные формулировки. */
  readonly phrase?: RegExp;
  /** Одно слово: только в начале имени (после «Приложение № N», номера, «Часть N») и в начале заголовка. */
  readonly bare?: RegExp;
}

const CONTRACT_PREFIX = String.raw`(?:(?:государственн|муниципальн|типов)\p{L}*\s+)?`;

/**
 * Категории заведомо безобъёмных документов. Список намеренно узкий: каждая строка — документ, который в закупке пишет
 * не проектировщик, а юрист или закупщик. «Приложение к извещению» или «ТЗ к проекту контракта» сюда не попадают:
 * однословные признаки требуют начала имени, а «проект контракта» не засчитывается после предлога «к».
 */
const CATEGORIES: readonly Category[] = [
  {
    label: "проект контракта или договора",
    phrase: new RegExp(String.raw`(?<!(?:^|[^\p{L}])к\s+)проект\p{L}*\s+${CONTRACT_PREFIX}(?:контракт|договор)\p{L}*`, "u"),
    bare: new RegExp(String.raw`${CONTRACT_PREFIX}(?:контракт|договор)\p{L}*(?![\p{L}])`, "u"),
  },
  {
    label: "требования к содержанию и составу заявки, инструкция участникам",
    phrase:
      /требовани\p{L}*\s+к\s+(?:содержани|состав|оформлен|заявк|участник|подготовк)\p{L}*|состав\p{L}*\s+(?:и\s+\p{L}+\s+)?заяв\p{L}*|инструкци\p{L}*\s+(?:для\s+|по\s+)?(?:участник|заполнен|подготовк|заяв)\p{L}*|порядок\s+(?:подачи|подготовки|оформлени\p{L}*)\s+заяв\p{L}*|информационн\p{L}*\s+карт\p{L}*|критери\p{L}*\s+оценк\p{L}*|порядок\s+оценк\p{L}*|обеспечени\p{L}*\s+(?:заявк|исполнени)\p{L}*/u,
  },
  {
    label: "формы и образцы документов",
    phrase: /форм\p{L}*\s+(?:документов|для\s+заполнен|заяв\p{L}*|участник\p{L}*)|образ[её]ц\p{L}*\s+(?:форм|документ|заяв)\p{L}*|типов\p{L}*\s+форм\p{L}*/u,
    bare: /образ[её]ц\p{L}*|формы(?![\p{L}])/u,
  },
  {
    label: "анкета, декларация, доверенность, согласие",
    phrase: /анкет\p{L}*|декларац\p{L}*|довер[её]нност\p{L}*/u,
    bare: /согласи[ейя](?![\p{L}])/u,
  },
  {
    label: "банковская гарантия",
    phrase: /банковск\p{L}*\s+гаранти\p{L}*|независим\p{L}*\s+гаранти\p{L}*|гаранти\p{L}*\s+(?:обеспечени|банк)\p{L}*/u,
  },
  {
    label: "протокол",
    phrase: /протокол\p{L}*\s+(?:рассмотрени|оценк|подведени|разногласи|вскрыти|итогов|заседани|согласован)\p{L}*/u,
    bare: /протокол\p{L}*/u,
  },
  {
    label: "разъяснения",
    phrase: /разъяснени\p{L}*|запрос\p{L}*\s+(?:на\s+)?разъяснен\p{L}*/u,
  },
  {
    label: "обоснование начальной цены (НМЦК)",
    phrase:
      /обоснован\p{L}*\s+(?:начальн|нмц|цены\s+контракт|максимальн)\p{L}*|(?<![\p{L}])нмц[кд]?(?![\p{L}])|начальн\p{L}*\s+\(?максимальн\p{L}*\s+цен\p{L}*/u,
  },
  {
    label: "извещение и его печатная форма",
    phrase: /извещени\p{L}*\s+о\s+проведен\p{L}*|печатн\p{L}*\s+форм\p{L}*\s+извещен\p{L}*/u,
    bare: /извещени\p{L}*|печатн\p{L}*\s+форм\p{L}*/u,
  },
];

/**
 * Слова в имени файла, которые отменяют «безобъёмность»: «ТЗ к проекту контракта», «Приложение 1. Спецификация (к договору)»,
 * «Обоснование НМЦК сметным методом». Сметой, ведомостью или заданием файл назвал человек — доверяем.
 */
const VOLUME_NAME =
  /(?<![\p{L}])(?:техническ\p{L}*[\s_.-]*задани|тз|спецификац\p{L}*|ведомост\p{L}*|объ[её]м\p{L}*|смет\p{L}*|описани\p{L}*[\s_.-]*объект|дефект\p{L}*|перечень[\s_.-]*работ|проектн\p{L}*|чертеж\p{L}*)(?![\p{L}])/u;

/** Имя без пути, расширения, «Приложение № 3», «Часть 2.» и номера пункта: то, с чего имя начинается по существу. */
function coreName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).trim();
  return fold(base)
    .replace(/\.[a-z0-9]{2,5}$/u, "")
    .replace(/^\s*приложени\p{L}*\s*(?:№|n)?\s*[\d.]*[\s.,:–—_-]*/u, "")
    .replace(/^\s*(?:часть|раздел|глава|том|книга)\s*[\divx]+[\s.,:–—_-]*/u, "")
    .replace(/^[\d.\s_-]+/u, "")
    .trim();
}

/** Первые непустые строки текста: по ним документ узнаётся, даже когда имя файла ничего не говорит («Документ.docx»). */
function headLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.slice(0, 3_000).split("\n")) {
    const line = raw.trim();
    if (line === "" || line.length > 200) continue;
    lines.push(line);
    if (lines.length >= 8) break;
  }
  return lines;
}

function anchored(pattern: RegExp): RegExp {
  return new RegExp(`^(?:${pattern.source})`, pattern.flags);
}

interface CategoryHit {
  readonly label: string;
  readonly by: "имени файла" | "заголовку";
}

/** Какой безобъёмной категории соответствует документ: по имени файла, затем по заголовку первых строк. */
function nonVolumeCategory(name: string, text: string): CategoryHit | null {
  const core = coreName(name);
  const plain = fold((name.split(/[\\/]/).pop() ?? name).trim());
  for (const category of CATEGORIES) {
    if (category.phrase?.test(plain) === true) return { label: category.label, by: "имени файла" };
    if (category.bare !== undefined && anchored(category.bare).test(core)) return { label: category.label, by: "имени файла" };
  }
  const heads = headLines(text).map((line) => stripHeadingPrefix(line));
  for (const category of CATEGORIES) {
    const phrase = category.phrase === undefined ? null : anchored(category.phrase);
    const bare = category.bare === undefined ? null : anchored(category.bare);
    if (heads.some((head) => head !== "" && (phrase?.test(head) === true || bare?.test(head) === true))) {
      return { label: category.label, by: "заголовку" };
    }
  }
  return null;
}

/* ------------------------------ Решение ------------------------------ */

function decideUnit(name: string, text: string): PartDecision {
  const chars = text.length;
  const level = classifyDocument(name, text).level;
  const make = (read: boolean, reason: string, quantityLines = 0): PartDecision => ({ name, level, read, reason, chars, quantityLines });

  // 1. Сметы и ведомости не пропускаются никогда.
  if (level !== "SPEC") return make(true, `уровень «${LEVEL_LABEL[level]}»: читается всегда`);

  // 2. Признаки объёмов в тексте.
  if (hasBillSignal(name, text)) return make(true, "есть признак ведомости объёмов работ (имя файла или заголовок)");
  const estimateHeading = findEstimateHeading(text);
  if (estimateHeading !== null) return make(true, `есть заголовок сметы: «${estimateHeading.slice(0, 80)}»`);

  const quantityLines = countQuantityLines(text);
  if (isDenseInQuantities(quantityLines, chars)) {
    return make(true, `строк с количеством и единицей: ${String(quantityLines)} — объёмы вероятны`, quantityLines);
  }
  // Строки с количеством считаются ПОСЛЕ заголовка: данные идут под ним, а ссылка «Приложение № 1 – Техническое задание»
  // в конце проекта контракта строк под собой не имеет.
  for (const weak of findWeakHeadings(text)) {
    const below = countQuantityLines(text.slice(weak.offset));
    if (below >= WEAK_HEADING_MIN_LINES) {
      return make(true, `заголовок «${weak.title.slice(0, 80)}» и под ним строк с количеством: ${String(below)}`, quantityLines);
    }
  }

  // 3. Безобъёмные документы по имени или заголовку.
  const category = nonVolumeCategory(name, text);
  if (category !== null) {
    const veto = VOLUME_NAME.exec(fold((name.split(/[\\/]/).pop() ?? name).trim()));
    if (veto !== null) return make(true, `в имени файла «${veto[0]}»: читается, хотя похоже на ${category.label}`, quantityLines);
    return make(
      false,
      `${category.label} (по ${category.by}); объёмов не видно: строк с количеством ${String(quantityLines)}, заголовков ведомости, сметы или ТЗ с данными нет`,
      quantityLines,
    );
  }

  // 4. Незнакомое читается.
  return make(true, "не опознан как безобъёмный документ: читается", quantityLines);
}

/* ------------------------------ Файлы архива ------------------------------ */

/** Метка файла внутри архива или листа в книге: «=== имя ===» отдельной строкой (как в `volumeSource.ts`). */
const ENTRY_MARK = /^=== (.+) ===[ \t]*$/gm;

interface RawPart {
  readonly name: string;
  /** Срез исходного текста, включая метку. */
  readonly raw: string;
  /** Текст части без метки. */
  readonly body: string;
  readonly archived: boolean;
}

function splitParts(documentName: string, text: string): RawPart[] {
  const marks = [...text.matchAll(ENTRY_MARK)];
  if (marks.length === 0) return [{ name: documentName, raw: text, body: text, archived: false }];

  const parts: RawPart[] = [];
  const first = marks[0]?.index ?? 0;
  if (first > 0) parts.push({ name: documentName, raw: text.slice(0, first), body: text.slice(0, first), archived: false });
  for (const [index, mark] of marks.entries()) {
    const end = marks[index + 1]?.index ?? text.length;
    parts.push({
      name: mark[1] as string,
      raw: text.slice(mark.index, end),
      body: text.slice(mark.index + mark[0].length, end),
      archived: true,
    });
  }
  return parts;
}

/** Метка читаемого и пропущенного файла в отчёте: «файл (в архиве)». */
function displayName(documentName: string, part: RawPart): string {
  return part.archived ? `${part.name} (в ${documentName})` : part.name;
}

/**
 * Решение по документу и текст, который уйдёт в модель.
 *
 * Документ без меток — одна часть. Архив — по части на файл; пустое «преамбульное» начало текста (до первой метки) без
 * содержимого не решается, а остаётся в тексте как есть. Читаются все части — текст возвращается без изменений.
 *
 * `readAll` — переключатель диагностики `ESTIMATE_READ_ALL_DOCUMENTS=1`: решения по-прежнему считаются (их видно в отчёте оценки),
 * но ничего не пропускается.
 */
export function selectDocumentForModel(name: string, text: string, options: { readonly readAll?: boolean } = {}): DocumentSelection {
  const rawParts = splitParts(name, text);
  const parts: PartDecision[] = [];
  const skipped: SkippedDocument[] = [];
  const kept: string[] = [];
  let anyDecided = false;

  for (const part of rawParts) {
    if (part.body.trim() === "") {
      // Пустая часть решения не требует: ни читать, ни отчитываться за неё не о чем.
      kept.push(part.raw);
      continue;
    }
    anyDecided = true;
    const decision = decideUnit(part.name, part.body);
    const shown = displayName(name, part);
    parts.push({ ...decision, name: shown });
    if (decision.read || options.readAll === true) {
      kept.push(part.raw);
    } else {
      skipped.push({ name: shown, reason: decision.reason, chars: part.body.length });
    }
  }

  if (!anyDecided) return { text, read: true, reason: "текст пуст: решать нечего", parts, skipped };

  const allRead = skipped.length === 0;
  const anyRead = parts.some((part) => part.read) || options.readAll === true;
  const selected = allRead ? text : kept.join("");
  const reason = allRead
    ? (parts.find((part) => part.read)?.reason ?? "читается")
    : anyRead
      ? `пропущено файлов: ${String(skipped.length)} из ${String(parts.length)}`
      : parts.length === 1
        ? (parts[0] as PartDecision).reason
        : `все ${String(parts.length)} файлов архива без объёмов`;
  return { text: anyRead ? selected : "", read: anyRead, reason, parts, skipped };
}

/**
 * Читать ли документ моделью. Для архива — «да», если нужна хотя бы одна его часть.
 *
 * Чистая функция: ни базы, ни окружения. Переключатель `ESTIMATE_READ_ALL_DOCUMENTS` действует в `extractBillOfWork`.
 */
export function shouldReadWithModel(name: string, text: string): ReadDecision {
  const selection = selectDocumentForModel(name, text);
  return { read: selection.read, reason: selection.reason };
}

/** Включён ли возврат к чтению всех документов (`ESTIMATE_READ_ALL_DOCUMENTS=1` или `true`). */
export function readAllDocuments(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env[READ_ALL_DOCUMENTS_ENV] ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}
