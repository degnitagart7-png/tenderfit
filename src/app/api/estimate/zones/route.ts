import { requireAccess } from "@/app/api/auth/requireAccess";
import { NextRequest, NextResponse } from "next/server";

import { describeError } from "@/lib/errors";
import { listBuiltZones, readPriceZoneRecords } from "@/repositories/estimateBaseRepository";
import { readZoneDirectoryFile } from "@/services/zoneOnDemand";

/**
 * GET /api/estimate/zones — собранные ценовые зоны и справочник зон.
 *
 * `zones` — зоны, цены которых собраны (`zones/<id>/zone.json`): их можно
 * выбрать для расчёта. `allZones` — справочник price-zones.csv целиком (субъект,
 * центр, муниципалитеты): клиенту он нужен, чтобы предвыбрать зону закупки той же
 * функцией, что и воркер, и показать «зона не из региона закупки».
 *
 * `directory` — номера всех зон ФГИС ЦС (`zones-directory.json`): зону без собранных
 * цен тоже можно выбрать, воркер соберёт её перед расчётом. Файла нет — список пуст,
 * и выбрать можно только собранные.
 *
 * Каталога данных нет (приложение развёрнуто без индекса) — оба списка пустые, а
 * не 500: экран тогда просто не предлагает выбор зоны.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  try {
    const [built, all, directory] = await Promise.all([
      listBuiltZones(),
      readPriceZoneRecords(),
      readZoneDirectoryFile(),
    ]);
    return NextResponse.json({
      zones: built.map((zone) => ({
        priceZoneId: zone.priceZoneId,
        zoneName: zone.zoneName,
        subject: zone.subject,
        period: zone.period,
      })),
      allZones: all.map((zone) => ({
        name: zone.zoneName,
        subjectCode: zone.subjectCode,
        subjectName: zone.subjectName,
        center: zone.center,
        municipalities: zone.municipalities,
      })),
      directory: directory ?? [],
    });
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}
