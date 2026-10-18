import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_REG_NUMBERS_PER_JOB } from "@/domain/syncJobRequest";
import {
  SyncJobRequestError,
  enqueueSyncJob,
  enqueueWithStatus,
  queueDocumentsAfterSearch,
  queueDocumentsForAnalysis,
  readWorkerStatus,
} from "./syncJobService";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import type { SyncJobRow } from "@/types/database";

/*
  Очередь заданий — это деньги и время партнёра: задание, которое потерялось или
  выполнилось дважды, видно в ленте и в счёте. Тесты проверяют состав запросов к
  репозиторию, а не только возвращаемые значения, и отдельно — что сбой очереди
  не ломает уже оплаченный поиск.

  Репозиторий подменён целиком: его собственные тесты проверяют SQL-цепочки, а
  здесь важно, какие именно вызовы делает сервис.
*/
vi.mock("@/repositories/syncJobRepository", () => ({
  syncJobRepository: {
    findRecent: vi.fn(),
    create: vi.fn(),
    status: vi.fn(),
    readHeartbeat: vi.fn(),
    countPending: vi.fn(),
  },
}));

const NOW = "2026-09-25T03:00:00.000Z";

function jobRow(overrides: Partial<SyncJobRow> = {}): SyncJobRow {
  return {
    id: "job-1",
    kind: "documents",
    status: "pending",
    payload: { regNumbers: ["32616407955"], reason: "press" },
    requested_by: null,
    attempts: 0,
    worker_id: null,
    claimed_at: null,
    finished_at: null,
    report: null,
    error: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/**
 * Пульс живого сервера: отметка свежая, выход российский.
 *
 * Отметки строятся от настоящих часов, а не от зашитого момента. Сервис читает
 * `new Date()` сам и параметром время не принимает, поэтому зашитая отметка
 * устаревала через 15 минут после написания теста, и домен честно отвечал
 * `stale`: тест падал сам по себе, без сломавшегося кода. Порог «пропал»
 * проверяют тесты домена, куда время передаётся параметром, — здесь важно
 * только то, что пульс и очередь собираются в подпись.
 */
function heartbeat(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  return {
    worker_id: "ru-vps",
    last_seen_at: new Date(now).toISOString(),
    last_full_sync_at: new Date(now - 58 * 60_000).toISOString(),
    exit_ip: "95.167.245.92",
    exit_country: "RU",
    host: "vps-1",
    version: "2026-09-25",
    last_job_id: null,
    last_error: null,
    created_at: NOW,
    ...overrides,
  };
}

const findRecent = vi.mocked(syncJobRepository.findRecent);
const create = vi.mocked(syncJobRepository.create);
const status = vi.mocked(syncJobRepository.status);

describe("enqueueSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findRecent.mockResolvedValue([]);
    create.mockResolvedValue(jobRow());
    status.mockResolvedValue({ heartbeat: heartbeat(), lastJob: null, pending: 0 });
  });

  it("создаёт задание с тем видом, номерами и причиной, что пришли в запросе", async () => {
    const enqueued = await enqueueSyncJob({
      kind: "documents",
      regNumbers: [" 32616407955 ", "32616407955", "0173100009825000001"],
      reason: "manual",
      requestedBy: "partner@example.test",
    });

    expect(enqueued.deduped).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    // Повторы и пробелы убирает домен: воркер иначе качал бы один файл дважды.
    expect(create).toHaveBeenCalledWith(
      "documents",
      { regNumbers: ["32616407955", "0173100009825000001"], reason: "manual" },
      "partner@example.test",
    );
  });

  it("равное активное задание переиспользуется, а не плодится", async () => {
    findRecent.mockResolvedValue([
      jobRow({ id: "job-old", status: "processing" }),
      jobRow({ id: "job-done", status: "completed" }),
    ]);

    const enqueued = await enqueueSyncJob({
      kind: "documents",
      regNumbers: ["32616407955"],
      reason: "press",
    });

    expect(enqueued.job.id).toBe("job-old");
    expect(enqueued.deduped).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("неверное тело отклоняется до обращения к базе", async () => {
    await expect(enqueueSyncJob({ kind: "documents", regNumbers: [] })).rejects.toBeInstanceOf(
      SyncJobRequestError,
    );
    await expect(enqueueSyncJob({ kind: "documents", regNumbers: [] })).rejects.toThrow(
      "Не указано ни одного номера закупки",
    );
    expect(findRecent).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("ошибка базы пробрасывается: роут обязан ответить 503 с причиной", async () => {
    create.mockRejectedValue({ message: "connection refused", code: "PGRST205" });

    await expect(
      enqueueSyncJob({ kind: "documents", regNumbers: ["1"] }),
    ).rejects.toMatchObject({ code: "PGRST205" });
  });

  /*
    Флаг платной карточки обязан дойти до базы: воркер читает только `payload`,
    и потерянный флаг означал бы, что партнёр нажал «купить карточку», а
    документация не появилась — при том, что запрос мог быть оплачен.
  */
  it("платное задание несёт флаг карточки в payload", async () => {
    await enqueueSyncJob({
      kind: "documents",
      regNumbers: ["RH24092600035"],
      reason: "kontur-card",
      konturCards: true,
    });

    expect(create).toHaveBeenCalledWith(
      "documents",
      { regNumbers: ["RH24092600035"], reason: "kontur-card", konturCards: true },
      null,
    );
  });

  it("бесплатное задание не получает флага: старые задания читаются как бесплатные", async () => {
    await enqueueSyncJob({ kind: "documents", regNumbers: ["32616407955"] });

    const payload = create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect("konturCards" in payload).toBe(false);
  });
});

describe("queueDocumentsAfterSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findRecent.mockResolvedValue([]);
    create.mockResolvedValue(jobRow({ id: "docs-job" }));
  });

  it("ставит документацию найденных закупок с причиной «press»", async () => {
    const outcome = await queueDocumentsAfterSearch(["32616407955", "0173100009825000001"]);

    expect(outcome).toEqual({
      queued: 2,
      jobId: "docs-job",
      deduped: false,
      error: null,
    });
    expect(create).toHaveBeenCalledWith(
      "documents",
      { regNumbers: ["32616407955", "0173100009825000001"], reason: "press" },
      null,
    );
  });

  it("пустой список не создаёт задания и не читает базу", async () => {
    const outcome = await queueDocumentsAfterSearch([]);

    expect(outcome).toEqual({ queued: 0, jobId: null, deduped: false, error: null });
    expect(findRecent).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  /*
    Поиск уже оплачен и закупки уже сохранены. Если бы сбой очереди (миграция не
    применена, Supabase не отвечает) пробрасывался наружу, роут ответил бы 500 и
    партнёр потерял бы результат платного прогона вместе с объяснением.
  */
  it("сбой очереди не ломает прогон и возвращается текстом причины", async () => {
    create.mockRejectedValue({
      message: "Could not find the table 'public.sync_jobs' in the schema cache",
      code: "PGRST205",
    });

    const outcome = await queueDocumentsAfterSearch(["32616407955"]);

    expect(outcome.jobId).toBeNull();
    expect(outcome.queued).toBe(0);
    expect(outcome.error).toContain("Could not find the table 'public.sync_jobs'");
    expect(outcome.error).toContain("PGRST205");
  });

  it("перебор номеров показывается как причина, а не режется молча", async () => {
    const tooMany = Array.from({ length: MAX_REG_NUMBERS_PER_JOB + 1 }, (_, i) => `n${i}`);

    const outcome = await queueDocumentsAfterSearch(tooMany);

    expect(outcome.jobId).toBeNull();
    expect(outcome.error).toContain("Слишком много номеров в одном задании");
    expect(create).not.toHaveBeenCalled();
  });

  it("повторная постановка того же набора переиспользует задание", async () => {
    findRecent.mockResolvedValue([jobRow({ id: "docs-job-old" })]);

    const outcome = await queueDocumentsAfterSearch(["32616407955"]);

    expect(outcome).toEqual({
      queued: 1,
      jobId: "docs-job-old",
      deduped: true,
      error: null,
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("readWorkerStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.mockResolvedValue({ heartbeat: heartbeat(), lastJob: null, pending: 2 });
  });

  afterEach(() => {
    delete process.env.SYNC_WORKER_ID;
  });

  it("подпись собирается в домене и показывает очередь", async () => {
    const snapshot = await readWorkerStatus();

    expect(snapshot.workerId).toBe("ru-vps");
    expect(snapshot.view.state).toBe("online");
    expect(snapshot.view.hint).toContain("В очереди заданий: 2.");
    expect(status).toHaveBeenCalledWith("ru-vps");
  });

  it("имя сервера берётся из окружения", async () => {
    process.env.SYNC_WORKER_ID = "home-pc";

    const snapshot = await readWorkerStatus();

    expect(snapshot.workerId).toBe("home-pc");
    expect(status).toHaveBeenCalledWith("home-pc");
  });

  it("без пульса подпись говорит, что сервер не запущен", async () => {
    status.mockResolvedValue({ heartbeat: null, lastJob: null, pending: 0 });

    const snapshot = await readWorkerStatus();

    expect(snapshot.view.state).toBe("unknown");
    expect(snapshot.view.label).toBe("Сервер в России ещё не выходил на связь");
  });
});

describe("enqueueWithStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findRecent.mockResolvedValue([]);
    create.mockResolvedValue(jobRow());
    status.mockResolvedValue({ heartbeat: heartbeat(), lastJob: null, pending: 1 });
  });

  it("возвращает задание и подпись сервера одним ответом", async () => {
    const result = await enqueueWithStatus({ kind: "full_sync" });

    expect(result.deduped).toBe(false);
    expect(result.job.id).toBe("job-1");
    expect(result.view.state).toBe("online");
  });
});

describe("почта вошедшего в задании (журнал /admin/users)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findRecent.mockResolvedValue([]);
    create.mockResolvedValue(jobRow());
    status.mockResolvedValue({ heartbeat: heartbeat(), lastJob: null, pending: 0 });
  });

  it("почта роута сильнее requestedBy из тела: клиент не может записать задание на чужого", async () => {
    await enqueueSyncJob(
      { kind: "full_sync", reason: "press", requestedBy: "чужой@почта.ru" },
      { requestedBy: "ivan@firma.ru" },
    );

    expect(create).toHaveBeenCalledWith("full_sync", expect.anything(), "ivan@firma.ru");
  });

  it("без почты роута (служебный ключ) остаётся requestedBy из тела, как раньше", async () => {
    await enqueueSyncJob({ kind: "full_sync", reason: "press", requestedBy: "worker" }, { requestedBy: null });
    await enqueueWithStatus({ kind: "full_sync", reason: "press" });

    expect(create).toHaveBeenNthCalledWith(1, "full_sync", expect.anything(), "worker");
    expect(create).toHaveBeenNthCalledWith(2, "full_sync", expect.anything(), null);
  });

  it("enqueueWithStatus передаёт почту дальше", async () => {
    await enqueueWithStatus({ kind: "full_sync", reason: "press" }, { requestedBy: "ivan@firma.ru" });

    expect(create).toHaveBeenCalledWith("full_sync", expect.anything(), "ivan@firma.ru");
  });

  it("загрузка документации под глубокий анализ записывается на того, кто нажал кнопку", async () => {
    await queueDocumentsForAnalysis("0123", "ivan@firma.ru");
    await queueDocumentsForAnalysis("0124");

    expect(create).toHaveBeenNthCalledWith(1, "documents", expect.objectContaining({ analyze: true }), "ivan@firma.ru");
    expect(create).toHaveBeenNthCalledWith(2, "documents", expect.objectContaining({ analyze: true }), null);
  });
});
