import { NextRequest, NextResponse } from "next/server";
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

const requestSchema = z.object({
  chunk: z.string().min(1).max(200_000),
  regNumber: z.string().min(1).max(64),
  subject: z.string().min(1).max(500),
  documentName: z.string().min(1).max(300),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Ожидается chunk, regNumber, subject и documentName" },
      { status: 400 },
    );
  }

  try {
    const answer = await fetchBillRows({
      chunk: parsed.data.chunk,
      context: {
        regNumber: parsed.data.regNumber,
        subject: parsed.data.subject,
      },
      documentName: parsed.data.documentName,
    });

    return NextResponse.json(answer);
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 502 });
  }
}
