"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CompanyFitResult } from "@/domain/companyFacts/fit";
import { CompanyApiError, companyApiService } from "@/services/companyApiService";

/**
 * «Соответствие вашей компании» по закупке: запросить у сервера и держать результат.
 *
 * Автозапуск (`auto`) — когда разбор закупки готов и у человека есть факты о компании: сервер сам решает, считать ли заново
 * (кэш по отпечаткам анализа и данных компании) или отдать сохранённое, так что открытие карточки без изменений ничего не
 * стоит. Кнопка «Проверить соответствие» запускает то же вручную (в том числе когда фактов нет, а анкета заполнена);
 * «Проверить заново» (`force`) пересчитывает, не глядя на кэш.
 *
 * Сбой не роняет карточку: ошибка показывается в блоке, остальной анализ работает как раньше.
 */

export type CompanyFitStatus = "idle" | "loading" | "ready" | "error";

export interface CompanyFitState {
  status: CompanyFitStatus;
  result: CompanyFitResult | null;
  /** Результат из сохранённого: модель не вызывалась. */
  cached: boolean;
  /** Модель не ответила: показаны только проверки по правилам. */
  degraded: boolean;
  error: string | null;
}

const INITIAL: CompanyFitState = { status: "idle", result: null, cached: false, degraded: false, error: null };

export function useCompanyFit(tenderId: string, options: { auto: boolean }): CompanyFitState & { run: (force?: boolean) => Promise<void> } {
  const [state, setState] = useState<CompanyFitState>(INITIAL);
  const seq = useRef(0);

  const run = useCallback(
    async (force = false): Promise<void> => {
      const mine = ++seq.current;
      setState((previous) => ({ ...previous, status: "loading", error: null }));
      try {
        const answer = await companyApiService.fit(tenderId, force);
        if (mine !== seq.current) return;
        setState({ status: "ready", result: answer.result, cached: answer.cached, degraded: answer.degraded === true, error: null });
      } catch (error) {
        if (mine !== seq.current) return;
        setState((previous) => ({
          ...previous,
          status: "error",
          error: error instanceof CompanyApiError || error instanceof Error ? error.message : "Не удалось сверить компанию с закупкой",
        }));
      }
    },
    [tenderId],
  );

  // Другая закупка — чистое состояние: результат одной не показывается на карточке другой.
  useEffect(() => {
    seq.current += 1;
    setState(INITIAL);
  }, [tenderId]);

  useEffect(() => {
    if (options.auto) void run(false);
  }, [options.auto, run]);

  return { ...state, run };
}
