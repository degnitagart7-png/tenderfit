import { requireAccess } from "@/app/api/auth/requireAccess";
import { recordRequestEvent, requestEmail } from "@/app/api/auth/requestUser";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { describeError } from "@/lib/errors";
import { resolveWorkerId } from "@/domain/workerStatus";
import { estimateOptionsSchema, hasEstimateOptions, normalizeEstimateOptions } from "@/domain/estimate/estimateOptions";
import { listBuiltZones } from "@/repositories/estimateBaseRepository";
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
  /** Ценовая зона, выбранная вручную. Нет — воркер определяет её по закупке. */
  priceZoneId: z.number().int().positive().optional(),
  /**
   * Что считать: `estimate` — смета по ведомости (по умолчанию); `audit` — проверка
   * локальной сметы заказчика построчно, без модели. Один вид задания на оба режима:
   * в базе стоит ограничение на виды, а миграция ради этого не нужна.
   */
  mode: z.enum(["estimate", "audit"]).optional(),
  /**
   * Вид работ, условия производства работ и сроки (блок «Условия работ»). Нет — начислений сверх
   * норм нет: смета считается как раньше.
   */
  options: estimateOptionsSchema.optional(),
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
 *
 * 2026-10-06 16:00 UTC (версия — mtime worker.ts в UTC): воркер выбирает ценовую зону (`payload.priceZoneId`, регион закупки).
 * Старый воркер её игнорирует и молча считает в амурских ценах — ровно та ошибка,
 * ради которой зоны и появились, поэтому версия поднята.
 *
 * 2026-10-08 12:40 UTC (mtime scripts/worker.ts после правки): воркер читает `payload.estimateOptions` (вид работ, условия производства
 * работ, сроки) и считает зимнее удорожание, временные здания и коэффициенты. Старый воркер их
 * игнорирует: человек поставил бы галочку «без расселения», а смета пришла бы без коэффициента.
 * 2026-10-08 22:26 UTC (mtime scripts/worker.ts после правки): воркер передаёт в расчёт название ценовой зоны (`priceZoneName`) и читает
 * `payload.estimateOptions.method` (метод расчёта: ресурсно-индексный или базисно-индексный, ФЕР-2020 × индексы Минстроя). Старый воркер
 * метод игнорирует: человек выбрал бы «базисно-индексный», а смета пришла бы ресурсной, без пометки.
 * Если worker.ts правится ещё раз, версию надо поднять до его нового mtime в UTC.
 */
const MIN_WORKER_VERSION = "2026-10-14 22:28";

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
  const denied = await requireAccess(request);
  if (denied) return denied;

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

  const { tenderId, subject, documents, priceZoneId } = parsed.data;
  const options = normalizeEstimateOptions(parsed.data.options);
  const mode = parsed.data.mode ?? "estimate";
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

  // Зона, которой нет среди собранных, отклоняется сразу: воркер всё равно упал бы
  // с тем же объяснением, но уже после постановки задания и ожидания в очереди.
  if (priceZoneId !== undefined) {
    const built = await listBuiltZones().catch(() => []);
    if (!built.some((zone) => zone.priceZoneId === priceZoneId)) {
      return NextResponse.json(
        { error: `Цен по ценовой зоне ${String(priceZoneId)} ещё нет: выберите одну из собранных зон` },
        { status: 400 },
      );
    }
  }

  try {
    const worker = await estimateCapableWorker();
    if (!worker.ok) {
      recordRequestEvent(request, { kind: "error", ok: false, tenderId: tenderId ?? null, detail: `POST /api/estimate: ${worker.reason}` });
      return NextResponse.json({ error: worker.reason }, { status: 503 });
    }

    // Закупка считается одна: повтор нажатия возвращает то же задание.
    if (tenderId !== undefined && !hasDocuments) {
      const running = await syncJobRepository.findActiveEstimate(tenderId, mode);
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
        ...(priceZoneId === undefined ? {} : { priceZoneId }),
        // Пустой выбор в задание не пишется: так оно совпадает с заданиями, поставленными раньше.
        ...(hasEstimateOptions(options) ? { estimateOptions: options } : {}),
        // Режим по умолчанию в задание не пишется: так оно совпадает с заданиями, поставленными раньше.
        ...(mode === "estimate" ? {} : { mode }),
        reason: hasDocuments ? "upload" : "tender",
      },
      // Вошедший записывается по почте (расход на ИИ и сбои задания видны в /admin/users);
      // служебный запрос остаётся с меткой «ui», как было.
      requestEmail(request) ?? "ui",
    );

    recordRequestEvent(request, {
      kind: "estimate",
      tenderId: tenderId ?? null,
      detail: mode === "audit" ? "проверка сметы заказчика" : hasDocuments ? "расчёт по загруженным файлам" : "расчёт сметы",
    });
    return NextResponse.json({ job: describe(job), reused: false });
  } catch (error) {
    recordRequestEvent(request, { kind: "error", ok: false, tenderId: tenderId ?? null, detail: `POST /api/estimate: ${describeError(error)}` });
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
  const denied = await requireAccess(request);
  if (denied) return denied;

  const jobId = request.nextUrl.searchParams.get("jobId");
  const tenderId = request.nextUrl.searchParams.get("tenderId");
  const modeParam = request.nextUrl.searchParams.get("mode");
  const mode = modeParam === "audit" ? "audit" : "estimate";

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
        : await syncJobRepository.findLatestEstimate(tenderId ?? "", mode);

    if (job === null) return NextResponse.json({ job: null });
    return NextResponse.json({ job: describe(job) });
  } catch (error) {
    recordRequestEvent(request, { kind: "error", ok: false, detail: `GET /api/estimate: ${describeError(error)}` });
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
    mode: job.payload?.mode ?? "estimate",
    estimate: job.report?.estimate ?? null,
    audit: job.report?.audit ?? null,
  };
}
