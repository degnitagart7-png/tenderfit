import { parseNumberCell, type DocumentText } from "@/domain/estimate/customerEstimate";
import type { SsrAuditFinding, SsrAuditReport } from "@/domain/estimate/customerSsrAudit";
import { annualDeflator } from "@/domain/estimate/ssrNormatives";

/**
 * Расчёт НМЦК заказчика по приказу 841/пр (приложение 2: «Расчёт начальной (максимальной) цены контракта») и проект сметы
 * контракта (приложение 3), прочитанные из «Обоснования НМЦК», и аудит их арифметики и методики.
 *
 * Что стоит за модулем. Заказчик определяет НМЦК иным методом на основании ЛСР: по каждому объекту лист «ССР Расчёт НМЦК» берёт
 * стоимость СМР в ценах сметной документации, умножает на «индекс фактической инфляции» (ИПЦ Росстата) и на «индекс прогнозной
 * инфляции» (дефляторы Минэкономразвития), а проект сметы контракта по каждому объекту переносит итог в позиции контракта.
 * Ошибки здесь стоят дороже ошибок в ЛСР: они сдвигают всю НМЦК. Проверяется (только арифметика и справочники, модели нет):
 * 1. индекс фактической инфляции за месяц, который ещё не закончился или по которому Росстат не успел опубликовать данные;
 * 2. месячный индекс выше 1 % при прогнозе Минэкономразвития на год около 0,9 % в месяц;
 * 3. годовой индекс прогнозной инфляции против дефлятора «Инвестиции в основной капитал» письма Минэкономразвития;
 * 4. подпись «цена по ЛСР» у суммы, в которую уже вошли индексы;
 * 5. лимит финансирования, распределённый по приложениям сметы контракта неравномерно.
 *
 * Принцип «лучше не найдено, чем ложная находка»: чего в расчёте нет или не разобрано, не проверяется.
 */

export interface NmckCalcSheet {
  readonly documentName: string;
  /** «1.1»: номер приложения, по которому лист связывается с проектом сметы контракта «3.1». */
  readonly appendix: string | null;
  readonly title: string;
  /** Стоимость СМР без НДС в трёх уровнях: цены сметы, после фактической инфляции, после прогнозной. */
  readonly exVat: readonly [number, number, number] | null;
  /** То же с НДС. */
  readonly withVat: readonly [number, number, number] | null;
  readonly vatPercent: number | null;
  readonly actualIndex: number | null;
  readonly forecastIndex: number | null;
  /** «Октябрь 2026 / Сентябрь 2026» → числитель и знаменатель ИПЦ, «2026-10» и «2026-09». */
  readonly actualBasis: { readonly text: string; readonly numerator: string; readonly denominator: string } | null;
  /** Годовой индекс прогнозной инфляции на год: «на 2026 год … 105,5%». */
  readonly annual: readonly { readonly year: number; readonly percent: number }[];
  readonly priceLevel: string | null;
  readonly formationMonth: string | null;
  readonly startMonth: string | null;
  readonly endMonth: string | null;
  readonly months: number | null;
  /** Формула прогнозного индекса, как напечатана: «(1,0045² - 1)/2 + 1». */
  readonly forecastFormula: string | null;
}

export interface NmckContractEstimate {
  readonly documentName: string;
  readonly appendix: string | null;
  readonly title: string;
  readonly totalExVat: number | null;
  readonly vat: number | null;
  readonly totalWithVat: number | null;
  readonly positions: number;
}

export interface NmckJustification {
  readonly documentName: string;
  /** Лимит финансирования, ₽. */
  readonly limit: number | null;
  /** «Цена согласно локальному сметному расчёту», как её назвал заказчик, ₽. */
  readonly namedLsrPrice: number | null;
  /** НМЦК, установленная заказчиком, ₽. */
  readonly nmck: number | null;
  /** «Дата подготовки обоснования НМЦК» (ISO). */
  readonly date: string | null;
}

export interface CustomerNmck {
  readonly sheets: readonly NmckCalcSheet[];
  readonly contracts: readonly NmckContractEstimate[];
  readonly justification: NmckJustification | null;
}

/* ------------------------------ Разбор ------------------------------ */

const MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"] as const;
const MONTH_NAMES = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;

function monthKey(text: string): string | null {
  const match = /([а-яё]+)\s+(20\d{2})/iu.exec(text);
  if (match === null) return null;
  const word = (match[1] as string).toLowerCase();
  const index = MONTHS.findIndex((stem) => word.startsWith(stem));
  return index < 0 ? null : `${match[2] as string}-${String(index + 1).padStart(2, "0")}`;
}

const monthIndex = (key: string): number => Number.parseInt(key.slice(0, 4), 10) * 12 + Number.parseInt(key.slice(5, 7), 10) - 1;
const monthText = (key: string): string => `${MONTH_NAMES[Number.parseInt(key.slice(5, 7), 10) - 1] as string} ${key.slice(0, 4)}`;

interface Row {
  readonly cells: readonly string[];
  readonly delimiter: string;
}

/** Строка CSV по ячейкам с учётом кавычек; разделитель — тот, которого больше вне кавычек. Листы короткие: хвосты пустых ячеек в тексте обрезаны. */
function splitRow(line: string): Row {
  let semicolons = 0;
  let commas = 0;
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted) {
      if (char === ";") semicolons += 1;
      else if (char === ",") commas += 1;
    }
  }
  const delimiter = semicolons > commas ? ";" : ",";
  const cells: string[] = [];
  let current = "";
  quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else quoted = false;
      } else current += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return { cells, delimiter };
}

function numbersOf(cells: readonly string[], delimiter: string): number[] {
  const result: number[] = [];
  for (const cell of cells) {
    const value = parseNumberCell(cell.replace("%", "").trim(), delimiter);
    if (value !== null) result.push(value);
  }
  return result;
}

function appendixOf(name: string): string | null {
  const match = /приложение\s*№?\s*(\d+)\.(\d+)/iu.exec(name);
  return match === null ? null : `${match[1] as string}.${match[2] as string}`;
}

interface Part {
  readonly file: string;
  readonly sheet: string | null;
  readonly lines: readonly string[];
  /** Где часть лежит в тексте документа: от метки, открывшей её, до следующей метки (`text.slice(start, end)`). */
  readonly start: number;
  readonly end: number;
}

/** Файлы архива и листы: заголовки «=== имя ===»; имя с расширением — файл, остальные — лист. */
function partsOf(document: DocumentText): Part[] {
  const parts: Part[] = [];
  let file = document.name;
  let sheet: string | null = null;
  let current: string[] = [];
  let partStart = 0;
  let position = 0;
  const flush = (end: number): void => {
    if (current.some((line) => line.trim() !== "")) parts.push({ file, sheet, lines: current, start: partStart, end });
    current = [];
  };
  for (const raw of document.text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length >= 6 && trimmed.startsWith("===") && trimmed.endsWith("===")) {
      const name = trimmed.slice(3, -3).trim();
      flush(position);
      partStart = position;
      if (/\.(?:xlsx?|docx?|pdf|csv|rar|zip)$/iu.test(name)) {
        file = name;
        sheet = null;
      } else {
        sheet = name;
      }
      position += raw.length + 1;
      continue;
    }
    current.push(raw);
    position += raw.length + 1;
  }
  flush(document.text.length);
  return parts;
}

function parseCalcSheet(part: Part): NmckCalcSheet | null {
  const text = part.lines.join("\n");
  if (!/расч[её]т\s+начальной/iu.test(text) && !/индекс\s+фактической\s+инфляции/iu.test(text)) return null;
  if (!/индекс\s+прогнозной\s+инфляции/iu.test(text)) return null;

  let title = "";
  let exVat: [number, number, number] | null = null;
  let withVat: [number, number, number] | null = null;
  let vatPercent: number | null = null;
  let actualIndex: number | null = null;
  let forecastIndex: number | null = null;
  let actualBasis: NmckCalcSheet["actualBasis"] = null;
  const annual: { year: number; percent: number }[] = [];
  let priceLevel: string | null = null;
  let formationMonth: string | null = null;
  let startMonth: string | null = null;
  let endMonth: string | null = null;
  let months: number | null = null;
  let forecastFormula: string | null = null;
  let amountsSeen = false;

  for (const raw of part.lines) {
    if (raw.trim() === "") continue;
    const parsed = splitRow(raw);
    const cells = parsed.cells.map((cell) => cell.trim());
    const label = cells.find((cell) => cell !== "") ?? "";
    const lower = label.toLowerCase();
    const numbers = numbersOf(cells.slice(1), parsed.delimiter);

    if (title === "" && /^устранение|^ремонт|^выполнение/iu.test(label) && numbers.length === 0) title = label;
    if (/^строительно-монтажные\s+работы/iu.test(label) && numbers.length >= 5) {
      amountsSeen = true;
      exVat ??= [numbers[0] as number, numbers[2] as number, numbers[4] as number];
      actualIndex = numbers[1] as number;
      forecastIndex = numbers[3] as number;
    } else if (/^стоимость\s+без\s+учета\s+ндс/iu.test(label) && numbers.length >= 3) {
      exVat = [numbers[0] as number, numbers[1] as number, numbers[2] as number];
    } else if (/^стоимость\s+с\s+учетом\s+ндс/iu.test(label) && numbers.length >= 3) {
      withVat = [numbers[0] as number, numbers[1] as number, numbers[2] as number];
    } else if (/^ндс\s*\(\s*(\d+(?:[.,]\d+)?)\s*%/iu.test(label)) {
      vatPercent = Number.parseFloat(((/(\d+(?:[.,]\d+)?)\s*%/u.exec(label) ?? [])[1] ?? "").replace(",", "."));
    }

    // Строки пояснений: метка во втором столбце («Уровень цен…», «Дата формирования НМЦК», «Октябрь 2026 / Сентябрь 2026»).
    const second = cells[1] ?? "";
    const value = cells.slice(2).find((cell) => cell !== "") ?? "";
    if (/уровень\s+цен/iu.test(second)) priceLevel = value === "" ? null : value;
    else if (/дата\s+формирования\s+нмцк/iu.test(second)) formationMonth = monthKey(value);
    else if (/^начало\s+строительства/iu.test(second)) startMonth = monthKey(value);
    else if (/^окончание\s+строительства/iu.test(second)) endMonth = monthKey(value);
    else if (/^продолжительность/iu.test(second)) {
      const parsedMonths = /(\d+)/u.exec(value);
      months = parsedMonths === null ? null : Number.parseInt(parsedMonths[1] as string, 10);
    } else if (/^[а-яё]+\s+20\d{2}\s*\/\s*[а-яё]+\s+20\d{2}/iu.test(second)) {
      const [top, bottom] = second.split("/");
      const numerator = monthKey(top ?? "");
      const denominator = monthKey(bottom ?? "");
      if (numerator !== null && denominator !== null) actualBasis = { text: second, numerator, denominator };
    } else if (/^на\s+(20\d{2})\s*год/iu.test(second)) {
      const year = Number.parseInt((/(20\d{2})/u.exec(second) ?? [])[1] ?? "0", 10);
      const percent = numbersOf(cells.slice(2), parsed.delimiter).find((n) => n > 50 && n < 400);
      if (percent !== undefined && !annual.some((item) => item.year === year)) annual.push({ year, percent });
    } else if (/^к\s+на\s+20\d{2}/iu.test(second) && forecastFormula === null) {
      forecastFormula = cells.find((cell, index) => index >= 2 && /[²2]|\/\s*2/u.test(cell) && /\(/u.test(cell)) ?? null;
    } else if (/итого\s+индекс\s+фактической/iu.test(second) || /итого\s+индекс\s+фактической/iu.test(lower)) {
      const found = numbersOf(cells.slice(1), parsed.delimiter).find((n) => n > 0.5 && n < 2);
      if (found !== undefined) actualIndex = found;
    } else if (/итого\s+индекс\s+прогнозной/iu.test(second) || /итого\s+индекс\s+прогнозной/iu.test(lower)) {
      const found = numbersOf(cells.slice(1), parsed.delimiter).find((n) => n > 0.5 && n < 2);
      if (found !== undefined) forecastIndex = found;
    }
  }

  if (!amountsSeen && exVat === null && withVat === null) return null;
  return {
    documentName: part.file,
    appendix: appendixOf(part.file),
    title,
    exVat,
    withVat,
    vatPercent,
    actualIndex,
    forecastIndex,
    actualBasis,
    annual,
    priceLevel,
    formationMonth,
    startMonth,
    endMonth,
    months,
    forecastFormula,
  };
}

function parseContract(part: Part): NmckContractEstimate | null {
  const text = part.lines.join("\n");
  if (!/проект\s+сметы\s+контракта|смета\s+контракта/iu.test(text) && !/смета\s+контракта/iu.test(part.sheet ?? "")) return null;

  let title = "";
  let titleNext = false;
  let totalExVat: number | null = null;
  let vat: number | null = null;
  let totalWithVat: number | null = null;
  let positions = 0;
  for (const raw of part.lines) {
    if (raw.trim() === "") continue;
    const parsed = splitRow(raw);
    const cells = parsed.cells.map((cell) => cell.trim());
    const label = cells.find((cell) => cell !== "") ?? "";
    const numbers = numbersOf(cells.slice(1), parsed.delimiter);
    if (titleNext && title === "" && label !== "" && numbers.length === 0) {
      title = label;
      titleNext = false;
    }
    if (/^\(наименование\s+объекта\)/iu.test(label)) titleNext = true;
    if (/^итого\s+по\s+смете/iu.test(label) || /итого\s+по\s+смете/iu.test(cells[1] ?? "")) totalExVat ??= numbers[numbers.length - 1] ?? null;
    else if (/сумма\s+ндс/iu.test(label) || /сумма\s+ндс/iu.test(cells[1] ?? "")) vat ??= numbers[numbers.length - 1] ?? null;
    else if (/^всего\s+с\s+ндс/iu.test(label) || /всего\s+с\s+ндс/iu.test(cells[1] ?? "")) totalWithVat ??= numbers[numbers.length - 1] ?? null;
    else if (/^\d+$/u.test(cells[0] ?? "") && /^лс\s/iu.test(cells[1] ?? "")) positions += 1;
  }
  if (totalExVat === null && totalWithVat === null) return null;
  return { documentName: part.file, appendix: appendixOf(part.file), title, totalExVat, vat, totalWithVat, positions };
}

const MONEY = /(\d{1,3}(?:[  ]\d{3})*(?:,\d{1,2})?)\s*руб/iu;

function moneyAfter(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (match === null) return null;
  const tail = text.slice(match.index + match[0].length);
  const amount = MONEY.exec(tail.slice(0, 400));
  if (amount === null) return null;
  const value = Number.parseFloat((amount[1] as string).replace(/[\s  ]/gu, "").replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function parseJustification(document: DocumentText, part: Part): NmckJustification | null {
  const text = part.lines.join("\n").replace(/\s+/gu, " ");
  if (!/лимит\s+финансирования|цена\s+согласно\s+локального/iu.test(text)) return null;
  const limit = moneyAfter(text, /лимит\s+финансирования[^.]{0,80}составляет/iu);
  const named = moneyAfter(text, /цена\s+согласно\s+локального\s+сметного\s+расч[её]та\s+[а-яё]*/iu);
  const nmck = moneyAfter(text, /итого\s+начальная\s+\(максимальная\)\s+цена\s+контракта:?/iu);
  const date = /дата\s+подготовки\s+обоснования\s+нмцк:\s*(\d{2})\.(\d{2})\.(\d{4})/iu.exec(text);
  if (limit === null && named === null && nmck === null) return null;
  return {
    documentName: part.file === "" ? document.name : part.file,
    limit,
    namedLsrPrice: named,
    nmck,
    date: date === null ? null : `${date[3] as string}-${date[2] as string}-${date[1] as string}`,
  };
}

/** Расчёты НМЦК и проекты смет контракта из текстов документов; нет ни одного листа расчёта — null. */
export function parseCustomerNmck(documents: readonly DocumentText[]): CustomerNmck | null {
  const sheets: NmckCalcSheet[] = [];
  const contracts: NmckContractEstimate[] = [];
  let justification: NmckJustification | null = null;
  for (const document of documents) {
    if (document.text === "" || !/нмцк|начальн[а-яё]*\s+\(максимальн/iu.test(document.text)) continue;
    for (const part of partsOf(document)) {
      const calc = parseCalcSheet(part);
      if (calc !== null) {
        sheets.push(calc);
        continue;
      }
      const contract = parseContract(part);
      if (contract !== null) {
        contracts.push(contract);
        continue;
      }
      justification ??= parseJustification(document, part);
    }
  }
  if (sheets.length === 0) return null;
  return { sheets, contracts, justification };
}

/**
 * Куски текста документа, которые читаются как лист расчёта НМЦК или проект сметы контракта: `text.slice(start, end)`, от метки
 * «=== … ===» до следующей. Те же отбор и признаки, что у `parseCustomerNmck`; нужны бенчмарку «вслепую»
 * (`estimateRemoval.ts`), чтобы вырезать эти таблицы из входа расчёта.
 */
export function nmckEstimateSpans(document: DocumentText): { readonly start: number; readonly end: number; readonly kind: "CALC" | "CONTRACT" }[] {
  if (document.text === "" || !/нмцк|начальн[а-яё]*\s+\(максимальн/iu.test(document.text)) return [];
  const spans: { start: number; end: number; kind: "CALC" | "CONTRACT" }[] = [];
  for (const part of partsOf(document)) {
    if (parseCalcSheet(part) !== null) spans.push({ start: part.start, end: part.end, kind: "CALC" });
    else if (parseContract(part) !== null) spans.push({ start: part.start, end: part.end, kind: "CONTRACT" });
  }
  return spans;
}

/* ------------------------------ Аудит ------------------------------ */

export interface NmckAuditContext {
  /** ISO-дата «сегодня». */
  readonly today: string;
}

const rubFormat = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rub = (value: number): string => `${rubFormat.format(Math.abs(value))} ₽`;
const signedRub = (value: number): string => `${value < 0 ? "−" : "+"}${rub(value)}`;
const pct2 = (value: number): string => `${value.toFixed(2).replace(".", ",")} %`;
const num4 = (value: number): string => value.toFixed(4).replace(".", ",");
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Месяц заканчивается в последний день; ИПЦ Росстата за него выходит, как правило, в середине следующего месяца. */
const PUBLICATION_DAY = 15;

function dayStamp(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(iso);
  if (match === null) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
}

/** Данные Росстата за месяц на дату: «NOT_ENDED» — месяц не закончился, «MAYBE» — закончился, но до середины следующего, «PUBLISHED». */
export function actualIndexAvailability(month: string, today: string): "NOT_ENDED" | "MAYBE" | "PUBLISHED" | "UNKNOWN" {
  const now = dayStamp(today);
  if (Number.isNaN(now)) return "UNKNOWN";
  const year = Number.parseInt(month.slice(0, 4), 10);
  const m = Number.parseInt(month.slice(5, 7), 10);
  const lastDay = Date.UTC(year, m, 0) / 86_400_000;
  if (now <= lastDay) return "NOT_ENDED";
  const publication = Date.UTC(year, m, PUBLICATION_DAY) / 86_400_000;
  return now < publication ? "MAYBE" : "PUBLISHED";
}

export function auditCustomerNmck(nmck: CustomerNmck, ctx: NmckAuditContext): SsrAuditReport {
  const findings: SsrAuditFinding[] = [];
  const { sheets, contracts, justification } = nmck;
  const vatFactor = (sheet: NmckCalcSheet): number => 1 + (sheet.vatPercent ?? 22) / 100;
  const withVatOf = (sheet: NmckCalcSheet, level: 0 | 1 | 2): number | null =>
    sheet.withVat !== null ? sheet.withVat[level] : sheet.exVat !== null ? round2(sheet.exVat[level] * vatFactor(sheet)) : null;

  const sum = (level: 0 | 1 | 2): number | null => {
    let total = 0;
    for (const sheet of sheets) {
      const value = withVatOf(sheet, level);
      if (value === null) return null;
      total += value;
    }
    return round2(total);
  };
  const sumLsr = sum(0);
  const sumActual = sum(1);
  const sumFinal = sum(2);

  // 1. Индекс фактической инфляции за месяц, которого ещё нет в статистике.
  const basis = sheets.find((sheet) => sheet.actualBasis !== null)?.actualBasis ?? null;
  const actual = sheets.find((sheet) => sheet.actualIndex !== null && sheet.actualIndex !== 1)?.actualIndex ?? null;
  if (basis !== null && actual !== null) {
    const availability = actualIndexAvailability(basis.numerator, ctx.today);
    const names = `«${basis.text}»`;
    if (availability === "NOT_ENDED" || availability === "MAYBE") {
      // «Как должно быть»: без фактической инфляции (данных за месяц нет) — индекс 1; прогнозный множитель остаётся.
      let impact = 0;
      let known = true;
      for (const sheet of sheets) {
        const lsr = withVatOf(sheet, 0);
        const final = withVatOf(sheet, 2);
        if (lsr === null || final === null) {
          known = false;
          break;
        }
        impact += lsr * (sheet.forecastIndex ?? 1) - final;
      }
      const effect = known ? round2(impact) : null;
      findings.push({
        type: "NMCK_FUTURE_ACTUAL_INDEX",
        severity: availability === "NOT_ENDED" ? "WARNING" : "INFO",
        message:
          availability === "NOT_ENDED"
            ? `Индекс фактической инфляции ${num4(actual)} (ИПЦ Росстата ${names}) взят за месяц, который ещё не закончился на ${ctx.today.split("-").reverse().join(".")}: фактических данных за ${monthText(basis.numerator)} нет и быть не может. Индекс с этой даты — не факт, а чья-то оценка${effect === null ? "" : `; без него НМЦК меньше на ${rub(effect)} (по всем объектам, с НДС)`}`
            : `Индекс фактической инфляции ${num4(actual)} (ИПЦ Росстата ${names}): месяц закончился, но Росстат публикует ИПЦ в середине следующего месяца — проверьте, что значение взято из опубликованных данных${effect === null ? "" : `; влияние индекса на НМЦК ${signedRub(effect)}`}`,
        impact: availability === "NOT_ENDED" ? effect : null,
        ref: "841/пр, п. 8 (подп. «б»), 22; ИПЦ Росстата",
      });
    }

    // 2. Месячный индекс выше 1 %: прогноз Минэкономразвития на год — около 0,9 % в месяц.
    const span = monthIndex(basis.numerator) - monthIndex(basis.denominator);
    if (span >= 1) {
      const monthly = actual ** (1 / span);
      const year = Number.parseInt(basis.numerator.slice(0, 4), 10);
      const annual = annualDeflator(year);
      const forecastMonthly = annual === null ? null : annual ** (1 / 12);
      if (monthly > 1.01) {
        findings.push({
          type: "NMCK_MONTHLY_INDEX",
          severity: "WARNING",
          message:
            `Индекс фактической инфляции ${num4(actual)} за ${String(span)} мес. — это ${pct2((monthly - 1) * 100)} в месяц, выше 1 %` +
            (forecastMonthly === null
              ? ""
              : `; прогноз Минэкономразвития на ${String(year)} г. (индекс-дефлятор «Инвестиции в основной капитал» ${(annual as number * 100).toFixed(1).replace(".", ",")} % г/г) даёт около ${pct2((forecastMonthly - 1) * 100)} в месяц`) +
            `. Влияние на НМЦК уже учтено в находке про фактическую инфляцию и в одну сумму с ней не складывается`,
          impact: null,
          ref: "841/пр, п. 8 (подп. «б»), 22 (подп. «б»)",
        });
      }
    }
  }

  // 3. Годовой индекс прогнозной инфляции: вместо дефлятора письма Минэкономразвития — другое число.
  const withAnnual = sheets.find((sheet) => sheet.annual.length === 1 && sheet.forecastIndex !== null && sheet.months !== null);
  if (withAnnual !== undefined) {
    const customerYear = withAnnual.annual[0] as { year: number; percent: number };
    const ours = annualDeflator(customerYear.year);
    const sameYear = withAnnual.startMonth !== null && withAnnual.endMonth !== null && withAnnual.startMonth.slice(0, 4) === withAnnual.endMonth.slice(0, 4);
    if (ours !== null && Math.abs(ours * 100 - customerYear.percent) > 0.05) {
      let impact: number | null = null;
      let formulaNote = "";
      if (sameYear && withAnnual.months !== null && /[²2]/u.test(withAnnual.forecastFormula ?? "")) {
        // Та же формула заказчика («(И² − 1)/2 + 1» для двух месяцев), но с дефлятором письма.
        const months = withAnnual.months;
        const own = ((ours ** (months / 12) - 1) / 2) + 1;
        const theirs = withAnnual.forecastIndex as number;
        let total = 0;
        let known = true;
        for (const sheet of sheets) {
          const base = withVatOf(sheet, 1);
          if (base === null) {
            known = false;
            break;
          }
          total += base * (own - (sheet.forecastIndex ?? theirs));
        }
        impact = known ? round2(total) : null;
        formulaNote = `: по той же формуле заказчика с дефлятором письма индекс ${num4(own)} вместо ${num4(theirs)}${impact === null ? "" : `, ${signedRub(impact)} (с НДС, по всем объектам)`}`;
      }
      findings.push({
        type: "NMCK_FORECAST_INDEX",
        severity: "WARNING",
        message: `Годовой индекс прогнозной инфляции на ${String(customerYear.year)} г. у заказчика ${customerYear.percent.toFixed(1).replace(".", ",")} %, а индекс-дефлятор «Инвестиции в основной капитал» в письме Минэкономразвития на этот год — ${(ours * 100).toFixed(1).replace(".", ",")} %${formulaNote}. Источник числа заказчика не назван — проверьте`,
        impact,
        ref: "841/пр, п. 8 (подп. «б»), 22 (подп. «б»), 23",
      });
    }
  }

  // 4. «Цена по ЛСР» — на сумме, в которую уже вошли индексы.
  if (justification !== null && justification.namedLsrPrice !== null && sumFinal !== null && sumLsr !== null) {
    const named = justification.namedLsrPrice;
    const equalsFinal = Math.abs(named - sumFinal) <= 1;
    const equalsActual = sumActual !== null && Math.abs(named - sumActual) <= 1;
    if ((equalsFinal || equalsActual) && Math.abs(named - sumLsr) > 1) {
      const which = equalsFinal ? "после фактической и прогнозной инфляции" : "после фактической инфляции";
      const limit = justification.limit;
      const limitNote =
        limit === null
          ? ""
          : limit >= sumLsr
            ? ` Лимит финансирования ${rub(limit)} ${limit > sumLsr ? `больше цены по ЛСР на ${rub(limit - sumLsr)}` : "равен цене по ЛСР"}: «нехватка лимита» ${rub(named - limit)} возникает только из-за индексов`
            : ` Лимит финансирования ${rub(limit)} меньше цены по ЛСР на ${rub(sumLsr - limit)}.`;
      findings.push({
        type: "NMCK_LSR_LABEL",
        severity: "WARNING",
        message: `«Цена согласно локальному сметному расчёту» ${rub(named)} — не цена по ЛСР: это итог приложений расчёта НМЦК ${which}. Цена по ЛСР в уровне цен ${sheets.find((sheet) => sheet.priceLevel !== null)?.priceLevel ?? "сметной документации"} — ${rub(sumLsr)} (сумма по ${String(sheets.length)} объектам, с НДС), разница ${signedRub(sumLsr - named)}.${limitNote}`,
        impact: null,
        ref: "841/пр, п. 22 (подп. «б»), приложение 2",
      });
    }
  }

  // 5. Лимит финансирования распределён по приложениям сметы контракта неравномерно.
  const pairs = contracts
    .map((contract) => {
      const calc = sheets.find((sheet) => sheet.appendix !== null && contract.appendix !== null && sheet.appendix.split(".")[1] === contract.appendix.split(".")[1]);
      const final = calc === undefined ? null : withVatOf(calc, 2);
      return { contract, final };
    })
    .filter((item): item is { contract: NmckContractEstimate; final: number } => item.contract.totalWithVat !== null && item.final !== null && item.final > 0);
  if (pairs.length >= 2) {
    const contractTotal = round2(pairs.reduce((total, item) => total + (item.contract.totalWithVat as number), 0));
    const calcTotal = round2(pairs.reduce((total, item) => total + item.final, 0));
    const ratios = pairs.map((item) => ({ item, ratio: (item.contract.totalWithVat as number) / item.final }));
    const overall = contractTotal / calcTotal;
    const spread = Math.max(...ratios.map((entry) => entry.ratio)) - Math.min(...ratios.map((entry) => entry.ratio));
    if (spread > 0.005 && contractTotal < calcTotal - 1) {
      const limitMatches = justification?.limit != null && Math.abs(justification.limit - contractTotal) <= 1;
      const parts = ratios
        .map(({ item, ratio }) => `${item.contract.appendix ?? "?"}${item.contract.title === "" ? "" : ` «${item.contract.title.replace(/^Устранение замечаний по МКП ГКШП\.\s*/iu, "").slice(0, 45)}»`} — ${ratio >= 0.99995 ? "без изменений" : pct2(ratio * 100)}`)
        .join("; ");
      findings.push({
        type: "NMCK_LIMIT_UNEVEN",
        severity: "WARNING",
        message:
          `Сумма проектов смет контракта ${rub(contractTotal)} ${limitMatches ? "равна лимиту финансирования" : "меньше расчёта НМЦК"} (${rub(calcTotal)} по приложениям расчёта), но сокращение распределено неравномерно: ${parts}. ` +
          `При едином коэффициенте ${pct2(overall * 100)} разброс был бы нулевым; сейчас ${pct2(spread * 100)} разницы между приложениями. Часть объектов осталась в сумме расчёта НМЦК целиком, часть урезана по-разному: позиции контракта по ним не сопоставимы с ЛСР`,
        impact: null,
        ref: "841/пр, п. 3, 21; приложение 3 (проект сметы контракта)",
      });
    }
  }

  const warnings = findings.filter((finding) => finding.severity === "WARNING").length;
  const totalFinal = sumFinal;
  const conclusion =
    warnings === 0
      ? "Расчёт НМЦК заказчика сходится: индексы, подписи сумм и распределение лимита без замечаний"
      : `Замечаний: ${String(warnings)}. Влияние указано рядом с находкой (плюс — НМЦК занижена, минус — завышена); находки пересекаются и в одну сумму не складываются`;
  return {
    documentName: justification?.documentName ?? sheets[0]?.documentName ?? "Расчёт НМЦК",
    estimateName: `Расчёт НМЦК заказчика (${String(sheets.length)} ${sheets.length === 1 ? "лист" : "листов"}${contracts.length > 0 ? `, смет контракта ${String(contracts.length)}` : ""})`,
    findings,
    warnings,
    customer: {
      chaptersTotal: null,
      reservePercent: null,
      inflationIndex: sheets.find((sheet) => sheet.forecastIndex !== null)?.forecastIndex ?? null,
      vatPercent: sheets.find((sheet) => sheet.vatPercent !== null)?.vatPercent ?? null,
      total: totalFinal,
      unitMultiplier: 1,
    },
    ourInflation: null,
    inflationPeriod: null,
    rows: [],
    conclusion,
  };
}
