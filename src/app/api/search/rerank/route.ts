import { requireAccess } from "@/app/api/auth/requireAccess";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAssistLimiter, readGuardedBody } from "@/app/api/search/guard";
import { MAX_RERANK_ITEMS } from "@/domain/searchAssist";
import { describeError } from "@/lib/errors";
import { searchAssist } from "@/services/searchAssistService";

/**
 * POST /api/search/rerank — оценка найденных закупок по смыслу.
 *
 * Тело: { query, companyNote?, candidates: [{ id, subject, customer? }] }.
 * Ответ: { verdicts: { [id]: { fit: "yes" | "maybe" | "no", reason } }, cached }.
 *
 * Зачем. Поиск по словам находит «услуги юридическому лицу» там, где человек
 * ищет юридические услуги: корень один, смысл разный. Векторный поиск этого не
 * лечит (замер 04.10.2026), а модель, читающая название целиком, различает.
 * Работает только по нажатию кнопки и не больше чем на тридцать закупок: токены
 * растут линейно, а потолок защищает и бюджет, и время ответа.
 *
 * Лимит: десять запросов за десять минут на адрес. Идентификаторы закупок
 * модели не отдаются — только номера в списке.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const limiter = createAssistLimiter(10);

const bodySchema = z.object({
  query: z.string().trim().min(1).max(200),
  companyNote: z.string().trim().max(400).optional(),
  candidates: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        subject: z.string().trim().min(1).max(600),
        customer: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(MAX_RERANK_ITEMS),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  const body = await readGuardedBody(request, limiter, bodySchema);
  if (!body.ok) return body.response;

  try {
    /*
      Описание компании клиента (companyNote) в модель не уходит (решение владельца 19.10.2026):
      модель работает через зарубежного провайдера, а данные клиентов храним и обрабатываем в РФ
      (152-ФЗ). Поле принимается для совместимости со старыми вкладками, но отбрасывается здесь,
      на сервере; оценка по смыслу идёт по запросу и названиям закупок.
    */
    const { verdicts, cached } = await searchAssist.rerank({
      query: body.data.query,
      candidates: body.data.candidates,
    });
    return NextResponse.json({ verdicts, cached });
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 502 });
  }
}
