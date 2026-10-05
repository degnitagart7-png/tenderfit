import type { RerankCandidate, RerankVerdict } from "@/domain/searchAssist";
import { readJsonOrThrow } from "@/lib/readJson";

/**
 * Клиент ручек помощника поиска: расширить запрос и проверить выдачу по смыслу.
 *
 * Сообщение об ошибке — это то, что вернул сервер в поле `error`, а не код
 * ответа: лимит запросов («подождите немного») и сбой шлюза человеку нужно
 * объяснять по-разному.
 */

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow<T>(response);
}

/** Ответ ручки живого поиска на постановку задания. */
export interface LiveStart {
  jobId: string;
  /** `pending` и `running` — идёт; `completed` — уже выполнено. */
  status: string;
  /** Тот же запрос выполнялся недавно: данные уже в базе, новое задание не ставилось. */
  cached?: boolean;
  /** Тот же запрос уже выполняется: вернули существующее задание. */
  reused?: boolean;
}

export interface LiveStatus {
  status: string;
  note: string | null;
  failed: boolean;
}

export const searchAssistApiService = {
  /**
   * Поставить задание живого поиска. Регионы (если есть) уходят на площадки:
   * ЕИС ищет по региону заказчика, и без них поиск идёт по всей России.
   */
  startLive(
    query: string,
    regions: readonly string[] = [],
    keywords: readonly string[] = [],
  ): Promise<LiveStart> {
    return postJson<LiveStart>("/api/search/live", {
      query,
      ...(regions.length > 0 ? { regions } : {}),
      // Свои дополнительные слова человека (из профиля) — вместо подбора моделью.
      ...(keywords.length > 0 ? { keywords } : {}),
    });
  },

  /** Узнать, чем закончилось задание живого поиска. */
  async liveStatus(jobId: string): Promise<LiveStatus> {
    const response = await fetch(`/api/search/live?jobId=${encodeURIComponent(jobId)}`);
    return readJsonOrThrow<LiveStatus>(response);
  },

  /** Варианты формулировки запроса. */
  async expand(query: string): Promise<string[]> {
    const data = await postJson<{ synonyms?: string[] }>("/api/search/expand", { query });
    return data.synonyms ?? [];
  },

  /** Оценки закупок по смыслу, по идентификатору. */
  async rerank(input: {
    query: string;
    companyNote?: string;
    candidates: readonly RerankCandidate[];
  }): Promise<Record<string, RerankVerdict>> {
    const data = await postJson<{ verdicts?: Record<string, RerankVerdict> }>("/api/search/rerank", input);
    return data.verdicts ?? {};
  },
};
