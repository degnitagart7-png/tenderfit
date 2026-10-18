import { requireAccess } from "@/app/api/auth/requireAccess";
import { recordRequestEvent } from "@/app/api/auth/requestUser";
import { NextRequest, NextResponse } from "next/server";
import { tenderRepository } from "@/repositories/tenderRepository";
import { fetchPaged } from "@/domain/pagedFetch";
import { trimFeedRow } from "@/domain/feedRawData";
import type { TenderLaw, TenderDataSource } from "@/types/database";

/** Сколько закупок отдаём по умолчанию и максимально. */
const DEFAULT_LIMIT = 500;
/**
 * Предел одного ответа — «вся лента». Совпадает с `MAX_FEED_ROWS` клиента
 * (`tenderApiService`): лента просит всё одним запросом, а страницы по тысяче
 * строк (предел PostgREST) сервер собирает сам и параллельно (`fetchPaged`).
 */
const MAX_FEED_ROWS = 5000;

/**
 * GET /api/tenders
 *
 * Получение списка закупок с фильтрацией.
 *
 * Query params:
 * - law: TenderLaw (FZ_44, FZ_223, PP_RF_615, COMMERCIAL)
 * - region: string
 * - data_source: TenderDataSource (MOCK, EIS, IMPORT, SBER_AST, KONTUR)
 * - customer_inn: string
 * - okpd2_code: string
 * - submission_end_after: ISO date
 * - submission_end_before: ISO date
 * - price_min: number
 * - price_max: number
 * - reg_number: string — выборка одной конкретной закупки
 * - limit: number (default 500, max 5000 — страницы базы собираются на сервере)
 * - offset: number (default 0)
 *
 * Response:
 * {
 *   tenders: TenderRow[],   // `raw_data` урезан до ключей, которые читает лента
 *   count: number           // сколько строк в ответе (не всего в базе)
 * }
 *
 * Запросы ленты при открытии страницы (замер 12.10.2026, ~1300 закупок):
 * было `limit=1000&offset=0`, затем строго после него `offset=1000` — два
 * запроса подряд, 1,66 МБ на тысячу строк, и всё это дважды (два компонента).
 * Стало: один запрос `limit=5000`, внутри него страницы базы идут параллельно,
 * а `raw_data` урезан (см. `domain/feedRawData`). Повторные одновременные
 * запросы клиент склеивает сам (`tenderApiService.listAll`).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  // Журнал действий: открытие ленты (раз в 10 минут на человека). Запрос одной
  // закупки по номеру — это карточка, её пишет /api/analysis/status.
  if (!new URL(request.url).searchParams.get("reg_number")) recordRequestEvent(request, { kind: "feed_open" });

  try {
    const { searchParams } = new URL(request.url);

    const law = searchParams.get("law") as TenderLaw | null;
    const region = searchParams.get("region");
    const data_source = searchParams.get("data_source") as TenderDataSource | null;
    const customer_inn = searchParams.get("customer_inn");
    const okpd2_code = searchParams.get("okpd2_code");
    const submission_end_after = searchParams.get("submission_end_after");
    const submission_end_before = searchParams.get("submission_end_before");
    const price_min = searchParams.get("price_min");
    const price_max = searchParams.get("price_max");
    const reg_number = searchParams.get("reg_number");
    // Лента фильтруется и пагинируется на клиенте, поэтому лимит по умолчанию
    // должен покрывать весь объём синхронизированных закупок: его приносит
    // прогон по всем подключённым площадкам, а не один источник.
    const requestedLimit = parseInt(
      searchParams.get("limit") ?? String(DEFAULT_LIMIT),
      10,
    );
    const requestedOffset = parseInt(searchParams.get("offset") ?? "0", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(1, requestedLimit), MAX_FEED_ROWS)
      : DEFAULT_LIMIT;
    const offset = Number.isFinite(requestedOffset)
      ? Math.max(0, requestedOffset)
      : 0;

    const filters = {
      law: law ?? undefined,
      region: region ?? undefined,
      data_source: data_source ?? undefined,
      customer_inn: customer_inn ?? undefined,
      okpd2_code: okpd2_code ?? undefined,
      submission_end_after: submission_end_after ?? undefined,
      submission_end_before: submission_end_before ?? undefined,
      price_min: price_min ? parseFloat(price_min) : undefined,
      price_max: price_max ? parseFloat(price_max) : undefined,
      reg_number: reg_number ?? undefined,
    };

    const rows = await fetchPaged(
      { limit, offset },
      {
        fetchPage: (pageOffset, pageLimit) => tenderRepository.list(filters, pageLimit, pageOffset),
        countTotal: () => tenderRepository.count(filters),
      },
    );
    const tenders = rows.map(trimFeedRow);

    return NextResponse.json({
      tenders,
      count: tenders.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    recordRequestEvent(request, { kind: "error", ok: false, detail: `GET /api/tenders: ${message}` });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
