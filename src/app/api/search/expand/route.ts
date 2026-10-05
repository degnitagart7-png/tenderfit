import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAssistLimiter, readGuardedBody } from "@/app/api/search/guard";
import { describeError } from "@/lib/errors";
import { searchAssist } from "@/services/searchAssistService";

/**
 * POST /api/search/expand — варианты формулировки запроса от языковой модели.
 *
 * Тело: { query }. Ответ: { synonyms, cached }.
 *
 * Зачем. Слова запроса ищутся по основе и не знают смысла: «юридические услуги»
 * не найдёт «правовое сопровождение». Модель предлагает формулировки, которыми
 * заказчик мог назвать то же самое, и человек добавляет нужные в поиск.
 *
 * Принимается только короткий запрос, а шаблон промпта неизменен: ручка,
 * пересылающая модели произвольный текст, — бесплатный прокси к платному
 * шлюзу. На адрес действует лимит: двадцать запросов за десять минут.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const limiter = createAssistLimiter(20);

const bodySchema = z.object({
  query: z.string().trim().min(1).max(200),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await readGuardedBody(request, limiter, bodySchema);
  if (!body.ok) return body.response;

  try {
    const { synonyms, cached } = await searchAssist.expand(body.data.query);
    return NextResponse.json({ synonyms, cached });
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 502 });
  }
}
