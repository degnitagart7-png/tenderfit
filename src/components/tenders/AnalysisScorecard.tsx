"use client";

import type { ScorecardItem, ScorecardStatus } from "@/domain/analysisDigest";
import { cn } from "@/lib/cn";

/**
 * Скоркарта глубокого анализа: шесть направлений плитками со светофором.
 *
 * Зачем. Три «ключевых числа» не говорили ни про сроки, ни про деньги, ни про то, где
 * именно плохо. Здесь по плитке на направление: слева цвет статуса, название мелко,
 * значение крупно, одна строка пояснения. Клик ведёт к секции с подробностями — как
 * в Lighthouse: сначала светофор, потом причины.
 */

/** Светофор — точка и цвет значения; рамок, полос и плашек нет. */
const STATUS_DOT: Record<ScorecardStatus, string> = {
  good: "bg-olive",
  warn: "bg-mustard",
  bad: "bg-brick",
  neutral: "bg-border-strong",
};

const STATUS_TEXT: Record<ScorecardStatus, string> = {
  good: "text-olive-fg",
  warn: "text-mustard-fg",
  bad: "text-brick-fg",
  neutral: "text-foreground",
};

/** Цвет не единственный носитель смысла: тот же статус словами — для читалок экрана. */
const STATUS_LABEL: Record<ScorecardStatus, string> = {
  good: "всё в порядке",
  warn: "есть что проверить",
  bad: "мешает участию",
  neutral: "нет данных",
};

export function AnalysisScorecard({
  items,
  onSelect,
}: {
  items: readonly ScorecardItem[];
  /** Плитка выбрана: панель открывает «Выводы» и прокручивает к секции `anchor`. */
  onSelect: (anchor: string) => void;
}) {
  return (
    // Сетка ячеек, разделённых волосяными линиями (фон-просвет между ячейками), — без карточек.
    <div
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-3"
      data-testid="scorecard"
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelect(item.anchor)}
          data-testid={`scorecard-${item.key}`}
          data-status={item.status}
          className="min-w-0 bg-panel px-4 py-3.5 text-left transition-colors hover:bg-panel-raised"
        >
          <span className="flex items-center gap-2 text-[13px] text-faint">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[item.status])} aria-hidden />
            {item.title}
            <span className="sr-only">: {STATUS_LABEL[item.status]}</span>
          </span>
          <span
            className={cn(
              "mt-1 block break-words text-[15px] font-semibold leading-snug tracking-tight sm:text-[17px]",
              STATUS_TEXT[item.status],
            )}
          >
            {item.value}
          </span>
          {item.note !== "" && (
            <span className="mt-0.5 block line-clamp-2 text-[13px] text-muted-foreground lg:truncate" title={item.note}>
              {item.note}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
