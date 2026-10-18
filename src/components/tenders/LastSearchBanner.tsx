"use client";

import { Button } from "@/components/ui/primitives";
import { markerQueryLabel, searchFreshSince, SEARCH_START_SLACK_MS, type SearchMarker } from "@/domain/searchMarker";
import { formatDateTime, pluralRu } from "@/utils/format";

/**
 * Полоса над таблицей: что принёс последний поиск.
 *
 * Результат поиска на площадках раньше растворялся в ленте: его скрывали
 * отсеивания по профилю, и найденное приходилось выискивать через «Расширенный
 * поиск». Полоса называет итог прямо («N новых»), даже когда он нулевой, и
 * даёт два действия: показать только результат поиска или вернуться ко всей
 * ленте. Закрыть её можно совсем — тогда отметка забывается.
 */
export function LastSearchBanner({
  marker,
  freshCount,
  knownCount,
  onlyActive,
  onToggleOnly,
  onDismiss,
}: {
  marker: SearchMarker;
  /** Новые строки поиска. */
  freshCount: number;
  /** Уже лежавшие в базе строки, найденные тем же запросом. */
  knownCount: number;
  onlyActive: boolean;
  onToggleOnly: () => void;
  onDismiss: () => void;
}) {
  const label = markerQueryLabel(marker);
  // Новое считается с прошлого визита, если он раньше начала поиска: так и говорим.
  const since = searchFreshSince(marker);
  const sinceVisit = since < Date.parse(marker.startedAt) - SEARCH_START_SLACK_MS;
  const sinceText = sinceVisit ? ` с вашего прошлого визита (${formatDateTime(new Date(since).toISOString())})` : "";
  const total = freshCount + knownCount;
  const known = `${knownCount} ${pluralRu(knownCount, ["закупка", "закупки", "закупок"])}`;

  let text: string;
  if (freshCount > 0) {
    text = `Новых для вас${label === null ? "" : ` по запросу ${label}`}: ${freshCount}${sinceText}`;
    if (knownCount > 0) text += ` и ещё ${known}, которые уже были в базе`;
    text += ".";
  } else {
    text = `Новых закупок${label === null ? "" : ` по запросу ${label}`} нет${sinceText} — лента та же.`;
    if (knownCount > 0) text += ` По этому запросу в ленте уже есть ${known}.`;
  }

  return (
    <div
      className="card flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-accent-line bg-accent-subtle px-4 py-3"
      role="status"
      data-testid="last-search-banner"
    >
      <p className="text-[14.5px] text-foreground">{text}</p>
      <div className="flex flex-wrap items-center gap-2">
        {total > 0 && (
          <Button size="sm" variant="secondary" onClick={onToggleOnly}>
            {onlyActive ? "Вернуться ко всей ленте" : "Показать только их"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Закрыть сообщение о последнем поиске">
          Закрыть
        </Button>
      </div>
    </div>
  );
}
