/**
 * JSON из ответа модели: первый объект или массив, без обёртки ```json и без текста вокруг.
 *
 * Gemini отвечала голым JSON или JSON в ограждении ```json … ```. Claude (Haiku 5.5, с 2026-10-11) после ограждения часто
 * дописывает пояснение: «```json {"has_bill": false, "rows": []} ``` В документе нет ведомости объёмов работ…». Прежняя
 * очистка срезала ограждение только в самом конце текста, и такой ответ считался «не JSON» — фрагмент терялся, хотя ответ
 * правильный. Поэтому берётся первое значение JSON со сбалансированными скобками (строки и экранирование учитываются).
 *
 * Значение оборвано (ответ упёрся в лимит токенов) — возвращается хвост от первой скобки: так разбор ведомости по-прежнему
 * может спасти уже приехавшие строки (`parseBillResponse`).
 */
export function extractLlmJson(raw: string): string {
  const text = raw.trim();
  const start = firstJsonStart(text);
  if (start < 0) return text.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```\s*$/u, "").trim();
  const end = balancedEnd(text, start);
  return end < 0 ? text.slice(start).replace(/\s*```\s*$/u, "").trim() : text.slice(start, end + 1);
}

function firstJsonStart(text: string): number {
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  if (brace < 0) return bracket;
  if (bracket < 0) return brace;
  return Math.min(brace, bracket);
}

/** Индекс закрывающей скобки значения, начатого в `start`; −1 — значение не закрыто. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
