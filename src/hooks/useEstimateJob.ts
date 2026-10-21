"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { readJsonOrThrow } from "@/lib/readJson";
import { userFacingError } from "@/lib/userError";

import type { EstimateResultData } from "@/components/estimate/EstimateResult";
import type { AuditReport } from "@/domain/estimate/customerAudit";
import type { EstimateOptions } from "@/domain/estimate/estimateOptions";
import type { NotRecognizedEstimate } from "@/domain/estimate/customerLsr";

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
 *
 * Второй режим задания — аудит сметы заказчика (`useEstimateAuditJob`). В базе оба
 * лежат одним видом задания `estimate`, и различает их `payload.mode`; поэтому у
 * каждого хука свой режим в запросах, и результат одного не подменяет результат
 * другого: открытая заново карточка получает «последнюю смету» и «последний аудит»
 * по отдельности.
 */

const POLL_MS = 5000;

export type EstimateJobStatus =
  | "idle"
  | "queued"
  | "running"
  | "done"
  | "failed";

/** Результат аудита, как его отдаёт `/api/estimate`. */
export interface AuditJobData {
  readonly reports: readonly AuditReport[];
  readonly zone: { priceZoneId: number; zoneName: string; basis: string; matched: string | null; northZone: string };
  readonly period: string;
  readonly notRecognized: readonly NotRecognizedEstimate[];
}

type JobMode = "estimate" | "audit";

/** Задание в том виде, как его отдаёт `GET /api/estimate` (см. `describe` там же). */
export interface EstimateJobView {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  error: string | null;
  mode?: JobMode;
  /** Шапка открытого из списка расчёта; у ответов без этих полей (старый вид) — нет. */
  reason?: "upload" | "tender";
  tenderId?: string | null;
  subject?: string | null;
  documentNames?: readonly string[] | null;
  createdAt?: string;
  estimate: EstimateResultData | null;
  audit?: AuditJobData | null;
}

type JobView = EstimateJobView;

export interface QueuedJobState<T> {
  readonly status: EstimateJobStatus;
  /** Задание, чей результат показан: к нему привязываются правки ведомости. */
  readonly jobId: string | null;
  readonly result: T | null;
  readonly error: string | null;
  /** Задание уже стояло в очереди: второе нажатие не создало нового. */
  readonly reused: boolean;
  /** Номер поставленного задания; null — не поставилось (причина в `error`). */
  readonly start: (body: EstimateJobRequest) => Promise<string | null>;
  /**
   * Показать уже существующее задание (открыто из списка «Мои расчёты» или по ссылке `?job=`): готовое
   * выводится сразу, идущее — опрашивается до конца. Задание чужого режима молча игнорируется.
   */
  readonly show: (job: EstimateJobView) => void;
  /** Забыть показанное: открыли расчёт другого режима, и этому хуку показывать нечего. */
  readonly reset: () => void;
}

export interface EstimateJobState {
  readonly status: EstimateJobStatus;
  /** Задание, чей результат показан: к нему привязываются правки ведомости. */
  readonly jobId: string | null;
  readonly result: EstimateResultData | null;
  readonly error: string | null;
  /** Задание уже стояло в очереди: второе нажатие не создало нового. */
  readonly reused: boolean;
  /** Номер поставленного задания; null — не поставилось (причина в `error`). */
  readonly start: (body: EstimateJobRequest) => Promise<string | null>;
  /** См. `QueuedJobState.show`. */
  readonly show: (job: EstimateJobView) => void;
  /** См. `QueuedJobState.reset`. */
  readonly reset: () => void;
}

export interface EstimateJobRequest {
  readonly tenderId?: string;
  readonly subject?: string;
  readonly documents?: readonly { name: string; text: string }[];
  /** Ценовая зона, выбранная вручную; нет — воркер определяет её по закупке. */
  readonly priceZoneId?: number;
  /** Вид работ, условия производства работ и сроки (блок «Условия работ»); нет — без начислений сверх норм. */
  readonly options?: EstimateOptions;
}

// Выбор результата — функции модуля, а не стрелки в вызове: стрелка новая на каждом рендере,
// и эффект подгрузки прошлого результата перезапускался бы бесконечно.
const pickEstimate = (job: JobView): EstimateResultData | null => job.estimate;
const pickAudit = (job: JobView): AuditJobData | null => job.audit ?? null;

export function useEstimateJob(tenderId?: string): EstimateJobState {
  return useQueuedJob<EstimateResultData>(tenderId, "estimate", pickEstimate);
}

/** Аудит сметы заказчика: ставится и читается так же, но с `mode: "audit"` и своим результатом. */
export function useEstimateAuditJob(tenderId?: string): QueuedJobState<AuditJobData> {
  return useQueuedJob<AuditJobData>(tenderId, "audit", pickAudit);
}

function useQueuedJob<T>(
  tenderId: string | undefined,
  mode: JobMode,
  pick: (job: JobView) => T | null,
): QueuedJobState<T> {
  const [status, setStatus] = useState<EstimateJobStatus>("idle");
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const jobId = useRef<string | null>(null);
  const [shownJobId, setShownJobId] = useState<string | null>(null);
  const alive = useRef(true);
  /*
    Поколение опроса. Опрос — цепочка таймеров, и если пользователь открыл другой расчёт или поставил
    новый, пока прежний ещё считался, старая цепочка продолжала бы дёргать сервер и писать чужой
    статус в экран. Каждый запуск показа увеличивает поколение, а цепочка прежнего поколения
    обрывается на своём следующем шаге.
  */
  const epoch = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((job: JobView | null): boolean => {
    if (job === null) return true;
    // Чужой режим (старый ответ или общий id): результат этого хука не подменяем.
    if ((job.mode ?? "estimate") !== mode) return true;
    if (job.status === "completed") {
      const picked = pick(job);
      setShownJobId(job.id);
      setResult(picked);
      setStatus(picked === null ? "failed" : "done");
      if (picked === null) setError("Задание закрыто без результата");
      return true;
    }
    if (job.status === "failed") {
      setStatus("failed");
      setError(job.error === null ? "Расчёт не удался" : userFacingError(job.error, "Расчёт не удался — повторите через минуту."));
      return true;
    }
    setStatus(job.status === "pending" ? "queued" : "running");
    return false;
  }, [mode, pick]);

  const poll = useCallback(async (generation: number): Promise<void> => {
    const id = jobId.current;
    if (id === null || !alive.current || generation !== epoch.current) return;

    try {
      const response = await fetch(`/api/estimate?jobId=${encodeURIComponent(id)}`);
      const payload = await readJsonOrThrow<{ job?: JobView | null }>(response);
      if (!alive.current || generation !== epoch.current) return;

      const finished = apply(payload.job ?? null);
      if (!finished) setTimeout(() => void poll(generation), POLL_MS);
    } catch (err) {
      if (!alive.current || generation !== epoch.current) return;
      setStatus("failed");
      setError(userFacingError(err, "Не удалось получить результат — обновите страницу через минуту."));
    }
  }, [apply]);

  /*
    Открытая заново карточка показывает уже посчитанное. Без этого пользователь,
    вернувшийся к закупке через час, видел бы кнопку «Рассчитать смету» так,
    будто расчёта не было, и платил бы за него второй раз. Показывается последний
    расчёт самого пользователя: чужие сервер не отдаёт.
  */
  useEffect(() => {
    if (tenderId === undefined) return;
    const generation = epoch.current;
    void (async () => {
      try {
        const response = await fetch(`/api/estimate?tenderId=${tenderId}${mode === "audit" ? "&mode=audit" : ""}`);
        const payload = await readJsonOrThrow<{ job?: JobView | null }>(response);
        // Пока ответ шёл, пользователь мог уже поставить расчёт: его не затираем.
        if (!alive.current || generation !== epoch.current) return;
        const job = payload.job ?? null;
        if (job === null) return;
        jobId.current = job.id;
        const finished = apply(job);
        if (!finished) setTimeout(() => void poll(generation), POLL_MS);
      } catch {
        // Молча: это подгрузка прошлого результата, а не действие пользователя.
      }
    })();
  }, [tenderId, mode, apply, poll]);

  const start = useCallback(
    async (body: EstimateJobRequest): Promise<string | null> => {
      epoch.current += 1;
      const generation = epoch.current;
      setStatus("queued");
      setError(null);
      setResult(null);
      setShownJobId(null);
      try {
        const response = await fetch("/api/estimate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mode === "audit" ? { ...body, mode } : body),
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
        if (!finished) setTimeout(() => void poll(generation), POLL_MS);
        return payload.job.id;
      } catch (err) {
        setStatus("failed");
        setError(userFacingError(err, "Не удалось поставить задание — повторите через минуту."));
        return null;
      }
    },
    [apply, poll, mode],
  );

  const show = useCallback(
    (job: JobView): void => {
      // Чужой режим этому хуку не показывается (им займётся хук второго режима).
      if ((job.mode ?? "estimate") !== mode) return;
      epoch.current += 1;
      const generation = epoch.current;
      jobId.current = job.id;
      setResult(null);
      setShownJobId(null);
      setError(null);
      setReused(false);
      const finished = apply(job);
      if (!finished) setTimeout(() => void poll(generation), POLL_MS);
    },
    [apply, poll, mode],
  );

  const reset = useCallback((): void => {
    epoch.current += 1;
    jobId.current = null;
    setStatus("idle");
    setResult(null);
    setShownJobId(null);
    setError(null);
    setReused(false);
  }, []);

  return { status, jobId: shownJobId, result, error, reused, start, show, reset };
}
