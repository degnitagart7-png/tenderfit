"use client";

import type { TenderLaw } from "@/domain/enums";
import { TENDER_LAWS } from "@/domain/enums";
import type { LawCounts } from "@/domain/filtering";
import { lawLabels } from "@/lib/labels";
import { cn } from "@/lib/cn";

/**
 * Переключатель закона в строку — как в Контур.Закупках.
 *
 * Отдельный компонент, а не пункт панели фильтров: закон выбирают чаще всего и
 * первым, поэтому он вынесен над формой и всегда на виду. Счётчик рядом с
 * подписью показывает, сколько закупок даст выбор, ещё до клика.
 *
 * Выбор множественный: профиль поиска может задавать два закона сразу, и
 * одиночный переключатель молча потерял бы часть сохранённого набора. «Все»
 * сбрасывает выбор.
 */
export function LawSwitcher({
  selected,
  counts,
  laws,
  onChange,
}: {
  selected: TenderLaw[];
  counts: LawCounts;
  /** Показываемые законы: те, что есть в данных, плюс уже выбранные. */
  laws: TenderLaw[];
  onChange: (laws: TenderLaw[]) => void;
}) {
  const toggle = (law: TenderLaw) => {
    const next = new Set(selected);
    if (next.has(law)) {
      next.delete(law);
    } else {
      next.add(law);
    }
    // Порядок берём из домена, а не из истории кликов: сохранённый набор фильтров
    // должен совпадать побайтово независимо от того, как его собирали.
    onChange(TENDER_LAWS.filter((l) => next.has(l)));
  };

  return (
    <div
      role="group"
      aria-label="Закон, по которому проводится закупка"
      // Одной строкой с прокруткой внутри себя: на телефоне перенос превращал
      // «таблетку» в двухэтажный овал (проверка 24.10.2026).
      className="inline-flex max-w-full items-center gap-1 overflow-x-auto whitespace-nowrap rounded-full border border-border bg-panel p-1 shadow-card [scrollbar-width:none] [&>*]:shrink-0"
    >
      <Segment
        label="Все"
        count={counts.ALL}
        active={selected.length === 0}
        onClick={() => onChange([])}
      />
      {laws.map((law) => (
        <Segment
          key={law}
          label={lawLabels[law]}
          count={counts[law]}
          active={selected.includes(law)}
          onClick={() => toggle(law)}
        />
      ))}
    </div>
  );
}

function Segment({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[14.5px] transition-colors duration-150",
        "focus:outline-none focus:ring-2 focus:ring-accent/35",
        active
          ? "bg-ink font-medium text-white"
          : "text-muted-foreground hover:bg-panel-raised hover:text-foreground",
      )}
    >
      {label}
      {/* Счётчик в отдельной плашке: это подсказка, а не часть названия закона. */}
      <span
        className={cn(
          "num rounded-full px-1.5 py-[1px] text-[12.5px]",
          active ? "bg-white/15 text-white/90" : "bg-panel-raised text-faint",
        )}
      >
        {count}
      </span>
    </button>
  );
}
