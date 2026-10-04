"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PIPELINE_STATUSES, type PipelineStatus } from "@/domain/enums";
import type { TenderRow } from "@/domain/filtering";
import { pipelineLabels } from "@/lib/labels";
import { pipelineRepository } from "@/repositories/pipelineRepository";
import { useTenderData } from "@/hooks/useTenderData";
import { ErrorState, LoadingSkeleton } from "@/components/ui/primitives";
import { FitScore, VerdictBadge } from "@/components/analysis";
import { formatDate, formatTenderPrice, pluralRu } from "@/utils/format";
import { cn } from "@/lib/cn";

/**
 * Доска решений по закупкам.
 *
 * Колонки прокручиваются внутри себя: без ограничения высоты страница с очередью
 * из сотни закупок уходила на десятки экранов вниз, и доска выглядела пустой
 * полосой. Перенос доступен и мышью (перетаскивание), и с клавиатуры (список
 * «Перенести» на карточке): drag-and-drop alone недоступен с клавиатуры.
 * Перенос меняет только стадию воронки и сообщает о ней строкой статуса: глубокий
 * разбор документации запускается кнопкой в карточке закупки, а не переносом.
 */

/** Одна строка о назначении колонки — показываем, пока колонка пуста. */
const COLUMN_HINTS: Record<PipelineStatus, string> = {
  NEW: "Очередь разбора: сюда попадает всё новое, отсортировано по fit.",
  INTERESTING: "Перенесите сюда закупки, которые хотите разобрать подробнее.",
  ANALYZING: "Закупки, по которым идёт глубокий анализ документации.",
  PREPARING_APPLICATION: "Готовите заявку: документы, обеспечение, сроки.",
  SUBMITTED: "Заявка отправлена, ждём результатов.",
  WON: "Выигранные закупки.",
  LOST: "Проигранные закупки.",
  SKIPPED: "Отложенные и неподходящие — чтобы не мешались в очереди.",
};

export function PipelineBoard() {
  const { rows, loading, error, reload } = useTenderData();
  const [statuses, setStatuses] = useState<Record<string, PipelineStatus>>({});
  const [dragOver, setDragOver] = useState<PipelineStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const map: Record<string, PipelineStatus> = {};
    for (const r of rows) map[r.tender.id] = pipelineRepository.getStatus(r.tender.id);
    setStatuses(map);
  }, [rows]);

  // Строка статуса живёт четыре секунды: дольше держать нечего, короче — не прочтут.
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const grouped = useMemo(() => {
    const g = Object.fromEntries(
      PIPELINE_STATUSES.map((s) => [s, [] as TenderRow[]]),
    ) as Record<PipelineStatus, TenderRow[]>;
    for (const r of rows) {
      const status = statuses[r.tender.id] ?? "NEW";
      g[status].push(r);
    }
    for (const key of PIPELINE_STATUSES) {
      g[key].sort((a, b) => b.analysis.fitScore - a.analysis.fitScore);
    }
    return g;
  }, [rows, statuses]);

  const inWork = rows.filter((r) => {
    const s = statuses[r.tender.id] ?? "NEW";
    return s !== "NEW" && s !== "SKIPPED";
  }).length;


  const move = (tenderId: string, status: PipelineStatus) => {
    pipelineRepository.setStatus(tenderId, status);
    setStatuses((s) => ({ ...s, [tenderId]: status }));
    setDragOver(null);
    setNotice(`Закупка перенесена: ${pipelineLabels[status]}.`);
  };

  /*
    Перенос по доске ничего не тратит, поэтому и не спрашивает.

    Подтверждение здесь стояло из-за того, что перевод в «Интересные» сам ставил
    глубокий разбор в очередь: нажатие стоило денег, и о нём предупреждали.
    Разбор запускается кнопкой в карточке закупки, и переспрашивать про перенос
    стало незачем — диалог на каждое перетаскивание мешал бы разбирать выдачу.
  */
  const requestMove = (tenderId: string, status: PipelineStatus) => {
    const current = statuses[tenderId] ?? "NEW";
    if (status === current) return;
    move(tenderId, status);
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading) return <LoadingSkeleton rows={6} />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">
          Воронка работы с закупками
        </h1>
        <p className="muted mt-1">
          В работе {inWork} из {rows.length}. Переносите карточку перетаскиванием или списком
          «Перенести» на карточке; статус сохранится в этом браузере.
        </p>
        <p
          role="status"
          className={cn(
            "mt-3 inline-flex items-center gap-2 rounded-full border border-accent-line bg-accent-subtle px-3 py-1.5 text-xs text-accent-fg",
            notice === null && "hidden",
          )}
        >
          {notice}
        </p>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {PIPELINE_STATUSES.map((col) => (
          <div
            key={col}
            className={cn(
              "flex w-[272px] shrink-0 flex-col rounded-card border bg-panel-raised/60 transition-colors",
              dragOver === col
                ? "border-accent bg-accent-subtle"
                : "border-border",
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(col);
            }}
            onDragLeave={() => setDragOver((c) => (c === col ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/tender-id");
              if (id) requestMove(id, col);
            }}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-3">
              <span className="text-[14.5px] font-semibold tracking-tight text-foreground">
                {pipelineLabels[col]}
              </span>
              {/* Счётчик в плашке: колонка без карточек всё равно обязана
                  сообщать свой размер, а «0» простым текстом теряется. */}
              <span className="num rounded-full border border-border bg-panel px-2 py-[1px] text-[12.5px] text-muted-foreground">
                {grouped[col].length}
              </span>
            </div>
            <div className="max-h-[calc(100vh-16rem)] min-h-[120px] space-y-2 overflow-y-auto p-2">
              {grouped[col].map((r) => {
                const status = statuses[r.tender.id] ?? "NEW";
                const suggested =
                  col === "NEW" && r.analysis.verdict === "RECOMMENDED";
                return (
                  <div
                    key={r.tender.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/tender-id", r.tender.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className="cursor-grab rounded-control border border-border bg-panel p-3 shadow-card transition-shadow hover:border-border-strong hover:shadow-card-hover active:cursor-grabbing"
                  >
                    <Link
                      href={`/tenders/${r.tender.id}`}
                      className="text-[14px] font-medium leading-snug text-foreground hover:text-accent-fg line-clamp-2"
                    >
                      {r.tender.subject}
                    </Link>
                    <p className="muted text-[12.5px] mt-1">
                      {formatTenderPrice(r.tender.financial.price)} · до{" "}
                      {formatDate(r.tender.deadlines.submissionEnd)}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <FitScore value={r.analysis.fitScore} size="md" />
                      <VerdictBadge verdict={r.analysis.verdict} short />
                    </div>
                    {suggested && (
                      <p className="mt-1.5 text-[12.5px] font-medium text-accent-fg">
                        Рекомендуем разобрать → «Интересные»
                      </p>
                    )}
                    <div className="mt-1.5">
                      <label
                        className="sr-only"
                        htmlFor={`move-${r.tender.id}`}
                      >
                        Перенести закупку «{r.tender.subject}» в другую колонку
                      </label>
                      <select
                        id={`move-${r.tender.id}`}
                        className="w-full rounded-control border border-border bg-panel px-2 py-1 text-[12.5px] text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/25"
                        value={status}
                        onChange={(e) =>
                          requestMove(r.tender.id, e.target.value as PipelineStatus)
                        }
                      >
                        {PIPELINE_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s === "INTERESTING" && suggested
                              ? `${pipelineLabels[s]} (рекомендуется)`
                              : pipelineLabels[s]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
              {grouped[col].length === 0 && (
                <p className="muted px-1 py-4 text-center text-xs">{COLUMN_HINTS[col]}</p>
              )}
              {col === "NEW" && grouped[col].length > 0 && (
                <p className="muted px-1 pb-1 text-center text-[12.5px]">
                  {pluralRu(grouped[col].length, [
                    "закупка в очереди",
                    "закупки в очереди",
                    "закупок в очереди",
                  ])}
                  , отсортировано по fit
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
