import { NextRequest, NextResponse } from "next/server";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { documentAnalysisRepository } from "@/repositories/documentAnalysisRepository";
import { documentRepository } from "@/repositories/documentRepository";
import { verdictHistoryRepository } from "@/repositories/verdictHistoryRepository";
import { DAILY_ANALYSIS_LIMIT, analysisQuota, moscowDayStart } from "@/domain/analysisQuota";

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
  try {
    const tenderId = request.nextUrl.searchParams.get("tenderId");
    if (!tenderId) {
      return NextResponse.json({ error: "tenderId query parameter is required" }, { status: 400 });
    }

    const [jobs, verdictHistory, documents, documentAnalyses, usedToday] = await Promise.all([
      analysisJobRepository.findByTenderId(tenderId),
      verdictHistoryRepository.findByTenderId(tenderId),
      documentRepository.listMetaByTenderId(tenderId),
      documentAnalysisRepository.findByTenderId(tenderId),
      analysisJobRepository.countCreatedSince(moscowDayStart(new Date()).toISOString()),
    ]);

    const quota = analysisQuota(usedToday);

    return NextResponse.json({
      jobs,
      verdictHistory,
      documents,
      documentAnalyses,
      quota: { usedToday, remaining: quota.remaining, limit: DAILY_ANALYSIS_LIMIT },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
