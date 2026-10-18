"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Вкладки карточки закупки. Порядок — порядок на экране. */
export const TENDER_TABS = [
  { id: "main", label: "Главное" },
  { id: "analysis", label: "Анализ документов" },
  { id: "risks", label: "Риски договора" },
  { id: "docs", label: "Документы" },
] as const;

export type TenderTabId = (typeof TENDER_TABS)[number]["id"];

export const DEFAULT_TENDER_TAB: TenderTabId = "main";

const TAB_IDS: readonly string[] = TENDER_TABS.map((t) => t.id);

export function isTenderTab(value: string | null | undefined): value is TenderTabId {
  return value != null && TAB_IDS.includes(value);
}

/**
 * Куда вели якоря прежней длинной страницы с одиннадцатью разделами.
 *
 * Ссылки вида `/tenders/<id>#deep-analysis` могли уйти в закладки и письма,
 * поэтому каждый старый якорь открывает вкладку, где теперь живёт раздел.
 * `block` — свёрнутый блок внутри вкладки, который надо раскрыть, чтобы к
 * якорю можно было прокрутить.
 */
export const LEGACY_ANCHORS: Record<string, { tab: TenderTabId; block?: string }> = {
  overview: { tab: "main" },
  compliance: { tab: "main", block: "score-details" },
  operations: { tab: "main", block: "score-details" },
  evidence: { tab: "main", block: "score-details" },
  economics: { tab: "main", block: "all-terms" },
  "manual-review": { tab: "main" },
  requirements: { tab: "analysis" },
  "deep-analysis": { tab: "analysis" },
  risks: { tab: "risks" },
  documents: { tab: "docs" },
  history: { tab: "docs" },
};

/** Вкладка из адреса: `?tab=…` важнее старого якоря `#…`. */
export function resolveTabFromLocation(
  search: string,
  hash: string,
): { tab: TenderTabId; anchor: string | null; block: string | null } {
  const fromQuery = new URLSearchParams(search).get("tab");
  const anchor = hash.replace(/^#/, "");
  const legacy = anchor !== "" ? LEGACY_ANCHORS[anchor] : undefined;
  if (isTenderTab(fromQuery)) {
    return {
      tab: fromQuery,
      anchor: legacy?.tab === fromQuery ? anchor : null,
      block: legacy?.tab === fromQuery ? (legacy.block ?? null) : null,
    };
  }
  if (legacy) return { tab: legacy.tab, anchor, block: legacy.block ?? null };
  return { tab: DEFAULT_TENDER_TAB, anchor: null, block: null };
}

/** Адрес для вкладки: главная не пишется в адрес, остальные параметры сохраняются. */
export function searchForTab(currentSearch: string, tab: TenderTabId): string {
  const params = new URLSearchParams(currentSearch);
  if (tab === DEFAULT_TENDER_TAB) params.delete("tab");
  else params.set("tab", tab);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export const tabButtonId = (tab: TenderTabId): string => `tender-tab-${tab}`;
export const tabPanelId = (tab: TenderTabId): string => `tender-panel-${tab}`;

/**
 * Горизонтальные вкладки карточки под шапкой.
 *
 * Приклеены под шапкой приложения (62px) при прокрутке. На узком экране
 * полоса прокручивается вбок, сами вкладки не переносятся и не сжимаются.
 * Стрелки влево/вправо переключают вкладки, как в обычном tablist.
 */
export function TenderTabs({
  active,
  onSelect,
  counts,
}: {
  active: TenderTabId;
  onSelect: (tab: TenderTabId) => void;
  /** Короткая цифра рядом с названием: сколько внутри. */
  counts?: Partial<Record<TenderTabId, number>>;
}): ReactNode {
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = TENDER_TABS[(index + step + TENDER_TABS.length) % TENDER_TABS.length]!;
    onSelect(next.id);
    document.getElementById(tabButtonId(next.id))?.focus();
  };

  return (
    <div className="sticky top-[62px] z-10 -mx-4 border-b border-border bg-background/95 px-4 backdrop-blur-sm lg:-mx-7 lg:px-7">
      <div
        role="tablist"
        aria-label="Разделы карточки закупки"
        className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {TENDER_TABS.map((tab, i) => {
          const selected = tab.id === active;
          const count = counts?.[tab.id];
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabButtonId(tab.id)}
              aria-selected={selected}
              aria-controls={tabPanelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "relative shrink-0 whitespace-nowrap px-3.5 py-3 text-[15px] transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35",
                selected
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {count !== undefined && count > 0 && " "}
              {count !== undefined && count > 0 && (
                <span className="num ml-1.5 rounded-full bg-panel-raised px-1.5 py-[1px] text-[12.5px] text-muted-foreground">
                  {count}
                </span>
              )}
              {selected && (
                <span
                  className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent"
                  aria-hidden
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
