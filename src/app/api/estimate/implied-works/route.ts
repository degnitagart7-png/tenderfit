import { NextRequest, NextResponse } from "next/server";

import { rejectWithoutWorkerSecret, WORKER_SECRET_HEADER } from "@/lib/workerSecret";

import { impliedWorksRequestSchema } from "@/domain/estimate/impliedWorks";
import { describeError } from "@/lib/errors";
import { fetchImpliedWorks } from "@/services/impliedWorksService";

/**
 * POST /api/estimate/implied-works — предложение работ, которых нет в ведомости, но которые обязана технология (леса, защитные сетки, ограждения).
 *
 * Зачем эта ручка. Тот же довод, что у `/api/estimate/norm-pick`: ключ языковой модели живёт на проде, а ведомость с выбранными нормами — у воркера.
 * Воркер отправляет позиции ведомости и сведения об объекте из ТЗ, прод зовёт модель по неизменному шаблону один раз и возвращает дополнения из белого
 * списка категорий: наименование, единица, объём формулой над позициями и причина. Проверяет формулы, считает объёмы и выбирает нормы воркер
 * (`estimateImplied.ts`): ответ модели без проверки в смету не попадает.
 *
 * Защита та же, что у `norm-pick`: секрет воркера (`TENDERFIT_WORKER_SECRET`), вход ограничен схемой (до 80 позиций, до 8 выдержек, предел длины каждого
 * поля), промпт — неизменный шаблон: прокси к платному шлюзу ручка не становится. Расход пишется самим чатом (`llmChat`) с видом работы
 * `estimate_implied`, закупкой и заданием расчёта. Модель — `TENDERFIT_IMPLIED_MODEL`, нет — `TENDERFIT_NORM_PICK_MODEL`, нет — модель по умолчанию.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Восемьдесят позиций с нормами и выдержки — около 40 тыс. знаков (до 2 байт на знак кириллицы); больше — не наша пачка. */
const MAX_BODY_CHARS = 120_000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Только воркер: ручка тратит ключ модели (см. src/lib/workerSecret.ts).
  const denied = rejectWithoutWorkerSecret(request.headers?.get(WORKER_SECRET_HEADER));
  if (denied !== null) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const declared = Number(request.headers?.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_CHARS * 2) {
    return NextResponse.json({ error: "Запрос слишком большой" }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }

  const parsed = impliedWorksRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Ожидается regNumber, subject, facts и items (1–80 позиций ведомости) (${parsed.error.issues
          .map((issue) => issue.path.join(".") || "тело")
          .slice(0, 6)
          .join(", ")})`,
      },
      { status: 400 },
    );
  }

  const body = parsed.data;
  // Формулы ссылаются на позиции по идентификатору: повтор сделал бы ссылку неоднозначной.
  if (new Set(body.items.map((item) => item.id)).size !== body.items.length) {
    return NextResponse.json({ error: "Идентификаторы позиций (items.id) повторяются" }, { status: 400 });
  }

  try {
    const answer = await fetchImpliedWorks({
      context: { regNumber: body.regNumber, subject: body.subject, jobId: body.jobId ?? null },
      facts: body.facts,
      items: body.items,
    });
    return NextResponse.json(answer);
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 502 });
  }
}
