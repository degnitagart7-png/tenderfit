import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/app/api/admin/guard";
import { buildFunnel, parseFunnelPeriod, type FunnelReport } from "@/domain/adminFunnel";
import { describeError } from "@/lib/errors";
import { adminUsersRepository } from "@/repositories/adminUsersRepository";

/**
 * GET /api/admin/funnel?period=all|7d|30d — воронка клиентов для /admin/users.
 *
 * Только для администратора (ADMIN_EMAILS), см. `requireAdmin`: в ответе почты
 * людей и их шаги. Период отбирает тех, кто зарегистрировался за последние 7 или
 * 30 суток; без параметра — все. Администраторы в воронку не входят. Хэшей и
 * содержимого профилей в ответе нет: репозиторий отдаёт только признаки.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface AdminFunnelResponse extends FunnelReport {
  generatedAt: string;
  /** Что нужно знать, читая цифры (например, журнал действий ещё не создан). */
  warnings: string[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;

  const period = parseFunnelPeriod(request.nextUrl.searchParams.get("period"));
  if (period === null) {
    return NextResponse.json({ error: "Период: all, 7d или 30d." }, { status: 400 });
  }

  try {
    const nowMs = Date.now();
    const [users, facts] = await Promise.all([adminUsersRepository.listUsers(), adminUsersRepository.loadFunnelFacts()]);
    const report = buildFunnel(users, facts, nowMs, period);

    const warnings: string[] = [];
    if (!facts.eventsAvailable) {
      warnings.push(
        "Журнал действий не создан: примените миграцию 20261014000022_user_events.sql. Пока шаги про ленту и закупки не видны, остальное считается по профилям и заданиям.",
      );
    }
    const body: AdminFunnelResponse = { ...report, generatedAt: new Date(nowMs).toISOString(), warnings };
    return NextResponse.json(body);
  } catch (error) {
    console.error("Админ-панель: воронка не собрана:", describeError(error));
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}
