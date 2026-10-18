import { EXPIRED_MESSAGE, lookupAccess } from "@/app/api/auth/requireAccess";
import { hasAccess } from "@/domain/access";
import { NextRequest, NextResponse } from "next/server";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { moscowDayStart, userAnalysisQuota } from "@/domain/analysisQuota";
import { queueDocumentsForAnalysis } from "@/services/syncJobService";
import { withoutRequester } from "@/domain/jobRequester";
import { recordUserEvent } from "@/services/userEventLog";

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
  // Как requireAccess, но с почтой: суточный лимит разборов считается на человека.
  const found = await lookupAccess(request);
  if (!found.ok) return found.response;
  const requestedBy = found.email === null ? null : found.email.trim().toLowerCase();
  if (found.access !== null && !hasAccess(found.access)) {
    // Попытка после конца доступа тоже видна в журнале: человек хотел пользоваться.
    void recordUserEvent({ email: requestedBy, kind: "deep_analysis", ok: false, detail: "отказ: доступ закончился" });
    return NextResponse.json({ error: EXPIRED_MESSAGE, reason: "expired" }, { status: 402 });
  }

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
      // Повторное нажатие по задаче, которая ждёт, ставит загрузку ещё раз:
      // задачи, созданные до появления загрузки по кнопке, иначе ждали бы
      // планового прогона. Дубля не будет — очередь заданий схлопывает
      // одинаковые по номеру.
      const documents = await queueDocumentsForAnalysis(body.tenderId, requestedBy);
      return NextResponse.json({ job: withoutRequester(active), deduped: true, documents }, { status: 200 });
    }

    const dayStart = moscowDayStart(new Date()).toISOString();
    const [globalUsed, userUsed] = await Promise.all([
      analysisJobRepository.countCreatedSince(dayStart),
      requestedBy === null ? Promise.resolve(null) : analysisJobRepository.countCreatedSince(dayStart, requestedBy),
    ]);
    const usedToday = userUsed ?? globalUsed;
    const quota = userAnalysisQuota({ userUsed, globalUsed });
    if (!quota.allowed) {
      void recordUserEvent({
        email: requestedBy,
        kind: "deep_analysis",
        ok: false,
        tenderId: body.tenderId,
        detail: `отказ: ${quota.reason ?? "суточный лимит"}`,
      });
      return NextResponse.json(
        { error: quota.reason, quota: { usedToday, remaining: quota.remaining } },
        { status: 429 },
      );
    }

    const job = await analysisJobRepository.create(
      body.tenderId,
      body.jobType ?? "full_analysis",
      body.priority ?? 0,
      requestedBy,
    );

    // Документация и разбор — сразу, а не плановым прогоном раз в два часа.
    const documents = await queueDocumentsForAnalysis(body.tenderId, requestedBy);

    // Считается только поставленный разбор: повторное нажатие (ветка выше) в журнал не идёт.
    void recordUserEvent({ email: requestedBy, kind: "deep_analysis", tenderId: body.tenderId });

    return NextResponse.json(
      {
        job: withoutRequester(job),
        deduped: false,
        documents,
        quota: { usedToday: usedToday + 1, remaining: quota.remaining - 1 },
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    void recordUserEvent({ email: requestedBy, kind: "error", ok: false, detail: `POST /api/analysis/trigger: ${message}` });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
