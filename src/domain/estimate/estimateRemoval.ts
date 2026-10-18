import { bimStreamSpans, parseCustomerBim } from "@/domain/estimate/customerBim";
import { splitCustomerEstimates, type DocumentText } from "@/domain/estimate/customerEstimate";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { nmckEstimateSpans, parseCustomerNmck } from "@/domain/estimate/customerNmck";
import { parseContractEstimates } from "@/domain/estimate/contractEstimate";
import { isSmetaRuServiceSheet } from "@/domain/estimate/smetaRu";

/**
 * Вырезание смет заказчика из текста документации: вход расчёта «вслепую» (`scripts/estimate-benchmark.ts --blind`).
 *
 * Зачем. Расчёт без сметы заказчика читает объёмы моделью из ТЗ, ведомости объёмов и спецификаций. Чтобы проверить этот путь на закупке,
 * у которой смета есть, смету нужно убрать из входа целиком: иначе модель перепишет её объёмы, и сравнение с ней ничего не скажет.
 * Но архив хранится одним текстом (файлы и листы подряд под метками «=== имя ==="), и «Описание объекта закупки.rar» нередко содержит
 * и ТЗ, и ЛСР. Поэтому документ не отбрасывается, а режется: из него уходят отрезки, которые читают наши разборы смет, остальное остаётся.
 *
 * Что вырезается (отрезки те же, что читают разборы, — отдельной сегментации здесь нет):
 * - локальные сметы формы 421/пр (Гранд-Смета, Smeta.RU, ТСН-2001 форма № 4б) — отрезок `splitCustomerEstimates` от метки листа до строки
 *   «ВСЕГО по смете» вместе с хвостом НДС, который читает разбор; признаёт смету сам разбор (`parseCustomerLsr`), а не «Итого» в тексте,
 *   поэтому ведомость объёмов с подсумками, которую разбор сметой не считает, остаётся;
 * - сметы на базисно-индексном методе (таблица листа и текст-поток PDF формы 421/пр, `parseCustomerBim`);
 * - служебные листы Smeta.RU (`Source`, `EtalonRes`…) — дамп базы программы рядом со сметой;
 * - «смета контракта» по форме 841/пр: таблица со строками «ЛС … Поз.:», с шапкой столбцов и итоговыми строками;
 * - расчёты НМЦК и проекты смет контракта из «Обоснования НМЦК» — листы, которые читает `parseCustomerNmck`.
 *
 * Чего не вырезается и о чём говорится. Отрезок, который смета занимает не с метки листа, а с начала плоского документа (Word, PDF), начинается с
 * шапки формы, если она находится; ТЗ перед сметой остаётся. Шапка не нашлась — вырезан весь отрезок, и это записано в `warnings`. Сметы не по форме 421/пр
 * (разбор их не читает, расчёт тоже, и в боевом прогоне их читала бы модель) остаются и названы в `warnings`.
 *
 * Проверка. После вырезания три разбора (`parseCustomerLsr`, `parseCustomerBim`, `parseContractEstimates`) и разбор НМЦК не должны находить
 * в остатке ничего; нашли — это `leaks`, и закупку считать нельзя: модель переписала бы объёмы заказчика. Остаток вырезается ещё раз (до трёх
 * проходов), и только потом называется утечкой.
 *
 * Модуль чистый: ни диска, ни сети, ни модели.
 */

/* ------------------------------ Типы ------------------------------ */

export type RemovedKind = "LSR" | "BIM_GRID" | "BIM_STREAM" | "SERVICE_SHEET" | "CONTRACT_ESTIMATE" | "NMCK_CALC" | "NMCK_CONTRACT";

export interface RemovedSpan {
  readonly document: string;
  readonly kind: RemovedKind;
  /** Что вырезано: номер или лист сметы, таблица смет контракта. */
  readonly label: string | null;
  /** Знаков вырезано (в исходном тексте, до слияния соседних отрезков). */
  readonly chars: number;
}

/** Остаток, в котором разбор всё ещё находит смету или таблицу. */
export interface EstimateLeak {
  readonly document: string;
  readonly detector: "LSR" | "BIM" | "CONTRACT_ESTIMATE" | "NMCK";
  readonly detail: string;
}

export interface StrippedDocument extends DocumentText {
  readonly originalChars: number;
  readonly removedChars: number;
}

export interface DroppedDocument {
  readonly name: string;
  readonly originalChars: number;
  /** Букв и цифр, оставшихся после вырезания (меньше порога). */
  readonly leftoverChars: number;
}

export interface StripResult {
  /** Документы без смет: то, что уходит в расчёт. Документ, из которого вырезано всё, сюда не входит (`dropped`). */
  readonly documents: readonly StrippedDocument[];
  readonly dropped: readonly DroppedDocument[];
  readonly removed: readonly RemovedSpan[];
  readonly leaks: readonly EstimateLeak[];
  /** Всё, что вырезано неточно или осталось похожим на смету. Не утечка, но человеку надо знать. */
  readonly warnings: readonly string[];
}

/** Замечание об отрезке текста: снимается, если другой разбор всё же вырезал этот отрезок. */
interface Note {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Span {
  start: number;
  end: number;
  readonly kind: RemovedKind;
  readonly label: string | null;
  readonly note?: string;
}

/* ------------------------------ Строки и метки ------------------------------ */

const MARKER_RE = /^=== (.+) ===[ \t]*$/;
/** Метка файла: имя с расширением (так различает файл и лист и разбор НМЦК). */
const FILE_NAME_RE = /\.(?:xlsx?|docx?|pdf|csv|rar|zip|7z|txt|rtf|odt|ods|xml|json)$/iu;
const CONTAINER_NAME_RE = /\.(?:rar|zip|7z)$/iu;

interface Line {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let position = 0;
  while (position <= text.length) {
    const newline = text.indexOf("\n", position);
    const end = newline < 0 ? text.length : newline;
    lines.push({ start: position, end, text: text.slice(position, end).replace(/\r$/, "") });
    if (newline < 0) break;
    position = newline + 1;
  }
  return lines;
}

function markerName(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < 6 || !trimmed.startsWith("===") || !trimmed.endsWith("===")) return null;
  const match = MARKER_RE.exec(trimmed);
  return match === null ? trimmed.slice(3, -3).trim() : (match[1] as string);
}

const isFileMarker = (name: string): boolean => FILE_NAME_RE.test(name) && !CONTAINER_NAME_RE.test(name);

/* ------------------------------ Отрезки ------------------------------ */

/**
 * Шапка сметы в начале строки: слова, по которым смету узнаёт человек. «УТВЕРЖДАЮ» и «СОГЛАСОВАНО» сюда не входят — они стоят и в шапке ТЗ.
 * Допускаются ведущие запятые и кавычки CSV.
 */
const HEADER_LINE_RE =
  /^[\s",;|]*(?:Утверждено\s+приказом\s+Минстроя|ЛОКАЛЬН\p{L}*\s+СМЕТН\p{L}*\s+РАСЧ|ОБЪЕКТН\p{L}*\s+СМЕТН\p{L}*\s+РАСЧ|Форма\s*№?\s*4б|\(локальная\s+смета\)|Smeta\.RU\s*\(|Наименование\s+программного\s+продукта)/iu;
const APPENDIX_LINE_RE = /^[\s",;|]*Приложение\s*№\s*\d/iu;

/** Начало сметы внутри отрезка, который начинается не с метки листа: строка шапки (и «Приложение № …» перед ней). null — шапки нет. */
function headerStart(text: string, from: number, to: number): number | null {
  const lines = linesOf(text.slice(from, to));
  for (const [index, line] of lines.entries()) {
    if (!HEADER_LINE_RE.test(line.text)) continue;
    const previous = lines[index - 1];
    const first = previous !== undefined && APPENDIX_LINE_RE.test(previous.text) ? previous : line;
    return from + first.start;
  }
  return null;
}

/** Строка перед `start` — метка листа или файла: отрезок сметы начинается сразу за ней; возвращает начало этой строки и имя метки. */
function markerLineBefore(text: string, start: number): { readonly lineStart: number; readonly name: string } | null {
  if (start <= 0) return null;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const name = markerName(text.slice(lineStart, start));
  return name === null ? null : { lineStart, name };
}

function labelOfEstimate(documentName: string, text: string, sheet: string | null): { kind: "LSR" | "BIM_GRID"; label: string | null } | null {
  const lsr = parseCustomerLsr([{ name: documentName, text }]).estimates[0];
  if (lsr !== undefined) {
    const number = lsr.estimateNumber ?? null;
    return { kind: "LSR", label: number !== null ? `ЛСР ${number}` : (sheet ?? lsr.estimateName) };
  }
  const bim = parseCustomerBim([{ name: documentName, text }]).estimates[0];
  if (bim !== undefined) return { kind: "BIM_GRID", label: sheet ?? bim.estimateName ?? null };
  return null;
}

/** Отрезки смет формы 421/пр: таблицы листов (ГС, Smeta.RU, ТСН, БИМ) и служебные листы Smeta.RU. */
function gridSpans(document: DocumentText, notes: Note[]): Span[] {
  const text = document.text;
  const spans: Span[] = [];

  for (const segment of splitCustomerEstimates(document)) {
    if (segment.noise) continue;
    const sheet = segment.estimate.estimateName;
    const found = labelOfEstimate(document.name, segment.text, sheet);
    if (found === null) {
      notes.push({
        start: segment.start,
        end: segment.end,
        text: `«${document.name}»${sheet === null ? "" : `, лист «${sheet}»`}: отрезок со сметными итогами не по форме 421/пр оставлен (в боевом прогоне его читала бы модель)`,
      });
      continue;
    }

    let start = segment.start;
    const marker = markerLineBefore(text, start);
    if (marker !== null && !FILE_NAME_RE.test(marker.name)) {
      // Лист xlsx: смета занимает лист целиком, от метки листа.
      start = marker.lineStart;
    } else {
      // Плоский документ (Word, PDF; в архиве — под меткой файла): перед сметой может стоять ТЗ — режем с шапки формы.
      const header = headerStart(text, start, segment.end);
      if (header !== null) {
        start = header;
      } else {
        notes.push({
          start: segment.start,
          end: segment.end,
          text:
            `«${document.name}»${marker === null ? "" : `, файл «${marker.name}»`}: шапка сметы не найдена, вырезан весь отрезок ${String(segment.end - start)} знаков ` +
            `(от ${marker === null ? (start === 0 ? "начала документа" : "итога предыдущей сметы") : "метки файла"}): текст перед сметой мог уйти вместе с ней`,
        });
        if (marker !== null) start = marker.lineStart;
      }
    }
    // Хвост за итогом (НДС, справка Smeta.RU) читает тот же разбор; без него остаются голые строки «НДС 22 %, Всего с НДС».
    spans.push({ start, end: segment.end + segment.tail.length, kind: found.kind, label: found.label });
  }

  for (const line of linesOf(text)) {
    const name = markerName(line.text);
    if (name === null || !isSmetaRuServiceSheet(name)) continue;
    const next = nextMarkerStart(text, line.end);
    spans.push({ start: line.start, end: next, kind: "SERVICE_SHEET", label: name });
  }
  return spans;
}

function nextMarkerStart(text: string, from: number): number {
  const found = /\n=== .+ ===[ \t]*(?:\n|$)/.exec(text.slice(from));
  return found === null ? text.length : from + found.index + 1;
}

/** Отрезки БИМ-потока PDF/Word. */
function streamSpans(document: DocumentText): Span[] {
  return bimStreamSpans(document.name, document.text).map((span) => ({ start: span.start, end: span.end, kind: "BIM_STREAM" as const, label: null }));
}

/** Шапка столбцов таблицы смет контракта и её итоговые строки. */
const CONTRACT_HEAD_RE = /номер\s+сметы|наименование|количеств|стоимост|цена|ед\.?\s*изм|№\s*п\/п|\(наименование|^[\s\d,;\t|"]+$|раздел\s+\d|^\s*смета\s+контракта/iu;
const CONTRACT_FOOT_RE = /^[\s",;|\t]*(?:итого|всего|сумма\s+ндс|в\s+том\s+числе|ндс)/iu;
const CONTRACT_HEAD_REACH = 10;
const CONTRACT_FOOT_REACH = 10;
const CONTRACT_GAP = 40;

/** Таблицы смет контракта: строки «ЛС … Поз.:» вместе с шапкой столбцов, итогами и строками между ними. */
function contractSpans(document: DocumentText): Span[] {
  if (!document.text.includes("Поз") || !/ЛС\s/.test(document.text)) return [];
  const lines = linesOf(document.text);
  const rows: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (!/ЛС\s/.test(line.text)) continue;
    if (parseContractEstimates([{ name: document.name, text: line.text }]).rows.length > 0) rows.push(index);
  }
  if (rows.length === 0) return [];

  const markerBetween = (from: number, to: number): boolean => {
    for (let i = from + 1; i < to; i += 1) if (markerName((lines[i] as Line).text) !== null) return true;
    return false;
  };
  const blocks: { first: number; last: number }[] = [];
  for (const row of rows) {
    const block = blocks[blocks.length - 1];
    if (block !== undefined && row - block.last <= CONTRACT_GAP && !markerBetween(block.last, row)) block.last = row;
    else blocks.push({ first: row, last: row });
  }

  return blocks.map((block) => {
    let first = block.first;
    for (let reach = 0; reach < CONTRACT_HEAD_REACH && first > 0; reach += 1) {
      const previous = (lines[first - 1] as Line).text;
      if (markerName(previous) !== null) break;
      if (previous.trim() !== "" && !CONTRACT_HEAD_RE.test(previous)) break;
      first -= 1;
    }
    let last = block.last;
    for (let reach = 0; reach < CONTRACT_FOOT_REACH && last < lines.length - 1; reach += 1) {
      const next = (lines[last + 1] as Line).text;
      if (markerName(next) !== null) break;
      if (next.trim() !== "" && !CONTRACT_FOOT_RE.test(next)) break;
      last += 1;
    }
    let table: string | null = null;
    for (let i = block.first; i >= 0; i -= 1) {
      const name = markerName((lines[i] as Line).text);
      if (name !== null) {
        table = name;
        break;
      }
    }
    return { start: (lines[first] as Line).start, end: (lines[last] as Line).end, kind: "CONTRACT_ESTIMATE" as const, label: table };
  });
}

function nmckSpans(document: DocumentText): Span[] {
  return nmckEstimateSpans(document).map((span) => ({
    start: span.start,
    end: span.end,
    kind: span.kind === "CALC" ? ("NMCK_CALC" as const) : ("NMCK_CONTRACT" as const),
    label: markerName(document.text.slice(span.start, span.end).split("\n", 1)[0] ?? ""),
  }));
}

/* ------------------------------ Вырезание ------------------------------ */

function mergeSpans(spans: readonly { readonly start: number; readonly end: number }[]): { start: number; end: number }[] {
  const sorted = spans.map((span) => ({ start: span.start, end: span.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * Режет текст по отрезкам. Метка файла, за которой не осталось ничего (до следующей метки файла, контейнера или конца текста), уходит
 * вместе с вырезанным: иначе от архива остался бы список названий файлов. Метки листов и контейнеров (`.rar`, `.zip`) не трогаются.
 */
export function cutSpans(text: string, spans: readonly { readonly start: number; readonly end: number }[]): string {
  // Отрезок, занявший строки целиком, забирает и перевод строки за собой: иначе на месте сметы остаётся пустая строка.
  const whole = spans.map((span) => ({
    start: span.start,
    end: (span.start === 0 || text[span.start - 1] === "\n") && text[span.end] === "\n" ? span.end + 1 : span.end,
  }));
  const merged = mergeSpans(whole);
  let result = "";
  let cursor = 0;
  for (const span of merged) {
    result += text.slice(cursor, span.start);
    cursor = span.end;
    // Метки файла перед вырезанным: осиротевшие уходят, если после вырезанного идёт метка файла, контейнера или конец.
    const rest = text.slice(cursor);
    const following = /^(?:[ \t]*\r?\n)*(.*)/.exec(rest);
    const nextLine = following?.[1] ?? "";
    const nextName = markerName(nextLine);
    const endsFile = rest.trim() === "" || (nextName !== null && (isFileMarker(nextName) || CONTAINER_NAME_RE.test(nextName)));
    if (endsFile) {
      for (;;) {
        const lines = result.split("\n");
        let last = lines.length - 1;
        while (last >= 0 && (lines[last] as string).trim() === "") last -= 1;
        if (last < 0) break;
        const name = markerName(lines[last] as string);
        if (name === null || !isFileMarker(name)) break;
        result = lines.slice(0, last).join("\n");
        if (last > 0) result += "\n";
      }
    }
  }
  return result + text.slice(cursor);
}

/** Знаков содержательного текста: без меток, пробелов и знаков таблицы. */
function meaningfulChars(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (markerName(line) !== null) continue;
    for (const char of line) if (/[\p{L}\p{N}]/u.test(char)) count += 1;
  }
  return count;
}

/**
 * Меньше стольки букв и цифр — от документа ничего не осталось (имя файла в первой строке, подпись листа), и он в расчёт не идёт.
 * Остаток поменьше 200 знаков не ТЗ: в нём нечего читать.
 */
const MIN_MEANINGFUL = 200;

/* ------------------------------ Проверка ------------------------------ */

/** Находят ли разборы смет заказчика что-нибудь в этих документах; по каждому документу отдельно, чтобы назвать виновника. */
export function findEstimateLeaks(documents: readonly DocumentText[]): EstimateLeak[] {
  const leaks: EstimateLeak[] = [];
  for (const document of documents) {
    const one = [{ name: document.name, text: document.text }];
    const lsr = parseCustomerLsr(one).estimates;
    if (lsr.length > 0) leaks.push({ document: document.name, detector: "LSR", detail: `форма 421/пр: ${lsr.map((estimate) => estimate.estimateNumber ?? estimate.estimateName ?? "без номера").join(", ")}` });
    const bim = parseCustomerBim(one).estimates;
    if (bim.length > 0) leaks.push({ document: document.name, detector: "BIM", detail: `БИМ-смета: ${String(bim.length)} шт.` });
    const contract = parseContractEstimates(one).rows;
    if (contract.length > 0) leaks.push({ document: document.name, detector: "CONTRACT_ESTIMATE", detail: `смета контракта: ${String(contract.length)} строк «ЛС … Поз.:»` });
    if (parseCustomerNmck(one) !== null) leaks.push({ document: document.name, detector: "NMCK", detail: "расчёт НМЦК: листы «ССР Расчёт НМЦК»" });
  }
  return leaks;
}

/** Признаки сметы, которые остались в тексте: итоговые строки и шапки формы. Не утечка (разбор не читает), но человеку полезно знать. */
const RESIDUE_RE =
  /^[\s",;|\t]*(?:ВСЕГО\s+по\s+смете|Итого\s+по\s+смете|ЛОКАЛЬН\p{L}*\s+СМЕТН\p{L}*\s+РАСЧ|ЛОКАЛЬН\p{L}*\s+СМЕТ\p{L}*\s*№|\(локальная\s+смета\)|Утверждено\s+приказом\s+Минстроя)/imu;

function residueWarnings(document: DocumentText): string[] {
  const found = new Set<string>();
  for (const line of document.text.split("\n")) {
    const match = RESIDUE_RE.exec(line);
    if (match !== null) found.add(match[0].replace(/[\s",;|\t]+/g, " ").trim().slice(0, 60));
  }
  return found.size === 0 ? [] : [`«${document.name}»: в остатке есть признаки сметы (${[...found].map((item) => `«${item}»`).join(", ")}) — разбор их не читает`];
}

/* ------------------------------ Точка входа ------------------------------ */

const MAX_PASSES = 3;

function collect(document: DocumentText, notes: Note[]): Span[] {
  return [...gridSpans(document, notes), ...streamSpans(document), ...contractSpans(document), ...nmckSpans(document)];
}

/**
 * Убирает из документов всё, что наши разборы читают как смету заказчика (см. шапку файла), и проверяет остаток.
 * Документы приходят как в расчёте: `{ name, text }`; порядок сохраняется.
 */
export function stripCustomerEstimates(documents: readonly DocumentText[]): StripResult {
  const removed: RemovedSpan[] = [];
  const warnings: string[] = [];
  const kept: StrippedDocument[] = [];
  const dropped: DroppedDocument[] = [];

  for (const document of documents) {
    let text = document.text;
    let removedChars = 0;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const notes: Note[] = [];
      const spans = collect({ name: document.name, text }, notes);
      if (pass === 0) {
        const covered = mergeSpans(spans);
        // Отрезок, который вырезал другой разбор (проект сметы контракта в «Обосновании НМЦК»), оставленным не считается.
        for (const note of notes) if (!covered.some((span) => span.start <= note.start && note.end <= span.end)) warnings.push(note.text);
      }
      if (spans.length === 0) break;
      for (const span of spans) removed.push({ document: document.name, kind: span.kind, label: span.label, chars: span.end - span.start });
      const next = cutSpans(text, spans);
      removedChars += text.length - next.length;
      text = next;
      // Остаток без смет — дальше резать нечего; иначе второй проход вырежет открывшееся.
      if (findEstimateLeaks([{ name: document.name, text }]).length === 0) break;
    }

    const leftover = meaningfulChars(text);
    if (text.trim() === "" || (text !== document.text && leftover < MIN_MEANINGFUL)) {
      dropped.push({ name: document.name, originalChars: document.text.length, leftoverChars: leftover });
      continue;
    }
    kept.push({ name: document.name, text, originalChars: document.text.length, removedChars });
    warnings.push(...residueWarnings({ name: document.name, text }));
  }

  return { documents: kept, dropped, removed, leaks: findEstimateLeaks(kept), warnings };
}
