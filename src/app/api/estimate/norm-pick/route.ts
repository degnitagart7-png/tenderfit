import { NextRequest, NextResponse } from "next/server";

import { rejectWithoutWorkerSecret, WORKER_SECRET_HEADER } from "@/lib/workerSecret";

import { normPickRequestSchema } from "@/domain/estimate/normPick";
import { describeError } from "@/lib/errors";
import { fetchNormPicks } from "@/services/normPickService";

/**
 * POST /api/estimate/norm-pick — выбор нормы «ИИ-сметчиком» для пачки позиций ведомости.
 *
 * Зачем эта ручка. Тот же довод, что у `/api/estimate/bill-rows`: ключ языковой модели живёт на проде, а база норм на 400 МБ —
 * у воркера. Воркер сам находит кандидатов (`normCandidates.ts`), отправляет сюда позиции вместе с ними, прод зовёт модель по
 * неизменному шаблону и возвращает выбор. Проверяет выбор и пишет в смету воркер: шифр обязан быть среди присланных кандидатов,
 * единица нормы — переводиться из единицы позиции.
 *
 * Защита та же, что у `bill-rows`: без входа и без лимита частоты (ручку зовёт воркер с той же машины или с Vercel, а расход
 * пишется в `llm_usage_log` с заданием расчёта). Прокси к платному шлюзу она не становится по построению: промпт собирается на
 * сервере по неизменному шаблону, а вход ограничен — не больше десяти позиций, тридцати кандидатов на позицию и длины каждого
 * поля. Единственное, что она умеет, — выбрать норму из присланного списка.
 *
 * Расход пишется самим чатом (`llmChat`) с видом работы `estimate_norm_pick`, закупкой и заданием расчёта; сбой шлюза пишется с
 * ok = false. Модель — `TENDERFIT_NORM_PICK_MODEL`, а без неё — та же, что у извлечения ведомости.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Пачка из десяти позиций с тридцатью кандидатами — около 150 тыс. знаков (до 2 байт на знак кириллицы); больше — не наша пачка. */
const MAX_BODY_CHARS = 400_000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Только воркер: ручка тратит ключ модели (см. src/lib/workerSecret.ts).
  const denied = rejectWithoutWorkerSecret(request.headers?.get(WORKER_SECRET_HEADER));
  if (denied !== null) return NextResponse.json({ error: denied.error }, { status: denied.status });

  // Размер известен до чтения тела: пачка не больше `MAX_BODY_CHARS` знаков, а длиннее — не наша пачка.
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

  const parsed = normPickRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Ожидается regNumber, subject и items (1–10 позиций с кандидатами: нормами или ресурсами) (${parsed.error.issues
          .map((issue) => issue.path.join(".") || "тело")
          .slice(0, 6)
          .join(", ")})`,
      },
      { status: 400 },
    );
  }

  const body = parsed.data;
  // Идентификаторы позиций внутри пачки не повторяются: ответ сопоставляется с позицией по id.
  if (new Set(body.items.map((item) => item.id)).size !== body.items.length) {
    return NextResponse.json({ error: "Идентификаторы позиций (items.id) повторяются" }, { status: 400 });
  }

  try {
    const answer = await fetchNormPicks({
      context: { regNumber: body.regNumber, subject: body.subject, jobId: body.jobId ?? null },
      items: body.items.map((item) => ({
        id: item.id,
        workName: item.workName,
        quantity: item.quantity,
        unit: item.unit,
        ...(item.extraVolumes === undefined ? {} : { extraVolumes: item.extraVolumes }),
        remark: item.remark,
        section: item.section,
        ...(item.kind === undefined ? {} : { kind: item.kind }),
        candidates: item.candidates,
        ...(item.resources === undefined || item.resources.length === 0 ? {} : { resources: item.resources.map((resource) => ({ ...resource })) }),
        ...(item.normResource === undefined ? {} : { normResource: { ...item.normResource } }),
      })),
    });
    return NextResponse.json(answer);
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 502 });
  }
}
