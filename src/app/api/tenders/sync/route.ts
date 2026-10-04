import { NextRequest, NextResponse } from "next/server";
import { EisTenderSourceAdapter } from "@/adapters/tender-source/eisTenderSourceAdapter";
import { tenderRepository } from "@/repositories/tenderRepository";
import type { TenderLaw, PlacingWay, TenderDataSource } from "@/types/database";

/**
 * POST /api/tenders/sync
 *
 * Синхронизация закупок из ЕИС.
 *
 * Работает только там, где ЕИС отвечает, то есть на машине с российским IP:
 * локальный `npm run dev` и плановый прогон `scripts/sync-eis.ts`. На Vercel
 * роут падает всегда — zakupki.gov.ru и filestore не отвечают зарубежным
 * адресам, поэтому интерфейс больше не зовёт его из браузера. Кнопка «Найти
 * новые закупки» ставит в очередь задание `full_sync` (`POST /api/sync-jobs`),
 * и его выполняет сервер в России тем же прогоном, что и по расписанию. Сам
 * прогон `scripts/sync-eis.ts` берёт адаптеры источников напрямую, минуя HTTP;
 * роут сохранён для локальной отладки запросом из командной строки.
 *
 * Body:
 * {
 *   laws: ("FZ_44" | "FZ_223" | "PP_RF_615")[],
 *   keywords?: string[],
 *   regions?: string[],
 *   minPrice?: number,
 *   maxPrice?: number,
 *   okpd2Codes?: string[],
 *   customerInns?: string[],
 *   limit?: number (default 50)
 * }
 *
 * Response:
 * {
 *   synced: number,
 *   created: number,
 *   updated: number,
 *   tenders: TenderRow[]
 * }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      laws: TenderLaw[];
      keywords?: string[];
      regions?: string[];
      minPrice?: number;
      maxPrice?: number;
      okpd2Codes?: string[];
      customerInns?: string[];
      limit?: number;
    };

    if (!body.laws || body.laws.length === 0) {
      return NextResponse.json(
        { error: "laws is required and must not be empty" },
        { status: 400 },
      );
    }

    // ИНН заказчиков: принимаем только валидные (10 или 12 цифр),
    // остальное отбрасываем, чтобы не отправлять мусор в ЕИС.
    const customerInns = (body.customerInns ?? [])
      .map((inn) => String(inn).replace(/\D/g, ""))
      .filter((inn) => /^\d{10,12}$/.test(inn));

    // Создаём адаптер ЕИС
    const adapter = new EisTenderSourceAdapter({
      rateLimitPerSec: 3,
      maxRetries: 3,
    });

    // Запрашиваем закупки из ЕИС
    const tenders = await adapter.fetchTenders({
      laws: body.laws,
      keywords: body.keywords,
      regions: body.regions,
      minPrice: body.minPrice ?? null,
      maxPrice: body.maxPrice ?? null,
      okpd2Codes: body.okpd2Codes,
      customerInns: customerInns.length > 0 ? customerInns : undefined,
      limit: body.limit ?? 50,
    });

    // Сохраняем в БД
    let created = 0;
    let updated = 0;
    const savedTenders = [];

    for (const tender of tenders) {
      const result = await tenderRepository.upsertByRegNumber({
        reg_number: tender.regNumber,
        external_id: tender.externalId,
        law: tender.law as TenderLaw,
        placing_way: tender.placingWay as PlacingWay,
        subject: tender.subject,
        customer_name: tender.customerName,
        customer_inn: tender.customerInn,
        region: tender.region,
        delivery_address: tender.deliveryAddress || null,
        price: tender.financial.price ?? null,
        currency: tender.financial.currency ?? "RUB",
        advance_payment: tender.financial.advancePercent ?? null,
        security_bid: tender.financial.bidSecurityAmount ?? null,
        security_contract: tender.financial.contractSecurityAmount ?? null,
        submission_end: tender.deadlines.submissionEnd,
        publication_date: tender.deadlines.publicationDate ?? null,
        last_update_date: tender.deadlines.lastUpdateDate ?? null,
        delivery_term_days: tender.deadlines.deliveryTermDays ?? null,
        delivery_date_end: null,
        okpd2_codes: tender.okpd2Codes.length > 0 ? tender.okpd2Codes : null,
        lots: tender.lots.length > 0 ? tender.lots : null,
        requirements: tender.requirements.length > 0 ? tender.requirements : null,
        national_regime: tender.nationalRegime,
        only_for_smp: tender.onlyForSmp,
        eis_url: tender.eisUrl,
        data_source: "EIS" as TenderDataSource,
        change_log: tender.changeLog.length > 0 ? tender.changeLog : null,
      });

      if (result.created) {
        created++;
      } else {
        updated++;
      }
      savedTenders.push(result.row);
    }

    return NextResponse.json({
      synced: tenders.length,
      created,
      updated,
      tenders: savedTenders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
