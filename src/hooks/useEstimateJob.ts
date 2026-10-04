"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { readJsonOrThrow } from "@/lib/readJson";

import type { EstimateResultData } from "@/components/estimate/EstimateResult";

/**
 * Задание на расчёт сметы: поставить и дождаться.
 *
 * Расчёт идёт на сервере воркера минутами — модель читает документацию
 * фрагментами, — поэтому кнопка не ждёт ответа, а ставит задание в очередь.
 * Экран опрашивает состояние раз в пять секунд: чаще незачем, реже пользователь
 * начинает думать, что кнопка сломалась.
 *
 * Опрос останавливается сам, когда задание закончилось или экран закрыли:
 * таймер, переживший размонтирование, продолжал бы дёргать сервер и писать в
 * состояние, которого уже нет.
 */

const POLL_MS = 5000;

export type EstimateJobStatus =
  | "idle"
  | "queued"
  | "running"
  | "done"
  | "failed";

interface JobView {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  error: string | null;
  estimate: EstimateResultData | null;
}

export interface EstimateJobState {
  readonly status: EstimateJobStatus;
  readonly result: EstimateResultData | null;
  readonly error: string | null;
  /** Задание уже стояло в очереди: второе нажатие не создало нового. */
  readonly reused: boolean;
  readonly start: (body: EstimateJobRequest) => Promise<void>;
}

export interface EstimateJobRequest {
  readonly tenderId?: string;
  readonly subject?: string;
  readonly documents?: readonly { name: string; text: string }[];
}

export function useEstimateJob(tenderId?: string): EstimateJobState {
  const [status, setStatus] = useState<EstimateJobStatus>("idle");
  const [result, setResult] = useState<EstimateResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const jobId = useRef<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((job: JobView | null): boolean => {
    if (job === null) return true;
    if (job.status === "completed") {
      setResult(job.estimate);
      setStatus(job.estimate === null ? "failed" : "done");
      if (job.estimate === null) setError("Задание закрыто без результата");
      return true;
    }
    if (job.status === "failed") {
      setStatus("failed");
      setError(job.error ?? "Расчёт не удался");
      return true;
    }
    setStatus(job.status === "pending" ? "queued" : "running");
    return false;
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    const id = jobId.current;
    if (id === null || !alive.current) return;

    try {
      const response = await fetch(`/api/estimate?jobId=${id}`);
      const payload = await readJsonOrThrow<{ job?: JobView | null }>(response);
      if (!alive.current) return;

      const finished = apply(payload.job ?? null);
      if (!finished) setTimeout(() => void poll(), POLL_MS);
    } catch (err) {
      if (!alive.current) return;
      setStatus("failed");
      setError(err instanceof Error ? err.message : "Задание не читается");
    }
  }, [apply]);

  /*
    Открытая заново карточка показывает уже посчитанное. Без этого пользователь,
    вернувшийся к закупке через час, видел бы кнопку «Рассчитать смету» так,
    будто расчёта не было, и платил бы за него второй раз.
  */
  useEffect(() => {
    if (tenderId === undefined) return;
    void (async () => {
      try {
        const response = await fetch(`/api/estimate?tenderId=${tenderId}`);
        const payload = await readJsonOrThrow<{ job?: JobView | null }>(response);
        if (!alive.current) return;
        const job = payload.job ?? null;
        if (job === null) return;
        jobId.current = job.id;
        const finished = apply(job);
        if (!finished) setTimeout(() => void poll(), POLL_MS);
      } catch {
        // Молча: это подгрузка прошлого результата, а не действие пользователя.
      }
    })();
  }, [tenderId, apply, poll]);

  const start = useCallback(
    async (body: EstimateJobRequest): Promise<void> => {
      setStatus("queued");
      setError(null);
      setResult(null);
      try {
        const response = await fetch("/api/estimate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await readJsonOrThrow<{
          job?: JobView;
          reused?: boolean;
        }>(response);
        if (payload.job === undefined) {
          throw new Error("Ответ не содержит задания");
        }

        jobId.current = payload.job.id;
        setReused(payload.reused === true);
        const finished = apply(payload.job);
        if (!finished) setTimeout(() => void poll(), POLL_MS);
      } catch (err) {
        setStatus("failed");
        setError(err instanceof Error ? err.message : "Задание не поставлено");
      }
    },
    [apply, poll],
  );

  return { status, result, error, reused, start };
}
