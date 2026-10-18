import type { BlindComparison, GeneratedLineResult, GeneratedStatus, Gap, GapKind, GapOurSide, GapSide, PositionResult } from "../src/domain/estimate/benchmarkBlind";
import type { GeneratedStats } from "../src/domain/estimate/generatedItems";
import type { DroppedDocument, EstimateLeak, RemovedKind, RemovedSpan } from "../src/domain/estimate/estimateRemoval";
import type { NormPickStats } from "../src/domain/estimate/normPick";
import type { EstimateGapKind, EstimateMethod } from "../src/domain/estimate/types";
import { fmtInt, fmtPercent, fmtRub, table } from "./estimate-benchmark.lib";
import { formatAiMaterialsSection, type AiMaterialRow } from "./estimate-benchmark.materials.lib";

/**
 * Чистые помощники режима `--blind` скрипта `scripts/estimate-benchmark.ts`: отчёт по закупке и сводка `summary.md`.
 * Без диска, сети и базы — как `estimate-benchmark.lib.ts`; сравнение лежит в `src/domain/estimate/benchmarkBlind.ts`,
 * вырезание смет — в `src/domain/estimate/estimateRemoval.ts`.
 */

/* ------------------------------ Отчёт по закупке ------------------------------ */

/**
 * - `OK` — расчёт выполнен и сравнён со сметой заказчика;
 * - `NO_VOLUMES` — расчёт выполнен, но объёмов не нашлось ни в одном документе (сравнение есть: всё недостающее);
 * - `LEAK` — после вырезания разборы всё ещё находят смету заказчика: модель не звалась, чтобы не переписать её объёмы;
 * - `NO_LSR` — в исходных документах нет сметы формы 421/пр: эталона нет;
 * - `NO_DOCUMENTS` — после вырезания не осталось ни одного документа (всё было сметами);
 * - `NO_ZONE` — ценовая зона не определена или не собрана на этой машине;
 * - `DRY_RUN` — только вырезание, модель не звалась, расчёта нет;
 * - `ERROR` — ошибка расчёта.
 */
export type BlindStatus = "OK" | "NO_VOLUMES" | "LEAK" | "NO_LSR" | "NO_DOCUMENTS" | "NO_ZONE" | "DRY_RUN" | "ERROR";

export interface BlindRemovalReport {
  readonly originalDocuments: number;
  readonly originalChars: number;
  /** Документы, которые ушли в расчёт, и сколько в них знаков. */
  readonly usedDocuments: readonly { readonly name: string; readonly chars: number; readonly originalChars: number }[];
  readonly remainingChars: number;
  readonly dropped: readonly DroppedDocument[];
  readonly removed: readonly RemovedSpan[];
  readonly leaks: readonly EstimateLeak[];
  readonly warnings: readonly string[];
  /** Сколько вызовов модели ожидается: Σ знаков / 100 000 с округлением вверх по документам (не меньше). */
  readonly expectedModelCalls: number;
}

export interface BlindCustomerReport {
  readonly lsrs: number;
  readonly positions: number;
  /** Σ «ВСЕГО по смете» без НДС. */
  readonly totalExVat: number | null;
  /** Σ «Всего по позиции» по позициям и подпозициям. */
  readonly positionsTotal: number;
  /** Зона и уровень цен, объявленные в шапках смет заказчика (в расчёт не передавались). */
  readonly declared: readonly string[];
}

export interface BlindTenderReport {
  readonly tenderId: string;
  readonly regNumber: string | null;
  readonly status: BlindStatus;
  readonly message: string | null;
  readonly zone: { readonly priceZoneId: number; readonly zoneName: string; readonly basis: string; readonly matched: string | null } | null;
  readonly zoneNotes: readonly string[];
  readonly method: EstimateMethod | null;
  readonly period: string | null;
  readonly removal: BlindRemovalReport | null;
  readonly customer: BlindCustomerReport | null;
  /** Уровень источника объёмов (BILL, CUSTOMER_ESTIMATE, CONTRACT_ESTIMATE, SPEC) и пояснение расчёта. */
  readonly volumeLevel: string | null;
  readonly volumeNote: string | null;
  readonly volumeDocuments: readonly string[];
  readonly tokensUsed: number | null;
  /** Сколько раз вызвана модель (через прод) и по каким документам. */
  readonly modelCalls: number;
  readonly modelDocuments: readonly string[];
  readonly billItems: number | null;
  readonly rejected: number | null;
  readonly documentsWithoutBill: readonly string[];
  readonly gapCounts: Readonly<Partial<Record<EstimateGapKind, number>>>;
  /**
   * Счётчики «ИИ-сметчика» из результата расчёта (`EstimateBuildResult.normPick`): позиции без шифра — сколько отправлено модели,
   * принято, отклонено проверкой, откатилось на подбор по наименованию, токены; и материалы ведомости — сколько строк опознано как
   * поставка, сколько ресурсов выбрала модель, сколько выбрано кодом без неё и сколько осталось без цены. null — расчёта нет.
   */
  readonly normPick: NormPickStats | null;
  /**
   * Материалы, подобранные ИИ (или кодом по наименованию), по нашим строкам: ресурс нормы «по проекту» → ресурс справочника и материалы строк ведомости, с расходом,
   * ценой, суммой, обоснованием и уверенностью модели (`estimate-benchmark.materials.lib.ts`). Пусто — материалов не подбиралось или расчёта нет.
   */
  readonly aiMaterials: readonly AiMaterialRow[];
  /**
   * Строки, добавленные расчётом сверх ведомости (`EstimateBuildResult.generated`): мусор по нормам (строк, тонн, рублей) и работы по технологии от ИИ
   * (предложено, принято, рублей, токены). Сверка этих строк со сметой заказчика — в `comparison.generated`. null — расчёта нет.
   */
  readonly generated: GeneratedStats | null;
  readonly comparison: BlindComparison | null;
  readonly durationMs: number;
}

/** Метка расхода модели в `llm_usage_log.job_id`: по ней отчёт о расходах отделяет прогоны бенчмарка от боевых. */
export const BLIND_JOB_PREFIX = "bench-blind:";

/** Метка задания для закупки: не длиннее 64 знаков (предел ручки `/api/estimate/bill-rows`). */
export function blindJobId(regNumber: string): string {
  return `${BLIND_JOB_PREFIX}${regNumber}`.slice(0, 64);
}

/** Сколько вызовов модели понадобится документам: фрагмент — 100 000 знаков; неполные ответы делятся и добавляют вызовы. */
export function expectedModelCalls(documents: readonly { readonly text: string }[]): number {
  return documents.reduce((sum, document) => sum + (document.text.length === 0 ? 0 : Math.ceil(document.text.length / 100_000)), 0);
}

/* ------------------------------ Сводный отчёт ------------------------------ */

const STATUS_LABELS: Readonly<Record<BlindStatus, string>> = {
  OK: "расчёт выполнен и сравнён со сметой заказчика",
  NO_VOLUMES: "расчёт выполнен, но объёмов не нашлось (всё недостающее)",
  LEAK: "после вырезания в остатке есть смета заказчика: модель не звалась",
  NO_LSR: "в исходных документах нет ЛСР формы 421/пр: эталона нет",
  NO_DOCUMENTS: "после вырезания не осталось документов",
  NO_ZONE: "зона не определена или не собрана на этой машине",
  DRY_RUN: "только вырезание: модель не звалась, расчёта нет",
  ERROR: "ошибка",
};

const KIND_LABELS: Readonly<Record<RemovedKind, string>> = {
  LSR: "ЛСР формы 421/пр",
  BIM_GRID: "БИМ-смета (таблица)",
  BIM_STREAM: "БИМ-смета (текст PDF/Word)",
  SERVICE_SHEET: "служебный лист Smeta.RU",
  CONTRACT_ESTIMATE: "смета контракта (ЛС … Поз.:)",
  NMCK_CALC: "расчёт НМЦК",
  NMCK_CONTRACT: "проект сметы контракта в обосновании НМЦК",
};

const GAP_LABELS: Readonly<Record<GapKind, string>> = {
  MISSING: "нет у нас",
  EXTRA: "лишняя у нас",
  QUANTITY: "объём",
  VARIANT: "другой вариант нормы",
  PRICE: "цена при том же объёме",
};

const VOLUME_LABELS: Readonly<Record<string, string>> = {
  BILL: "ведомость объёмов",
  CUSTOMER_ESTIMATE: "смета заказчика",
  CONTRACT_ESTIMATE: "смета контракта",
  SPEC: "ТЗ и спецификации",
};

const quantityText = (value: number | null): string => (value === null ? "—" : fmtRub(value));

function customerGapText(side: GapSide | null, count: number): string {
  if (side === null) return "—";
  const code = side.code === null ? "" : `${side.code}; `;
  const more = count > 1 ? ` (+${String(count - 1)} поз.)` : "";
  return `${side.ref}: ${code}${side.name}; ${quantityText(side.quantity)} ${side.unit}; ${fmtRub(side.total)} ₽${more}`;
}

function oursGapText(sides: readonly GapOurSide[]): string {
  if (sides.length === 0) return "—";
  return sides
    .slice(0, 3)
    .map((side) => `${side.code ?? ""}: ${side.name}; ${quantityText(side.quantity)} ${side.unit}; ${fmtRub(side.total)} ₽${side.priceSource === null ? "" : ` (цена: ${side.priceSource})`}`)
    .join(" ‖ ") + (sides.length > 3 ? ` … (+${String(sides.length - 3)})` : "");
}

function sourceText(sides: readonly GapOurSide[]): string {
  const parts = sides
    .slice(0, 2)
    .map((side) => [side.sourceDocument, side.sourceQuote === null ? null : `«${side.sourceQuote.replace(/\s+/g, " ").trim().slice(0, 120)}»`].filter((part) => part !== null).join(": "))
    .filter((part) => part !== "");
  return parts.length === 0 ? "—" : parts.join(" ‖ ");
}

function gapRow(gap: Gap): (string | number | null)[] {
  return [
    GAP_LABELS[gap.kind],
    fmtRub(gap.rub),
    customerGapText(gap.customer, gap.customerPositions),
    oursGapText(gap.ours),
    gap.ratio === null ? null : fmtRub(gap.ratio),
    sourceText(gap.ours),
    gap.similar === null ? null : `${gap.similar.side === "OURS" ? "наша" : "заказчика"}: ${gap.similar.code ?? "—"} ${gap.similar.name} (${fmtRub(gap.similar.score)})`,
  ];
}

const GAP_HEADER = ["Разрыв", "₽", "Заказчик: позиция, шифр, наименование, объём, ед., ₽", "Мы: шифр, наименование, объём, ед., ₽", "Объём: мы / заказчик", "Откуда у нас: документ, цитата", "Похожая по названию"];

function similarRows(positions: readonly PositionResult[], limit: number): (string | number | null)[][] {
  return positions
    .filter((result) => result.status === "MISSING" && result.similar !== null)
    .sort((a, b) => Math.abs(b.position.total ?? 0) - Math.abs(a.position.total ?? 0))
    .slice(0, limit)
    .map((result) => {
      const similar = result.similar as NonNullable<PositionResult["similar"]>;
      return [
        `${result.position.lsr ?? ""} поз. ${result.position.label}`,
        result.position.code,
        result.position.name,
        fmtRub(result.position.total),
        similar.code,
        similar.name,
        fmtRub(similar.total),
        fmtRub(similar.score),
      ];
    });
}

function volumeText(report: BlindTenderReport): string | null {
  if (report.volumeLevel === null) return report.status === "OK" || report.status === "NO_VOLUMES" ? "источника нет" : null;
  return VOLUME_LABELS[report.volumeLevel] ?? report.volumeLevel;
}

/** «Принято / отправлено / отклонено / без ответа» по нормам ИИ; null — расчёта не было. */
function normPickCell(pick: NormPickStats | null): string | null {
  if (pick === null) return null;
  return `${fmtInt(pick.picked)} / ${fmtInt(pick.requested)} / ${fmtInt(pick.rejected)} / ${fmtInt(pick.fallback)}`;
}

/** Материалы ведомости: «строк / ресурс ИИ / по наименованию / без цены / отклонено ИИ»; у расчёта до подбора ресурсов поля нет. */
function materialCell(pick: NormPickStats | null): string | null {
  if (pick === null) return null;
  const count = (value: number | undefined): string => fmtInt(value ?? 0);
  return `${count(pick.materialRows)} / ${count(pick.materialPicked)} / ${count(pick.materialFallback)} / ${count(pick.materialUnpriced)} / ${count(pick.materialRejected)}`;
}

/**
 * Материал нормы «по проекту» (`normMaterial.ts`): «отправлено / ИИ / по наименованию / отказ модели / отклонено проверкой». Ресурс без марки нормы, которому
 * в справочнике цен подобран материал; у расчёта до этого этапа поля нет — нули.
 */
function normMaterialCell(pick: NormPickStats | null): string | null {
  if (pick === null) return null;
  const count = (value: number | undefined): string => fmtInt(value ?? 0);
  return `${count(pick.normMaterialRequested)} / ${count(pick.normMaterialPicked)} / ${count(pick.normMaterialFallback)} / ${count(pick.normMaterialDeclined)} / ${count(pick.normMaterialRejected)}`;
}

/** «Мусор: строк / т / ₽; ИИ: принято из предложенного / ₽»: что добавлено сверх ведомости; null — расчёта нет. */
function generatedCell(generated: GeneratedStats | null): string | null {
  if (generated === null) return null;
  const { debris, implied } = generated;
  const debrisText = debris.rows > 0 ? `${fmtInt(debris.rows)} стр. / ${fmtRub(debris.tons)} т / ${fmtRub(debris.rub)} ₽${debris.unpriced > 0 ? ` (без цены ${fmtInt(debris.unpriced)})` : ""}` : (debris.skipped ?? (debris.enabled ? "нет" : "выкл."));
  const impliedText = implied.proposed > 0 ? `${fmtInt(implied.accepted)} из ${fmtInt(implied.proposed)} / ${fmtRub(implied.rub)} ₽` : implied.failed > 0 ? "ответа модели нет" : (implied.skipped ?? (implied.enabled ? "нет" : "выкл."));
  return `мусор: ${debrisText}; ИИ: ${impliedText}`;
}

const GENERATED_KIND_LABELS = { AI_IMPLIED: "ИИ (технология)", DEBRIS: "мусор" } as const;
const GENERATED_STATUS_LABELS: Readonly<Record<GeneratedStatus, string>> = {
  MATCHED: "совпал шифр с заказчиком",
  SAME_TABLE: "та же таблица, другой вариант",
  NOT_IN_CUSTOMER: "у заказчика такой позиции нет",
};

function generatedRow(line: GeneratedLineResult): (string | number | null)[] {
  const customer = line.customer;
  return [
    GENERATED_KIND_LABELS[line.kind],
    GENERATED_STATUS_LABELS[line.status],
    line.code,
    line.name,
    `${fmtRub(line.quantity)} ${line.unit}`,
    fmtRub(line.total),
    customer === null ? (line.similar === null ? null : `похожая по названию: ${line.similar.code ?? "—"} ${line.similar.name} (${fmtRub(line.similar.total)} ₽)`) : `${customer.ref}: ${customer.code ?? "—"} ${customer.name}; ${fmtRub(customer.total)} ₽`,
    line.quantityRatio === null ? null : fmtRub(line.quantityRatio),
    line.note === null ? null : line.note.replace(/\s+/g, " ").trim().slice(0, 300),
  ];
}

export interface BlindSummaryMeta {
  readonly generatedAt: string;
  /** Сколько строк «главных разрывов» показать по закупке. */
  readonly topN: number;
}

/** `summary.md`: сводная таблица, вырезание смет, главные разрывы и похожие по названию позиции по каждой закупке. */
export function formatBlindSummary(reports: readonly BlindTenderReport[], meta: BlindSummaryMeta): string {
  const statusCounts = new Map<BlindStatus, number>();
  for (const report of reports) statusCounts.set(report.status, (statusCounts.get(report.status) ?? 0) + 1);

  const out: string[] = ["# Бенчмарк «вслепую»: объёмы из документации против сметы заказчика", ""];
  out.push(
    `Сформирован ${meta.generatedAt}. Из входа расчёта вырезаны все сметы заказчика (ЛСР формы 421/пр, БИМ-сметы, смета контракта, таблицы НМЦК): объёмы читала модель из ТЗ, ведомости и спецификаций, ` +
      "нормы подобраны поиском, цены посчитал расчёт. Эталон — смета заказчика, прочитанная кодом из исходных документов.",
    "",
  );
  out.push(
    "Что пишется в базу: расчёт ничего не сохраняет (ни смет, ни заданий). Прод по ручке `/api/estimate/bill-rows` записывает расход модели в `llm_usage_log` " +
      `(purpose = estimate_bill, tender_id = реестровый номер, job_id начинается с \`${BLIND_JOB_PREFIX}\`): эти строки не боевые, отчёт о расходах должен их отделять.`,
    "",
  );

  out.push("## Закупки по статусам", "");
  out.push(
    ...table(
      ["Статус", "Закупок", "Что значит"],
      (Object.keys(STATUS_LABELS) as BlindStatus[]).filter((status) => statusCounts.has(status)).map((status) => [status, statusCounts.get(status), STATUS_LABELS[status]]),
    ),
  );

  out.push("## Закупки", "");
  out.push(
    ...table(
      [
        "Закупка",
        "Статус",
        "Наша зона",
        "Зона заказчика",
        "Метод",
        "Источник объёмов",
        "Токены",
        "Итог заказчика по позициям, ₽",
        "Итог ЛСР без НДС, ₽",
        "Наш итог СМР, ₽",
        "Δ к позициям, %",
        "Δ к итогу ЛСР, %",
        "Покрытие по ₽: шифр, %",
        "Покрытие по ₽: шифр + таблица, %",
        "Совпало / та же таблица / нет у нас / лишних",
        "Медиана объёмов мы / заказчик",
        "ИИ-нормы: принято / отправлено / отклонено / без ответа",
        "Материалы: строк / ресурс ИИ / по наименованию / без цены / отклонено",
        "Материал нормы «по проекту»: отправлено / ИИ / по наименованию / отказ / отклонено",
        "Добавлено сверх ведомости (мусор; работы по технологии ИИ)",
      ],
      reports.map((report) => {
        const comparison = report.comparison;
        const coverage = comparison?.coverage ?? null;
        return [
          report.regNumber !== null && report.regNumber !== report.tenderId ? `${report.tenderId} (${report.regNumber})` : report.tenderId,
          report.message === null ? report.status : `${report.status}: ${report.message}`,
          report.zone === null ? null : `${report.zone.zoneName} (${String(report.zone.priceZoneId)})`,
          report.customer === null ? null : report.customer.declared.join("; "),
          report.method === null ? null : report.method === "BASE_INDEX" ? "БИМ" : "РИМ",
          volumeText(report),
          report.tokensUsed === null ? null : fmtInt(report.tokensUsed),
          comparison === null ? (report.customer === null ? null : fmtRub(report.customer.positionsTotal)) : fmtRub(comparison.totals.customerPositionsTotal),
          comparison === null ? (report.customer === null ? null : fmtRub(report.customer.totalExVat)) : fmtRub(comparison.totals.customerLsrTotal),
          comparison === null ? null : fmtRub(comparison.totals.ourWorkTotal),
          fmtPercent(comparison?.totals.deltaPercentVsPositions),
          fmtPercent(comparison?.totals.deltaPercentVsLsr),
          fmtPercent(coverage?.matchedPercent),
          fmtPercent(coverage?.matchedOrTablePercent),
          coverage === null ? null : `${fmtInt(coverage.matched)} / ${fmtInt(coverage.sameTable)} / ${fmtInt(coverage.missing)} / ${fmtInt(coverage.extra)}`,
          comparison?.quantity.median == null ? null : `${fmtRub(comparison.quantity.median)} (${fmtInt(comparison.quantity.groups)} шифров)`,
          normPickCell(report.normPick),
          materialCell(report.normPick),
          normMaterialCell(report.normPick),
          generatedCell(report.generated),
        ];
      }),
    ),
  );

  const compared = reports.filter((report) => report.comparison !== null);
  if (compared.length > 1) {
    const sum = (pick: (comparison: BlindComparison) => number): number => compared.reduce((total, report) => total + pick(report.comparison as BlindComparison), 0);
    const customerTotal = sum((c) => c.totals.customerPositionsTotal);
    const oursTotal = sum((c) => c.totals.ourWorkTotal);
    const weight = sum((c) => c.coverage.customerWeight);
    const matched = sum((c) => c.coverage.matchedRub);
    const tableRub = sum((c) => c.coverage.sameTableRub);
    const percent = (value: number, base: number): string => (base === 0 ? "—" : fmtPercent(Math.round((value / base) * 10_000) / 100));
    out.push(
      `Итого по ${fmtInt(compared.length)} закупкам с сравнением: заказчик по позициям ${fmtRub(customerTotal)} ₽, мы ${fmtRub(oursTotal)} ₽, **Δ ${percent(oursTotal - customerTotal, customerTotal)}**; ` +
        `покрытие по рублям: шифр ${percent(matched, weight)}, шифр + таблица ${percent(matched + tableRub, weight)}.`,
      "",
    );
  }

  const picked = reports.flatMap((report) => (report.normPick === null ? [] : [report.normPick]));
  if (picked.length > 0) {
    const sumOf = (pick: (stats: NormPickStats) => number | undefined): number => picked.reduce((total, stats) => total + (pick(stats) ?? 0), 0);
    out.push(
      `ИИ-сметчик по ${fmtInt(picked.length)} закупкам: нормы — отправлено ${fmtInt(sumOf((s) => s.requested))}, принято ${fmtInt(sumOf((s) => s.picked))}, отклонено проверкой ${fmtInt(sumOf((s) => s.rejected))}, ` +
        `без ответа ${fmtInt(sumOf((s) => s.fallback))}, токенов ${fmtInt(sumOf((s) => s.tokens))}; ` +
        `материалы — строк ${fmtInt(sumOf((s) => s.materialRows))} (неясных ${fmtInt(sumOf((s) => s.ambiguousRows))}), ресурс выбрала модель ${fmtInt(sumOf((s) => s.materialPicked))}, ` +
        `выбран кодом без модели ${fmtInt(sumOf((s) => s.materialFallback))}, без цены ${fmtInt(sumOf((s) => s.materialUnpriced))}, ответ модели отклонён ${fmtInt(sumOf((s) => s.materialRejected))}; ` +
        `материал нормы «по проекту» — отправлено ${fmtInt(sumOf((s) => s.normMaterialRequested))}, выбрала модель ${fmtInt(sumOf((s) => s.normMaterialPicked))}, ` +
        `выбран кодом без модели ${fmtInt(sumOf((s) => s.normMaterialFallback))}, отказ модели ${fmtInt(sumOf((s) => s.normMaterialDeclined))}, отклонено проверкой ${fmtInt(sumOf((s) => s.normMaterialRejected))}.`,
      "",
    );
  }

  const generatedReports = reports.flatMap((report) => (report.generated === null ? [] : [report.generated]));
  if (generatedReports.length > 0) {
    const sumDebris = (pick: (stats: GeneratedStats["debris"]) => number): number => generatedReports.reduce((total, stats) => total + pick(stats.debris), 0);
    const sumImplied = (pick: (stats: GeneratedStats["implied"]) => number): number => generatedReports.reduce((total, stats) => total + pick(stats.implied), 0);
    out.push(
      `Строки сверх ведомости по ${fmtInt(generatedReports.length)} закупкам: мусор — строк ${fmtInt(sumDebris((s) => s.rows))}, ${fmtRub(sumDebris((s) => s.tons))} т, ${fmtRub(sumDebris((s) => s.rub))} ₽ ` +
        `(без цены ${fmtInt(sumDebris((s) => s.unpriced))}); работы по технологии от ИИ — предложено ${fmtInt(sumImplied((s) => s.proposed))}, принято ${fmtInt(sumImplied((s) => s.accepted))}, ` +
        `отклонено проверкой ${fmtInt(sumImplied((s) => s.rejected))}, ${fmtRub(sumImplied((s) => s.rub))} ₽, токенов ${fmtInt(sumImplied((s) => s.tokens))}.`,
      "",
    );
  }

  out.push("## Что вырезано из входа", "");
  out.push(
    ...table(
      ["Закупка", "Документов было / ушло в расчёт", "Знаков было / осталось", "Вырезано (вид: сколько отрезков)", "Ушли целиком", "Вызовов модели (ожидается)", "Утечки"],
      reports
        .filter((report) => report.removal !== null)
        .map((report) => {
          const removal = report.removal as BlindRemovalReport;
          const kinds = new Map<RemovedKind, number>();
          for (const span of removal.removed) kinds.set(span.kind, (kinds.get(span.kind) ?? 0) + 1);
          return [
            report.tenderId,
            `${fmtInt(removal.originalDocuments)} / ${fmtInt(removal.usedDocuments.length)}`,
            `${fmtInt(removal.originalChars)} / ${fmtInt(removal.remainingChars)}`,
            [...kinds].map(([kind, count]) => `${KIND_LABELS[kind]}: ${fmtInt(count)}`).join("; "),
            removal.dropped.map((item) => item.name).join("; "),
            fmtInt(removal.expectedModelCalls),
            removal.leaks.map((leak) => `${leak.document}: ${leak.detail}`).join("; "),
          ];
        }),
    ),
  );
  for (const report of reports) {
    const removal = report.removal;
    if (removal === null || (removal.warnings.length === 0 && removal.leaks.length === 0)) continue;
    out.push(`### ${report.tenderId}: предупреждения о вырезании`, "");
    for (const leak of removal.leaks) out.push(`- **LEAK** «${leak.document}» (${leak.detector}): ${leak.detail}`);
    for (const warning of removal.warnings) out.push(`- ${warning}`);
    out.push("");
  }

  for (const report of reports) {
    const comparison = report.comparison;
    if (comparison === null) continue;
    out.push(`## ${report.tenderId}: главные разрывы в рублях`, "");
    const c = comparison.coverage;
    out.push(
      `Позиций заказчика ${fmtInt(c.customerPositions)}: совпало по шифру ${fmtInt(c.matched)} (${fmtRub(c.matchedRub)} ₽), та же таблица ${fmtInt(c.sameTable)} (${fmtRub(c.sameTableRub)} ₽), ` +
        `нет у нас ${fmtInt(c.missing)} (${fmtRub(c.missingRub)} ₽, ${fmtPercent(c.missingPercent)} веса сметы; из них похожих по названию ${fmtInt(c.missingSimilar)} на ${fmtRub(c.missingSimilarRub)} ₽). ` +
        `Лишних строк у нас ${fmtInt(c.extra)} на ${fmtRub(c.extraRub)} ₽ (${fmtPercent(c.extraPercent)} веса сметы заказчика; похожих по названию ${fmtInt(c.extraSimilar)}). ` +
        `Работы по нормам: покрытие шифром ${fmtRub(c.byKind.WORK.matchedRub)} из ${fmtRub(c.byKind.WORK.customerTotal)} ₽; материалы, оборудование и цены заказчика: ${fmtRub(c.byKind.OTHER.matchedRub)} из ${fmtRub(c.byKind.OTHER.customerTotal)} ₽.`,
      "",
    );
    out.push(
      `Объёмы по совпавшим шифрам (мы / заказчик, в единицах нормы): медиана ${comparison.quantity.median === null ? "—" : fmtRub(comparison.quantity.median)}, ` +
        `квартили ${comparison.quantity.p25 === null ? "—" : fmtRub(comparison.quantity.p25)} … ${comparison.quantity.p75 === null ? "—" : fmtRub(comparison.quantity.p75)}, ` +
        `в пределах допуска ${fmtPercent(comparison.quantity.withinTolerancePercent)} из ${fmtInt(comparison.quantity.groups)} шифров.`,
      "",
    );
    out.push(...table(GAP_HEADER, comparison.gaps.slice(0, meta.topN).map(gapRow)));
    out.push(...formatAiMaterialsSection(report.aiMaterials, meta.topN).map((line) => line.replace("### ", `### ${report.tenderId}: `)));

    const generated = comparison.generated;
    if (generated.count > 0 || generated.unpriced.length > 0) {
      out.push(`### ${report.tenderId}: строки, добавленные расчётом и ИИ сверх ведомости`, "");
      out.push(
        `Добавлено строк с ценой ${fmtInt(generated.count)} на ${fmtRub(generated.total)} ₽ (мусор ${fmtInt(generated.byKind.DEBRIS.count)} на ${fmtRub(generated.byKind.DEBRIS.total)} ₽; работы по технологии от ИИ ${fmtInt(generated.byKind.AI_IMPLIED.count)} на ${fmtRub(generated.byKind.AI_IMPLIED.total)} ₽), без цены ${fmtInt(generated.unpriced.length)}. ` +
          `Совпало с заказчиком по шифру ${fmtInt(generated.matched)}, по таблице ${fmtInt(generated.sameTable)}, такой позиции у заказчика нет ${fmtInt(generated.notInCustomer)}; ` +
          `у совпавших наша стоимость ${fmtRub(generated.matchedRub)} ₽ против ${fmtRub(generated.customerMatchedRub)} ₽ у заказчика. ` +
          `Без этих строк наш итог СМР ${fmtRub(generated.ourWorkTotalWithoutGenerated)} ₽ (Δ к позициям ${fmtPercent(generated.deltaPercentWithoutGenerated)}).`,
        "",
      );
      if (generated.lines.length > 0) {
        out.push(...table(["Вид", "Сверка с заказчиком", "Наш шифр", "Наименование", "Объём", "₽", "Позиция заказчика", "Объём: мы / заказчик", "Как получена"], generated.lines.map(generatedRow)));
      }
      if (generated.unpriced.length > 0) {
        out.push(...table(["Вид", "Наименование", "Объём", "Почему без цены"], generated.unpriced.map((item) => [GENERATED_KIND_LABELS[item.kind], item.name, `${fmtRub(item.quantity)} ${item.unit}`, item.reason])));
      }
    }

    const similar = similarRows(comparison.positions, meta.topN);
    if (similar.length > 0) {
      out.push(`### ${report.tenderId}: похожие по названию (шифры разные)`, "");
      out.push("Позиции заказчика без совпадения по шифру и по таблице, у которых есть наша строка с похожим названием: модель могла выбрать другую, но равноценную норму.", "");
      out.push(...table(["Позиция заказчика", "Шифр", "Наименование", "₽", "Наш шифр", "Наше наименование", "Наш ₽", "Похожесть"], similar));
    }
  }

  const failed = reports.filter((report) => report.comparison === null);
  if (failed.length > 0) {
    out.push("## Закупки без сравнения", "");
    out.push(...table(["Закупка", "Статус", "Причина"], failed.map((report) => [report.tenderId, report.status, report.message])));
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

