import { NextRequest, NextResponse } from "next/server";

import { createAssistLimiter } from "@/app/api/search/guard";
import { parseDemandReport } from "@/domain/demand";
import { describeError } from "@/lib/errors";
import { clientKey } from "@/lib/rateLimit";
import {
  SearchDemandFullError,
  SearchDemandTableMissingError,
  searchDemandRepository,
} from "@/repositories/searchDemandRepository";

/**
 * Спрос посетителя: какие темы закупок он ждёт.
 *
 * POST { visitorId, profiles } — заменить темы посетителя. Сервер собирает
 * закупки по объединению тем всех активных посетителей.
 *
 * Ручка открыта без входа, а за каждой темой стоят запросы к чужим площадкам,
 * поэтому защита в трёх местах: лимит на адрес, пределы отчёта (не больше пяти
 * профилей и пятнадцати слов, слова чистятся как запрос живого поиска) и общий
 * предел таблицы. Сверх этого сборщик берёт за прогон только ограниченное число
 * самых востребованных слов.
 */
export const runtime = "nodejs";

const limiter = createAssistLimiter(20);

const MAX_BODY_CHARS = 20_000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const decision = limiter.check(clientKey(request.headers));
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Слишком много обновлений. Подождите немного.", retryAfterSec: decision.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
    );
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return NextResponse.json({ error: "Тело запроса не прочитано" }, { status: 400 });
  }
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: "Отчёт слишком большой" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }

  const parsed = parseDemandReport(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    await searchDemandRepository.replaceForVisitor(parsed.visitorId, parsed.entries);
    return NextResponse.json({ topics: parsed.entries.length });
  } catch (error) {
    if (error instanceof SearchDemandTableMissingError || error instanceof SearchDemandFullError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}
