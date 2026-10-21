import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireCompanyUser } from "@/app/api/company/requireUser";
import { createRateLimiter } from "@/lib/rateLimit";
import { describeError } from "@/lib/errors";
import { computeCompanyFit, defaultFitDeps } from "@/services/companyFitService";

/**
 * POST /api/company/fit — «Соответствие вашей компании» по закупке с готовым глубоким анализом.
 *
 * Тело: `{ tenderId, force? }`. Ответ: `{ result, cached, degraded? }`, где `result` — `CompanyFitResult`
 * (вердикты по требованиям, контракты по теме, чего не хватает, риски).
 *
 * Чьи данные. Факты и анкета читаются из `user_data` вошедшего (идентификатор — из сессии), не из тела запроса, и пишутся под
 * ним же: чужую сверку получить или подменить нельзя. Тело несёт только номер закупки.
 *
 * Стоимость и лимиты — в `companyFitService`: попадание в кэш бесплатно; модельная сверка — один малый вызов (около 0,1 ₽),
 * суточный лимит глубоких разборов она не расходует, у неё свой предел и лимит частоты здесь (`force` — кнопка
 * «Проверить заново» — не обходит предел). Коды: 401/402 — вход и срок доступа; 404 — закупки нет; 409 — разбор закупки
 * ещё не готов (`reason: "no_analysis"`); 429 — предел сверок за сутки или частоты.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const limiter = createRateLimiter({ limit: 40, windowMs: 10 * 60 * 1000 });

const bodySchema = z.object({
  tenderId: z.string().min(1).max(100),
  force: z.boolean().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const found = await requireCompanyUser(request);
  if (!found.ok) return found.response;
  const { user } = found;

  const decision = limiter.check(user.id);
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Слишком много запросов. Подождите немного.", retryAfterSec: decision.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "Ожидается tenderId." }, { status: 400 });

  try {
    const outcome = await computeCompanyFit(
      { userId: user.id, tenderId: parsed.data.tenderId, ...(parsed.data.force === undefined ? {} : { force: parsed.data.force }) },
      defaultFitDeps(),
    );
    switch (outcome.status) {
      case "no_tender":
        return NextResponse.json({ error: "Закупка не найдена." }, { status: 404 });
      case "no_analysis":
        return NextResponse.json({ error: "Сначала нужен готовый глубокий анализ закупки.", reason: "no_analysis" }, { status: 409 });
      case "limit":
        return NextResponse.json(
          { error: `Достигнут суточный предел сверок с компанией: ${String(outcome.limit)}. Следующую можно сделать после 00:00 по Москве.` },
          { status: 429 },
        );
      case "no_data":
        return NextResponse.json({ result: outcome.result, cached: false });
      case "ok":
        return NextResponse.json({ result: outcome.result, cached: outcome.cached, ...(outcome.degraded ? { degraded: true } : {}) });
    }
  } catch (error) {
    console.error("Сверка с компанией не выполнена:", describeError(error));
    return NextResponse.json({ error: "Не удалось сверить компанию с закупкой. Повторите позже." }, { status: 502 });
  }
}
