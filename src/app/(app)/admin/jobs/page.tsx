"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ProcessingJob } from "@/domain/entities";
import { jobsRepository } from "@/repositories/jobsRepository";
import { Badge, Button, Card, ProgressBar } from "@/components/ui/primitives";
import { KonturSyncPanel } from "@/components/admin/KonturSyncPanel";
import { WorkerQueuePanel } from "@/components/admin/WorkerQueuePanel";
import { formatDateTime } from "@/utils/format";
import { jobStatusLabels, jobTypeLabels } from "@/lib/labels";

const statusTone: Record<ProcessingJob["status"], "neutral" | "accent" | "olive" | "brick"> = {
  QUEUED: "neutral",
  RUNNING: "accent",
  SUCCEEDED: "olive",
  FAILED: "brick",
};

/**
 * Служебная страница. В меню её нет: обычному пользователю здесь делать нечего,
 * а платный запуск Контур.Закупок без ролевой модели показывать всем нельзя.
 *
 * Журнал ниже честный: записи появляются только тогда, когда действительно
 * что-то сделано (сейчас это добавление своей закупки). Кнопки «повторить»
 * здесь нет — повторный запуск рисовал бы успешное задание, не выполняя его.
 *
 * Очередь заданий сервера в России показана только на чтение. Кнопки «поставить
 * задание» здесь нет по той же причине, по которой страница убрана из меню:
 * ролевой модели нет, а полный прогон — это минуты работы и расход платного
 * источника, если прошло больше шести часов с предыдущего.
 */
export default function AdminJobsPage() {
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);

  const refresh = () => setJobs(jobsRepository.getAll());

  useEffect(refresh, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Журнал фоновых процессов</h1>
          <p className="muted mt-1">
            Расход платного API Контур.Закупок и запуск синхронизации вручную — вверху.
            Ниже состояние сервера в России: он скачивает документацию к закупкам и
            выполняет плановый прогон, поэтому очередь заданий и её журнал показаны там же.
            В самом нижнем журнале — действия, выполненные в браузере (сейчас это
            добавление своей закупки); прогон и очередь в него не пишут.
          </p>
        </div>
        <Button variant="secondary" onClick={refresh}>
          <RefreshCw className="h-4 w-4" /> Обновить журнал
        </Button>
      </div>

      <KonturSyncPanel />

      <WorkerQueuePanel />

      <Card>
        {jobs.length === 0 ? (
          <p className="muted">Записей пока нет.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-sm">
              <thead>
                <tr className="border-b border-border text-left muted">
                  <th className="px-2 py-2 font-medium">Тип</th>
                  <th className="px-2 py-2 font-medium">Статус</th>
                  <th className="px-2 py-2 font-medium">Прогресс</th>
                  <th className="px-2 py-2 font-medium">Начало</th>
                  <th className="px-2 py-2 font-medium">Завершение</th>
                  <th className="px-2 py-2 font-medium">Сообщение</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-border last:border-0">
                    <td className="px-2 py-2 whitespace-nowrap text-foreground">
                      {jobTypeLabels[j.type]}
                    </td>
                    <td className="px-2 py-2">
                      <Badge tone={statusTone[j.status]}>{jobStatusLabels[j.status]}</Badge>
                    </td>
                    <td className="px-2 py-2 w-32">
                      <ProgressBar value={j.progress} />
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap muted">
                      {formatDateTime(j.startedAt)}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap muted">
                      {j.finishedAt ? formatDateTime(j.finishedAt) : "—"}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {j.error ? (
                        <span className="text-brick-fg">{j.error}</span>
                      ) : (
                        j.message
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
