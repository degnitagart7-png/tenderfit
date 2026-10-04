import type { SearchProfile } from "@/domain/entities";

/**
 * Потолок платных поисков на одно нажатие кнопки «Найти новые закупки».
 *
 * Контур.Закупки соединяет ключевые слова в одну строку, поэтому роут
 * `/api/kontur/sync` отправляет по одному платному поиску на каждое слово.
 * Профиль с десятью словами стоил бы трети суточного тарифа (30 запросов на
 * метод) за одно случайное нажатие. Число 3 установлено владельцем проекта
 * 2026-09-24 вместе с самим решением сделать поиск ручным.
 */
export const MAX_SEARCHES_PER_PRESS = 3;

/** Что произойдёт при нажатии кнопки: профиль, слова, расход и что не влезло. */
export interface KonturPressPlan {
  /** Профиль, по которому пойдёт поиск. null — включать нечего. */
  profile: SearchProfile | null;
  /** Слова, которые уйдут в поиск. Порядок — как в профиле. */
  keywords: string[];
  /** Сколько платных поисков это стоит. 0 — запрос не нужен вовсе. */
  spend: number;
  /** Слова сверх потолка: партнёр должен видеть, что они не участвуют. */
  omitted: string[];
}

/**
 * Считает план одного нажатия кнопки поиска.
 *
 * Единственное место, где живёт правило «не больше трёх платных поисков»:
 * и панель подтверждения, и сам запрос строятся из этого плана, поэтому
 * показанная партнёру цена не может разойтись с фактическим расходом.
 *
 * Серверную проверку бюджета правило не заменяет: роут по-прежнему читает
 * остаток по тарифу до платного запроса и отвечает 429, когда он кончился.
 */
export function konturPressPlan(
  profiles: SearchProfile[],
  selectedId: string | null,
  maxSearches: number = MAX_SEARCHES_PER_PRESS,
): KonturPressPlan {
  // Отключённый профиль не участвует, даже если выбран явно: кнопка не должна
  // тратить деньги на поиск, который партнёр выключил.
  const enabled = profiles.filter((profile) => profile.enabled);
  const profile =
    enabled.find((candidate) => candidate.id === selectedId) ?? enabled[0] ?? null;
  if (!profile) {
    return { profile: null, keywords: [], spend: 0, omitted: [] };
  }

  const ceiling = Math.max(0, Math.trunc(maxSearches));
  const words = normalizeKeywords(profile.keywords);
  const keywords = words.slice(0, ceiling);

  // Профиль без слов всё равно стоит одного поиска: роут при пустом списке
  // отправляет один запрос без ключевых слов, а не ноль запросов.
  const spend = ceiling === 0 ? 0 : Math.max(1, keywords.length);

  return { profile, keywords, spend, omitted: words.slice(ceiling) };
}

/**
 * Приводит слова профиля к тому виду, в котором они уйдут в поиск.
 *
 * Пустые строки и пробелы отбрасываются: иначе «ремонт, , стройка» стоил бы
 * трёх поисков вместо двух, а один из них искал бы всё подряд. Повторы
 * схлопываются без учёта регистра — «Ремонт» и «ремонт» дают у Контура одну и
 * ту же выдачу, платить за неё дважды смысла нет.
 */
function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const keyword of keywords) {
    const word = keyword.trim();
    if (word.length === 0) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(word);
  }

  return result;
}
