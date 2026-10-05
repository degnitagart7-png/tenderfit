import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAssistLimiter, readGuardedBody } from "@/app/api/search/guard";
import {
  decideLiveStart,
  normalizeLiveQuery,
  normalizeLiveRegions,
  normalizeLiveSynonyms,
  type LiveJobView,
} from "@/domain/liveSearch";
import { resolveWorkerId } from "@/domain/workerStatus";
import { describeError } from "@/lib/errors";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import { searchAssist } from "@/services/searchAssistService";
import type { SyncJobRow } from "@/types/database";

/**
 * Живой поиск: запрос уходит прямо на площадки, найденное остаётся в базе.
 *
 * POST { query } — поставить задание; GET ?jobId= — узнать, чем оно закончилось.
 *
 * Зачем. Поиск по ленте ищет только то, что уже загружено, а грузят три
 * зашитых профиля сервера. Запрос «юридические услуги» находил две закупки не
 * потому, что поиск плох, а потому, что юристов никто не собирал. Эта ручка
 * просит воркер найти запрос на ЕИС, Сбербанк-АСТ, Росэлторге и Фабриканте.
 *
 * Почему через очередь, а не прямо здесь. Прогон идёт минуты: Росэлторг и
 * Фабрикант тратят отдельный запрос карточки на каждую процедуру. Серверная
 * функция столько не живёт, а воркер уже умеет ходить на площадки и пишет в
 * базу по правилам приоритета источников.
 *
 * Что защищает ручку. Она открыта без входа, а за каждым запросом — прогон по
 * чужим площадкам. Поэтому: лимит на адрес (три за десять минут), чистка
 * запроса перед передачей чужим поисковым строкам, один прогон за раз, повтор
 * не плодит задания, а при устаревшем воркере задание не ставится вовсе:
 * старый воркер не знает режима живого поиска и выполнил бы вместо него полный
 * плановый прогон со всеми побочными эффектами.
 */
export const runtime = "nodejs";
export const maxDuration = 30;

const limiter = createAssistLimiter(3);

/**
 * С какой версии воркер умеет живой поиск.
 *
 * Версия — момент изменения scripts/worker.ts на сервере, её пишет пульс.
 * Без проверки задание с запросом ушло бы к старому воркеру, который берёт
 * любое `full_sync` за плановый прогон.
 */
const MIN_WORKER_VERSION = "2026-10-04 17:59";

/** Дольше не выходил на связь — задание повисло бы в очереди без исполнителя. */
const WORKER_SILENCE_LIMIT_MS = 10 * 60_000;

const bodySchema = z.object({
  query: z.string().max(200),
  /** Регионы поиска: ЕИС искать по региону заказчика умеет, остальное отберёт лента. */
  regions: z.array(z.string().max(120)).max(10).optional(),
  /** Дополнительные слова человека (из его профиля): если есть, модель не спрашиваем. */
  keywords: z.array(z.string().max(120)).max(10).optional(),
});

const jobIdSchema = z.string().uuid();

function toView(row: SyncJobRow): LiveJobView {
  return {
    id: row.id,
    query: row.payload?.liveQuery ?? "",
    regions: row.payload?.liveRegions ?? [],
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** Сколько ждём ответа модели: дольше человек не должен смотреть на кнопку. */
const RELATED_WORDS_TIMEOUT_MS = 10_000;

/**
 * Близкие слова запроса от модели. Сбой, пустой ответ и долгое ожидание не
 * останавливают поиск: он пойдёт по самому запросу.
 */
async function relatedWords(query: string): Promise<string[]> {
  try {
    const answer = await Promise.race([
      searchAssist.expand(query),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), RELATED_WORDS_TIMEOUT_MS)),
    ]);
    return normalizeLiveSynonyms(query, answer?.synonyms);
  } catch {
    return [];
  }
}

async function workerProblem(): Promise<string | null> {
  const heartbeat = await syncJobRepository.readHeartbeat(
    resolveWorkerId(process.env["SYNC_WORKER_ID"]),
  );
  if (heartbeat === null) return "Сервер поиска ни разу не выходил на связь: искать некому";

  const version = heartbeat.version ?? "";
  if (version < MIN_WORKER_VERSION) {
    return `На сервере поиска код от ${version || "неизвестной даты"}, а живой поиск появился ${MIN_WORKER_VERSION}. Обновите воркер.`;
  }

  const silence = Date.now() - Date.parse(heartbeat.last_seen_at);
  if (Number.isNaN(silence) || silence > WORKER_SILENCE_LIMIT_MS) {
    return "Сервер поиска давно не отвечает: задание некому выполнить";
  }
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await readGuardedBody(request, limiter, bodySchema);
  if (!body.ok) return body.response;

  const query = normalizeLiveQuery(body.data.query);
  if (query === null) {
    return NextResponse.json(
      { error: "Запрос слишком короткий или состоит из недопустимых символов" },
      { status: 400 },
    );
  }

  const regions = normalizeLiveRegions(body.data.regions);

  try {
    const problem = await workerProblem();
    if (problem !== null) return NextResponse.json({ error: problem }, { status: 503 });

    const [active, recent] = await Promise.all([
      syncJobRepository.findActiveLive(),
      syncJobRepository.findRecentLive(query),
    ]);
    const decision = decideLiveStart({
      query,
      regions,
      active: active === null ? null : toView(active),
      recent: recent === null ? null : toView(recent),
      nowMs: Date.now(),
    });

    switch (decision.kind) {
      case "busy":
        return NextResponse.json({ error: decision.reason }, { status: 429 });
      case "reuse":
        return NextResponse.json({ jobId: decision.jobId, status: "running", reused: true });
      case "cached":
        return NextResponse.json({ jobId: decision.jobId, status: "completed", cached: true });
      case "create": {
        // Близкие слова — только когда задание действительно ставится: повтор,
        // кэш и отказ не должны тратить токены.
        const own = normalizeLiveSynonyms(query, body.data.keywords);
        const synonyms = own.length > 0 ? own : await relatedWords(query);
        const job = await syncJobRepository.create(
          "full_sync",
          {
            liveQuery: query,
            ...(regions.length > 0 ? { liveRegions: regions } : {}),
            ...(synonyms.length > 0 ? { liveKeywords: synonyms } : {}),
            reason: "live-search",
          },
          "live-search",
        );
        return NextResponse.json({ jobId: job.id, status: job.status });
      }
    }
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 502 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = jobIdSchema.safeParse(request.nextUrl.searchParams.get("jobId"));
  if (!parsed.success) {
    return NextResponse.json({ error: "Нужен jobId — идентификатор задания" }, { status: 400 });
  }

  try {
    const job = await syncJobRepository.findById(parsed.data);
    // Только задания живого поиска: ручка не должна показывать чужие задания,
    // в которых могут лежать тексты присланных документов.
    if (job === null || job.payload?.liveQuery === undefined) {
      return NextResponse.json({ error: "Задание не найдено" }, { status: 404 });
    }
    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      note: job.report?.note ?? null,
      // Текст ошибки наружу не отдаём: в нём могут быть адреса внутренних
      // сервисов. Человеку достаточно «не удалось».
      failed: job.status === "failed",
    });
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 502 });
  }
}
