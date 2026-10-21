import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireCompanyUser } from "@/app/api/company/requireUser";
import { createRateLimiter } from "@/lib/rateLimit";
import { describeError } from "@/lib/errors";
import { extractCompanyFacts, FactsExtractionError } from "@/services/companyFactsService";
import { llmChat } from "@/services/searchAssistService";

/**
 * POST /api/company/facts — деловые факты компании из её документов.
 *
 * Тело: `{ documents: [{ id, name, category, text }], companyInn?, companyName? }` — тексты документов анкеты.
 * Ответ: `{ facts, skipped, truncated, sentChars, calls, droppedForPii, failedCalls }`.
 *
 * Что делает. Очищает тексты от персональных данных (ФИО, телефоны, почта, паспорт, СНИЛС, дата рождения, личный адрес),
 * по одному вызову модели на порцию очищенного текста извлекает факты (виды работ, контракты, СРО, лицензии, кадры,
 * техника, свои цены) и проверяет ответ ещё раз на личное. Сырой текст в модель не уходит никогда: очистка выполняется здесь,
 * даже если браузер уже показал человеку очищенный вариант (серверу присланное устройством не доверяется).
 *
 * Куда пишутся факты. Сюда — никуда: ручка отдаёт их браузеру, а он сохраняет анкету обычным путём синхронизации
 * (`accountSync` → `PUT /api/me/data`). Запись «заменить целиком» работает по принципу последнего записавшего, и серверная
 * запись фактов в `user_data.company_profile` затиралась бы следующей отправкой анкеты с устройства, где фактов ещё нет;
 * правки человека (удалил или поправил строку фактов) тоже живут в анкете. Так у фактов один владелец и один путь.
 *
 * Защита. Вход и срок доступа обязательны (401/402), лимит — шесть извлечений за десять минут на человека, размер тела
 * ограничен. Расход пишется в `llm_usage_log` с видом работы `company_facts`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Сырой текст документов может быть длиннее бюджета (лишнее отрезается планом); выше этого — не наш запрос. */
const MAX_BODY_CHARS = 3_000_000;
const MAX_DOC_CHARS = 600_000;

const limiter = createRateLimiter({ limit: 6, windowMs: 10 * 60 * 1000 });

const CATEGORIES = ["license", "sro", "experience", "financial", "other", "price", "staff", "equipment"] as const;

const bodySchema = z.object({
  documents: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().max(300),
        category: z.enum(CATEGORIES).catch("other"),
        text: z.string().max(MAX_DOC_CHARS),
      }),
    )
    .min(1)
    .max(30),
  companyInn: z.string().max(20).optional(),
  companyName: z.string().max(300).optional(),
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

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_CHARS * 2) {
    return NextResponse.json({ error: "Документы слишком большие." }, { status: 413 });
  }
  let payload: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: "Документы слишком большие." }, { status: 413 });
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Ожидаются documents (1–30 документов: id, name, category, text)." }, { status: 400 });
  }

  try {
    const result = await extractCompanyFacts(
      {
        documents: parsed.data.documents,
        ...(parsed.data.companyInn === undefined ? {} : { companyInn: parsed.data.companyInn }),
        ...(parsed.data.companyName === undefined ? {} : { companyName: parsed.data.companyName }),
        userId: user.id,
      },
      { chat: llmChat },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FactsExtractionError) return NextResponse.json({ error: error.message }, { status: 422 });
    console.error("Факты компании не извлечены:", describeError(error));
    return NextResponse.json({ error: "Не удалось обновить профиль по документам. Повторите позже." }, { status: 502 });
  }
}
