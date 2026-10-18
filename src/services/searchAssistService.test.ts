import { describe, expect, it, vi } from "vitest";

import { createSearchAssist, type ChatFn } from "@/services/searchAssistService";

/** Поддельная модель: отвечает заданным текстом и считает обращения. */
function fakeChat(content: string, tokens = 120): { chat: ChatFn; calls: () => number } {
  const spy = vi.fn(async () => ({ content, tokens }));
  return { chat: spy, calls: () => spy.mock.calls.length };
}

describe("expand", () => {
  it("возвращает формулировки из ответа модели", async () => {
    const { chat } = fakeChat('{"synonyms":["юрист","адвокат"]}');
    const assist = createSearchAssist(chat);

    const result = await assist.expand("юридические услуги");

    expect(result.synonyms).toEqual(["юрист", "адвокат"]);
    expect(result.cached).toBe(false);
    expect(result.tokens).toBe(120);
  });

  it("повторный запрос берётся из кэша и не тратит токены", async () => {
    const { chat, calls } = fakeChat('{"synonyms":["юрист"]}');
    const assist = createSearchAssist(chat);

    await assist.expand("юридические услуги");
    const again = await assist.expand("  Юридические   услуги ");

    expect(calls()).toBe(1);
    expect(again.cached).toBe(true);
    expect(again.tokens).toBe(0);
  });

  it("пустой разбор не кэшируется: следующая попытка может удаться", async () => {
    const { chat, calls } = fakeChat("не могу помочь");
    const assist = createSearchAssist(chat);

    await assist.expand("юридические услуги");
    await assist.expand("юридические услуги");

    expect(calls()).toBe(2);
  });

  it("сбой модели доходит до вызывающего, а не превращается в пустой ответ", async () => {
    const chat: ChatFn = async () => {
      throw new Error("шлюз недоступен");
    };

    await expect(createSearchAssist(chat).expand("юридические услуги")).rejects.toThrow(
      "шлюз недоступен",
    );
  });
});

describe("rerank", () => {
  const candidates = [
    { id: "t1", subject: "Оказание комплекса юридических услуг" },
    { id: "t2", subject: "Оказание услуг связи юридическому лицу" },
  ];
  const answer = JSON.stringify({
    items: [
      { n: 1, fit: "yes", reason: "юридические услуги" },
      { n: 2, fit: "no", reason: "юридическое лицо" },
    ],
  });

  it("сопоставляет оценки с закупками", async () => {
    const { chat } = fakeChat(answer);

    const result = await createSearchAssist(chat).rerank({
      query: "юридические услуги",
      candidates,
    });

    expect(result.verdicts.t1?.fit).toBe("yes");
    expect(result.verdicts.t2?.fit).toBe("no");
  });

  it("тот же набор кэшируется, другой — нет", async () => {
    const { chat, calls } = fakeChat(answer);
    const assist = createSearchAssist(chat);

    await assist.rerank({ query: "юридические услуги", candidates });
    await assist.rerank({ query: "юридические услуги", candidates });
    await assist.rerank({ query: "юридические услуги", candidates: candidates.slice(0, 1) });

    expect(calls()).toBe(2);
  });

  it("запрос к модели не получает внутренних идентификаторов", async () => {
    const seen: string[] = [];
    const chat: ChatFn = async (prompt) => {
      seen.push(prompt);
      return { content: answer, tokens: 1 };
    };

    await createSearchAssist(chat).rerank({ query: "юридические услуги", candidates });

    expect(seen[0]).not.toContain("t1");
  });

  it("лишние закупки сверх предела не уходят в модель", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `t${String(i)}`,
      subject: `Закупка ${String(i)}`,
    }));
    const seen: string[] = [];
    const chat: ChatFn = async (prompt) => {
      seen.push(prompt);
      return { content: '{"items":[]}', tokens: 1 };
    };

    await createSearchAssist(chat).rerank({ query: "q", candidates: many });

    expect(seen[0]).not.toContain("31.");
  });
});
