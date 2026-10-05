import type { Tender } from "@/domain/entities";
import { buildSearchIndex, matchIndex, parseSearchInput } from "@/domain/textSearch";

/**
 * Относится ли найденная площадкой закупка к запросу.
 *
 * Площадка отдаёт всё, что показалось ей похожим: по запросу «юридические
 * услуги» ЕИС вернула оценку арестованного имущества, вывоз отходов и питание
 * участников форума (прогон 05.10.2026) — совпало слово «услуги». Сохранять
 * такое нельзя: ложные находки выглядят как работа поиска, которая не
 * работает. Проверка идёт тем же правилом, каким ищет лента (`matchIndex`), чтобы
 * найденное при сборе не пропадало из ленты, а мусор в неё не попадал.
 *
 * Каждое слово профиля — отдельный запрос: достаточно подойти под любое.
 * Пустой список — проверять нечем, подходит всё.
 */
export function isRelevantToKeywords(tender: Tender, keywords: readonly string[]): boolean {
  const usable = keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword !== "");
  if (usable.length === 0) return true;

  const index = buildSearchIndex(tender);
  return usable.some((keyword) => matchIndex(index, parseSearchInput(keyword)).matched);
}
