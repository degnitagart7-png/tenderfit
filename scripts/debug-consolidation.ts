/**
 * Отладка сводки глубокого анализа на одной закупке: собирает запрос так же, как разбор,
 * зовёт шлюз и печатает причину завершения, расход и начало ответа. Ничего не пишет в базу.
 *
 *   npx tsx scripts/debug-consolidation.ts <regNumber> [maxTokens]
 */
import { buildConsolidationPrompt } from "../src/domain/analysisConsolidation";
import { resolveLlmEndpoint } from "../src/services/llmGateway";
import { sourcedFindings } from "../src/services/analysisConsolidationService";
import { documentAnalysisRepository } from "../src/repositories/documentAnalysisRepository";
import { documentRepository } from "../src/repositories/documentRepository";
import { tenderRepository } from "../src/repositories/tenderRepository";

async function main(): Promise<void> {
  const regNumber = process.argv[2] ?? "";
  const maxTokens = Number(process.argv[3] ?? "16000");
  const row = await tenderRepository.findByRegNumber(regNumber);
  const documents = await documentRepository.findByTenderId(regNumber);
  const items = sourcedFindings(await documentAnalysisRepository.findByTenderId(regNumber), documents);
  const prompt = buildConsolidationPrompt(
    {
      regNumber,
      subject: row?.subject ?? "",
      price: row?.price ?? null,
      law: row?.law ?? null,
      submissionEnd: row?.submission_end ?? null,
      region: row?.region ?? null,
    },
    items,
  );
  const endpoint = resolveLlmEndpoint();
  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
    body: JSON.stringify({ model: endpoint.model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens, ...(JSON.parse(process.env["EXTRA"] ?? "{}") as object) }),
  });
  const data = (await response.json()) as {
    choices?: { message?: Record<string, unknown>; finish_reason?: string }[];
    usage?: unknown;
  };
  const message = data.choices?.[0]?.message ?? {};
  const content = typeof message["content"] === "string" ? (message["content"] as string) : JSON.stringify(message["content"]);
  console.log("выводов на входе:", items.length, "знаков запроса:", prompt.length);
  console.log("finish_reason:", data.choices?.[0]?.finish_reason, "ключи сообщения:", Object.keys(message).join(","));
  console.log("usage:", JSON.stringify(data.usage));
  console.log("длина ответа:", content?.length ?? 0);
  console.log("начало:", (content ?? "").slice(0, 400));
  console.log("конец:", (content ?? "").slice(-300));
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
