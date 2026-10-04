"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Digest } from "@/domain/entities";
import type { TenderRow } from "@/domain/filtering";
import { mockNotificationProvider } from "@/adapters/notifications/mockNotificationProvider";
import { settingsRepository } from "@/repositories/settingsRepository";
import { useTenderData } from "@/hooks/useTenderData";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
} from "@/components/ui/primitives";
import { FitScore, VerdictBadge } from "@/components/analysis";
import { RegionBars, VerdictDonut } from "@/components/reports/ReportCharts";
import { formatDate, formatTenderPrice, pluralRu } from "@/utils/format";
import { DISCLAIMER, closingSoonLabel, verdictLabels } from "@/lib/labels";

/**
 * Ежедневный отчёт: что можно подавать, что нужно посмотреть, у чего скоро
 * закрывается подача и почему остальное не подошло.
 *
 * Письма не отправляются (см. оговорку в настройках уведомлений), поэтому
 * «Preview email-версии» отсюда убран: кнопка обещала доставку, которой нет.
 * Сводные графики переехали сюда с экрана «Сегодня» — там они спорили
 * с главной задачей экрана (что открыть прямо сейчас).
 */

function DigestRow({ row, reasons }: { row: TenderRow; reasons?: string[] }) {
  const topRisk =
    [...row.analysis.contractRisks].sort(
      (a, b) =>
        ["CRITICAL", "HIGH", "MEDIUM", "LOW"].indexOf(a.severity) -
        ["CRITICAL", "HIGH", "MEDIUM", "LOW"].indexOf(b.severity),
    )[0]?.title ?? row.analysis.hardBlockers[0]?.reason;
  const reasonList = reasons ?? [
    ...row.analysis.positiveFactors.slice(0, 2).map((f) => f.text),
    ...row.analysis.negativeFactors.slice(0, 1).map((f) => f.text),
  ].slice(0, 3);

  return (
    <li className="rounded-control border border-border bg-panel p-3.5 transition-colors hover:border-border-strong">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/tenders/${row.tender.id}`}
            className="text-sm font-medium text-foreground hover:text-accent-fg"
          >
            {row.tender.subject}
          </Link>
          <p className="muted text-xs mt-0.5">
            {row.tender.customerName} · {row.tender.region} ·{" "}
            {formatTenderPrice(row.tender.financial.price)} · подача до{" "}
            {formatDate(row.tender.deadlines.submissionEnd)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <FitScore value={row.analysis.fitScore} size="sm" />
          <VerdictBadge verdict={row.analysis.verdict} />
        </div>
      </div>
      {reasonList.length > 0 && (
        <ul className="list-disc pl-5 mt-2 space-y-0.5 text-xs text-muted-foreground">
          {reasonList.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
        <p className="text-xs text-muted-foreground">
          {topRisk ? <>Главный риск: <span className="text-muted-foreground">{topRisk}</span></> : "Риски не обнаружены"}
          {row.analysis.nextActions[0] ? <> · Следующий шаг: {row.analysis.nextActions[0]}</> : null}
        </p>
        <Link href={`/tenders/${row.tender.id}`}>
          <span className="inline-flex items-center rounded-full border border-border px-3 py-1 text-[13.5px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground">
            Открыть
          </span>
        </Link>
      </div>
    </li>
  );
}

export function DailyReportView() {
  const { rows, loading, error, reload } = useTenderData();
  const [digest, setDigest] = useState<Digest | null>(null);
  const settings = settingsRepository.get();

  useEffect(() => {
    if (rows.length === 0) return;
    let cancelled = false;
    (async () => {
      const d = await mockNotificationProvider.buildDailyDigest(
        rows.map((r) => r.analysis),
        rows.map((r) => r.tender),
        settings,
      );
      if (!cancelled) setDigest(d);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const rowById = useMemo(() => {
    const map = new Map<string, TenderRow>();
    for (const r of rows) map.set(r.tender.id, r);
    return map;
  }, [rows]);

  const pick = (ids: string[]): TenderRow[] =>
    ids
      .map((id) => rowById.get(id))
      .filter((r): r is TenderRow => r !== undefined)
      .sort((a, b) => b.analysis.fitScore - a.analysis.fitScore);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !digest) return <LoadingSkeleton rows={8} />;

  const recommended = pick(digest.recommended);
  const review = pick(digest.manualReview);
  const closing = pick(digest.closingSoon);
  const changed = pick(digest.documentChanges);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Отчёт</h1>
        <p className="muted mt-1">
          За {formatDate(digest.date)} · разобрано {digest.totalNew}{" "}
          {pluralRu(digest.totalNew, ["закупка", "закупки", "закупок"])} · в отчёт попадают
          закупки с оценкой не ниже {settings.minFitScore}. На почту пока не отправляется —
          отчёт живёт здесь.
        </p>
      </div>

      <Card title={`1. ${verdictLabels.RECOMMENDED} (${recommended.length})`}>
        {recommended.length === 0 ? (
          <EmptyState
            title="Таких закупок нет"
            description="Ни одна закупка не прошла все проверки профиля компании. Причины — в разделе 4."
          />
        ) : (
          <ul className="space-y-3">
            {recommended.map((r) => (
              <DigestRow key={r.tender.id} row={r} />
            ))}
          </ul>
        )}
      </Card>

      <Card title={`2. ${verdictLabels.MANUAL_REVIEW} (${review.length})`}>
        {review.length === 0 ? (
          <p className="muted">Закупок, требующих ручной проверки, нет.</p>
        ) : (
          <ul className="space-y-3">
            {review.map((r) => (
              <DigestRow key={r.tender.id} row={r} />
            ))}
          </ul>
        )}
      </Card>

      <Card title={`3. ${closingSoonLabel} (${closing.length})`}>
        {closing.length === 0 ? (
          <p className="muted">Горящих сроков нет.</p>
        ) : (
          <ul className="space-y-3">
            {closing.map((r) => (
              <DigestRow key={r.tender.id} row={r} />
            ))}
          </ul>
        )}
      </Card>

      <Card title={`4. Не подошло (${digest.excluded.length})`}>
        {digest.excluded.length === 0 ? (
          <p className="muted">Отклонённых закупок нет.</p>
        ) : (
          <ul className="space-y-2">
            {digest.excluded.map((e) => {
              const row = rowById.get(e.tenderId);
              if (!row) return null;
              return (
                <li
                  key={e.tenderId}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/tenders/${row.tender.id}`}
                      className="font-medium text-foreground hover:text-accent-fg line-clamp-1"
                    >
                      {row.tender.subject}
                    </Link>
                    <p className="text-xs text-brick-fg mt-0.5">{e.reason}</p>
                  </div>
                  <span className="muted text-xs tabular-nums">
                    Fit Score {row.analysis.fitScore}/100
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {changed.length > 0 && (
        <Card title={`Изменения документации (${changed.length})`}>
          <ul className="space-y-2">
            {changed.map((r) => {
              const last = r.tender.changeLog.at(-1);
              return (
                <li key={r.tender.id} className="text-sm">
                  <Link
                    href={`/tenders/${r.tender.id}`}
                    className="font-medium text-foreground hover:text-accent-fg"
                  >
                    {r.tender.subject}
                  </Link>
                  {last && (
                    <p className="muted text-xs">
                      {formatDate(last.date)} — {last.description}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/*
        Сводка по всей базе, а не за день: графики отвечают на вопрос «как
        вообще выглядит выдача», и на экране «Сегодня» они уводили взгляд
        от единственного нужного действия.
      */}
      {rows.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <VerdictDonut rows={rows} />
          <RegionBars rows={rows} />
        </div>
      )}

      <p className="muted text-xs">{DISCLAIMER}</p>
    </div>
  );
}
