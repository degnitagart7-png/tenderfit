import type { GeneratedStats } from "../src/domain/estimate/generatedItems";
import type { NormPickStats } from "../src/domain/estimate/normPick";
import type { BillOfWorkSection, EstimateDocument, EstimateGapKind, EstimateMethod, GeneratedKind } from "../src/domain/estimate/types";
import type { BillRowInfo } from "../src/domain/estimate/billReview";
import { cell, fmtInt, fmtPercent, fmtRub, table } from "./estimate-benchmark.lib";
import { formatAiMaterialsSection, type AiMaterialRow } from "./estimate-benchmark.materials.lib";

/**
 * Чистые помощники режима `--estimate-only` скрипта `scripts/estimate-benchmark.ts`: закупки БЕЗ сметы заказчика, эталона нет.
 * Отчёт по закупке (статус, зона, источник объёмов, токены, строки по источнику цены, пробелы, итог и отношение к НМЦК, главные строки по рублям,
 * добавленные расчётом строки) и сводка `summary.md`. Без диска, сети и базы — как `estimate-benchmark.lib.ts`; расчёт зовёт сам скрипт.
 */

/** Метка расхода модели в `llm_usage_log.job_id`: по ней отчёт о расходах отделяет прогоны бенчмарка от боевых. */
export const E2E_JOB_PREFIX = "bench-e2e:";

/** Метка задания для закупки: не длиннее 64 знаков (предел ручки `/api/estimate/bill-rows`). */
export function e2eJobId(regNumber: string): string {
  return `${E2E_JOB_PREFIX}${regNumber}`.slice(0, 64);
}

/* ------------------------------ Статус и отчёт ------------------------------ */

/**
 * - `OK` — расчёт выполнен, строки в смете есть;
 * - `NO_VOLUMES` — расчёт выполнен, но объёмов нет ни в одном документе или в смете нет строк;
 * - `NO_DOCUMENTS` — у закупки нет документов с текстом;
 * - `NO_ZONE` — ценовая зона не определена или не собрана на этой машине;
 * - `ERROR` — ошибка расчёта.
 */
export type EstimateOnlyStatus = "OK" | "NO_VOLUMES" | "NO_DOCUMENTS" | "NO_ZONE" | "ERROR";

/** Откуда цена строки (взаимоисключающе; порядок проверки — `priceSourceOf`). */
export type PriceSourceBucket = "generated" | "service" | "customerPrice" | "ownPrice" | "resource" | "aiNorm" | "norm";

export const PRICE_SOURCE_LABELS: Readonly<Record<PriceSourceBucket, string>> = {
  norm: "по норме (шифр или наименование)",
  aiNorm: "по норме, выбранной ИИ-сметчиком",
  resource: "по ресурсу справочника цен (материал, оборудование)",
  customerPrice: "по цене заказчика",
  ownPrice: "по цене, названной человеком",
  service: "по сметной цене услуги ФГИС ЦС (перевозка, погрузка)",
  generated: "строка добавлена расчётом (мусор, работы по технологии ИИ)",
};

export const PRICE_SOURCE_ORDER: readonly PriceSourceBucket[] = ["norm", "aiNorm", "resource", "customerPrice", "ownPrice", "service", "generated"];

export type LinesBySource = Readonly<Record<PriceSourceBucket, number>>;

export const EMPTY_LINES_BY_SOURCE: LinesBySource = { norm: 0, aiNorm: 0, resource: 0, customerPrice: 0, ownPrice: 0, service: 0, generated: 0 };

export interface TopLine {
  readonly name: string;
  /** «ГЭСН 08-07-001-02»; у строки без нормы — код услуги или «—». */
  readonly norm: string;
  readonly quantity: number;
  readonly unit: string;
  /** Стоимость строки без НДС (прямые затраты + НР + СП), ₽. */
  readonly total: number;
  /** Доля строки в стоимости СМР, %. */
  readonly sharePercent: number | null;
  /** Как выбрана норма (CODE, NAME, AI, MANUAL, NONE) и откуда цена (`PriceSourceBucket`). */
  readonly basis: string;
  readonly priceSource: PriceSourceBucket;
  /** Пояснение: откуда добавлена строка, откуда цена, почему «проверьте». */
  readonly note: string | null;
  readonly sourceDocument: string | null;
}

export interface GeneratedRow {
  readonly kind: GeneratedKind;
  readonly name: string;
  readonly quantity: number;
  readonly unit: string;
  /** null — строка добавлена, но в смету не попала (цены нет). */
  readonly total: number | null;
  readonly norm: string | null;
  readonly note: string | null;
  /** Почему нет цены. */
  readonly unpricedReason: string | null;
}

export type NmckSource = "tenders.price" | "document";

export interface Nmck {
  /** НМЦК, ₽ (обычно с НДС: так её публикует заказчик). */
  readonly value: number;
  readonly source: NmckSource;
  /** Откуда прочитано: документ и дословная фраза; у `tenders.price` — null. */
  readonly quote: string | null;
}

export interface EstimateOnlyTotals {
  /** Стоимость СМР без НДС (до зимнего удорожания и временных зданий). */
  readonly workCost: number;
  readonly beforeVat: number;
  readonly vat: number;
  /** Итог с НДС. */
  readonly total: number;
}

export interface EstimateOnlyReport {
  readonly tenderId: string;
  readonly regNumber: string | null;
  readonly status: EstimateOnlyStatus;
  readonly message: string | null;
  /** Пометки прогона: смета заказчика всё же нашлась, регион взят из документов и т. п. */
  readonly notes: readonly string[];
  readonly zone: { readonly priceZoneId: number; readonly zoneName: string; readonly basis: string; readonly matched: string | null } | null;
  readonly zoneNotes: readonly string[];
  readonly method: EstimateMethod | null;
  readonly period: string | null;
  /** Источник объёмов: уровень (BILL, CUSTOMER_ESTIMATE, CONTRACT_ESTIMATE, SPEC), пояснение и документы. */
  readonly volumeLevel: string | null;
  readonly volumeNote: string | null;
  readonly volumeDocuments: readonly string[];
  readonly tokens: { readonly bill: number; readonly normPick: number; readonly implied: number; readonly total: number } | null;
  readonly modelCalls: number;
  readonly billItems: number | null;
  readonly rejected: number | null;
  readonly documentsWithoutBill: readonly string[];
  readonly duplicateDocuments: readonly { readonly name: string; readonly duplicateOf: string }[];
  readonly pricedLines: number | null;
  readonly linesBySource: LinesBySource | null;
  readonly gapCounts: Readonly<Partial<Record<EstimateGapKind, number>>>;
  readonly totals: EstimateOnlyTotals | null;
  readonly nmck: Nmck | null;
  /** Наш итог с НДС / НМЦК. null — НМЦК не нашлась или расчёта нет. */
  readonly ratioToNmck: number | null;
  readonly topLines: readonly TopLine[];
  readonly generatedRows: readonly GeneratedRow[];
  readonly normPick: NormPickStats | null;
  /** Материалы, подобранные ИИ (или кодом по наименованию), по нашим строкам: ресурс нормы → ресурс справочника, расход, цена, сумма, обоснование, уверенность. */
  readonly aiMaterials: readonly AiMaterialRow[];
  readonly generated: GeneratedStats | null;
  readonly durationMs: number;
}

/* ------------------------------ Источник цены строки ------------------------------ */

interface LineLike {
  readonly itemId: string;
  readonly normBaseType: string;
  readonly normCode: string;
  readonly normName: string;
  readonly normUnit: string;
  readonly quantity: number;
  readonly billQuantity: number;
  readonly billUnit: string;
  readonly directCost: number;
  readonly overheadCost: number;
  readonly profitCost: number;
  readonly sourceDocument: string | null;
  readonly priceSource?: "CUSTOMER_PRICE" | "FGIS_SERVICE" | "OWN_PRICE";
  readonly priceNote?: string;
}

interface ItemLike {
  readonly id: string;
  readonly workName: string;
  readonly quantity: number;
  readonly quantityUnit: string;
  readonly resourceCode: string | null;
  readonly generated?: GeneratedKind;
  readonly generatedNote?: string;
  readonly generatedUnpricedReason?: string;
}

/**
 * Откуда цена строки. Порядок: добавлена расчётом → услуга ФГИС ЦС → цена заказчика → цена человека → ресурс справочника → норма ИИ-сметчика → норма.
 * Один источник на строку: суммы по источникам дают число строк сметы.
 */
export function priceSourceOf(line: Pick<LineLike, "priceSource">, item: Pick<ItemLike, "generated" | "resourceCode"> | undefined, info: Pick<BillRowInfo, "basis"> | undefined): PriceSourceBucket {
  if (item?.generated !== undefined) return "generated";
  if (line.priceSource === "FGIS_SERVICE") return "service";
  if (line.priceSource === "CUSTOMER_PRICE") return "customerPrice";
  if (line.priceSource === "OWN_PRICE") return "ownPrice";
  if (item !== undefined && item.resourceCode !== null) return "resource";
  if (info?.basis === "AI") return "aiNorm";
  return "norm";
}

const lineTotal = (line: Pick<LineLike, "directCost" | "overheadCost" | "profitCost">): number => Math.round((line.directCost + line.overheadCost + line.profitCost) * 100) / 100;

function normLabel(line: Pick<LineLike, "normBaseType" | "normCode">): string {
  const code = line.normCode.trim();
  if (code === "") return "—";
  return `${line.normBaseType} ${code}`.trim();
}

export interface EstimateLike {
  readonly document: Pick<EstimateDocument, "sections" | "totals">;
  readonly bill: { readonly sections: readonly BillOfWorkSection[]; readonly rows: readonly Pick<BillRowInfo, "itemId" | "basis" | "reviewReason">[] };
}

export interface LinesSummary {
  readonly pricedLines: number;
  readonly linesBySource: LinesBySource;
  readonly topLines: readonly TopLine[];
  readonly generatedRows: readonly GeneratedRow[];
}

/** Строки сметы по источнику цены, главные строки по рублям и добавленные расчётом строки (в том числе не попавшие в смету). */
export function summarizeLines(estimate: EstimateLike, topN = 15): LinesSummary {
  const items = new Map<string, ItemLike>();
  for (const section of estimate.bill.sections) for (const item of section.items) items.set(item.id, item);
  const infos = new Map(estimate.bill.rows.map((row) => [row.itemId, row] as const));

  const counts: Record<PriceSourceBucket, number> = { ...EMPTY_LINES_BY_SOURCE };
  const lines: { line: LineLike; item: ItemLike | undefined; source: PriceSourceBucket; total: number }[] = [];
  for (const section of estimate.document.sections) {
    for (const line of section.lines as readonly LineLike[]) {
      const item = items.get(line.itemId);
      const source = priceSourceOf(line, item, infos.get(line.itemId));
      counts[source] += 1;
      lines.push({ line, item, source, total: lineTotal(line) });
    }
  }

  const workCost = estimate.document.totals.workCost;
  const top = [...lines]
    .sort((a, b) => b.total - a.total)
    .slice(0, topN)
    .map(({ line, item, source, total }): TopLine => {
      const info = infos.get(line.itemId);
      const note = item?.generatedNote ?? line.priceNote ?? info?.reviewReason ?? null;
      return {
        name: item?.workName ?? line.normName,
        norm: normLabel(line),
        quantity: line.billQuantity,
        unit: line.billUnit,
        total,
        sharePercent: workCost > 0 ? Math.round((total / workCost) * 10000) / 100 : null,
        basis: `${info?.basis ?? "—"} / ${source}`,
        priceSource: source,
        note: note === null ? null : note.replace(/\s+/g, " ").trim().slice(0, 300),
        sourceDocument: line.sourceDocument,
      };
    });

  const priced = new Map(lines.map((entry) => [entry.line.itemId, entry] as const));
  const generatedRows: GeneratedRow[] = [];
  for (const section of estimate.bill.sections) {
    for (const item of section.items) {
      if (item.generated === undefined) continue;
      const entry = priced.get(item.id);
      generatedRows.push({
        kind: item.generated,
        name: item.workName,
        quantity: item.quantity,
        unit: item.quantityUnit,
        total: entry === undefined ? null : entry.total,
        norm: entry === undefined ? null : normLabel(entry.line),
        note: item.generatedNote === undefined ? null : item.generatedNote.replace(/\s+/g, " ").trim().slice(0, 300),
        unpricedReason: entry === undefined ? (item.generatedUnpricedReason ?? "строка не вошла в смету") : null,
      });
    }
  }

  return { pricedLines: lines.length, linesBySource: counts, topLines: top, generatedRows };
}

/* ------------------------------ НМЦК ------------------------------ */

const NMCK_LABEL = /начальн\p{L}*\s*\(\s*максимальн\p{L}*\s*\)\s*цен\p{L}*(?:\s+(?:контракта|договора|единицы|лота|закупки))?|(?<![\p{L}])нмцк?(?![\p{L}])/giu;

/** Сколько знаков после подписи читается как значение. */
const NMCK_WINDOW = 200;

/** Число с пробелами-разрядами и десятичной частью: «12 345 678,90», «1234567.5», «5 000 000». */
const MONEY = /(?<![\d.,])(\d{1,3}(?:[\s  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?(?![\d])/gu;

/** Первая денежная сумма после подписи; годы, проценты и номера законов («44-ФЗ», «20 %») не берутся. */
export function moneyAfter(text: string): number | null {
  for (const match of text.matchAll(MONEY)) {
    const whole = (match[1] as string).replace(/[\s  ]/gu, "");
    const value = Number(`${whole}.${match[2] ?? "0"}`);
    const end = (match.index ?? 0) + match[0].length;
    const after = text.slice(end, end + 6);
    if (/^\s*%/u.test(after) || /^-?\s*фз/iu.test(after)) continue;
    if (match[2] === undefined && whole.length === 4 && value >= 1900 && value <= 2100) continue;
    if (value >= 1000) return value;
  }
  return null;
}

/** НМЦК из текста документа: «Начальная (максимальная) цена контракта: 12 345 678,90 руб.»; первая найденная сумма. */
export function nmckFromText(documents: readonly { readonly name: string; readonly text: string }[]): Nmck | null {
  for (const document of documents) {
    for (const match of document.text.matchAll(NMCK_LABEL)) {
      const start = (match.index ?? 0) + match[0].length;
      const window = document.text.slice(start, start + NMCK_WINDOW);
      // Значение не дальше конца абзаца: следующий абзац — уже другое поле.
      const paragraph = window.split(/\n\s*\n/u)[0] ?? window;
      const value = moneyAfter(paragraph);
      if (value !== null) {
        return { value, source: "document", quote: `${document.name}: ${`${match[0]}${paragraph}`.replace(/\s+/g, " ").trim().slice(0, 160)}` };
      }
    }
  }
  return null;
}

/** НМЦК закупки: сначала `tenders.price` (если больше нуля), иначе из текста извещения и печатной формы. */
export function resolveNmck(tenderPrice: number | null | undefined, documents: readonly { readonly name: string; readonly text: string }[]): Nmck | null {
  if (tenderPrice !== null && tenderPrice !== undefined && Number.isFinite(tenderPrice) && tenderPrice > 0) return { value: tenderPrice, source: "tenders.price", quote: null };
  return nmckFromText(documents);
}

/** Наш итог с НДС к НМЦК; null — нет НМЦК или итога. */
export function ratioToNmck(total: number | null | undefined, nmck: Nmck | null): number | null {
  if (total === null || total === undefined || nmck === null || !(nmck.value > 0) || !(total > 0)) return null;
  return Math.round((total / nmck.value) * 1000) / 1000;
}

/* ------------------------------ Сводка ------------------------------ */

const STATUS_LABELS: Readonly<Record<EstimateOnlyStatus, string>> = {
  OK: "расчёт выполнен",
  NO_VOLUMES: "расчёт выполнен, объёмов или строк сметы нет",
  NO_DOCUMENTS: "нет документов с текстом",
  NO_ZONE: "зона не определена или не собрана на этой машине",
  ERROR: "ошибка расчёта",
};

function tenderLabel(report: Pick<EstimateOnlyReport, "tenderId" | "regNumber">): string {
  return report.regNumber !== null && report.regNumber !== report.tenderId ? `${report.tenderId} (${report.regNumber})` : report.tenderId;
}

function sourceCell(counts: LinesBySource | null): string | null {
  if (counts === null) return null;
  const parts = PRICE_SOURCE_ORDER.filter((key) => counts[key] > 0).map((key) => `${key} ${fmtInt(counts[key])}`);
  return parts.length === 0 ? "—" : parts.join(", ");
}

function gapsCell(counts: EstimateOnlyReport["gapCounts"]): string | null {
  const parts = Object.entries(counts)
    .filter(([, count]) => (count ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([kind, count]) => `${kind} ${fmtInt(count ?? 0)}`);
  return parts.length === 0 ? "—" : parts.join(", ");
}

function volumeCell(report: EstimateOnlyReport): string | null {
  if (report.volumeLevel === null) return null;
  const docs = report.volumeDocuments.length === 0 ? "" : ` (${report.volumeDocuments.slice(0, 3).join("; ")}${report.volumeDocuments.length > 3 ? "…" : ""})`;
  return `${report.volumeLevel}${docs}`;
}

export interface EstimateOnlySummaryMeta {
  readonly generatedAt: string;
  /** Сколько главных строк по рублям показать по закупке. */
  readonly topN: number;
}

/** `summary.md`: сводная таблица, затем по каждой закупке — главные строки по рублям, добавленные расчётом строки, пробелы и пометки. */
export function formatEstimateOnlySummary(reports: readonly EstimateOnlyReport[], meta: EstimateOnlySummaryMeta): string {
  const statusCounts = new Map<EstimateOnlyStatus, number>();
  for (const report of reports) statusCounts.set(report.status, (statusCounts.get(report.status) ?? 0) + 1);

  const out: string[] = ["# Расчёт без сметы заказчика: наш итог и НМЦК", ""];
  out.push(
    `Сформирован ${meta.generatedAt}. Те же документы, тот же конвейер, что у воркера: настоящий извлекатель ведомости (через прод), подбор норм ИИ-сметчиком, работы по технологии, мусор; ` +
      "зона — как её выбрал бы воркер (в том числе регион из документов). Эталона нет: сравнить можно только с НМЦК (отношение нашего итога с НДС к НМЦК) и по здравому смыслу.",
    "",
  );

  out.push("## Закупки по статусам", "");
  out.push(
    ...table(
      ["Статус", "Закупок", "Что значит"],
      (Object.keys(STATUS_LABELS) as EstimateOnlyStatus[]).filter((status) => statusCounts.has(status)).map((status) => [status, statusCounts.get(status), STATUS_LABELS[status]]),
    ),
  );

  out.push("## Закупки", "");
  out.push(
    ...table(
      ["Закупка", "Статус", "Зона", "Метод", "Источник объёмов", "Токены", "Позиций ведомости", "Строк в смете", "Строки по источнику цены", "Пробелы", "Итог с НДС, ₽", "НМЦК, ₽", "Итог / НМЦК"],
      reports.map((report) => [
        tenderLabel(report),
        report.message === null ? report.status : `${report.status}: ${report.message}`,
        report.zone === null ? null : `${report.zone.zoneName} (${String(report.zone.priceZoneId)})`,
        report.method === null ? null : report.method === "BASE_INDEX" ? "БИМ" : "РИМ",
        volumeCell(report),
        report.tokens === null ? null : fmtInt(report.tokens.total),
        report.billItems === null ? null : fmtInt(report.billItems),
        report.pricedLines === null ? null : fmtInt(report.pricedLines),
        sourceCell(report.linesBySource),
        report.totals === null ? null : gapsCell(report.gapCounts),
        report.totals === null ? null : fmtRub(report.totals.total),
        report.nmck === null ? null : `${fmtRub(report.nmck.value)}${report.nmck.source === "document" ? " (из документа)" : ""}`,
        report.ratioToNmck === null ? null : fmtPercent(Math.round(report.ratioToNmck * 1000) / 10),
      ]),
    ),
  );

  out.push("## Источники цены строк", "");
  for (const key of PRICE_SOURCE_ORDER) out.push(`- \`${key}\` — ${PRICE_SOURCE_LABELS[key]}`);
  out.push("");

  for (const report of reports) {
    out.push(`## ${tenderLabel(report)}: ${report.status}`, "");
    if (report.message !== null) out.push(`${report.message}`, "");
    for (const note of [...report.notes, ...report.zoneNotes]) out.push(`- ${note}`);
    if (report.notes.length + report.zoneNotes.length > 0) out.push("");
    if (report.volumeNote !== null) out.push(`Источник объёмов: ${report.volumeNote.replace(/\s+/g, " ").trim()}`, "");
    if (report.nmck?.quote != null) out.push(`НМЦК: ${report.nmck.quote}`, "");
    if (report.duplicateDocuments.length > 0) out.push(`Повторы документов (считались один раз): ${report.duplicateDocuments.map((entry) => `«${entry.name}» = «${entry.duplicateOf}»`).join("; ")}`, "");
    if (report.documentsWithoutBill.length > 0) out.push(`Документы без ведомости: ${report.documentsWithoutBill.join("; ")}`, "");

    if (report.topLines.length > 0) {
      out.push(`### Главные строки по рублям (${fmtInt(report.topLines.length)} из ${fmtInt(report.pricedLines ?? 0)})`, "");
      out.push(
        ...table(
          ["Работа", "Норма", "Объём", "Итог, ₽", "Доля СМР, %", "Основание / источник цены", "Примечание"],
          report.topLines.slice(0, meta.topN).map((line) => [line.name, line.norm, `${fmtRub(line.quantity)} ${line.unit}`, fmtRub(line.total), fmtPercent(line.sharePercent), line.basis, line.note]),
        ),
      );
    }
    out.push(...formatAiMaterialsSection(report.aiMaterials, meta.topN));
    const pick = report.normPick;
    if (pick !== null && (pick.normMaterialRequested ?? 0) + (pick.normMaterialFallback ?? 0) > 0) {
      out.push(
        `Материал нормы «по проекту» (ресурс без марки с числовым расходом): отправлено модели ${fmtInt(pick.normMaterialRequested ?? 0)}, выбрала модель ${fmtInt(pick.normMaterialPicked ?? 0)}, ` +
          `выбран кодом без модели ${fmtInt(pick.normMaterialFallback ?? 0)}, отказ модели ${fmtInt(pick.normMaterialDeclined ?? 0)}, отклонено проверкой ${fmtInt(pick.normMaterialRejected ?? 0)}.`,
        "",
      );
    }
    if (report.generatedRows.length > 0) {
      out.push("### Добавлено расчётом сверх ведомости", "");
      out.push(
        ...table(
          ["Вид", "Работа", "Объём", "Норма", "Итог, ₽", "Примечание"],
          report.generatedRows.map((row) => [
            row.kind === "DEBRIS" ? "мусор" : "работа по технологии (ИИ)",
            row.name,
            `${fmtRub(row.quantity)} ${row.unit}`,
            row.norm,
            row.total === null ? `нет в смете: ${row.unpricedReason ?? "цены нет"}` : fmtRub(row.total),
            row.note,
          ]),
        ),
      );
    }
    if (report.generated !== null) {
      const implied = report.generated.implied;
      if (implied.notes.length > 0) out.push(`Работы по технологии: предложено ${fmtInt(implied.proposed)}, принято ${fmtInt(implied.accepted)}, отклонено ${fmtInt(implied.rejected)}. Причины: ${implied.notes.map((note) => cell(note)).join("; ")}`, "");
    }
  }
  return `${out.join("\n")}\n`;
}
