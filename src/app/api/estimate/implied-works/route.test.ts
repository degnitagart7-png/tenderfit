import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chat = vi.fn();
vi.mock("@/services/searchAssistService", () => ({ llmChat: (...args: unknown[]) => chat(...args) }));

process.env["TENDERFIT_WORKER_SECRET"] = "test-worker-secret-0123456789abcdef";
const { POST } = await import("./route");

/**
 * Ручка «работы по технологии»: проверяется то, что она обещает, а не модель. Чат подменён; видно, что в него ушло (промпт, вид работы для журнала
 * расхода, модель) и что вернулось воркеру. Как у norm-pick: секрет воркера, вход ограничен схемой, промпт — неизменный шаблон.
 */

const SECRET = "test-worker-secret-0123456789abcdef";

function item(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: `Монтаж утеплителя ${id}`, quantity: 56.5, unit: "м2", norm: { book: "ГЭСН", code: "26-01-041-01", name: "Изоляция стен" }, machines: false, ...extra };
}

const FACTS = { heightM: 12, floors: 4, mentions: { facade: true, roof: false, interior: false }, snippets: ["Высота здания до 12 м"] };

function request(body: unknown, headers: Record<string, string> = { "x-worker-secret": SECRET }): NextRequest {
  return new NextRequest("http://localhost/api/estimate/implied-works", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const body = (items: unknown[], extra: Record<string, unknown> = {}) => ({ regNumber: "0134300025826000377", subject: "Ремонт утепления фасада", facts: FACTS, items, ...extra });

const ADDITION = { workName: "Устройство и разборка наружных трубчатых инвентарных лесов", category: "SCAFFOLD", unit: "м2", formula: "max(#1, #2)", reason: "Работы на фасаде выше 1,8 м" };
const ANSWER = JSON.stringify({ additions: [ADDITION] });

describe("POST /api/estimate/implied-works", () => {
  beforeEach(() => {
    chat.mockReset();
    chat.mockResolvedValue({ content: ANSWER, tokens: 777 });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("отдаёт дополнения модели, токены и число кривых элементов; шаблон промпта — неизменный: белый список, формулы, позиции", async () => {
    const response = await POST(request(body([item("1"), item("2")])));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ additions: [ADDITION], tokens: 777, malformed: 0 });
    const prompt = chat.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("аттестованный сметчик");
    expect(prompt).toContain("Закупка № 0134300025826000377");
    expect(prompt).toContain("## Белый список категорий");
    expect(prompt).toContain("- SCAFFOLD — леса, подмости, люльки");
    expect(prompt).toContain("Высота здания по ТЗ: 12 м");
    expect(prompt).toContain("#1 | Монтаж утеплителя 1 | 56,5 м2 | норма ГЭСН 26-01-041-01");
    expect(prompt).toContain("#2 | Монтаж утеплителя 2");
  });

  it("расход уходит в журнал с видом работы estimate_implied, закупкой и заданием расчёта", async () => {
    await POST(request(body([item("1")], { jobId: "sync-77" })));
    expect(chat.mock.calls[0]?.[2]).toEqual({ purpose: "estimate_implied", tenderId: "0134300025826000377", jobId: "sync-77" });
  });

  it("расчёт по присланным файлам («без номера») пишется без закупки", async () => {
    await POST(request(body([item("1")], { regNumber: "без номера" })));
    expect(chat.mock.calls[0]?.[2]).toEqual({ purpose: "estimate_implied", tenderId: null, jobId: null });
  });

  it("модель: TENDERFIT_IMPLIED_MODEL, затем TENDERFIT_NORM_PICK_MODEL, затем по умолчанию", async () => {
    await POST(request(body([item("1")])));
    expect(chat.mock.calls[0]?.[3]).toEqual({ timeoutMs: 90_000 });

    vi.stubEnv("TENDERFIT_NORM_PICK_MODEL", "google/gemini-2.5-pro");
    await POST(request(body([item("1")])));
    expect(chat.mock.calls[1]?.[3]).toEqual({ model: "google/gemini-2.5-pro", timeoutMs: 90_000 });

    vi.stubEnv("TENDERFIT_IMPLIED_MODEL", "anthropic/claude-sonnet");
    await POST(request(body([item("1")])));
    expect(chat.mock.calls[2]?.[3]).toEqual({ model: "anthropic/claude-sonnet", timeoutMs: 90_000 });
  });

  it("без секрета воркера — 403, с чужим — 403; модель не зовётся", async () => {
    expect((await POST(request(body([item("1")]), {}))).status).toBe(403);
    expect((await POST(request(body([item("1")]), { "x-worker-secret": "wrong-secret" }))).status).toBe(403);
    expect(chat).not.toHaveBeenCalled();
  });

  it("секрет у приложения не задан — ручка закрыта (503), а не открыта", async () => {
    const saved = process.env["TENDERFIT_WORKER_SECRET"];
    delete process.env["TENDERFIT_WORKER_SECRET"];
    try {
      expect((await POST(request(body([item("1")])))).status).toBe(503);
    } finally {
      process.env["TENDERFIT_WORKER_SECRET"] = saved;
    }
    expect(chat).not.toHaveBeenCalled();
  });

  it("позиций 81 — 400; пусто — 400; повторяющиеся идентификаторы — 400", async () => {
    const many = Array.from({ length: 81 }, (_, index) => item(String(index + 1)));
    expect((await POST(request(body(many)))).status).toBe(400);
    expect((await POST(request(body([])))).status).toBe(400);
    const dup = await POST(request(body([item("1"), item("1")])));
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { error: string }).error).toContain("повторяются");
    expect(chat).not.toHaveBeenCalled();
  });

  it("не JSON — 400; слишком большой запрос — 413; без facts — 400", async () => {
    const broken = new NextRequest("http://localhost/api/estimate/implied-works", { method: "POST", body: "{не json", headers: { "Content-Type": "application/json", "x-worker-secret": SECRET } });
    expect((await POST(broken)).status).toBe(400);
    expect((await POST(request(body([item("1")]), { "x-worker-secret": SECRET, "content-length": "9000000" }))).status).toBe(413);
    expect((await POST(request({ regNumber: "R", subject: "s", items: [item("1")] }))).status).toBe(400);
    expect(chat).not.toHaveBeenCalled();
  });

  it("длинный предмет закупки обрезается, а не роняет расчёт", async () => {
    const response = await POST(request(body([item("1")], { subject: "Выполнение работ ".repeat(200) })));
    expect(response.status).toBe(200);
    expect((chat.mock.calls[0]?.[0] as string).includes("Выполнение работ ".repeat(70))).toBe(false);
  });

  it("модель вернула не JSON — 502 с причиной: воркер оставит ведомость как есть", async () => {
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

  it("категория вне белого списка и кривой элемент считаются, остальные доезжают", async () => {
    chat.mockResolvedValueOnce({ content: JSON.stringify({ additions: [ADDITION, { ...ADDITION, category: "DEMOLITION" }, "мусор"] }), tokens: 5 });
    const answer = (await (await POST(request(body([item("1"), item("2")])))).json()) as { additions: unknown[]; malformed: number };
    expect(answer.additions).toHaveLength(1);
    expect(answer.malformed).toBe(2);
  });
});
