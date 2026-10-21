import { MIN_RELIABLE_COVERAGE, type AuditFinding, type AuditFindingType, type AuditPosition, type AuditReport } from "@/domain/estimate/customerAudit";
import {
  auditBreakdown,
  auditReasons,
  bimDetailLines,
  coverageText,
  formatPercent,
  formatRub,
  isBimReport,
  notRecognizedLine,
  uncheckedSummary,
  zoneLabel,
  type BreakdownLine,
  type UncheckedSummary,
} from "@/domain/estimate/customerAuditText";
import { estimateSubtitle, estimateTitle } from "@/domain/estimate/auditEstimateTitle";
import { classifyResourceCode } from "@/domain/estimate/resourceKinds";
import type { NotRecognizedEstimate } from "@/domain/estimate/customerLsr";

/**
 * Заключение по смете заказчика: вывод простыми словами, главные причины разницы и позиции, на которых она набралась.
 *
 * Зачем отдельный слой над `AuditReport`. Отчёт проверки — это находки и суммы по группам; подрядчику, который решает, идти ли
 * в закупку, нужен ответ на вопрос «хватит ли заказчику денег на эти работы и почему он считает иначе». Здесь отчёт сворачивается
 * в этот ответ: итог заказчика против нашего пересчёта, разница в рублях и процентах, вывод («занижена», «завышена», «в пределах
 * ±5 %»), пять главных причин, что не удалось переоценить, и честная оговорка о точности. Заключение показывает экран и печатает
 * файл Word — оба строятся из одного значения, поэтому говорят одно и то же теми же числами.
 *
 * Тексты строк разницы и «не проверено» — из `customerAuditText.ts`, общие с карточкой проверки и отчётом глубокого анализа.
 *
 * Знак разницы. `diff` = наш пересчёт − итог заказчика. Плюс — у нас дороже, то есть смета заказчика занижена и денег на работы
 * может не хватить; минус — смета завышена.
 *
 * Модуль чистый: ни сети, ни хранилища, ни `Date.now()`.
 */

/** Разница в пределах ±5 % от итога заказчика — не вывод, а шум цен и округлений. */
export const WITHIN_TOLERANCE_PERCENT = 5;
/** Сколько главных причин и позиций называет заключение. */
export const TOP_REASONS = 5;
export const TOP_POSITIONS = 20;

/** Разница позиции, с которой она попадает в заключение: не меньше рубля и не меньше 0,5 % стоимости позиции у заказчика. */
export const TRIVIAL_DIFF_RUB = 1;
export const TRIVIAL_DIFF_SHARE = 0.005;

/** Расхождение позиции существенно: нули и копеечные округления в список «где разница» не попадают. */
export function isNontrivialDiff(position: { readonly diff: number; readonly customerTotal: number }): boolean {
  const abs = Math.abs(position.diff);
  if (abs < TRIVIAL_DIFF_RUB) return false;
  const base = Math.abs(position.customerTotal);
  return base <= 0 || abs / base >= TRIVIAL_DIFF_SHARE;
}

export type ConclusionVerdict = "UNDERSTATED" | "OVERSTATED" | "WITHIN";

export interface ConclusionPosition {
  readonly number: number;
  readonly code: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string;
  readonly customerTotal: number;
  readonly ourTotal: number;
  readonly diff: number;
  /** Причина одной фразой: что именно двинуло сумму позиции. */
  readonly reason: string;
}

export interface AuditConclusion {
  readonly verdict: ConclusionVerdict;
  /** Вывод одной фразой: «Смета заказчика занижена на … (…) — денег на работы может не хватить». */
  readonly headline: string;
  /** Подзаголовок: «Итог заказчика … · наш пересчёт … (зона, квартал)». */
  readonly figures: string;
  readonly customerTotal: number;
  readonly repricedTotal: number;
  readonly diff: number;
  /** Разница от итога заказчика, %; null — итог нулевой. */
  readonly diffPercent: number | null;
  /** Итоги с НДС: суммы приведены к итогу сметы. */
  readonly vatIncluded: boolean;
  readonly coverage: number;
  readonly coverageText: string;
  /** Покрытие ниже порога: вывод неполный. */
  readonly coverageLow: boolean;
  /** Главные причины разницы (до пяти), по убыванию модуля суммы. */
  readonly reasons: readonly BreakdownLine[];
  /** Все составляющие разницы со знаком: для таблицы. */
  readonly breakdown: readonly BreakdownLine[];
  readonly unrepriced: UncheckedSummary & { readonly share: number | null };
  /** Позиции с наибольшей |разницей| (до двадцати). */
  readonly topPositions: readonly ConclusionPosition[];
  /** Оговорки о точности, от общей к частным. */
  readonly caveats: readonly string[];
  readonly method: "RESOURCE_INDEX" | "BASE_INDEX";
  /** «Республика Бурятия, 5 зона, 3 кв. 2026» или про смету БИМ. */
  readonly pricesLabel: string;
  readonly title: string;
  /** Файл и база норм («Смета.xlsx · Смета по ФСНБ 421+557пр, РИМ»): мелким шрифтом под названием. */
  readonly subtitle: string;
}

export interface AuditConclusionInput {
  readonly report: AuditReport;
  /** Названия смет, которые построчно не проверены (другая база, не форма 421/пр): попадают в оговорки. */
  readonly notRecognized?: readonly NotRecognizedEstimate[];
}

export const DISCLAIMER =
  "Расчёт носит информационный характер: это автоматическая сверка цен, нормативов и арифметики, а не сметный расчёт и не заключение экспертизы. Решение о цене заявки принимайте с учётом своей сметы и условий закупки.";

function verdictOf(diffPercent: number | null, diff: number): ConclusionVerdict {
  if (diffPercent === null) return Math.abs(diff) < 1 ? "WITHIN" : diff > 0 ? "UNDERSTATED" : "OVERSTATED";
  if (diffPercent > WITHIN_TOLERANCE_PERCENT) return "UNDERSTATED";
  if (diffPercent < -WITHIN_TOLERANCE_PERCENT) return "OVERSTATED";
  return "WITHIN";
}

function headlineOf(verdict: ConclusionVerdict, diff: number, diffPercent: number | null, coverage: number): string {
  const share = diffPercent === null ? "" : ` (${formatPercent(diffPercent)})`;
  switch (verdict) {
    case "UNDERSTATED":
      return `Смета заказчика занижена на ${formatRub(Math.abs(diff))}${share} — денег на работы может не хватить`;
    case "OVERSTATED":
      return `Смета заказчика завышена на ${formatRub(Math.abs(diff))}${share} — в цене есть запас на снижение`;
    case "WITHIN": {
      const figures = Math.abs(diff) >= 1 ? ` (разница ${formatRub(diff, true)}${diffPercent === null ? "" : `, ${formatPercent(diffPercent)}`})` : "";
      // Малое покрытие: «расхождений нет» про смету, которую почти не переоценили, было бы неправдой.
      if (coverage < MIN_RELIABLE_COVERAGE) {
        return `Итог сметы заказчика в пределах ±${String(WITHIN_TOLERANCE_PERCENT)} % от пересчёта${figures}, но переоценено лишь ${String(Math.round(coverage * 100))} % затрат — об остальном судить нельзя`;
      }
      return `Итог сметы заказчика в пределах ±${String(WITHIN_TOLERANCE_PERCENT)} % от пересчёта${figures} — существенных расхождений нет`;
    }
  }
}

/** Находка → короткая причина и вес для выбора главной причины позиции. */
function findingReason(finding: AuditFinding): { readonly label: string; readonly weight: number } | null {
  const weight = Math.abs(finding.impact ?? finding.discrepancy ?? 0);
  const typed = (type: AuditFindingType): boolean => finding.type === type;
  if (typed("RESOURCE_PRICE")) {
    const kind = classifyResourceCode(finding.subject ?? "");
    const label =
      kind === "LABOUR" || kind === "MACHINIST_HOURS"
        ? "цены труда"
        : kind === "MACHINE"
          ? "цены машин"
          : "цены материалов";
    return { label, weight };
  }
  if (typed("OVERHEAD_RATE")) return { label: "норматив НР", weight };
  if (typed("PROFIT_RATE")) return { label: "норматив СП", weight };
  if (typed("ARITHMETIC")) return { label: "арифметика", weight };
  if (typed("INDEX_VALUE")) return { label: "индексы пересчёта", weight };
  if (typed("FER_PRICE")) return { label: "базисная цена ФЕР-2020", weight };
  return null;
}

const FLAG_REASON: Partial<Record<AuditFindingType, string>> = {
  RESOURCE_PRICE: "цены ресурсов",
  ARITHMETIC: "арифметика",
  OVERHEAD_RATE: "норматив НР",
  PROFIT_RATE: "норматив СП",
  INDEX_VALUE: "индексы пересчёта",
  FER_PRICE: "базисная цена ФЕР-2020",
};

/**
 * Причина разницы по позиции: до двух самых тяжёлых по деньгам видов находок («цены труда, норматив НР»). Находок с суммой
 * нет — по флагам позиции; и флагов нет — пусто (разница пришла из округлений и связей между ресурсами).
 */
export function positionReason(report: AuditReport, position: AuditPosition): string {
  const bucket = new Map<string, number>();
  for (const finding of report.findings) {
    if (finding.positionNumber !== position.number) continue;
    const reason = findingReason(finding);
    if (reason === null) continue;
    bucket.set(reason.label, (bucket.get(reason.label) ?? 0) + reason.weight);
  }
  if (bucket.size > 0) {
    return [...bucket.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([label]) => label)
      .join(", ");
  }
  const flags = position.flags.map((flag) => FLAG_REASON[flag]).filter((label): label is string => label !== undefined);
  return [...new Set(flags)].slice(0, 2).join(", ");
}

function caveatsOf(report: AuditReport, input: AuditConclusionInput, coverageLow: boolean): string[] {
  const caveats: string[] = [
    "Проверка идёт без участия ИИ: объёмы и расход ресурсов заказчика не меняются, пересчитываются только цены ресурсов, нормативы НР и СП и арифметика. Выбор расценок и объёмы она не оценивает — это предмет сметчика.",
  ];
  if (isBimReport(report)) {
    caveats.push(
      "Смета составлена базисно-индексным методом (ФЕР/ТЕР-2001 × индексы): базисные цены сверены с ФЕР-2020 по шифру расценки, индексы — с письмом Минстроя России для субъекта, объекта и квартала. Расценки ТЕР региона и корпоративные открытой базы не имеют — такие позиции не проверены.",
    );
    const checks = report.bim?.baseChecks;
    if (checks !== undefined && checks.compared > 0) {
      caveats.push(`Базисные цены сверены у ${String(checks.compared)} расценок: совпали ${String(checks.matched)}, расходятся ${String(checks.mismatched)}.`);
    }
    for (const line of bimDetailLines(report).slice(0, 3)) caveats.push(line);
  } else {
    caveats.push(
      `Цены ресурсов — сметные цены ФГИС ЦС ценовой зоны и квартала проверки (${report.zone}, ${report.period}); цены по коммерческим предложениям и конъюнктурному анализу заказчика с ними не сравниваются.`,
    );
  }
  if (coverageLow) {
    caveats.push(`${coverageText(report)}: вывод неполный, остальное нечем переоценить. Разницу по непроверенной части нельзя ни подтвердить, ни исключить.`);
  }
  for (const item of input.notRecognized ?? []) caveats.push(notRecognizedLine(item));
  return caveats;
}

export function buildAuditConclusion(input: AuditConclusionInput): AuditConclusion {
  const { report } = input;
  const verdict = verdictOf(report.diffPercent, report.diff);
  const breakdown = auditBreakdown(report);
  const reasons = auditReasons(report)
    .filter((line) => line.amount !== null && Math.abs(line.amount) >= 0.5)
    .sort((a, b) => Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0))
    .slice(0, TOP_REASONS);
  const unchecked = uncheckedSummary(report);
  const coverageLow = report.coverage < MIN_RELIABLE_COVERAGE;
  const topPositions = [...report.positions]
    .filter(isNontrivialDiff)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, TOP_POSITIONS)
    .map(
      (position): ConclusionPosition => ({
        number: position.number,
        code: position.code,
        name: position.name,
        quantity: position.quantity ?? null,
        unit: position.unit ?? "",
        customerTotal: position.customerTotal,
        ourTotal: position.ourTotal,
        diff: position.diff,
        reason: positionReason(report, position),
      }),
    );
  // Доля непереоценённого — от суммы позиций у заказчика (она без НДС, как и стоимость позиций).
  const positionsBase = report.positions.reduce((sum, position) => sum + position.customerTotal, 0);
  const bim = isBimReport(report);
  const pricesLabel = bim ? `${report.zone}, ${report.period}` : zoneLabel(report.zone, report.period);
  return {
    verdict,
    headline: headlineOf(verdict, report.diff, report.diffPercent, report.coverage),
    figures:
      `Итог заказчика ${formatRub(report.customerTotal)}${report.totalMissing ? " (итога в тексте нет — сумма позиций)" : ""}` +
      ` · пересчёт по ${bim ? "ФЕР-2020 и индексам Минстроя" : "нашим ценам"} (${pricesLabel}) ${formatRub(report.repricedTotal)}`,
    customerTotal: report.customerTotal,
    repricedTotal: report.repricedTotal,
    diff: report.diff,
    diffPercent: report.diffPercent,
    vatIncluded: report.vat.included,
    coverage: report.coverage,
    coverageText: coverageText(report),
    coverageLow,
    reasons,
    breakdown,
    unrepriced: { ...unchecked, share: positionsBase > 0 ? unchecked.amount / positionsBase : null },
    topPositions,
    caveats: caveatsOf(report, input, coverageLow),
    method: bim ? "BASE_INDEX" : "RESOURCE_INDEX",
    pricesLabel,
    title: estimateTitle(report),
    subtitle: estimateSubtitle(report),
  };
}

/** Советы, когда в загруженном нет сметы, которую можно проверить. Показываются рядом с причинами «не распознана». */
export const NO_ESTIMATE_ADVICE: readonly string[] = [
  "Выгрузите локальную смету (ЛСР) из программы — Гранд-Смета или Smeta.RU — в Excel (.xlsx) или PDF и загрузите этот файл; родные файлы программ (.gsfx, .xml) не читаются.",
  "Загружайте смету, а не ведомость объёмов или сводный расчёт: проверка идёт по локальной смете с разделами, расценками и итогами.",
  "Файл с текстом читается лучше скана: PDF-сканы и фотографии не распознаются, а смета внутри архива читается, только если сам файл не скан.",
  "Если сметы в закупке нет совсем, проверять нечего — рассчитайте смету по ведомости объёмов на вкладке «Рассчитать смету».",
];
