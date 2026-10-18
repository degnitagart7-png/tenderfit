import { requireAccess } from "@/app/api/auth/requireAccess";
import { recordRequestEvent, requestEmail } from "@/app/api/auth/requestUser";
import { NextRequest, NextResponse } from "next/server";
import {
  SyncJobRequestError,
  enqueueWithStatus,
  readWorkerStatus,
} from "@/services/syncJobService";
import { describeError } from "@/lib/errors";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import { redactSyncJob, redactSyncJobs } from "@/domain/syncJobRedaction";

export const dynamic = "force-dynamic";

/** Сколько последних заданий отдаём в журнал панели. */
const MAX_RECENT = 20;

function isConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Ответ 503 с причиной, а не 500 со стеком: очередь не работает по одной из двух
 * понятных причин — не заданы переменные Supabase или не применена миграция.
 * Обе лечатся администратором, и интерфейс обязан называть их своими словами.
 *
 * Ошибку расшифровывает `describeError`: PostgREST возвращает не `Error`, а
 * объект `{ message, code }`, и обычный `String(error)` показал бы партнёру
 * `[object Object]` вместо «таблицы sync_jobs нет».
 */
function unavailableResponse(error: unknown): NextResponse {
  const message = describeError(error);
  const migrationMissing =
    message.includes("sync_jobs") ||
    message.includes("worker_heartbeat") ||
    message.includes("42P01") ||
    message.includes("PGRST205") ||
    message.includes("does not exist");

  return NextResponse.json(
    {
      error: migrationMissing
        ? "Очередь заданий не настроена: примените миграцию supabase/migrations/20260925000004_add_sync_jobs.sql"
        : "Очередь заданий недоступна",
      detail: message,
    },
    { status: 503 },
  );
}

/**
 * GET /api/sync-jobs
 *
 * Состояние воркера с российским IP: пульс, адрес выхода, длина очереди,
 * последнее задание и журнал. Панель показывает готовую подпись (`view`),
 * чтобы формулировки жили в домене и проверялись тестами, а не в компоненте.
 *
 * Ответ: { configured, workerId, now, status, view, recent }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  const limitParam = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), MAX_RECENT)
    : 5;

  if (!isConfigured()) {
    return NextResponse.json(
      {
        configured: false,
        // Текст уходит на экран партнёра как есть («Состояние сервера не
        // прочитано: …»), поэтому в нём нет слова «воркер»: процесс называется
        // сервером в России — так же, как в подписях `describeWorkerStatus`.
        error: "Supabase не настроен: состояние очереди заданий недоступно",
      },
      { status: 503 },
    );
  }

  try {
    const [{ workerId, now, status, view }, recent] = await Promise.all([
      readWorkerStatus(),
      syncJobRepository.findRecent(limit),
    ]);

    /*
      Журнал уходит без текстов присланных документов: они лежат в задании,
      потому что хранить их больше негде, но показывать их в панели незачем.
      Те же тексты не возвращает и POST /api/estimate — журнал не имеет права
      быть щедрее расчёта, ради которого файлы и присылали.
    */
    return NextResponse.json({
      configured: true,
      workerId,
      now,
      status: {
        ...status,
        lastJob: status.lastJob === null ? null : redactSyncJob(status.lastJob),
      },
      view,
      recent: redactSyncJobs(recent),
    });
  } catch (error) {
    recordRequestEvent(request, { kind: "error", ok: false, detail: `GET /api/sync-jobs: ${describeError(error)}` });
    return unavailableResponse(error);
  }
}

/**
 * POST /api/sync-jobs
 * Body: { kind?: "documents" | "full_sync", regNumbers?: string[], reason?: string, requestedBy?: string }
 *
 * Ставит задание воркеру. Из браузера сюда приходит один вид задания:
 *
 * - кнопка «Найти новые закупки» на дашборде ставит `full_sync` с `reason:
 *   "press"` — бесплатный прогон всех источников, которые не стоят денег.
 *
 * Задание `documents` браузер не ставит вовсе: номера закупок знает сервер, и он
 * же пишет строку в очередь — `POST /api/kontur/sync` после платного поиска
 * (`queueDocumentsAfterSearch`) и покупка платной карточки
 * (`buyKonturCard`). Номера не обязаны делать круг через клиент, а ролевой модели
 * в приложении нет, поэтому и кнопки «докачать документацию» в панели
 * администратора нет: она только читает очередь.
 *
 * Повторное обращение с тем же набором номеров возвращает прежнее задание
 * (`deduped: true`) и не плодит одинаковую работу: воркер качал бы одни и те же
 * файлы несколько раз, а партнёр видел бы растущую очередь без движения.
 * Плановый прогон сравнивается только по виду — второй прогон подряд ничего не
 * добавляет, а сервер занимает на десятки минут.
 *
 * Ответ 201: { job, deduped, view } · 200 при переиспользовании ·
 * 400 при неверном теле · 503, если очередь не настроена.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  if (!isConfigured()) {
    return NextResponse.json(
      {
        configured: false,
        error: "Supabase не настроен: задание в очередь поставить нельзя",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Тело запроса не является JSON" },
      { status: 400 },
    );
  }

  try {
    // Задание записывается на вошедшего (почта сильнее requestedBy из тела), чтобы
    // его расход и сбои были видны в /admin/users.
    const { job, deduped, view } = await enqueueWithStatus(body, { requestedBy: requestEmail(request) });
    if (!deduped && job.kind === "full_sync") recordRequestEvent(request, { kind: "find_new" });
    // Вырезание и здесь: при `deduped` возвращается уже лежащее задание, а
    // какое именно — решает поиск по совпадению, не этот роут.
    return NextResponse.json(
      { job: redactSyncJob(job), deduped, view },
      { status: deduped ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof SyncJobRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    recordRequestEvent(request, { kind: "error", ok: false, detail: `POST /api/sync-jobs: ${describeError(error)}` });
    return unavailableResponse(error);
  }
}
