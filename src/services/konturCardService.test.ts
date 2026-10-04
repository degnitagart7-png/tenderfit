import { beforeEach, describe, expect, it, vi } from "vitest";
import { buyKonturCard, readKonturCardStatus } from "./konturCardService";
import { tenderRepository } from "@/repositories/tenderRepository";
import { documentRepository } from "@/repositories/documentRepository";
import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { konturCacheRepository } from "@/repositories/konturCacheRepository";
import { enqueueSyncJob } from "@/services/syncJobService";
import { hasKonturApiKey, resolveKonturContract } from "@/adapters/tender-source/konturContract";
import type { AnalysisJobRow, SyncJobRow, TenderRow } from "@/types/database";

/*
  Явная покупка карточки Контур.Закупок — единственное место в приложении, где
  нажатие кнопки тратит платный запрос источника и оплачивает разбор моделью.
  Поэтому тесты проверяют не только возвращаемые значения, но и состав вызовов:
  при отказе не должно быть ни задания в очереди, ни задачи разбора.

  Сеть и база подменены целиком — по правилам проекта тесты в сеть не ходят.
*/
vi.mock("@/repositories/tenderRepository", () => ({
  tenderRepository: { findByRegNumber: vi.fn() },
}));
vi.mock("@/repositories/documentRepository", () => ({
  documentRepository: { findByTenderId: vi.fn() },
}));
vi.mock("@/repositories/analysisJobRepository", () => ({
  analysisJobRepository: {
    findByTenderId: vi.fn(),
    countCreatedSince: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("@/repositories/konturCacheRepository", () => ({
  konturCacheRepository: { billableCallsToday: vi.fn() },
}));
vi.mock("@/services/syncJobService", () => ({
  enqueueSyncJob: vi.fn(),
  SyncJobRequestError: class SyncJobRequestError extends Error {},
}));
vi.mock("@/adapters/tender-source/konturContract", () => ({
  resolveKonturContract: vi.fn(),
  hasKonturApiKey: vi.fn(),
}));

const REG_NUMBER = "RH24092600035";
const NOW = "2026-09-25T15:00:00.000Z";

/**
 * Живая закупка, из-за которой появился платный путь: Контур.Закупки, закон
 * COMMERCIAL, ЕИС вкладку документов не публикует.
 */
function tenderRow(overrides: Partial<TenderRow> = {}): TenderRow {
  return {
    id: "tender-1",
    reg_number: REG_NUMBER,
    external_id: "IS76922341",
    law: "COMMERCIAL",
    placing_way: "OTHER",
    subject: "Поставка оборудования",
    customer_name: "АО «ДГК»",
    customer_inn: "2723088888",
    region: "Хабаровский край",
    delivery_address: null,
    price: 1_500_000,
    currency: "RUB",
    advance_payment: null,
    security_bid: null,
    security_contract: null,
    submission_end: "2026-10-05T10:00:00.000Z",
    publication_date: "2026-09-24",
    last_update_date: "2026-09-25",
    delivery_term_days: null,
    delivery_date_end: null,
    okpd2_codes: null,
    lots: null,
    requirements: null,
    national_regime: false,
    only_for_smp: false,
    eis_url: null,
    data_source: "KONTUR",
    change_log: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function analysisJob(overrides: Partial<AnalysisJobRow> = {}): AnalysisJobRow {
  return {
    id: "job-analysis-1",
    tender_id: REG_NUMBER,
    job_type: "full_analysis",
    status: "pending",
    priority: 0,
    documents_total: 0,
    documents_processed: 0,
    error_message: null,
    started_at: null,
    finished_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const findByRegNumber = vi.mocked(tenderRepository.findByRegNumber);
const findDocuments = vi.mocked(documentRepository.findByTenderId);
const findAnalysisJobs = vi.mocked(analysisJobRepository.findByTenderId);
const countCreatedSince = vi.mocked(analysisJobRepository.countCreatedSince);
const createAnalysisJob = vi.mocked(analysisJobRepository.create);
const billableCallsToday = vi.mocked(konturCacheRepository.billableCallsToday);
const enqueue = vi.mocked(enqueueSyncJob);
const configured = vi.mocked(hasKonturApiKey);
const resolveContract = vi.mocked(resolveKonturContract);

/** Исход, в котором покупка разрешена: коммерческая закупка без документов. */
function arrangeAllowed(): void {
  findByRegNumber.mockResolvedValue(tenderRow());
  findDocuments.mockResolvedValue([]);
  findAnalysisJobs.mockResolvedValue([]);
  countCreatedSince.mockResolvedValue(5);
  billableCallsToday.mockResolvedValue({ search: 1, card: 2 });
  configured.mockReturnValue(true);
  // Контракт целиком не нужен: признак ключа задаёт подмена `hasKonturApiKey`,
  // а поля путей сервис не читает.
  resolveContract.mockReturnValue({ apiKey: "test-key" } as ReturnType<typeof resolveKonturContract>);
  createAnalysisJob.mockResolvedValue(analysisJob());
  enqueue.mockResolvedValue({ job: { id: "job-docs-1" } as SyncJobRow, deduped: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["KONTUR_DAILY_REQUEST_LIMIT"];
});

describe("readKonturCardStatus", () => {
  it("коммерческой закупке без документов карточку покупать можно", async () => {
    arrangeAllowed();

    const status = await readKonturCardStatus(REG_NUMBER);

    expect(status).toMatchObject({
      show: true,
      allowed: true,
      refusalKind: null,
      cardSpentToday: 2,
      cardLimit: 30,
      // 20 разборов в сутки, 5 уже поставлено.
      analysisRemaining: 15,
    });
    expect(status?.budgetNote).toBe("Карточек Контур.Закупок сегодня: 2 из 30, осталось 28");
  });

  it("закупки нет в базе — статус не выдуман", async () => {
    findByRegNumber.mockResolvedValue(null);

    expect(await readKonturCardStatus(REG_NUMBER)).toBeNull();
    expect(billableCallsToday).not.toHaveBeenCalled();
  });

  it("закупке 44-ФЗ блок не показывается: документацию ЕИС отдаёт бесплатно", async () => {
    arrangeAllowed();
    findByRegNumber.mockResolvedValue(tenderRow({ law: "FZ_44" }));

    const status = await readKonturCardStatus(REG_NUMBER);

    expect(status).toMatchObject({ show: false, allowed: false });
  });

  it("ключ на сервере не задан — блок виден с причиной", async () => {
    arrangeAllowed();
    configured.mockReturnValue(false);

    const status = await readKonturCardStatus(REG_NUMBER);

    expect(status).toMatchObject({ show: true, allowed: false, refusalKind: "config" });
    expect(status?.reason).toMatch(/ключ/i);
  });

  it("предел карточек берётся из настройки, а не из зашитой тридцатки", async () => {
    arrangeAllowed();
    process.env["KONTUR_DAILY_REQUEST_LIMIT"] = "10";

    const status = await readKonturCardStatus(REG_NUMBER);

    expect(status).toMatchObject({ cardLimit: 10, allowed: true });
    expect(status?.budgetNote).toBe("Карточек Контур.Закупок сегодня: 2 из 10, осталось 8");
  });

  /*
    Задача разбора на эту закупку уже стоит: новый слот лимита не нужен, поэтому
    исчерпанные 20 разборов не блокируют покупку. Иначе партнёр, который утром
    перевёл карточку в «Интересное», не смог бы докупить документацию вечером.
  */
  it("задача разбора уже в очереди — лимит разборов покупку не блокирует", async () => {
    arrangeAllowed();
    countCreatedSince.mockResolvedValue(20);
    findAnalysisJobs.mockResolvedValue([analysisJob()]);

    const status = await readKonturCardStatus(REG_NUMBER);

    expect(status).toMatchObject({ allowed: true, analysisRemaining: null });
  });

  it("свободных разборов нет и задачи нет — блок отказывает до траты", async () => {
    arrangeAllowed();
    countCreatedSince.mockResolvedValue(20);

    const status = await readKonturCardStatus(REG_NUMBER);

    expect(status).toMatchObject({ allowed: false, refusalKind: "analysis" });
    expect(status?.reason).toMatch(/лимит разборов/i);
  });
});

describe("buyKonturCard", () => {
  it("ставит платное задание на документацию и задачу разбора", async () => {
    arrangeAllowed();

    const result = await buyKonturCard(REG_NUMBER);

    expect(enqueue).toHaveBeenCalledWith({
      kind: "documents",
      regNumbers: [REG_NUMBER],
      reason: "kontur-card",
      konturCards: true,
    });
    // Приоритет тот же, что у явного запуска загрузки рукой: платная закупка
    // важнее фонового накопления очереди.
    expect(createAnalysisJob).toHaveBeenCalledWith(REG_NUMBER, "full_analysis", 10);
    expect(result).toMatchObject({
      status: "queued",
      jobId: "job-docs-1",
      analysisJobId: "job-analysis-1",
      deduped: false,
      warning: null,
    });
  });

  it("отказ не ставит ни задания, ни задачи разбора", async () => {
    arrangeAllowed();
    findByRegNumber.mockResolvedValue(tenderRow({ law: "FZ_44" }));

    const result = await buyKonturCard(REG_NUMBER);

    expect(result.status).toBe("refused");
    expect(enqueue).not.toHaveBeenCalled();
    expect(createAnalysisJob).not.toHaveBeenCalled();
  });

  it("исчерпанный бюджет карточек — отказ 429 с датой следующей попытки", async () => {
    arrangeAllowed();
    billableCallsToday.mockResolvedValue({ search: 0, card: 30 });

    const result = await buyKonturCard(REG_NUMBER);

    expect(result).toMatchObject({ status: "refused", refusalKind: "budget" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("исчерпанный лимит разборов — карточка не покупается", async () => {
    arrangeAllowed();
    countCreatedSince.mockResolvedValue(20);

    const result = await buyKonturCard(REG_NUMBER);

    expect(result).toMatchObject({ status: "refused", refusalKind: "analysis" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(createAnalysisJob).not.toHaveBeenCalled();
  });

  it("закупки нет в базе — отдельный исход, а не отказ с выдуманной причиной", async () => {
    findByRegNumber.mockResolvedValue(null);

    expect(await buyKonturCard(REG_NUMBER)).toEqual({ status: "not_found", regNumber: REG_NUMBER });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("повторное нажатие переиспользует задание и не плодит задачи разбора", async () => {
    arrangeAllowed();
    enqueue.mockResolvedValue({ job: { id: "job-docs-old" } as SyncJobRow, deduped: true });
    findAnalysisJobs.mockResolvedValue([analysisJob({ id: "job-analysis-old" })]);

    const result = await buyKonturCard(REG_NUMBER);

    expect(result).toMatchObject({
      status: "queued",
      jobId: "job-docs-old",
      analysisJobId: "job-analysis-old",
      deduped: true,
    });
    expect(createAnalysisJob).not.toHaveBeenCalled();
  });

  /*
    Задание на документацию уже стоит в очереди — платный запрос будет сделан.
    Потерять из-за этого покупку нельзя: воркер создаст задачу разбора сам,
    когда документация появится, поэтому ответ честный, но с предупреждением.
  */
  it("сбой задачи разбора не отменяет купленное задание", async () => {
    arrangeAllowed();
    createAnalysisJob.mockRejectedValue(new Error("connection refused"));

    const result = await buyKonturCard(REG_NUMBER);

    expect(result).toMatchObject({ status: "queued", jobId: "job-docs-1", analysisJobId: null });
    expect(result.status === "queued" && result.warning).toMatch(/задачу разбора/i);
  });

  it("сбой очереди пробрасывается: роут ответит 503 и карточка не будет куплена", async () => {
    arrangeAllowed();
    enqueue.mockRejectedValue({ message: "connection refused", code: "PGRST205" });

    await expect(buyKonturCard(REG_NUMBER)).rejects.toMatchObject({ code: "PGRST205" });
    expect(createAnalysisJob).not.toHaveBeenCalled();
  });
});
