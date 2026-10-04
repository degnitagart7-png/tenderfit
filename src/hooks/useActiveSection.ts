"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Активный раздел длинной страницы: Intersection Observer + учёт клика.
 *
 * Полоса наблюдения смещена сверху на headerOffsetPx (sticky-хедер не должен
 * «съедать» заголовок раздела) и снизу на 55% вьюпорта: пересечение её границ —
 * сигнал пересчитать активный раздел; пассивный scroll-слушатель нужен, чтобы
 * подсветка не залипала у конца страницы, где границ больше нет.
 *
 * Правила выбора:
 *  - обычный случай — последний раздел, заголовок которого прошёл линию
 *    headerOffsetPx (то есть раздел, начатый сверху экрана);
 *  - у конца страницы последние разделы физически не могут подняться к этой
 *    линии, поэтому берётся последний раздел, дошедший до середины экрана.
 *
 * Клик по пункту навигации закрепляет раздел активным до первого действия
 * пользователя: иначе короткий раздел терял бы подсветку, а переход к последнему
 * разделу страницы не подсвечивался бы вовсе. Закрепление снимается явным жестом
 * (колесо/тач/клавиатура) либо любой прокруткой после завершения программной —
 * так работает и перетаскивание ползунка скролла.
 *
 * Требует, чтобы у раздела были `id` и `data-section` с тем же значением;
 * порядок `sectionIds` задаёт приоритет при пересечении нескольких разделов.
 */
export function useActiveSection(
  sectionIds: readonly string[],
  headerOffsetPx = 80,
): { activeId: string; selectSection: (id: string) => void } {
  const [activeId, setActiveId] = useState(sectionIds[0] ?? "");
  const pinnedRef = useRef(false);
  /** Идёт ли программная прокрутка после клика (продлевается кадрами scroll). */
  const programmaticRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (sectionIds.length === 0) return;

    const recompute = () => {
      if (pinnedRef.current) return;
      const rects = sectionIds
        .map((id) => {
          const el = document.getElementById(id);
          return el ? { id, top: el.getBoundingClientRect().top } : null;
        })
        .filter((entry): entry is { id: string; top: number } => entry !== null);
      if (rects.length === 0) return;
      const atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 2;
      const line = atBottom ? window.innerHeight * 0.45 : headerOffsetPx;
      let current = rects[0]!.id;
      for (const rect of rects) {
        if (rect.top <= line) current = rect.id;
      }
      setActiveId(current);
    };

    const releasePin = () => {
      if (!pinnedRef.current) return;
      pinnedRef.current = false;
      recompute();
    };

    const clearSettleTimer = () => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };

    const onScroll = () => {
      if (programmaticRef.current) {
        // Кадры плавной прокрутки продлевают «программное» состояние.
        clearSettleTimer();
        settleTimerRef.current = window.setTimeout(() => {
          programmaticRef.current = false;
          settleTimerRef.current = null;
        }, 160);
        return;
      }
      releasePin();
      recompute();
    };

    const observer = new IntersectionObserver(() => recompute(), {
      rootMargin: `-${headerOffsetPx}px 0px -55% 0px`,
      threshold: 0,
    });
    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    recompute();

    // Явный жест снимает закрепление сразу, даже во время плавной прокрутки.
    const onGesture = () => {
      programmaticRef.current = false;
      clearSettleTimer();
      releasePin();
    };
    for (const evt of ["wheel", "touchmove", "keydown"] as const) {
      window.addEventListener(evt, onGesture, { passive: true });
    }

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      clearSettleTimer();
      for (const evt of ["wheel", "touchmove", "keydown"] as const) {
        window.removeEventListener(evt, onGesture);
      }
    };
  }, [sectionIds, headerOffsetPx]);

  /** Перейти к разделу и считать его активным до следующего действия пользователя. */
  const selectSection = useCallback((id: string) => {
    pinnedRef.current = true;
    programmaticRef.current = true;
    setActiveId(id);
    scrollIntoSection(id);
  }, []);

  return { activeId, selectSection };
}

/** Плавный переход к разделу с учётом prefers-reduced-motion. */
export function scrollIntoSection(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}
