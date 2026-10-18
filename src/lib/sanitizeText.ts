/**
 * Очистка текста перед записью в Postgres.
 *
 * Тип `text` в Postgres не принимает нулевой символ (`unsupported Unicode escape
 * sequence`, «\u0000 cannot be converted to text»), а `jsonb` не принимает
 * одиночные суррогаты. Оба встречаются в тексте, который достали из rar, odt или
 * распознали со скана: Tesseract и распаковщики время от времени отдают
 * служебные байты. Один такой знак ронял запись всего документа, а вместе с ней
 * и прогон.
 *
 * Убирается всё, что в тексте документа смысла не несёт: управляющие знаки,
 * кроме табуляции и переводов строки, и одиночные суррогаты.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const LONE_SURROGATES =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizePgText(text: string): string {
  return text.replace(CONTROL_CHARS, "").replace(LONE_SURROGATES, "");
}

/** То же для значения, которое может быть null. */
export function sanitizePgTextOrNull(text: string | null): string | null {
  return text === null ? null : sanitizePgText(text);
}
