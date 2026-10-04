import { NextRequest, NextResponse } from "next/server";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { analysisQuota, moscowDayStart } from "@/domain/analysisQuota";

/**
 * POST /api/analysis/trigger
 * Body: { tenderId: string, priority?: number, jobType?: "full_analysis" | "reanalyze" | "parse_only" }
 *
 * Ставит закупку в очередь глубокого анализа. Вызывается из интерфейса кнопкой
 * «Запустить глубокий анализ» в панели на карточке закупки — и только ею: стадия
 * воронки задачу не создаёт, чтобы «эта закупка мне интересна» не означало
 * автоматически «потрать на неё разбор».
 *
 * Повторный вызов для закупки, которая уже в очереди или в работе, новую задачу
 * не создаёт: иначе каждое лишнее нажатие оплачивалось бы ещё одним разбором
 * того же документа.
 *
 * Суточный лимит (analysisQuota) проверяется после этой проверки и только перед
 * созданием задачи: повторное нажатие не должно упираться в лимит, который оно
 * не расходует.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      tenderId: string;
      priority?: number;
      jobType?: "full_analysis" | "reanalyze" | "parse_only";
    };

    if (!body.tenderId) {
      return NextResponse.json({ error: "tenderId is required" }, { status: 400 });
    }

    const existing = await analysisJobRepository.findByTenderId(body.tenderId);
    const active = existing.find(
      (job) => job.status === "pending" || job.status === "processing",
    );
    if (active) {
      return NextResponse.json({ job: active, deduped: true }, { status: 200 });
    }

    const usedToday = await analysisJobRepository.countCreatedSince(
      moscowDayStart(new Date()).toISOString(),
    );
    const quota = analysisQuota(usedToday);
    if (!quota.allowed) {
      return NextResponse.json(
        { error: quota.reason, quota: { usedToday, remaining: quota.remaining } },
        { status: 429 },
      );
    }

    const job = await analysisJobRepository.create(
      body.tenderId,
      body.jobType ?? "full_analysis",
      body.priority ?? 0,
    );

    return NextResponse.json(
      { job, deduped: false, quota: { usedToday: usedToday + 1, remaining: quota.remaining - 1 } },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
