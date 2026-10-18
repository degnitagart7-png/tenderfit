import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/app/api/admin/guard";
import { buildUserJournal, type JournalItem } from "@/domain/adminUsers";
import { describeError } from "@/lib/errors";
import { adminUsersRepository } from "@/repositories/adminUsersRepository";

/**
 * GET /api/admin/users/events?email=… — журнал одного пользователя.
 *
 * Последние 200 записей: его действия (`user_events`) и упавшие задания разбора
 * и очереди, новые сверху. Только для администратора (см. `requireAdmin`).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 200;

const emailSchema = z.string().trim().toLowerCase().min(3).max(320).includes("@");

export interface AdminUserEventsResponse {
  email: string;
  items: JournalItem[];
  /** false — таблицы журнала действий ещё нет; показаны только упавшие задания. */
  eventsAvailable: boolean;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;

  const parsed = emailSchema.safeParse(request.nextUrl.searchParams.get("email") ?? "");
  if (!parsed.success) return NextResponse.json({ error: "Нужна почта пользователя (email)." }, { status: 400 });
  const email = parsed.data;

  try {
    const [events, failed] = await Promise.all([
      adminUsersRepository.listUserEvents(email, LIMIT),
      adminUsersRepository.listFailedJobs(email, LIMIT),
    ]);
    const body: AdminUserEventsResponse = {
      email,
      items: buildUserJournal(events.rows, failed, LIMIT),
      eventsAvailable: events.available,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error("Админ-панель: журнал не собран:", describeError(error));
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}
