import { requireAccess } from "@/app/api/auth/requireAccess";
import { NextRequest, NextResponse } from "next/server";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";

/**
 * GET /api/analysis/completed
 *
 * Закупки, по которым глубокий разбор уже закончен. Нужен двум экранам сразу:
 * блоку «Разбор готов» на «Сегодня» и отметке в списке закупок.
 *
 * Отдаёт идентификаторы и время окончания, а не карточки: наименование, цену и
 * срок подачи клиент уже держит — это та же выдача, которую он показывает. Так
 * один дешёвый запрос закрывает оба экрана, и ни один из них не ходит за
 * состоянием разбора по каждой закупке отдельно.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  try {
    const completed = await analysisJobRepository.listCompleted();
    return NextResponse.json({ completed }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
