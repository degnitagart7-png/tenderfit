import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { describeError } from "@/lib/errors";
import { resolveWorkerId } from "@/domain/workerStatus";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import type { SyncJobRow } from "@/types/database";

/**
 * Очередь расчётов сметы.
 *
 * POST — поставить задание, GET — узнать, чем оно закончилось.
 *
 * Почему не считаем прямо здесь. Расчёт читает базу ФСНБ-2022 с диска: 56 242
 * нормы, около 600 МБ памяти и две секунды на загрузку. Каталог индекса в
 * поставку не входит — 200 МБ справочников не помещаются в серверную функцию, —
 * поэтому считает машина воркера, где эта база лежит. Второе: извлечение
 * ведомости идёт через модель и на полной документации занимает минуты, а
 * серверная функция столько не живёт.
 *
 * Пользователю это видно как «поставили в очередь — результат придёт»: тот же
 * порядок, что у глубокого анализа, и та же таблица заданий.
 *
 * Повторное нажатие не плодит заданий: если по закупке уже считается смета,
 * возвращается то же задание. Расчёт стоит минут работы модели, и запускать его
 * дважды по одной кнопке — платить дважды за один ответ.
 */

const documentSchema = z.object({
  name: z.string().min(1),
  text: z.string().min(1),
});

const requestSchema = z.object({
  tenderId: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  documents: z.array(documentSchema).optional(),
});

/** Сколько текста принимаем в одном задании: дальше упрёмся в размер строки. */
const MAX_TOTAL_CHARS = 2_000_000;

/**
 * С какой версии воркер умеет считать смету.
 *
 * Версия — момент изменения scripts/worker.ts на сервере, её пишет пульс.
 * Проверка обязательна, и вот почему: старый воркер разбирал вид задания
 * двумя ветками — «документация» и всё остальное, — поэтому задание на смету
 * молча уходило в полный прогон источников и тратило платные запросы
 * Контур.Закупок. Одно нажатие кнопки «Рассчитать смету» стоило суточного
 * бюджета поиска и не давало сметы.
 *
 * Поэтому задание не ставится, пока сервер не обновлён: отказ с объяснением
 * дешевле молчаливого списания денег.
 */
const MIN_WORKER_VERSION = "2026-09-28 00:00";

/** Пульс сервера расчёта: версия кода и давно ли он на связи. */
async function estimateCapableWorker(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const workerId = resolveWorkerId(process.env["SYNC_WORKER_ID"]);
  const heartbeat = await syncJobRepository.readHeartbeat(workerId);

  if (heartbeat === null) {
    return {
      ok: false,
      reason:
        "Сервер расчёта ни разу не выходил на связь: смету считать некому",
    };
  }

  const version = heartbeat.version ?? "";
  if (version < MIN_WORKER_VERSION) {
    return {
      ok: false,
      reason:
        `На сервере расчёта код от ${version || "неизвестной даты"}, а смета появилась ` +
        `${MIN_WORKER_VERSION}. Обновите воркер: deploy/deploy-worker.sh --restart`,
    };
  }

  return { ok: true };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Тело запроса не JSON" },
      { status: 400 },
    );
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Ожидается tenderId или documents" },
      { status: 400 },
    );
  }

  const { tenderId, subject, documents } = parsed.data;
  const hasDocuments = documents !== undefined && documents.length > 0;
  if (tenderId === undefined && !hasDocuments) {
    return NextResponse.json(
      { error: "Нужен либо tenderId, либо непустой список documents" },
      { status: 400 },
    );
  }

  if (hasDocuments) {
    const chars = documents.reduce((sum, item) => sum + item.text.length, 0);
    if (chars > MAX_TOTAL_CHARS) {
      return NextResponse.json(
        {
          error: `Текста слишком много: ${chars.toLocaleString("ru-RU")} знаков при пределе ${MAX_TOTAL_CHARS.toLocaleString("ru-RU")}`,
        },
        { status: 413 },
      );
    }
  }

  try {
    const worker = await estimateCapableWorker();
    if (!worker.ok) {
      return NextResponse.json({ error: worker.reason }, { status: 503 });
    }

    // Закупка считается одна: повтор нажатия возвращает то же задание.
    if (tenderId !== undefined && !hasDocuments) {
      const running = await syncJobRepository.findActiveEstimate(tenderId);
      if (running !== null) {
        return NextResponse.json({ job: describe(running), reused: true });
      }
    }

    const job = await syncJobRepository.create(
      "estimate",
      {
        ...(tenderId === undefined ? {} : { tenderId }),
        ...(subject === undefined ? {} : { subject }),
        ...(hasDocuments ? { documents } : {}),
        reason: hasDocuments ? "upload" : "tender",
      },
      "ui",
    );

    return NextResponse.json({ job: describe(job), reused: false });
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}

/**
 * GET /api/estimate?jobId=… — состояние задания.
 * GET /api/estimate?tenderId=… — последняя смета по закупке.
 *
 * Второй случай нужен, чтобы открытая заново карточка показывала уже
 * посчитанную смету, а не предлагала считать её второй раз.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const jobId = request.nextUrl.searchParams.get("jobId");
  const tenderId = request.nextUrl.searchParams.get("tenderId");

  if (jobId === null && tenderId === null) {
    return NextResponse.json(
      { error: "Нужен jobId или tenderId" },
      { status: 400 },
    );
  }

  try {
    const job =
      jobId !== null
        ? await syncJobRepository.findById(jobId)
        : await syncJobRepository.findLatestEstimate(tenderId ?? "");

    if (job === null) return NextResponse.json({ job: null });
    return NextResponse.json({ job: describe(job) });
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}

/**
 * Что из задания отдаётся клиенту.
 *
 * Присланные тексты документов обратно не возвращаются: они уже есть у того,
 * кто их прислал, и весят больше всего остального вместе взятого.
 */
function describe(job: SyncJobRow) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    error: job.error,
    estimate: job.report?.estimate ?? null,
  };
}
