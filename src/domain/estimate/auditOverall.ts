import { estimateSubtitle, estimateTitles } from "@/domain/estimate/auditEstimateTitle";
import { MIN_RELIABLE_COVERAGE, type AuditReport } from "@/domain/estimate/customerAudit";
import { formatPercent, formatRub, zoneLabel } from "@/domain/estimate/customerAuditText";
import { WITHIN_TOLERANCE_PERCENT, type ConclusionVerdict } from "@/domain/estimate/auditConclusion";

/**
 * Итог по всем сметам закупки.
 *
 * В закупке бывает десяток локальных смет; читать тринадцать заключений подряд никто не будет. Здесь они сворачиваются в одно:
 * сумма заказчика → наш пересчёт → разница, покрытие, взвешенное по прямым затратам, и короткий список только тех смет, где есть
 * на что смотреть (разница больше 5 % или покрытие ниже 70 %). Остальные — в таблице целиком (для файла Word) и в раскрывающихся блоках.
 *
 * Суммы смет с НДС и без НДС (смета БИМ — без НДС) приводятся к НДС по нашей ставке, иначе их складывать нельзя; в строках каждая
 * смета остаётся в своих цифрах. Модуль чистый.
 */

export interface OverallRow {
  readonly index: number;
  readonly title: string;
  readonly subtitle: string;
  readonly customerTotal: number;
  readonly repricedTotal: number;
  readonly diff: number;
  readonly diffPercent: number | null;
  readonly coverage: number;
  readonly verdict: ConclusionVerdict;
  /** Разница больше 5 % или покрытие ниже 70 %. */
  readonly attention: boolean;
  /** Одно слово для таблицы: «занижена», «завышена», «в пределах ±5 %», «проверена частично». */
  readonly verdictText: string;
}

export interface AuditOverall {
  readonly count: number;
  readonly customerTotal: number;
  readonly repricedTotal: number;
  readonly diff: number;
  readonly diffPercent: number | null;
  /** Покрытие, взвешенное по прямым затратам смет. */
  readonly coverage: number;
  readonly coverageText: string;
  readonly coverageLow: boolean;
  readonly verdict: ConclusionVerdict;
  readonly headline: string;
  readonly rows: readonly OverallRow[];
  /** Только сметы, требующие внимания. */
  readonly attention: readonly OverallRow[];
  /** Позиции, которые не переоценены целиком, по всем сметам. */
  readonly unrepricedPositions: number;
  /** Суммы приведены к НДС: в наборе есть сметы с НДС и без него. */
  readonly vatNormalized: boolean;
  readonly pricesLabel: string;
}

function verdictOf(diffPercent: number | null, diff: number): ConclusionVerdict {
  if (diffPercent === null) return Math.abs(diff) < 1 ? "WITHIN" : diff > 0 ? "UNDERSTATED" : "OVERSTATED";
  if (diffPercent > WITHIN_TOLERANCE_PERCENT) return "UNDERSTATED";
  if (diffPercent < -WITHIN_TOLERANCE_PERCENT) return "OVERSTATED";
  return "WITHIN";
}

function rowVerdictText(verdict: ConclusionVerdict, coverageLow: boolean): string {
  const base = verdict === "UNDERSTATED" ? "занижена" : verdict === "OVERSTATED" ? "завышена" : `в пределах ±${String(WITHIN_TOLERANCE_PERCENT)} %`;
  return coverageLow ? `${base}; проверена частично` : base;
}

export function buildAuditOverall(reports: readonly AuditReport[]): AuditOverall {
  const titles = estimateTitles(reports);
  const mixedVat = reports.some((report) => report.vat.included) && reports.some((report) => !report.vat.included);
  const factor = (report: AuditReport): number => (mixedVat && !report.vat.included ? 1 + report.vat.ourPercent / 100 : 1);

  const rows = reports.map((report, index): OverallRow => {
    const verdict = verdictOf(report.diffPercent, report.diff);
    const coverageLow = report.coverage < MIN_RELIABLE_COVERAGE;
    const significant = report.diffPercent === null ? Math.abs(report.diff) >= 1 : Math.abs(report.diffPercent) > WITHIN_TOLERANCE_PERCENT;
    return {
      index,
      title: titles[index] as string,
      subtitle: estimateSubtitle(report),
      customerTotal: report.customerTotal,
      repricedTotal: report.repricedTotal,
      diff: report.diff,
      diffPercent: report.diffPercent,
      coverage: report.coverage,
      verdict,
      attention: significant || coverageLow,
      verdictText: rowVerdictText(verdict, coverageLow),
    };
  });

  const customerTotal = reports.reduce((sum, report) => sum + report.customerTotal * factor(report), 0);
  const repricedTotal = reports.reduce((sum, report) => sum + report.repricedTotal * factor(report), 0);
  const diff = repricedTotal - customerTotal;
  const diffPercent = customerTotal === 0 ? null : (diff * 100) / customerTotal;
  const checked = reports.reduce((sum, report) => sum + report.checkedDirect, 0);
  const total = reports.reduce((sum, report) => sum + report.totalDirect, 0);
  const coverage = total > 0 ? Math.min(1, checked / total) : 0;
  const verdict = verdictOf(diffPercent, diff);
  const share = diffPercent === null ? "" : ` (${formatPercent(diffPercent)})`;
  const headline =
    verdict === "UNDERSTATED"
      ? `Итого по всем сметам (${String(reports.length)}): занижено на ${formatRub(Math.abs(diff))}${share} — денег на работы может не хватить`
      : verdict === "OVERSTATED"
        ? `Итого по всем сметам (${String(reports.length)}): завышено на ${formatRub(Math.abs(diff))}${share} — в цене есть запас на снижение`
        : `Итого по всем сметам (${String(reports.length)}): в пределах ±${String(WITHIN_TOLERANCE_PERCENT)} % от пересчёта${
            Math.abs(diff) >= 1 ? ` (разница ${formatRub(diff, true)})` : ""
          }`;
  const first = reports[0];
  return {
    count: reports.length,
    customerTotal,
    repricedTotal,
    diff,
    diffPercent,
    coverage,
    coverageText: `проверено ${String(Math.round(coverage * 100))} % прямых затрат`,
    coverageLow: coverage < MIN_RELIABLE_COVERAGE,
    verdict,
    headline,
    rows,
    attention: rows.filter((row) => row.attention),
    unrepricedPositions: reports.reduce((sum, report) => sum + report.positions.filter((position) => position.checkedShare <= 0).length, 0),
    vatNormalized: mixedVat,
    pricesLabel: first === undefined ? "" : first.method === "BASE_INDEX" ? `${first.zone}, ${first.period}` : zoneLabel(first.zone, first.period),
  };
}
