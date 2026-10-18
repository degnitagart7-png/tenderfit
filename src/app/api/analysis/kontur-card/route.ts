import { requireAccess } from "@/app/api/auth/requireAccess";
import { KONTUR_DISABLED_MESSAGE, KONTUR_ENABLED } from "@/domain/features";
import { NextRequest, NextResponse } from "next/server";
import type { KonturCardRefusal } from "@/domain/konturCardRequest";
import { describeError } from "@/lib/errors";
import { buyKonturCard, readKonturCardStatus } from "@/services/konturCardService";

export const dynamic = "force-dynamic";

/**
 * Платная карточка Контур.Закупок для одной закупки.
 *
 * Номер закупки передаётся как `regNumber`: в этом приложении идентификатор
 * закупки и есть её реестровый номер, а панель глубокого анализа держит его как
 * `tenderId`.
 *
 * Ключ Контур.Закупок в ответ не попадает — только признак, что карточку купить
 * нечем. Сами платные запросы выполняет воркер на сервере в России: ссылки на
 * файлы ведут на filestore zakupki.gov.ru, который не пускает зарубежные IP.
 */

/**
 * Код ответа по роду отказа.
 *
 * Разные коды нужны не для красоты: 429 говорит партнёру «подождать до
 * завтра», 503 — «это чинит владелец сервера», 409 — «у этой закупки карточки
 * нет вовсе». Один общий 400 смешал бы три разных действия.
 */
const REFUSAL_STATUS: Record<KonturCardRefusal, number> = {
  budget: 429,
  analysis: 429,
  config: 503,
  tender: 409,
};

function isConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function unconfigured(): NextResponse {
  return NextResponse.json(
    {
      configured: false,
      error: "Supabase не настроен: состояние платной карточки недоступно",
    },
    { status: 503 },
  );
}

/**
 * 503 с причиной, а не 500 со стеком: почти всегда это не применённая миграция
 * или недоступность базы, и обе причины лечит администратор. PostgREST отдаёт не
 * `Error`, а объект `{ message, code }`, поэтому расшифровка — за `describeError`.
 */
function unavailableResponse(error: unknown): NextResponse {
  return NextResponse.json(
    { error: "Состояние платной карточки не прочитано", detail: describeError(error) },
    { status: 503 },
  );
}

/**
 * GET /api/analysis/kontur-card?regNumber=…
 *
 * Нужен ли закупке платный запрос и можно ли его сделать сейчас. Чтение
 * бесплатное: только свои таблицы, ни одного обращения к Контур.Закупкам,
 * поэтому панель может опрашивать роут при каждом открытии карточки.
 *
 * Ответ 200: KonturCardStatus · 400 без номера · 404, если закупки нет в базе ·
 * 503, если база не настроена или не отвечает.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!KONTUR_ENABLED) {
    return NextResponse.json({ error: KONTUR_DISABLED_MESSAGE }, { status: 410 });
  }
  const denied = await requireAccess(request);
  if (denied) return denied;
  const regNumber = request.nextUrl.searchParams.get("regNumber")?.trim() ?? "";
  if (regNumber === "") {
    return NextResponse.json({ error: "Не указан номер закупки (regNumber)" }, { status: 400 });
  }
  if (!isConfigured()) return unconfigured();

  try {
    const status = await readKonturCardStatus(regNumber);
    if (status === null) {
      return NextResponse.json(
        { error: `Закупка ${regNumber} не найдена в базе` },
        { status: 404 },
      );
    }
    return NextResponse.json(status);
  } catch (error) {
    return unavailableResponse(error);
  }
}

/**
 * POST /api/analysis/kontur-card
 * Body: { regNumber: string }
 *
 * Покупает карточку: ставит воркеру задание на документацию с флагом
 * `konturCards` и задачу глубокого разбора. Повторное нажатие переиспользует
 * прежнее задание (`deduped: true`, ответ 200) и не тратит второй запрос.
 *
 * Ответ 201: { status: "queued", jobId, analysisJobId, deduped, budgetNote, warning } ·
 * 200 при переиспользовании · 404, если закупки нет · 409/429/503 с причиной
 * отказа (см. REFUSAL_STATUS) · 503, если очередь недоступна.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!KONTUR_ENABLED) {
    return NextResponse.json({ error: KONTUR_DISABLED_MESSAGE }, { status: 410 });
  }
  const denied = await requireAccess(request);
  if (denied) return denied;
  if (!isConfigured()) return unconfigured();

  let body: { regNumber?: unknown };
  try {
    body = (await request.json()) as { regNumber?: unknown };
  } catch {
    return NextResponse.json({ error: "Тело запроса не является JSON" }, { status: 400 });
  }

  const regNumber = typeof body.regNumber === "string" ? body.regNumber.trim() : "";
  if (regNumber === "") {
    return NextResponse.json({ error: "Не указан номер закупки (regNumber)" }, { status: 400 });
  }

  try {
    const result = await buyKonturCard(regNumber);

    switch (result.status) {
      case "queued":
        return NextResponse.json(result, { status: result.deduped ? 200 : 201 });
      case "not_found":
        return NextResponse.json(
          { error: `Закупка ${regNumber} не найдена в базе` },
          { status: 404 },
        );
      case "refused":
        return NextResponse.json(
          { ...result, error: result.reason },
          { status: REFUSAL_STATUS[result.refusalKind] },
        );
    }
  } catch (error) {
    return unavailableResponse(error);
  }
}
