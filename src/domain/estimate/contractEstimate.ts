import { parseNumberCell, parseLine } from "@/domain/estimate/customerEstimate";
import type { CustomerPosition } from "@/domain/estimate/customerLsr";
import { documentRank, normalizeLsrNumber, type LsrEntry } from "@/domain/estimate/customerLsrSet";
import type { RejectedBillRow } from "@/domain/estimate/billExtraction";
import type { BillOfWorkItem, CustomerPrice } from "@/domain/estimate/types";
import { baseUnitOf, isWholeWorkUnit, parseUnit } from "@/domain/estimate/units";

/**
 * «Смета контракта» по форме приказа 841/пр: чтение и сверка с локальными сметами заказчика.
 *
 * Что это за документ. К проекту контракта и к обоснованию НМЦК заказчик прикладывает смету
 * контракта: «№ | Номер сметы | Наименование конструктивных решений, комплексов (видов) работ,
 * оборудования | Ед. | Количество | Цена | Стоимость». Строка — укрупнённая позиция вида
 * «1 | ЛС 02-02-07 Поз.: 3-3.2 | Монтаж водонагревателей… | шт | 1»: в ней нет шифров расценок,
 * ресурсов и оборудования, а под «Поз.: 3-3.2» стоят три позиции локальной сметы 02-02-07.
 * Это производная таблица: настоящие объёмы лежат в ЛСР, а смета контракта — их свод для оплаты
 * по этапам. Ведомостью объёмов она не является.
 *
 * Что с ней делается.
 * 1. Нет ни ведомости, ни ЛСР — смета контракта становится источником объёмов (уровень
 *    `CONTRACT_ESTIMATE`), и расчёт честно говорит, что держится на допущении: позиции укрупнены.
 * 2. Есть ЛСР — смета контракта служит сверкой: «Поз.: 3-3.2» раскрывается в позиции ЛСР, и видно,
 *    все ли строки контракта покрыты, где объём не сходится и какие позиции ЛСР в контракт не вошли.
 *
 * Читается кодом: строка узнаётся по «ЛС … Поз.:», таблица — табуляцией (Word), запятыми (xlsx)
 * или вертикальной чертой. Модель не нужна, и ответ не обрезается.
 */

/** Ссылка на позиции ЛСР: «3», диапазон «3-3.2» или «13-15». */
export interface ContractRef {
  readonly from: string;
  readonly to: string;
}

export interface ContractEstimateRow {
  /** № п/п строки таблицы. */
  readonly number: number;
  /** Номер ЛСР из графы «Номер сметы»: «02-02-07»; «БН» — смета без номера. */
  readonly estimateRef: string;
  /** Позиции ЛСР как напечатаны: «1, 1.1», «3-3.2». */
  readonly positionsText: string;
  readonly refs: readonly ContractRef[];
  readonly name: string;
  readonly unit: string;
  readonly quantity: number | null;
  readonly unitPrice: number | null;
  readonly total: number | null;
  /** Заголовок раздела таблицы («Раздел 1. Сантехнические работы»). */
  readonly section: string | null;
  /** Документ и, для архива, файл или лист внутри него. */
  readonly document: string;
  readonly table: string | null;
}

export interface ContractEstimateParse {
  readonly rows: readonly ContractEstimateRow[];
  /** Документы, в которых найдены строки. */
  readonly documents: readonly string[];
  /** Повторы той же строки в другом документе (в проекте контракта и в обосновании): взяты один раз. */
  readonly duplicates: number;
}

const REF_CELL = /^\s*ЛС\s+(\S+)\s+Поз(?:иции|\.)?\s*:?\s*(.*)$/isu;
/** Строка ссылается на позиции ЛС: ей хватает этого признака, чтобы документ считался производным от ЛСР. */
export const LSR_REFERENCE = /(?<![\p{L}\d])ЛС\s*[\dБН№][^\n|\t]{0,40}?Поз(?:иции|\.)/giu;

const HAS_LSR_REFERENCE = /(?<![\p{L}\d])ЛС\s*[\dБН№][^\n|\t]{0,40}?Поз(?:иции|\.)/iu;

/** В строке есть ссылка на позиции локальной сметы: «ЛС 02-02-07 Поз.: 3-3.2». */
export function referencesLsr(line: string): boolean {
  return HAS_LSR_REFERENCE.test(line);
}

/** Сколько строк со ссылкой «ЛС … Поз.:» в тексте (до `limit`, чтобы не читать мегабайт ради счёта). */
export function countLsReferences(text: string, limit = 50): number {
  let count = 0;
  for (const _match of text.matchAll(LSR_REFERENCE)) {
    count += 1;
    if (count >= limit) break;
  }
  return count;
}

/** Метка листа или файла: «=== имя ===» отдельной строкой. */
const ENTRY_MARK = /^=== (.+) ===[ \t]*$/;
const SECTION_LINE = /^\s*(?:раздел\s+\d+[.:]?|подраздел\s+\d+[.:]?)/iu;

function splitCells(line: string): { cells: string[]; delimiter: string } | null {
  if (line.includes("\t")) return { cells: line.split("\t"), delimiter: ";" };
  if (line.includes(" | ")) return { cells: line.split(" | "), delimiter: ";" };
  const parsed = parseLine(line, true);
  return parsed.csv ? { cells: [...parsed.cells], delimiter: parsed.delimiter } : null;
}

/** Метка позиции ЛСР: «3», «3.1» — без пробелов и хвостовых точек. */
function labelOf(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/[.,;]+$/g, "");
}

/** «1, 1.1» → [1, 1.1]; «3-3.2» → [3…3.2]; «13-15» → [13…15]. Пустая или нечитаемая ссылка — пустой список. */
export function parseRefs(text: string): ContractRef[] {
  const refs: ContractRef[] = [];
  for (const part of text.split(/[;,]/)) {
    const token = part.replace(/[–—−]/g, "-").replace(/\s+/g, "");
    if (token === "") continue;
    const range = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(token);
    if (range !== null) {
      refs.push({ from: labelOf(range[1] as string), to: labelOf(range[2] as string) });
      continue;
    }
    if (/^\d+(?:\.\d+)?$/.test(token)) refs.push({ from: token, to: token });
  }
  return refs;
}

function isNumeric(cell: string | undefined, delimiter: string): boolean {
  return cell !== undefined && cell.trim() !== "" && parseNumberCell(cell.trim(), delimiter) !== null;
}

function rowOf(
  line: string,
  context: { document: string; table: string | null; section: string | null },
): ContractEstimateRow | null {
  const split = splitCells(line);
  if (split === null) return null;
  const { cells, delimiter } = split;
  const refIndex = cells.findIndex((cell) => REF_CELL.test(cell));
  if (refIndex < 0) return null;
  const ref = REF_CELL.exec(cells[refIndex] as string) as RegExpExecArray;

  const numberCell = cells.slice(0, refIndex).find((cell) => cell.trim() !== "");
  if (numberCell === undefined || !/^\d{1,4}$/.test(numberCell.trim())) return null;

  // После ссылки: наименование, единица, количество, цена, стоимость; дальше в xlsx идут копии подписей.
  const rest = cells.slice(refIndex + 1).map((cell) => cell.replace(/\s+/g, " ").trim()).filter((cell) => cell !== "");
  const name = rest[0];
  if (name === undefined || !/\p{L}/u.test(name)) return null;
  let at = 1;
  let unit = "";
  if (rest[at] !== undefined && !isNumeric(rest[at], delimiter)) {
    unit = rest[at] as string;
    at += 1;
  }
  const take = (): number | null => {
    const cell = rest[at];
    if (cell === undefined || !isNumeric(cell, delimiter)) return null;
    at += 1;
    return parseNumberCell(cell, delimiter);
  };
  const quantity = take();
  const unitPrice = take();
  const total = take();

  const positionsText = (ref[2] as string).replace(/\s+/g, " ").trim();
  return {
    number: Number.parseInt(numberCell.trim(), 10),
    estimateRef: (ref[1] as string).trim(),
    positionsText,
    refs: parseRefs(positionsText),
    name,
    unit,
    quantity,
    unitPrice,
    total,
    section: context.section,
    document: context.document,
    table: context.table,
  };
}

function rowKey(row: ContractEstimateRow): string {
  const name = row.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `${normalizeLsrNumber(row.estimateRef) ?? row.estimateRef}|${row.positionsText.replace(/\s+/g, "")}|${name}|${String(row.quantity)}`;
}

/** Строки смет контракта из текстов документов; повтор в другом документе берётся один раз. */
export function parseContractEstimates(documents: readonly { readonly name: string; readonly text: string }[]): ContractEstimateParse {
  const byKey = new Map<string, ContractEstimateRow>();
  const order: string[] = [];
  let duplicates = 0;

  for (const document of documents) {
    if (!document.text.includes("Поз") || !/ЛС\s/.test(document.text)) continue;
    let table: string | null = null;
    let section: string | null = null;
    for (const raw of document.text.split("\n")) {
      const line = raw.replace(/\r$/, "");
      const mark = ENTRY_MARK.exec(line.trim());
      if (mark !== null) {
        table = mark[1] as string;
        section = null;
        continue;
      }
      if (line.trim() === "") continue;
      if (SECTION_LINE.test(line.trim())) {
        section = (line.split(/[\t,]/)[0] ?? line).replace(/\s+/g, " ").trim();
        continue;
      }
      if (!/ЛС\s/.test(line)) continue;
      const row = rowOf(line, { document: document.name, table, section });
      if (row === null) continue;
      const key = rowKey(row);
      const known = byKey.get(key);
      if (known === undefined) {
        byKey.set(key, row);
        order.push(key);
        continue;
      }
      duplicates += 1;
      // Из двух копий остаётся та, где есть цены, затем та, что из документа повесомее.
      const better =
        (row.total !== null && known.total === null) ||
        (row.total !== null === (known.total !== null) && documentRank(row.document) < documentRank(known.document));
      if (better) byKey.set(key, row);
    }
  }

  const rows = order.map((key) => byKey.get(key) as ContractEstimateRow);
  const names: string[] = [];
  for (const row of rows) if (!names.includes(row.document)) names.push(row.document);
  return { rows, documents: names, duplicates };
}

/* ------------------------------ Сверка с ЛСР ------------------------------ */

export type ContractRowStatus =
  /** Все позиции, на которые ссылается строка, есть в ЛСР. */
  | "COVERED"
  /** ЛСР с таким номером в документации нет. */
  | "NO_ESTIMATE"
  /** ЛСР есть, но части позиций из ссылки в ней нет. */
  | "MISSING_POSITIONS"
  /** «ЛС БН» или ссылка не читается: сопоставить не с чем. */
  | "NO_REFERENCE";

export interface ContractRowCheck {
  readonly row: ContractEstimateRow;
  readonly status: ContractRowStatus;
  /** Ключ ЛСР, с которой сопоставлена строка. */
  readonly estimateKey: string | null;
  /** Метки позиций ЛСР, на которые раскрылась ссылка. */
  readonly positions: readonly string[];
  /** Метки из ссылки, которых нет в ЛСР. */
  readonly missing: readonly string[];
  /** Объём строки контракта и первой позиции ЛСР расходятся; null — сошлись или несравнимы по единице. */
  readonly volumeNote: string | null;
  /** Стоимость строки контракта и сумма позиций ЛСР расходятся; null — сошлись или цены в строке нет. */
  readonly amountNote: string | null;
}

export interface ContractCheck {
  readonly rows: readonly ContractRowCheck[];
  readonly covered: number;
  readonly total: number;
  /** Позиции ЛСР (по метке), которых нет ни в одной строке контракта, по сметам, которые контракт упоминает. */
  readonly uncoveredPositions: readonly { readonly estimateKey: string; readonly estimate: string; readonly labels: readonly string[] }[];
  /** Готовые фразы для карточки и отчёта. */
  readonly messages: readonly string[];
}

function minorOf(label: string): number {
  const match = /^\d+\.(\d+)$/.exec(label);
  return match === null ? 0 : Number.parseInt(match[1] as string, 10);
}

function majorOf(label: string): number {
  return Number.parseInt(label.split(".")[0] as string, 10);
}

/** Порядковый ключ метки: «3» → 3.0, «3.2» → 3.002. */
function orderKey(label: string): number {
  return majorOf(label) + minorOf(label) / 1000;
}

/**
 * Метки позиций ЛСР, на которые раскрывается ссылка. Диапазон «3-3.2» — позиция 3 и её подпозиции до 3.2;
 * «13-15» — позиции 13…15 вместе с их подпозициями: подпозиция 15.1 принадлежит позиции 15.
 * Метки отсутствующих позиций — в `missing`, но не как «нет»: диапазон считается покрытым, если крайние метки есть.
 */
export function expandRefs(
  refs: readonly ContractRef[],
  labels: readonly string[],
): { found: string[]; missing: string[] } {
  const sorted = [...labels].sort((a, b) => orderKey(a) - orderKey(b));
  const have = new Set(labels);
  const found = new Set<string>();
  const missing: string[] = [];
  for (const ref of refs) {
    if (ref.from === ref.to) {
      if (have.has(ref.from)) found.add(ref.from);
      else missing.push(ref.from);
      continue;
    }
    if (!have.has(ref.from)) missing.push(ref.from);
    if (!have.has(ref.to)) missing.push(ref.to);
    const low = orderKey(ref.from);
    // Конец диапазона — основная позиция: в него входят и её подпозиции.
    const high = ref.to.includes(".") ? orderKey(ref.to) : majorOf(ref.to) + 0.999;
    for (const label of sorted) {
      const key = orderKey(label);
      if (key >= low - 1e-9 && key <= high + 1e-9) found.add(label);
    }
  }
  return { found: [...found], missing };
}

function labelOfPosition(position: CustomerPosition): string {
  return position.label ?? String(position.number);
}

function positionsOf(entry: LsrEntry): CustomerPosition[] {
  return [...entry.estimate.positions, ...(entry.estimate.subPositions ?? [])];
}

const formatNumber = (value: number): string => String(Math.round(value * 1e4) / 1e4).replace(".", ",");

/** Объём в основной единице: «8 шт» и «0,08 × 100 шт» сходятся. */
function baseQuantity(quantity: number, unit: string): { quantity: number; unit: string } | null {
  const parsed = parseUnit(unit);
  if (parsed === null) return null;
  const base = baseUnitOf(parsed.unit);
  return base === null ? null : { quantity: quantity * parsed.multiplier, unit: base };
}

const VOLUME_TOLERANCE = 0.02;
/** Цена контракта и сумма позиций ЛСР округляются по-разному (индексы, заготовительно-складские): 5 % — это уже расхождение. */
const AMOUNT_TOLERANCE = 0.05;

function checkRow(row: ContractEstimateRow, entries: readonly LsrEntry[]): ContractRowCheck {
  const empty = { positions: [], missing: [], volumeNote: null, amountNote: null } as const;
  if (normalizeLsrNumber(row.estimateRef) === "БН" || row.refs.length === 0) {
    return { row, status: "NO_REFERENCE", estimateKey: null, ...empty };
  }
  const number = normalizeLsrNumber(row.estimateRef);
  const candidates = entries.filter((entry) => normalizeLsrNumber(entry.number) === number);
  if (candidates.length === 0) return { row, status: "NO_ESTIMATE", estimateKey: null, ...empty };

  // Номер у нескольких смет (варианты): подходит та, где нашлись все позиции.
  let chosen: { entry: LsrEntry; found: string[]; missing: string[] } | null = null;
  for (const entry of candidates) {
    const expanded = expandRefs(row.refs, positionsOf(entry).map(labelOfPosition));
    if (chosen === null || expanded.missing.length < chosen.missing.length) chosen = { entry, ...expanded };
    if (expanded.missing.length === 0) break;
  }
  const { entry, found, missing } = chosen as { entry: LsrEntry; found: string[]; missing: string[] };
  if (missing.length > 0) {
    return { row, status: "MISSING_POSITIONS", estimateKey: entry.key, positions: found, missing, volumeNote: null, amountNote: null };
  }

  const byLabel = new Map(positionsOf(entry).map((position) => [labelOfPosition(position), position] as const));
  let volumeNote: string | null = null;
  const lead = byLabel.get(row.refs[0]?.from ?? "");
  if (lead !== undefined && row.quantity !== null && lead.quantity !== null && row.unit !== "") {
    const ours = baseQuantity(row.quantity, row.unit);
    const theirs = baseQuantity(lead.quantity, lead.unit);
    if (ours !== null && theirs !== null && ours.unit === theirs.unit && theirs.quantity > 0) {
      const diff = Math.abs(ours.quantity - theirs.quantity) / theirs.quantity;
      if (diff > VOLUME_TOLERANCE) {
        volumeNote = `в смете контракта ${formatNumber(ours.quantity)} ${ours.unit}, в ЛСР (поз. ${labelOfPosition(lead)}) ${formatNumber(theirs.quantity)} ${theirs.unit}`;
      }
    }
  }

  let amountNote: string | null = null;
  if (row.total !== null && row.total > 0) {
    let sum = 0;
    for (const label of found) sum += byLabel.get(label)?.total ?? 0;
    if (sum > 0 && Math.abs(row.total - sum) / sum > AMOUNT_TOLERANCE) {
      amountNote = `в смете контракта ${formatNumber(row.total)} ₽, по позициям ЛСР ${formatNumber(Math.round(sum * 100) / 100)} ₽`;
    }
  }
  return { row, status: "COVERED", estimateKey: entry.key, positions: found, missing: [], volumeNote, amountNote };
}

const MAX_LISTED = 8;

/**
 * Сверка сметы контракта с ЛСР: покрыты ли все строки, сходятся ли объёмы, какие позиции ЛСР в контракт не вошли.
 * Без ЛСР сверять не с чем — вызывающий код её не зовёт.
 */
export function checkContractAgainstLsr(rows: readonly ContractEstimateRow[], entries: readonly LsrEntry[]): ContractCheck {
  const checks = rows.map((row) => checkRow(row, entries));
  const covered = checks.filter((check) => check.status === "COVERED").length;

  // Позиции ЛСР, не названные ни одной строкой контракта; только у смет, которые контракт упоминает.
  const referenced = new Map<string, Set<string>>();
  for (const check of checks) {
    if (check.estimateKey === null) continue;
    const set = referenced.get(check.estimateKey) ?? new Set<string>();
    for (const label of check.positions) set.add(label);
    referenced.set(check.estimateKey, set);
  }
  const uncoveredPositions: { estimateKey: string; estimate: string; labels: string[] }[] = [];
  for (const entry of entries) {
    const set = referenced.get(entry.key);
    if (set === undefined) continue;
    const labels = positionsOf(entry)
      .map(labelOfPosition)
      .filter((label) => !set.has(label));
    if (labels.length > 0) {
      uncoveredPositions.push({ estimateKey: entry.key, estimate: entry.number === null ? entry.sectionTitle : `ЛСР ${entry.number}`, labels });
    }
  }

  const messages: string[] = [];
  const total = checks.length;
  if (total > 0) {
    const noEstimate = checks.filter((check) => check.status === "NO_ESTIMATE");
    const missing = checks.filter((check) => check.status === "MISSING_POSITIONS");
    const noRef = checks.filter((check) => check.status === "NO_REFERENCE");
    if (covered === total) {
      messages.push(`Смета контракта: все ${String(total)} позиций покрыты позициями ЛСР`);
    } else {
      messages.push(`Смета контракта: покрыто позициями ЛСР ${String(covered)} из ${String(total)}`);
    }
    const listed = (items: readonly ContractRowCheck[], describe: (check: ContractRowCheck) => string): string => {
      const shown = items.slice(0, MAX_LISTED).map(describe).join("; ");
      return items.length > MAX_LISTED ? `${shown}; и ещё ${String(items.length - MAX_LISTED)}` : shown;
    };
    if (noEstimate.length > 0) {
      messages.push(
        `Нет ЛСР для строк контракта: ${listed(noEstimate, (check) => `№ ${String(check.row.number)} (ЛС ${check.row.estimateRef} Поз.: ${check.row.positionsText})`)}`,
      );
    }
    if (missing.length > 0) {
      messages.push(
        `Позиций из ссылки нет в ЛСР: ${listed(missing, (check) => `№ ${String(check.row.number)} (ЛС ${check.row.estimateRef}): ${check.missing.join(", ")}`)}`,
      );
    }
    if (noRef.length > 0) {
      messages.push(
        `Строки без номера ЛС, сопоставить не с чем: ${listed(noRef, (check) => `№ ${String(check.row.number)} «${check.row.name.slice(0, 60)}»`)}`,
      );
    }
    const volume = checks.filter((check) => check.volumeNote !== null);
    if (volume.length > 0) {
      messages.push(
        `Объём расходится с ЛСР: ${listed(volume, (check) => `№ ${String(check.row.number)} «${check.row.name.slice(0, 50)}»: ${check.volumeNote as string}`)}`,
      );
    }
    const amount = checks.filter((check) => check.amountNote !== null);
    if (amount.length > 0) {
      messages.push(
        `Стоимость расходится с ЛСР: ${listed(amount, (check) => `№ ${String(check.row.number)}: ${check.amountNote as string}`)}`,
      );
    }
    for (const item of uncoveredPositions) {
      messages.push(`${item.estimate}: позиции ${item.labels.slice(0, MAX_LISTED).join(", ")}${item.labels.length > MAX_LISTED ? "…" : ""} в смету контракта не вошли`);
    }
  }
  return { rows: checks, covered, total, uncoveredPositions, messages };
}


/* --------------------- Ведомость из сметы контракта (без ЛСР) --------------------- */

export interface ContractBill {
  /** Позиции по документам: раздел нашей сметы — документ, как у строк модели. */
  readonly sections: readonly { readonly title: string; readonly document: string; readonly items: readonly BillOfWorkItem[] }[];
  readonly rejected: readonly RejectedBillRow[];
}

/** Цена строки контракта: сумма и цена за единицу в одной единице с объёмом; null — цен в строке нет. */
function contractPrice(row: ContractEstimateRow, quantity: number, unit: string): CustomerPrice | null {
  if (row.total === null || !(row.total > 0) || !(quantity > 0)) return null;
  const consistent =
    row.unitPrice !== null &&
    row.quantity !== null &&
    Math.abs(row.unitPrice * row.quantity - row.total) <= Math.max(0.02, row.total * 0.005);
  return { total: row.total, unitPrice: row.total / quantity, unit, origin: consistent ? "LINE" : "POSITION_TOTAL", document: row.document };
}

/**
 * Позиции для расчёта из строк сметы контракта — на случай, когда нет ни ведомости, ни ЛСР.
 * Строка идёт в подбор расценки по наименованию, как строка ТЗ; цена контракта (если в строке она есть) —
 * запасная. Объём «1 комплекс» без цены расчёту не годится и называется отказом, а не пропадает молча.
 */
export function contractBill(rows: readonly ContractEstimateRow[]): ContractBill {
  const byDocument = new Map<string, BillOfWorkItem[]>();
  const rejected: RejectedBillRow[] = [];
  for (const [index, row] of rows.entries()) {
    const reject = (reason: RejectedBillRow["reason"], message: string): void => {
      rejected.push({
        reason,
        row: { workName: row.name, quantity: row.quantity ?? "", unit: row.unit, evidenceQuote: quoteOf(row) },
        message: `«${row.name}»: ${message}`,
        documentName: row.document,
      });
    };
    if (row.quantity === null || !(row.quantity > 0)) {
      reject("BAD_QUANTITY", "в строке сметы контракта нет объёма");
      continue;
    }
    const parsed = parseUnit(row.unit);
    const whole = isWholeWorkUnit(row.unit) || /^компл/i.test(row.unit.trim());
    // Единица, которой нет в таблице единиц («сеть», «комплекс»), остаётся как напечатана — как у позиций ЛСР:
    // расценка с той же единицей посчитает её, а не совпала — расчёт назовёт расхождение.
    if (parsed === null && !whole && row.unit.trim() === "") {
      reject("UNKNOWN_UNIT", "в строке сметы контракта нет единицы измерения");
      continue;
    }
    const quantity = parsed === null ? row.quantity : row.quantity * parsed.multiplier;
    const unit = parsed === null ? row.unit : parsed.unit;
    const price = contractPrice(row, quantity, unit);
    if (whole && row.quantity === 1 && price === null) {
      reject("WHOLE_WORK", "объём задан всей работой (1 комплекс) — нужна разбивка по позициям");
      continue;
    }
    const items = byDocument.get(row.document) ?? [];
    items.push({
      id: `k${String(index + 1)}-${String(row.number)}`,
      workName: row.name,
      quantity,
      quantityUnit: unit,
      unitDivisor: 1,
      normCode: null,
      normBaseType: null,
      resourceCode: null,
      sourceQuote: quoteOf(row),
      sourceDocument: row.document,
      billSection: row.section,
      sourceLevel: "CONTRACT_ESTIMATE",
      positionNumber: String(row.number),
      normCodeHint: null,
      ...(price === null ? {} : { customerPrice: price }),
    });
    byDocument.set(row.document, items);
  }
  return {
    sections: [...byDocument.entries()].map(([document, items]) => ({ title: document, document, items })),
    rejected,
  };
}

function quoteOf(row: ContractEstimateRow): string {
  return `${String(row.number)} ЛС ${row.estimateRef} Поз.: ${row.positionsText} ${row.name} ${row.unit} ${row.quantity === null ? "" : formatNumber(row.quantity)}`.replace(/\s+/g, " ").trim();
}
