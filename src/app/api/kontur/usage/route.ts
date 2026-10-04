import { NextRequest, NextResponse } from "next/server";
import { hasKonturApiKey, resolveKonturContract } from "@/adapters/tender-source/konturContract";
import {
  fetchKonturTariff,
  type KonturTariffInfo,
} from "@/services/konturSyncService";
import { konturCacheRepository } from "@/repositories/konturCacheRepository";

export const dynamic = "force-dynamic";

/**
 * Суточный бюджет на каждый метод — тот же, что использует сервис
 * синхронизации. Применяется только как страховка: настоящий остаток отдаёт
 * тариф (поле `tariff.available`), и он считается по группам, а не по нашему
 * журналу. Боевой тариф с 24.09.2026 — 30 запросов в сутки на метод.
 */
const DEFAULT_DAILY_LIMIT = 30;

/** Сколько последних записей журнала отдаём на страницу «Журнал заданий». */
const MAX_RECENT = 100;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * GET /api/kontur/usage
 *
 * Сводка расхода платного API Контур.Закупок: сколько запросов сделано сегодня,
 * сколько ответов получено из кэша, какой остаток по тарифу и сколько сырых
 * ответов накоплено для повторного использования.
 *
 * Журнал читается из таблиц api_usage_log и kontur_raw_responses. Остаток
 * тарифа — единственный живой запрос к Контур.Закупкам, и он бесплатный
 * (`/external/v1/limitGroups` не списывает лимит группы), поэтому открытие
 * панели trial не тратит. Если миграция 20260921000003 ещё не применена,
 * счётчики журнала будут нулевыми, а остаток тарифа — настоящим.
 *
 * Ответ: { configured, baseUrl, paths, dailyRequestLimit, spentToday,
 *          spentTodayByMethod, remainingToday, remainingTodayByMethod, summary,
 *          recent, storedResponses, tariff, tariffError }
 *
 * `dailyRequestLimit` — бюджет на каждый метод (поиск и карточки считаются
 * раздельно, как группы тарифа), поэтому расход и остаток тоже отданы по
 * методам: одна общая сумма скрыла бы, что поиски кончились, а карточки нет.
 *
 * Ключ API в ответ не попадает — только признак configured.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const limitParam = Number.parseInt(
    request.nextUrl.searchParams.get("limit") ?? "",
    10,
  );
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), MAX_RECENT)
    : 50;

  const contract = resolveKonturContract();
  const configured = hasKonturApiKey(contract);
  const dailyRequestLimit = envNumber("KONTUR_DAILY_REQUEST_LIMIT", DEFAULT_DAILY_LIMIT);
  const now = new Date().toISOString();

  const [summary, recent, storedResponses, spentByMethod] = await Promise.all([
    konturCacheRepository.summaryToday(now),
    konturCacheRepository.recent(limit),
    konturCacheRepository.storedResponses(),
    konturCacheRepository.billableCallsToday(now),
  ]);

  // Бюджет без ограничения (0 или меньше) — остаток не считаем.
  const limited = dailyRequestLimit > 0;
  const remainingByMethod = {
    search: limited ? Math.max(0, dailyRequestLimit - spentByMethod.search) : null,
    card: limited ? Math.max(0, dailyRequestLimit - spentByMethod.card) : null,
  };
  // Общий остаток — по самому узкому методу: именно он ограничивает следующий
  // прогон, и показывать сумму двух групп было бы обещанием, которого нет.
  const remainingToday = limited
    ? Math.min(remainingByMethod.search ?? 0, remainingByMethod.card ?? 0)
    : null;

  let tariff: KonturTariffInfo | null = null;
  let tariffError: string | null = null;
  if (configured) {
    try {
      tariff = await fetchKonturTariff();
    } catch (error) {
      // Панель должна показывать журнал даже тогда, когда API недоступен:
      // причина отказа важнее, чем пустая страница.
      tariffError = error instanceof Error ? error.message : String(error);
    }
  }

  return NextResponse.json({
    configured,
    baseUrl: contract.baseUrl,
    paths: {
      search: contract.searchPath,
      tender: contract.tenderPath,
      testTender: contract.testTenderPath,
      limitGroups: contract.limitGroupsPath,
    },
    dailyRequestLimit: limited ? dailyRequestLimit : null,
    spentToday: summary.apiCalls,
    spentTodayByMethod: spentByMethod,
    remainingToday,
    remainingTodayByMethod: remainingByMethod,
    summary,
    recent,
    storedResponses,
    tariff,
    tariffError,
  });
}
