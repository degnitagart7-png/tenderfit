import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Доступ проверяет requireAccess (его правила — в access.routes.test.ts); здесь ручка ведёт себя как для вошедшего.
vi.mock("@/app/api/auth/requireAccess", () => ({ requireAccess: vi.fn(async () => null) }));

vi.mock("@/repositories/syncJobRepository", () => ({
  syncJobRepository: {
    readHeartbeat: vi.fn(),
    findActiveLive: vi.fn(),
    findRecentLive: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock("@/services/searchAssistService", () => ({
  searchAssist: { expand: vi.fn() },
}));

import { GET, POST } from "@/app/api/search/live/route";
import { searchAssist } from "@/services/searchAssistService";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import type { SyncJobRow, WorkerHeartbeatRow } from "@/types/database";

/**
 * Ручка живого поиска.
 *
 * За каждым запросом стоит прогон по чужим площадкам на несколько минут, а
 * ручка открыта без входа. Поэтому: лимит на адрес, чистка запроса, один
 * прогон за раз, повтор не плодит задания, а при устаревшем воркере задание не
 * ставится вовсе — старый воркер не знает режима живого поиска и выполнил бы
 * вместо него полный плановый прогон со всеми побочными эффектами.
 */

const repo = vi.mocked(syncJobRepository);

let counter = 0;
function post(body: unknown): NextRequest {
  counter += 1;
  return new NextRequest("http://localhost/api/search/live", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": `10.1.0.${String(counter)}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function heartbeat(over: Partial<WorkerHeartbeatRow> = {}): WorkerHeartbeatRow {
  return {
    worker_id: "ru-vps",
    last_seen_at: new Date().toISOString(),
    last_full_sync_at: null,
    exit_ip: null,
    exit_country: "RU",
    host: null,
    version: "2026-10-05 10:00",
    last_job_id: null,
    last_error: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function job(over: Partial<SyncJobRow> = {}): SyncJobRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "full_sync",
    status: "pending",
    payload: { liveQuery: "юридические услуги" },
    report: null,
    requested_by: "live-search",
    error: null,
    attempts: 0,
    created_at: "2026-10-04T18:00:00.000Z",
    claimed_at: null,
    finished_at: null,
    ...over,
  } as SyncJobRow;
}

beforeEach(() => {
  for (const fn of Object.values(repo)) (fn as ReturnType<typeof vi.fn>).mockReset();
  repo.readHeartbeat.mockResolvedValue(heartbeat());
  repo.findActiveLive.mockResolvedValue(null);
  repo.findRecentLive.mockResolvedValue(null);
  repo.create.mockResolvedValue(job());
  vi.mocked(searchAssist.expand).mockReset();
  vi.mocked(searchAssist.expand).mockResolvedValue({ synonyms: [], cached: false, tokens: 0 });
});

describe("POST /api/search/live", () => {
  it("ставит задание с очищенным запросом", async () => {
    const response = await POST(post({ query: '  юридические   "услуги" ' }));

    expect(response.status).toBe(200);
    expect(repo.create).toHaveBeenCalledWith(
      "full_sync",
      expect.objectContaining({ liveQuery: "юридические услуги" }),
      expect.any(String),
    );
    expect(await response.json()).toMatchObject({ status: "pending" });
  });

  it("регионы запроса чистятся и уходят в задание", async () => {
    await POST(post({ query: "строительство", regions: ["  Республика   Бурятия ", "<Москва>", "Республика Бурятия"] }));

    expect(repo.create).toHaveBeenCalledWith(
      "full_sync",
      expect.objectContaining({ liveQuery: "строительство", liveRegions: ["Республика Бурятия", "Москва"] }),
      expect.any(String),
    );
  });

  it("без регионов в задании нет поля liveRegions: поиск по всей России", async () => {
    await POST(post({ query: "строительство" }));

    const payload = repo.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("liveRegions");
  });

  it("тот же запрос по другому региону не подхватывает чужой прогон и не берёт его из кэша", async () => {
    repo.findActiveLive.mockResolvedValue(job({ payload: { liveQuery: "строительство", liveRegions: ["Москва"] } }));

    const response = await POST(post({ query: "строительство", regions: ["Республика Бурятия"] }));

    expect(response.status).toBe(429);
    expect(repo.create).not.toHaveBeenCalled();
  });

  /*
    Близкие слова. «Строительство» одним словом даёт единицы, а заказчик пишет
    «ремонт» и «реконструкция». Модель предлагает формулировки, и задание
    несёт их воркеру. Сбой модели поиск не останавливает: он идёт по запросу.
  */
  it("близкие слова от модели уходят в задание (не больше трёх, без повторов запроса)", async () => {
    vi.mocked(searchAssist.expand).mockResolvedValue({
      synonyms: ["строительство", "ремонт зданий", "реконструкция", "Капитальный ремонт", "благоустройство"],
      cached: false,
      tokens: 0,
    });

    await POST(post({ query: "строительство" }));

    expect(repo.create).toHaveBeenCalledWith(
      "full_sync",
      expect.objectContaining({ liveKeywords: ["ремонт зданий", "реконструкция", "Капитальный ремонт"] }),
      expect.any(String),
    );
  });

  it("свои слова человека идут в задание вместо подбора моделью", async () => {
    await POST(post({ query: "ремонт кровли", keywords: ["фасадные работы", "ремонт кровли"] }));

    expect(searchAssist.expand).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledWith(
      "full_sync",
      expect.objectContaining({ liveQuery: "ремонт кровли", liveKeywords: ["фасадные работы"] }),
      expect.any(String),
    );
  });

  it("модель недоступна — задание ставится без близких слов, ответ 200", async () => {
    vi.mocked(searchAssist.expand).mockRejectedValue(new Error("шлюз недоступен"));

    const response = await POST(post({ query: "строительство" }));

    expect(response.status).toBe(200);
    const payload = repo.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("liveKeywords");
  });

  it("модель отвечает слишком долго — не ждём: поиск идёт по запросу", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(searchAssist.expand).mockReturnValue(new Promise(() => undefined));

      const pending = POST(post({ query: "строительство" }));
      await vi.advanceTimersByTimeAsync(20_000);
      const response = await pending;

      expect(response.status).toBe(200);
      expect(repo.create).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("повтор запроса не зовёт модель: задание уже идёт", async () => {
    repo.findActiveLive.mockResolvedValue(job({ payload: { liveQuery: "строительство" } }));

    await POST(post({ query: "строительство" }));

    expect(searchAssist.expand).not.toHaveBeenCalled();
  });

  it("слишком короткий запрос — 400, задание не ставится", async () => {
    const response = await POST(post({ query: "а" }));

    expect(response.status).toBe(400);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("не JSON — 400", async () => {
    expect((await POST(post("не json"))).status).toBe(400);
  });

  it("воркер ни разу не выходил на связь — 503", async () => {
    repo.readHeartbeat.mockResolvedValue(null);

    const response = await POST(post({ query: "юридические услуги" }));

    expect(response.status).toBe(503);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("воркер с устаревшим кодом — 503: он выполнил бы полный прогон вместо поиска", async () => {
    repo.readHeartbeat.mockResolvedValue(heartbeat({ version: "2026-10-01 10:00" }));

    const response = await POST(post({ query: "юридические услуги" }));

    expect(response.status).toBe(503);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("воркер давно не отвечал — 503: задание зависло бы в очереди", async () => {
    repo.readHeartbeat.mockResolvedValue(
      heartbeat({ last_seen_at: new Date(Date.now() - 60 * 60_000).toISOString() }),
    );

    expect((await POST(post({ query: "юридические услуги" }))).status).toBe(503);
  });

  it("тот же запрос уже выполняется — возвращается то же задание", async () => {
    repo.findActiveLive.mockResolvedValue(job({ status: "processing" }));

    const response = await POST(post({ query: "юридические услуги" }));
    const body = await response.json();

    expect(repo.create).not.toHaveBeenCalled();
    expect(body).toMatchObject({ jobId: "11111111-1111-4111-8111-111111111111", reused: true });
  });

  it("выполняется чужой запрос — 429 с объяснением", async () => {
    repo.findActiveLive.mockResolvedValue(
      job({ status: "processing", payload: { liveQuery: "охрана объектов" } }),
    );

    const response = await POST(post({ query: "юридические услуги" }));

    expect(response.status).toBe(429);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("недавно выполненный запрос не повторяется", async () => {
    repo.findRecentLive.mockResolvedValue(
      job({ status: "completed", finished_at: new Date(Date.now() - 5 * 60_000).toISOString() }),
    );

    const body = await (await POST(post({ query: "юридические услуги" }))).json();

    expect(repo.create).not.toHaveBeenCalled();
    expect(body).toMatchObject({ status: "completed", cached: true });
  });

  it("сверх лимита с одного адреса — 429", async () => {
    let last = 200;
    for (let i = 0; i < 10; i += 1) {
      const request = new NextRequest("http://localhost/api/search/live", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-real-ip": "198.51.100.9" },
        body: JSON.stringify({ query: "юристы" }),
      });
      last = (await POST(request)).status;
      if (last === 429) break;
    }

    expect(last).toBe(429);
  });
});

describe("GET /api/search/live", () => {
  const url = (id: string) => new NextRequest(`http://localhost/api/search/live?jobId=${id}`);

  it("возвращает состояние задания", async () => {
    repo.findById.mockResolvedValue(
      job({ status: "completed", report: { note: "Готово: 40 сохранено" } }),
    );

    const response = await GET(url("11111111-1111-4111-8111-111111111111"));

    expect(await response.json()).toMatchObject({ status: "completed", note: "Готово: 40 сохранено" });
  });

  it("не отдаёт чужие задания: только живой поиск", async () => {
    repo.findById.mockResolvedValue(job({ payload: { tenderId: "x" } }));

    const response = await GET(url("11111111-1111-4111-8111-111111111111"));

    expect(response.status).toBe(404);
  });

  it("не uuid — 400, в базу не идём", async () => {
    const response = await GET(url("не-идентификатор"));

    expect(response.status).toBe(400);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("текст ошибки задания наружу не отдаётся", async () => {
    repo.findById.mockResolvedValue(
      job({ status: "failed", error: "ECONNRESET db.internal.example:5432" }),
    );

    const body = await (await GET(url("11111111-1111-4111-8111-111111111111"))).json();

    expect(JSON.stringify(body)).not.toContain("db.internal");
    expect(body.status).toBe("failed");
  });
});
