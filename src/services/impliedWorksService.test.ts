import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImpliedRequest } from "@/domain/estimate/impliedWorks";
import { fetchImpliedWorks, remoteImpliedProposer, resolveImpliedModel } from "@/services/impliedWorksService";

/** Клиент воркера и серверная часть «работ по технологии»: что уходит на прод и как ответ по сети приводится к типам. */

const REQUEST: ImpliedRequest = {
  context: { regNumber: "0134300025826000377", subject: "Ремонт фасада", jobId: "sync-5" },
  facts: { heightM: 12, floors: null, mentions: { facade: true, roof: false, interior: false }, snippets: [] },
  items: [{ id: "1", name: "Монтаж утеплителя", quantity: 56.5, unit: "м2", norm: null, machines: null }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("remoteImpliedProposer", () => {
  it("отправляет на прод контекст, факты и позиции; jobId — только если есть", async () => {
    const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => ({ ok: true, json: async () => ({ additions: [], tokens: 0 }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    await remoteImpliedProposer("https://app.example")(REQUEST);
    await remoteImpliedProposer("https://app.example")({ ...REQUEST, context: { regNumber: "T", subject: "s" } });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://app.example/api/estimate/implied-works");
    const first = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(first).toMatchObject({ regNumber: "0134300025826000377", subject: "Ремонт фасада", jobId: "sync-5", facts: { heightM: 12 } });
    expect(first.items[0]).toMatchObject({ id: "1", name: "Монтаж утеплителя", unit: "м2" });
    const second = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect("jobId" in second).toBe(false);
  });

  it("ответ приводится к типам: чужие поля, категории вне белого списка и кривые элементы отбрасываются и считаются", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          additions: [
            { workName: "Леса", category: "SCAFFOLD", unit: "м2", formula: "#1", reason: 5, лишнее: true },
            { workName: "Основные работы", category: "MAIN", unit: "м2", formula: "#1" },
            { workName: "Без формулы", category: "SCAFFOLD", unit: "м2" },
            "мусор",
          ],
          tokens: "много",
          malformed: 2,
        }),
      })),
    );
    const answer = await remoteImpliedProposer("https://app.example")(REQUEST);
    expect(answer.additions).toEqual([{ workName: "Леса", category: "SCAFFOLD", unit: "м2", formula: "#1", reason: "" }]);
    expect(answer.malformed).toBe(5);
    expect(answer.tokens).toBe(0);
  });

  it("не 200 — ошибка с кодом и причиной из тела", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Нужен секрет воркера" }), { status: 403 })));
    await expect(remoteImpliedProposer("https://app.example")(REQUEST)).rejects.toThrow(/HTTP 403.*Нужен секрет воркера/);
  });
});

describe("fetchImpliedWorks", () => {
  it("зовёт чат с видом работы estimate_implied и разбирает ответ", async () => {
    const chat = vi.fn(async () => ({ content: JSON.stringify({ additions: [{ workName: "Сетка защитная", category: "PROTECTION", unit: "м2", formula: "#1", reason: "над проходом" }] }), tokens: 321 }));
    const answer = await fetchImpliedWorks(REQUEST, chat, {});
    expect(chat).toHaveBeenCalledTimes(1);
    expect((chat.mock.calls[0] as unknown[])[2]).toEqual({ purpose: "estimate_implied", tenderId: "0134300025826000377", jobId: "sync-5" });
    expect(answer).toMatchObject({ tokens: 321, malformed: 0 });
    expect(answer.additions[0]?.category).toBe("PROTECTION");
  });

  it("модель: свой переменной, иначе подбора норм, иначе нет", () => {
    expect(resolveImpliedModel({})).toBeUndefined();
    expect(resolveImpliedModel({ TENDERFIT_NORM_PICK_MODEL: "a" })).toBe("a");
    expect(resolveImpliedModel({ TENDERFIT_NORM_PICK_MODEL: "a", TENDERFIT_IMPLIED_MODEL: "b" })).toBe("b");
    expect(resolveImpliedModel({ TENDERFIT_IMPLIED_MODEL: "  " })).toBeUndefined();
  });
});
