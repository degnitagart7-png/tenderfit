import { analysisJobRepository } from "@/repositories/analysisJobRepository";
import { documentAnalysisRepository } from "@/repositories/documentAnalysisRepository";
import { documentRepository } from "@/repositories/documentRepository";
import { tenderRepository } from "@/repositories/tenderRepository";
import { verdictHistoryRepository } from "@/repositories/verdictHistoryRepository";
import { applyDocumentFindings } from "@/domain/scoring";
import { applyLegalRules, readConsolidated, type ConsolidationTender } from "@/domain/analysisConsolidation";
import {
  consolidateAnalysis,
  defaultConsolidationDeps,
  sourcedFindings,
} from "@/services/analysisConsolidationService";
import { documentSkipMark } from "@/domain/deepAnalysis";
import { textForDeepAnalysis } from "@/domain/deepAnalysisText";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { parseAttachment } from "@/services/attachmentParser";
import { computeContentHash, splitIntoChunks } from "@/services/documentParser";
import { downloadDocument } from "@/services/documentDownloader";
import { isEisBlockedError } from "@/lib/eisGate";
import { describeError } from "@/lib/errors";
import { recordDocumentTerms } from "@/services/documentTermsService";
import { analyzeDocumentWithLlm } from "@/services/llmAnalysis";
import { resolveLlmModel } from "@/services/llmGateway";
import { MAX_TOTAL_CHARS_PER_TENDER } from "@/services/tenderAttachmentsFetcher";
import type { AnalysisFinding, TenderDocumentRow, TenderLaw, Verdict } from "@/types/database";

/**
 * Сколько знаков текста уходит в один вызов модели. Это размер фрагмента, а не
 * предел: документ режется на столько фрагментов, сколько нужно, и анализ
 * продолжается (pending → следующий вызов воркера) до последнего.
 */
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

/**
 * Сводка выводов начинается в том же вызове, только если с его начала прошло не больше
 * этого: сводке нужно до 105 с, а вызов воркера ждёт ответа 120 с.
 */
const CONSOLIDATION_START_WINDOW_MS = 10_000;

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
  /** Закон закупки: по нему промпт отделяет норму закона от отклонения. */
  law?: TenderLaw | null;
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
  const startedAt = now();
  const deadline = startedAt + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);

  // Только задачи с уже загруженной документацией: задача кнопки «Глубокий
  // анализ» появляется раньше своих документов (см. nextJobWithDocuments).
  const job = await analysisJobRepository.claimNextPending({ withDocumentsOnly: true });
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
          jobId: job.id,
          filename: document.filename,
          // Большая смета — шапка и итоги; позиции проверяет аудит сметы (`deepAnalysisText.ts`).
          text: textForDeepAnalysis(document.filename, text).text,
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

    /*
      Сводка выводов по всем документам (`analysisConsolidation.ts`) — один вызов
      модели до минуты-полутора, а вызов воркера ждёт ответа две минуты
      (`WORKER_TIMEOUT_MS`). Если этот вызов уже потратил время на фрагменты,
      задача возвращается в очередь, и следующий, свежий вызов сразу делает сводку.
    */
    if (now() - startedAt > CONSOLIDATION_START_WINDOW_MS) {
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
    const facts = { ...(await consolidationTenderFor(job.tender_id)), estimates: customerEstimatesFact(documents) };
    const consolidated = await consolidateAnalysis(
      facts,
      sourcedFindings(await documentAnalysisRepository.findByTenderId(job.tender_id), documents),
      { jobId: job.id },
      defaultConsolidationDeps(model),
    );

    // Вердикт пересчитываем только когда разобрано всё: иначе часть факторов
    // ещё не найдена и вывод был бы преждевременным. Основа — сводка (повторы
    // объединены, противоречия разрешены, правила закона применены); без неё —
    // построчные выводы с теми же правилами закона.
    const findings =
      consolidated?.findings ?? applyLegalRules(await collectFindings(job.tender_id), facts).findings;
    const verdictChanged = await recordVerdictIfWorsened(job.tender_id, findings, facts.law);

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
    // describeError, а не String(err): ошибка Supabase — простой объект, и в задаче оставалось
    // «[object Object]» вместо причины (анализ клиента 14.10.2026).
    const errorMessage = describeError(err);
    console.error(`Разбор ${job.tender_id} не удался: ${errorMessage}`);
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
    law: row.law ?? null,
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

  // Строка пропуска: файл весит больше предела, не читается, оказался сканом
  // без слоя (или, в старых записях, не влез в прежний бюджет знаков). Ссылка в ней настоящая — на ЕИС,
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
      // Бюджета знаков по умолчанию нет; если его включили для аварии
      // (TENDERFIT_MAX_CHARS_PER_TENDER), он один на закупку.
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
        ocr: parsed.ocr ?? null,
      });
      await recordDocumentTerms(document.tender_id, cached?.parsed_text ?? parsedText);

      return cached?.parsed_text ?? parsedText;
    }
  } catch (err) {
    const errorMessage = describeError(err);
    // Блокировка ЕИС временна: документ остаётся «в ожидании» и скачивается при
    // следующем разборе, а не помечается как окончательно не скачавшийся.
    await documentRepository.updateDownloadStatus(document.id, {
      download_status: isEisBlockedError(err) ? "pending" : "failed",
      error_message: errorMessage,
    });
    return null;
  }

  return null;
}

interface AnalyzeDocumentArgs {
  documentId: string;
  tenderId: string;
  /** Задание анализа: к нему привязывается расход на модель (llm_usage_log). */
  jobId: string;
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
): Promise<{ deferred: boolean; analyzed: boolean; recorded: number }> {
  const chunks = splitIntoChunks(args.text, CHUNK_SIZE);
  const analyzedBefore = await documentAnalysisRepository.countByDocumentId(args.documentId);
  let recorded = 0;

  for (let index = analyzedBefore; index < chunks.length; index += 1) {
    // Дедлайн проверяем ДО вызова модели: один запрос может идти десятки секунд,
    // и начинать его, когда время уже вышло, значит гарантированно получить обрыв.
    if (args.now() > args.deadline) {
      return { deferred: true, analyzed: analyzedBefore + recorded > 0, recorded };
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
      usageContext: { tenderId: args.tenderId, jobId: args.jobId },
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

  return { deferred: false, analyzed: analyzedBefore + recorded > 0, recorded };
}

/** Все факторы по закупке — из всех разобранных фрагментов всех документов (без прежних сводок). */
async function collectFindings(tenderId: string): Promise<AnalysisFinding[]> {
  const analyses = await documentAnalysisRepository.findByTenderId(tenderId);
  return analyses
    .filter((row) => readConsolidated(row.analysis) === null)
    .flatMap((row) => row.analysis?.findings ?? []);
}

/** Факт закупки для сводки: против него сверяются сроки, НМЦК и пороги закона. */
/** Сумма смет заказчика по всем файлам — факт для сводки (см. `ConsolidationTender.estimates`). */
function customerEstimatesFact(documents: readonly TenderDocumentRow[]): ConsolidationTender["estimates"] {
  try {
    const texts = documents
      .filter((d) => d.parsed_status === "parsed" && (d.parsed_text ?? "") !== "")
      .map((d) => ({ name: d.filename, text: d.parsed_text ?? "" }));
    const estimates = parseCustomerLsr(texts).estimates;
    if (estimates.length === 0) return null;
    return { files: estimates.length, positionsTotal: estimates.reduce((sum, e) => sum + e.positionsTotal, 0) };
  } catch (err) {
    // Разбор сметы не должен ронять сводку: без суммы модель просто не получит этот факт.
    console.error(`Сумма смет не посчитана: ${describeError(err)}`);
    return null;
  }
}

async function consolidationTenderFor(regNumber: string): Promise<ConsolidationTender> {
  const row = await tenderRepository.findByRegNumber(regNumber);
  return {
    regNumber,
    subject: row?.subject ?? "",
    price: row?.price ?? null,
    law: row?.law ?? null,
    submissionEnd: row?.submission_end ?? null,
    region: row?.region ?? null,
  };
}

/**
 * Пишет изменение вердикта в историю, если разбор документов её ухудшил.
 * Точка отсчёта — последний записанный вердикт; если истории нет, old_verdict
 * остаётся null, а не выдуманным «RECOMMENDED».
 */
async function recordVerdictIfWorsened(
  tenderId: string,
  findings: AnalysisFinding[],
  law: TenderLaw | null,
): Promise<boolean> {
  const history = await verdictHistoryRepository.findByTenderId(tenderId);
  const currentVerdict: Verdict | null = history[0]?.new_verdict ?? null;

  const result = applyDocumentFindings({ currentVerdict, findings, law });
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
