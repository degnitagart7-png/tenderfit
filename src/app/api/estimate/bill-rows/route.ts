import { NextRequest, NextResponse } from "next/server";

import { rejectWithoutWorkerSecret, WORKER_SECRET_HEADER } from "@/lib/workerSecret";
import { z } from "zod";

import { describeError } from "@/lib/errors";
import { fetchBillRows } from "@/services/billOfWorkExtraction";

/**
 * POST /api/estimate/bill-rows — строки ведомости из одного фрагмента текста.
 *
 * Зачем эта ручка вообще нужна. Ключ языковой модели в проекте живёт в одном
 * месте — на проде. Глубокий разбор устроен так же: воркер дёргает
 * `/api/analysis/worker`, а модель зовёт Vercel. Расчёт сметы сначала нарушил
 * это правило и звал модель прямо с сервера воркера, из-за чего ключ
 * потребовался бы на второй машине — арендованной коробке, где его до сих пор
 * намеренно не было.
 *
 * Разделение получается по тому, что каждая сторона умеет: у прода ключ, у
 * воркера база сметных нормативов на 400 МБ. Фрагмент документа едет на прод,
 * оттуда — в модель, строки возвращаются воркеру, и он их проверяет по тексту,
 * подбирает нормы и считает деньги.
 *
 * Почему принимается фрагмент, а не готовый запрос к модели. Ручка, которая
 * пересылает модели произвольный текст, — это бесплатный прокси к платному
 * шлюзу для любого, кто узнает адрес. Здесь запрос собирается на сервере по
 * неизменному шаблону, и ничего, кроме поиска ведомости, эта ручка сделать не
 * может.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Длинные подписи обрезаются, а не отклоняются: предмет закупки в ЕИС бывает
 * длиннее 500 знаков (0302300048726001118 — 517), имя входа архива — длиннее
 * 300. Отказ из-за подписи ронял весь расчёт сметы, хотя модели она нужна лишь
 * для контекста.
 */
const clipped = (max: number) =>
  z
    .string()
    .transform((value) => value.trim().slice(0, max))
    .pipe(z.string().min(1));

const requestSchema = z.object({
  chunk: z.string().min(1).max(200_000),
  regNumber: clipped(64),
  subject: clipped(1000),
  documentName: clipped(500),
  /** Задание расчёта: только метка для журнала расхода llm_usage_log. */
  jobId: z.string().min(1).max(64).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Только воркер: ручка тратит ключ модели (см. src/lib/workerSecret.ts).
  const denied = rejectWithoutWorkerSecret(request.headers?.get(WORKER_SECRET_HEADER));
  if (denied !== null) return NextResponse.json({ error: denied.error }, { status: denied.status });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Ожидается chunk, regNumber, subject и documentName (${parsed.error.issues
          .map((issue) => issue.path.join(".") || "тело")
          .join(", ")})`,
      },
      { status: 400 },
    );
  }

  try {
    const answer = await fetchBillRows({
      chunk: parsed.data.chunk,
      context: {
        regNumber: parsed.data.regNumber,
        subject: parsed.data.subject,
        jobId: parsed.data.jobId ?? null,
      },
      documentName: parsed.data.documentName,
    });

    return NextResponse.json(answer);
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 502 });
  }
}
