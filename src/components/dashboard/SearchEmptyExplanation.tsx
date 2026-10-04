"use client";

import type { SearchMatchSummary } from "@/domain/searchMatching";
import { UNKNOWN_REGION } from "@/domain/entities";
import { regionUnknownNote, searchCriterionLabels } from "@/lib/labels";
import { pluralRu } from "@/utils/format";

/**
 * Разбор выдачи по профилям поиска: какой критерий сколько закупок отклонил
 * и что в базе есть на самом деле.
 *
 * Без этого блока пустой результат выглядит поломкой: пользователь не видит,
 * что профиль требует регион, которого в собранной базе просто нет. Правило
 * проекта — закупка не исчезает молча, причина показывается одной фразой.
 */
export function SearchEmptyExplanation({ summary }: { summary: SearchMatchSummary }) {
  if (summary.total === 0) return null;

  const requested = summary.requestedRegions;
  const presentRequested = summary.regionsInBase.filter((r) =>
    requested.includes(r.region),
  );
  const listed = summary.regionsInBase.slice(0, 8);
  const restCount = summary.regionsInBase.length - listed.length;

  return (
    <div className="border-t border-border pt-4 text-left">
      <p className="text-[14.5px] font-medium text-foreground">
        Почему так: чем отклонены {summary.total}{" "}
        {pluralRu(summary.total, ["закупка", "закупки", "закупок"])} базы
      </p>

      {summary.rejected.length > 0 && (
        <ul className="mt-2 space-y-1">
          {summary.rejected.map(({ criterion, count }) => (
            <li
              key={criterion}
              className="flex items-baseline justify-between gap-3 text-[13.5px] text-muted-foreground"
            >
              <span>{searchCriterionLabels[criterion]}</span>
              <span className="num shrink-0 text-foreground">
                {count} {pluralRu(count, ["закупка", "закупки", "закупок"])}
              </span>
            </li>
          ))}
        </ul>
      )}

      {requested.length > 0 && (
        <div className="mt-3 space-y-1.5 text-[13.5px] text-muted-foreground">
          <p>
            Профиль ограничивает регионы:{" "}
            <span className="text-foreground">{requested.join(", ")}</span>.
          </p>
          <p>
            {presentRequested.length === 0
              ? "Ни одной закупки из этих регионов в базе нет: синхронизация собирает выдачу по ключевым словам со всей России, а у ЕИС регионального фильтра в поисковой выдаче нет."
              : `Из этих регионов в базе: ${presentRequested
                  .map((r) => `${r.region} (${r.count})`)
                  .join(", ")}.`}
          </p>
          <p>
            Регионы, которые в базе есть:{" "}
            {listed.map((r) => `${r.region} (${r.count})`).join(", ")}
            {restCount > 0 && ` и ещё ${restCount}`}.
          </p>
          {summary.unknownRegionInBase > 0 && (
            <p>
              Плюс {summary.unknownRegionInBase}{" "}
              {pluralRu(summary.unknownRegionInBase, [
                "закупка",
                "закупки",
                "закупок",
              ])}{" "}
              с регионом «{UNKNOWN_REGION}». Они проходят фильтр по региону с
              оговоркой: «не определён» не значит «другой».
            </p>
          )}
        </div>
      )}

      {requested.length === 0 && summary.matchedRegionUnknown > 0 && (
        <p className="mt-3 text-[13.5px] text-muted-foreground">
          {regionUnknownNote}.
        </p>
      )}
    </div>
  );
}
