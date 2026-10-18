import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LlmCacheEntry, LlmCacheInsert, LlmResponseCacheStore } from "@/repositories/llmResponseCacheRepository";
import {
  LLM_CACHE_TTL_MS,
  LLM_CACHE_VERSION,
  cachedLlmChat,
  isCompleteFinish,
  isLlmCacheDisabled,
  llmCacheKey,
  resetLlmCacheWarnings,
  usageTokens,
  type GatewayChatAnswer,
} from "@/services/llmResponseCache";

/**
 * Кэш ответов модели: попадание, промах, срок жизни, сбои хранилища и неполные ответы. Хранилище — в памяти, шлюз — заглушка:
 * ни базы, ни настоящей модели.
 */

const NOW = Date.parse("2026-10-12T12:00:00Z");
const MESSAGES = [{ role: "user", content: "Найди ведомость в этом фрагменте" }];

interface Row extends LlmCacheInsert {
  createdAt: number;
  hits: number;
}

/** Хранилище в памяти с тем же правилом срока, что у настоящего: старше `notOlderThan` — нет. */
function memoryStore(): LlmResponseCacheStore & { rows: Map<string, Row>; puts: LlmCacheInsert[]; touches: [string, number][] } {
  const rows = new Map<string, Row>();
  const puts: LlmCacheInsert[] = [];
  const touches: [string, number][] = [];
  return {
    rows,
    puts,
    touches,
    async get(key, notOlderThan): Promise<LlmCacheEntry | null> {
      const row = rows.get(key);
      if (row === undefined || row.createdAt < Date.parse(notOlderThan)) return null;
      return { key, response: row.response, hits: row.hits };
    },
    async put(entry) {
      puts.push(entry);
      rows.set(entry.key, { ...entry, createdAt: NOW, hits: 0 });
    },
    async touch(key, hits) {
      touches.push([key, hits]);
      const row = rows.get(key);
      if (row !== undefined) row.hits = hits;
    },
  };
}

function gateway(answer: Partial<GatewayChatAnswer> = {}): { call: () => Promise<GatewayChatAnswer>; calls: () => number } {
  let calls = 0;
  return {
    call: async () => {
      calls += 1;
      return { content: '{"has_bill": true, "rows": []}', tokens: 120, tokensIn: 100, tokensOut: 20, finishReason: "stop", ...answer };
    },
    calls: () => calls,
  };
}

const ON = {}; // Окружение без LLM_CACHE_DISABLED: в vitest он выставлен глобально, поэтому передаётся своё.

beforeEach(() => {
  resetLlmCacheWarnings();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ключ кэша", () => {
  it("sha256 от версии, модели, вида работы и полного JSON сообщений", () => {
    const key = llmCacheKey({ model: "m-1", purpose: "estimate_bill", messages: MESSAGES });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(llmCacheKey({ model: "m-1", purpose: "estimate_bill", messages: MESSAGES })).toBe(key);
    expect(llmCacheKey({ model: "m-2", purpose: "estimate_bill", messages: MESSAGES })).not.toBe(key);
    expect(llmCacheKey({ model: "m-1", purpose: "estimate_implied", messages: MESSAGES })).not.toBe(key);
    expect(llmCacheKey({ model: "m-1", purpose: "estimate_bill", messages: [{ role: "user", content: "другой текст" }] })).not.toBe(key);
    expect(LLM_CACHE_VERSION).toBeTruthy();
  });
});

describe("cachedLlmChat", () => {
  it("промах: зовёт шлюз и запоминает полный ответ вместе с токенами", async () => {
    const store = memoryStore();
    const gw = gateway();
    const answer = await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gw.call }, { store, env: ON, now: () => NOW });

    expect(answer).toMatchObject({ cached: false, tokens: 120, content: '{"has_bill": true, "rows": []}' });
    expect(gw.calls()).toBe(1);
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]).toMatchObject({ purpose: "estimate_bill", model: "m-1", tokensIn: 100, tokensOut: 20 });
  });

  it("попадание: шлюз не зовётся, токены 0, счётчик попаданий растёт без ожидания", async () => {
    const store = memoryStore();
    const first = gateway();
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: first.call }, { store, env: ON, now: () => NOW });

    const second = gateway({ content: "другой ответ" });
    const answer = await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: second.call }, { store, env: ON, now: () => NOW });

    expect(answer).toMatchObject({ cached: true, tokens: 0, content: '{"has_bill": true, "rows": []}' });
    expect(second.calls()).toBe(0);
    await vi.waitFor(() => expect(store.touches).toHaveLength(1));
    expect(store.touches[0]?.[1]).toBe(1);
  });

  it("попадание не ждёт счётчика: зависший touch ответа не задерживает", async () => {
    const store = memoryStore();
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gateway().call }, { store, env: ON, now: () => NOW });
    store.touch = () => new Promise<void>(() => {});
    const answer = await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gateway().call }, { store, env: ON, now: () => NOW });
    expect(answer.cached).toBe(true);
  });

  it("сбой touch не ломает ответ", async () => {
    const store = memoryStore();
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gateway().call }, { store, env: ON, now: () => NOW });
    store.touch = async () => {
      throw new Error("нет прав");
    };
    const answer = await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gateway().call }, { store, env: ON, now: () => NOW });
    expect(answer.cached).toBe(true);
  });

  it("другая модель или другой текст — промах", async () => {
    const store = memoryStore();
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gateway().call }, { store, env: ON, now: () => NOW });

    const otherModel = gateway();
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-2", messages: MESSAGES, call: otherModel.call }, { store, env: ON, now: () => NOW });
    const otherText = gateway();
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: [{ role: "user", content: "иначе" }], call: otherText.call }, { store, env: ON, now: () => NOW });

    expect(otherModel.calls()).toBe(1);
    expect(otherText.calls()).toBe(1);
  });

  it("срок: ответ старше 60 дней игнорируется, свежий (59 дней) отдаётся", async () => {
    const store = memoryStore();
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gateway().call }, { store, env: ON, now: () => NOW });

    const fresh = gateway();
    const at59 = await cachedLlmChat(
      { purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: fresh.call },
      { store, env: ON, now: () => NOW + LLM_CACHE_TTL_MS - 24 * 60 * 60 * 1000 },
    );
    expect(at59.cached).toBe(true);
    expect(fresh.calls()).toBe(0);

    const expired = gateway({ content: '{"has_bill": false, "rows": []}' });
    const at61 = await cachedLlmChat(
      { purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: expired.call },
      { store, env: ON, now: () => NOW + LLM_CACHE_TTL_MS + 24 * 60 * 60 * 1000 },
    );
    expect(at61).toMatchObject({ cached: false, content: '{"has_bill": false, "rows": []}' });
    expect(expired.calls()).toBe(1);
  });

  it("сбой чтения кэша (таблицы нет): вызов идёт в шлюз, предупреждение одно", async () => {
    const store = memoryStore();
    store.get = async () => {
      throw new Error('relation "llm_response_cache" does not exist');
    };
    const gw = gateway();
    const input = { purpose: "estimate_norm_pick" as const, model: "m-1", messages: MESSAGES, call: gw.call };

    const first = await cachedLlmChat(input, { store, env: ON, now: () => NOW });
    const second = await cachedLlmChat(input, { store, env: ON, now: () => NOW });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(gw.calls()).toBe(2);
    expect(vi.mocked(console.warn).mock.calls.filter((call) => String(call[0]).includes("чтение кэша не удалось"))).toHaveLength(1);
  });

  it("сбой записи в кэш не ломает ответ", async () => {
    const store = memoryStore();
    store.put = async () => {
      throw new Error("база недоступна");
    };
    const answer = await cachedLlmChat({ purpose: "estimate_implied", model: "m-1", messages: MESSAGES, call: gateway().call }, { store, env: ON, now: () => NOW });
    expect(answer).toMatchObject({ cached: false, tokens: 120 });
  });

  it("зависшая база не задерживает расчёт дольше таймаута", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore();
      store.get = () => new Promise<LlmCacheEntry | null>(() => {});
      const gw = gateway();
      const pending = cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gw.call }, { store, env: ON, now: () => NOW });
      await vi.advanceTimersByTimeAsync(3_100);
      const answer = await pending;
      expect(answer.cached).toBe(false);
      expect(gw.calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ошибка шлюза пробрасывается и ничего не запоминает", async () => {
    const store = memoryStore();
    const call = async (): Promise<GatewayChatAnswer> => {
      throw new Error("Шлюз модели ответил 502");
    };
    await expect(cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call }, { store, env: ON, now: () => NOW })).rejects.toThrow(/502/);
    expect(store.puts).toHaveLength(0);
  });
});

describe("неполные ответы не кэшируются", () => {
  it.each(["length", "max_tokens", "MAX_TOKENS", "content_filter", "error"])("finish_reason «%s»", async (finishReason) => {
    const store = memoryStore();
    const gw = gateway({ finishReason });
    const answer = await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gw.call }, { store, env: ON, now: () => NOW });
    expect(answer.content).toBeTruthy(); // ответ отдаётся как есть
    expect(store.puts).toHaveLength(0);

    // Повтор снова идёт в шлюз: у него есть шанс на полный ответ.
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gw.call }, { store, env: ON, now: () => NOW });
    expect(gw.calls()).toBe(2);
  });

  it("finish_reason «stop» и неназванный — кэшируются", async () => {
    const store = memoryStore();
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gateway({ finishReason: "stop" }).call }, { store, env: ON, now: () => NOW });
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-2", messages: MESSAGES, call: gateway({ finishReason: null }).call }, { store, env: ON, now: () => NOW });
    expect(store.puts).toHaveLength(2);
  });

  it("ответ, который не прошёл проверку вызывающего (оборванный JSON), не кэшируется", async () => {
    const store = memoryStore();
    const gw = gateway({ content: '{"has_bill": true, "rows": [{"work_name": "Недопис' });
    await cachedLlmChat(
      { purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gw.call, validate: (content) => content.trimEnd().endsWith("}") },
      { store, env: ON, now: () => NOW },
    );
    expect(store.puts).toHaveLength(0);
  });

  it("проверка, которая бросает, равна отказу: ответ отдан, в кэш не лёг", async () => {
    const store = memoryStore();
    const answer = await cachedLlmChat(
      {
        purpose: "estimate_bill",
        model: "m-1",
        messages: MESSAGES,
        call: gateway().call,
        validate: () => {
          throw new Error("разбор упал");
        },
      },
      { store, env: ON, now: () => NOW },
    );
    expect(answer.cached).toBe(false);
    expect(store.puts).toHaveLength(0);
  });

  it("пустой ответ не кэшируется", async () => {
    const store = memoryStore();
    await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gateway({ content: "  " }).call }, { store, env: ON, now: () => NOW });
    expect(store.puts).toHaveLength(0);
  });

  it("isCompleteFinish", () => {
    expect(isCompleteFinish(undefined)).toBe(true);
    expect(isCompleteFinish("stop")).toBe(true);
    expect(isCompleteFinish("end_turn")).toBe(true);
    expect(isCompleteFinish("length")).toBe(false);
  });
});

describe("выключение и область действия", () => {
  it("LLM_CACHE_DISABLED=1 (или true): хранилище не трогается, шлюз зовётся каждый раз", async () => {
    for (const flag of ["1", "true", " TRUE "]) {
      const store = memoryStore();
      const getSpy = vi.spyOn(store, "get");
      const gw = gateway();
      await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gw.call }, { store, env: { LLM_CACHE_DISABLED: flag }, now: () => NOW });
      await cachedLlmChat({ purpose: "estimate_bill", model: "m-1", messages: MESSAGES, call: gw.call }, { store, env: { LLM_CACHE_DISABLED: flag }, now: () => NOW });
      expect(gw.calls()).toBe(2);
      expect(getSpy).not.toHaveBeenCalled();
      expect(store.puts).toHaveLength(0);
    }
    expect(isLlmCacheDisabled({ LLM_CACHE_DISABLED: "0" })).toBe(false);
    expect(isLlmCacheDisabled({})).toBe(false);
  });

  it("вне сметы (поиск, глубокий анализ, диагностика) кэш не работает", async () => {
    for (const purpose of ["search_assist", "rerank", "deep_analysis", "other"] as const) {
      const store = memoryStore();
      const gw = gateway();
      await cachedLlmChat({ purpose, model: "m-1", messages: MESSAGES, call: gw.call }, { store, env: ON, now: () => NOW });
      await cachedLlmChat({ purpose, model: "m-1", messages: MESSAGES, call: gw.call }, { store, env: ON, now: () => NOW });
      expect(gw.calls()).toBe(2);
      expect(store.puts).toHaveLength(0);
    }
  });

  it("usageTokens читает prompt_tokens и completion_tokens", () => {
    expect(usageTokens({ prompt_tokens: 50, completion_tokens: 7.4 })).toEqual({ tokensIn: 50, tokensOut: 7 });
    expect(usageTokens(undefined)).toEqual({ tokensIn: null, tokensOut: null });
    expect(usageTokens({ prompt_tokens: "много" })).toEqual({ tokensIn: null, tokensOut: null });
  });
});
