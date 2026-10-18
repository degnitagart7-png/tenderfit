import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/app/api/admin/guard";
import { buildAdminUsersReport, type AdminUsersReport } from "@/domain/adminUsers";
import { describeError } from "@/lib/errors";
import { adminUsersRepository } from "@/repositories/adminUsersRepository";
import { llmUsageRepository } from "@/repositories/llmUsageRepository";

/**
 * GET /api/admin/users — сводка и таблица пользователей для /admin/users.
 *
 * Только для администратора (ADMIN_EMAILS), см. `requireAdmin`. Отдаёт почты,
 * сроки доступа, счётчики активности, ошибки и расход на ИИ в рублях; хэшей
 * пароля и токенов сессий здесь нет: репозиторий их не читает.
 *
 * Данные небольшие, поэтому всё считается на лету по строкам за 30 суток (расход и
 * задания — за всё время, чтобы «потрачено всего» было полным): `domain/adminUsers`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

export interface AdminUsersResponse extends AdminUsersReport {
  /** Что нужно знать, читая цифры: чего не хватает (например, миграция журнала не применена). */
  warnings: string[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdmin(request);
  if (!gate.ok) return gate.response;

  try {
    const nowMs = Date.now();
    const since30 = new Date(nowMs - 30 * DAY_MS).toISOString();
    const [users, sessions, events, jobs, llm] = await Promise.all([
      adminUsersRepository.listUsers(),
      adminUsersRepository.listSessionsSince(since30),
      adminUsersRepository.listEventsSince(since30),
      adminUsersRepository.listAttributedJobs(),
      llmUsageRepository.listBetween({}),
    ]);

    const report = buildAdminUsersReport({
      nowMs,
      users,
      sessions,
      events: events.rows,
      jobs,
      llm: llm.map((row) => ({ job_id: row.job_id, created_at: row.created_at, cost_rub: row.cost_rub })),
    });

    const warnings: string[] = [];
    if (!events.available) {
      warnings.push(
        "Журнал действий не создан: примените миграцию 20261014000022_user_events.sql. Пока видны только входы, расход и сбои заданий.",
      );
    }
    const body: AdminUsersResponse = { ...report, warnings };
    return NextResponse.json(body);
  } catch (error) {
    console.error("Админ-панель: сводка не собрана:", describeError(error));
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}
