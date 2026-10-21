"use client";

import { useRef, useState } from "react";
import { FileText } from "lucide-react";

import { Button } from "@/components/ui/primitives";
import { buildAuditConclusion, isNontrivialDiff, NO_ESTIMATE_ADVICE, type AuditConclusion } from "@/domain/estimate/auditConclusion";
import { auditConclusionFileName, auditOverallFileName } from "@/domain/estimate/auditConclusionReport";
import { estimateSubtitle, estimateTitles } from "@/domain/estimate/auditEstimateTitle";
import { buildAuditOverall, type AuditOverall } from "@/domain/estimate/auditOverall";
import type { AuditReport } from "@/domain/estimate/customerAudit";
import {
  auditBreakdown,
  bimDetailLines,
  flagLabel,
  isBimReport,
  findingLists,
  formatRub,
  formatSignedPercent,
  notRecognizedLine,
  uncheckedLine,
} from "@/domain/estimate/customerAuditText";
import { describePriceZoneBasis, type PriceZoneBasis } from "@/domain/estimate/priceZoneResolve";
import type { AuditJobData } from "@/hooks/useEstimateJob";
import { cn } from "@/lib/cn";
import { DOCX_MIME, saveBytes } from "@/lib/downloadFile";
import { readJsonOrThrow } from "@/lib/readJson";
import { userFacingError } from "@/lib/userError";

/**
 * Аудит сметы заказчика: где он ошибся и на сколько это двигает НМЦК.
 *
 * Все числа считает `auditCustomerLsr` по ценам нашей зоны, модель не участвует.
 * Блок показывает вывод одной строкой, затем «откуда разница» (труд, машины,
 * материалы, НДС, нормативы, арифметика), позиции с наибольшей разницей и — свёрнуто —
 * все находки и то, что проверить не удалось. Покрытие названо рядом с выводом: вывод
 * по четверти сметы — это не вывод, и человек должен видеть, на чём он стоит.
 *
 * Над деталями стоит «Заключение» простыми словами (`buildAuditConclusion`): итог заказчика против нашего пересчёта, вывод
 * («занижена», «завышена», «в пределах ±5 %»), пять главных причин, что не переоценено и честная оговорка. Файл Word с тем же
 * заключением собирает сервер по номеру задания (`jobId`): без номера (результат ещё не сохранён) кнопки нет.
 */

const SHOWN_FINDINGS = 40;
const SHOWN_UNCHECKED = 30;
const SHOWN_REPORTS = 40;

const BREAKDOWN_TONE = (amount: number | null): string =>
  amount === null ? "text-mustard-fg" : amount > 0 ? "text-brick-fg" : amount < 0 ? "text-olive-fg" : "text-muted-foreground";

/** Цвет полоски вывода: красный — у заказчика дешевле, чем по нашим ценам (денег может не хватить), зелёный — дороже. */
const VERDICT_MARK: Record<AuditConclusion["verdict"], string> = {
  UNDERSTATED: "bg-brick",
  OVERSTATED: "bg-olive",
  WITHIN: "bg-border-strong",
};

/** Цвет разницы: у заказчика дешевле — предупреждение, дороже — спокойно, ноль — серым. Один смысл цвета на всём экране. */
/**
 * Цвет разницы: меньше рубля или меньше 0,5 % от суммы заказчика — нейтральный. Красный «+8 233 ₽ (0,0 %)» на
 * сметах МПГУ на 110 млн (21.10.2026) выглядел тревогой там, где расхождения по сути нет.
 */
const diffTone = (diff: number, base?: number | null): string =>
  Math.abs(diff) < 1 || (base != null && base > 0 && Math.abs(diff) / base < 0.005)
    ? "text-muted-foreground"
    : diff > 0
      ? "text-brick-fg"
      : "text-olive-fg";

/** Деньги не переносятся посреди суммы и стоят колонкой. */
const MONEY = "whitespace-nowrap tabular-nums";

const COLOR_LEGEND = "Красным — у заказчика дешевле, чем по нашим ценам (денег может не хватить); зелёным — дороже; серым — без разницы.";

/** Скачивание заключения Word с сервера: `report` — номер сметы или «all»; ошибка — спокойной фразой. */
function useConclusionDownload(jobId: string | null, report: string, fileName: () => string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    if (jobId === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/estimate/conclusion?jobId=${encodeURIComponent(jobId)}&report=${report}`);
      if (!response.ok) {
        // Ошибка приходит JSON-ом с объяснением; читаем её тем же разбором, что и остальные ответы.
        await readJsonOrThrow(response);
        throw new Error("Не удалось собрать заключение");
      }
      saveBytes(await response.arrayBuffer(), fileName(), DOCX_MIME);
    } catch (err) {
      setError(userFacingError(err, "Не удалось собрать заключение — повторите через минуту."));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function CustomerAuditCard({ audit, jobId = null }: { audit: AuditJobData; jobId?: string | null }) {
  const reports = audit.reports;
  const titles = estimateTitles(reports);
  const overall = reports.length > 1 ? buildAuditOverall(reports) : null;
  // Какие сметы раскрыты: по умолчанию все свёрнуты, нужную открывает строка из списка «Требуют внимания».
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const blocks = useRef(new Map<number, HTMLDetailsElement>());
  const reveal = (index: number): void => {
    setExpanded((current) => new Set(current).add(index));
    setTimeout(() => blocks.current.get(index)?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
  };
  const zoneNote = describePriceZoneBasis({
    basis: audit.zone.basis as PriceZoneBasis,
    matched: audit.zone.matched,
  });

  return (
    <section className="space-y-4 rounded-md border border-border p-3 sm:p-4" aria-label="Аудит сметы заказчика">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">Проверка сметы заказчика</h3>
        {/* Одна короткая строка: откуда цены. Как считали — в раскрывающемся блоке под выводом. */}
        {reports.some((report) => !isBimReport(report)) ? (
          <p className="text-xs text-muted-foreground" data-testid="audit-zone">
            Цены: {audit.zone.zoneName}, {audit.period} — {zoneNote}.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="audit-zone">
            Смета по базисно-индексному методу: пересчёт по ФЕР-2020 и индексам Минстроя (
            {reports[0] === undefined ? "субъект не определён" : `${reports[0].zone}, ${reports[0].period}`}).
          </p>
        )}
      </div>

      {reports.length === 0 && (
        <div className="space-y-2" data-testid="audit-empty">
          <p className="text-sm text-muted-foreground">Ни одной сметы заказчика построчно проверить не удалось.</p>
          {audit.notRecognized.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground" data-testid="audit-not-recognized">
              {audit.notRecognized.slice(0, 20).map((item, index) => (
                <li key={`${item.documentName}-${item.estimateName ?? ""}-${String(index)}`}>{notRecognizedLine(item)}</li>
              ))}
            </ul>
          )}
          <div className="rounded-md border border-border/60 px-3 py-2" data-testid="audit-advice">
            <p className="text-sm font-medium">Что сделать</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
              {NO_ESTIMATE_ADVICE.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {overall !== null && <OverallBlock overall={overall} jobId={jobId} onReveal={reveal} />}

      {reports.slice(0, SHOWN_REPORTS).map((report, index) => (
        <ReportBlock
          key={`${report.documentName}-${report.estimateName ?? ""}-${String(index)}`}
          report={report}
          title={titles[index] as string}
          open={expanded.has(index)}
          onToggle={(next) =>
            setExpanded((current) => {
              if (current.has(index) === next) return current;
              const copy = new Set(current);
              if (next) copy.add(index);
              else copy.delete(index);
              return copy;
            })
          }
          register={(node) => {
            if (node === null) blocks.current.delete(index);
            else blocks.current.set(index, node);
          }}
          collapsible={reports.length > 1}
          jobId={jobId}
          reportIndex={index}
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

function ReportBlock({
  report,
  title,
  open,
  onToggle,
  register,
  collapsible,
  jobId,
  reportIndex,
}: {
  report: AuditReport;
  title: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  register: (node: HTMLDetailsElement | null) => void;
  collapsible: boolean;
  jobId: string | null;
  reportIndex: number;
}) {
  // Несверенные сметы названы в своём блоке ниже; в «Как считали» им повторяться незачем (в файле Word они — в оговорках).
  const conclusion = buildAuditConclusion({ report });
  const body = (
    <div className="space-y-4">
      <ConclusionBlock conclusion={conclusion} report={report} jobId={jobId} reportIndex={reportIndex} />
      <Breakdown report={report} />
      <BimDetails report={report} />
      <TopPositions report={report} />
      <Lists report={report} />
      <details className="rounded-md border border-border/60 px-3 py-2" data-testid="audit-method">
        <summary className="cursor-pointer text-sm font-medium">Как считали</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
          {conclusion.caveats.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );

  if (!collapsible) return body;
  const subtitle = estimateSubtitle(report);
  return (
    <details
      ref={register}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="scroll-mt-4 rounded-md border border-border/60 px-3 py-2"
      data-testid="audit-estimate"
    >
      <summary className="cursor-pointer">
        <span className="text-sm font-medium">{title}</span>
        {subtitle !== "" && <span className="ml-2 text-xs text-muted-foreground">{subtitle}</span>}
        <span className={cn("ml-3 text-[13px]", MONEY, diffTone(report.diff, report.customerTotal))}>
          {formatRub(report.diff, true)}
          {report.diffPercent !== null && ` (${formatSignedPercent(report.diffPercent)})`}
        </span>
        <span className="ml-2 text-xs text-muted-foreground">проверено {String(Math.round(report.coverage * 100))} %</span>
      </summary>
      {/* Тело строится, только пока смета раскрыта: тринадцать смет с таблицами и списками находок сразу — лишний вес. */}
      {open && <div className="mt-2">{body}</div>}
    </details>
  );
}

/** Крупная цифра героя: подпись и значение, деньги не переносятся. */
function Figure({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className={cn("text-[22px] font-semibold leading-tight sm:text-[26px]", MONEY, tone ?? "text-foreground")}>
        {value}
        {note !== undefined && <span className="ml-2 text-[15px] font-medium">{note}</span>}
      </dd>
    </div>
  );
}

/**
 * Итог по всем сметам закупки: один герой вместо тринадцати. Сумма заказчика → наш пересчёт → разница, покрытие, взвешенное по
 * прямым затратам, и короткий список смет, на которые стоит посмотреть (разница больше 5 % или покрытие ниже 70 %): строка
 * раскрывает нужную смету и прокручивает к ней.
 */
function OverallBlock({ overall, jobId, onReveal }: { overall: AuditOverall; jobId: string | null; onReveal: (index: number) => void }) {
  const { busy, error, run } = useConclusionDownload(jobId, "all", () => auditOverallFileName(new Date()));
  const diffNote = overall.diffPercent === null ? undefined : `(${formatSignedPercent(overall.diffPercent)})`;
  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-panel-raised px-3 py-3 sm:px-4" data-testid="audit-overall">
      <div className="flex items-start gap-3">
        <span className={cn("mt-1.5 h-6 w-[3px] shrink-0 rounded-full", VERDICT_MARK[overall.verdict])} aria-hidden />
        <p className="text-[18px] font-semibold leading-snug text-foreground sm:text-[20px]" data-testid="audit-overall-headline">
          {overall.headline}
        </p>
      </div>

      <dl className="grid grid-cols-1 items-end gap-x-4 gap-y-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr]" data-testid="audit-overall-figures">
        <Figure label={`Сметы заказчика (${String(overall.count)})`} value={formatRub(overall.customerTotal)} />
        <span className="hidden pb-1 text-[20px] text-faint sm:block" aria-hidden>→</span>
        <Figure label="Наш пересчёт" value={formatRub(overall.repricedTotal)} />
        <span className="hidden pb-1 text-[20px] text-faint sm:block" aria-hidden>→</span>
        <Figure label="Разница" value={formatRub(overall.diff, true)} note={diffNote} tone={diffTone(overall.diff, overall.customerTotal)} />
      </dl>

      <p className={cn("text-[13px]", overall.coverageLow ? "font-medium text-mustard-fg" : "text-muted-foreground")} data-testid="audit-overall-coverage">
        {overall.coverageText.charAt(0).toUpperCase() + overall.coverageText.slice(1)}
        {overall.unrepricedPositions > 0 ? ` · не переоценено целиком ${String(overall.unrepricedPositions)} поз.` : ""}
        {overall.vatNormalized ? " · суммы приведены к НДС" : ""}
      </p>

      {overall.attention.length === 0 ? (
        <p className="text-[13px] text-muted-foreground" data-testid="audit-attention-none">
          Все сметы в пределах ±5 % и проверены не менее чем на 70 %.
        </p>
      ) : (
        <div>
          <p className="text-[13px] font-medium text-foreground">
            Требуют внимания: {overall.attention.length} из {overall.count}
          </p>
          <ul className="mt-1 space-y-0.5" data-testid="audit-attention">
            {overall.attention.map((row) => (
              <li key={row.index}>
                <button
                  type="button"
                  onClick={() => onReveal(row.index)}
                  className="w-full rounded px-1 py-0.5 text-left text-[13.5px] hover:bg-panel"
                >
                  <span className="font-medium text-foreground">{row.title}</span>
                  <span className="text-muted-foreground"> · </span>
                  <span className={cn(MONEY, diffTone(row.diff))}>
                    {formatRub(row.diff, true)}
                    {row.diffPercent !== null && ` (${formatSignedPercent(row.diffPercent)})`}
                  </span>
                  <span className="text-muted-foreground"> · </span>
                  <span className={cn(MONEY, row.coverage < 0.7 ? "text-mustard-fg" : "text-muted-foreground")}>проверено {String(Math.round(row.coverage * 100))} %</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {jobId !== null && (
          <Button variant="secondary" size="sm" onClick={() => void run()} disabled={busy} className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            {busy ? "Собираем заключение..." : "Скачать заключение по всем сметам"}
          </Button>
        )}
        {error !== null && <span className="text-sm text-brick-fg" role="alert">{error}</span>}
      </div>
    </div>
  );
}

/**
 * «Заключение»: главное — первым. Вывод крупно, с цветной отметкой; одна строка из трёх цифр (смета заказчика → наш пересчёт →
 * разница); покрытие одной строкой; причины; кнопка Word с тем же заключением.
 */
function ConclusionBlock({
  conclusion,
  report,
  jobId,
  reportIndex,
}: {
  conclusion: AuditConclusion;
  report: AuditReport;
  jobId: string | null;
  reportIndex: number;
}) {
  const un = conclusion.unrepriced;
  const diffNote = conclusion.diffPercent === null ? undefined : `(${formatSignedPercent(conclusion.diffPercent)})`;
  const { busy, error, run } = useConclusionDownload(jobId, String(reportIndex), () => auditConclusionFileName(conclusion.title, new Date()));

  return (
    <div className="space-y-3" data-testid="audit-verdict">
      <div className="flex items-start gap-3">
        <span className={cn("mt-1.5 h-6 w-[3px] shrink-0 rounded-full", VERDICT_MARK[conclusion.verdict])} aria-hidden />
        <p className="text-[18px] font-semibold leading-snug text-foreground sm:text-[20px]" data-testid="audit-verdict-headline">
          {conclusion.headline}
        </p>
      </div>

      <dl className="grid grid-cols-1 items-end gap-x-4 gap-y-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr]" data-testid="audit-figures">
        <Figure label="Смета заказчика" value={formatRub(conclusion.customerTotal)} />
        <span className="hidden pb-1 text-[20px] text-faint sm:block" aria-hidden>→</span>
        <Figure label="Наш пересчёт" value={formatRub(conclusion.repricedTotal)} />
        <span className="hidden pb-1 text-[20px] text-faint sm:block" aria-hidden>→</span>
        <Figure label="Разница" value={formatRub(conclusion.diff, true)} note={diffNote} tone={diffTone(conclusion.diff, conclusion.customerTotal)} />
      </dl>

      <p className={cn("text-[13px]", conclusion.coverageLow ? "font-medium text-mustard-fg" : "text-muted-foreground")} data-testid="audit-coverage">
        {conclusion.coverageText.charAt(0).toUpperCase() + conclusion.coverageText.slice(1)} · не переоценено {un.positions} поз.
        {un.positions === 0 && un.partial > 0 ? `, частично — ${String(un.partial)}` : ""}
        {conclusion.coverageLow && " — вывод неполный: остальное нечем переоценить"}
      </p>

      {/* Подробная строка — только когда есть что не переоценено целиком: при нуле она повторяла бы строку выше. */}
      {un.positions > 0 && (
        <p className={cn("text-[13px]", un.share !== null && un.share >= 0.3 ? "font-medium text-mustard-fg" : "text-muted-foreground")} data-testid="audit-unrepriced">
          Не удалось переоценить: {un.positions} поз. на <span className={MONEY}>{formatRub(un.amount)}</span> у заказчика
          {un.share === null ? "" : ` (${String(Math.round(un.share * 100))} % суммы позиций)`}
          {un.partial > 0 ? `, ещё ${String(un.partial)} — частично` : ""}
          {un.byReason.length === 0 ? "" : `. Причины: ${un.byReason.map((item) => item.label).join("; ")}`}.
        </p>
      )}

      {conclusion.reasons.length > 0 && (
        <div>
          <p className="text-[13px] font-medium text-foreground">Главные причины разницы</p>
          <ol className="mt-0.5 list-decimal space-y-0.5 pl-5 text-[13.5px] text-foreground" data-testid="audit-reasons">
            {conclusion.reasons.map((line) => (
              <li key={line.group}>{line.text}</li>
            ))}
          </ol>
        </div>
      )}

      {report.vat.included && (
        <p className="text-xs text-muted-foreground">Суммы — с НДС {String(report.vat.ourPercent)} %, как итог сметы заказчика.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {jobId !== null && (
          <Button variant="secondary" size="sm" onClick={() => void run()} disabled={busy} className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            {busy ? "Собираем заключение..." : "Скачать заключение (Word)"}
          </Button>
        )}
        {error !== null && <span className="text-sm text-brick-fg" role="alert">{error}</span>}
      </div>
    </div>
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
  // Только существенные расхождения: таблица нулей ничего не говорит.
  const shown = report.top.filter(isNontrivialDiff);
  if (shown.length === 0) {
    return <p className="text-sm text-muted-foreground" data-testid="audit-no-positions">Расхождений по позициям нет.</p>;
  }
  return (
    <div className="space-y-1">
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
              <th className="py-1 font-normal">Причина</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((position) => (
              <tr key={position.number} className="border-t border-border/60">
                <td className="py-1 pr-3">{position.number}</td>
                <td className="py-1 pr-3">{position.code === "" ? "—" : position.code}</td>
                <td className="py-1 pr-3">{position.name.length > 70 ? `${position.name.slice(0, 70)}…` : position.name}</td>
                <td className={cn("py-1 pr-3 text-right", MONEY)}>{formatRub(position.customerTotal)}</td>
                <td className={cn("py-1 pr-3 text-right", MONEY)}>{formatRub(position.ourTotal)}</td>
                <td className={cn("py-1 pr-3 text-right", MONEY, diffTone(position.diff))}>{formatRub(position.diff, true)}</td>
                <td className="py-1 text-xs text-muted-foreground">{position.flags.map(flagLabel).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11.5px] text-muted-foreground" data-testid="audit-legend">{COLOR_LEGEND}</p>
    </div>
  );
}

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
