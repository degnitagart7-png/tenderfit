import type { WorkerStatusView } from "@/domain/workerStatus";
import type { RedactedSyncJob } from "@/domain/syncJobRedaction";
import type { WorkerHeartbeatRow } from "@/types/database";

/**
 * Клиентский сервис очереди заданий: обращения к /api/sync-jobs.
 *
 * Очередь читает и пишет Supabase на сервере (service role key), поэтому отсюда
 * только транспорт и типы. Задание на документацию по номерам закупок ставит не
 * клиент, а сервер внутри `POST /api/kontur/sync`: номера известны ему и не
 * обязаны делать круг через браузер. А прогон по кнопке «Найти новые закупки»
 * ставится отсюда — номеров у него нет, есть только команда «опросить источники
 * заново».
 */

/**
 * Состояние воркера в журнале: последнее задание уже вычищено.
 *
 * Отдельный тип, а не `WorkerStatus`, потому что роут отдаёт не строку из базы,
 * а её копию без текстов присланных документов. Если объявить здесь `WorkerStatus`,
 * компилятор разрешит панели читать `payload.documents[].text` — и она получила бы
 * `undefined` на месте строки, которую тип обещал. Разницу обязан ловить компилятор,
 * а не партнёр на экране.
 */
export interface RedactedWorkerStatus {
  /** null — сервер ни разу не выходил на связь (таблица пуста). */
  heartbeat: WorkerHeartbeatRow | null;
  lastJob: RedactedSyncJob | null;
  /** Сколько заданий ждёт в очереди. */
  pending: number;
}

/** Ответ GET /api/sync-jobs. */
export interface SyncJobsStatusResponse {
  /** Заданы ли переменные Supabase на сервере. */
  configured: boolean;
  /** Имя воркера, чей пульс читает прод. */
  workerId: string;
  /** Момент наблюдения: подпись состояния зависит от него. */
  now: string;
  /** Пульс, последнее задание и длина очереди; задания — без текстов документов. */
  status: RedactedWorkerStatus;
  /** Готовая подпись для интерфейса — собрана в домене и проверена тестами. */
  view: WorkerStatusView;
  /** Журнал последних заданий; документы в нём — только имя и размер. */
  recent: RedactedSyncJob[];
}

/** Текст ошибки из ответа роута; если тело не JSON — статус запроса. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    // Тело не JSON (страница входа прокси, обрыв) — оставляем статус.
    return fallback;
  }
}

/** Ответ POST /api/sync-jobs: задание, признак переиспользования и подпись сервера. */
export interface EnqueueSyncJobResponse {
  job: RedactedSyncJob;
  /**
   * true — активное задание того же вида уже лежало в очереди, новое не
   * создавалось. Панель обязана сказать об этом своими словами: «поставлено в
   * очередь» про задание, которое уже выполняется, — неправда.
   */
  deduped: boolean;
  /** Свежая подпись состояния сервера: очередь после постановки изменилась. */
  view: WorkerStatusView;
}

export const syncJobApiService = {
  /**
   * Состояние воркера и очередь.
   *
   * Бросает ошибку с текстом из ответа: 503 означает, что Supabase не настроен
   * или миграция очереди не применена, и интерфейс обязан показать причину, а не
   * «нет данных».
   */
  async getStatus(limit = 5): Promise<SyncJobsStatusResponse> {
    const res = await fetch(`/api/sync-jobs?limit=${limit}`);
    if (!res.ok) {
      throw new Error(
        await errorMessage(res, `Состояние очереди заданий не прочитано: HTTP ${res.status}`),
      );
    }
    return (await res.json()) as SyncJobsStatusResponse;
  },

  /**
   * Прогон по кнопке «Найти новые закупки»: задание `full_sync` в очередь
   * сервера в России.
   *
   * Бесплатно и без ключей в браузере: сервер опрашивает все источники, которые
   * не стоят денег, по профилям, заведённым на нём. Повторное нажатие возвращает
   * прежнее активное задание (`deduped: true`) — два прогона подряд не дают
   * ничего нового, зато каждый занимает сервер на десятки минут.
   *
   * Отказ приходит текстом причины из ответа, а не кодом статуса: 503 означает,
   * что очередь не настроена, и партнёр обязан увидеть, что чинить.
   */
  async enqueueFullSync(): Promise<EnqueueSyncJobResponse> {
    const res = await fetch("/api/sync-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "full_sync", reason: "press" }),
    });
    if (!res.ok) {
      throw new Error(
        await errorMessage(res, `Прогон не поставлен в очередь: HTTP ${res.status}`),
      );
    }
    return (await res.json()) as EnqueueSyncJobResponse;
  },
};
