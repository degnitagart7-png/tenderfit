"use client";

import { useEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/cn";

export type TenderNavSection = { id: string; label: string };

export type TenderNavGroup = {
  title: string;
  sections: TenderNavSection[];
};

/** Все разделы групп одним плоским списком (для мобильного бара). */
export function flattenNavGroups(groups: TenderNavGroup[]): TenderNavSection[] {
  return groups.flatMap((g) => g.sections);
}

/**
 * Держит активный пункт в поле зрения навигации: без этого при прокрутке
 * длинного списка текущий раздел уходит за край сайдбара/бара.
 *
 * Прокручиваем только сам контейнер навигации (scrollTop/scrollLeft), а не
 * через scrollIntoView: последний прокручивает и страницу, что конфликтует с
 * плавным переходом по якорю.
 */
function useKeepActiveVisible(
  ref: RefObject<HTMLElement | null>,
  activeId: string,
  axis: "y" | "x",
) {
  useEffect(() => {
    const nav = ref.current;
    if (!nav || !activeId) return;
    const item = nav.querySelector<HTMLElement>(`[data-nav-item="${activeId}"]`);
    if (!item) return;
    const navRect = nav.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (axis === "y") {
      if (itemRect.top < navRect.top) {
        nav.scrollTop -= navRect.top - itemRect.top + 8;
      } else if (itemRect.bottom > navRect.bottom) {
        nav.scrollTop += itemRect.bottom - navRect.bottom + 8;
      }
      return;
    }
    if (itemRect.left < navRect.left) {
      nav.scrollLeft -= navRect.left - itemRect.left + 12;
    } else if (itemRect.right > navRect.right) {
      nav.scrollLeft += itemRect.right - navRect.right + 12;
    }
  }, [ref, activeId, axis]);
}


/**
 * Sticky-навигация по разделам карточки закупки (десктоп, ≥1024px).
 * Активный раздел: акцентный текст + вертикальная линия 2px слева.
 */
export function TenderSectionNav({
  groups,
  activeId,
  onNavigate,
}: {
  groups: TenderNavGroup[];
  activeId: string;
  onNavigate: (id: string) => void;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  useKeepActiveVisible(navRef, activeId, "y");

  return (
    <nav
      ref={navRef}
      aria-label="Разделы карточки закупки"
      className="sticky top-[68px] max-h-[calc(100vh-84px)] w-[200px] shrink-0 overflow-y-auto pb-6 hidden lg:block"
    >
      <ul className="space-y-5">
        {groups.map((group) => (
          <li key={group.title}>
            <p className="mb-1.5 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {group.title}
            </p>
            <ul className="space-y-0.5">
              {group.sections.map((section) => {
                const active = section.id === activeId;
                return (
                  <li key={section.id}>
                    <button
                      type="button"
                      data-nav-item={section.id}
                      onClick={() => onNavigate(section.id)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "w-full rounded-control px-3 py-1.5 text-left text-[15px] transition-colors duration-150",
                        active
                          ? "bg-accent-subtle font-medium text-accent-fg"
                          : "text-muted-foreground hover:bg-panel-raised hover:text-foreground",
                      )}
                    >
                      {section.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Горизонтальный скроллируемый бар вместо сайдбара на экранах <1024px.
 * Активный раздел подчёркнут; прилипает под sticky-хедер приложения.
 */
export function TenderSectionNavMobile({
  sections,
  activeId,
  onNavigate,
}: {
  sections: TenderNavSection[];
  activeId: string;
  onNavigate: (id: string) => void;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  useKeepActiveVisible(listRef, activeId, "x");

  return (
    <nav
      aria-label="Разделы карточки закупки"
      className="sticky top-[52px] z-10 -mx-4 border-b border-border bg-panel px-4 lg:hidden"
    >
      <ul ref={listRef} className="flex gap-1.5 overflow-x-auto py-2">
        {sections.map((section) => {
          const active = section.id === activeId;
          return (
            <li key={section.id}>
              <button
                type="button"
                data-nav-item={section.id}
                onClick={() => onNavigate(section.id)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "whitespace-nowrap rounded-full border-b-2 px-3 py-1.5 text-[15px] transition-colors duration-150",
                  active
                    ? "border-accent bg-accent-subtle font-medium text-accent-fg"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {section.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
