import type { DocumentText } from "@/domain/estimate/customerEstimate";
import { monthQuarterIn, quarterIn, zoneNumberIn, type IndexPriceLevel, type QuarterMark } from "@/domain/estimate/priceLevel";
import { isSameRegion } from "@/domain/regionCodes";
import { UNKNOWN_REGION } from "@/domain/entities";
import { normalizeRegionText, regionFromAddress } from "@/domain/regions";
import { isTsnFormHead, normBaseOf } from "@/domain/estimate/smetaRu";

/**
 * Уровень цен, который заказчик объявил в шапке своей локальной сметы, и сверка его с нашей ценовой книгой.
 *
 * Зачем. Заказчик считает в своей ценовой зоне и в своём квартале, и печатает их в шапке формы 421/пр:
 *
 *   Наименование субъекта Российской Федерации ,,,,,,03. Республика Бурятия
 *   Наименование зоны субъекта Российской Федерации ,,,,,,Республика Бурятия (5 зона)
 *   Составлен(а) в текущем уровне цен ,,III квартал 2026 года
 *
 * Считать в другой зоне нельзя (цены ресурсов зон различаются на десятки процентов), а сравнивать наш расчёт
 * с его сметой по строкам — нельзя, пока не ясно, в каком уровне она составлена.
 *
 * Только шапка и только смета заказчика. Раньше «первый квартал и первая зона где угодно в тексте» читались из любого
 * документа, и фраза договора «работы выполняются в IV квартале 2026» или санитарная «1 зона» отказывали в расчёте.
 * Шапка сметы — отрезок от строки «Наименование субъекта…» (или заголовка «ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА)») до
 * таблицы «№ п/п»: в нём живут все три поля, а позиции и обоснования — нет.
 *
 * Тексты бывают из xlsx (ячейки через запятую) и из распознавания PDF (разделители «|», пробелы, «lil квартал»
 * вместо «III квартал»), поэтому разбор терпим к шуму — но только внутри шапки.
 */

/** Уровень цен одной сметы заказчика. Нет поля — шапка о нём молчит. */
export interface DeclaredEstimateLevel {
  readonly documentName: string;
  /** «Республика Бурятия» (код субъекта «03.» отброшен). */
  readonly subject: string | null;
  /** «Республика Бурятия (5 зона)»; у зон без номера («Камчатский край») — просто название. */
  readonly zoneName: string | null;
  readonly zoneNumber: number | null;
  readonly quarter: number | null;
  readonly year: number | null;
}

/** Уровень цен заказчика, сведённый по всем его сметам. */
export interface DeclaredPriceLevelSummary {
  readonly subject: string | null;
  readonly zoneName: string | null;
  readonly zoneNumber: number | null;
  readonly quarter: number | null;
  readonly year: number | null;
  /** Сколько смет заказчика назвали хотя бы одно из трёх полей. */
  readonly estimates: number;
  /** Расхождения между сметами словами: у кого зона или квартал свои. Пусто — все сметы согласны. */
  readonly disagreements: readonly string[];
}

/* ----------------------------- Поиск шапки ----------------------------- */

/*
  Якоря шапки: строки «Наименование субъекта Российской Федерации» / «Наименование зоны субъекта …» и заголовок
  формы. Заголовок требует «(СМЕТА)»: фраза «Приложение: локальный сметный расчёт» в договоре и обосновании НМЦК
  шапкой сметы не является.
*/
const ANCHOR_RE = /наименование\s+(?:зоны\s+)?субъекта\s+Российск|ЛОКАЛЬН\p{L}*\s+СМЕТН\p{L}*\s+РАСЧ[ЕЁ]Т\s*\(?\s*СМЕТА/giu;
const SUBJECT_LABEL_RE = /наименование\s+субъекта\s+Российск\p{L}*\s+Федерац\p{L}*/iu;
const ZONE_LABEL_RE = /наименование\s+зоны\s+субъекта\s+Российск\p{L}*\s+Федерац\p{L}*/iu;
const TABLE_START_RE = /№\s*п\s*\/\s*п/iu;
/**
 * Шапка не длиннее: строки сметы за ней нельзя принимать за шапку, если таблица не распознана.
 * Длина — «полезная»: серия разделителей считается одним знаком (`usefulLength`), иначе окно в 4000 знаков
 * у текста из xlsx закрывается на второй-четвёртой строке.
 */
const MAX_HEADER = 4000;
/** Непустых строк в шапке не больше: у текста из xlsx строка — сотни запятых, и длина в знаках о числе строк ничего не говорит. */
const MAX_HEADER_LINES = 60;
/** Строка, длиннее которой окно не читает целиком: текст из PDF без переводов строк — мегабайт в одной строке, а якорей в нём десятки. */
const MAX_RAW_LINE = 100_000;

/**
 * Серия разделителей и пробелов — один знак. Тексты из xlsx выгружают ячейки через запятую, и пустая ячейка у сотни
 * колонок печатает «,,,,,,,,,»: строка «Составлен(а) в текущем уровне цен ,,I квартал 2026 года» стоит в таблице
 * шириной в 16–40 колонок, а в тексте занимает 300+ знаков. Окно, измеренное в знаках, до неё не дотягивалось (бенчмарк
 * 22 закупок: ни одной пометки PRICE_LEVEL_DIFFERS у смет в I–II кв. 2026 и III–IV кв. 2025).
 */
const SEPARATOR_RUN_RE = /[,;|\s"]{2,}/gu;
const SEPARATOR_CHAR_RE = /[,;|\s"]/u;

/** Длина строки без избыточных разделителей. */
function usefulLength(line: string): number {
  return line.replace(SEPARATOR_RUN_RE, " ").length;
}

/** Сколько знаков строки укладывается в `budget` «полезных» знаков (серия разделителей — один знак). */
function takeByUsefulLength(line: string, budget: number): number {
  let used = 0;
  let index = 0;
  while (index < line.length && used < budget) {
    if (SEPARATOR_CHAR_RE.test(line[index] as string)) {
      // Серия разделителей съедается целиком и стоит один знак.
      while (index < line.length && SEPARATOR_CHAR_RE.test(line[index] as string)) index += 1;
    } else {
      index += 1;
    }
    used += 1;
  }
  return index;
}

/**
 * Конец окна шапки, которое начинается в `start`: таблица «№ п/п» (если она раньше), иначе предел — не больше
 * `MAX_HEADER_LINES` непустых строк и `MAX_HEADER` полезных знаков, смотря что кончится раньше. Строки читаются по
 * переводам строки, поэтому окно не зависит от ширины таблицы.
 */
function headerEnd(text: string, start: number): number {
  let position = start;
  let lines = 0;
  let budget = MAX_HEADER;
  while (position < text.length) {
    let next = text.indexOf("\n", position);
    if (next < 0) next = text.length;
    const tooLong = next - position > MAX_RAW_LINE;
    const line = text.slice(position, tooLong ? position + MAX_RAW_LINE : next);

    const table = TABLE_START_RE.exec(line);
    if (table !== null) return position + table.index;

    const cost = usefulLength(line);
    if (cost > budget || tooLong) return position + takeByUsefulLength(line, budget);
    budget -= cost;
    if (/[\p{L}\d]/u.test(line)) lines += 1;
    position = next + 1;
    if (lines >= MAX_HEADER_LINES) break;
  }
  return Math.min(position, text.length);
}

interface HeaderWindow {
  readonly text: string;
}

function headerWindows(text: string): HeaderWindow[] {
  const windows: HeaderWindow[] = [];
  const anchors = new RegExp(ANCHOR_RE.source, ANCHOR_RE.flags);
  for (let match = anchors.exec(text); match !== null; match = anchors.exec(text)) {
    const start = match.index;
    const end = Math.max(headerEnd(text, start), start + match[0].length);
    windows.push({ text: text.slice(start, end) });
    anchors.lastIndex = end;
  }
  return windows;
}

/**
 * Шапка сметы: начало её текста до таблицы «№ п/п» (не больше `MAX_HEADER_LINES` строк и `MAX_HEADER` полезных знаков). Для разбора уровня цен у смет,
 * сегмент которых начинается с шапки: позиции и обоснования ниже уровня цен не называют, а «1 зона» в них — мусор.
 */
export function headOfEstimate(text: string): string {
  return text.slice(0, headerEnd(text, 0));
}

/* ----------------------------- Значения полей ----------------------------- */

/** Значение справа от подписи: первая непустая ячейка строки (CSV, «|», табуляция), иначе следующая строка. */
function valueAfter(header: string, label: RegExp): string | null {
  const match = label.exec(header);
  if (match === null) return null;
  // Значение кончается на следующей подписи: в тексте из PDF строки шапки идут подряд через пробелы
  // («75. Забайкальский край  Наименование редакции сметных нормативов …»).
  const rest = header.slice(match.index + match[0].length).split(/наименование\s/iu)[0] ?? "";
  const lines = rest.split(/\r?\n/u);
  for (const line of lines.slice(0, 2)) {
    // Ячейки: CSV из xlsx, «|» распознавания, табуляция или два и больше пробела (текст PDF).
    for (const raw of line.split(/[,;|\t]|\s{2,}/u)) {
      const cell = raw.replace(/["«»]/gu, "").replace(/\s+/gu, " ").trim().replace(/^[:.\-–—\s]+|[\s]+$/gu, "");
      if (/[\p{L}\d]/u.test(cell)) return cell;
    }
  }
  return null;
}

/**
 * «03. Республика Бурятия» → «Республика Бурятия». Субъект обязан опознаваться справочником регионов: в шапке из PDF
 * за названием идёт что угодно, и неопознанный текст субъектом не считается.
 */
function cleanSubject(raw: string): string | null {
  const name = raw.replace(/^\d{1,3}\s*[.)]\s*/u, "").trim();
  if (!/\p{L}/u.test(name)) return null;
  const region = regionFromAddress(name);
  return region === UNKNOWN_REGION ? null : region;
}

const ZONE_WITH_NUMBER_RE = /^(.*?\(\s*\d+\s*(?:-?я)?\s*зон[аеы]\s*\))/iu;

/**
 * Название зоны: с номером — до закрывающей скобки «(5 зона)», хвост за ней (наименование стройки из той же строки PDF)
 * отбрасывается. Без номера зона называется субъектом («Камчатский край», «город Москва»); строка, в которой субъекта
 * нет («Загородный учебно-оздоровительный комплекс»), — не зона, а название объекта не в той графе.
 */
function cleanZoneName(raw: string): string | null {
  const numbered = ZONE_WITH_NUMBER_RE.exec(raw);
  if (numbered?.[1] !== undefined) return numbered[1].trim();
  return regionFromAddress(raw) === UNKNOWN_REGION ? null : raw.trim();
}

const ZONE_SUFFIX_RE = /\s*\(\s*\d+\s*(?:-?я)?\s*зон[аеы]\s*\)\s*$/iu;

/** Название субъекта из названия зоны: «Республика Бурятия (5 зона)» → «Республика Бурятия». */
export function subjectOfZoneName(zoneName: string): string {
  return zoneName.replace(ZONE_SUFFIX_RE, "").trim();
}

/* ----------------------------- Квартал ----------------------------- */

/** Подпись уровня цен: сначала точная «Составлен(а) в текущем уровне цен», потом просто «в текущем уровне цен» (распознавание ломает первое слово). */
const LABEL_LEVEL_RES: readonly RegExp[] = [
  /составлен\p{L}*(?:\(\p{L}\))?\s+в\s+(?:текущем\s+)?уровне\s+цен/giu,
  /в\s+текущем\s+уровне\s+цен/giu,
];

/*
  Римская цифра квартала как её читает распознавание: «III» → «lil», «Ill», «ill», «lll», «1II»; «IV» → «lV», «1V».
  Арабская цифра — только 1–4. Слово «квартал» или «кв.» обязательно, год — четыре цифры.
*/
const QUARTER_WORD = String.raw`(?:квартал\p{L}*|кв\.?)`;
const QUARTER_RE = new RegExp(
  String.raw`(?<![\p{L}\d])([IiІіlL1|!]V|[IiІіlL1|!]{1,3}|[1-4])\s*[-–]?\s*${QUARTER_WORD}\s*(\d{4})`,
  "iu",
);
const DATE_RE = /(?<!\d)(\d{2})\.(\d{2})\.(\d{4})(?!\d)/u;

const MIN_YEAR = 2000;
const MAX_YEAR = 2099;

function quarterFromRoman(raw: string): number | null {
  if (/^[IiІіlL1|!][Vv]$/u.test(raw)) return 4;
  if (/^[1-4]$/u.test(raw)) return Number.parseInt(raw, 10);
  if (/^[IiІіlL1|!]{1,3}$/u.test(raw)) return raw.length;
  return null;
}

/** Квартал и год в тексте, терпимо к шуму распознавания: «lil квартал 2026 года», «II кв. 2026 г.», «01.07.2026». */
export function quarterInHeader(text: string): QuarterMark | null {
  const candidates: { index: number; mark: QuarterMark }[] = [];

  const word = QUARTER_RE.exec(text);
  if (word !== null) {
    const quarter = quarterFromRoman(word[1] ?? "");
    const year = Number.parseInt(word[2] ?? "", 10);
    if (quarter !== null && year >= MIN_YEAR && year <= MAX_YEAR) candidates.push({ index: word.index, mark: { quarter, year } });
  }

  const date = DATE_RE.exec(text);
  if (date !== null) {
    const month = Number.parseInt(date[2] ?? "", 10);
    const year = Number.parseInt(date[3] ?? "", 10);
    if (month >= 1 && month <= 12 && year >= MIN_YEAR && year <= MAX_YEAR) {
      candidates.push({ index: date.index, mark: { quarter: Math.floor((month - 1) / 3) + 1, year } });
    }
  }

  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]?.mark ?? null;
}

/** Квартал сметы: сразу за словами «в текущем уровне цен» — до 200 знаков, чтобы не зацепить даты приказов выше. */
function quarterOfHeader(header: string): QuarterMark | null {
  for (const pattern of LABEL_LEVEL_RES) {
    const labels = new RegExp(pattern.source, pattern.flags);
    for (let match = labels.exec(header); match !== null; match = labels.exec(header)) {
      const from = match.index + match[0].length;
      const window = header.slice(from, from + 200);
      // Smeta.RU: «в текущем уровне цен на сентябрь 2026 года» — квартала и даты нет, только месяц и год.
      const mark = quarterInHeader(window) ?? monthQuarterIn(window);
      if (mark !== null) return mark;
    }
  }
  // Подписи нет — не берём: в шапке полно дат приказов и писем об индексах, и первый попавшийся квартал не уровень цен сметы.
  return null;
}

/* ----------------------------- Разбор ----------------------------- */

function readWindow(window: HeaderWindow, documentName: string): DeclaredEstimateLevel | null {
  const subjectRaw = valueAfter(window.text, SUBJECT_LABEL_RE);
  const zoneRaw = valueAfter(window.text, ZONE_LABEL_RE);
  const zoneName = zoneRaw === null || zoneRaw === "" ? null : cleanZoneName(zoneRaw);
  const number = zoneName === null ? null : zoneNumberIn(zoneName);
  const subject = (subjectRaw === null ? null : cleanSubject(subjectRaw)) ?? (zoneName === null ? null : subjectOfZoneName(zoneName));
  const mark = quarterOfHeader(window.text);
  if (subject === null && zoneName === null && mark === null) return null;
  return {
    documentName,
    subject: subject === "" ? null : subject,
    zoneName,
    zoneNumber: number,
    quarter: mark?.quarter ?? null,
    year: mark?.year ?? null,
  };
}

/**
 * Уровни цен по шапкам смет заказчика во всех документах: по одному на смету.
 * Документ без шапки сметы (договор, техзадание, ведомость) ничего не даёт.
 */
export function declaredLevelsOf(documents: readonly DocumentText[]): DeclaredEstimateLevel[] {
  const levels: DeclaredEstimateLevel[] = [];
  for (const document of documents) {
    for (const window of headerWindows(document.text)) {
      const level = readWindow(window, document.name);
      if (level !== null) levels.push(level);
    }
  }
  return levels;
}

/* ----------------------------- Свод по сметам ----------------------------- */

const ROMAN = ["I", "II", "III", "IV"] as const;

/** «II квартал 2026 г.» — как пишет заказчик; `genitive` — «в уровне цен II квартала 2026 г.». */
export function describeCustomerQuarter(quarter: number, year: number, genitive = false): string {
  return `${ROMAN[quarter - 1] ?? String(quarter)} ${genitive ? "квартала" : "квартал"} ${String(year)} г.`;
}

interface Tally<T> {
  readonly key: string;
  readonly value: T;
  count: number;
}

function tally<T>(items: readonly { readonly key: string; readonly value: T }[]): Tally<T>[] {
  const groups = new Map<string, Tally<T>>();
  for (const item of items) {
    const group = groups.get(item.key);
    if (group === undefined) groups.set(item.key, { key: item.key, value: item.value, count: 1 });
    else group.count += 1;
  }
  return [...groups.values()];
}

/** Победитель по большинству; ничья между первыми — `null` (не угадываем). */
function majority<T>(groups: readonly Tally<T>[]): Tally<T> | null {
  if (groups.length === 0) return null;
  const sorted = [...groups].sort((a, b) => b.count - a.count);
  const first = sorted[0] as Tally<T>;
  const second = sorted[1];
  return second !== undefined && second.count === first.count ? null : first;
}

function listGroups<T>(groups: readonly Tally<T>[], label: (value: T) => string): string {
  return [...groups]
    .sort((a, b) => b.count - a.count)
    .map((group) => `«${label(group.value)}» — ${String(group.count)}`)
    .join(", ");
}

/**
 * Один уровень цен заказчика по всем его сметам. Согласны — он и есть; расходятся — берётся большинство, а расхождение
 * называется в `disagreements`; при ничьей поле остаётся пустым: выбирать зону по жребию нельзя.
 * `null` — ни одна смета заказчика уровня не назвала.
 */
export function summarizeDeclaredLevels(levels: readonly DeclaredEstimateLevel[]): DeclaredPriceLevelSummary | null {
  if (levels.length === 0) return null;
  const disagreements: string[] = [];

  const zones = tally(
    levels
      .filter((level) => level.zoneName !== null)
      .map((level) => ({ key: normalizeRegionText(level.zoneName as string), value: level })),
  );
  let zonePick = majority(zones);
  if (zones.length > 1) {
    disagreements.push(
      `Сметы заказчика названы в разных ценовых зонах: ${listGroups(zones, (level) => level.zoneName ?? "")}. ` +
        (zonePick === null ? "Поровну — зона заказчика не определена." : "Принята зона большинства смет."),
    );
  }

  let subject = zonePick?.value.subject ?? null;
  if (zonePick === null && zones.length === 0) {
    const subjects = tally(
      levels.filter((level) => level.subject !== null).map((level) => ({ key: normalizeRegionText(level.subject as string), value: level })),
    );
    const subjectPick = majority(subjects);
    subject = subjectPick?.value.subject ?? null;
    if (subjects.length > 1) {
      disagreements.push(
        `Сметы заказчика названы в разных субъектах: ${listGroups(subjects, (level) => level.subject ?? "")}.` +
          (subjectPick === null ? " Поровну — субъект заказчика не определён." : ""),
      );
    }
  }

  const quarters = tally(
    levels
      .filter((level) => level.quarter !== null && level.year !== null)
      .map((level) => ({ key: `${String(level.year)}-${String(level.quarter)}`, value: level })),
  );
  const quarterPick = majority(quarters);
  if (quarters.length > 1) {
    disagreements.push(
      `Сметы заказчика составлены в разных уровнях цен: ${listGroups(quarters, (level) => describeCustomerQuarter(level.quarter as number, level.year as number))}. ` +
        (quarterPick === null ? "Поровну — квартал заказчика не определён." : "Принят квартал большинства смет."),
    );
  }

  return {
    subject,
    zoneName: zonePick?.value.zoneName ?? null,
    zoneNumber: zonePick?.value.zoneNumber ?? null,
    quarter: quarterPick?.value.quarter ?? null,
    year: quarterPick?.value.year ?? null,
    estimates: levels.length,
    disagreements,
  };
}

/** Уровень цен заказчика по документам: только шапки его смет. `null` — смет с шапкой нет или они о цене молчат. */
export function extractDeclaredPriceLevel(documents: readonly DocumentText[]): DeclaredPriceLevelSummary | null {
  const summary = summarizeDeclaredLevels(declaredLevelsOf(documents));
  if (summary !== null && (summary.zoneName !== null || summary.subject !== null)) return summary;
  /*
    Смета по ТСН-2001 (Форма № 4б, капремонт Москвы) строк «Наименование субъекта / зоны» не печатает, а в карточке закупки
    223-ФЗ регион часто пуст — расчёт отказывал «регион закупки не определён». Но ТСН-2001 — территориальная база Москвы
    (`normBaseOf` отсекает ТСН других субъектов), и смета на ней сама говорит, где объект: город Москва, одна ценовая зона.
  */
  if (!documents.some((document) => hasTsnEstimate(document.text))) return summary;
  return {
    subject: "город Москва",
    zoneName: "город Москва",
    zoneNumber: null,
    quarter: summary?.quarter ?? null,
    year: summary?.year ?? null,
    estimates: summary?.estimates ?? 0,
    disagreements: summary?.disagreements ?? [],
  };
}

/** Сколько знаков перед подписью графы «Шифр расценки» смотреть на признаки формы ТСН-2001 (шапка сметы). */
const TSN_HEAD_LENGTH = 20000;

/**
 * Есть ли в тексте смета по форме ТСН-2001 Москвы. Смета бывает не в начале: текст архива — это файлы подряд, и форма № 4б
 * лежит в его середине (закупка 32616403300: с 915-тысячного знака). Поэтому смотрится шапка перед каждой подписью графы
 * «Шифр расценки», а не только начало документа.
 */
function hasTsnEstimate(text: string): boolean {
  for (let at = text.indexOf("Шифр расценки"); at >= 0; at = text.indexOf("Шифр расценки", at + 1)) {
    const head = text.slice(Math.max(0, at - TSN_HEAD_LENGTH), at + 200);
    if (isTsnFormHead(head) && normBaseOf(head) === "TSN_2001_MOSCOW") return true;
  }
  return false;
}

/* ----------------------------- Сверка зон ----------------------------- */

/**
 * Зона заказчика и зона нашей книги — одна и та же. Без угадывания: названия совпали после нормализации, либо один
 * субъект и один номер. Если у одной из сторон номера нет (у субъекта одна зона), совпадение субъекта считается совпадением.
 */
export function sameZone(
  declared: { readonly zoneName: string | null; readonly subject: string | null; readonly zoneNumber: number | null },
  ourZoneName: string,
): boolean {
  if (declared.zoneName !== null && normalizeRegionText(declared.zoneName) === normalizeRegionText(ourZoneName)) return true;
  const declaredSubject = declared.subject ?? (declared.zoneName === null ? null : subjectOfZoneName(declared.zoneName));
  if (declaredSubject === null || declaredSubject === "") return false;
  if (!isSameRegion(declaredSubject, subjectOfZoneName(ourZoneName))) return false;
  const ourNumber = zoneNumberIn(ourZoneName);
  if (declared.zoneNumber === null || ourNumber === null) return true;
  return declared.zoneNumber === ourNumber;
}

/**
 * Чем наш уровень цен отличается от заявленного заказчиком; пусто — совпали или сравнивать нечего.
 * Это пометка расчёта (`PRICE_LEVEL_DIFFERS`), а не отказ: расчёт идёт в нашей зоне и в нашем квартале, но построчное
 * сравнение цен со сметой заказчика становится неточным.
 */
export function priceLevelDifferences(declared: DeclaredPriceLevelSummary | null, ours: IndexPriceLevel): string[] {
  if (declared === null) return [];
  const messages: string[] = [...declared.disagreements];

  if ((declared.zoneName !== null || declared.subject !== null) && ours.priceZone.trim() !== "" && !sameZone(declared, ours.priceZone)) {
    const theirs = declared.zoneName ?? declared.subject ?? "";
    messages.push(
      `Смета заказчика посчитана в ценовой зоне «${theirs}», а наш расчёт — в зоне «${ours.priceZone}»: ` +
        "цены ресурсов зон различаются, построчное сравнение цен не равнозначно.",
    );
  }

  const ourQuarter = quarterIn(ours.period);
  if (
    declared.quarter !== null &&
    declared.year !== null &&
    ourQuarter !== null &&
    (declared.quarter !== ourQuarter.quarter || declared.year !== ourQuarter.year)
  ) {
    messages.push(
      `Смета заказчика составлена в уровне цен ${describeCustomerQuarter(declared.quarter, declared.year, true)}, ` +
        `наш расчёт — в уровне ${String(ourQuarter.quarter)} квартала ${String(ourQuarter.year)} г.: ` +
        "цены ресурсов различаются на индексацию между кварталами, построчное сравнение цен неточно.",
    );
  }

  return messages;
}
