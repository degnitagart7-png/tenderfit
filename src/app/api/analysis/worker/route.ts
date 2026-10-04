import { NextResponse } from "next/server";
import { processAnalysisJob } from "@/services/documentAnalysisPipeline";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";

export const dynamic = "force-dynamic";

/**
 * Разбор одного фрагмента документа моделью занимает десятки секунд, а Vercel
 * Hobby по умолчанию обрывает функцию на 10. Просим максимум доступного тарифу;
 * если воркер всё равно не уложится, задача вернётся в очередь и продолжится
 * следующим вызовом.
 */
export const maxDuration = 60;

/**
 * GET /api/analysis/worker
 *
 * Вызывается планировщиком и локальным скриптом загрузки документации.
 * 1. Возвращает в очередь зависшие задачи (processing дольше 10 минут)
 * 2. Обрабатывает одну задачу из очереди
 */
export async function GET(): Promise<NextResponse> {
  try {
    const resetCount = await analysisJobRepository.resetStaleJobs(10);

    const result = await processAnalysisJob();

    return NextResponse.json({
      staleJobsReset: resetCount,
      processed: result
        ? {
            jobId: result.jobId,
            tenderId: result.tenderId,
            documentsProcessed: result.documentsProcessed,
            findingsTotal: result.findingsTotal,
            verdictChanged: result.verdictChanged,
            // true — время функции кончилось, разбор продолжит следующий вызов.
            deferred: result.deferred,
          }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
