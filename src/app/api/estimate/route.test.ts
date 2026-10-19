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
    findById: vi.fn(),
    findActiveEstimate: vi.fn(),
    findLatestEstimate: vi.fn(),
    create: vi.fn(),
  },
}));

import { rememberRequestEmail } from "@/app/api/auth/requestUser";
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
    expect(repo.findActiveEstimate).toHaveBeenCalledWith("t1", "audit", "ui");
    expect(repo.create).toHaveBeenCalledWith("estimate", expect.objectContaining({ tenderId: "t1", mode: "audit" }), "ui");
  });

  it("расчёт сметы режим в payload не пишет: задание совпадает с поставленными до появления аудита", async () => {
    await POST(post({ tenderId: "t1" }));
    await POST(post({ tenderId: "t1", mode: "estimate" }));

    for (const call of repo.create.mock.calls) {
      expect(call[1]).not.toHaveProperty("mode");
    }
    expect(repo.findActiveEstimate).toHaveBeenNthCalledWith(1, "t1", "estimate", "ui");
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
    expect(repo.findLatestEstimate).toHaveBeenLastCalledWith("t1", "audit", "ui");
    const body = (await audit.json()) as { job: { mode: string; audit: unknown; estimate: unknown } };
    expect(body.job.mode).toBe("audit");
    expect(body.job.audit).toEqual({ reports: [], period: "3 квартал 2026 г." });
    expect(body.job.estimate).toBeNull();

    await GET(new NextRequest("http://localhost/api/estimate?tenderId=t1"));
    expect(repo.findLatestEstimate).toHaveBeenLastCalledWith("t1", "estimate", "ui");
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


/*
  Расчёт принадлежит тому, кто его поставил (20.10.2026). До этого GET ?jobId= отдавал любое задание по
  номеру, а GET ?tenderId= — последнюю смету закупки от кого угодно: смета одного пользователя открывалась
  у всех на карточке закупки. Теперь: свой — отдаётся, чужой — как несуществующий, администратор читает
  любое по номеру, служебный запрос (почты нет) — тоже.
*/
describe("владелец расчёта: /api/estimate", () => {
  const job = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "job-9",
      kind: "estimate",
      status: "completed",
      created_at: "2026-10-20T10:00:00Z",
      finished_at: "2026-10-20T10:03:00Z",
      error: null,
      requested_by: "anna@firma.ru",
      payload: { subject: "Объект Анны", reason: "upload", documents: [{ name: "ТЗ.docx", text: "СЕКРЕТНЫЙ ТЕКСТ" }] },
      report: { estimate: { document: { totals: { total: 1 } } } },
      ...overrides,
    }) as never;

  function as(email: string | null, url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
    const request = new NextRequest(url, init);
    rememberRequestEmail(request, email);
    return request;
  }

  const getJob = (email: string | null, id = "job-9") => GET(as(email, `http://localhost/api/estimate?jobId=${id}`));
  const postJson = (email: string | null, body: unknown) =>
    POST(as(email, "http://localhost/api/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  it("свой расчёт по номеру отдаётся — без текстов присланных документов, но с именами файлов", async () => {
    repo.findById.mockResolvedValue(job());

    const response = await getJob("anna@firma.ru");
    const body = (await response.json()) as { job: { id: string; subject: string; documentNames: string[] } };

    expect(body.job.id).toBe("job-9");
    expect(body.job.subject).toBe("Объект Анны");
    expect(body.job.documentNames).toEqual(["ТЗ.docx"]);
    expect(JSON.stringify(body)).not.toContain("СЕКРЕТНЫЙ ТЕКСТ");
  });

  it("чужой расчёт по номеру — {job: null}, как несуществующий: наличие не выдаётся", async () => {
    repo.findById.mockResolvedValue(job());

    const foreign = await getJob("boris@firma.ru");
    repo.findById.mockResolvedValue(null);
    const missing = await getJob("boris@firma.ru");

    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ job: null });
    expect(await missing.json()).toEqual({ job: null });
  });

  it("почта сравнивается без учёта регистра и пробелов в базе", async () => {
    repo.findById.mockResolvedValue(job({ requested_by: " Anna@Firma.ru " }));
    expect(((await (await getJob("anna@firma.ru")).json()) as { job: unknown }).job).not.toBeNull();
  });

  it("задание не расчёта сметы (другой вид очереди) по этой ручке не отдаётся никому", async () => {
    repo.findById.mockResolvedValue(job({ kind: "full_sync", requested_by: "anna@firma.ru" }));
    expect(await (await getJob("anna@firma.ru")).json()).toEqual({ job: null });
  });

  it("администратор (ADMIN_EMAILS) читает чужой расчёт по номеру — по ссылке из письма о сбое", async () => {
    vi.stubEnv("ADMIN_EMAILS", "owner@tender-fit.ru");
    repo.findById.mockResolvedValue(job());

    const body = (await (await getJob("owner@tender-fit.ru")).json()) as { job: { id: string } | null };
    expect(body.job?.id).toBe("job-9");
  });

  it("служебный запрос без почты (воркер, ключ владельца, режим разработки) читает любое по номеру", async () => {
    repo.findById.mockResolvedValue(job());
    expect(((await (await getJob(null)).json()) as { job: { id: string } | null }).job?.id).toBe("job-9");
  });

  it("последняя смета закупки ищется среди расчётов самого пользователя — и у администратора тоже", async () => {
    vi.stubEnv("ADMIN_EMAILS", "owner@tender-fit.ru");
    repo.findLatestEstimate.mockResolvedValue(null);

    await GET(as("anna@firma.ru", "http://localhost/api/estimate?tenderId=t1"));
    expect(repo.findLatestEstimate).toHaveBeenLastCalledWith("t1", "estimate", "anna@firma.ru");

    await GET(as("owner@tender-fit.ru", "http://localhost/api/estimate?tenderId=t1&mode=audit"));
    expect(repo.findLatestEstimate).toHaveBeenLastCalledWith("t1", "audit", "owner@tender-fit.ru");
  });

  it("идущий расчёт закупки подхватывается только свой: чужой не склеивается с нажатием другого человека", async () => {
    repo.findActiveEstimate.mockResolvedValue(null);

    const response = await postJson("boris@firma.ru", { tenderId: "t1" });

    expect(repo.findActiveEstimate).toHaveBeenCalledWith("t1", "estimate", "boris@firma.ru");
    expect(((await response.json()) as { reused: boolean }).reused).toBe(false);
    expect(repo.create).toHaveBeenCalledWith("estimate", expect.anything(), "boris@firma.ru");
  });

  it("загруженные файлы: в payload пишутся имена отдельным полем, чтобы список не читал тексты", async () => {
    await postJson("anna@firma.ru", {
      subject: "Объект",
      documents: [
        { name: "ТЗ.docx", text: "текст 1" },
        { name: "Ведомость.xlsx", text: "текст 2" },
      ],
    });

    const payload = repo.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload["documentNames"]).toEqual(["ТЗ.docx", "Ведомость.xlsx"]);
    expect(payload["reason"]).toBe("upload");
    expect(repo.findActiveEstimate).not.toHaveBeenCalled();
  });

  it("расчёт по закупке имён файлов в payload не пишет", async () => {
    await postJson("anna@firma.ru", { tenderId: "t1" });
    expect(repo.create.mock.calls[0]?.[1]).not.toHaveProperty("documentNames");
  });
});
