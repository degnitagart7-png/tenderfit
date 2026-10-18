import type { SsrNmcComparison, SsrResult } from "@/domain/estimate/ssr";
import { periodText } from "@/domain/estimate/forecastInflation";

/**
 * Тексты сводного расчёта для карточки и отчёта Word: одни и те же строки на экране и в файле.
 */

const rubFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const moneyFormat = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** «2 032 153 ₽» (округление до рубля). */
export function rubText(value: number): string {
  return `${rubFormat.format(Math.round(value))} ₽`;
}

/** «2 032 153,32» — как в таблице сводного расчёта. */
export function moneyText(value: number): string {
  return moneyFormat.format(value);
}

export function signedPercentText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Math.abs(rounded).toFixed(1).replace(".", ",");
  if (rounded === 0) return "0,0 %";
  return `${rounded > 0 ? "+" : "−"}${text} %`;
}

/** «Наша оценка НМЦК: X ₽ против НМЦК закупки Y ₽ (разница ±Z %)». */
export function nmcHeadline(result: SsrResult, comparison: SsrNmcComparison | null): string {
  if (comparison === null) {
    return `Наша оценка НМЦК: ${rubText(result.nmc.total)} с НДС (${rubText(result.nmc.beforeVat)} без НДС). НМЦК закупки не объявлена — сравнивать не с чем`;
  }
  const vat = comparison.nmcIncludesVat ? "с НДС" : "без НДС";
  return `Наша оценка НМЦК: ${rubText(comparison.ours)} против НМЦК закупки ${rubText(comparison.nmc)} (${vat}; разница ${signedPercentText(comparison.diffPercent)})`;
}

/** Что сказано про индекс инфляции: одной строкой. */
export function inflationLine(result: SsrResult): string {
  const inflation = result.nmc.inflation;
  if (!inflation.applied) return `Прогнозная инфляция не применена: ${inflation.reason ?? "индекс не рассчитан"}`;
  const period = periodText(inflation);
  return `Индекс прогнозной инфляции ${inflation.index.toFixed(4).replace(".", ",")}${period === null ? "" : ` за период ${period}`}: ${inflation.formula ?? ""}`;
}

export interface SsrTableRow {
  readonly kind: "chapter" | "group" | "reserve" | "total";
  readonly label: string;
  /** Сумма графы 8 (всего), ₽; null — глава не оценивалась. */
  readonly amount: number | null;
  readonly note: string;
}

/** Строки сводного расчёта: главы 1-12, итоги по группам глав, резерв, НДС. */
export function ssrTableRows(result: SsrResult): SsrTableRow[] {
  const rows: SsrTableRow[] = [];
  for (const chapter of result.chapters) {
    rows.push({
      kind: "chapter",
      label: `Глава ${String(chapter.number)}. ${chapter.shortTitle}`,
      amount: chapter.computed ? chapter.amounts.total : null,
      note: chapter.note,
    });
    if (chapter.number === 7 || chapter.number === 8 || chapter.number === 9 || chapter.number === 12) {
      const id = `1-${String(chapter.number)}`;
      const group = result.groups.find((item) => item.id === id);
      if (group !== undefined) rows.push({ kind: "group", label: group.label, amount: group.amounts.total, note: "" });
    }
  }
  rows.push({
    kind: "reserve",
    label: `Непредвиденные затраты ${String(result.reserve.percent)} %`,
    amount: result.reserve.amounts.total,
    note: `${result.purpose.label}: ${result.purpose.note}`,
  });
  rows.push({ kind: "total", label: "Итого с резервом", amount: result.afterReserve.total, note: "" });
  rows.push({ kind: "total", label: `НДС ${String(result.vatPercent)} %`, amount: result.full.vat, note: "на итог глав 1-12 с резервом (п. 181)" });
  rows.push({ kind: "total", label: "Всего по сводному расчёту (текущие цены)", amount: result.full.total, note: "" });
  return rows;
}
