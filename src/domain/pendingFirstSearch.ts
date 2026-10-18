/**
 * Передача «первого поиска» из «Быстрого старта» в ленту.
 *
 * Поиск на площадках запускается на экране онбординга, а следить за ним и
 * перечитывать базу по окончании должна лента — страницы разные. Задание
 * кладётся в память вкладки (не в localStorage: она нужна ровно на один
 * переход, другая вкладка и другой визит её видеть не должны), а лента при
 * открытии забирает её и стирает.
 */

export const PENDING_FIRST_SEARCH_KEY = "tenderfit.pendingFirstSearch";

export interface PendingFirstSearch {
  /** Задание поиска; null — поиск не запустился, лента только покажет причину. */
  jobId: string | null;
  startedAt: string;
  /** Слова профиля: по ним лента отличает принесённые поиском закупки. */
  queries: string[];
  problem: string | null;
}

export function savePendingFirstSearch(pending: PendingFirstSearch): void {
  try {
    sessionStorage.setItem(PENDING_FIRST_SEARCH_KEY, JSON.stringify(pending));
  } catch {
    // Память вкладки недоступна: профиль сохранён, лента подберёт закупки при ближайшем сборе.
  }
}

/** Забрать и стереть задание. null — его нет или оно испорчено. */
export function takePendingFirstSearch(): PendingFirstSearch | null {
  try {
    const raw = sessionStorage.getItem(PENDING_FIRST_SEARCH_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(PENDING_FIRST_SEARCH_KEY);
    const value = JSON.parse(raw) as Partial<PendingFirstSearch> | null;
    if (value === null || typeof value !== "object") return null;
    if (typeof value.startedAt !== "string" || !Array.isArray(value.queries)) return null;
    return {
      jobId: typeof value.jobId === "string" ? value.jobId : null,
      startedAt: value.startedAt,
      queries: value.queries.filter((q): q is string => typeof q === "string"),
      problem: typeof value.problem === "string" ? value.problem : null,
    };
  } catch {
    return null;
  }
}
