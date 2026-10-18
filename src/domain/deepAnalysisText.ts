/**
 * Что из документа читает глубокий анализ.
 *
 * Решение владельца 16.10.2026: договор, ТЗ и извещение — целиком, а из больших смет —
 * только шапку и итоги. Смета на сотни позиций рисков договора почти не содержит, а
 * читать её моделью — часы и сотня рублей на закупку: у 32616445639 тринадцать смет
 * Excel дали 23 млн знаков. Полную смету по-прежнему проверяет аудит сметы — ему этот
 * текст отдаётся без сокращений (`documentRepository` хранит его целиком).
 *
 * В шапке — объект, основания, уровень цен, коэффициенты и условия; в итогах — суммы,
 * накладные, сметная прибыль, зимнее удорожание, непредвиденные, НДС. Этого достаточно,
 * чтобы сводка увидела противоречия «смета против НМЦК и ТЗ», не перебирая позиции.
 */

/** Смета короче — читается целиком, как раньше: сокращать нечего. */
export const ESTIMATE_FULL_READ_CHARS = 60_000;
const HEAD_CHARS = 20_000;
const TAIL_CHARS = 15_000;
const SECTION_TOTALS_CHARS = 10_000;

const ESTIMATE_NAME = /смет|лср|ресурсн/iu;
// \w в JS — только латиница, поэтому окончания русских слов — через \p{L}.
const ESTIMATE_CONTENT = /локальн\p{L}*\s+сметн|сметн\p{L}*\s+расч[её]т|локальная\s+смета|ресурсн\p{L}*\s+сметн/iu;
const SECTION_TOTAL = /итого\s+по\s+(разделу|смете|главе)|всего\s+по\s+(смете|разделу)/iu;

export interface DeepAnalysisText {
  text: string;
  /** Текст сокращён до шапки и итогов. */
  condensed: boolean;
  originalChars: number;
}

export function isEstimateDocument(filename: string, text: string): boolean {
  return ESTIMATE_NAME.test(filename) || ESTIMATE_CONTENT.test(text.slice(0, 5_000));
}

export function textForDeepAnalysis(filename: string, text: string): DeepAnalysisText {
  const originalChars = text.length;
  if (originalChars <= ESTIMATE_FULL_READ_CHARS || !isEstimateDocument(filename, text)) {
    return { text, condensed: false, originalChars };
  }
  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const middle = text.slice(HEAD_CHARS, originalChars - TAIL_CHARS);
  // Итоги разделов из середины: по ним видно, из чего складывается сумма.
  const sectionTotals: string[] = [];
  let used = 0;
  for (const line of middle.split("\n")) {
    if (!SECTION_TOTAL.test(line)) continue;
    const clean = line.replace(/,{2,}/g, ",").trim();
    if (used + clean.length > SECTION_TOTALS_CHARS) break;
    sectionTotals.push(clean);
    used += clean.length + 1;
  }
  const note =
    `[Смета сокращена для анализа рисков: шапка, итоги разделов и итог сметы из ${String(originalChars)} знаков. ` +
    "Позиции сметы проверяет аудит сметы.]";
  const parts = [note, head, "…", ...(sectionTotals.length > 0 ? ["Итоги разделов:", ...sectionTotals, "…"] : []), tail];
  return { text: parts.join("\n"), condensed: true, originalChars };
}
