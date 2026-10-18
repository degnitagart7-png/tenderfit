import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Доступ проверяет requireAccess (его правила — в access.routes.test.ts); здесь ручка ведёт себя как для вошедшего.
vi.mock("@/app/api/auth/requireAccess", () => ({ requireAccess: vi.fn(async () => null) }));

vi.mock("@/repositories/syncJobRepository", () => ({
  syncJobRepository: {
    readHeartbeat: vi.fn(),
    findActiveEstimate: vi.fn(),
    findLatestEstimate: vi.fn(),
    create: vi.fn(),
  },
}));

import { GET, POST } from "@/app/api/estimate/route";
import { syncJobRepository } from "@/repositories/syncJobRepository";

/*
  Постановка расчёта сметы: ценовая зона, выбранная вручную, проверяется по
  собранным зонам до постановки задания — воркер всё равно упал бы с тем же
  объяснением, но уже после ожидания в очереди.
*/

const repo = vi.mocked(syncJobRepository);
let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "estimate-route-"));
  vi.stubEnv("FSNB_INDEX_DIR", dir);
  await mkdir(join(dir, "zones", "236"), { recursive: true });
  await writeFile(
    join(dir, "zones", "236", "zone.json"),
    JSON.stringify({ priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)", subject: "Республика Бурятия", period: "3 квартал 2026 г." }),
  );
  repo.readHeartbeat.mockResolvedValue({ version: "2026-10-14 22:28" } as never);
  repo.findActiveEstimate.mockResolvedValue(null);
  repo.create.mockResolvedValue({ id: "job-1", status: "pending", created_at: "2026-10-07T00:00:00Z", finished_at: null, error: null, report: null } as never);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/estimate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/estimate: ценовая зона", () => {
  it("собранная зона уходит в payload задания", async () => {
    const response = await POST(post({ tenderId: "t1", subject: "Объект", priceZoneId: 236 }));

    expect(response.status).toBe(200);
    expect(repo.create).toHaveBeenCalledWith("estimate", expect.objectContaining({ tenderId: "t1", priceZoneId: 236 }), "ui");
  });

  it("зона не передана — в payload её нет: воркер определит по закупке", async () => {
    await POST(post({ tenderId: "t1" }));

    const payload = repo.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("priceZoneId");
  });

  it("несобранная зона — 400, задание не ставится", async () => {
    const response = await POST(post({ tenderId: "t1", priceZoneId: 237 }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("Цен по ценовой зоне 237 ещё нет");
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("не число и не целое — 400", async () => {
    expect((await POST(post({ tenderId: "t1", priceZoneId: "236" }))).status).toBe(400);
    expect((await POST(post({ tenderId: "t1", priceZoneId: 236.5 }))).status).toBe(400);
    expect((await POST(post({ tenderId: "t1", priceZoneId: -1 }))).status).toBe(400);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("каталога зон нет вовсе — любая ручная зона отклоняется", async () => {
    vi.stubEnv("FSNB_INDEX_DIR", join(dir, "нет"));
    expect((await POST(post({ tenderId: "t1", priceZoneId: 236 }))).status).toBe(400);
  });
});

describe("режим задания: расчёт сметы и аудит сметы заказчика", () => {
  it("режим audit уходит в payload, а повторное нажатие ищет активное задание именно аудита", async () => {
    const response = await POST(post({ tenderId: "t1", mode: "audit" }));

    expect(response.status).toBe(200);
    expect(repo.findActiveEstimate).toHaveBeenCalledWith("t1", "audit");
    expect(repo.create).toHaveBeenCalledWith("estimate", expect.objectContaining({ tenderId: "t1", mode: "audit" }), "ui");
  });

  it("расчёт сметы режим в payload не пишет: задание совпадает с поставленными до появления аудита", async () => {
    await POST(post({ tenderId: "t1" }));
    await POST(post({ tenderId: "t1", mode: "estimate" }));

    for (const call of repo.create.mock.calls) {
      expect(call[1]).not.toHaveProperty("mode");
    }
    expect(repo.findActiveEstimate).toHaveBeenNthCalledWith(1, "t1", "estimate");
  });

  it("идущий расчёт сметы не блокирует постановку аудита и наоборот", async () => {
    repo.findActiveEstimate.mockImplementation(async (_tenderId, mode) =>
      mode === "estimate" ? ({ id: "job-est", status: "processing", payload: {}, report: null, created_at: "x", finished_at: null, error: null } as never) : null,
    );

    const audit = await POST(post({ tenderId: "t1", mode: "audit" }));
    expect(((await audit.json()) as { reused: boolean }).reused).toBe(false);

    const estimate = await POST(post({ tenderId: "t1" }));
    const body = (await estimate.json()) as { reused: boolean; job: { id: string } };
    expect(body.reused).toBe(true);
    expect(body.job.id).toBe("job-est");
  });

  it("неизвестный режим — 400, задание не ставится", async () => {
    expect((await POST(post({ tenderId: "t1", mode: "magic" }))).status).toBe(400);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("GET ?mode=audit отдаёт последний аудит и его отчёт, по умолчанию — смету", async () => {
    const row = {
      id: "job-a",
      status: "done",
      created_at: "2026-10-07T00:00:00Z",
      finished_at: "2026-10-07T00:01:00Z",
      error: null,
      payload: { tenderId: "t1", mode: "audit" },
      report: { audit: { reports: [], period: "3 квартал 2026 г." } },
    };
    repo.findLatestEstimate.mockResolvedValue(row as never);

    const audit = await GET(new NextRequest("http://localhost/api/estimate?tenderId=t1&mode=audit"));
    expect(repo.findLatestEstimate).toHaveBeenLastCalledWith("t1", "audit");
    const body = (await audit.json()) as { job: { mode: string; audit: unknown; estimate: unknown } };
    expect(body.job.mode).toBe("audit");
    expect(body.job.audit).toEqual({ reports: [], period: "3 квартал 2026 г." });
    expect(body.job.estimate).toBeNull();

    await GET(new NextRequest("http://localhost/api/estimate?tenderId=t1"));
    expect(repo.findLatestEstimate).toHaveBeenLastCalledWith("t1", "estimate");
  });
});

describe("POST /api/estimate: условия работ", () => {
  it("выбор пользователя уходит в payload полем estimateOptions", async () => {
    const response = await POST(
      post({
        tenderId: "t1",
        options: { phase: "CAPITAL_REPAIR", workKind: "CR_RES_BRICK", conditionIds: ["T5-8"], winterWork: "NO", workPeriod: { start: "2026-06-01", end: "2026-08-31" } },
      }),
    );

    expect(response.status).toBe(200);
    const payload = repo.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload["estimateOptions"]).toEqual({
      phase: "CAPITAL_REPAIR",
      workKind: "CR_RES_BRICK",
      conditionIds: ["T5-8"],
      newConstructionNorms: false,
      winterWork: "NO",
      workPeriod: { start: "2026-06-01", end: "2026-08-31" },
      winterPartId: null,
    });
  });

  it("метод расчёта: выбор уходит в payload, «как у заказчика» (null) и пустой выбор — нет; чужой метод — 400", async () => {
    await POST(post({ tenderId: "t1", options: { method: "BASE_INDEX" } }));
    const chosen = repo.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect((chosen["estimateOptions"] as Record<string, unknown>)["method"]).toBe("BASE_INDEX");

    repo.create.mockClear();
    await POST(post({ tenderId: "t2", options: { method: null } }));
    expect(repo.create.mock.calls[0]?.[1]).not.toHaveProperty("estimateOptions");

    expect((await POST(post({ tenderId: "t3", options: { method: "FER" } }))).status).toBe(400);
  });

  it("выбора нет или он пустой — в payload поля нет: задание совпадает с прежними", async () => {
    await POST(post({ tenderId: "t1" }));
    await POST(post({ tenderId: "t2", options: {} }));

    for (const call of repo.create.mock.calls) expect(call[1]).not.toHaveProperty("estimateOptions");
  });

  it("непригодные условия — 400, задание не ставится", async () => {
    expect((await POST(post({ tenderId: "t1", options: { conditionIds: ["drop table"] } }))).status).toBe(400);
    expect((await POST(post({ tenderId: "t1", options: { winterWork: "MAYBE" } }))).status).toBe(400);
    expect((await POST(post({ tenderId: "t1", options: { workPeriod: { start: "01.09.2026", end: null } } }))).status).toBe(400);
    expect(repo.create).not.toHaveBeenCalled();
  });
});
