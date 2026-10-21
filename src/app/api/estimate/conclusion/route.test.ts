import JSZip from "jszip";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Доступ проверяет requireAccess (его правила — в access.routes.test.ts); здесь ручка ведёт себя как для вошедшего.
vi.mock("@/app/api/auth/requireAccess", () => ({ requireAccess: vi.fn(async () => null) }));
vi.mock("@/repositories/syncJobRepository", () => ({ syncJobRepository: { findById: vi.fn() } }));
vi.mock("@/repositories/tenderRepository", () => ({ tenderRepository: { findById: vi.fn(), findByRegNumber: vi.fn() } }));

import { rememberRequestEmail } from "@/app/api/auth/requestUser";
import { GET } from "@/app/api/estimate/conclusion/route";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import { tenderRepository } from "@/repositories/tenderRepository";
import { auditData, reportMatching, reportWithFindings } from "@/test/auditReports";

/*
  «Заключение по смете заказчика» файлом Word: правила доступа те же, что у GET /api/estimate?jobId=, — свой видит свой,
  администратор и служебный запрос — любой, чужой неотличим от несуществующего (один и тот же 404).
*/

const repo = vi.mocked(syncJobRepository);

function job(overrides: Record<string, unknown> = {}) {
  const audit = auditData([reportWithFindings(), reportMatching()]);
  return {
    id: "job-7",
    kind: "estimate",
    status: "completed",
    requested_by: "anna@firma.ru",
    payload: { mode: "audit", subject: "Ремонт школы", tenderId: "0302300048726001118", documentNames: ["Смета.xlsx"], documents: [{ name: "Смета.xlsx", text: "СЕКРЕТНЫЙ ТЕКСТ" }] },
    report: { audit: { reports: audit.reports, zone: audit.zone, period: audit.period, notRecognized: audit.notRecognized } },
    ...overrides,
  } as never;
}

function as(email: string | null, query = "jobId=job-7"): NextRequest {
  const request = new NextRequest(`http://localhost/api/estimate/conclusion?${query}`);
  rememberRequestEmail(request, email);
  return request;
}

const tenders = vi.mocked(tenderRepository);

beforeEach(() => {
  repo.findById.mockResolvedValue(job());
  tenders.findById.mockResolvedValue(null);
  tenders.findByRegNumber.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function textOf(response: Response): Promise<string> {
  const zip = await JSZip.loadAsync(new Uint8Array(await response.arrayBuffer()));
  return (await zip.file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("GET /api/estimate/conclusion: владелец", () => {
  it("свою проверку владелец получает файлом Word с именем и типом", async () => {
    const response = await GET(as("anna@firma.ru"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? "")).toMatch(/^Заключение по смете .* от \d{4}-\d{2}-\d{2}\.docx$/);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const text = await textOf(response);
    expect(text).toContain("Заключение по смете заказчика");
    expect(text).toContain("Ремонт школы");
    expect(text).toContain("0302300048726001118");
    // Тексты присланных документов в файл не попадают.
    expect(text).not.toContain("СЕКРЕТНЫЙ ТЕКСТ");
  });

  it("чужую проверку не отдаёт: тот же 404, что и для несуществующей", async () => {
    const foreign = await GET(as("boris@firma.ru"));
    repo.findById.mockResolvedValue(null);
    const missing = await GET(as("boris@firma.ru"));

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it("почта сравнивается без учёта регистра и пробелов в базе", async () => {
    repo.findById.mockResolvedValue(job({ requested_by: " Anna@Firma.ru " }));
    expect((await GET(as("anna@firma.ru"))).status).toBe(200);
  });

  it("администратор (ADMIN_EMAILS) читает чужую проверку; служебный запрос без почты — любую", async () => {
    vi.stubEnv("ADMIN_EMAILS", "owner@tender-fit.ru");
    expect((await GET(as("owner@tender-fit.ru"))).status).toBe(200);
    expect((await GET(as(null))).status).toBe(200);
  });

  it("задание не проверки сметы (расчёт по ведомости, другой вид очереди) заключения не имеет — 404 даже владельцу", async () => {
    repo.findById.mockResolvedValue(job({ payload: { subject: "Расчёт" } }));
    expect((await GET(as("anna@firma.ru"))).status).toBe(404);
    repo.findById.mockResolvedValue(job({ kind: "full_sync" }));
    expect((await GET(as("anna@firma.ru"))).status).toBe(404);
  });
});

describe("GET /api/estimate/conclusion: объект в шапке", () => {
  it("в задании вместо названия номер закупки — предмет берётся из закупки", async () => {
    repo.findById.mockResolvedValue(job({ payload: { mode: "audit", subject: "0302300083426000012", tenderId: "t-1", documentNames: ["Смета.xlsx"] } }));
    tenders.findById.mockResolvedValue({ subject: "Капитальный ремонт лыжной базы", reg_number: "0302300083426000012" } as never);

    const text = await textOf(await GET(as("anna@firma.ru")));

    expect(text).toContain("Объект Капитальный ремонт лыжной базы");
    expect(text).toContain("Закупка № 0302300083426000012");
  });

  it("в задании есть настоящее название — берётся оно, базу не спрашивают", async () => {
    await GET(as("anna@firma.ru"));
    expect(tenders.findById).not.toHaveBeenCalled();
  });

  it("закупка не нашлась или база молчит — файл всё равно собирается", async () => {
    repo.findById.mockResolvedValue(job({ payload: { mode: "audit", subject: "0302300083426000012", tenderId: "t-1" } }));
    tenders.findById.mockRejectedValue(new Error("база"));
    expect((await GET(as("anna@firma.ru"))).status).toBe(200);
  });
});

describe("GET /api/estimate/conclusion: состояния", () => {
  it("без номера — 400", async () => {
    expect((await GET(as("anna@firma.ru", ""))).status).toBe(400);
  });

  it("проверка ещё не закончена — 409 с объяснением, а не пустой файл", async () => {
    repo.findById.mockResolvedValue(job({ status: "processing", report: null }));
    const response = await GET(as("anna@firma.ru"));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("ещё не закончена");
  });

  it("в проверке нет ни одной сметы — 409", async () => {
    const empty = auditData([]);
    repo.findById.mockResolvedValue(job({ report: { audit: { reports: [], zone: empty.zone, period: empty.period, notRecognized: [] } } }));
    expect((await GET(as("anna@firma.ru"))).status).toBe(409);
  });

  it("номер сметы в проверке: вторая смета — свой файл; несуществующий номер — 409", async () => {
    expect((await GET(as("anna@firma.ru", "jobId=job-7&report=1"))).status).toBe(200);
    expect((await GET(as("anna@firma.ru", "jobId=job-7&report=5"))).status).toBe(409);
  });

  it("report=all: одно заключение по всем сметам со своим именем файла", async () => {
    const response = await GET(as("anna@firma.ru", "jobId=job-7&report=all"));

    expect(response.status).toBe(200);
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? "")).toMatch(/^Заключение по всем сметам от \d{4}-\d{2}-\d{2}\.docx$/);
    const text = await textOf(response);
    expect(text).toContain("Заключение по всем сметам заказчика");
    expect(text).toContain("Итого по всем сметам (2)");
  });

  it("report=all у чужой проверки — тот же 404; без смет — 409", async () => {
    expect((await GET(as("boris@firma.ru", "jobId=job-7&report=all"))).status).toBe(404);
    const empty = auditData([]);
    repo.findById.mockResolvedValue(job({ report: { audit: { reports: [], zone: empty.zone, period: empty.period, notRecognized: [] } } }));
    expect((await GET(as("anna@firma.ru", "jobId=job-7&report=all"))).status).toBe(409);
  });

  it("сбой базы — 500 с текстом, без падения ручки", async () => {
    repo.findById.mockRejectedValue(new Error("база недоступна"));
    const response = await GET(as("anna@firma.ru"));
    expect(response.status).toBe(500);
  });
});
