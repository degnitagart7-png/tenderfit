import { NextRequest, NextResponse } from "next/server";

import { createAssistLimiter } from "@/app/api/search/guard";
import { summarizeLlmUsage, type LlmCostSummary } from "@/domain/llmCostReport";
import { checkAdminToken } from "@/lib/adminToken";
import { describeError } from "@/lib/errors";
import { clientKey } from "@/lib/rateLimit";
import { llmUsageRepository } from "@/repositories/llmUsageRepository";

/**
 * GET /api/llm-cost — расход на языковую модель за 30 дней для карточки в админке.
 *
 * Закрыт ключом владельца ADMIN_TOKEN (заголовок x-admin-token) так же, как
 * /api/sync-profiles: ключ не задан — ручка выключена (503), а не открыта; попытки
 * считаются лимитом на адрес. Цифры те же, что печатает scripts/llm-cost-report.ts,
 * но без списков самых дорогих закупок: номера закупок клиенту незачем.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createAssistLimiter(20);

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export interface LlmCostCardData {
  summary: Omit<LlmCostSummary, "deepAnalysis" | "estimateBill"> & {
    deepAnalysis: Omit<LlmCostSummary["deepAnalysis"], "top">;
    estimateBill: Omit<LlmCostSummary["estimateBill"], "top">;
  };
  windowDays: number;
}

async function guard(request: NextRequest): Promise<NextResponse | null> {
  const decision = limiter.check(clientKey(request.headers));
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Слишком много попыток. Подождите немного.", retryAfterSec: decision.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
    );
  }

  const verdict = checkAdminToken(request.headers.get("x-admin-token"), process.env["ADMIN_TOKEN"]);
  if (verdict === "disabled") {
    return NextResponse.json(
      { error: "Раздел выключен: на сервере не задан ADMIN_TOKEN (не короче 12 знаков)." },
      { status: 503 },
    );
  }
  if (verdict === "denied") {
    return NextResponse.json({ error: "Неверный ключ владельца." }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await guard(request);
  if (denied) return denied;

  try {
    const until = new Date();
    const since = new Date(until.getTime() - WINDOW_DAYS * DAY_MS);
    const rows = await llmUsageRepository.listBetween({
      since: since.toISOString(),
      until: until.toISOString(),
    });
    const full = summarizeLlmUsage(rows, { since, until });
    // Списки самых дорогих закупок остаются в скрипте отчёта.
    const { top: _deepTop, ...deepAnalysis } = full.deepAnalysis;
    const { top: _billTop, ...estimateBill } = full.estimateBill;
    void _deepTop;
    void _billTop;
    const body: LlmCostCardData = {
      windowDays: WINDOW_DAYS,
      summary: { ...full, deepAnalysis, estimateBill },
    };
    return NextResponse.json(body);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "42P01" || code === "PGRST205") {
      return NextResponse.json(
        { error: "Таблица расхода не создана: примените миграцию 20261008000016_add_llm_usage_log.sql." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}
