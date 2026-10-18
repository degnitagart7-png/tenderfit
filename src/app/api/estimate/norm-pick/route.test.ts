import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chat = vi.fn();
vi.mock("@/services/searchAssistService", () => ({ llmChat: (...args: unknown[]) => chat(...args) }));

process.env["TENDERFIT_WORKER_SECRET"] = "test-worker-secret-0123456789abcdef";
const { POST } = await import("./route");

/**
 * Ручка «ИИ-сметчика»: проверяется то, что она обещает, а не модель. Чат подменён; видно, что в него ушло (промпт, вид работы
 * для журнала расхода, модель) и что вернулось воркеру. Без входа и без лимита частоты — как `bill-rows`: расход ложится в
 * журнал, а вход ограничен схемой.
 */

function candidate(code: string, extra: Record<string, unknown> = {}) {
  return {
    key: `ГЭСН|${code}`,
    book: "ГЭСН",
    code,
    tableCode: code.split("-").slice(0, 3).join("-"),
    tableName: "Облицовка",
    rowName: "оконных проемов в наружных стенах откосной планкой",
    unit: "м2",
    collection: "Отделочные работы / наружная облицовка фасадов",
    summary: "Установка верхних деталей окантовок с подгонкой по месту монтажа.",
    ...extra,
  };
}

function item(id: string, extra: Record<string, unknown> = {}) {
  return { id, workName: `Демонтаж оконных откосов ${id}`, quantity: 12, unit: "м2", remark: null, section: "Фасад", candidates: [candidate("15-01-070-01")], ...extra };
}

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/estimate/norm-pick", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-worker-secret": "test-worker-secret-0123456789abcdef", ...headers },
  });
}

const body = (items: unknown[], extra: Record<string, unknown> = {}) => ({ regNumber: "0134300025826000377", subject: "Ремонт фасада", items, ...extra });

const ANSWER = JSON.stringify({ items: [{ id: "1", pick: "ГЭСН|15-01-070-01", demolition: true, confidence: "high", reason: "откосная планка" }] });

describe("POST /api/estimate/norm-pick", () => {
  beforeEach(() => {
    chat.mockReset();
    chat.mockResolvedValue({ content: ANSWER, tokens: 4321 });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("отдаёт выбор модели, токены и число кривых элементов; шаблон промпта — неизменный, кандидаты внутри", async () => {
    const response = await POST(request(body([item("1")])));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      picks: [{ id: "1", pick: "ГЭСН|15-01-070-01", demolition: true, confidence: "high", reason: "откосная планка" }],
      tokens: 4321,
      malformed: 0,
    });
    const prompt = chat.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("аттестованный сметчик");
    expect(prompt).toContain("Закупка № 0134300025826000377");
    expect(prompt).toContain("Работа: Демонтаж оконных откосов 1");
    expect(prompt).toContain("ГЭСН|15-01-070-01 | оконных проемов в наружных стенах откосной планкой | ед. м2");
  });

  it("расход уходит в журнал с видом работы estimate_norm_pick, закупкой и заданием расчёта", async () => {
    await POST(request(body([item("1")], { jobId: "sync-77" })));
    expect(chat.mock.calls[0]?.[2]).toEqual({ purpose: "estimate_norm_pick", tenderId: "0134300025826000377", jobId: "sync-77" });
  });

  it("расчёт по присланным файлам («без номера») пишется без закупки, без задания — jobId null", async () => {
    await POST(request(body([item("1")], { regNumber: "без номера" })));
    expect(chat.mock.calls[0]?.[2]).toEqual({ purpose: "estimate_norm_pick", tenderId: null, jobId: null });
  });

  it("модель — TENDERFIT_NORM_PICK_MODEL; не задана — без переопределения, то есть модель извлечения ведомости", async () => {
    await POST(request(body([item("1")])));
    expect(chat.mock.calls[0]?.[3]).toEqual({ timeoutMs: 90_000 });

    vi.stubEnv("TENDERFIT_NORM_PICK_MODEL", "google/gemini-2.5-pro");
    await POST(request(body([item("1")])));
    expect(chat.mock.calls[1]?.[3]).toEqual({ model: "google/gemini-2.5-pro", timeoutMs: 90_000 });

    vi.stubEnv("TENDERFIT_NORM_PICK_MODEL", "   ");
    await POST(request(body([item("1")])));
    expect(chat.mock.calls[2]?.[3]).toEqual({ timeoutMs: 90_000 });
  });

  it("пачка из десяти позиций — один вызов модели; на ответ закладывается запас токенов по числу позиций", async () => {
    const items = Array.from({ length: 10 }, (_, index) => item(String(index + 1)));
    const response = await POST(request(body(items)));
    expect(response.status).toBe(200);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[1]).toBe(400 + 10 * 140);
    const prompt = chat.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("### Позиция 10");
  });

  it("одиннадцатая позиция — 400: пачка не больше десяти; модель не зовётся", async () => {
    const items = Array.from({ length: 11 }, (_, index) => item(String(index + 1)));
    const response = await POST(request(body(items)));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("items");
    expect(chat).not.toHaveBeenCalled();
  });

  it("повторяющиеся идентификаторы позиций — 400: ответ сопоставляется с позицией по id", async () => {
    const response = await POST(request(body([item("1"), item("1")])));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("повторяются");
  });

  it("позиция без кандидатов и более тридцати кандидатов — 400", async () => {
    expect((await POST(request(body([item("1", { candidates: [] })])))).status).toBe(400);
    const many = Array.from({ length: 31 }, (_, index) => candidate(`15-01-${String(100 + index)}-01`));
    expect((await POST(request(body([item("1", { candidates: many })])))).status).toBe(400);
    expect(chat).not.toHaveBeenCalled();
  });

  it("не JSON — 400; слишком большой запрос — 413", async () => {
    const broken = new NextRequest("http://localhost/api/estimate/norm-pick", { method: "POST", body: "{не json", headers: { "Content-Type": "application/json", "x-worker-secret": "test-worker-secret-0123456789abcdef" } });
    expect((await POST(broken)).status).toBe(400);
    const huge = request(body([item("1")]), { "content-length": "9000000" });
    expect((await POST(huge)).status).toBe(413);
    expect(chat).not.toHaveBeenCalled();
  });

  it("длинные предмет закупки и примечание обрезаются, а не роняют расчёт", async () => {
    const response = await POST(request(body([item("1", { remark: "п".repeat(900) })], { subject: "Выполнение работ ".repeat(80) })));
    expect(response.status).toBe(200);
    const prompt = chat.mock.calls[0]?.[0] as string;
    expect(prompt).not.toContain("п".repeat(301));
  });

  it("модель вернула не JSON — 502 с причиной: воркер откатит пачку на подбор по наименованию", async () => {
    chat.mockResolvedValueOnce({ content: "Извините, не могу помочь", tokens: 10 });
    const response = await POST(request(body([item("1")])));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("не JSON");
  });

  it("сбой шлюза — 502", async () => {
    chat.mockRejectedValueOnce(new Error("Шлюз модели ответил 503"));
    const response = await POST(request(body([item("1")])));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("503");
  });

  it("кривой элемент ответа считается числом, остальные доезжают", async () => {
    chat.mockResolvedValueOnce({ content: JSON.stringify({ items: [{ id: "1", pick: null, reason: "нет" }, { pick: "ГЭСН|1" }] }), tokens: 5 });
    const answer = (await (await POST(request(body([item("1"), item("2")])))).json()) as { picks: unknown[]; malformed: number };
    expect(answer.picks).toHaveLength(1);
    expect(answer.malformed).toBe(1);
  });

  it("материал: позиция без норм, но с ресурсами принимается, а в промпт доезжают тип и кандидаты-ресурсы", async () => {
    const material = item("1", {
      workName: "Трубы стальные электросварные, наружный диаметр 89 мм",
      unit: "м",
      kind: "material",
      candidates: [],
      resources: [{ key: "РЕСУРС|23.3.06.04-0104", code: "23.3.06.04-0104", name: "Трубы стальные электросварные, наружный диаметр 89 мм", unit: "м", price: 703.4 }],
    });
    chat.mockResolvedValueOnce({ content: JSON.stringify({ items: [{ id: "1", pick: "РЕСУРС|23.3.06.04-0104", confidence: "high", reason: "диаметр 89 мм" }] }), tokens: 99 });
    const response = await POST(request(body([material])));
    expect(response.status).toBe(200);
    const prompt = chat.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Тип: материал");
    expect(prompt).toContain("РЕСУРС|23.3.06.04-0104 | Трубы стальные электросварные, наружный диаметр 89 мм | ед. м | цена 703,4 ₽");
    const answer = (await response.json()) as { picks: { pick: string }[] };
    expect(answer.picks[0]?.pick).toBe("РЕСУРС|23.3.06.04-0104");
  });

  it("материал нормы «по проекту»: ресурс нормы и кандидаты-ресурсы принимаются, в промпт доезжают описание ресурса нормы и правила; без ресурса нормы — 400", async () => {
    const need = {
      code: "14.2.05.03",
      name: "Состав двухкомпонентный на основе полиуретановых смол",
      unit: "кг",
      quantity: 165,
      norm: "ГЭСН 26-01-021-01 «Изоляция плоских и криволинейных поверхностей из пенополиуретана», единица нормы 100 м2",
      total: 300.3,
    };
    const resources = [{ key: "РЕСУРС|14.2.05.03-0020", code: "14.2.05.03-0020", name: "Состав двухкомпонентный на основе полиуретановых смол", unit: "кг", price: 1777.2 }];
    const normMaterial = item("1", { workName: "Изоляция кровли напыляемым пенополиуретаном", kind: "norm_material", candidates: [], resources, normResource: need });
    chat.mockResolvedValueOnce({ content: JSON.stringify({ items: [{ id: "1", pick: "РЕСУРС|14.2.05.03-0020", confidence: "high", reason: "смола для напыления" }] }), tokens: 70 });
    const response = await POST(request(body([normMaterial])));
    expect(response.status).toBe(200);
    const prompt = chat.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Тип: материал нормы «по проекту»");
    expect(prompt).toContain("Норма: ГЭСН 26-01-021-01");
    expect(prompt).toContain("Материал нормы без марки: «Состав двухкомпонентный на основе полиуретановых смол», код 14.2.05.03, единица кг; расход по норме 165 кг на единицу нормы, на весь объём позиции около 300,3 кг");
    expect(prompt).toContain("РЕСУРС|14.2.05.03-0020 | Состав двухкомпонентный на основе полиуретановых смол | ед. кг | цена 1\u00a0777,2 ₽");
    expect(prompt).toContain("## Материал нормы «по проекту»");
    expect(prompt).toContain("Лучше null, чем чужой материал");
    expect(((await response.json()) as { picks: { pick: string }[] }).picks[0]?.pick).toBe("РЕСУРС|14.2.05.03-0020");

    chat.mockClear();
    const withoutNeed = item("1", { kind: "norm_material", candidates: [], resources });
    expect((await POST(request(body([withoutNeed])))).status).toBe(400);
    expect(chat).not.toHaveBeenCalled();
  });

  it("материал без ресурсов и без норм — 400", async () => {
    expect((await POST(request(body([item("1", { kind: "material", candidates: [], resources: [] })])))).status).toBe(400);
    expect(chat).not.toHaveBeenCalled();
  });

  it("доступна без входа, как bill-rows: ни заголовка авторизации, ни куки не требуется", async () => {
    const response = await POST(request(body([item("1")])));
    expect(response.status).toBe(200);
  });
});
