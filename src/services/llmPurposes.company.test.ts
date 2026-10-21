import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { LLM_PURPOSES } from "@/repositories/llmUsageRepository";
import { CACHEABLE_PURPOSES, isCacheablePurpose, cachedLlmChat } from "@/services/llmResponseCache";
import { parseFactsResponse } from "@/domain/companyFacts/schema";

/**
 * Новые виды работы в журнале расхода: код, подписи и проверка в базе обязаны совпадать — иначе запись учёта по новому виду
 * молча отвергается базой, а расход пропадает из отчёта.
 */

describe("виды работы company_facts и company_fit", () => {
  it("есть в перечне видов работы", () => {
    expect(LLM_PURPOSES).toContain("company_facts");
    expect(LLM_PURPOSES).toContain("company_fit");
  });

  it("проверка purpose в самой свежей миграции перечисляет ровно те же виды, что и код", () => {
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    let latest: string | null = null;
    for (const name of files) {
      if (readFileSync(path.join(dir, name), "utf8").includes("add constraint llm_usage_log_purpose_check")) latest = name;
    }
    expect(latest).not.toBeNull();
    const sql = readFileSync(path.join(dir, latest ?? ""), "utf8");
    const match = /add constraint llm_usage_log_purpose_check\s+check \(purpose in \(([^)]*)\)\)/u.exec(sql);
    const purposes = [...(match?.[1] ?? "").matchAll(/'([a-z_]+)'/gu)].map((item) => item[1]).sort();
    expect(purposes).toEqual([...LLM_PURPOSES].sort());
  });

  it("миграция идемпотентна и помечена для pq.sh", () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", "20261021000027_company_fit.sql"), "utf8");
    expect(sql).toContain("/root/dbmove/pq.sh -f");
    expect(sql).toContain("create table if not exists public.company_fit");
    expect(sql).toContain("drop constraint if exists llm_usage_log_purpose_check");
    expect(sql).toContain("primary key (user_id, tender_id)");
    expect(sql).toContain("notify pgrst");
  });
});

describe("кэш ответов для company_facts", () => {
  it("факты компании кэшируются, сверка с закупкой — нет (у неё своя таблица)", () => {
    expect(CACHEABLE_PURPOSES).toContain("company_facts");
    expect(isCacheablePurpose("company_facts")).toBe(true);
    expect(isCacheablePurpose("company_fit")).toBe(false);
  });

  it("тот же очищенный запрос не оплачивается второй раз; ответ не по схеме в кэш не кладётся", async () => {
    const rows = new Map<string, string>();
    const store = {
      get: async (key: string) => (rows.has(key) ? { key, response: rows.get(key) ?? "", hits: 0 } : null),
      put: async (entry: { key: string; response: string }) => {
        rows.set(entry.key, entry.response);
      },
      touch: async () => undefined,
    };
    const env = { LLM_CACHE_DISABLED: "" };
    let calls = 0;
    const input = (content: string) => ({
      purpose: "company_facts" as const,
      model: "m",
      messages: [{ role: "user", content: "очищенный текст [ФИО]" }],
      call: async () => {
        calls += 1;
        return { content, tokens: 10, finishReason: "stop" };
      },
      validate: (text: string) => {
        parseFactsResponse(text);
        return true;
      },
    });

    await cachedLlmChat(input("не JSON"), { store, env });
    expect(rows.size).toBe(0);

    const good = JSON.stringify({ regions: ["Омская область"] });
    await cachedLlmChat(input(good), { store, env });
    const again = await cachedLlmChat(input(good), { store, env });
    expect(again.cached).toBe(true);
    expect(calls).toBe(2);
  });
});
