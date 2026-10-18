import { afterEach, describe, expect, it, vi } from "vitest";

import { createNormSearchIndex } from "@/domain/estimate/matchNorms";
import { CANDIDATE_NORMS } from "@/domain/estimate/normCandidates.fixtures";
import type { NormPickBatch, NormPicker } from "@/domain/estimate/normPick";
import type { BillOfWorkItem, BillOfWorkSection } from "@/domain/estimate/types";
import { withNormPicks, NORM_PICK_CONCURRENCY } from "@/services/estimateNormPick";
import { fetchNormPicks, remoteNormPicker, resolveNormPickModel } from "@/services/normPickService";
import { makeBillItem } from "@/test/estimateFixtures";

/**
 * Клиент подбора норм на воркере и этап «ИИ-сметчик»: пачки, одновременность, пропуски и то, как ответ по сети приводится к типам.
 */

const BATCH: NormPickBatch = {
  context: { regNumber: "0134300025826000377", subject: "Ремонт фасада", jobId: "sync-5" },
  items: [
    {
      id: "1",
      workName: "Демонтаж профлиста",
      quantity: 10,
      unit: "м2",
      extraVolumes: ["2 т"],
      remark: null,
      section: "Фасад",
      candidates: [
        { key: "ГЭСНр|63-03-007-02", book: "ГЭСНр", code: "63-03-007-02", tableCode: "63-03-007", tableName: "Замена облицовки", rowName: "от 1 м2 до 5 м2", unit: "100 м2", collection: "Облицовочные работы", summary: "Демонтаж" },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("remoteNormPicker", () => {
  it("отправляет на прод контекст, позиции и кандидатов; jobId — только если есть", async () => {
    const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => ({ ok: true, json: async () => ({ picks: [], tokens: 0 }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    await remoteNormPicker("https://app.example")(BATCH);
    await remoteNormPicker("https://app.example")({ ...BATCH, context: { regNumber: "T", subject: "s" } });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://app.example/api/estimate/norm-pick");
    const first = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(first).toMatchObject({ regNumber: "0134300025826000377", subject: "Ремонт фасада", jobId: "sync-5" });
    expect(first.items[0]).toMatchObject({ id: "1", workName: "Демонтаж профлиста", unit: "м2", extraVolumes: ["2 т"] });
    expect(first.items[0].candidates[0].key).toBe("ГЭСНр|63-03-007-02");
    const second = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect("jobId" in second).toBe(false);
  });

  it("материал: тип строки и ресурсы-кандидаты уходят на прод вместе с позицией", async () => {
    const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => ({ ok: true, json: async () => ({ picks: [], tokens: 0 }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const resources = [{ key: "РЕСУРС|23.3.06.04-0104", code: "23.3.06.04-0104", name: "Трубы стальные", unit: "м", price: 703.4 }];
    await remoteNormPicker("https://app.example")({ ...BATCH, items: [{ ...(BATCH.items[0] as NormPickBatch["items"][number]), kind: "material", candidates: [], resources }] });
    const sent = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sent.items[0]).toMatchObject({ kind: "material", candidates: [], resources });
    // Работа без типа уходит как раньше: ни kind, ни resources.
    await remoteNormPicker("https://app.example")(BATCH);
    const plain = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect("kind" in plain.items[0]).toBe(false);
    expect("resources" in plain.items[0]).toBe(false);
  });

  it("материал нормы «по проекту»: ресурс нормы уходит на прод вместе с кандидатами", async () => {
    const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => ({ ok: true, json: async () => ({ picks: [], tokens: 0 }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const resources = [{ key: "РЕСУРС|14.2.05.03-0020", code: "14.2.05.03-0020", name: "Состав двухкомпонентный", unit: "кг", price: 1777.2 }];
    const normResource = { code: "14.2.05.03", name: "Состав", unit: "кг", quantity: 165, norm: "ГЭСН 26-01-021-01", total: 300.3 };
    await remoteNormPicker("https://app.example")({ ...BATCH, items: [{ ...(BATCH.items[0] as NormPickBatch["items"][number]), kind: "norm_material", candidates: [], resources, normResource }] });
    const sent = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sent.items[0]).toMatchObject({ kind: "norm_material", candidates: [], resources, normResource });
    await remoteNormPicker("https://app.example")(BATCH);
    const plain = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect("normResource" in plain.items[0]).toBe(false);
  });

  it("ответ приводится к типам: чужие поля и кривые элементы отбрасываются и считаются", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          picks: [
            { id: 1, pick: "ГЭСН|15-01-070-01", demolition: "да", confidence: "высокая", reason: 5, лишнее: true },
            { id: "2", pick: "", demolition: true, confidence: "low", reason: "нет" },
            { pick: "ГЭСН|1" },
            "мусор",
          ],
          tokens: "много",
          malformed: 2,
        }),
      })) as unknown as typeof fetch,
    );
    const answer = await remoteNormPicker("https://app.example")(BATCH);
    expect(answer.picks).toEqual([
      { id: "1", pick: "ГЭСН|15-01-070-01", demolition: false, confidence: null, reason: "" },
      { id: "2", pick: null, demolition: true, confidence: "low", reason: "нет" },
    ]);
    expect(answer.malformed).toBe(4);
    expect(answer.tokens).toBe(0);
  });

  it("код ответа проверяется до разбора тела: страница 404 даёт «HTTP 404», а не «Unexpected token <»", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, text: async () => "<html><body>Not found</body></html>" })) as unknown as typeof fetch);
    await expect(remoteNormPicker("https://app.example")(BATCH)).rejects.toThrow(/HTTP 404/);
  });

  it("из JSON-ошибки берётся поле error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, text: async () => JSON.stringify({ error: "Модель вернула не JSON" }) })) as unknown as typeof fetch);
    await expect(remoteNormPicker("https://app.example")(BATCH)).rejects.toThrow(/HTTP 502.*Модель вернула не JSON/);
  });
});

describe("модель подбора норм", () => {
  it("TENDERFIT_NORM_PICK_MODEL читается из окружения; пусто — не задано", () => {
    expect(resolveNormPickModel({ TENDERFIT_NORM_PICK_MODEL: " google/gemini-2.5-pro " })).toBe("google/gemini-2.5-pro");
    expect(resolveNormPickModel({ TENDERFIT_NORM_PICK_MODEL: "" })).toBeUndefined();
    expect(resolveNormPickModel({})).toBeUndefined();
  });

  it("чат получает модель и таймаут пачки, а ответ разбирается", async () => {
    const chat = vi.fn(async () => ({ content: JSON.stringify({ items: [{ id: "1", pick: null, reason: "нет" }] }), tokens: 99 }));
    const answer = await fetchNormPicks(BATCH, chat, { TENDERFIT_NORM_PICK_MODEL: "m-1" });
    expect(answer).toMatchObject({ tokens: 99, malformed: 0 });
    expect(answer.picks[0]).toMatchObject({ id: "1", pick: null });
    expect(chat).toHaveBeenCalledWith(expect.stringContaining("Демонтаж профлиста"), 540, { purpose: "estimate_norm_pick", tenderId: "0134300025826000377", jobId: "sync-5" }, { model: "m-1", timeoutMs: 90_000 });
  });
});

describe("withNormPicks: пачки и пропуски", () => {
  const INDEX = createNormSearchIndex(CANDIDATE_NORMS);
  const base = (patch: Partial<BillOfWorkItem>): BillOfWorkItem =>
    makeBillItem({ workName: "Демонтаж оконных откосов", quantity: 10, quantityUnit: "м2", unitDivisor: 1, normCode: null, normBaseType: null, ...patch });
  const section = (items: BillOfWorkItem[]): BillOfWorkSection[] => [{ title: "ВОР", items }];
  const finalize = (item: BillOfWorkItem): BillOfWorkItem => item;
  const nothing: NormPicker = async () => ({ picks: [], tokens: 0, malformed: 0 });

  it("25 позиций — три пачки (10 + 10 + 5), одновременно не больше NORM_PICK_CONCURRENCY", async () => {
    const items = Array.from({ length: 25 }, (_, index) => base({ id: `i${String(index)}` }));
    let inFlight = 0;
    let peak = 0;
    const sizes: number[] = [];
    const picker: NormPicker = async (batch) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      sizes.push(batch.items.length);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { picks: [], tokens: 10, malformed: 0 };
    };
    const { stats } = await withNormPicks(section(items), { index: INDEX, picker, context: { regNumber: "T", subject: "s" }, finalize });
    expect(sizes.sort((a, b) => b - a)).toEqual([10, 10, 5]);
    expect(peak).toBeLessThanOrEqual(NORM_PICK_CONCURRENCY);
    expect(stats).toMatchObject({ requested: 25, batches: 3, tokens: 30, fallback: 25 });
  });

  it("идентификаторы внутри пачки — «1»…«10», а не идентификаторы ведомости", async () => {
    const seen: string[][] = [];
    const picker: NormPicker = async (batch) => {
      seen.push(batch.items.map((item) => item.id));
      return { picks: [], tokens: 0, malformed: 0 };
    };
    await withNormPicks(section([base({ id: "очень-длинный-идентификатор-ведомости-1" }), base({ id: "x2" })]), { index: INDEX, picker, context: { regNumber: "T", subject: "s" }, finalize });
    expect(seen).toEqual([["1", "2"]]);
  });

  it("позиция без читаемой единицы или без кандидатов на подбор не уходит и считается в skipped", async () => {
    const picker = vi.fn(nothing);
    const items = [base({ id: "a", quantityUnit: "условных единиц" }), base({ id: "b", workName: "Zzzzqqq xxyyzz" }), base({ id: "c" })];
    const { stats } = await withNormPicks(section(items), { index: INDEX, picker, context: { regNumber: "T", subject: "s" }, finalize });
    expect(stats).toMatchObject({ requested: 1, skipped: 2 });
    expect(picker.mock.calls[0]?.[0].items).toHaveLength(1);
  });

  it("парный объём уходит справкой, примечание и раздел — в позицию запроса", async () => {
    const picker = vi.fn(nothing);
    const item = base({ volumeVariants: [{ quantity: 10, unit: "м2" }, { quantity: 3.5, unit: "т" }], remark: "*доступ к профлисту", billSection: "Фасад" });
    await withNormPicks(section([item]), { index: INDEX, picker, context: { regNumber: "T", subject: "s" }, finalize });
    expect(picker.mock.calls[0]?.[0].items[0]).toMatchObject({ unit: "м2", extraVolumes: ["3.5 т"], remark: "*доступ к профлисту", section: "Фасад" });
  });

  it("позиции без выбора возвращаются теми же объектами; вход не меняется", async () => {
    const items = [base({ id: "a" })];
    const input = section(items);
    const { sections } = await withNormPicks(input, { index: INDEX, picker: nothing, context: { regNumber: "T", subject: "s" }, finalize });
    expect(sections[0]?.items[0]).toBe(items[0]);
    expect(input[0]?.items[0]).toBe(items[0]);
  });
});
