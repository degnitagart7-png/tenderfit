/**
 * Утилиты текстового сопоставления предмета закупки с профилем компании.
 * Чистые функции без зависимостей от React — используются в scoring.
 */

const STOP_TOKENS = new Set([
  "и",
  "в",
  "во",
  "на",
  "с",
  "со",
  "к",
  "по",
  "для",
  "из",
  "о",
  "об",
  "не",
  "а",
  "но",
  "или",
  "до",
  "от",
  "за",
  "под",
  "над",
  "услуг",
  "услуги",
  "услуга",
  "поставка",
  "выполнение",
  "оказание",
  "работ",
  "работы",
  "работа",
  "нужд",
  "нужды",
]);

/** Нормализация и токенизация текста в нижнем регистре. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s-]/gi, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

/** Приводит строку к массиву непустых элементов. */
export function toArray(value: string[] | undefined | null): string[] {
  return (value ?? []).map((v) => v.trim()).filter(Boolean);
}

/**
 * Проверяет, встречается ли ключевое слово (или его основа) в тексте.
 * Используется нечёткое сопоставление по основе (первые 6 символов),
 * чтобы «компьютер» совпадал с «компьютеров», «компьютерное».
 */
export function keywordInText(keyword: string, text: string): boolean {
  const k = keyword.toLowerCase().replace(/ё/g, "е").trim();
  const t = text.toLowerCase().replace(/ё/g, "е");
  if (k.length === 0) return false;
  if (t.includes(k)) return true;
  const stem = k.slice(0, Math.max(5, Math.min(k.length, 7)));
  return stem.length >= 5 && t.includes(stem);
}

export interface MatchResult {
  matchedKeywords: string[];
  matchedStopWords: string[];
  okpd2Matched: boolean;
  /** Доля совпавших ключевых слов, 0..1. */
  ratio: number;
}

/**
 * Сопоставляет текст закупки с возможностями компании.
 * Стоп-слова снижают релевантность (признак нерелевантной закупки).
 */
export function matchCapabilities(
  tenderText: string,
  keywords: string[],
  stopWords: string[],
  tenderOkpd2: string[],
  profileOkpd2: string[],
): MatchResult {
  const kws = toArray(keywords);
  const stops = toArray(stopWords);

  const matchedKeywords = kws.filter((k) => keywordInText(k, tenderText));
  const matchedStopWords = stops.filter((s) => keywordInText(s, tenderText));

  const okpd2Matched =
    profileOkpd2.length > 0 &&
    tenderOkpd2.some((code) =>
      profileOkpd2.some(
        (p) => code.startsWith(p.slice(0, 2)) && p.startsWith(code.slice(0, 2)),
      ),
    );

  const ratio = kws.length === 0 ? 0 : matchedKeywords.length / kws.length;

  return { matchedKeywords, matchedStopWords, okpd2Matched, ratio };
}
