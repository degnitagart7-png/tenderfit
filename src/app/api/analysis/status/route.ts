import { EXPIRED_MESSAGE, lookupAccess } from "@/app/api/auth/requireAccess";
import { hasAccess } from "@/domain/access";
import { NextRequest, NextResponse } from "next/server";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { documentAnalysisRepository } from "@/repositories/documentAnalysisRepository";
import { documentRepository } from "@/repositories/documentRepository";
import { verdictHistoryRepository } from "@/repositories/verdictHistoryRepository";
import { DAILY_ANALYSIS_LIMIT, moscowDayStart, userAnalysisQuota } from "@/domain/analysisQuota";
import { withoutRequester } from "@/domain/jobRequester";
import { recordUserEvent } from "@/services/userEventLog";

/**
 * GET /api/analysis/status?tenderId=...
 *
 * Всё, что нужно карточке закупки для блока «Глубокий анализ документации»:
 * очередь задач, найденные документы, факторы из разобранных фрагментов
 * и история вердиктов.
 *
 * Отдаём строки БД как есть, без переименования полей: клиент импортирует те же
 * типы, и расхождение между ответом и интерфейсом становится невозможно.
 * Документы берутся через listMetaByTenderId — parsed_text (сотни килобайт
 * на закупку) в ответ не попадает.
 *
 * Квота суточных разборов читается тем же счётчиком, что и в POST
 * /api/analysis/trigger, но без создания задачи: так остаток лимита виден
 * на проде, не расходуя его.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const found = await lookupAccess(request);
  if (!found.ok) return found.response;
  if (found.access !== null && !hasAccess(found.access)) {
    return NextResponse.json({ error: EXPIRED_MESSAGE, reason: "expired" }, { status: 402 });
  }
  const requestedBy = found.email === null ? null : found.email.trim().toLowerCase();

  try {
    const tenderId = request.nextUrl.searchParams.get("tenderId");
    if (!tenderId) {
      return NextResponse.json({ error: "tenderId query parameter is required" }, { status: 400 });
    }

    // Журнал действий: карточку закупки открыли (раз в час на человека и закупку).
    void recordUserEvent({ email: found.email, kind: "tender_open", tenderId });

    const dayStart = moscowDayStart(new Date()).toISOString();
    const [jobs, verdictHistory, documents, documentAnalyses, globalUsed, userUsed] = await Promise.all([
      analysisJobRepository.findByTenderId(tenderId),
      verdictHistoryRepository.findByTenderId(tenderId),
      documentRepository.listMetaByTenderId(tenderId),
      documentAnalysisRepository.findByTenderId(tenderId),
      analysisJobRepository.countCreatedSince(dayStart),
      requestedBy === null ? Promise.resolve(null) : analysisJobRepository.countCreatedSince(dayStart, requestedBy),
    ]);

    // Остаток — свой: 20 разборов в сутки на человека (и общий аварийный потолок).
    const usedToday = userUsed ?? globalUsed;
    const quota = userAnalysisQuota({ userUsed, globalUsed });

    return NextResponse.json({
      // Почта того, кто поставил разбор, обычному пользователю не нужна и может быть чужой.
      jobs: jobs.map(withoutRequester),
      verdictHistory,
      documents,
      documentAnalyses,
      quota: { usedToday, remaining: quota.remaining, limit: DAILY_ANALYSIS_LIMIT },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    void recordUserEvent({ email: found.email, kind: "error", ok: false, detail: `GET /api/analysis/status: ${message}` });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
