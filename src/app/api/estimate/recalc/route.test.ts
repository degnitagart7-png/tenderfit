import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Доступ проверяет requireAccess (его правила — в access.routes.test.ts); здесь ручка ведёт себя как для вошедшего.
vi.mock("@/app/api/auth/requireAccess", () => ({ requireAccess: vi.fn(async () => null) }));

import { anchorOf, type BillEdit } from "@/domain/estimate/billEdits";
import type { SyncJobRow } from "@/types/database";
import { RIGHT_NORM, buildEditResult, makeEditBase, modelCalls } from "@/test/billEditFixtures";

const findById = vi.fn();
const loadBase = vi.fn();
const extract = vi.fn();
const fetchRows = vi.fn();
const logUsage = vi.fn();

vi.mock("@/repositories/syncJobRepository", () => ({
  syncJobRepository: { findById: (...args: unknown[]) => findById(...args) },
}));
vi.mock("@/repositories/estimateBaseRepository", async () => {
  const actual = await vi.importActual<typeof import("@/repositories/estimateBaseRepository")>("@/repositories/estimateBaseRepository");
  return {
    ...actual,
    loadEstimateBase: (...args: unknown[]) => loadBase(...args),
    loadZoneAuditPrices: async () => null,
    loadZoneAutoServices: async () => null,
  };
});
// Всё, что стоит денег: извлечение ведомости моделью и журнал расхода. На пути пересчёта их нет.
vi.mock("@/services/billOfWorkExtraction", async () => {
  const actual = await vi.importActual<typeof import("@/services/billOfWorkExtraction")>("@/services/billOfWorkExtraction");
  // Вызовы пишутся и пропускаются дальше: расчёт-основа для задания строится настоящим кодом, а счётчики сбрасываются перед пересчётом.
  return {
    ...actual,
    extractBillOfWork: (...args: Parameters<typeof actual.extractBillOfWork>) => {
      extract(...args);
      return actual.extractBillOfWork(...args);
    },
    fetchBillRows: (...args: Parameters<typeof actual.fetchBillRows>) => {
      fetchRows(...args);
      return actual.fetchBillRows(...args);
    },
  };
});
vi.mock("@/repositories/llmUsageRepository", () => ({
  llmUsageRepository: { insert: (...args: unknown[]) => logUsage(...args), record: (...args: unknown[]) => logUsage(...args) },
}));

import { rememberRequestEmail } from "@/app/api/auth/requestUser";
import { POST } from "@/app/api/estimate/recalc/route";

let counter = 0;
const globalFetch = vi.fn();

function post(body: unknown, raw?: string): NextRequest {
  counter += 1;
  return new NextRequest("http://localhost/api/estimate/recalc", {
    method: "POST",
    headers: { "x-real-ip": `10.8.0.${String(counter)}` },
    body: raw ?? JSON.stringify(body),
  });
}

async function completedJob(id: string): Promise<{ job: SyncJobRow; walls: string }> {
  const result = await buildEditResult(makeEditBase());
  const walls = result.bill.sections.flatMap((section) => section.items).find((item) => item.workName === "Демонтаж наружных стен");
  const job = {
    id,
    kind: "estimate",
    status: "completed",
    payload: { tenderId: "0123" },
    report: {
      estimate: {
        document: result.document,
        rejected: [],
        documentsWithoutBill: [],
        billItems: result.billItems,
        tokensUsed: 100,
        bill: result.bill,
      },
    },
  } as unknown as SyncJobRow;
  return { job, walls: walls?.id ?? "" };
}

beforeEach(() => {
  vi.stubGlobal("fetch", globalFetch);
  findById.mockReset();
  loadBase.mockReset();
  extract.mockReset();
  fetchRows.mockReset();
  logUsage.mockReset();
  globalFetch.mockReset();
  loadBase.mockResolvedValue(makeEditBase());
});

describe("POST /api/estimate/recalc", () => {
  it("правки на входе — документ сметы на выходе; модель не вызывается, расход ИИ ноль", async () => {
    const { job, walls } = await completedJob("job-a");
    findById.mockResolvedValue(job);
    const calls = modelCalls.count;
    extract.mockClear();
    const edit: BillEdit = {
      kind: "norm",
      anchor: { itemId: walls, workName: "Демонтаж наружных стен", quantity: 120, unit: "м2", positionNumber: null, normCode: null, section: null },
      norm: { code: RIGHT_NORM.code, baseType: RIGHT_NORM.baseType },
    };

    const response = await POST(post({ jobId: "job-a", edits: [edit] }));
    const body = (await response.json()) as {
      document: { sections: { lines: { itemId: string; normCode: string }[] }[]; totals: { workCost: number } };
      tokensUsed: number;
      applied: { count: number };
    };

    expect(response.status).toBe(200);
    expect(body.document.sections.flatMap((section) => section.lines).find((line) => line.itemId === walls)?.normCode).toBe(RIGHT_NORM.code);
    expect(body.tokensUsed).toBe(0);
    expect(body.applied.count).toBe(1);
    // Ни извлечения, ни запросов к шлюзу, ни записи в llm_usage_log, ни сетевых вызовов вообще.
    expect(extract).not.toHaveBeenCalled();
    expect(fetchRows).not.toHaveBeenCalled();
    expect(logUsage).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(modelCalls.count).toBe(calls);
  });

  it("пустой список правок — тот же итог, что у расчёта", async () => {
    const { job } = await completedJob("job-b");
    findById.mockResolvedValue(job);

    const body = (await (await POST(post({ jobId: "job-b", edits: [] }))).json()) as { document: { totals: unknown } };
    expect(body.document.totals).toEqual((job.report?.estimate?.document as { totals: unknown }).totals);
  });

  it("отчёт задания читается из базы один раз: следующие пересчёты идут из кэша", async () => {
    const { job } = await completedJob("job-c");
    findById.mockResolvedValue(job);

    await POST(post({ jobId: "job-c", edits: [] }));
    await POST(post({ jobId: "job-c", edits: [] }));
    expect(findById).toHaveBeenCalledTimes(1);
  });

  it("задания нет — 404; ещё считается — 409", async () => {
    findById.mockResolvedValueOnce(null);
    expect((await POST(post({ jobId: "нет", edits: [] }))).status).toBe(404);

    const { job } = await completedJob("job-d");
    findById.mockResolvedValueOnce({ ...job, id: "job-d2", status: "processing" });
    expect((await POST(post({ jobId: "job-d2", edits: [] }))).status).toBe(409);
  });

  it("смета без записи ведомости (посчитана старым воркером) — 409 с понятной причиной", async () => {
    const { job } = await completedJob("job-e");
    const estimate = { ...(job.report?.estimate as object), bill: undefined };
    findById.mockResolvedValue({ ...job, id: "job-e", report: { estimate } });

    const response = await POST(post({ jobId: "job-e", edits: [] }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/до появления правок/);
  });

  it("цены зоны обновились после расчёта — 409, а не смешанный уровень", async () => {
    const { job } = await completedJob("job-f");
    findById.mockResolvedValue(job);
    const fresh = makeEditBase();
    loadBase.mockResolvedValue({ ...fresh, priceBook: { ...fresh.priceBook, period: "4 квартал 2026 г." } });

    const response = await POST(post({ jobId: "job-f", edits: [] }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/Цены обновились/);
  });

  it("мусор вместо правок — 400; не JSON — 400; слишком много — 413", async () => {
    expect((await POST(post({ jobId: "x", edits: [{ kind: "price", unitPrice: -1 }] }))).status).toBe(400);
    expect((await POST(post(null, "это не json"))).status).toBe(400);
    expect((await POST(post({ jobId: "x" }))).status).toBe(400);
    expect((await POST(post(null, "x".repeat(1_000_001)))).status).toBe(413);
  });

  it("базы норм на сервере нет — 503", async () => {
    const { job } = await completedJob("job-g");
    findById.mockResolvedValue(job);
    loadBase.mockRejectedValue(new Error("нет norms.jsonl"));
    const response = await POST(post({ jobId: "job-g", edits: [] }));
    expect(response.status).toBe(503);
  });

  it("ответ укладывается в секунды: пересчёт на готовой базе — доли секунды", async () => {
    const { job, walls } = await completedJob("job-h");
    findById.mockResolvedValue(job);
    const item = job.report?.estimate?.bill as { sections: { items: Parameters<typeof anchorOf>[0][] }[] };
    const wallsItem = item.sections.flatMap((section) => section.items).find((candidate) => candidate.id === walls);
    const started = Date.now();
    await POST(post({ jobId: "job-h", edits: [{ kind: "price", anchor: anchorOf(wallsItem as Parameters<typeof anchorOf>[0]), unitPrice: 100 }] }));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/*
  Пересчёт — только своего расчёта: ведомость и цены чужого — его смета. Владелец проверяется на каждом
  запросе, и когда отчёт взят из кэша тоже: кэш ключуется номером задания.
*/
describe("POST /api/estimate/recalc: владелец расчёта", () => {
  function postAs(email: string | null, jobId: string): NextRequest {
    const request = post({ jobId, edits: [] });
    rememberRequestEmail(request, email);
    return request;
  }

  it("свой расчёт пересчитывается; чужой — 404 как несуществующий", async () => {
    const { job } = await completedJob("job-own-1");
    findById.mockResolvedValue({ ...job, requested_by: "anna@firma.ru" });

    expect((await POST(postAs("anna@firma.ru", "job-own-1"))).status).toBe(200);

    const { job: other } = await completedJob("job-own-2");
    findById.mockResolvedValue({ ...other, requested_by: "anna@firma.ru" });
    const foreign = await POST(postAs("boris@firma.ru", "job-own-2"));
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: string }).error).toBe("Расчёт не найден");
  });

  it("отчёт в кэше чужого не спасает: второй запрос другого человека по тому же номеру — тоже 404", async () => {
    const { job } = await completedJob("job-own-3");
    findById.mockResolvedValue({ ...job, requested_by: "anna@firma.ru" });

    expect((await POST(postAs("anna@firma.ru", "job-own-3"))).status).toBe(200);
    // Отчёт теперь в кэше; в базу второй запрос не идёт, но владелец сверяется всё равно.
    findById.mockClear();
    expect((await POST(postAs("boris@firma.ru", "job-own-3"))).status).toBe(404);
    expect(findById).not.toHaveBeenCalled();
    // И владелец по-прежнему получает ответ из кэша.
    expect((await POST(postAs("anna@firma.ru", "job-own-3"))).status).toBe(200);
  });

  it("администратор пересчитывает любой; служебный запрос без почты — тоже", async () => {
    vi.stubEnv("ADMIN_EMAILS", "owner@tender-fit.ru");
    const { job } = await completedJob("job-own-4");
    findById.mockResolvedValue({ ...job, requested_by: "anna@firma.ru" });

    expect((await POST(postAs("owner@tender-fit.ru", "job-own-4"))).status).toBe(200);
    expect((await POST(postAs(null, "job-own-4"))).status).toBe(200);
    vi.unstubAllEnvs();
  });
});
