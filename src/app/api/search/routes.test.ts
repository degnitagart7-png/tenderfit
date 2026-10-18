import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Доступ проверяет requireAccess (его правила — в access.routes.test.ts); здесь ручка ведёт себя как для вошедшего.
vi.mock("@/app/api/auth/requireAccess", () => ({ requireAccess: vi.fn(async () => null) }));

vi.mock("@/services/searchAssistService", () => ({
  searchAssist: {
    expand: vi.fn(),
    rerank: vi.fn(),
  },
}));

import { POST as expandPost } from "@/app/api/search/expand/route";
import { POST as rerankPost } from "@/app/api/search/rerank/route";
import { searchAssist } from "@/services/searchAssistService";

/**
 * Ручки помощника поиска.
 *
 * Открыты без входа, а за каждым обращением стоит платный вызов модели. Поэтому
 * вход проверяется строго (длины, число закупок), а на адрес действует лимит:
 * без него любой, кто узнал бы адрес, получил бы бесплатный доступ к платному
 * шлюзу.
 */

let counter = 0;
/** Каждому тесту — свой адрес: лимит хранится в памяти процесса и общий для файла. */
function post(path: string, body: unknown, ip?: string): NextRequest {
  counter += 1;
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": ip ?? `10.0.0.${String(counter)}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(searchAssist.expand).mockReset();
  vi.mocked(searchAssist.rerank).mockReset();
});

describe("POST /api/search/expand", () => {
  it("возвращает формулировки", async () => {
    vi.mocked(searchAssist.expand).mockResolvedValue({ synonyms: ["юрист"], cached: false, tokens: 90 });

    const response = await expandPost(post("/api/search/expand", { query: "юридические услуги" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ synonyms: ["юрист"], cached: false });
  });

  it("пустой запрос — 400", async () => {
    const response = await expandPost(post("/api/search/expand", { query: "   " }));

    expect(response.status).toBe(400);
    expect(searchAssist.expand).not.toHaveBeenCalled();
  });

  it("слишком длинный запрос — 400: модели не нужны абзацы", async () => {
    const response = await expandPost(post("/api/search/expand", { query: "а".repeat(500) }));

    expect(response.status).toBe(400);
  });

  it("не JSON — 400", async () => {
    const response = await expandPost(post("/api/search/expand", "не json"));

    expect(response.status).toBe(400);
  });

  it("сбой модели — 502, а не 500: сайт цел, недоступен внешний сервис", async () => {
    vi.mocked(searchAssist.expand).mockRejectedValue(new Error("шлюз недоступен"));

    const response = await expandPost(post("/api/search/expand", { query: "юридические услуги" }));

    expect(response.status).toBe(502);
  });

  it("сверх лимита с одного адреса — 429 с подсказкой, когда повторить", async () => {
    vi.mocked(searchAssist.expand).mockResolvedValue({ synonyms: ["юрист"], cached: false, tokens: 1 });
    let last = 200;
    let retryAfter: string | null = null;
    for (let i = 0; i < 40; i += 1) {
      const response = await expandPost(post("/api/search/expand", { query: "юристы" }, "203.0.113.7"));
      last = response.status;
      if (last === 429) {
        retryAfter = response.headers.get("Retry-After");
        break;
      }
    }

    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /api/search/rerank", () => {
  const candidates = [{ id: "t1", subject: "Оказание комплекса юридических услуг" }];

  it("возвращает оценки", async () => {
    vi.mocked(searchAssist.rerank).mockResolvedValue({
      verdicts: { t1: { fit: "yes", reason: "то самое" } },
      cached: false,
      tokens: 400,
    });

    const response = await rerankPost(
      post("/api/search/rerank", { query: "юридические услуги", candidates }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).verdicts.t1.fit).toBe("yes");
  });

  it("пустой список закупок — 400", async () => {
    const response = await rerankPost(
      post("/api/search/rerank", { query: "юридические услуги", candidates: [] }),
    );

    expect(response.status).toBe(400);
  });

  it("больше тридцати закупок — 400: токены растут линейно", async () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ id: `t${String(i)}`, subject: "x" }));

    const response = await rerankPost(post("/api/search/rerank", { query: "q", candidates: many }));

    expect(response.status).toBe(400);
  });

  it("описание компании клиента в модель не уходит (152-ФЗ, с 19.10.2026)", async () => {
    vi.mocked(searchAssist.rerank).mockResolvedValue({ verdicts: {}, cached: false, tokens: 1 });

    await rerankPost(
      post("/api/search/rerank", { query: "q", companyNote: "юридическая фирма", candidates }),
    );

    expect(vi.mocked(searchAssist.rerank).mock.calls[0]?.[0]).not.toHaveProperty("companyNote");
  });

  it("сбой модели — 502", async () => {
    vi.mocked(searchAssist.rerank).mockRejectedValue(new Error("таймаут"));

    const response = await rerankPost(post("/api/search/rerank", { query: "q", candidates }));

    expect(response.status).toBe(502);
  });
});
