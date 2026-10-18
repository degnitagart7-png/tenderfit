import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AnalysisJobRow, TenderDocumentRow, VerdictHistoryRow } from "@/types/database";
import { MAX_TOTAL_CHARS_PER_TENDER } from "@/services/tenderAttachmentsFetcher";

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({ from: vi.fn() }),
}));

vi.mock("./documentDownloader", () => ({
  downloadDocument: vi.fn(),
}));

vi.mock("./attachmentParser", async () => {
  const actual = await vi.importActual("./attachmentParser");
  return {
    ...actual,
    parseAttachment: vi.fn(),
  };
});

vi.mock("./llmAnalysis", () => ({
  analyzeDocumentWithLlm: vi.fn(),
}));

// Сводка выводов — отдельный вызов модели; в этих тестах её нет, кроме случая, где она проверяется.
vi.mock("./analysisConsolidationService", async () => {
  const actual = await vi.importActual<typeof import("./analysisConsolidationService")>("./analysisConsolidationService");
  return { ...actual, consolidateAnalysis: vi.fn(async () => null), defaultConsolidationDeps: vi.fn(() => ({})) };
});

vi.mock("@/repositories/documentRepository", () => ({
  documentRepository: {
    findByTenderId: vi.fn(),
    create: vi.fn(),
    updateDownloadStatus: vi.fn(),
    updateParsed: vi.fn(),
    findByContentHash: vi.fn(),
  },
}));

vi.mock("@/repositories/documentAnalysisRepository", () => ({
  documentAnalysisRepository: {
    record: vi.fn(),
    findByTenderId: vi.fn(),
    countByDocumentId: vi.fn(),
  },
}));

vi.mock("@/repositories/analysisJobRepository", () => ({
  analysisJobRepository: {
    claimNextPending: vi.fn(),
    updateStatus: vi.fn(),
    setDocumentsProcessed: vi.fn(),
    setDocumentsTotal: vi.fn(),
  },
}));

vi.mock("@/repositories/verdictHistoryRepository", () => ({
  verdictHistoryRepository: {
    record: vi.fn(),
    findByTenderId: vi.fn(),
  },
}));

vi.mock("@/repositories/tenderRepository", () => ({
  tenderRepository: {
    findByRegNumber: vi.fn(),
  },
}));

const JOB: AnalysisJobRow = {
  id: "job-1",
  tender_id: "0573100026626000009",
  job_type: "full_analysis",
  status: "processing",
  priority: 0,
  documents_total: 0,
  documents_processed: 0,
  error_message: null,
  started_at: null,
  finished_at: null,
  created_at: "2026-09-21T00:00:00Z",
  updated_at: "2026-09-21T00:00:00Z",
};

/** Документ с готовым текстом: так в базу пишет локальный скрипт загрузки. */
function parsedDocument(text: string): TenderDocumentRow {
  return {
    id: "doc-1",
    tender_id: JOB.tender_id,
    source_type: "eis_api",
    filename: "print-form-0573100026626000009.html",
    document_type: "notice",
    file_url: "https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=1",
    raw_json: null,
    file_size: text.length,
    mime_type: "text/html",
    download_status: "downloaded",
    parsed_status: "parsed",
    parsed_text: text,
    parsed_sections: null,
    content_hash: "hash",
    error_message: null,
    created_at: "2026-09-21T00:00:00Z",
    updated_at: "2026-09-21T00:00:00Z",
  };
}

const BLOCKER = {
  category: "blocker" as const,
  title: "Требуется лицензия ФСБ",
  detail: "Участник обязан иметь лицензию на работу со сведениями гостайны.",
  evidence_quote: "наличие лицензии ФСБ России",
  evidence_section: "Требования к участникам",
  severity: "high" as const,
};

/** Документ, от которого в базе есть только ссылка: такие воркер качает сам. */
function linkedDocument(filename = "Проект контракта.pdf"): TenderDocumentRow {
  return {
    ...parsedDocument("ignored"),
    filename,
    parsed_status: "pending",
    parsed_text: null,
    download_status: "pending",
  };
}

/**
 * Строка пропуска: локальный скрипт файл не скачал и записал причину в raw_json.
 * Ссылка в ней настоящая — на ЕИС, которая зарубежные IP не пускает.
 */
function skippedDocument(
  reason = "Файл не уложился в бюджет знаков на закупку.",
): TenderDocumentRow {
  return {
    ...parsedDocument(""),
    id: "doc-2",
    filename: "Проектная документация.zip",
    raw_json: { chars: 0, skipped: { code: "over_char_budget", reason } },
    file_size: 314_572_800,
    download_status: "failed",
    parsed_status: "failed",
    parsed_text: null,
    error_message: reason,
  };
}

async function mocks() {
  const { analysisJobRepository } = await import("@/repositories/analysisJobRepository");
  const { documentRepository } = await import("@/repositories/documentRepository");
  const { documentAnalysisRepository } = await import("@/repositories/documentAnalysisRepository");
  const { verdictHistoryRepository } = await import("@/repositories/verdictHistoryRepository");
  const { tenderRepository } = await import("@/repositories/tenderRepository");
  const { downloadDocument } = await import("./documentDownloader");
  const { parseAttachment } = await import("./attachmentParser");
  const { analyzeDocumentWithLlm } = await import("./llmAnalysis");

  vi.mocked(analysisJobRepository.claimNextPending).mockResolvedValue(JOB);
  vi.mocked(analysisJobRepository.updateStatus).mockResolvedValue(JOB);
  vi.mocked(analysisJobRepository.setDocumentsProcessed).mockResolvedValue(undefined);
  vi.mocked(documentAnalysisRepository.countByDocumentId).mockResolvedValue(0);
  vi.mocked(documentAnalysisRepository.record).mockResolvedValue({ id: "an-1" } as never);
  vi.mocked(documentAnalysisRepository.findByTenderId).mockResolvedValue([]);
  vi.mocked(verdictHistoryRepository.findByTenderId).mockResolvedValue([]);
  vi.mocked(verdictHistoryRepository.record).mockResolvedValue({ id: "vh-1" } as never);
  vi.mocked(tenderRepository.findByRegNumber).mockResolvedValue({
    reg_number: JOB.tender_id,
    subject: "Поставка технических средств",
    customer_name: "ФГУ «Заказчик»",
    price: 1_000_000,
    law: "FZ_44",
  } as never);
  vi.mocked(analyzeDocumentWithLlm).mockResolvedValue({
    findings: [BLOCKER],
    summary: "Найден блокирующий фактор",
    tokensUsed: 500,
    processingTimeMs: 2000,
  });

  return {
    analysisJobRepository,
    documentRepository,
    documentAnalysisRepository,
    verdictHistoryRepository,
    tenderRepository,
    downloadDocument,
    parseAttachment,
    analyzeDocumentWithLlm,
  };
}

describe("processAnalysisJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("разбирает готовый текст и закрывает задачу", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([
      parsedDocument("Текст извещения о закупке"),
    ]);
    vi.mocked(m.documentAnalysisRepository.findByTenderId).mockResolvedValue([
      { analysis: { findings: [BLOCKER], summary: "s" } } as never,
    ]);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(result).toMatchObject({
      jobId: "job-1",
      tenderId: JOB.tender_id,
      documentsProcessed: 1,
      deferred: false,
      findingsTotal: 1,
      verdictChanged: true,
    });
    expect(m.analysisJobRepository.updateStatus).toHaveBeenCalledWith("job-1", "completed");
    // Скачивание не нужно: текст уже в базе.
    expect(m.downloadDocument).not.toHaveBeenCalled();
  });

  it("передаёт модели настоящий контекст закупки, а не имя файла", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([
      parsedDocument("Текст извещения о закупке"),
    ]);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    await processAnalysisJob();

    expect(m.analyzeDocumentWithLlm).toHaveBeenCalledWith(
      expect.objectContaining({
        tenderContext: {
          regNumber: JOB.tender_id,
          subject: "Поставка технических средств",
          customerName: "ФГУ «Заказчик»",
          price: 1_000_000,
          // Закон нужен промпту, чтобы отличать норму закона от отклонения.
          law: "FZ_44",
        },
      }),
    );
  });

  it("пишет изменение вердикта в историю от последнего известного вердикта", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([
      parsedDocument("Текст извещения о закупке"),
    ]);
    vi.mocked(m.documentAnalysisRepository.findByTenderId).mockResolvedValue([
      { analysis: { findings: [BLOCKER], summary: "s" } } as never,
    ]);
    // История уже есть: findByTenderId отдаёт записи от новых к старым.
    vi.mocked(m.verdictHistoryRepository.findByTenderId).mockResolvedValue([
      { new_verdict: "MANUAL_REVIEW" } as VerdictHistoryRow,
    ]);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    await processAnalysisJob();

    expect(m.verdictHistoryRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tender_id: JOB.tender_id,
        old_verdict: "MANUAL_REVIEW",
        new_verdict: "NOT_RECOMMENDED",
        old_score: null,
        new_score: null,
        triggered_by: "document_analysis",
      }),
    );
  });

  it("вердикт строится по сводке: СРО при НМЦК до 10 млн — не блокер, и вердикт не ухудшается", async () => {
    const m = await mocks();
    const service = await import("./analysisConsolidationService");
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([parsedDocument("Текст извещения о закупке")]);
    vi.mocked(m.documentAnalysisRepository.findByTenderId).mockResolvedValue([
      { analysis: { findings: [BLOCKER], summary: "s" } } as never,
    ]);
    vi.mocked(service.consolidateAnalysis).mockResolvedValueOnce({
      kind: "consolidated",
      summary: "Можно участвовать",
      findings: [{ ...BLOCKER, category: "risk", severity: "medium", sources: ["ТЗ.docx"], legal_note: "ч. 2.1 ст. 52 ГрК РФ" }],
      conflicts: [],
      questions: [],
      facts: {
        work_start: null,
        work_end: null,
        warranty_months: null,
        bid_security_percent: null,
        contract_security_percent: null,
        warranty_security_percent: null,
        advance_percent: null,
        payment_days: null,
      },
    });

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(service.consolidateAnalysis).toHaveBeenCalled();
    expect(result?.verdictChanged).toBe(false);
    expect(m.analysisJobRepository.updateStatus).toHaveBeenCalledWith("job-1", "completed");
  });

  it("без значимых факторов историю вердиктов не трогает", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([
      parsedDocument("Текст извещения о закупке"),
    ]);
    vi.mocked(m.analyzeDocumentWithLlm).mockResolvedValue({
      findings: [],
      summary: "Значимых факторов нет",
      tokensUsed: 10,
      processingTimeMs: 10,
    });

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(result?.verdictChanged).toBe(false);
    expect(result?.findingsTotal).toBe(0);
    expect(m.verdictHistoryRepository.record).not.toHaveBeenCalled();
  });

  it("задача без документов закрывается сразу", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([]);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(result).toMatchObject({ documentsProcessed: 0, findingsTotal: 0 });
    expect(m.analysisJobRepository.updateStatus).toHaveBeenCalledWith("job-1", "completed");
    expect(m.analyzeDocumentWithLlm).not.toHaveBeenCalled();
  });

  it("возвращает null, когда в очереди нет задач", async () => {
    const m = await mocks();
    vi.mocked(m.analysisJobRepository.claimNextPending).mockResolvedValueOnce(null);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(result).toBeNull();
  });

  it("не уложился в бюджет времени — задача возвращается в очередь", async () => {
    const m = await mocks();
    // 250 тыс. знаков — три фрагмента по 100 тыс.
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([
      parsedDocument("а".repeat(250_000)),
    ]);

    let clock = 0;
    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob({
      timeBudgetMs: 40_000,
      now: () => (clock += 25_000),
    });

    expect(result?.deferred).toBe(true);
    // Первый фрагмент разобран, на втором время вышло.
    expect(m.analyzeDocumentWithLlm).toHaveBeenCalledTimes(1);
    expect(m.analysisJobRepository.updateStatus).toHaveBeenCalledWith("job-1", "pending");
    // Прогресс записан и на незавершённом прогоне: документ уже начал разбираться.
    expect(m.analysisJobRepository.setDocumentsProcessed).toHaveBeenCalledWith("job-1", 1);
    // Вердикт по неполным данным не пересчитывается.
    expect(m.verdictHistoryRepository.record).not.toHaveBeenCalled();
  });

  it("продолжает с первого неразобранного фрагмента", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([
      parsedDocument("а".repeat(250_000)),
    ]);
    // Два фрагмента уже разобраны прошлыми вызовами воркера.
    vi.mocked(m.documentAnalysisRepository.countByDocumentId).mockResolvedValue(2);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(result?.deferred).toBe(false);
    expect(m.analyzeDocumentWithLlm).toHaveBeenCalledTimes(1);
    expect(m.analysisJobRepository.updateStatus).toHaveBeenCalledWith("job-1", "completed");
  });

  it("текст на 3 млн знаков доходит до модели целиком: все фрагменты, ни одного пропуска", async () => {
    const m = await mocks();
    // Три миллиона знаков с абзацами: фрагменты режутся по границам абзацев.
    const paragraph = (n: number) => `Абзац ${n}. ${"требование заказчика ".repeat(20)}`;
    const text = Array.from({ length: 7_000 }, (_, i) => paragraph(i)).join("\n\n");
    expect(text.length).toBeGreaterThan(3_000_000);
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([parsedDocument(text)]);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob({ timeBudgetMs: 3_600_000 });

    expect(result?.deferred).toBe(false);
    const chunks = vi
      .mocked(m.analyzeDocumentWithLlm)
      .mock.calls.map((call) => call[0].documentText);
    // Размер фрагмента — 100 тыс. знаков: меньше тридцати вызовов не бывает.
    expect(chunks.length).toBeGreaterThanOrEqual(30);
    // Фрагменты подряд, без пропусков и перекрытий: склейка равна исходному тексту.
    expect(chunks.join("")).toBe(text);
    expect(m.documentAnalysisRepository.record).toHaveBeenCalledTimes(chunks.length);
    expect(m.analysisJobRepository.updateStatus).toHaveBeenCalledWith("job-1", "completed");
  });

  it("большой документ идёт за несколько вызовов воркера и доходит до последнего фрагмента", async () => {
    const m = await mocks();
    const text = "а".repeat(450_000); // пять фрагментов
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([parsedDocument(text)]);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");

    // Первый вызов: время выходит после двух фрагментов.
    let clock = 0;
    const first = await processAnalysisJob({ timeBudgetMs: 40_000, now: () => (clock += 15_000) });
    expect(first?.deferred).toBe(true);
    const done = vi.mocked(m.analyzeDocumentWithLlm).mock.calls.length;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(5);

    // Второй вызов продолжает с первого неразобранного: счётчик берётся из базы.
    vi.mocked(m.documentAnalysisRepository.countByDocumentId).mockResolvedValue(done);
    const second = await processAnalysisJob({ timeBudgetMs: 3_600_000 });
    expect(second?.deferred).toBe(false);
    expect(vi.mocked(m.analyzeDocumentWithLlm).mock.calls.length).toBe(5);
  });

  it("расход на модель привязывается к закупке и заданию", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([parsedDocument("Текст извещения")]);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    await processAnalysisJob();

    expect(m.analyzeDocumentWithLlm).toHaveBeenCalledWith(
      expect.objectContaining({ usageContext: { tenderId: JOB.tender_id, jobId: "job-1" } }),
    );
  });

  it("документ только со ссылкой скачивает и разбирает сам", async () => {
    const m = await mocks();
    const linked = linkedDocument();
    const bytes = Buffer.from("fake pdf content");
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([linked]);
    vi.mocked(m.downloadDocument).mockResolvedValue({
      buffer: bytes,
      mimeType: "application/pdf",
      fileSize: 18,
    });
    vi.mocked(m.parseAttachment).mockResolvedValue({
      text: "Текст из PDF",
      status: "parsed",
      reason: null,
      truncated: false,
    });
    vi.mocked(m.documentRepository.findByContentHash).mockResolvedValue(null);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(m.downloadDocument).toHaveBeenCalledWith(linked.file_url);
    // Разбор тот же, что и у вложений ЕИС, и с тем же бюджетом знаков на закупку.
    expect(m.parseAttachment).toHaveBeenCalledWith(
      bytes,
      "Проект контракта.pdf",
      "application/pdf",
      MAX_TOTAL_CHARS_PER_TENDER,
    );
    expect(m.documentRepository.updateParsed).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({
        parsed_status: "parsed",
        parsed_text: "Текст из PDF",
        truncated: false,
        archive: null,
      }),
    );
    expect(result?.deferred).toBe(false);
  });

  it("обрезку по бюджету знаков пишет в базу вместе с текстом", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([
      linkedDocument("Документация о закупке.zip"),
    ]);
    vi.mocked(m.downloadDocument).mockResolvedValue({
      buffer: Buffer.from("fake archive"),
      // ЕИС отдаёт файлы как application/download: формат определяет расширение.
      mimeType: "application/download",
      fileSize: 18_350_080,
    });
    vi.mocked(m.parseAttachment).mockResolvedValue({
      text: "ы".repeat(1_000_000),
      status: "parsed",
      reason: null,
      truncated: true,
      archive: { parsed: 2, total: 15 },
    });
    vi.mocked(m.documentRepository.findByContentHash).mockResolvedValue(null);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    await processAnalysisJob();

    // Без отметки карточка показала бы «Разбор завершён» над документацией,
    // которую модель не видела целиком: из 15 вложений архива прочитаны 2.
    expect(m.documentRepository.updateParsed).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({ truncated: true, archive: { parsed: 2, total: 15 } }),
    );
  });

  it("скан без текстового слоя помечает needs_ocr и не роняет задачу", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([linkedDocument()]);
    vi.mocked(m.downloadDocument).mockResolvedValue({
      buffer: Buffer.from("scan"),
      mimeType: "image/png",
      fileSize: 4,
    });
    vi.mocked(m.parseAttachment).mockResolvedValue({
      text: "",
      status: "empty",
      reason: "Текстового слоя нет: файл отсканирован или пуст.",
      truncated: false,
    });

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(m.documentRepository.updateParsed).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({
        parsed_status: "needs_ocr",
        error_message: "Текстового слоя нет: файл отсканирован или пуст.",
      }),
    );
    expect(m.analyzeDocumentWithLlm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deferred: false, findingsTotal: 0 });
    expect(m.analysisJobRepository.updateStatus).toHaveBeenCalledWith("job-1", "completed");
  });

  it("неподдерживаемый формат помечает failed с причиной парсера", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([
      linkedDocument("Чертежи.dwg"),
    ]);
    vi.mocked(m.downloadDocument).mockResolvedValue({
      buffer: Buffer.from("dwg"),
      mimeType: "application/download",
      fileSize: 3,
    });
    vi.mocked(m.parseAttachment).mockResolvedValue({
      text: "",
      status: "unsupported",
      reason: "Формат .dwg не читается: нужен AutoCAD.",
      truncated: false,
    });

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    expect(m.documentRepository.updateParsed).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({
        parsed_status: "failed",
        error_message: "Формат .dwg не читается: нужен AutoCAD.",
      }),
    );
    expect(result).toMatchObject({ documentsProcessed: 1, deferred: false, findingsTotal: 0 });
  });

  it("строку пропуска не пытается скачать", async () => {
    const m = await mocks();
    const skipped = skippedDocument();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([skipped]);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const result = await processAnalysisJob();

    // ЕИС зарубежные IP не пускает: попытка затёрла бы внятную причину сетевой ошибкой.
    expect(m.downloadDocument).not.toHaveBeenCalled();
    expect(m.documentRepository.updateParsed).not.toHaveBeenCalled();
    expect(m.analyzeDocumentWithLlm).not.toHaveBeenCalled();
    // Ждать от документа больше нечего, поэтому он входит в прогресс задачи.
    expect(result).toMatchObject({ documentsProcessed: 1, deferred: false, findingsTotal: 0 });
    expect(m.analysisJobRepository.updateStatus).toHaveBeenCalledWith("job-1", "completed");
  });

  it("счётчик прогресса абсолютный и не растёт от повторных вызовов", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([
      parsedDocument("Текст извещения о закупке"),
      skippedDocument(),
    ]);

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    const first = await processAnalysisJob();
    const second = await processAnalysisJob();

    expect(first?.documentsProcessed).toBe(2);
    expect(second?.documentsProcessed).toBe(2);
    const calls = vi.mocked(m.analysisJobRepository.setDocumentsProcessed).mock.calls;
    expect(calls.at(-1)).toEqual(["job-1", 2]);
    expect(m.analysisJobRepository.setDocumentsTotal).toHaveBeenCalledWith("job-1", 2);
  });

  it("ошибка разбора помечает задачу failed и пробрасывается наружу", async () => {
    const m = await mocks();
    vi.mocked(m.documentRepository.findByTenderId).mockResolvedValue([
      parsedDocument("Текст извещения о закупке"),
    ]);
    vi.mocked(m.analyzeDocumentWithLlm).mockRejectedValue(new Error("OpenRouter 429"));

    const { processAnalysisJob } = await import("./documentAnalysisPipeline");
    await expect(processAnalysisJob()).rejects.toThrow("OpenRouter 429");

    expect(m.analysisJobRepository.updateStatus).toHaveBeenCalledWith(
      "job-1",
      "failed",
      "OpenRouter 429",
    );
  });
});
