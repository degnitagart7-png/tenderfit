"use client";

import { useEffect, useState } from "react";
import { deepAnalysisService } from "@/services/deepAnalysisService";

/**
 * Закупки, по которым глубокий разбор уже закончен.
 *
 * Один запрос на экран, а не по запросу на закупку: и «Сегодня», и список
 * закупок показывают десятки строк сразу, и состояние разбора им нужно только
 * как отметка «готово».
 *
 * Ошибку намеренно глотаем. Это вспомогательная разметка поверх выдачи: если
 * список готовых разборов не пришёл, выдача обязана остаться рабочей, а не
 * превратиться в экран ошибки из-за галочки. Пустое множество означает «ничего
 * не отмечаем» и выглядит как «разборов пока нет» — хуже, чем правда, но
 * безопаснее, чем сломанный экран.
 */
export function useCompletedAnalyses(): {
  /** Идентификаторы закупок с готовым разбором. */
  ids: ReadonlySet<string>;
  /** Когда разбор закончился, по идентификатору закупки. */
  finishedAt: ReadonlyMap<string, string | null>;
  loading: boolean;
} {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const [finishedAt, setFinishedAt] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const completed = await deepAnalysisService.getCompleted();
        if (cancelled) return;
        setIds(new Set(completed.map((item) => item.tenderId)));
        setFinishedAt(new Map(completed.map((item) => [item.tenderId, item.finishedAt])));
      } catch {
        // Разметка необязательна: экран работает и без неё.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { ids, finishedAt, loading };
}
