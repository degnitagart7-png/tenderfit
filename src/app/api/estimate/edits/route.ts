import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAssistLimiter } from "@/app/api/search/guard";
import { billEditsRecordSchema } from "@/domain/estimate/billEdits";
import { clientKey } from "@/lib/rateLimit";
import { AppStateUnavailableError, userDataRepository } from "@/repositories/userDataRepository";
import { SESSION_COOKIE, getAuthService } from "@/services/authRuntime";

/**
 * Правки ведомости сметы, сохранённые за закупкой и пользователем.
 *
 * GET ?tenderId=… — что сохранено; PUT `{ tenderId, record }` — сохранить, `record: null` — отбросить.
 * Лежит в данных аккаунта (`user_data.app_state`) под ключом `bill-edits:<tenderId>`: отдельной
 * таблицы и миграции не нужно. Только для вошедшего: без сессии 401, и экран держит правки на
 * устройстве. Нет колонки app_state (миграция 20261005000014 не применена) — 503 по той же причине.
 *
 * Запись ведётся по ключу, а не всей строкой: профили поиска и анкета компании не задеваются.
 * Ключи с этим префиксом принадлежат серверу — полная запись данных аккаунта с устройства
 * (`PUT /api/me/data`) их не стирает (см. `userDataRepository`).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createAssistLimiter(120);

/** Запись правок — сотни строк с цитатами; дальше это уже не правки. */
const MAX_BODY_CHARS = 600_000;

const putSchema = z.object({
  tenderId: z.string().min(1).max(200),
  record: billEditsRecordSchema.nullable(),
});

const keyOf = (tenderId: string): string => `bill-edits:${tenderId}`;

async function currentUser(request: NextRequest) {
  const auth = getAuthService();
  if (auth === null) return null;
  try {
    return await auth.getUser(request.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    return null;
  }
}

function tooMany(request: NextRequest): NextResponse | null {
  const decision = limiter.check(clientKey(request.headers));
  if (decision.allowed) return null;
  return NextResponse.json(
    { error: "Слишком много запросов. Подождите немного.", retryAfterSec: decision.retryAfterSec },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
  );
}

function failure(error: unknown): NextResponse {
  if (error instanceof AppStateUnavailableError) {
    return NextResponse.json({ error: "Сервер пока не хранит правки: они сохранены на этом устройстве." }, { status: 503 });
  }
  console.error("Правки ведомости не обработаны:", error instanceof Error ? error.message : error);
  return NextResponse.json({ error: "Правки сейчас недоступны." }, { status: 503 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = tooMany(request);
  if (limited) return limited;

  const tenderId = request.nextUrl.searchParams.get("tenderId");
  if (tenderId === null || tenderId.length === 0 || tenderId.length > 200) {
    return NextResponse.json({ error: "Нужен tenderId" }, { status: 400 });
  }
  const user = await currentUser(request);
  if (user === null) return NextResponse.json({ error: "Нужно войти." }, { status: 401 });

  try {
    const state = await userDataRepository.getAppState(user.id);
    const parsed = billEditsRecordSchema.safeParse(state?.[keyOf(tenderId)]);
    // Запись, не прошедшая проверку (старая версия формата), — как будто правок нет: устройство не должно падать.
    return NextResponse.json({ record: parsed.success ? parsed.data : null });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const limited = tooMany(request);
  if (limited) return limited;

  const user = await currentUser(request);
  if (user === null) return NextResponse.json({ error: "Нужно войти." }, { status: 401 });

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ error: "Правок слишком много." }, { status: 413 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "Правки не приняты." }, { status: 400 });
  const { tenderId, record } = parsed.data;
  if (record !== null && record.tenderId !== tenderId) {
    return NextResponse.json({ error: "Правки относятся к другой закупке." }, { status: 400 });
  }

  try {
    // Пустой список правок не хранится: нечего восстанавливать, а ключ в данных аккаунта лишний.
    await userDataRepository.setAppStateEntry(user.id, keyOf(tenderId), record === null || record.edits.length === 0 ? null : record);
    return NextResponse.json({ saved: true });
  } catch (error) {
    return failure(error);
  }
}
