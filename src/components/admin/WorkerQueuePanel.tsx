"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ServerCog, ServerOff } from "lucide-react";
import { describeSyncJobReport } from "@/domain/syncJobReport";
import type { WorkerState } from "@/domain/workerStatus";
import {
  syncJobApiService,
  type SyncJobsStatusResponse,
} from "@/services/syncJobApiService";
import { Badge, Button, Card, Counter } from "@/components/ui/primitives";
import { formatDateTime } from "@/utils/format";
import {
  syncJobKindLabels,
  syncJobReasonLabels,
  syncJobStatusLabels,
} from "@/lib/labels";
import type { SyncJobRow } from "@/types/database";

/** Сколько заданий показываем в журнале: потолок совпадает с серверным. */
const RECENT_LIMIT = 20;

function stateTone(state: WorkerState): "olive" | "mustard" | "brick" | "neutral" {
  if (state === "online") return "olive";
  // Зарубежный выход — не «внимание», а поломка: ЕИС не отвечает таким адресам,
  // и документация не загрузится, пока выход не сменится.
  if (state === "foreign_exit") return "brick";
  if (state === "stale") return "mustard";
  return "neutral";
}

function statusTone(status: SyncJobRow["status"]): "olive" | "mustard" | "brick" | "neutral" {
  if (status === "completed") return "olive";
  if (status === "failed") return "brick";
  if (status === "processing") return "mustard";
  return "neutral";
}

/** Подпись причины задания; неизвестную показываем как пришла из базы. */
function reasonLabel(reason: string | undefined): string | null {
  if (!reason) return null;
  return syncJobReasonLabels[reason] ?? reason;
}

/**
 * Панель сервера в России и очереди заданий.
 *
 * Зачем она нужна владельцу: документацию к закупкам и плановый прогон делает
 * машина с российским адресом — ЕИС и её хранилище файлов не отвечают
 * зарубежным. Без этой панели «документации нет» неотличимо от «сервер не
 * запущен», «сменился выход в сеть» и «задание упало с ошибкой», а проверить
 * это можно только по SSH.
 *
 * Панель только читает. Задания ставят кнопка «Найти новые закупки» (прогон по
 * бесплатным площадкам), платный поиск той же панели (документацию найденных
 * закупок ставит сервер внутри `POST /api/kontur/sync`) и сам сервер по
 * расписанию; намеренно нет кнопки запуска отсюда — страница доступна любому
 * вошедшему, а ролевой модели в приложении нет. Ручной прогон делается на
 * сервере: `npx tsx scripts/worker.ts --job` или `--full-sync`.
 */
export function WorkerQueuePanel() {
  const [data, setData] = useState<SyncJobsStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await syncJobApiService.getStatus(RECENT_LIMIT));
      setError(null);
    } catch (cause) {
      // Текст причины из ответа роута: он различает «Supabase не настроен» и
      // «миграция очереди не применена», и обе лечатся по-разному.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const heartbeat = data?.status.heartbeat ?? null;
  const lastJob = data?.status.lastJob ?? null;

  return (
    <Card
      title="Сервер в России и очередь заданий"
      actions={
        <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          Обновить
        </Button>
      }
    >
      {error && (
        <div className="mb-3 rounded border border-brick/40 px-3 py-2">
          <p className="text-sm text-brick-fg" role="alert">
            Состояние сервера не прочитано: {error}
          </p>
          <Button className="mt-2" size="sm" variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        </div>
      )}

      {loading && !data ? (
        <p className="muted">Читаем состояние сервера…</p>
      ) : data ? (
        <>
          <div className="flex items-start gap-3">
            {data.view.state === "online" ? (
              <ServerCog className="mt-0.5 h-5 w-5 shrink-0 text-olive-fg" aria-hidden />
            ) : (
              <ServerOff className="mt-0.5 h-5 w-5 shrink-0 text-mustard-fg" aria-hidden />
            )}
            <div>
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                {data.view.label}
                <Badge tone={stateTone(data.view.state)} dot={false}>
                  {data.workerId}
                </Badge>
              </p>
              <p className="muted mt-1 text-sm">{data.view.hint}</p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Counter
              label="Ждёт в очереди"
              value={String(data.status.pending)}
              tone={data.status.pending > 0 ? "warning" : "default"}
            />
            <Counter
              label="Последний пульс"
              value={heartbeat ? formatDateTime(heartbeat.last_seen_at) : "—"}
            />
            <Counter
              label="Прогон по расписанию"
              value={
                heartbeat?.last_full_sync_at
                  ? formatDateTime(heartbeat.last_full_sync_at)
                  : "ещё не выполнялся"
              }
            />
            <Counter
              label="Выход в сеть"
              value={
                heartbeat?.exit_ip
                  ? `${heartbeat.exit_ip}${heartbeat.exit_country ? ` (${heartbeat.exit_country})` : ""}`
                  : "не определён"
              }
              tone={data.view.state === "foreign_exit" ? "danger" : "default"}
            />
            <Counter
              label="Код на сервере"
              value={heartbeat?.version ?? "не сообщён"}
            />
          </div>

          {lastJob ? (
            <p className="muted mt-3 text-sm">
              Последнее задание: {syncJobKindLabels[lastJob.kind]} ·{" "}
              {syncJobStatusLabels[lastJob.status]} · {describeSyncJobReport(lastJob.report)}
              {lastJob.error ? <span className="text-brick-fg"> · {lastJob.error}</span> : null}
            </p>
          ) : (
            <p className="muted mt-3 text-sm">
              Заданий ещё не выполнялось: очередь пуста или сервер не успел её разобрать.
            </p>
          )}

          <div className="mt-4 border-t border-border pt-3">
            <h3 className="label mb-2">Журнал заданий</h3>
            {data.recent.length === 0 ? (
              <p className="muted">
                Заданий пока нет. Прогон по бесплатным площадкам ставит кнопка «Найти
                новые закупки», документацию найденных закупок — платный поиск той же
                панели (это задание ставит сервер, а не браузер); плановый прогон сервер
                делает по расписанию и в этот журнал тоже пишет. Если список пуст, хотя
                прогон был, миграция очереди (20260925000004_add_sync_jobs.sql) не
                применена.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left muted">
                      <th className="px-2 py-2 font-medium">Поставлено</th>
                      <th className="px-2 py-2 font-medium">Задание</th>
                      <th className="px-2 py-2 font-medium">Статус</th>
                      <th className="px-2 py-2 font-medium">Закупок</th>
                      <th className="px-2 py-2 font-medium">Исход</th>
                      <th className="px-2 py-2 font-medium">Завершено</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((job) => {
                      const reason = reasonLabel(job.payload?.reason);
                      return (
                        <tr key={job.id} className="border-b border-border last:border-0">
                          <td className="num whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                            {formatDateTime(job.created_at)}
                          </td>
                          <td className="px-2 py-1.5 text-foreground">
                            {syncJobKindLabels[job.kind]}
                            {reason ? <span className="muted block text-xs">{reason}</span> : null}
                          </td>
                          <td className="px-2 py-1.5">
                            <Badge tone={statusTone(job.status)} dot={false}>
                              {syncJobStatusLabels[job.status]}
                              {job.attempts > 1 ? ` · попытка ${job.attempts}` : ""}
                            </Badge>
                          </td>
                          <td className="num px-2 py-1.5 text-muted-foreground">
                            {job.kind === "documents"
                              ? String(job.payload?.regNumbers?.length ?? 0)
                              : "—"}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">
                            {job.error ? (
                              <span className="text-brick-fg">{job.error}</span>
                            ) : job.status === "completed" ? (
                              describeSyncJobReport(job.report)
                            ) : (
                              <span className="text-faint">—</span>
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                            {job.finished_at ? formatDateTime(job.finished_at) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </Card>
  );
}
