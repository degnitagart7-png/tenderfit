import { NextRequest, NextResponse } from "next/server";

import { documentRepository } from "@/repositories/documentRepository";
import { describeError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Сколько знаков разобранного текста отдаём на документ.
 *
 * Документация закупки доходит до сотен килобайт: у 32616426639 два файла на
 * 199 003 знака. Карточке столько не нужно — разбор читает начало документа,
 * где стоят требования и условия, а целиком текст нужен только расчёту сметы,
 * и тот берёт его на сервере.
 *
 * Предел щедрый намеренно: срезать требования, которые стоят в середине
 * извещения, хуже, чем передать лишние килобайты.
 */
const MAX_TEXT_CHARS = 120_000;

/**
 * GET /api/documents?tenderId=<reg_number>
 *
 * Документы одной закупки вместе с разобранным текстом.
 *
 * Зачем отдельный маршрут, а не поле в списке закупок. В ленте двести
 * закупок, и текст документации у каждой измеряется сотнями килобайт:
 * приложить его к списку значит отдать браузеру десятки мегабайт ради
 * страницы, где показываются названия. Карточке же текст нужен — без него
 * разбор идёт по названию и реквизитам и выдаёт «существенных ограничений не
 * найдено» на закупке, к которой приложено извещение с требованием СРО.
 *
 * Ответ: { documents: [...] } · 400 без tenderId · 503, если база недоступна.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const regNumber = request.nextUrl.searchParams.get("tenderId");
  if (regNumber === null || regNumber.trim() === "") {
    return NextResponse.json(
      { error: "Не задан tenderId — номер закупки" },
      { status: 400 },
    );
  }

  try {
    /*
      Ключ документа — реестровый номер закупки, а не её UUID из таблицы
      tenders. Так их кладёт загрузчик (`fetch-tender-documents.ts`:
      `tender_id: regNumber`), и так же их читает расчёт сметы в воркере.
      Попытка найти закупку по номеру и спросить документы по её `id` даёт
      пустой список молча — проверено на 32616426639, где лежат два файла.
    */
    const rows = await documentRepository.findByTenderId(regNumber.trim());
    return NextResponse.json({
      documents: rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        document_type: row.document_type,
        file_url: row.file_url,
        file_size: row.file_size,
        parsed_status: row.parsed_status,
        download_status: row.download_status,
        parsed_text: (row.parsed_text ?? "").slice(0, MAX_TEXT_CHARS),
        updated_at: row.updated_at,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: describeError(error) },
      { status: 503 },
    );
  }
}
