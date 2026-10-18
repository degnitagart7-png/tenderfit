import { buildLlmsFullTxt, textResponse } from "@/lib/llms";

/**
 * /llms-full.txt — полные тексты всех статей обычным текстом для загрузки в
 * ИИ-ассистентов. Открыт без входа, кэшируется на сутки.
 */
// Литерал, а не константа: Next читает настройку сегмента статически.
export const revalidate = 86400;

export function GET(): Response {
  return textResponse(buildLlmsFullTxt(), "text/markdown; charset=utf-8");
}
