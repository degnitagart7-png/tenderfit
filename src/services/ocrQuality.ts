/**
 * Оценка распознанного текста и его пометка. Чистые функции без зависимостей.
 *
 * Отдельно от ocr.ts, потому что тот тянет `child_process` и подключается
 * динамически, а оценка нужна разбору вложений всегда.
 */

export const OCR_UNAVAILABLE_NOTE = "Распознавание на этом сервере недоступно.";

/** Слово для оценки: три и более кириллические буквы подряд. */
const CYRILLIC_WORD = /[А-Яа-яЁё]{3,}/g;

/**
 * Меньше стольких слов на странице — это обрывки, а не текст.
 *
 * Страница настоящего документа даёт сотни слов; штамп чертежа с «Разработал,
 * Проверил, Утвердил» — два десятка. Порог выбран выше штампа, ниже короткой
 * страницы с подписями. Подобран без живых данных: если на проде отрежет
 * лишнее, менять здесь.
 */
export const MIN_WORDS_PER_PAGE = 20;

/**
 * Доля знаков, лежащих в словах из 3+ кириллических букв. У распознанного
 * чертежа основная масса — цифры, размеры, одиночные буквы и знаки.
 */
export const MIN_WORD_CHAR_RATIO = 0.45;

/** Доля страниц-обрывков, начиная с которой файл считается схемой или чертежом. */
export const SCRAP_PAGES_SHARE = 0.8;

export function isScrapPage(text: string): boolean {
  const words = text.match(CYRILLIC_WORD) ?? [];
  if (words.length < MIN_WORDS_PER_PAGE) return true;
  const letters = words.reduce((sum, word) => sum + word.length, 0);
  const visible = text.replace(/\s+/g, "").length;
  return visible === 0 || letters / visible < MIN_WORD_CHAR_RATIO;
}

export type OcrAssessment = { kind: "scheme" } | { kind: "text"; text: string };

/**
 * Годится ли распознанное для анализа.
 *
 * Если 80 и более процентов распознанных страниц — обрывки, файл считается
 * схемой или чертежом, и в анализ не уходит ничего: мусор из размерных линий
 * хуже отсутствия текста. Иначе берутся только страницы с текстом: в
 * документе с чертежами между страницами выбрасываются сами чертежи.
 */
export function assessOcrPages(
  pages: readonly (string | null)[],
): OcrAssessment {
  const read = pages.filter((page): page is string => page !== null);
  if (read.length === 0) return { kind: "scheme" };

  const good = read.filter((page) => !isScrapPage(page));
  const scrapShare = (read.length - good.length) / read.length;
  if (scrapShare >= SCRAP_PAGES_SHARE) return { kind: "scheme" };

  return {
    kind: "text",
    text: good.map((page) => page.trim()).join("\n\n"),
  };
}

/** Первая строка текста, распознанного со скана: по ней анализ отличает такой текст от слоя. */
export function ocrHeader(recognized: number, totalPages: number): string {
  return `[Текст распознан со скана: ${recognized} стр. из ${totalPages}]`;
}
