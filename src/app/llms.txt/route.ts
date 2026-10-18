import { buildLlmsTxt, textResponse } from "@/lib/llms";

/**
 * /llms.txt — указатель для ИИ-ассистентов (соглашение llmstxt.org): что за
 * сервис и где лежат статьи. Открыт без входа, кэшируется на сутки.
 */
// Литерал, а не константа: Next читает настройку сегмента статически.
export const revalidate = 86400;

export function GET(): Response {
  return textResponse(buildLlmsTxt(), "text/markdown; charset=utf-8");
}
