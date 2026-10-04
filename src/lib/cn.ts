/** Компактный объединитель CSS-классов с фильтрацией ложных значений. */
export function cn(
  ...parts: (string | false | null | undefined)[]
): string {
  return parts.filter(Boolean).join(" ");
}
