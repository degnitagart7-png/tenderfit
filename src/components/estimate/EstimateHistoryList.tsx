"use client";

import Link from "next/link";

import { Badge, Button } from "@/components/ui/primitives";
import {
  MODE_LABELS,
  STATUS_LABELS,
  historyFilesLine,
  historyTitle,
  type EstimateHistoryItem,
  type EstimateHistoryStatus,
} from "@/domain/estimate/estimateHistory";
import type { EstimateHistoryState } from "@/hooks/useEstimateHistory";
import { cn } from "@/lib/cn";
import { formatCurrency, formatDateTime } from "@/utils/format";

/**
 * «Мои расчёты»: список расчётов сметы человека под формой, от нового к старому.
 *
 * Зачем он нужен. Результат расчёта жил только на экране: закрыл вкладку или поставил второй расчёт —
 * прежний пропадал из виду, хотя в базе лежал, а письмо «смета готова» вело на пустую форму. Теперь
 * каждый расчёт — строка со временем, объектом, статусом и суммой; нажатие открывает результат на этой
 * же странице (адрес с `?job=…`, его можно сохранить и отправить себе).
 *
 * Список личный: сервер отдаёт только расчёты того, кто вошёл (см. `/api/estimate/history`).
 */

const STATUS_TONE: Record<EstimateHistoryStatus, "olive" | "mustard" | "brick" | "neutral"> = {
  pending: "neutral",
  processing: "mustard",
  completed: "olive",
  failed: "brick",
};

interface Props {
  readonly history: EstimateHistoryState;
  /** Расчёт, открытый на странице: строка подсвечена. */
  readonly selectedId: string | null;
  readonly onOpen: (id: string) => void;
}

function Row({ item, selected, onOpen }: { item: EstimateHistoryItem; selected: boolean; onOpen: (id: string) => void }) {
  const files = historyFilesLine(item);
  const title = historyTitle(item);
  return (
    <li
      data-testid="estimate-history-item"
      data-job-id={item.id}
      className={cn("-mx-2 rounded-control px-2 py-3", selected && "bg-accent-subtle")}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          aria-label={`Открыть расчёт: ${title}`}
          onClick={() => onOpen(item.id)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-[14.5px] font-medium text-foreground">{title}</span>
          <span className="muted mt-0.5 block text-[13px]">
            {formatDateTime(item.createdAt)} · {MODE_LABELS[item.mode]}
          </span>
          {files !== null && <span className="muted block truncate text-[13px]">{files}</span>}
        </button>
        <div className="shrink-0 space-y-0.5 text-right">
          <Badge tone={STATUS_TONE[item.status]} className="text-[13px]">
            {STATUS_LABELS[item.status]}
          </Badge>
          {item.totalRub !== null && (
            <span className="num block text-[13.5px] text-foreground" data-testid="estimate-history-total">
              {formatCurrency(item.totalRub)}
            </span>
          )}
        </div>
      </div>
      {item.status === "failed" && item.error !== null && <p className="mt-1 text-[13px] text-brick-fg">{item.error}</p>}
      {item.tenderId !== null && (
        <Link
          href={`/tenders/${encodeURIComponent(item.tenderId)}?tab=analysis`}
          className="mt-1 inline-block text-[13px] text-accent-fg underline-offset-2 hover:underline"
        >
          Закупка {item.tenderId}
        </Link>
      )}
    </li>
  );
}

export function EstimateHistoryList({ history, selectedId, onOpen }: Props) {
  // Пока первая страница не пришла, раздел не рисуется: «пусто» в этот момент было бы неправдой.
  if (!history.loaded) return null;
  if (history.items.length === 0 && history.error === null) return null;

  return (
    <section className="card p-5 sm:p-6" aria-labelledby="estimate-history-title" data-testid="estimate-history">
      <h2 id="estimate-history-title" className="text-[15.5px] font-semibold tracking-tight text-foreground">
        Мои расчёты
      </h2>
      <p className="muted mt-0.5 text-[13.5px]">От нового к старому. Нажмите на расчёт, чтобы открыть результат.</p>

      {history.items.length > 0 && (
        <ul className="mt-2 divide-y divide-border">
          {history.items.map((item) => (
            <Row key={item.id} item={item} selected={item.id === selectedId} onOpen={onOpen} />
          ))}
        </ul>
      )}

      {history.error !== null && (
        <p className="mt-2 text-sm text-brick-fg" role="alert">
          {history.error}
        </p>
      )}

      {history.hasMore && (
        <div className="mt-3">
          <Button variant="secondary" size="sm" disabled={history.loadingMore} onClick={() => void history.loadMore()}>
            {history.loadingMore ? "Загружаем…" : "Показать ещё"}
          </Button>
        </div>
      )}
    </section>
  );
}
