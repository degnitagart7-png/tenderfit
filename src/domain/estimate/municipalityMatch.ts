import { normalizeRegionText } from "@/domain/regions";

/**
 * Сравнение названия муниципалитета с текстом закупки по словам и основам.
 *
 * Общий разбор для выбора ценовой зоны (`priceZoneResolve`) и районов Крайнего Севера (`north`):
 * названия склоняются («Северобайкальск» → «Северобайкальска»), прилагательные меняют окончание
 * («Баунтовский» → «Баунтовского»), поэтому слово текста сравнивается с основой названия.
 */

export interface NameStem {
  readonly stem: string;
  readonly exact: boolean;
}

const ADJECTIVE_ENDING = /(?:ский|ская|ское|ские|цкий|цкая|цкое|ний|няя|нее|ый|ая|ое|ие|ые|ой|ий|яя|ее)$/u;

/** Слова названия и их основы: прилагательные — без двух последних букв, последнее слово — без одной. */
export function stemsOf(name: string): NameStem[] {
  const words = normalizeRegionText(name).split(" ").filter((word) => word !== "");
  return words.map((word, index) => {
    const last = index === words.length - 1;
    if (ADJECTIVE_ENDING.test(word)) return { stem: word.slice(0, -2), exact: false };
    // Последнее слово склоняется («Северобайкальск» → «Северобайкальска»), предыдущие — нет.
    return last ? { stem: word.slice(0, -1), exact: false } : { stem: word, exact: true };
  });
}

export interface StemMatch {
  /** Буквы совпавших слов. */
  readonly length: number;
  /** Индекс первого и последнего совпавшего слова текста. */
  readonly start: number;
  readonly end: number;
}

/**
 * Совпадение основ с текстом: слово текста должно начинаться с основы и быть не длиннее основы
 * + 4 буквы («Кабанск» находит «Кабанского», но не «Кабанскиеполя»). null — нет совпадения.
 */
export function matchStems(stems: readonly NameStem[], words: readonly string[]): StemMatch | null {
  for (let start = 0; start + stems.length <= words.length; start += 1) {
    let length = 0;
    let ok = true;
    for (let offset = 0; offset < stems.length; offset += 1) {
      const word = words[start + offset] as string;
      const { stem, exact } = stems[offset] as NameStem;
      const extra = exact ? 2 : 4;
      if (!word.startsWith(stem) || word.length > stem.length + extra) {
        ok = false;
        break;
      }
      length += word.length;
    }
    if (ok) return { length, start, end: start + stems.length - 1 };
  }
  return null;
}
