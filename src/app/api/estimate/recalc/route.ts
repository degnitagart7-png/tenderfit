import { requireAccess } from "@/app/api/auth/requireAccess";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAssistLimiter } from "@/app/api/search/guard";
import { billEditsSchema } from "@/domain/estimate/billEdits";
import type { EstimateBillSnapshot } from "@/domain/estimate/billReview";
import type { EstimateDocument } from "@/domain/estimate/types";
import { describeError } from "@/lib/errors";
import { clientKey } from "@/lib/rateLimit";
import { createTtlCache } from "@/lib/ttlCache";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import { EstimateBaseMissingError } from "@/services/estimateService";
import {
  RecalcStaleError,
  RecalcUnavailableError,
  recalculateEstimate,
  type RecalcSource,
} from "@/services/estimateRecalc";

/**
 * POST /api/estimate/recalc — пересчёт сметы после правок ведомости: `{ jobId, edits }`.
 *
 * Считает здесь, в приложении, а не в воркере, и без модели: ведомость берётся из отчёта задания
 * расчёта, правки применяются к ней, нормы и цены читаются из той же базы (`data/fsnb/index`), что
 * и у воркера, — приложение и воркер на одной машине. Расход ИИ — ноль: ни одного обращения к
 * `/api/estimate/bill-rows`, ничего не пишется в `llm_usage_log`. Почему не воркером — см.
 * `src/services/estimateRecalc.ts`: он занят разбором документации минутами, а ответ нужен за секунды.
 *
 * Первый пересчёт после перезапуска приложения читает базу норм в память (около двух секунд),
 * последующие — доли секунды. Сам отчёт задания (он весит мегабайты) держится в кэше пять минут:
 * правят строку за строкой, и каждый раз тянуть его из базы незачем. Отчёт завершённого задания
 * не меняется, поэтому кэш безопасен.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const limiter = createAssistLimiter(200);
const sources = createTtlCache<RecalcSource>({ ttlMs: 5 * 60_000, maxEntries: 8 });

/** Правки приходят целиком при каждом пересчёте; сотни строк с запасом укладываются в это. */
const MAX_BODY_CHARS = 1_000_000;

const bodySchema = z.object({
  jobId: z.string().min(1).max(80),
  edits: billEditsSchema,
});

async function sourceOf(jobId: string): Promise<RecalcSource | { error: string; status: number }> {
  const cached = sources.get(jobId);
  if (cached !== undefined) return cached;

  const job = await syncJobRepository.findById(jobId);
  if (job === null || job.kind !== "estimate") return { error: "Расчёт не найден", status: 404 };
  if (job.status !== "completed") return { error: "Расчёт ещё не закончен", status: 409 };

  const estimate = job.report?.estimate;
  const bill = estimate?.bill as EstimateBillSnapshot | undefined;
  if (estimate === undefined || bill === undefined || bill.version !== 1 || !Array.isArray(bill.sections)) {
    return {
      error:
        "Эта смета посчитана до появления правок ведомости: нажмите «Рассчитать смету» ещё раз — тогда её можно будет править",
      status: 409,
    };
  }
  const source: RecalcSource = { document: estimate.document as EstimateDocument, bill };
  sources.set(jobId, source);
  return source;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  const decision = limiter.check(clientKey(request.headers));
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Слишком много пересчётов. Подождите немного.", retryAfterSec: decision.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
    );
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ error: "Правок слишком много" }, { status: 413 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Ожидается jobId и список правок edits" }, { status: 400 });
  }

  try {
    const source = await sourceOf(parsed.data.jobId);
    if ("error" in source) return NextResponse.json({ error: source.error }, { status: source.status });

    const result = await recalculateEstimate(source, parsed.data.edits);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RecalcUnavailableError || error instanceof RecalcStaleError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof EstimateBaseMissingError) {
      return NextResponse.json({ error: `База норм на сервере не собрана: пересчёт недоступен. ${error.message}` }, { status: 503 });
    }
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}
