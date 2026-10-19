import { requireAccess } from "@/app/api/auth/requireAccess";
import { recordRequestEvent } from "@/app/api/auth/requestUser";
import { NextRequest, NextResponse } from "next/server";

import { estimateViewer } from "@/app/api/estimate/viewer";
import {
  HISTORY_MAX_PAGE_SIZE,
  HISTORY_PAGE_SIZE,
  type EstimateHistoryPage,
} from "@/domain/estimate/estimateHistory";
import { ownerKey } from "@/domain/estimate/jobOwnership";
import { describeError } from "@/lib/errors";
import { syncJobRepository } from "@/repositories/syncJobRepository";

/**
 * GET /api/estimate/history?limit=20&before=<курсор> — «Мои расчёты»: расчёты сметы того, кто
 * спрашивает, от нового к старому.
 *
 * Только свои: отбор по `requested_by` — почте вошедшего — делает запрос в базу, а не фильтр
 * после него, чужие расчёты сюда не попадают вовсе. Даже у администратора список свой; чужое
 * задание он открывает по номеру (`GET /api/estimate?jobId=`), как в письме о сбое.
 *
 * Ответ лёгкий — `EstimateHistoryPage`: номер, статус, время, режим, закупка, объект, имена файлов,
 * итог с НДС и краткая причина сбоя. Тексты документов и сама смета не отдаются: открытие расчёта —
 * отдельный запрос по номеру.
 *
 * Страницы — по ключу: `nextCursor` (время постановки последней строки) подставляется в `before`.
 * Смещения нет намеренно: наверх приходят новые расчёты, и по смещению строка показалась бы дважды.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Курсор — метка времени из базы (`2026-10-20T10:00:00.123456+00:00`); всё остальное отклоняется до запроса. */
const CURSOR_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const limitParam = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), HISTORY_MAX_PAGE_SIZE) : HISTORY_PAGE_SIZE;

  // Плюс в смещении пояса («+00:00»), не закодированный клиентом, приходит пробелом: чиним.
  const rawBefore = params.get("before")?.replace(" ", "+") ?? null;
  if (rawBefore !== null && (rawBefore.length > 40 || !CURSOR_PATTERN.test(rawBefore))) {
    return NextResponse.json({ error: "Неверный курсор before" }, { status: 400 });
  }

  try {
    // На одну строку больше страницы: так видно, есть ли следующая, без отдельного подсчёта.
    const rows = await syncJobRepository.listEstimateHistory(ownerKey(estimateViewer(request)), {
      limit: limit + 1,
      before: rawBefore,
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const page: EstimateHistoryPage = {
      items,
      nextCursor: rows.length > limit && last !== undefined ? last.createdAt : null,
    };
    return NextResponse.json(page);
  } catch (error) {
    recordRequestEvent(request, { kind: "error", ok: false, detail: `GET /api/estimate/history: ${describeError(error)}` });
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}
