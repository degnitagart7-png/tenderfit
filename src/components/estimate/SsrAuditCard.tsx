"use client";

import { SSR_FINDING_TITLES, type SsrAuditFinding, type SsrAuditFindingType, type SsrAuditReport } from "@/domain/estimate/customerSsrAudit";
import { cn } from "@/lib/cn";

/**
 * Аудит сводного сметного расчёта заказчика: процент непредвиденных против предела 421/пр, индекс
 * прогнозной инфляции против нашего, арифметика итогов, НДС и затраты заказчика (главы 10-12) в цене
 * контракта. Те же правила, что у аудита локальной сметы: находка с типом, пунктом приказа и суммой
 * влияния на НМЦК. Проверка без модели и без цен зоны; нет ССР в документах — карточки нет.
 */

const rubFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const signedRub = (value: number): string => `${value < 0 ? "−" : "+"}${rubFormat.format(Math.round(Math.abs(value)))} ₽`;

function groupByType(findings: readonly SsrAuditFinding[]): { type: SsrAuditFindingType; items: SsrAuditFinding[] }[] {
  const groups: { type: SsrAuditFindingType; items: SsrAuditFinding[] }[] = [];
  for (const finding of findings) {
    const existing = groups.find((group) => group.type === finding.type);
    if (existing === undefined) groups.push({ type: finding.type, items: [finding] });
    else existing.items.push(finding);
  }
  return groups;
}

export function SsrAuditCard({ reports }: { reports: readonly SsrAuditReport[] }) {
  if (reports.length === 0) return null;
  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Аудит сводного сметного расчёта заказчика" data-testid="ssr-audit">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">Аудит сводного сметного расчёта заказчика</h3>
        <p className="text-xs text-muted-foreground">
          Проверка без ИИ: резерв на непредвиденные против 421/пр (п. 179), индекс прогнозной инфляции против нашего по срокам
          (841/пр, п. 22-23), арифметика глав и итогов, НДС, затраты заказчика в цене контракта; в расчёте НМЦК заказчика — индекс фактической инфляции за месяц без данных Росстата, месячный индекс против прогноза, подпись «цена по ЛСР», распределение лимита по приложениям сметы контракта. Влияние — на НМЦК: плюс — НМЦК
          занижена, минус — завышена.
        </p>
      </div>
      {reports.slice(0, 5).map((report, index) => (
        <ReportBlock key={`${report.documentName}-${report.estimateName ?? ""}-${String(index)}`} report={report} />
      ))}
    </section>
  );
}

function ReportBlock({ report }: { report: SsrAuditReport }) {
  const title = report.estimateName ?? report.documentName;
  const groups = groupByType(report.findings);
  return (
    <div className="space-y-2" data-testid="ssr-audit-report">
      <p className="text-sm font-medium">{title}</p>
      <p className={cn("text-sm", report.warnings > 0 ? "text-brick-fg" : "text-olive-fg")} data-testid="ssr-audit-conclusion">
        {report.conclusion}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground" data-testid="ssr-audit-figures">
        {report.customer.reservePercent !== null && <li>Непредвиденные: {String(report.customer.reservePercent).replace(".", ",")} %</li>}
        {report.customer.inflationIndex !== null && (
          <li>
            Индекс инфляции: {report.customer.inflationIndex.toFixed(4).replace(".", ",")}
            {report.inflationPeriod === null ? "" : ` (${report.inflationPeriod})`}
          </li>
        )}
        {report.customer.vatPercent !== null && <li>НДС: {String(report.customer.vatPercent)} %</li>}
        {report.customer.total !== null && <li>Всего по расчёту: {rubFormat.format(Math.round(report.customer.total))} ₽</li>}
      </ul>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Находок нет.</p>
      ) : (
        <div className="space-y-2 text-sm" data-testid="ssr-audit-findings">
          {groups.map((group) => (
            <div key={group.type}>
              <p className="font-medium">{SSR_FINDING_TITLES[group.type]}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {group.items.map((finding, index) => (
                  <li key={`${finding.type}-${String(index)}`} className={finding.severity === "WARNING" ? "text-foreground" : "text-muted-foreground"}>
                    {finding.message}
                    {finding.impact !== null && <span className="ml-1 font-medium">→ {signedRub(finding.impact)}</span>}
                    <span className="ml-1 text-xs text-muted-foreground">[{finding.ref}]</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
