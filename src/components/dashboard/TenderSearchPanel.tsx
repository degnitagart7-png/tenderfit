"use client";

import { KONTUR_ENABLED } from "@/domain/features";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw, ServerCog, ServerOff } from "lucide-react";
import type { SearchProfile } from "@/domain/entities";
import { konturPressPlan, type KonturPressPlan } from "@/domain/konturPressPlan";
import type { WorkerStatusView } from "@/domain/workerStatus";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { konturApiService, type KonturUsageResponse } from "@/services/konturApiService";
import { syncJobApiService } from "@/services/syncJobApiService";
import type { KonturSyncReport, TenderSyncState } from "@/hooks/useTenderData";
import { Button, Card } from "@/components/ui/primitives";
import {
  FreeRunSection,
  type FreeRunOutcome,
} from "@/components/dashboard/FreeRunSection";
import {
  KonturPressSection,
  KonturPressReport,
} from "@/components/dashboard/KonturPressSection";
import { cn } from "@/lib/cn";

interface TenderSearchPanelProps {
  /** Раскрыта ли панель подтверждения. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  syncKontur: (plan: KonturPressPlan) => Promise<KonturSyncReport | null>;
  syncState: TenderSyncState;
  /** Лента ещё грузится — кнопка в это время бессмысленна. */
  busy?: boolean;
}

/**
 * Кнопка «Найти новые закупки» и панель с двумя способами пополнить ленту.
 *
 * Основное действие — бесплатный прогон площадок на сервере с российским
 * адресом. Нажатие не опрашивает источники из браузера, а ставит задание в
 * очередь: ЕИС и её хранилище файлов зарубежным адресам не отвечают, поэтому
 * иного способа выполнить прогон нет.
 *
 * Платный поиск в Контур.Закупках показан ниже и вторичен: он стоит денег из
 * суточного тарифа и работает только пока источник настроен. Лента от него не
 * зависит — кончившаяся подписка не лишает партнёра закупок, и панель не имеет
 * права делать вид, что это единственная кнопка.
 *
 * Оба действия подтверждаются до запуска, а не после: партнёр обязан видеть и
 * состав прогона, и цену платного поиска заранее.
 */
export function TenderSearchPanel({
  open,
  onOpenChange,
  syncKontur,
  syncState,
  busy = false,
}: TenderSearchPanelProps) {
  const [profiles, setProfiles] = useState<SearchProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [usage, setUsage] = useState<KonturUsageResponse | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  // Флаг выставляется до запроса: иначе сбой чтения остатка перезапускал бы его
  // по кругу, дёргая роут на каждый рендер.
  const [usageRequested, setUsageRequested] = useState(false);

  const [worker, setWorker] = useState<WorkerStatusView | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [workerLoading, setWorkerLoading] = useState(false);
  const [workerRequested, setWorkerRequested] = useState(false);

  const [freeRunning, setFreeRunning] = useState(false);
  const [freeOutcome, setFreeOutcome] = useState<FreeRunOutcome | null>(null);

  // Профили перечитываются при каждом открытии: их правят в настройках, и
  // панель обязана показывать текущие слова, а не те, что были при загрузке.
  useEffect(() => {
    if (open) setProfiles(searchProfileRepository.getAll().filter((p) => p.enabled));
  }, [open]);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      setUsage(await konturApiService.getUsage(1));
      setUsageError(null);
    } catch (error) {
      setUsageError(error instanceof Error ? error.message : String(error));
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const loadWorker = useCallback(async () => {
    setWorkerLoading(true);
    try {
      setWorker((await syncJobApiService.getStatus(1)).view);
      setWorkerError(null);
    } catch (error) {
      setWorkerError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkerLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!KONTUR_ENABLED || !open || usageRequested) return;
    setUsageRequested(true);
    void loadUsage();
  }, [open, usageRequested, loadUsage]);

  useEffect(() => {
    if (!open || workerRequested) return;
    setWorkerRequested(true);
    void loadWorker();
  }, [open, workerRequested, loadWorker]);

  const plan = useMemo(() => konturPressPlan(profiles, selectedId), [profiles, selectedId]);
  const { syncing, report } = syncState;

  /**
   * Постановка бесплатного прогона и сразу перечитывание состояния сервера.
   *
   * Очередь изменилась, поэтому прежняя подпись («в очереди заданий: 0») стала
   * неправдой. Отказ не бросается наверх: он печатается причиной под кнопкой, а
   * расписание на сервере продолжает работать — молчание выглядело бы как
   * «лента больше не пополняется».
   */
  const runFreeSync = useCallback(async () => {
    setFreeRunning(true);
    try {
      const { deduped } = await syncJobApiService.enqueueFullSync();
      setFreeOutcome({ kind: deduped ? "deduped" : "queued" });
    } catch (error) {
      setFreeOutcome({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setFreeRunning(false);
      await loadWorker();
    }
  }, [loadWorker]);

  /**
   * Платный прогон и сразу перечитывание состояния сервера.
   *
   * Поиск ставит документацию в очередь, поэтому длина очереди и подпись
   * «на связи» после прогона меняются; показать партнёру прежние числа — значит
   * показать неправду про задание, которое он только что создал.
   */
  const runKonturSync = useCallback(
    async (selected: KonturPressPlan) => {
      await syncKontur(selected);
      await loadWorker();
    },
    [syncKontur, loadWorker],
  );

  /*
    `foreign_exit` считается ответом: сервер работает и задание выполнит, а то,
    что документация при этом не загрузится, названо в подписи состояния ниже.
    Не отвечают только `unknown` (сервер ни разу не выходил на связь) и `stale`
    (отметка времени устарела или не читается).
  */
  const serverAnswers =
    worker === null ? null : worker.state !== "unknown" && worker.state !== "stale";

  return (
    <div className={cn("flex flex-col items-end gap-3", open && "w-full")}>
      <Button
        onClick={() => onOpenChange(!open)}
        disabled={busy || syncing}
        aria-expanded={open}
        aria-controls="tender-search-panel"
      >
        <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
        {syncing ? (syncState.progress ?? "Ищем новые закупки…") : "Найти новые закупки"}
      </Button>

      {open && (
        <div id="tender-search-panel" className="w-full">
          <Card title="Поиск новых закупок" className="w-full">
            <div className="space-y-3">
              <WorkerNote
                view={worker}
                loading={workerLoading}
                error={workerError}
                onRetry={() => void loadWorker()}
              />

              <FreeRunSection
                running={freeRunning}
                disabled={syncing}
                outcome={freeOutcome}
                serverAnswers={serverAnswers}
                onRun={() => void runFreeSync()}
              />

              {KONTUR_ENABLED && (
                <KonturPressSection
                  profiles={profiles}
                  plan={plan}
                  usage={usage}
                  usageLoading={usageLoading}
                  usageError={usageError}
                  syncing={syncing}
                  onSelectProfile={setSelectedId}
                  onRun={(selected) => void runKonturSync(selected)}
                  onCancel={() => onOpenChange(false)}
                />
              )}

              {KONTUR_ENABLED && report && (
                <KonturPressReport report={report} at={syncState.lastSynced} />
              )}

              {/* Вход на страницу своей закупки: из меню она убрана, а эта панель
                  открывается там, где человек пополняет ленту. */}
              <p className="text-[13.5px] text-muted-foreground">
                Нашли закупку сами?{" "}
                <Link
                  href="/tenders/import"
                  className="text-accent-fg underline-offset-2 hover:underline"
                >
                  Добавить закупку вручную
                </Link>
              </p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/**
 * Состояние сервера, который выполняет прогон и качает документацию.
 *
 * Читается с сервера, а не выводится из наличия закупок в ленте: молчащая машина
 * выглядит как «всё хорошо» ровно до момента, когда партнёр ждёт разбор. Подпись
 * приходит готовой из домена (`describeWorkerStatus`), поэтому формулировки
 * одинаковы здесь и в панели администратора и проверены тестами.
 *
 * Сбой чтения не прячется: показывается причина и кнопка «Повторить», иначе
 * «нет данных» неотличимо от «сервер не запущен».
 *
 * Раздел стоит первым: бесплатный прогон выполняет именно этот сервер, и
 * партнёр обязан увидеть его состояние до нажатия, а не после.
 */
function WorkerNote({
  view,
  loading,
  error,
  onRetry,
}: {
  view: WorkerStatusView | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const online = view?.state === "online";

  return (
    <div
      // Когда сервер на связи, пояснение не нужно: оно в подсказке. Предупреждение
      // о неполадке остаётся напечатанным.
      title={online ? view?.hint : undefined}
      className={cn(
        "flex items-start gap-2 rounded-control border px-3 py-2",
        online || view === null ? "border-border" : "border-mustard/40",
      )}
    >
      {online ? (
        <ServerCog className="mt-0.5 h-4 w-4 shrink-0 text-faint" aria-hidden />
      ) : (
        <ServerOff className="mt-0.5 h-4 w-4 shrink-0 text-mustard-fg" aria-hidden />
      )}
      <div className="min-w-0 space-y-1">
        {loading && view === null && !error && (
          <p className="text-[13.5px] text-faint">Проверяем подключение…</p>
        )}
        {error ? (
          <div className="space-y-1.5">
            <p className="text-[13.5px] text-muted-foreground">
              Сервер не проверен: {error}
            </p>
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Повторить
            </Button>
          </div>
        ) : (
          view && (
            <>
              <p className="text-[13.5px] font-medium text-foreground">{view.label}</p>
              {!online && <p className="text-[13.5px] text-muted-foreground">{view.hint}</p>}
            </>
          )
        )}
      </div>
    </div>
  );
}
