"use client";

import type { AuditReport } from "@/domain/estimate/customerAudit";
import {
  auditBreakdown,
  auditHeadline,
  bimDetailLines,
  coverageText,
  isBimReport,
  findingLists,
  formatRub,
  notRecognizedLine,
  uncheckedLine,
} from "@/domain/estimate/customerAuditText";
import { describePriceZoneBasis, type PriceZoneBasis } from "@/domain/estimate/priceZoneResolve";
import type { AuditJobData } from "@/hooks/useEstimateJob";
import { cn } from "@/lib/cn";

/**
 * Аудит сметы заказчика: где он ошибся и на сколько это двигает НМЦК.
 *
 * Все числа считает `auditCustomerLsr` по ценам нашей зоны, модель не участвует.
 * Блок показывает вывод одной строкой, затем «откуда разница» (труд, машины,
 * материалы, НДС, нормативы, арифметика), позиции с наибольшей разницей и — свёрнуто —
 * все находки и то, что проверить не удалось. Покрытие названо рядом с выводом: вывод
 * по четверти сметы — это не вывод, и человек должен видеть, на чём он стоит.
 */

const SHOWN_FINDINGS = 40;
const SHOWN_UNCHECKED = 30;
const SHOWN_REPORTS = 5;

const BREAKDOWN_TONE = (amount: number | null): string =>
  amount === null ? "text-mustard-fg" : amount > 0 ? "text-brick-fg" : amount < 0 ? "text-olive-fg" : "text-muted-foreground";

const VERDICT_TONE: Record<AuditReport["verdict"], string> = {
  UNDERSTATED: "text-brick-fg",
  OVERSTATED: "text-olive-fg",
  MATCH: "text-muted-foreground",
};

export function CustomerAuditCard({ audit }: { audit: AuditJobData }) {
  const reports = audit.reports;
  const zoneNote = describePriceZoneBasis({
    basis: audit.zone.basis as PriceZoneBasis,
    matched: audit.zone.matched,
  });

  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Аудит сметы заказчика">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">Аудит сметы заказчика</h3>
        {reports.some((report) => !isBimReport(report)) ? (
          <p className="text-xs text-muted-foreground" data-testid="audit-zone">
            Цены: {audit.zone.zoneName}, {audit.period} — {zoneNote}. Проверка без ИИ: объёмы и расход ресурсов
            заказчика не меняются, пересчитываются только цены, нормативы и арифметика.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="audit-zone">
            Смета составлена базисно-индексным методом: базисные цены сверяются с ФЕР-2020, индексы — с письмами
            Минстроя России. Проверка без ИИ: объёмы и расход ресурсов заказчика не меняются.
          </p>
        )}
      </div>

      {reports.length === 0 && (
        <p className="text-sm text-muted-foreground">Ни одной сметы заказчика построчно проверить не удалось.</p>
      )}

      {reports.slice(0, SHOWN_REPORTS).map((report, index) => (
        <ReportBlock
          key={`${report.documentName}-${report.estimateName ?? ""}-${String(index)}`}
          report={report}
          open={index === 0}
          collapsible={reports.length > 1}
        />
      ))}
      {reports.length > SHOWN_REPORTS && (
        <p className="text-xs text-muted-foreground">и ещё смет: {reports.length - SHOWN_REPORTS}</p>
      )}

      {audit.notRecognized.length > 0 && (
        <details className="rounded-md border border-border/60 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Не проверено построчно: смет {audit.notRecognized.length}
          </summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {audit.notRecognized.slice(0, 20).map((item, index) => (
              <li key={`${item.documentName}-${item.estimateName ?? ""}-${String(index)}`}>{notRecognizedLine(item)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ReportBlock({ report, open, collapsible }: { report: AuditReport; open: boolean; collapsible: boolean }) {
  const title = report.estimateName ?? report.documentName;
  const body = (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm" data-testid="audit-headline">
          {auditHeadline(report)}
        </p>
        <p className={cn("text-xs", report.coverage < 0.7 ? "text-mustard-fg" : "text-muted-foreground")} data-testid="audit-coverage">
          {coverageText(report)}
          {report.coverage < 0.7 && (isBimReport(report) ? " — вывод неполный: остальное нечем сверить" : " — вывод неполный: остальные ресурсы нечем переоценить")}
        </p>
      </div>

      <Breakdown report={report} />
      <BimDetails report={report} />
      <TopPositions report={report} />
      <Lists report={report} />
    </div>
  );

  if (!collapsible) return body;
  return (
    <details open={open} className="rounded-md border border-border/60 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">
        {title}: <span className={VERDICT_TONE[report.verdict]}>{report.conclusion}</span>
      </summary>
      <div className="mt-2">{body}</div>
    </details>
  );
}

function BimDetails({ report }: { report: AuditReport }) {
  const lines = bimDetailLines(report);
  if (lines.length === 0) return null;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground" data-testid="audit-bim-details">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function Breakdown({ report }: { report: AuditReport }) {
  const lines = auditBreakdown(report);
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">Расхождений по ценам, нормативам и арифметике не найдено.</p>;
  }
  return (
    <div>
      <p className="text-sm font-medium">Откуда разница</p>
      <ul className="mt-1 space-y-0.5 text-sm" data-testid="audit-breakdown">
        {lines.map((line) => (
          <li key={line.group} className={BREAKDOWN_TONE(line.amount)}>
            {line.text}
          </li>
        ))}
      </ul>
      {report.vat.included && (
        <p className="mt-1 text-xs text-muted-foreground">
          Суммы групп — с НДС {String(report.vat.ourPercent)} %, чтобы складываться в разницу итога.
        </p>
      )}
    </div>
  );
}

function TopPositions({ report }: { report: AuditReport }) {
  if (report.top.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="pb-1 text-left text-muted-foreground">
          Позиции с наибольшей разницей (в смете, без НДС)
        </caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-3 font-normal">№</th>
            <th className="py-1 pr-3 font-normal">Обоснование</th>
            <th className="py-1 pr-3 font-normal">Наименование</th>
            <th className="py-1 pr-3 text-right font-normal">У заказчика</th>
            <th className="py-1 pr-3 text-right font-normal">У нас</th>
            <th className="py-1 pr-3 text-right font-normal">Разница</th>
            <th className="py-1 font-normal">Флаги</th>
          </tr>
        </thead>
        <tbody>
          {report.top.map((position) => (
            <tr key={position.number} className="border-t border-border/60">
              <td className="py-1 pr-3">{position.number}</td>
              <td className="py-1 pr-3">{position.code === "" ? "—" : position.code}</td>
              <td className="py-1 pr-3">{position.name.length > 70 ? `${position.name.slice(0, 70)}…` : position.name}</td>
              <td className="py-1 pr-3 text-right">{formatRub(position.customerTotal)}</td>
              <td className="py-1 pr-3 text-right">{formatRub(position.ourTotal)}</td>
              <td className={cn("py-1 pr-3 text-right", position.diff > 0 ? "text-brick-fg" : "text-olive-fg")}>
                {formatRub(position.diff, true)}
              </td>
              <td className="py-1 text-xs text-muted-foreground">{position.flags.map(flagLabel).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FLAG_LABEL: Record<string, string> = {
  RESOURCE_PRICE: "цены",
  ARITHMETIC: "арифметика",
  OVERHEAD_RATE: "НР",
  PROFIT_RATE: "СП",
  INDEX_VALUE: "индексы",
  FER_PRICE: "цена ФЕР",
};
const flagLabel = (flag: string): string => FLAG_LABEL[flag] ?? flag;

function Lists({ report }: { report: AuditReport }) {
  const lists = findingLists(report);
  return (
    <>
      {lists.length > 0 && (
        <details className="rounded-md border border-border/60 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Все находки ({report.findings.length})</summary>
          <div className="mt-2 space-y-3 text-sm">
            {lists.map((list) => (
              <div key={list.type}>
                <p className="font-medium">
                  {list.title}: {list.items.length}
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {list.items.slice(0, SHOWN_FINDINGS).map((finding, index) => (
                    <li key={`${list.type}-${String(index)}`}>
                      {finding.message}
                      {finding.impact !== null && ` → ${formatRub(finding.impact, true)}`}
                      {finding.type === "ARITHMETIC" && finding.discrepancy !== undefined && ` (расхождение ${formatRub(finding.discrepancy)})`}
                    </li>
                  ))}
                  {list.items.length > SHOWN_FINDINGS && (
                    <li className="list-none">и ещё {list.items.length - SHOWN_FINDINGS}</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}

      {report.unchecked.length > 0 && (
        <details className="rounded-md border border-border/60 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Не проверено ({report.unchecked.length})</summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {report.unchecked.slice(0, SHOWN_UNCHECKED).map((item) => (
              <li key={`${item.kind}-${item.code}`}>{uncheckedLine(item)}</li>
            ))}
            {report.unchecked.length > SHOWN_UNCHECKED && (
              <li className="list-none">и ещё {report.unchecked.length - SHOWN_UNCHECKED}</li>
            )}
          </ul>
        </details>
      )}
    </>
  );
}
