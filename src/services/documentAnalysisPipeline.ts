import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { documentAnalysisRepository } from "@/repositories/documentAnalysisRepository";
import { documentRepository } from "@/repositories/documentRepository";
import { tenderRepository } from "@/repositories/tenderRepository";
import { verdictHistoryRepository } from "@/repositories/verdictHistoryRepository";
import { applyDocumentFindings } from "@/domain/scoring";
import { documentSkipMark } from "@/domain/deepAnalysis";
import { parseAttachment } from "@/services/attachmentParser";
import { computeContentHash, splitIntoChunks } from "@/services/documentParser";
import { downloadDocument } from "@/services/documentDownloader";
import { analyzeDocumentWithLlm } from "@/services/llmAnalysis";
import { resolveLlmModel } from "@/services/llmGateway";
import { MAX_TOTAL_CHARS_PER_TENDER } from "@/services/tenderAttachmentsFetcher";
import type { AnalysisFinding, TenderDocumentRow, Verdict } from "@/types/database";

/** Сколько знаков текста уходит в один вызов модели. */
const CHUNK_SIZE = 100_000;

/**
 * Бюджет времени на один вызов воркера.
 *
 * Vercel Hobby обрывает серверную функцию на 60 секундах, а извещение ЕИС —
 * это 240 тыс. знаков, то есть три вызова модели по 100 тыс. За один вызов
 * воркер физически не успевает разобрать документ целиком, поэтому работа
 * делится на фрагменты: не уложились — задача возвращается в очередь и
 * следующий вызов продолжает с того фрагмента, на котором остановились.
 */
const DEFAULT_TIME_BUDGET_MS = 40_000;

export interface ProcessOptions {
  /** Сколько миллисекунд воркер может работать до возврата задачи в очередь. */
  timeBudgetMs?: number;
  /** Текущее время — передаётся извне, чтобы дедлайн можно было проверить в тестах. */
  now?: () => number;
}

export interface ProcessResult {
  jobId: string;
  tenderId: string;
  documentsProcessed: number;
  /** true — бюджет времени исчерпан, задача вернулась в очередь на дозапуск. */
  deferred: boolean;
  /** Сколько факторов найдено по всем разобранным фрагментам. */
  findingsTotal: number;
  verdictChanged: boolean;
}

interface TenderContext {
  regNumber: string;
  subject: string;
  customerName: string;
  price: number;
}

/**
 * Обрабатывает одну задачу из очереди: скачать → разобрать → проанализировать →
 * пересчитать вердикт. Возвращает null, если задач нет.
 *
 * Скачивание здесь почти не происходит: текст извещения ЕИС заранее кладёт
 * локальный скрипт scripts/fetch-tender-documents.ts (ЕИС не пускает зарубежные
 * IP, а Vercel стоит за рубежом). Ветка со скачиванием нужна для документов,
 * которые попали в базу только ссылкой, — вручную загруженных и контуровских.
 */
export async function processAnalysisJob(
  options: ProcessOptions = {},
): Promise<ProcessResult | null> {
  const now = options.now ?? ((): number => Date.now());
  const deadline = now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);

  const job = await analysisJobRepository.claimNextPending();
  if (!job) return null;

  try {
    const documents = await documentRepository.findByTenderId(job.tender_id);

    if (documents.length === 0) {
      await analysisJobRepository.updateStatus(job.id, "completed");
      return {
        jobId: job.id,
        tenderId: job.tender_id,
        documentsProcessed: 0,
        deferred: false,
        findingsTotal: 0,
        verdictChanged: false,
      };
    }

    await analysisJobRepository.setDocumentsTotal(job.id, documents.length);

    const context = await tenderContextFor(job.tender_id);
    // Какая модель делала выводы: записывается в каждый разбор, чтобы смену
    // провайдера было видно в данных, а не только в настройках.
    const model = resolveLlmModel();

    // Прогресс считается от результата, а не от числа проходов: большой документ
    // разбирается по фрагментам за несколько вызовов воркера, и счётчик,
    // растущий на каждом проходе, после трёх дозапусков показывал «12 из 4».
    // В отчёт идут документы хотя бы с одним разобранным фрагментом и документы,
    // от которых текста не дождаться вовсе — ждать от них больше нечего.
    let analyzed = 0;
    let withoutText = 0;
    let deferred = false;

    for (const document of documents) {
      const text = await ensureDocumentText(document);
      if (text === null) {
        withoutText += 1;
      } else {
        const outcome = await analyzeDocument({
          documentId: document.id,
          tenderId: job.tender_id,
          filename: document.filename,
          text,
          context,
          model,
          deadline,
          now,
        });
        deferred = outcome.deferred;
        if (outcome.analyzed) analyzed += 1;
      }

      // Пишем каждый проход, а не только в конце: прогон идёт десятки секунд,
      // и партнёр в карточке закупки должен видеть движение, а не ноль.
      await analysisJobRepository.setDocumentsProcessed(job.id, analyzed + withoutText);
      if (deferred) break;
    }

    const processed = analyzed + withoutText;

    if (deferred) {
      // Не ошибка: работа продолжится следующим вызовом воркера.
      await analysisJobRepository.updateStatus(job.id, "pending");
      return {
        jobId: job.id,
        tenderId: job.tender_id,
        documentsProcessed: processed,
        deferred: true,
        findingsTotal: 0,
        verdictChanged: false,
      };
    }

    // Вердикт пересчитываем только когда разобрано всё: иначе часть факторов
    // ещё не найдена и вывод был бы преждевременным.
    const findings = await collectFindings(job.tender_id);
    const verdictChanged = await recordVerdictIfWorsened(job.tender_id, findings);

    await analysisJobRepository.updateStatus(job.id, "completed");

    return {
      jobId: job.id,
      tenderId: job.tender_id,
      documentsProcessed: processed,
      deferred: false,
      findingsTotal: findings.length,
      verdictChanged,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await analysisJobRepository.updateStatus(job.id, "failed", errorMessage);
    throw err;
  }
}

/** Контекст закупки для промпта: без него модель судит о документе вслепую. */
async function tenderContextFor(regNumber: string): Promise<TenderContext> {
  const row = await tenderRepository.findByRegNumber(regNumber);
  if (!row) {
    return { regNumber, subject: "", customerName: "", price: 0 };
  }
  return {
    regNumber: row.reg_number,
    subject: row.subject,
    customerName: row.customer_name,
    // null означает «цена не опубликована» — промпт так и напишет.
    price: row.price ?? 0,
  };
}

/**
 * Текст документа: готовый из базы либо скачанный и разобранный сейчас.
 * null — текста нет (неподдерживаемый формат, нужна OCR, ошибка загрузки).
 */
async function ensureDocumentText(document: TenderDocumentRow): Promise<string | null> {
  if (document.parsed_status === "parsed" && document.parsed_text) {
    return document.parsed_text;
  }

  // Строка пропуска: файл не влез в бюджет знаков, весит больше предела,
  // не читается или оказался сканом без слоя. Ссылка в ней настоящая — на ЕИС,
  // которая зарубежные IP не пускает. Скачивание закончилось бы сетевой
  // ошибкой и затёрло внятную причину, которую локальный скрипт записал
  // специально для партнёра, поэтому выходим до всякой сети.
  if (documentSkipMark(document) !== null) return null;

  if (!document.file_url) return null;

  try {
    if (document.download_status !== "downloaded") {
      await documentRepository.updateDownloadStatus(document.id, {
        download_status: "downloading",
      });

      const downloaded = await downloadDocument(document.file_url);

      await documentRepository.updateDownloadStatus(document.id, {
        download_status: "downloaded",
        file_size: downloaded.fileSize,
      });

      // Разбор тот же, что и у вложений ЕИС: doc, docx, pdf, таблицы и архивы.
      // Предел знаков один на закупку — больше в разбор всё равно не уйдёт.
      const parsed = await parseAttachment(
        downloaded.buffer,
        document.filename,
        downloaded.mimeType,
        MAX_TOTAL_CHARS_PER_TENDER,
      );

      if (parsed.status !== "parsed") {
        // «empty» — это скан без текстового слоя: партнёру важно понять, что
        // документ существует, но прочитать его может только распознавание.
        await documentRepository.updateParsed(document.id, {
          parsed_text: null,
          parsed_status: parsed.status === "empty" ? "needs_ocr" : "failed",
          error_message: parsed.reason ?? "Текст из файла получить не удалось.",
        });
        return null;
      }

      const parsedText = parsed.text;

      // Одинаковый текст уже мог быть разобран для другой закупки — берём из кэша.
      const hash = computeContentHash(parsedText);
      const cached = await documentRepository.findByContentHash(hash);

      await documentRepository.updateParsed(document.id, {
        parsed_text: cached?.parsed_text ?? parsedText,
        parsed_status: "parsed",
        content_hash: hash,
        truncated: parsed.truncated,
        archive: parsed.archive ?? null,
      });

      return cached?.parsed_text ?? parsedText;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await documentRepository.updateDownloadStatus(document.id, {
      download_status: "failed",
      error_message: errorMessage,
    });
    return null;
  }

  return null;
}

interface AnalyzeDocumentArgs {
  documentId: string;
  tenderId: string;
  filename: string;
  text: string;
  context: TenderContext;
  model: string;
  deadline: number;
  now: () => number;
}

/**
 * Разбор документа по фрагментам с продолжением между вызовами воркера.
 * Сколько фрагментов уже разобрано, видно по числу строк в document_analyses:
 * отдельной колонки для номера фрагмента в схеме нет, а миграцию ради этого
 * заводить не нужно.
 *
 * `analyzed` — есть ли у документа хотя бы один разобранный фрагмент. По нему
 * воркер считает прогресс задачи: фрагментов у большого документа много, а
 * документ в отчёте один.
 */
async function analyzeDocument(
  args: AnalyzeDocumentArgs,
): Promise<{ deferred: boolean; analyzed: boolean }> {
  const chunks = splitIntoChunks(args.text, CHUNK_SIZE);
  const analyzedBefore = await documentAnalysisRepository.countByDocumentId(args.documentId);
  let recorded = 0;

  for (let index = analyzedBefore; index < chunks.length; index += 1) {
    // Дедлайн проверяем ДО вызова модели: один запрос может идти десятки секунд,
    // и начинать его, когда время уже вышло, значит гарантированно получить обрыв.
    if (args.now() > args.deadline) {
      return { deferred: true, analyzed: analyzedBefore + recorded > 0 };
    }

    const chunk = chunks[index];
    if (chunk === undefined) continue;

    const result = await analyzeDocumentWithLlm({
      documentText: chunk,
      tenderContext: args.context,
      companyProfile: {
        // Профиль компании живёт в браузере пользователя, на сервере его нет.
        // Промпт честно сообщает об этом модели вместо пустых строк.
        capabilities: "",
        restrictions: "",
      },
    });

    await documentAnalysisRepository.record({
      tender_id: args.tenderId,
      document_id: args.documentId,
      model_used: args.model,
      findings: result.findings,
      summary: result.summary,
      tokens_used: result.tokensUsed,
      processing_time_ms: result.processingTimeMs,
    });
    recorded += 1;
  }

  return { deferred: false, analyzed: analyzedBefore + recorded > 0 };
}

/** Все факторы по закупке — из всех разобранных фрагментов всех документов. */
async function collectFindings(tenderId: string): Promise<AnalysisFinding[]> {
  const analyses = await documentAnalysisRepository.findByTenderId(tenderId);
  return analyses.flatMap((row) => row.analysis?.findings ?? []);
}

/**
 * Пишет изменение вердикта в историю, если разбор документов её ухудшил.
 * Точка отсчёта — последний записанный вердикт; если истории нет, old_verdict
 * остаётся null, а не выдуманным «RECOMMENDED».
 */
async function recordVerdictIfWorsened(
  tenderId: string,
  findings: AnalysisFinding[],
): Promise<boolean> {
  const history = await verdictHistoryRepository.findByTenderId(tenderId);
  const currentVerdict: Verdict | null = history[0]?.new_verdict ?? null;

  const result = applyDocumentFindings({ currentVerdict, findings });
  if (!result.worsened || result.verdict === null) return false;

  await verdictHistoryRepository.record({
    tender_id: tenderId,
    old_verdict: currentVerdict,
    new_verdict: result.verdict,
    // Оценку соответствия документный разбор не пересчитывает: выдумывать
    // число в истории нельзя.
    old_score: null,
    new_score: null,
    reason: result.reason,
    triggered_by: "document_analysis",
    analysis_id: null,
  });

  return true;
}
