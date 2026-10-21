import type { CompanyFitResult } from "@/domain/companyFacts/fit";
import type { CompanyDocumentCategory, CompanyFacts } from "@/domain/companyFacts/types";

/**
 * Клиентская часть ручек «Компания»: факты из документов и сверка с закупкой.
 * Браузер сюда шлёт только то, что человек уже видел в «Что уйдёт в ИИ» (очищенные тексты), и номер закупки.
 */

export interface FactsApiResult {
  facts: CompanyFacts;
  skipped: { id: string; name: string; reason: string }[];
  truncated: boolean;
  sentChars: number;
  calls: number;
  droppedForPii: number;
  failedCalls: number;
}

export interface FitApiResult {
  result: CompanyFitResult;
  /** Взято из сохранённого результата: модель не вызывалась. */
  cached: boolean;
  /** Модель не ответила: показаны только проверки по правилам, результат не сохранён. */
  degraded?: boolean;
}

/** Ошибка ручки с кодом и причиной, чтобы экран отличал «нет разбора» (409) от сбоя. */
export class CompanyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "CompanyApiError";
  }
}

async function readError(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => null)) as { error?: string; reason?: string } | null;
  throw new CompanyApiError(body?.error ?? `${fallback}: ${String(response.status)}`, response.status, body?.reason);
}

export const companyApiService = {
  async extractFacts(input: {
    documents: { id: string; name: string; category: CompanyDocumentCategory; text: string }[];
    companyInn?: string;
    companyName?: string;
  }): Promise<FactsApiResult> {
    const response = await fetch("/api/company/facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) await readError(response, "Не удалось обновить профиль по документам");
    return (await response.json()) as FactsApiResult;
  },

  async fit(tenderId: string, force = false): Promise<FitApiResult> {
    const response = await fetch("/api/company/fit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenderId, ...(force ? { force: true } : {}) }),
    });
    if (!response.ok) await readError(response, "Не удалось сверить компанию с закупкой");
    return (await response.json()) as FitApiResult;
  },
};
