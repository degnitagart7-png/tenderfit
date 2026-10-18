"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/primitives";
import { WorkProgress } from "@/components/ui/WorkProgress";
import { syncJobApiService } from "@/services/syncJobApiService";
import { DEFAULT_SYNC_INTERVAL_HOURS } from "@/domain/workerSchedule";
import { syncNoteWarnings } from "@/domain/syncRunNote";
import { pluralRu } from "@/utils/format";
import type { RedactedSyncJob } from "@/domain/syncJobRedaction";

/** Как часто спрашиваем, закончился ли поиск, пока он идёт. */
const POLL_MS = 8_000;

const SEARCH_STEPS = [
  "Принимаем запрос",
  "Ищем закупки",
  "Обновляем ленту",
] as const;

type Phase = "idle" | "starting" | "running" | "done" | "error";

/** Поиск ещё идёт: задание полного прогона ждёт своей очереди или выполняется. */
function activeSearch(
  jobs: readonly RedactedSyncJob[],
): RedactedSyncJob | null {
  return (
    jobs.find(
      (job) =>
        job.kind === "full_sync" &&
        (job.status === "pending" || job.status === "processing"),
    ) ?? null
  );
}

/**
 * «Найти новые закупки» — одна кнопка, без промежуточной панели.
 *
 * Раньше кнопка только раскрывала панель, а в ней стояла вторая кнопка
 * «Запустить поиск»: человек нажимал дважды ради одного действия. Теперь нажатие
 * сразу запускает поиск и показывает, как он идёт. Перечня площадок и
 * состояния серверов здесь нет намеренно: пользователю важно, идёт ли поиск и
 * когда он закончится, а не через что он проходит. Подробности остаются в
 * служебном журнале.
 *
 * Ход поиска переживает перезагрузку страницы: при открытии спрашиваем, нет ли
 * уже идущего поиска, и показываем его, а не предлагаем запустить второй.
 *
 * Состояние вынесено в хук, а вид разделён на два места: кнопка живёт в шапке
 * справа, а ход поиска — отдельной полосой на всю ширину под шапкой. Когда
 * карточка хода стояла в правой колонке под кнопкой, она получалась узкой,
 * прижатой к краю и расталкивала всё, что ниже.
 */
/** Итог прогона для того, кто хочет показать его результат: когда прогон начался. */
export interface TendersSearchFinish {
  /** Начало прогона, ISO: у задания — его `created_at` с сервера, иначе часы браузера. */
  startedAt: string;
}

export function useTendersSearch(onFinished?: (info: TendersSearchFinish) => void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  /** Что прогон не сделал (ЕИС ограничила доступ, площадка не ответила); null — всё отработало. */
  const [warning, setWarning] = useState<string | null>(null);
  /** Последнее задание, которое мы видели идущим: по нему читаем итоговую строку. */
  const watchedJobId = useRef<string | null>(null);
  const phaseRef = useRef<Phase>("idle");
  /** Когда начался отслеживаемый прогон: по нему лента отличает новые строки от старых. */
  const startedAtRef = useRef<string | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const apply = useCallback(
    (jobs: readonly RedactedSyncJob[]) => {
      const job = activeSearch(jobs);
      if (job !== null) {
        watchedJobId.current = job.id;
        // Прогон, начатый до открытия страницы (или в другой вкладке), помнит
        // своё время сам.
        startedAtRef.current ??= job.created_at ?? new Date().toISOString();
        setStep(job.status === "pending" ? 0 : 1);
        if (phaseRef.current !== "running") move("running");
      } else if (phaseRef.current === "running") {
        // Задание исчезло из активных — поиск закончился: лента могла пополниться.
        // Итоговая строка прогона: «Готово: … · ЕИС временно ограничила доступ …».
        // Без неё человек видел «лента обновлена» и после прогона, где ЕИС не ответила ни разу.
        const finishedJob =
          jobs.find((candidate) => candidate.id === watchedJobId.current) ??
          jobs.find((candidate) => candidate.kind === "full_sync" && candidate.status === "completed");
        const warnings = syncNoteWarnings(finishedJob?.report?.note);
        setWarning(warnings.length > 0 ? warnings.join("; ") : null);
        move("done");
        const startedAt = startedAtRef.current ?? new Date().toISOString();
        startedAtRef.current = null;
        finished.current?.({ startedAt });
      }
    },
    [move],
  );

  const poll = useCallback(async () => {
    try {
      apply((await syncJobApiService.getStatus(10)).recent);
    } catch {
      // Не ответили на этот опрос — спросим в следующий: поиск от этого не остановился.
    }
  }, [apply]);

  // При открытии страницы — не идёт ли поиск уже.
  useEffect(() => {
    void poll();
  }, [poll]);

  useEffect(() => {
    if (phase !== "running") return;
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase, poll]);

  const start = async () => {
    move("starting");
    startedAtRef.current = new Date().toISOString();
    setFailure(null);
    setWarning(null);
    try {
      const { job } = await syncJobApiService.enqueueFullSync();
      watchedJobId.current = job.id;
      // Повторное нажатие вернуло уже идущее задание: считаем от его начала.
      if (job.created_at) startedAtRef.current = job.created_at;
      setStep(job.status === "processing" ? 1 : 0);
      move("running");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      move("error");
    }
  };

  return {
    phase,
    step,
    failure,
    warning,
    start,
    working: phase === "starting" || phase === "running",
  };
}

export type TendersSearch = ReturnType<typeof useTendersSearch>;

/** Кнопка в шапке и ссылка на ручной ввод под ней. */
export function NewTendersButton({
  search,
  busy = false,
}: {
  search: TendersSearch;
  busy?: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <Button
        onClick={() => void search.start()}
        disabled={busy || search.working}
        data-tour="search"
      >
        <RefreshCw
          className={`h-4 w-4 ${search.working ? "animate-spin" : ""}`}
          aria-hidden
        />
        {search.working ? "Ищем новые закупки…" : "Найти новые закупки"}
      </Button>
      {!search.working && (
        <p className="text-[13.5px] text-muted-foreground" data-tour="add-link">
          Нашли закупку сами?{" "}
          <Link
            href="/tenders/import"
            className="text-accent-fg underline-offset-2 hover:underline"
          >
            Добавить по ссылке
          </Link>
        </p>
      )}
    </div>
  );
}

/** Ход поиска, итог или отказ — полосой на всю ширину под шапкой. */
export function NewTendersStatus({ search }: { search: TendersSearch }) {
  if (search.phase === "running" || search.phase === "starting") {
    return (
      <div className="rounded-card border border-border bg-panel p-5">
        <WorkProgress
          title="Ищем новые закупки"
          hint="Поиск идёт в фоне и может занять десятки минут. Можно продолжать работу — лента обновится сама."
          steps={SEARCH_STEPS}
          current={search.step}
        />
      </div>
    );
  }
  if (search.phase === "done") {
    if (search.warning !== null) {
      return (
        <p className="text-[14px] text-mustard-fg" role="status">
          Поиск завершён, но лента обновлена не полностью: {search.warning}.
        </p>
      );
    }
    return (
      <p className="text-[14px] text-muted-foreground">
        Поиск завершён — лента обновлена.
      </p>
    );
  }
  if (search.phase === "error") {
    return (
      <p
        className="text-[14px] text-brick-fg"
        title={search.failure ?? undefined}
      >
        Не удалось запустить поиск. Попробуйте ещё раз — лента также обновляется
        сама каждые {DEFAULT_SYNC_INTERVAL_HOURS}{" "}
        {pluralRu(DEFAULT_SYNC_INTERVAL_HOURS, ["час", "часа", "часов"])}.
      </p>
    );
  }
  return null;
}
