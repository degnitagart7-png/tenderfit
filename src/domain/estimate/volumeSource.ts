import type { VolumeSource, VolumeSourceLevel } from "@/domain/estimate/types";

/**
 * Откуда брать объёмы: приоритет источников и отсев таблиц, которые не работы.
 *
 * Зачем. Извлечение берёт строки из всех документов подряд, а в документации
 * один и тот же объём лежит в нескольких местах: ведомость, смета заказчика,
 * проект, ТЗ. Склеенные вместе, они дают двойной счёт, а таблицы вроде
 * «Ведомость потребности машин, механизмов и приспособлений» — бульдозер,
 * КАМАЗ, знаки безопасности — превращаются в позиции сметы. На закупке
 * 0134600012126000001 (снос дома) так вышло «5 из 9 позиций не попали в расчёт»:
 * четыре из пяти — машины и СИЗ.
 *
 * Уровни, от высшего к низшему:
 * 0. смета заказчика (ЛСР, форма 421/пр), которую прочитал код (`parseCustomerLsr`), — если она есть, объёмы и
 *    шифры расценок из неё, а ведомость идёт только на сверку (решение владельца 2026-10-10). Замер: расчёт по
 *    ЛСР отклоняется на 0–5 %, по ведомости — на −40…−95 %: в ЛСР есть все нормы, включая технологические
 *    работы (леса, ограждения, перевозка), а в ведомости их нет. Отдельного значения уровня нет — это тот же
 *    «CUSTOMER_ESTIMATE», а признак «распознана формой 421» — у группы позиций (`volumeRank`);
 * 1. ведомость объёмов работ — если ЛСР формы 421/пр нет, объёмы только из неё;
 * 2. смета заказчика, прочитанная моделью (скан, OCR, нестандартная вёрстка), — только когда ведомости нет;
 *    при ведомости она ниже: модель читает такую смету с потерями, а ведомость надёжна;
 * 3. смета контракта (приказ 841/пр, «ЛС 02-02-07 Поз.: 3») — только когда нет ни ведомости, ни ЛСР;
 * 4. ТЗ, спецификация, таблицы проекта — только когда нет ничего из перечисленного.
 * Внутри уровня берутся все документы: три ЛСР по разделам — это три источника,
 * а не выбор.
 *
 * Почему смета контракта не ведомость. Заказчик прикладывает её к проекту контракта: «№ | Номер
 * сметы | Наименование конструктивных решений… | Ед. | Количество | Цена | Стоимость». Строки
 * укрупнены («Монтаж водонагревателей… шт 1»), без шифров, материалов и оборудования, а в графе
 * «Номер сметы» стоит «ЛС 02-02-07 Поз.: 3-3.2» — ссылка на позиции локальной сметы. На закупке
 * 0302300048726001118 такая таблица, принятая за ведомость, перебила шесть полноценных ЛСР, и из
 * 1,86 млн ₽ заказчика расчёт покрыл 0,45. Поэтому её уровень — ниже ЛСР, а при наличии ЛСР она только сверка.
 *
 * Тот же довод — про настоящую ведомость, которая ссылается на позиции ЛС («ЛС 02-02-07 Поз.: 3»):
 * строка со ссылкой — производная, составлена из ЛСР, и надёжнее ЛСР, из которой она выведена. Такая
 * строка получает уровень сметы контракта (решает `extractBillItems` по самой строке таблицы, а не по
 * документу целиком: в одной ведомости бывают и строки со ссылками, и без), а ведомостью остаются строки
 * без ссылок на ЛС. Объёмы и шифры тогда берутся из ЛСР, а ведомость служит сверкой.
 *
 * Уровень определяет код, а не модель: по имени файла, по шапке текста и по
 * заголовку таблицы рядом со строкой. Модель вправе подсказать раздел, но
 * решение принимается здесь — одинаково на одном и том же документе.
 */

export type { VolumeSource, VolumeSourceLevel };

/** Вес уровня: больше — приоритетнее. «CUSTOMER_ESTIMATE» здесь — смета, прочитанная моделью; распознанная формой 421 весит больше (`volumeRank`). */
export const LEVEL_RANK: Readonly<Record<VolumeSourceLevel, number>> = {
  BILL: 4,
  CUSTOMER_ESTIMATE: 3,
  CONTRACT_ESTIMATE: 2,
  SPEC: 1,
};

/** Вес сметы заказчика, прочитанной детерминированным разбором формы 421/пр: выше ведомости. */
export const FORM_421_RANK = 5;

/**
 * Вес группы позиций при выборе источника. `form421` — позиции построены кодом из ЛСР формы 421/пр
 * (`customerLsrBill`), а не прочитаны моделью: такая смета важнее ведомости.
 */
export function volumeRank(level: VolumeSourceLevel, form421 = false): number {
  return form421 && level === "CUSTOMER_ESTIMATE" ? FORM_421_RANK : LEVEL_RANK[level];
}

export const LEVEL_LABEL: Readonly<Record<VolumeSourceLevel, string>> = {
  BILL: "ведомость объёмов работ",
  CUSTOMER_ESTIMATE: "смета заказчика",
  CONTRACT_ESTIMATE: "смета контракта",
  SPEC: "ТЗ, спецификация, таблицы проекта",
};

/* ------------------------------- Заголовки ------------------------------- */

/** Сворачивание для сравнения: нижний регистр, «ё» → «е». */
function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

/**
 * Начало заголовка без «Приложение № 3», «Таблица 4 —», «Раздел 2.» и номера
 * пункта: сам заголовок начинается после них. Якорь в начале строки отделяет
 * заголовок от предложения, где те же слова стоят посреди фразы: «Основание:
 * ведомость объёмов работ № 1» в шапке сметы ведомостью не является.
 */
export function stripHeadingPrefix(heading: string): string {
  return fold(heading)
    .replace(/^\s*приложение\s*(?:№|n)?\s*\d*(?:\.\d+)*[\s.,:–—-]*/u, "")
    .replace(/^\s*таблица\s*(?:№|n)?\s*\d+[\s.,:–—-]*/u, "")
    .replace(/^\s*раздел\s+\d+[\s.,:–—-]*/u, "")
    .replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/u, "")
    .trim();
}

/**
 * Таблицы и перечни, которые работами не являются: потребность в машинах,
 * кадрах, СИЗ, инструменте, графики. Слово «ведомость» в «Ведомость
 * потребности машин» не делает таблицу ведомостью объёмов работ.
 */
const NON_WORK_HEADINGS: readonly RegExp[] = [
  /^ведомост\p{L}*\s+потребност/u,
  /^(?:сводн\p{L}*\s+)?потребност\p{L}*(?![\p{L}])/u,
  /^ведомост\p{L}*\s+(?:машин|механизм|инструмент|приспособлен|оборудован)/u,
  /^машин\p{L}*(?:,|\s+и)\s+механизм/u,
  /^(?:индивидуальн\p{L}*\s+)?средств\p{L}*\s+(?:индивидуальн\p{L}*\s+)?защит/u,
  /^сиз(?![\p{L}])/u,
  /^перечень\s+(?:инструмент|приспособлен|оборудован|машин|механизм|сиз|средств)/u,
  /^(?:календарн\p{L}*\s+(?:план|график)|(?:сетев\p{L}*\s+)?график)/u,
  /^(?:численност|штатн\p{L}*\s+расписан|состав\s+бригад)/u,
];

/** Ведомость объёмов работ: ВОР, дефектная ведомость. */
const BILL_HEADINGS: readonly RegExp[] = [
  /^(?:(?:сводн|уточн[её]нн|предварительн|итогов)\p{L}*\s+)?ведомост\p{L}*\s+(?:объ[её]м\p{L}*|(?:строительн\p{L}*\s+)?работ|дефект\p{L}*)/u,
  /^дефектн\p{L}*\s+ведомост/u,
  /^вор(?![\p{L}])/u,
];

/** Локальная смета заказчика: ЛСР, форма 421/пр, сметный расчёт. */
const ESTIMATE_HEADINGS: readonly RegExp[] = [
  /^локальн\p{L}*\s+(?:сметн\p{L}*\s+расч[её]т|смет)/u,
  /^объектн\p{L}*\s+(?:сметн\p{L}*\s+расч[её]т|смет)/u,
  /^сметн\p{L}*\s+расч[её]т/u,
  /^смета\s*(?:№|n|\d)/u,
  /^лср(?![\p{L}])/u,
];

/**
 * Смета контракта (приказ 841/пр): «Смета контракта», «Проект сметы контракта», «Смета цены контракта».
 * Проверяется раньше сметы заказчика: «смета контракта» — не локальная смета.
 */
const CONTRACT_ESTIMATE_HEADINGS: readonly RegExp[] = [
  /^(?:проект\s+)?смет\p{L}*\s+(?:цены\s+)?контракт\p{L}*/u,
  /^смет\p{L}*\s+цены\s+договор/u,
];

export type HeadingClass = "BILL" | "CUSTOMER_ESTIMATE" | "CONTRACT_ESTIMATE" | "NON_WORK";

/** Что говорит заголовок: ведомость, смета, не-работа — или ничего. */
export function classifyHeading(heading: string): HeadingClass | null {
  const text = stripHeadingPrefix(heading);
  if (text === "") return null;
  // Не-работа проверяется первой: «Ведомость потребности машин» начинается с «ведомость».
  if (NON_WORK_HEADINGS.some((pattern) => pattern.test(text))) return "NON_WORK";
  if (BILL_HEADINGS.some((pattern) => pattern.test(text))) return "BILL";
  if (CONTRACT_ESTIMATE_HEADINGS.some((pattern) => pattern.test(text))) return "CONTRACT_ESTIMATE";
  if (ESTIMATE_HEADINGS.some((pattern) => pattern.test(text))) return "CUSTOMER_ESTIMATE";
  return null;
}

/** Заголовок — таблица, которая не работа. Годится и для поля «раздел» из ответа модели. */
export function isNonWorkHeading(heading: string | undefined | null): boolean {
  if (heading === undefined || heading === null) return false;
  return classifyHeading(heading) === "NON_WORK";
}

export type DocHeadingKind = "BILL" | "CUSTOMER_ESTIMATE" | "CONTRACT_ESTIMATE" | "NON_WORK" | "TABLE" | "SECTION";

/** Заголовок в тексте документа. */
export interface DocHeading {
  /** Смещение начала заголовка в тексте. */
  readonly offset: number;
  readonly kind: DocHeadingKind;
  /** Текст заголовка. */
  readonly title: string;
}

const MAX_HEADING_LINE = 260;
/** Подпись таблицы бывает посреди склеенной строки PDF: ищем и там. */
const TABLE_CAPTION = /(?:^|[\n.|]\s*)(таблица\s*(?:№|n)?\s*\d+\s*[-–—.:]\s*[^\n|]{3,200})/giu;
const SECTION_LINE = /^\s*раздел\s+(?:\d+|[ivx]+)(?![\p{L}\d])/iu;
/**
 * Нумерованный заголовок пункта: «7. Объём работ». Точка после номера обязательна, а
 * цифр и «|» в остальном тексте быть не должно — иначе это строка таблицы, а не
 * заголовок. Нужен как граница: заголовок «График производства работ» не должен
 * распространяться на пункты после него.
 */
const NUMBERED_TITLE = /^\s*\d{1,2}(?:\.\d{1,2})*[.)]\s+\p{Lu}[\p{L}\s,;:()«»"-]{3,100}$/u;

/**
 * Заголовки документа в порядке следования: ведомости, сметы, таблицы-не-работы,
 * подписи «Таблица N — …» и «Раздел N». Линейно по тексту: документы бывают до
 * мегабайта, поэтому разбираются только короткие строки и подписи таблиц.
 */
export function documentHeadings(text: string): DocHeading[] {
  const headings: DocHeading[] = [];
  let position = 0;
  while (position <= text.length) {
    const newline = text.indexOf("\n", position);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(position, lineEnd);
    if (line.length > 0 && line.length <= MAX_HEADING_LINE) {
      const kind = classifyHeading(line);
      if (kind !== null) {
        headings.push({ offset: position, kind, title: line.trim() });
      } else if (SECTION_LINE.test(line) || NUMBERED_TITLE.test(line)) {
        headings.push({ offset: position, kind: "SECTION", title: line.trim() });
      }
    }
    if (newline < 0) break;
    position = newline + 1;
  }

  for (const match of text.matchAll(TABLE_CAPTION)) {
    const title = (match[1] as string).trim();
    const offset = match.index + match[0].indexOf(match[1] as string);
    const kind = classifyHeading(title);
    // Подпись «Таблица 4 — Ведомость потребности машин» уже могла попасть в список строкой.
    if (headings.some((heading) => heading.offset === offset)) continue;
    headings.push({
      offset,
      kind: kind === null ? "TABLE" : kind,
      title,
    });
  }

  // Архив: его файлы идут подряд под метками «=== имя ===», и уровень у каждого свой.
  for (const entry of archiveEntries(text)) {
    const level = classifyDocument(entry.name, entry.body).level;
    headings.push({
      offset: entry.offset,
      // ТЗ внутри архива не задаёт уровня, но обрывает действие заголовка предыдущего файла.
      kind: level === "SPEC" ? "TABLE" : level,
      title: `=== ${entry.name} ===`,
    });
  }

  return headings.sort((a, b) => a.offset - b.offset);
}

/** Метка файла внутри архива или листа в книге: «=== имя ===» отдельной строкой. */
const ENTRY_MARK = /^=== (.+) ===[ \t]*$/gm;

interface ArchiveEntry {
  readonly offset: number;
  readonly name: string;
  readonly body: string;
}

/** Файлы архива, как они лежат в тексте документа. Нет меток — пусто. */
function archiveEntries(text: string): ArchiveEntry[] {
  const marks = [...text.matchAll(ENTRY_MARK)];
  return marks.map((mark, index) => ({
    offset: mark.index,
    name: mark[1] as string,
    body: text.slice(mark.index + mark[0].length, marks[index + 1]?.index ?? text.length),
  }));
}

/** Дальше этого от строки заголовок уже не считается относящимся к ней. */
const MAX_HEADING_DISTANCE = 30_000;

export interface HeadingInfo {
  /** Заголовок не-работы, под которым стоит строка; null — строка не в такой таблице. */
  readonly nonWork: string | null;
  /** Сколько знаков от заголовка не-работы до строки; null, если заголовка нет. */
  readonly nonWorkDistance: number | null;
  /** Уровень, который задаёт ближайший заголовок ведомости или сметы; null — не задаёт. */
  readonly level: VolumeSourceLevel | null;
}

const NO_HEADING: HeadingInfo = { nonWork: null, nonWorkDistance: null, level: null };

/** Заголовки, действующие в позиции `offset`. */
export function headingInfoAt(
  headings: readonly DocHeading[],
  offset: number,
): HeadingInfo {
  let low = 0;
  let high = headings.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((headings[middle] as DocHeading).offset <= offset) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (found < 0) return NO_HEADING;

  const nearest = headings[found] as DocHeading;
  if (offset - nearest.offset > MAX_HEADING_DISTANCE) return NO_HEADING;
  const nonWork = nearest.kind === "NON_WORK" ? nearest.title : null;

  let level: VolumeSourceLevel | null = null;
  for (let index = found; index >= 0; index -= 1) {
    const heading = headings[index] as DocHeading;
    if (offset - heading.offset > MAX_HEADING_DISTANCE) break;
    if (heading.kind === "BILL") {
      level = "BILL";
      break;
    }
    if (heading.kind === "CUSTOMER_ESTIMATE") {
      level = "CUSTOMER_ESTIMATE";
      break;
    }
    if (heading.kind === "CONTRACT_ESTIMATE") {
      level = "CONTRACT_ESTIMATE";
      break;
    }
    // Подпись другой таблицы или не-работа обрывают действие заголовка выше.
    if (heading.kind === "NON_WORK" || heading.kind === "TABLE") break;
  }
  return {
    nonWork,
    nonWorkDistance: nonWork === null ? null : offset - nearest.offset,
    level,
  };
}

/* ----------------------------- Уровень документа ----------------------------- */

/** Имя файла — ведомость объёмов: «Ведомость объемов.xlsx», «ВОР.docx», «Дефектная ведомость». */
const BILL_NAME =
  /(?<![\p{L}])ведомост\p{L}*[\s_.-]*(?:объ[её]м|работ|дефект)|дефектн\p{L}*[\s_.-]*ведомост|дефектовк|(?<![\p{L}\d])вор(?![\p{L}])/iu;

/**
 * Имя файла — смета заказчика. «Сметный метод» в «Обоснование НМЦК сметный
 * метод» и «сметная документация» сметой заказчика не являются: это про способ
 * расчёта цены и про состав проекта.
 */
const ESTIMATE_NAME = /(?<![\p{L}])(?:смет\p{L}*|лср|лс)(?![\p{L}])/iu;
/** Имя файла — смета контракта: «Смета контракта.xlsx», «Приложение №3.1 Проект сметы контракта.xlsx». */
const CONTRACT_ESTIMATE_NAME = /смет\p{L}*[\s_.-]*(?:цены[\s_.-]*)?контракт|смет\p{L}*[\s_.-]*цены[\s_.-]*договор/iu;
const NOT_ESTIMATE_NAME =
  /смет\p{L}*[\s_.-]*(?:метод|норматив|документац|стоимост|расч[её]т\p{L}*\s+цен)/giu;

/** Сколько знаков в начале текста читаем в поисках шапки документа. */
const HEAD_CHARS = 4000;


export interface DocumentClass {
  readonly level: VolumeSourceLevel;
  /** По чему определено: имя файла, шапка, структура таблицы или умолчание. */
  readonly reason: string;
}

/**
 * Уровень документа. Порядок такой: имя файла, затем шапка текста, затем
 * признаки формы сметы; ничего не нашлось — документ считается ТЗ или
 * спецификацией. Ведомость выигрывает у сметы: «Приложение 1. Ведомость объёмов
 * работ» к смете — это ведомость.
 */
export function classifyDocument(name: string, text: string): DocumentClass {
  const fileName = fold(name);
  /*
    Текст архива — несколько файлов подряд. Шапка и форма сметы у одного из них не
    делают сметой остальные, поэтому для документа читается только то, что стоит
    до первой метки файла; уровень каждого файла определяется отдельно
    (`documentHeadings`) и действует на его строки.
  */
  const firstMark = text.search(/^=== .+ ===[ \t]*$/m);
  if (firstMark >= 0) text = text.slice(0, firstMark);

  if (CONTRACT_ESTIMATE_NAME.test(fileName)) {
    return { level: "CONTRACT_ESTIMATE", reason: "имя файла — смета контракта" };
  }

  if (BILL_NAME.test(fileName)) {
    return { level: "BILL", reason: "имя файла — ведомость объёмов" };
  }

  let headBill = false;
  let headEstimate = false;
  let headContract = false;
  const head = text.slice(0, HEAD_CHARS);
  for (const line of head.split("\n")) {
    if (line.length === 0 || line.length > MAX_HEADING_LINE) continue;
    const kind = classifyHeading(line);
    if (kind === "BILL") headBill = true;
    else if (kind === "CUSTOMER_ESTIMATE") headEstimate = true;
    else if (kind === "CONTRACT_ESTIMATE") headContract = true;
  }
  if (headBill) return { level: "BILL", reason: "шапка текста — ведомость объёмов" };
  if (headContract) return { level: "CONTRACT_ESTIMATE", reason: "шапка текста — смета контракта" };

  if (ESTIMATE_NAME.test(fileName.replace(NOT_ESTIMATE_NAME, " "))) {
    return { level: "CUSTOMER_ESTIMATE", reason: "имя файла — смета" };
  }
  if (headEstimate) {
    return { level: "CUSTOMER_ESTIMATE", reason: "шапка текста — локальный сметный расчёт" };
  }
  if (
    /наименование\s+работ\s+и\s+затрат/iu.test(text) &&
    /(?:всего|итого)\s+по\s+(?:смете|разделу)/iu.test(text)
  ) {
    return { level: "CUSTOMER_ESTIMATE", reason: "форма сметы: «Наименование работ и затрат», «Всего по смете»" };
  }

  return { level: "SPEC", reason: "ТЗ, спецификация или таблицы проекта" };
}

/**
 * Есть ли в документе признак настоящей ведомости объёмов: имя файла или заголовок «Ведомость объёмов
 * работ». По нему документ со сметой контракта всё же читает модель, а не только код: ведомость, лежащая
 * в том же файле, выше ЛСР, и пропустить её нельзя.
 */
export function hasBillSignal(name: string, text: string): boolean {
  if (BILL_NAME.test(fold(name))) return true;
  return documentHeadings(text).some((heading) => heading.kind === "BILL");
}

/* ------------------------------- Выбор уровня ------------------------------- */

function quoted(documents: readonly string[]): string {
  return documents.map((name) => `«${name}»`).join(", ");
}

/**
 * Какой уровень лёг в расчёт.
 *
 * Берётся высший уровень, на котором есть хоть одна принятая строка: ведомость,
 * из которой ничего не удалось подтвердить, объёмов не даёт, и расчёт честно
 * спускается ниже — с пояснением, почему.
 */
type VolumeSourceInput = {
  /** `form421` — позиция построена кодом из ЛСР формы 421/пр: такая смета выше ведомости. */
  readonly accepted: readonly {
    readonly level: VolumeSourceLevel;
    readonly document: string;
    readonly form421?: boolean;
  }[];
  readonly documentLevels: readonly { readonly name: string; readonly level: VolumeSourceLevel }[];
};

/**
 * Выбор источника объёмов с явной отметкой `form421`: объёмы взяты из сметы, разобранной кодом по
 * форме 421/пр. По отметке интерфейс пишет «Расчёт по смете заказчика», а не «Примерная оценка»:
 * пояснение без ведомости у такой сметы совпадает с пояснением сметы, прочитанной моделью.
 */
export function chooseVolumeSource(input: VolumeSourceInput): VolumeSource | null {
  const source = chooseVolumeSourceLevel(input);
  if (source === null) return null;
  const form421 = input.accepted.some(
    (item) => item.form421 === true && volumeRank(item.level, true) === FORM_421_RANK && source.documents.includes(item.document),
  );
  return form421 && source.level === "CUSTOMER_ESTIMATE" ? { ...source, form421: true } : source;
}

function chooseVolumeSourceLevel(input: VolumeSourceInput): VolumeSource | null {
  let level: VolumeSourceLevel | null = null;
  let rank = 0;
  for (const item of input.accepted) {
    const itemRank = volumeRank(item.level, item.form421 === true);
    if (level === null || itemRank > rank) {
      level = item.level;
      rank = itemRank;
    }
  }
  if (level === null) return null;

  const documents: string[] = [];
  for (const item of input.accepted) {
    if (volumeRank(item.level, item.form421 === true) === rank && !documents.includes(item.document)) {
      documents.push(item.document);
    }
  }

  // Документы выше выбранного уровня, из которых ничего не принято.
  const skipped = (above: VolumeSourceLevel): string[] =>
    input.documentLevels
      .filter(({ level: documentLevel }) => documentLevel === above)
      .map(({ name }) => name);

  const plural = documents.length > 1;

  // Смета формы 421/пр выше ведомости: если ведомость есть, она — сверка, а не источник.
  if (rank === FORM_421_RANK) {
    const billRead = input.accepted.some((item) => item.level === "BILL");
    const billDocuments = input.documentLevels.filter((item) => item.level === "BILL").map((item) => item.name);
    const head = `Объёмы и шифры — из ${plural ? "смет" : "сметы"} заказчика (форма 421/пр)`;
    if (billRead) {
      return { level, documents, note: `${head}; ведомость объёмов работ использована для сверки` };
    }
    if (billDocuments.length > 0) {
      return {
        level,
        documents,
        note:
          `${head}; ведомость объёмов работ ${quoted(billDocuments)} в расчёт не берётся и не сверялась: ` +
          "её таблицу код не прочитал, а читать её моделью ради сверки не стали",
      };
    }
  }

  if (level === "BILL") {
    return {
      level,
      documents,
      note: `Объёмы взяты из ${plural ? "ведомостей" : "ведомости"} объёмов работ ${quoted(documents)}`,
    };
  }

  const missedBill = skipped("BILL");
  const missedEstimate = level === "CUSTOMER_ESTIMATE" ? [] : skipped("CUSTOMER_ESTIMATE");
  const missedContract = level === "SPEC" ? skipped("CONTRACT_ESTIMATE") : [];
  const reasons: string[] = [];
  if (missedBill.length > 0) {
    reasons.push(
      `ведомость объёмов ${quoted(missedBill)} найдена, но ни одной строки из неё подтвердить не удалось`,
    );
  } else {
    reasons.push("Ведомости объёмов в документации нет");
  }
  if (level === "CONTRACT_ESTIMATE" || level === "SPEC") {
    if (missedEstimate.length > 0) {
      reasons.push(
        `смета заказчика ${quoted(missedEstimate)} найдена, но ни одной строки из неё подтвердить не удалось`,
      );
    } else {
      reasons.push("сметы заказчика нет");
    }
  }
  if (level === "SPEC") {
    if (missedContract.length > 0) {
      reasons.push(
        `смета контракта ${quoted(missedContract)} найдена, но ни одной строки из неё подтвердить не удалось`,
      );
    }
  }
  const head = reasons.join(", ");
  const sentence = head.charAt(0).toUpperCase() + head.slice(1);

  if (level === "CUSTOMER_ESTIMATE") {
    return {
      level,
      documents,
      note: `${sentence} — объёмы взяты из ${plural ? "смет" : "сметы"} заказчика ${quoted(documents)}`,
    };
  }
  if (level === "CONTRACT_ESTIMATE") {
    return {
      level,
      documents,
      note:
        `${sentence} — объёмы взяты из ${plural ? "смет" : "сметы"} контракта ${quoted(documents)}. ` +
        "Позиции в ней укрупнены: без шифров расценок, материалов и оборудования, поэтому расчёт держится на допущении и " +
        "занижен там, где ЛСР раскрыла бы работу подробнее",
    };
  }
  return {
    level,
    documents,
    note: `${sentence} — объёмы взяты из технического задания, спецификации или таблиц проекта ${quoted(documents)}`,
  };
}

/** Источник одной строкой для карточки: «сметы заказчика «…»». */
export function volumeSourceLabel(source: VolumeSource): string {
  const plural = source.documents.length > 1;
  const names = quoted(source.documents);
  switch (source.level) {
    case "BILL":
      return `${plural ? "ведомостей" : "ведомости"} объёмов работ ${names}`;
    case "CUSTOMER_ESTIMATE":
      return `${plural ? "смет" : "сметы"} заказчика ${names}`;
    case "CONTRACT_ESTIMATE":
      return `${plural ? "смет" : "сметы"} контракта (приказ 841/пр) ${names}`;
    case "SPEC":
      return `технического задания, спецификации или таблиц проекта ${names}`;
  }
}

/** Строка «Объёмы взяты из: …» — одна и та же в карточке и в отчёте Word. */
export function volumeSourceLine(source: VolumeSource): string {
  return `Объёмы взяты из: ${volumeSourceLabel(source)}`;
}
