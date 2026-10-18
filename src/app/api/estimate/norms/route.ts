import { requireAccess } from "@/app/api/auth/requireAccess";
import { NextRequest, NextResponse } from "next/server";

import { createAssistLimiter } from "@/app/api/search/guard";
import {
  clampLimit,
  searchNorms,
  unitFits,
  type NormSearchResult,
} from "@/domain/estimate/normSearch";
import { describeError } from "@/lib/errors";
import { clientKey } from "@/lib/rateLimit";
import { createTtlCache } from "@/lib/ttlCache";
import { FerBaseUnavailableError, loadFerBase } from "@/repositories/bimRepository";
import { EstimateBaseUnavailableError, loadNormSearchIndex } from "@/repositories/estimateBaseRepository";

/**
 * GET /api/estimate/norms?q=…&limit=…&book=…&unit=…&method=… — поиск нормы ФСНБ-2022 по шифру или словам.
 *
 * `method=BASE_INDEX` — смета посчитана базисно-индексным методом: ищутся расценки ФЕР-2020 (`ФЕР`, `ФЕРм`, `ФЕРр`, `ФЕРп`, `ФЕРмр`)
 * в отдельном индексе, а не нормы ГЭСН. Выбор человека всегда запись из той базы, по которой считается его смета.
 *
 * Нужен правке ведомости: человек видит, что расчёт подобрал не ту норму («Демонтаж наружных
 * стен» → опалубка), и ищет нужную сам. Поиск идёт на сервере по `norms.jsonl` через тот же
 * репозиторий, что и расчёт (`loadNormSearchIndex`): 185 МБ норм в браузер не едут, а выдача —
 * только записи, которые в базе есть.
 *
 * Лимит: не больше 30 норм за запрос (по умолчанию 10) и 300 запросов с адреса за десять минут —
 * поле ввода шлёт запрос на каждую паузу в наборе. Кэш: один и тот же запрос не пересчитывается
 * десять минут (ответ от единицы позиции не зависит — `unitOk` дописывается поверх кэша).
 *
 * Пустой и слишком короткий запрос — 200 с пустой выдачей: это штатное состояние поля ввода.
 * Базы норм на сервере нет — 503 с причиной, а не пустая выдача: «ничего не нашлось» было бы ложью.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createAssistLimiter(300);
const cache = createTtlCache<NormSearchResult>({ ttlMs: 10 * 60_000, maxEntries: 500 });

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  const decision = limiter.check(clientKey(request.headers));
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Слишком много запросов поиска. Подождите немного.", retryAfterSec: decision.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
    );
  }

  const params = request.nextUrl.searchParams;
  const query = (params.get("q") ?? "").slice(0, 200);
  const limitParam = params.get("limit");
  const limit = clampLimit(limitParam === null || limitParam.trim() === "" ? undefined : Number(limitParam));
  const book = (params.get("book") ?? "").trim().slice(0, 20);
  const unit = (params.get("unit") ?? "").trim().slice(0, 40);
  const bim = params.get("method") === "BASE_INDEX";

  try {
    const key = `${bim ? "bim" : "rim"}|${book}|${String(limit)}|${query.trim().replace(/\s+/gu, " ").toLowerCase()}`;
    let result = cache.get(key);
    if (result === undefined) {
      const index = bim ? (await loadFerBase()).searchIndex : await loadNormSearchIndex();
      result = searchNorms(index, { query, limit, baseType: book === "" ? null : book });
      // Пустая выдача на пустой запрос в кэш не нужна: она ничего не стоит.
      if (result.mode !== "EMPTY") cache.set(key, result);
    }

    return NextResponse.json(
      {
        query: result.query,
        mode: result.mode,
        note: result.note,
        limit,
        items: result.items.map((hit) => ({ ...hit, ...(unit === "" ? {} : { unitOk: unitFits(unit, hit.unit) }) })),
      },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch (error) {
    if (error instanceof FerBaseUnavailableError) {
      return NextResponse.json({ error: "ФЕР-2020 на сервере не собраны: поиск расценок недоступен." }, { status: 503 });
    }
    if (error instanceof EstimateBaseUnavailableError) {
      return NextResponse.json({ error: "База норм на сервере не собрана: поиск норм недоступен." }, { status: 503 });
    }
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}
