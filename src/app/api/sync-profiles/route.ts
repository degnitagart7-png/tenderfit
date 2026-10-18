import { NextRequest, NextResponse } from "next/server";

import { createAssistLimiter } from "@/app/api/search/guard";
import { parseServerProfiles } from "@/domain/syncProfiles";
import { checkAdminToken } from "@/lib/adminToken";
import { describeError } from "@/lib/errors";
import { clientKey } from "@/lib/rateLimit";
import {
  SyncProfilesTableMissingError,
  syncProfileRepository,
} from "@/repositories/syncProfileRepository";

/**
 * Профили, по которым сервер собирает закупки.
 *
 * GET — что сейчас на сервере; PUT — заменить набор.
 *
 * Входа в приложении нет, поэтому ручка закрыта ключом владельца ADMIN_TOKEN
 * (заголовок x-admin-token): без него любой посетитель мог бы подменить темы,
 * по которым сервер ходит на чужие площадки. Ключ не задан — ручка выключена
 * (503), а не открыта. Попытки считаются лимитом на адрес, чтобы ключ нельзя
 * было подбирать.
 */
export const runtime = "nodejs";
// Ответ зависит от куки и окружения: без этого Next.js отдавал бы снимок, сделанный при сборке.
export const dynamic = "force-dynamic";

const limiter = createAssistLimiter(20);

async function guard(request: NextRequest): Promise<NextResponse | null> {
  const decision = limiter.check(clientKey(request.headers));
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Слишком много попыток. Подождите немного.", retryAfterSec: decision.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
    );
  }

  const verdict = checkAdminToken(request.headers.get("x-admin-token"), process.env["ADMIN_TOKEN"]);
  if (verdict === "disabled") {
    return NextResponse.json(
      { error: "Отправка профилей на сервер выключена: на сервере не задан ADMIN_TOKEN (не короче 12 знаков)." },
      { status: 503 },
    );
  }
  if (verdict === "denied") {
    return NextResponse.json({ error: "Неверный ключ владельца." }, { status: 401 });
  }
  return null;
}

function failure(error: unknown): NextResponse {
  if (error instanceof SyncProfilesTableMissingError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  return NextResponse.json({ error: describeError(error) }, { status: 500 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await guard(request);
  if (denied) return denied;

  try {
    return NextResponse.json({ profiles: await syncProfileRepository.list() });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const denied = await guard(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса не JSON" }, { status: 400 });
  }

  const profiles = (body as { profiles?: unknown } | null)?.profiles;
  const parsed = parseServerProfiles(profiles);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    await syncProfileRepository.replaceAll(parsed.profiles);
    return NextResponse.json({ saved: parsed.profiles.length });
  } catch (error) {
    return failure(error);
  }
}
