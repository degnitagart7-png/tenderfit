import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Доступ проверяет requireAccess (его правила — в access.routes.test.ts); здесь ручка ведёт себя как для вошедшего.
vi.mock("@/app/api/auth/requireAccess", () => ({ requireAccess: vi.fn(async () => null) }));
vi.mock("@/repositories/syncJobRepository", () => ({
  syncJobRepository: { listEstimateHistory: vi.fn() },
}));

import { rememberRequestEmail } from "@/app/api/auth/requestUser";
import { GET } from "@/app/api/estimate/history/route";
import type { EstimateHistoryItem } from "@/domain/estimate/estimateHistory";
import { syncJobRepository } from "@/repositories/syncJobRepository";

/*
  «Мои расчёты»: страницы от нового к старому, только расчёты самого пользователя. Страница читается
  на одну строку больше, чтобы узнать, есть ли следующая; курсор — время постановки последней показанной.
*/

const repo = vi.mocked(syncJobRepository);

function item(n: number): EstimateHistoryItem {
  return {
    id: `job-${String(n)}`,
    status: "completed",
    // Чем больше номер, тем новее: список приходит от нового к старому, то есть от большего номера к меньшему.
    createdAt: `2026-10-20T10:${String(n).padStart(2, "0")}:00.123456+00:00`,
    finishedAt: null,
    mode: "estimate",
    reason: "upload",
    tenderId: null,
    subject: `Объект ${String(n)}`,
    documentNames: ["ТЗ.docx"],
    totalRub: 1000 * n,
    error: null,
  };
}

function request(query = "", email: string | null = "anna@firma.ru"): NextRequest {
  const req = new NextRequest(`http://localhost/api/estimate/history${query}`);
  rememberRequestEmail(req, email);
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.listEstimateHistory.mockResolvedValue([]);
});

describe("GET /api/estimate/history", () => {
  it("запрашивает расчёты именно того, кто вошёл, по умолчанию 20 на страницу (плюс одна на «есть ли ещё»)", async () => {
    await GET(request("", "Anna@Firma.ru"));

    // Почта в нижнем регистре — её записывает requestUser; в базе по ней и ищется.
    expect(repo.listEstimateHistory).toHaveBeenCalledWith("anna@firma.ru", { limit: 21, before: null });
  });

  it("служебный запрос без почты видит задания с меткой «ui»", async () => {
    await GET(request("", null));
    expect(repo.listEstimateHistory).toHaveBeenCalledWith("ui", { limit: 21, before: null });
  });

  it("администратор тоже видит только свои: чужие открываются по номеру", async () => {
    vi.stubEnv("ADMIN_EMAILS", "owner@tender-fit.ru");
    await GET(request("", "owner@tender-fit.ru"));
    expect(repo.listEstimateHistory).toHaveBeenCalledWith("owner@tender-fit.ru", expect.anything());
    vi.unstubAllEnvs();
  });

  it("строк не больше страницы — nextCursor null", async () => {
    repo.listEstimateHistory.mockResolvedValue([item(3), item(2), item(1)]);

    const body = (await (await GET(request("?limit=5"))).json()) as { items: { id: string }[]; nextCursor: string | null };

    expect(body.items.map((entry) => entry.id)).toEqual(["job-3", "job-2", "job-1"]);
    expect(body.nextCursor).toBeNull();
  });

  it("строк больше страницы — лишняя отрезается, курсор — время последней показанной (с микросекундами)", async () => {
    repo.listEstimateHistory.mockResolvedValue([item(5), item(4), item(3)]);

    const body = (await (await GET(request("?limit=2"))).json()) as { items: { id: string }[]; nextCursor: string | null };

    expect(repo.listEstimateHistory).toHaveBeenCalledWith("anna@firma.ru", { limit: 3, before: null });
    expect(body.items.map((entry) => entry.id)).toEqual(["job-5", "job-4"]);
    expect(body.nextCursor).toBe("2026-10-20T10:04:00.123456+00:00");
  });

  it("следующая страница: курсор уходит в запрос как before; плюс в смещении пояса, ставший пробелом, чинится", async () => {
    await GET(request("?before=2026-10-20T10:04:00.123456%2B00:00"));
    expect(repo.listEstimateHistory).toHaveBeenLastCalledWith("anna@firma.ru", { limit: 21, before: "2026-10-20T10:04:00.123456+00:00" });

    await GET(request("?before=2026-10-20T10:04:00.123456 00:00"));
    expect(repo.listEstimateHistory).toHaveBeenLastCalledWith("anna@firma.ru", { limit: 21, before: "2026-10-20T10:04:00.123456+00:00" });
  });

  it("постраничный обход отдаёт всё без повторов и пропусков", async () => {
    const all = [5, 4, 3, 2, 1].map(item);
    repo.listEstimateHistory.mockImplementation(async (_owner, options) =>
      all.filter((entry) => options.before === undefined || options.before === null || entry.createdAt < options.before).slice(0, options.limit),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 5; guard += 1) {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&before=${encodeURIComponent(cursor)}`;
      const body = (await (await GET(request(query))).json()) as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...body.items.map((entry) => entry.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual(["job-5", "job-4", "job-3", "job-2", "job-1"]);
  });

  it("limit ограничен: не меньше 1 и не больше 50; мусор — значение по умолчанию", async () => {
    await GET(request("?limit=1000"));
    expect(repo.listEstimateHistory).toHaveBeenLastCalledWith("anna@firma.ru", { limit: 51, before: null });
    await GET(request("?limit=0"));
    expect(repo.listEstimateHistory).toHaveBeenLastCalledWith("anna@firma.ru", { limit: 2, before: null });
    await GET(request("?limit=abc"));
    expect(repo.listEstimateHistory).toHaveBeenLastCalledWith("anna@firma.ru", { limit: 21, before: null });
  });

  it("курсор не времени — 400, в базу запрос не уходит", async () => {
    for (const bad of ["abc", "2026-10-20", "'; drop table sync_jobs; --", "2026-10-20T10:00:00Z)or(id.neq.0"]) {
      const response = await GET(request(`?before=${encodeURIComponent(bad)}`));
      expect(response.status).toBe(400);
    }
    expect(repo.listEstimateHistory).not.toHaveBeenCalled();
  });

  it("в ответе нет текстов документов и самой сметы: только поля строки списка", async () => {
    // Репозиторий отдаёт лёгкие записи; ручка не добавляет к ним ничего, кроме курсора.
    repo.listEstimateHistory.mockResolvedValue([item(1)]);
    const body = (await (await GET(request())).json()) as { items: Record<string, unknown>[] };
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(
      ["createdAt", "documentNames", "error", "finishedAt", "id", "mode", "reason", "status", "subject", "tenderId", "totalRub"].sort(),
    );
  });

  it("сбой базы — 500 с причиной, не пустой список", async () => {
    repo.listEstimateHistory.mockRejectedValue(new Error("база недоступна"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain("база недоступна");
  });
});
