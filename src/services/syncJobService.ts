import {
  findReusableJob,
  parseSyncJobRequest,
  type SyncJobRequest,
} from "@/domain/syncJobRequest";
import {
  describeWorkerStatus,
  resolveWorkerId,
  type WorkerStatusView,
} from "@/domain/workerStatus";
import { describeError } from "@/lib/errors";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import type { SyncJobRow, WorkerStatus } from "@/types/database";

/**
 * Серверная сторона очереди заданий воркеру с российским IP.
 *
 * Правила постановки живут здесь, а не в роутах: одно и то же задание ставят
 * два разных места — `POST /api/sync-jobs` (панель администратора и кнопка
 * «Найти новые закупки», которая ставит прогон `full_sync`) и
 * `POST /api/kontur/sync` (платный поиск той же панели — документация
 * найденных закупок). Держать проверку повторов в одном модуле — значит не
 * получить две очереди, которые не знают друг о друге и заставляют воркер
 * качать одни и те же файлы дважды.
 */

/**
 * Сколько последних заданий читается в поиске равного.
 *
 * Совпадает с длиной журнала в роуте: больше — лишний трафик, меньше — риск не
 * увидеть задание, поставленное минуту назад, и поставить второе такое же.
 */
const MAX_RECENT = 20;

/**
 * Откуда задание, поставленное поиском. Значение попадает в `payload.reason`
 * и читается в журнале: прогон по кнопке и ручной запуск администратором
 * чинятся по-разному, а отличить их можно только по этой метке.
 */
const PRESS_REASON = "press";
/** Задание кнопки «Глубокий анализ»: загрузка документации и сразу разбор. */
export const ANALYSIS_REASON = "analysis";

/** Тело запроса не прошло проверку домена. Роут отвечает на неё 400. */
export class SyncJobRequestError extends Error {}

/** Задание создано или найдено равное среди активных. */
export interface EnqueuedSyncJob {
  job: SyncJobRow;
  /** Равное активное задание уже стояло: новое не создавалось. */
  deduped: boolean;
}

/**
 * Дополнения к постановке задания, которые знает роут, а не тело запроса.
 *
 * `requestedBy` — почта вошедшего. Она сильнее `requestedBy` из тела: тело пишет
 * клиент, и подставить в него чужую почту — значит записать чужому человеку
 * расход и сбои. Без почты (служебный ключ, разработка) остаётся то, что в теле.
 */
export interface EnqueueOptions {
  requestedBy?: string | null;
}

/** Состояние воркера в том виде, в котором его отдают роуты. */
export interface WorkerStatusSnapshot {
  workerId: string;
  now: string;
  status: WorkerStatus;
  /** Готовая подпись: формулировки живут в домене и проверены тестами. */
  view: WorkerStatusView;
}

/**
 * Что ответ поиска говорит про документацию найденных закупок.
 *
 * Форма повторяется клиентским типом `KonturDocumentsQueue` в
 * `konturApiService`: клиент не импортирует серверные модули, а расхождение
 * полей было бы видно только в рантайме.
 */
export interface DocumentsQueueOutcome {
  /** Сколько номеров ушло в задание. 0 — ставить было нечего. */
  queued: number;
  /** Идентификатор задания; null — задание не создано. */
  jobId: string | null;
  /** Равное задание уже стояло в очереди. */
  deduped: boolean;
  /** Почему документация не поставлена; null — поставлена или нечего было ставить. */
  error: string | null;
}

/** Пульс воркера, последнее задание и длина очереди — одной подписью. */
export async function readWorkerStatus(): Promise<WorkerStatusSnapshot> {
  const workerId = resolveWorkerId(process.env.SYNC_WORKER_ID);
  const now = new Date().toISOString();
  const status = await syncJobRepository.status(workerId);
  return { workerId, now, status, view: describeWorkerStatus(status, now) };
}

/** Задание с подписью воркера: роут отдаёт их вместе, чтобы панель не делала второй запрос. */
export async function enqueueWithStatus(
  body: unknown,
  options?: EnqueueOptions,
): Promise<EnqueuedSyncJob & { view: WorkerStatusView }> {
  const enqueued = await enqueueSyncJob(body, options);
  const { view } = await readWorkerStatus();
  return { ...enqueued, view };
}

/**
 * Разбирает тело запроса и ставит задание в очередь.
 *
 * Повторное обращение с тем же набором номеров возвращает прежнее активное
 * задание (`deduped: true`): кнопка на дашборде нажимается несколько раз подряд,
 * а одинаковая работа в очереди означала бы, что воркер качает одни и те же
 * файлы повторно и партнёр видит растущий список без движения.
 *
 * Бросает `SyncJobRequestError` на неверном теле и ошибку базы — как есть.
 */
export async function enqueueSyncJob(body: unknown, options?: EnqueueOptions): Promise<EnqueuedSyncJob> {
  const parsed = parseSyncJobRequest(body);
  if (!parsed.ok) throw new SyncJobRequestError(parsed.error);
  const request: SyncJobRequest = parsed.request;

  const active = (await syncJobRepository.findRecent(MAX_RECENT)).filter(
    (job) => job.status === "pending" || job.status === "processing",
  );
  const reusable = findReusableJob(active, request);
  if (reusable) return { job: reusable, deduped: true };

  const job = await syncJobRepository.create(
    request.kind,
    {
      regNumbers: request.regNumbers,
      reason: request.reason,
      // Флаг пишется только когда он есть: воркер читает payload, а отсутствие
      // ключа означает бесплатное задание — как у всех строк, созданных раньше.
      ...(request.konturCards ? { konturCards: true } : {}),
      ...(request.analyze ? { analyze: true } : {}),
    },
    options?.requestedBy ?? request.requestedBy,
  );
  return { job, deduped: false };
}

/**
 * Документация найденных закупок — в очередь воркеру.
 *
 * Функция не бросает ошибок и всегда возвращает исход. Поиск уже оплачен и
 * закупки уже сохранены: сбой очереди (миграция не применена, Supabase не
 * отвечает) не вправе превращать удачный платный прогон в 500 и терять его
 * результат. Вместо этого исход честно уходит в ответ, а панель пишет, что
 * документация не поставлена и её добавит плановый прогон.
 *
 * Глубокий разбор здесь не ставится намеренно: он стоит денег (≈6 ₽ за закупку
 * при суточном потолке 20) и требует решения партнёра по каждой закупке, а не
 * по нажатию кнопки поиска.
 *
 * Потолок `MAX_REG_NUMBERS_PER_JOB` на одно задание не обходится разбиением на
 * несколько: прогон по кнопке даёт не больше 150 номеров (3 слова × 1 страница ×
 * 50), а превышение означает нештатный запрос — его лучше показать в ответе, чем
 * молча разрезать на задания, которые партнёр не заказывал.
 */
export async function queueDocumentsAfterSearch(
  regNumbers: readonly string[],
): Promise<DocumentsQueueOutcome> {
  const numbers = [...regNumbers];
  if (numbers.length === 0) {
    return { queued: 0, jobId: null, deduped: false, error: null };
  }

  try {
    const { job, deduped } = await enqueueSyncJob({
      kind: "documents",
      regNumbers: numbers,
      reason: PRESS_REASON,
    });
    return { queued: numbers.length, jobId: job.id, deduped, error: null };
  } catch (error) {
    return { queued: 0, jobId: null, deduped: false, error: describeError(error) };
  }
}

/** Исход постановки загрузки под глубокий анализ. */
export interface AnalysisDocumentsOutcome {
  /** Задание на загрузку и разбор; null — поставить не удалось. */
  jobId: string | null;
  deduped: boolean;
  /** Почему не поставлено; null — поставлено. */
  error: string | null;
}

/**
 * Загрузка документации одной закупки с разбором сразу после неё.
 *
 * Без этого кнопка «Глубокий анализ» только создавала задачу разбора, а
 * документацию для неё приносил плановый прогон раз в два часа: партнёр
 * нажимал и видел «в очереди» десятки минут (медиана по базе — 23 минуты).
 * Задание уходит воркеру на сервере в России, он опрашивает очередь каждые
 * несколько секунд, скачивает и распаковывает файлы и тут же отдаёт закупку
 * на разбор.
 *
 * Не бросает: задача разбора уже создана, и сбой очереди не должен превращать
 * нажатие в ошибку — воркер всё равно подберёт ожидающую задачу сам.
 */
export async function queueDocumentsForAnalysis(
  regNumber: string,
  /** Почта того, кто нажал кнопку: задание записывается на него (журнал /admin/users). */
  requestedBy?: string | null,
): Promise<AnalysisDocumentsOutcome> {
  try {
    const { job, deduped } = await enqueueSyncJob(
      {
        kind: "documents",
        regNumbers: [regNumber],
        reason: ANALYSIS_REASON,
        analyze: true,
      },
      requestedBy === undefined || requestedBy === null ? undefined : { requestedBy },
    );
    return { jobId: job.id, deduped, error: null };
  } catch (error) {
    return { jobId: null, deduped: false, error: describeError(error) };
  }
}
