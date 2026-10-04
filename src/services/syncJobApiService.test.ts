import { afterEach, describe, expect, it, vi } from "vitest";
import { syncJobApiService } from "@/services/syncJobApiService";
import type { RedactedSyncJob } from "@/domain/syncJobRedaction";
import type { WorkerStatusView } from "@/domain/workerStatus";

/*
  Очередь заданий проверяется на заглушке fetch: тесты не ходят в сеть
  (правило проекта), а форма запроса и разбора ошибки здесь и есть поведение
  сервиса. Ошибка роута обязана дойти до интерфейса текстом, а не статусом:
  панель печатает её как есть, и «HTTP 503» вместо «примените миграцию» лишил
  бы владельца способа понять, что чинить.
*/

function job(overrides: Partial<RedactedSyncJob> = {}): RedactedSyncJob {
  return {
    id: "job-full-1",
    kind: "full_sync",
    status: "pending",
    payload: { regNumbers: [], reason: "press" },
    requested_by: null,
    attempts: 0,
    worker_id: null,
    claimed_at: null,
    finished_at: null,
    report: null,
    error: null,
    created_at: "2026-10-03T21:30:00.000Z",
    updated_at: "2026-10-03T21:30:00.000Z",
    ...overrides,
  };
}

function view(overrides: Partial<WorkerStatusView> = {}): WorkerStatusView {
  return {
    state: "online",
    label: "Сервер в России на связи 2 мин назад",
    hint: "Выход из России (95.167.245.92).",
    minutesSinceSeen: 2,
    pending: 1,
    exitIp: "95.167.245.92",
    lastError: null,
    ...overrides,
  };
}

/** Заглушка fetch, которая запоминает запрос и отдаёт заданный ответ. */
function stubFetch(response: { ok: boolean; status: number; body: unknown; json?: boolean }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => {
        if (response.json === false) throw new Error("Тело не JSON");
        return response.body;
      },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("syncJobApiService.enqueueFullSync", () => {
  it("ставит плановый прогон от имени кнопки и возвращает задание с подписью сервера", async () => {
    const calls = stubFetch({
      ok: true,
      status: 201,
      body: { job: job(), deduped: false, view: view() },
    });

    const result = await syncJobApiService.enqueueFullSync();

    expect(result.deduped).toBe(false);
    expect(result.job.id).toBe("job-full-1");
    expect(result.view.label).toBe("Сервер в России на связи 2 мин назад");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/sync-jobs");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      kind: "full_sync",
      reason: "press",
    });
  });

  it("повторное нажатие возвращает прежнее задание, и это видно панели", async () => {
    stubFetch({
      ok: true,
      status: 200,
      body: { job: job({ status: "processing" }), deduped: true, view: view() },
    });

    const result = await syncJobApiService.enqueueFullSync();

    // Без этого флага панель сказала бы «прогон поставлен в очередь» про задание,
    // которое уже выполняется, и партнёр ждал бы второй прогон.
    expect(result.deduped).toBe(true);
    expect(result.job.status).toBe("processing");
  });

  it("отказ роута доходит текстом причины из ответа", async () => {
    stubFetch({
      ok: false,
      status: 503,
      body: { error: "Очередь заданий не настроена: примените миграцию" },
    });

    await expect(syncJobApiService.enqueueFullSync()).rejects.toThrow(
      "Очередь заданий не настроена: примените миграцию",
    );
  });

  it("ответ не JSON — партнёр видит статус, а не пустую причину", async () => {
    stubFetch({ ok: false, status: 502, body: null, json: false });

    await expect(syncJobApiService.enqueueFullSync()).rejects.toThrow(
      "Прогон не поставлен в очередь: HTTP 502",
    );
  });
});
