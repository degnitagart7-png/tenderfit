import type { LlmCostCardData } from "@/app/api/llm-cost/route";
import { readJsonOrThrow } from "@/lib/readJson";

/** Клиент ручки расхода на ИИ: закрыта ключом владельца. */
export const llmCostApiService = {
  async fetch(token: string): Promise<LlmCostCardData> {
    const response = await fetch("/api/llm-cost", {
      headers: { "x-admin-token": token },
      cache: "no-store",
    });
    return readJsonOrThrow<LlmCostCardData>(response);
  },
};
