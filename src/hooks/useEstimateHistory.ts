"use client";

import { userFacingError } from "@/lib/userError";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  isHistoryItemActive,
  mergeHistory,
  type EstimateHistoryItem,
  type EstimateHistoryPage,
} from "@/domain/estimate/estimateHistory";
import { readJsonOrThrow } from "@/lib/readJson";

/**
 * Список «Мои расчёты» на экране «Смета»: страницы от нового к старому, обновление и «Показать ещё».
 *
 * Обновление (`refresh`) подтягивает первую страницу и вливает её в уже загруженное, а не
 * сбрасывает список: человек мог дойти до третьей страницы, а только что поставленный расчёт
 * должен появиться сверху, не стерев прочитанное. Курсор «дальше» при этом остаётся прежним.
 *
 * Пока в списке есть идущий расчёт (в очереди или считается), список сам перечитывается раз в
 * 15 секунд: расчёт могли поставить с другой вкладки или оставить идти, закрыв экран. Тот, что
 * ведёт этот экран, обновляет список по смене своего состояния (`refresh` зовёт сам экран).
 */

const REFRESH_ACTIVE_MS = 15_000;

interface State {
  readonly items: readonly EstimateHistoryItem[];
  /** Значение `before` для «Показать ещё»; null — загружено всё. */
  readonly cursor: string | null;
  /** Первая страница уже приходила: до этого пустой список — «ещё не знаем», а не «расчётов нет». */
  readonly loaded: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
}

const INITIAL: State = { items: [], cursor: null, loaded: false, loadingMore: false, error: null };

export interface EstimateHistoryState {
  readonly items: readonly EstimateHistoryItem[];
  readonly loaded: boolean;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  /** Перечитать первую страницу и влить её в список. */
  readonly refresh: () => Promise<void>;
  /** Следующая (более старая) страница. */
  readonly loadMore: () => Promise<void>;
}

async function fetchPage(before: string | null): Promise<EstimateHistoryPage> {
  const query = before === null ? "" : `?before=${encodeURIComponent(before)}`;
  const response = await fetch(`/api/estimate/history${query}`);
  const page = await readJsonOrThrow<Partial<EstimateHistoryPage>>(response);
  // Ответ без списка (прокси, старый сервер) — пустая страница, а не падение экрана.
  return { items: Array.isArray(page.items) ? page.items : [], nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null };
}

export function useEstimateHistory(): EstimateHistoryState {
  const [state, setState] = useState<State>(INITIAL);
  const alive = useRef(true);
  const loadingMore = useRef(false);
  const cursor = useRef<string | null>(null);
  cursor.current = state.cursor;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const page = await fetchPage(null);
      if (!alive.current) return;
      setState((current) => ({
        ...current,
        items: mergeHistory(page.items, current.items),
        // Первая загрузка берёт курсор ответа; потом он остаётся там, докуда человек долистал.
        cursor: current.loaded ? current.cursor : page.nextCursor,
        loaded: true,
        error: null,
      }));
    } catch (err) {
      if (!alive.current) return;
      setState((current) => ({ ...current, loaded: true, error: userFacingError(err, "Список расчётов не загрузился — повторите через минуту.") }));
    }
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    const before = cursor.current;
    if (before === null || loadingMore.current) return;
    loadingMore.current = true;
    setState((current) => ({ ...current, loadingMore: true }));
    try {
      const page = await fetchPage(before);
      if (!alive.current) return;
      setState((current) => ({
        ...current,
        items: mergeHistory(page.items, current.items),
        cursor: page.nextCursor,
        loadingMore: false,
        error: null,
      }));
    } catch (err) {
      if (!alive.current) return;
      setState((current) => ({ ...current, loadingMore: false, error: userFacingError(err, "Список расчётов не загрузился — повторите через минуту.") }));
    } finally {
      loadingMore.current = false;
    }
  }, []);

  const hasActive = state.items.some(isHistoryItemActive);
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void refresh(), REFRESH_ACTIVE_MS);
    return () => clearInterval(timer);
  }, [hasActive, refresh]);

  return {
    items: state.items,
    loaded: state.loaded,
    hasMore: state.cursor !== null,
    loadingMore: state.loadingMore,
    error: state.error,
    refresh,
    loadMore,
  };
}
