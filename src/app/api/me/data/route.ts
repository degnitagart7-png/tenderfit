import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAssistLimiter } from "@/app/api/search/guard";
import { clientKey } from "@/lib/rateLimit";
import { userDataRepository } from "@/repositories/userDataRepository";
import { SESSION_COOKIE, getAuthService } from "@/services/authRuntime";

/**
 * Данные аккаунта: профили поиска и анкета компании.
 *
 * GET — что хранится на сервере; PUT — заменить. Только для вошедшего: без
 * действующей сессии 401. Размер ограничен, а профилей не больше тридцати.
 */
export const runtime = "nodejs";
// Ответ зависит от куки и окружения: без этого Next.js отдавал бы снимок, сделанный при сборке.
export const dynamic = "force-dynamic";

const limiter = createAssistLimiter(60);

const MAX_BODY_CHARS = 500_000;

const bodySchema = z.object({
  searchProfiles: z.array(z.record(z.unknown())).max(30),
  companyProfile: z.record(z.unknown()).nullable(),
});

async function currentUser(request: NextRequest) {
  const auth = getAuthService();
  if (auth === null) return null;
  try {
    return await auth.getUser(request.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    return null;
  }
}

function limited(request: NextRequest): NextResponse | null {
  const decision = limiter.check(clientKey(request.headers));
  if (decision.allowed) return null;
  return NextResponse.json(
    { error: "Слишком много запросов. Подождите немного.", retryAfterSec: decision.retryAfterSec },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const tooMany = limited(request);
  if (tooMany) return tooMany;

  const user = await currentUser(request);
  if (user === null) return NextResponse.json({ error: "Нужно войти." }, { status: 401 });

  try {
    const record = await userDataRepository.get(user.id);
    return NextResponse.json({
      searchProfiles: record?.searchProfiles ?? [],
      companyProfile: record?.companyProfile ?? null,
    });
  } catch (error) {
    console.error("Данные аккаунта не прочитаны:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Данные аккаунта сейчас недоступны." }, { status: 503 });
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const tooMany = limited(request);
  if (tooMany) return tooMany;

  const user = await currentUser(request);
  if (user === null) return NextResponse.json({ error: "Нужно войти." }, { status: 401 });

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: "Данные слишком большие." }, { status: 413 });

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "Данные не приняты." }, { status: 400 });

  try {
    await userDataRepository.put(user.id, parsed.data);
    return NextResponse.json({ saved: true });
  } catch (error) {
    console.error("Данные аккаунта не сохранены:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Не удалось сохранить данные аккаунта." }, { status: 503 });
  }
}
