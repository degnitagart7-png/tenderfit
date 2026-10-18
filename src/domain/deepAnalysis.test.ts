import { describe, it, expect } from "vitest";
import {
  deepAnalysisBlocker,
  documentSkipMark,
  documentTruncation,
  documentVerdictChange,
  groupDocuments,
  deepAnalysisFingerprint,
  documentArchive,
  groupFindings,
  summarizeDeepAnalysis,
  type DeepAnalysisInput,
} from "./deepAnalysis";
import { applyDocumentFindings } from "@/domain/scoring";
import type {
  AnalysisFinding,
  AnalysisJobRow,
  DocumentAnalysisRow,
  DocumentMeta,
  SkippedCode,
  VerdictHistoryRow,
} from "@/types/database";

function job(overrides: Partial<AnalysisJobRow> = {}): AnalysisJobRow {
  return {
    id: "job-1",
    tender_id: "0573100026626000009",
    job_type: "full_analysis",
    status: "pending",
    priority: 0,
    documents_total: 1,
    documents_processed: 0,
    error_message: null,
    started_at: null,
    finished_at: null,
    created_at: "2026-09-21T20:00:00Z",
    updated_at: "2026-09-21T20:00:00Z",
    ...overrides,
  };
}

function document(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id: "doc-1",
    filename: "print-form-1.html",
    document_type: "notice",
    source_type: "eis_api",
    file_url:
      "https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=1",
    parsed_status: "parsed",
    download_status: "downloaded",
    content_hash: "a".repeat(64),
    file_size: 432708,
    error_message: null,
    created_at: "2026-09-21T20:57:43Z",
    updated_at: "2026-09-21T20:57:43Z",
    raw_json: { title: "Извещение о закупке (печатная форма)" },
    ...overrides,
  };
}

/**
 * Вложение, которое обход не стал читать.
 *
 * Повторяет то, что пишет documentRepository.saveSkipped: текст пуст,
 * error_message равен причине, а признак пропуска лежит в raw_json.skipped.
 * Именно raw_json отличает осознанный пропуск от настоящего сбоя разбора.
 */
function skippedDocument(
  overrides: Partial<DocumentMeta> & {
    code?: SkippedCode;
    reason?: string;
  } = {},
): DocumentMeta {
  const {
    code = "file_too_large",
    reason = "Файл больше предела 50 МБ и не читается.",
    ...rest
  } = overrides;
  return document({
    id: "doc-skipped",
    filename: "Йошкар Ола ПСД.part01.rar",
    parsed_status: "failed",
    download_status: "failed",
    content_hash: null,
    file_size: null,
    error_message: reason,
    raw_json: {
      title: "Проектная документация",
      chars: 0,
      skipped: { code, reason },
    },
    ...rest,
  });
}

/**
 * Вложение, которое прочитано частично: бюджет знаков на закупку кончился.
 *
 * Повторяет то, что пишет documentRepository.saveParsed: признак обрезки лежит
 * в raw_json.truncated, а счётчик архива — рядом в raw_json.archive, и только
 * когда файл действительно архив.
 */
function truncatedDocument(
  overrides: Partial<DocumentMeta> & {
    archive?: { parsed: number; total: number } | null;
  } = {},
): DocumentMeta {
  const { archive = null, ...rest } = overrides;
  return document({
    id: "doc-truncated",
    filename: "ДОЗ.zip",
    raw_json: {
      title: "Документация о закупке",
      chars: 173_598,
      truncated: true,
      ...(archive ? { archive } : {}),
    },
    ...rest,
  });
}

function finding(overrides: Partial<AnalysisFinding> = {}): AnalysisFinding {
  return {
    category: "risk",
    title: "Неустойка 0,5%",
    detail: "Размер пени выше обычного",
    evidence_quote: "Неустойка составляет 0,5% от цены контракта",
    evidence_section: "Раздел 5. Проект контракта",
    severity: "high",
    ...overrides,
  };
}

function analysis(
  findings: AnalysisFinding[],
  id = "an-1",
): DocumentAnalysisRow {
  return {
    id,
    tender_id: "0573100026626000009",
    document_id: "doc-1",
    model_used: "google/gemini-2.5-flash",
    analysis: { findings, summary: "Найдены риски по неустойке" },
    verdict_before: null,
    verdict_after: null,
    old_score: null,
    new_score: null,
    confidence_score: null,
    tokens_used: 1200,
    processing_time_ms: 8400,
    created_at: "2026-09-21T21:00:00Z",
  };
}

function verdictRow(
  overrides: Partial<VerdictHistoryRow> = {},
): VerdictHistoryRow {
  return {
    id: "vh-1",
    tender_id: "0573100026626000009",
    old_verdict: null,
    new_verdict: "NOT_RECOMMENDED",
    old_score: null,
    new_score: null,
    reason: "Обнаружены блокирующие факторы: Отсутствие лицензии",
    triggered_by: "document_analysis",
    analysis_id: null,
    created_at: "2026-09-21T21:05:00Z",
    ...overrides,
  };
}

function input(overrides: Partial<DeepAnalysisInput> = {}): DeepAnalysisInput {
  return {
    dataSource: "EIS",
    jobs: [],
    documents: [],
    documentAnalyses: [],
    verdictHistory: [],
    ...overrides,
  };
}

describe("deepAnalysisBlocker", () => {
  it("разрешает ЕИС", () => {
    expect(deepAnalysisBlocker("EIS")).toBeNull();
  });

  /**
   * Контур.Закупки — агрегатор: его номер извещения совпадает с номером ЕИС,
   * поэтому документацию отдаёт тот же бесплатный обход печатной формы и вкладки
   * документов. Проверено живым прогоном 23.09.2026 на номерах из прод-базы.
   */
  it("разрешает Контур.Закупки: документацию по их номеру отдаёт ЕИС", () => {
    expect(deepAnalysisBlocker("KONTUR")).toBeNull();
  });

  it("объясняет, почему Сбербанк-АСТ не анализируется", () => {
    expect(deepAnalysisBlocker("SBER_AST")).toMatch(/Сбербанк-АСТ/);
  });

  it("объясняет ручной импорт", () => {
    expect(deepAnalysisBlocker("IMPORT")).toMatch(/вручную/);
  });
});

describe("summarizeDeepAnalysis", () => {
  it("для недоступного источника не обещает разбор, даже если задача есть", () => {
    const result = summarizeDeepAnalysis(
      input({ dataSource: "SBER_AST", jobs: [job()] }),
    );

    expect(result.state).toBe("unsupported");
    expect(result.detail).toMatch(/КЭП/);
  });

  it("без задач говорит, что анализ не запускался", () => {
    const result = summarizeDeepAnalysis(input());

    expect(result.state).toBe("not_started");
    expect(result.title).toMatch(/не запускался/);
    expect(result.detail).toMatch(/Запустить глубокий анализ/);
  });

  it("задача в очереди без документов — ждём плановую синхронизацию", () => {
    const result = summarizeDeepAnalysis(input({ jobs: [job()] }));

    expect(result.state).toBe("queued");
    expect(result.detail).toMatch(/обычно это 1–3 минуты/);
  });

  it("не обещает плановую догрузку закупке, которой документы даст только карточка", () => {
    // Для коммерческой закупки Контур.Закупок ЕИС не публикует вкладку
    // документов: обещание скорой загрузки не выполнится никогда, и
    // рядом с предложением купить карточку оно читается как обман.
    const result = summarizeDeepAnalysis(
      input({ dataSource: "KONTUR", jobs: [job()], paidCardOffered: true }),
    );

    expect(result.state).toBe("queued");
    expect(result.detail).toMatch(/Плановая синхронизация сюда не дойдёт/);
    expect(result.detail).not.toMatch(/обычно это 1–3 минуты/);
  });

  it("документы загружены, но разбор ещё не начался", () => {
    const result = summarizeDeepAnalysis(
      input({ jobs: [job()], documents: [document()] }),
    );

    expect(result.state).toBe("queued");
    expect(result.title).toMatch(/Документация прочитана/);
    expect(result.detail).toContain("1");
  });

  it("processing — идёт разбор", () => {
    const result = summarizeDeepAnalysis(
      input({ jobs: [job({ status: "processing" })], documents: [document()] }),
    );

    expect(result.state).toBe("analyzing");
    expect(result.detail).toContain("1");
  });

  it("pending после части фрагментов — разбор продолжится", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job()],
        documents: [document()],
        documentAnalyses: [
          analysis([finding()], "an-1"),
          analysis([finding()], "an-2"),
        ],
      }),
    );

    expect(result.state).toBe("resuming");
    expect(result.chunksAnalyzed).toBe(2);
    expect(result.detail).toContain("Разобрано фрагментов: 2");
  });

  it("completed считает прочитанные файлы и находки", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "completed", documents_processed: 1 })],
        documents: [document()],
        documentAnalyses: [
          analysis([finding(), finding({ category: "blocker" })], "an-1"),
        ],
      }),
    );

    expect(result.state).toBe("completed");
    expect(result.detail).toContain("Прочитан 1 файл из 1");
    expect(result.detail).toContain("Нашлось важного: 2");
  });

  it("completed без единого фрагмента честно говорит, что анализировать было нечего", () => {
    const result = summarizeDeepAnalysis(
      input({ jobs: [job({ status: "completed" })] }),
    );

    expect(result.state).toBe("completed");
    expect(result.title).toMatch(/анализировать было нечего/);
    expect(result.findings).toEqual([]);
  });

  it("failed показывает сохранённую причину", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "failed", error_message: "OpenRouter 429" })],
      }),
    );

    expect(result.state).toBe("failed");
    expect(result.detail).toBe("OpenRouter 429");
  });

  it("при одинаковой свежести берёт задачу, созданную позже", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [
          job({ id: "job-2", status: "pending" }),
          job({ id: "job-1", status: "completed" }),
        ],
      }),
    );

    expect(result.state).toBe("queued");
    expect(result.job?.id).toBe("job-2");
  });

  it("готовый разбор не прячет задача, созданная раньше и закрытая позже", () => {
    // Случай с прода 21.09.2026: первая задача прошла со второй попытки и
    // завершилась в 21:23:04, а поставленная между попытками вторая задача
    // осталась в очереди. Воркер обрабатывает одну задачу за вызов, поэтому
    // «свежайшая по созданию» — не значит «последняя по смыслу».
    const result = summarizeDeepAnalysis(
      input({
        jobs: [
          job({
            id: "job-2",
            status: "pending",
            created_at: "2026-09-21T21:19:44Z",
            updated_at: "2026-09-21T21:19:44Z",
          }),
          job({
            id: "job-1",
            status: "completed",
            documents_processed: 1,
            created_at: "2026-09-21T21:16:51Z",
            updated_at: "2026-09-21T21:23:04Z",
          }),
        ],
        documents: [document()],
        documentAnalyses: [analysis([finding()], "an-1")],
      }),
    );

    expect(result.state).toBe("completed");
    expect(result.job?.id).toBe("job-1");
  });

  it("задача, поставленная после готового разбора, снова показывает ожидание", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [
          job({
            id: "job-3",
            status: "pending",
            created_at: "2026-09-21T22:00:00Z",
            updated_at: "2026-09-21T22:00:00Z",
          }),
          job({
            id: "job-1",
            status: "completed",
            created_at: "2026-09-21T21:16:51Z",
            updated_at: "2026-09-21T21:23:04Z",
          }),
        ],
        documents: [document()],
      }),
    );

    expect(result.state).toBe("queued");
    expect(result.job?.id).toBe("job-3");
  });

  it("последняя по времени задача в работе важнее завершённой раньше", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [
          job({
            id: "job-1",
            status: "completed",
            updated_at: "2026-09-21T21:23:04Z",
          }),
          job({
            id: "job-2",
            status: "processing",
            updated_at: "2026-09-21T22:10:00Z",
          }),
        ],
        documents: [document()],
      }),
    );

    expect(result.state).toBe("analyzing");
    expect(result.job?.id).toBe("job-2");
  });

  it("собирает факторы из всех фрагментов и последнее изменение вердикта", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "completed" })],
        documents: [document()],
        documentAnalyses: [
          analysis([finding({ title: "Первый" })], "an-1"),
          analysis([finding({ title: "Второй" })], "an-2"),
        ],
        verdictHistory: [verdictRow()],
      }),
    );

    expect(result.findings.map((f) => f.title)).toEqual(["Первый", "Второй"]);
    expect(result.verdictChange).toEqual({
      from: null,
      to: "NOT_RECOMMENDED",
      reason: "Обнаружены блокирующие факторы: Отсутствие лицензии",
      at: "2026-09-21T21:05:00Z",
    });
  });

  it("считает документы с текстом и пропущенные отдельно", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "completed", documents_processed: 1 })],
        documents: [
          document(),
          skippedDocument({ id: "doc-2" }),
          skippedDocument({
            id: "doc-3",
            filename: "Йошкар Ола ПСД.part02.rar",
          }),
        ],
        documentAnalyses: [analysis([finding()], "an-1")],
      }),
    );

    expect(result.documentsWithText).toBe(1);
    expect(result.documentsSkipped).toBe(2);
    expect(result.detail).toBe(
      "Прочитан 1 файл из 3. Нашлось важного: 1. Каждое — с цитатой из документа." +
        " Документация прочитана не вся: пропущено 2 — детали в списке ниже.",
    );
  });

  it("обрезанный по бюджету документ попадает в итоговую строку", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "completed", documents_processed: 2 })],
        documents: [document(), truncatedDocument({ id: "doc-2" })],
        documentAnalyses: [
          analysis([finding()], "an-1"),
          analysis([finding()], "an-2"),
        ],
      }),
    );

    expect(result.documentsTruncated).toBe(1);
    expect(result.documentsSkipped).toBe(0);
    expect(result.detail).toBe(
      "Прочитано 2 файла из 2. Нашлось важного: 2. Каждое — с цитатой из документа." +
        " Документация прочитана не вся: обрезано 1 — детали в списке ниже.",
    );
  });

  it("пропуск и обрезка считаются в итоговой строке вместе", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "completed", documents_processed: 3 })],
        documents: [
          document(),
          truncatedDocument({ id: "doc-2" }),
          skippedDocument({ id: "doc-3" }),
        ],
        documentAnalyses: [analysis([finding()], "an-1")],
      }),
    );

    expect(result.documentsWithText).toBe(2);
    expect(result.detail).toBe(
      "Прочитано 2 файла из 3. Нашлось важного: 1. Каждое — с цитатой из документа." +
        " Документация прочитана не вся: пропущено 1, обрезано 1 — детали в списке ниже.",
    );
  });

  it("когда документация прочитана вся, итоговая строка без предупреждений", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "completed", documents_processed: 1 })],
        documents: [document()],
        documentAnalyses: [analysis([finding()], "an-1")],
      }),
    );

    expect(result.documentsTruncated).toBe(0);
    expect(result.detail).toBe(
      "Прочитан 1 файл из 1. Нашлось важного: 1. Каждое — с цитатой из документа.",
    );
  });

  it("в ожидании разбора говорит, сколько файлов не будет прочитано", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "pending" })],
        documents: [document(), skippedDocument({ id: "doc-2" })],
      }),
    );

    expect(result.detail).toBe(
      "Прочитан 1 файл из 2. Остальные не читаются — причина по каждому в списке" +
        " ниже. Выводы будут построены только на прочитанном.",
    );
  });

  it("во время разбора в работе только документы с текстом", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "processing" })],
        documents: [document(), skippedDocument({ id: "doc-2" })],
      }),
    );

    expect(result.detail).toBe("Документов в работе: 1, пропущено 1.");
  });

  it("когда все файлы пропущены, не выдаёт это за разбор документации", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "completed", documents_processed: 2 })],
        documents: [
          skippedDocument({ id: "doc-2" }),
          skippedDocument({
            id: "doc-3",
            filename: "Йошкар Ола ПСД.part02.rar",
          }),
        ],
      }),
    );

    expect(result.state).toBe("completed");
    expect(result.documentsWithText).toBe(0);
    expect(result.detail).toBe(
      "Текста нет ни в одном из 2 файлов — причина по каждому в списке документов.",
    );
  });
});

/**
 * Категории на экране обязаны совпадать с категориями, которые учитывает вердикт.
 *
 * Движок вердикта понижает типовые условия допуска до требования
 * (`demoteUniversalBlockers` внутри `applyDocumentFindings`), а в базе лежат
 * категории ровно так, как их назвала модель. Если путь чтения их не понижает,
 * карточка показывает «Блокеры: 1» рядом с вердиктом RECOMMENDED — факты и
 * выводы расходятся, и объяснить вердикт нельзя.
 */
describe("summarizeDeepAnalysis — категории согласованы с вердиктом", () => {
  /** Типовое условие допуска: его выполняет любая действующая компания. */
  const universal = finding({
    category: "blocker",
    severity: "high",
    title: "Отсутствие сведений в реестре недобросовестных поставщиков",
    detail: "Участник закупки не должен находиться в РНП",
    evidence_quote:
      "Сведения об участнике отсутствуют в реестре недобросовестных поставщиков",
    evidence_section: "Раздел 2. Требования к участникам",
  });

  /** Настоящий блокер: сверяется с профилем компании и движок его не понижает. */
  const real = finding({
    category: "blocker",
    severity: "high",
    title: "Требуется лицензия ФСБ России",
    detail: "Работы связаны с доступом к сведениям, составляющим гостайну",
    evidence_quote:
      "Наличие лицензии ФСБ России на проведение работ со сведениями, составляющими государственную тайну",
    evidence_section: "Раздел 2. Требования к участникам",
  });

  it("типовое условие допуска не показывается вовсе: ни блокером, ни требованием", () => {
    const summary = summarizeDeepAnalysis(
      input({ documentAnalyses: [analysis([universal])] }),
    );

    // Раньше здесь ожидалось «requirement»: РНП показывался требованием. Теперь это
    // норма закона (findingNoise.ts) — в списке нет совсем, а в allFindings понижение сохранено.
    expect(summary.findings).toEqual([]);
    expect(summary.findingGroups).toEqual([]);
    expect(summary.allFindings?.[0]?.category).toBe("requirement");
  });

  it("вердикт по такому фактору не ухудшается", () => {
    const summary = summarizeDeepAnalysis(
      input({ documentAnalyses: [analysis([universal])] }),
    );
    const verdict = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      findings: summary.findings,
    });

    expect(verdict.verdict).toBe("RECOMMENDED");
    expect(verdict.worsened).toBe(false);
  });

  it("настоящий блокер остаётся блокером и на экране, и в вердикте", () => {
    const summary = summarizeDeepAnalysis(
      input({ documentAnalyses: [analysis([real])] }),
    );
    const verdict = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      findings: summary.findings,
    });

    expect(summary.findings[0]?.category).toBe("blocker");
    expect(summary.findingGroups.map((group) => group.category)).toEqual([
      "blocker",
    ]);
    expect(verdict.verdict).toBe("NOT_RECOMMENDED");
  });

  it("находка не переписывается: цитата и раздел сохраняются", () => {
    const summary = summarizeDeepAnalysis(
      input({ documentAnalyses: [analysis([universal])] }),
    );

    expect(summary.allFindings?.[0]?.evidence_quote).toBe(universal.evidence_quote);
    expect(summary.allFindings?.[0]?.evidence_section).toBe(
      universal.evidence_section,
    );
    expect(summary.allFindings?.[0]?.title).toBe(universal.title);
  });

  it("входной массив базы не меняется: правило возвращает копию", () => {
    const stored: AnalysisFinding[] = [universal];
    summarizeDeepAnalysis(input({ documentAnalyses: [analysis(stored)] }));

    expect(stored[0]?.category).toBe("blocker");
  });
});

describe("documentSkipMark", () => {
  it("читает признак пропуска из raw_json", () => {
    expect(
      documentSkipMark(
        skippedDocument({
          code: "over_char_budget",
          reason: "Файл не уложился в бюджет знаков.",
        }),
      ),
    ).toEqual({
      code: "over_char_budget",
      reason: "Файл не уложился в бюджет знаков.",
    });
  });

  it("строку воркера с широким raw_json разбирает так же", () => {
    // Аргумент — unknown: функция нужна и домену, и воркеру, а TenderDocumentRow
    // описывает JSONB как Record<string, unknown>, не как DocumentRawJson.
    const row = {
      raw_json: {
        chars: 0,
        skipped: { code: "empty_text", reason: "Скан без текстового слоя" },
      },
    };

    expect(documentSkipMark(row)).toEqual({
      code: "empty_text",
      reason: "Скан без текстового слоя",
    });
  });

  it("без признака пропуска возвращает null", () => {
    expect(documentSkipMark(document())).toBeNull();
    expect(documentSkipMark({ raw_json: null })).toBeNull();
    expect(
      documentSkipMark({ raw_json: { title: "Извещение", chars: 431_208 } }),
    ).toBeNull();
  });

  it("мусор в raw_json пропуском не считается", () => {
    expect(documentSkipMark({ raw_json: "строка" })).toBeNull();
    expect(documentSkipMark({ raw_json: { skipped: "не объект" } })).toBeNull();
    expect(
      documentSkipMark({ raw_json: { skipped: { code: "file_too_large" } } }),
    ).toBeNull();
    expect(
      documentSkipMark({
        raw_json: { skipped: { code: 5, reason: "причина" } },
      }),
    ).toBeNull();
  });

  it("неизвестный код пропуском не считается", () => {
    // Опечатка в коде не должна превращать строку в «Пропущен»: воркер тогда
    // перестанет качать файл, а партнёр не увидит перевода причины.
    expect(
      documentSkipMark({
        raw_json: { skipped: { code: "over_budget", reason: "причина" } },
      }),
    ).toBeNull();
  });
});

describe("documentTruncation", () => {
  it("читает признак обрезки из raw_json", () => {
    expect(documentTruncation(truncatedDocument())).toEqual({ archive: null });
  });

  it("возвращает счётчик архива, когда он записан", () => {
    expect(
      documentTruncation(
        truncatedDocument({ archive: { parsed: 2, total: 15 } }),
      ),
    ).toEqual({ archive: { parsed: 2, total: 15 } });
  });

  it("без признака обрезки возвращает null", () => {
    expect(documentTruncation(document())).toBeNull();
    expect(documentTruncation({ raw_json: null })).toBeNull();
    expect(documentTruncation({ raw_json: { chars: 40_092 } })).toBeNull();
    // false писать в базу незачем, но прочитать её должны как «не обрезано».
    expect(documentTruncation({ raw_json: { truncated: false } })).toBeNull();
  });

  it("мусор в raw_json обрезкой не считается", () => {
    expect(documentTruncation({ raw_json: "строка" })).toBeNull();
    expect(documentTruncation({ raw_json: { truncated: "да" } })).toBeNull();
  });

  it("битый счётчик архива отбрасывается, а не подменяется нулём", () => {
    // «прочитано 0 из 0 файлов» звучит хуже, чем просто «обрезано».
    expect(
      documentTruncation({ raw_json: { truncated: true, archive: "мусор" } }),
    ).toEqual({
      archive: null,
    });
    expect(
      documentTruncation({
        raw_json: { truncated: true, archive: { parsed: 2 } },
      }),
    ).toEqual({ archive: null });
    expect(
      documentTruncation({
        raw_json: { truncated: true, archive: { parsed: 2, total: null } },
      }),
    ).toEqual({ archive: null });
    expect(
      documentTruncation({
        raw_json: {
          truncated: true,
          archive: { parsed: 2, total: Number.NaN },
        },
      }),
    ).toEqual({ archive: null });
  });

  it("пропущенное вложение не считается обрезанным", () => {
    // Пропуск и обрезка — разные решения обхода: файл не качали вовсе против
    // прочитали частично. В raw_json пропущенной строки truncated нет.
    expect(documentTruncation(skippedDocument())).toBeNull();
  });
});

describe("groupDocuments", () => {
  it("документы с текстом идут первыми в порядке загрузки", () => {
    const groups = groupDocuments([
      skippedDocument({ id: "doc-2" }),
      document({ id: "doc-1", filename: "print-form-1.html" }),
      document({ id: "doc-3", filename: "Проект контракта.docx" }),
    ]);

    expect(groups.map((group) => group.document.filename)).toEqual([
      "print-form-1.html",
      "Проект контракта.docx",
      "Йошкар Ола ПСД.part01.rar",
    ]);
    expect(groups[0]?.skipped).toBeNull();
    expect(groups[2]?.skipped?.code).toBe("file_too_large");
  });

  it("одинаковые причины схлопываются, скрытые строки считаются", () => {
    const groups = groupDocuments([
      skippedDocument({ id: "doc-2", filename: "Йошкар Ола ПСД.part01.rar" }),
      skippedDocument({ id: "doc-3", filename: "Йошкар Ола ПСД.part02.rar" }),
      skippedDocument({ id: "doc-4", filename: "Йошкар Ола ПСД.part03.rar" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.document.filename).toBe("Йошкар Ола ПСД.part01.rar");
    expect(groups[0]?.hidden).toBe(2);
  });

  it("разные причины остаются отдельными строками", () => {
    const groups = groupDocuments([
      skippedDocument({
        id: "doc-2",
        code: "empty_text",
        reason: "Скан без текстового слоя",
      }),
      skippedDocument({
        id: "doc-3",
        filename: "Смета.xls",
        code: "unsupported_format",
        reason: "Формат не читается",
      }),
    ]);

    expect(groups.map((group) => group.hidden)).toEqual([0, 0]);
    expect(groups.map((group) => group.skipped?.reason)).toEqual([
      "Скан без текстового слоя",
      "Формат не читается",
    ]);
  });

  it("пустой список даёт пустой результат", () => {
    expect(groupDocuments([])).toEqual([]);
  });

  it("обрезка передаётся в строку документа", () => {
    const groups = groupDocuments([
      document({ id: "doc-1" }),
      truncatedDocument({ id: "doc-2", archive: { parsed: 2, total: 15 } }),
      skippedDocument({ id: "doc-3" }),
    ]);

    expect(groups.map((group) => group.truncated)).toEqual([
      null,
      { archive: { parsed: 2, total: 15 } },
      null,
    ]);
    // Схлопнутая группа пропусков строится из первой строки, у которой обрезки
    // не было по определению: файл не качали вовсе.
    expect(groups.map((group) => group.hidden)).toEqual([0, 0, 0]);
  });
});

describe("groupFindings", () => {
  it("категории идут от блокирующих к нейтральным, пустые не показываются", () => {
    const groups = groupFindings([
      finding({ category: "neutral" }),
      finding({ category: "blocker" }),
      finding({ category: "requirement" }),
    ]);

    expect(groups.map((g) => g.category)).toEqual([
      "blocker",
      "requirement",
      "neutral",
    ]);
  });

  it("внутри категории важные факторы идут первыми", () => {
    const groups = groupFindings([
      finding({ severity: "low", title: "Мелочь" }),
      finding({ severity: "high", title: "Критично" }),
      finding({ severity: "medium", title: "Средне" }),
    ]);

    expect(groups[0]?.findings.map((f) => f.title)).toEqual([
      "Критично",
      "Средне",
      "Мелочь",
    ]);
  });

  it("пустой список даёт пустой результат", () => {
    expect(groupFindings([])).toEqual([]);
  });
});

describe("documentVerdictChange", () => {
  it("игнорирует решения, принятые не разбором документации", () => {
    const change = documentVerdictChange([
      verdictRow({
        triggered_by: "manual_override",
        new_verdict: "RECOMMENDED",
      }),
      verdictRow({ id: "vh-2", triggered_by: "document_analysis" }),
    ]);

    expect(change?.to).toBe("NOT_RECOMMENDED");
  });

  it("без записей от разбора возвращает null", () => {
    expect(
      documentVerdictChange([
        verdictRow({ triggered_by: "metadata_analysis" }),
      ]),
    ).toBeNull();
  });
});

/**
 * Формулировки для партнёра, а не для разработчика.
 *
 * Живой пример, на котором это вылезло: закупка 32616411271 — три файла, из них
 * прочитана только карточка закупки на 7 КБ, а два тома .rar с настоящей
 * документацией пропущены. Панель писала «Документация загружена, ждём разбор»
 * и «Документов в базе: 1, пропущено 2» — из этого партнёр делает вывод, что
 * документы прочитаны, хотя прочитана треть, и не та.
 */
describe("summarizeDeepAnalysis — понятность формулировок", () => {
  it("в очереди считает файлы, а не строки базы", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job()],
        documents: [
          document(),
          skippedDocument({ id: "s1" }),
          skippedDocument({ id: "s2" }),
        ],
      }),
    );

    expect(result.state).toBe("queued");
    expect(result.detail).toContain("1 файл из 3");
    expect(result.detail).not.toContain("в базе");
  });

  it("в очереди не обещает срок, которого не контролирует", () => {
    const result = summarizeDeepAnalysis(
      input({ jobs: [job()], documents: [document()] }),
    );

    expect(result.detail).not.toContain("в ближайшие минуты");
  });

  it("говорит прямо, когда прочитана меньшая часть файлов", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job()],
        documents: [
          document(),
          skippedDocument({ id: "s1" }),
          skippedDocument({ id: "s2" }),
        ],
      }),
    );

    expect(result.title).toMatch(/прочитан/i);
    expect(result.title).not.toBe("Документация загружена, ждём разбор");
  });

  it("не называет прочитанным то, что прочитано целиком", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job()],
        documents: [document(), document({ id: "doc-2" })],
      }),
    );

    expect(result.title).toBe("Документация прочитана, ждём разбор");
    expect(result.detail).toContain("2 файла из 2");
  });

  it("в завершённом разборе не говорит «фрагментов» и «факторов»", () => {
    const result = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "completed" })],
        documents: [document()],
        documentAnalyses: [analysis([finding()])],
      }),
    );

    expect(result.state).toBe("completed");
    expect(result.detail).not.toContain("фрагментов");
    expect(result.detail).not.toContain("факторов");
  });
});

/**
 * Состав архива виден независимо от обрезки.
 *
 * Живой случай — закупка 32616404461: «408_2026_Документация_ОЗО.zip» на 7,1 МБ
 * дал 662 910 знаков и в бюджет уложился, то есть обрезки нет. Но сколько файлов
 * внутри архива действительно стало текстом, а сколько оказалось сканами, по
 * записи было не узнать вовсе: отчёт по входам писался только при обрезке.
 */
describe("documentArchive", () => {
  it("читает состав архива у непрочитанного целиком файла", () => {
    const row = {
      raw_json: { chars: 662_910, archive: { parsed: 12, total: 40 } },
    };

    expect(documentArchive(row)).toEqual({ parsed: 12, total: 40 });
  });

  it("читает состав и когда обрезка есть", () => {
    const row = {
      raw_json: { truncated: true, archive: { parsed: 2, total: 15 } },
    };

    expect(documentArchive(row)).toEqual({ parsed: 2, total: 15 });
  });

  it("у обычного файла состава нет", () => {
    expect(documentArchive({ raw_json: { chars: 100 } })).toBeNull();
    expect(documentArchive({ raw_json: null })).toBeNull();
  });

  it("битую запись состава не придумывает", () => {
    expect(
      documentArchive({ raw_json: { archive: { parsed: "две", total: 15 } } }),
    ).toBeNull();
  });
});

/**
 * Отпечаток состояния: изменилось ли что-нибудь с прошлой проверки.
 *
 * Нужен кнопке «Обновить статус». Без него нажатие на неё, когда состояние не
 * поменялось, выглядит так, будто кнопка сломана: запрос уходит, ответ тот же,
 * на экране не двигается ничего.
 */
describe("deepAnalysisFingerprint", () => {
  const state = (
    over: Partial<Parameters<typeof deepAnalysisFingerprint>[0]> = {},
  ) => ({
    jobs: [],
    documents: [],
    documentAnalyses: [],
    ...over,
  });

  it("одинаковое состояние даёт одинаковый отпечаток", () => {
    const first = deepAnalysisFingerprint(state({ jobs: [job()] }));
    const second = deepAnalysisFingerprint(state({ jobs: [job()] }));

    expect(first).toBe(second);
  });

  it("смена статуса задачи меняет отпечаток", () => {
    const before = deepAnalysisFingerprint(
      state({ jobs: [job({ status: "pending" })] }),
    );
    const after = deepAnalysisFingerprint(
      state({ jobs: [job({ status: "completed" })] }),
    );

    expect(before).not.toBe(after);
  });

  it("новый документ меняет отпечаток", () => {
    const before = deepAnalysisFingerprint(state({ documents: [document()] }));
    const after = deepAnalysisFingerprint(
      state({ documents: [document(), document({ id: "doc-2" })] }),
    );

    expect(before).not.toBe(after);
  });

  it("перечитанный документ меняет отпечаток, даже если их столько же", () => {
    const before = deepAnalysisFingerprint(
      state({ documents: [document({ parsed_status: "pending" })] }),
    );
    const after = deepAnalysisFingerprint(
      state({ documents: [document({ parsed_status: "parsed" })] }),
    );

    expect(before).not.toBe(after);
  });

  it("новый разобранный фрагмент меняет отпечаток", () => {
    const before = deepAnalysisFingerprint(state({ documentAnalyses: [] }));
    const after = deepAnalysisFingerprint(
      state({ documentAnalyses: [analysis([finding()])] }),
    );

    expect(before).not.toBe(after);
  });
});

describe("summarizeDeepAnalysis: сводка по всем документам", () => {
  const sro = finding({
    category: "blocker",
    title: "Обязательное членство в СРО",
    evidence_quote: "Участник закупки должен являться членом саморегулируемой организации",
    requirement_kind: "SRO",
  });

  it("есть сводка — выводы из неё, построчные разборы в выводы не идут, фрагменты считаются без неё", () => {
    const consolidated = {
      ...analysis([], "an-c"),
      document_id: null as unknown as string,
      analysis: {
        kind: "consolidated",
        summary: "Участвовать можно",
        findings: [{ ...finding({ title: "Гарантия 60 месяцев" }), sources: ["ТЗ.docx", "Проект контракта.docx"] }],
        conflicts: [{ topic: "Срок", values: [], resolution: "до 20.11", needs_question: false }],
        questions: ["Уточните срок"],
        facts: {},
      } as never,
    };
    const summary = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "completed" })],
        documents: [document()],
        documentAnalyses: [analysis([sro, finding()]), consolidated],
      }),
    );

    expect(summary.findings.map((f) => f.title)).toEqual(["Гарантия 60 месяцев"]);
    expect(summary.consolidation?.questions).toEqual(["Уточните срок"]);
    expect(summary.chunksAnalyzed).toBe(1);
  });

  it("сводки нет — к построчным выводам применяется закон: СРО при НМЦК до 10 млн не блокер", () => {
    const summary = summarizeDeepAnalysis(
      input({
        jobs: [job({ status: "completed" })],
        documents: [document()],
        documentAnalyses: [analysis([sro])],
        price: 9_831_629.07,
      }),
    );

    expect(summary.consolidation).toBeNull();
    expect(summary.findings[0]?.category).toBe("risk");
    expect(summary.findingGroups.map((g) => g.category)).not.toContain("blocker");
  });
});

describe("summarizeDeepAnalysis — норма закона и обычай не находка (findingNoise.ts)", () => {
  const rnp = finding({
    category: "blocker",
    severity: "high",
    title: "Отсутствие в реестре недобросовестных поставщиков",
    evidence_quote: "участник не должен состоять в РНП",
  });
  const foreignAgent = finding({
    category: "blocker",
    severity: "high",
    title: "Отсутствие статуса иностранного агента",
    evidence_quote: "участник не является иностранным агентом",
  });
  const vat = finding({ title: "НДС 22%", evidence_quote: "цена включает НДС 22 %" });
  const treasury = finding({
    severity: "high",
    title: "Казначейское сопровождение аванса",
    evidence_quote: "аванс подлежит казначейскому сопровождению",
  });
  const unilateral = finding({
    title: "Возможность одностороннего отказа заказчика",
    evidence_quote: "Заказчик вправе принять решение об одностороннем отказе от исполнения контракта",
  });
  const payment30 = finding({
    category: "neutral",
    severity: "low",
    title: "Срок оплаты",
    evidence_quote: "оплата в течение 30 рабочих дней с даты подписания акта",
  });
  const winter = finding({
    category: "risk",
    severity: "medium",
    title: "Работы в зимний период",
    evidence_quote: "работы выполняются с ноября по март",
  });
  const noise = [rnp, foreignAgent, vat, treasury, unilateral, payment30, winter];

  it("44-ФЗ: в выводах остаётся отклонение и существенное, типовое схлопнуто в строку", () => {
    const summary = summarizeDeepAnalysis(
      input({ law: "FZ_44", documentAnalyses: [analysis(noise)] }),
    );

    expect(summary.findings.map((f) => f.title).sort()).toEqual(["Работы в зимний период", "Срок оплаты"].sort());
    const payment = summary.findings.find((f) => f.title === "Срок оплаты");
    // Оплата дольше закона поднята до высокого риска, со ссылкой на жалобу в ФАС.
    expect(payment?.category).toBe("risk");
    expect(payment?.severity).toBe("high");
    expect((payment as { legal_note?: string }).legal_note).toMatch(/ФАС/);
    expect(summary.standardLine).toBe(
      "Типовые условия 44-ФЗ без отклонений: односторонний отказ заказчика (ч. 9 ст. 95), казначейское сопровождение аванса.",
    );
    // До чистки находки доступны блокам фактов («Деньги», «Сроки»).
    expect(summary.allFindings).toHaveLength(noise.length);
  });

  it("223-ФЗ: казначейство и односторонний отказ остаются рисками, а РНП и НДС убраны", () => {
    const summary = summarizeDeepAnalysis(
      input({ law: "FZ_223", documentAnalyses: [analysis(noise)] }),
    );

    expect(summary.findings.map((f) => f.title)).toEqual([
      "Казначейское сопровождение аванса",
      "Возможность одностороннего отказа заказчика",
      "Срок оплаты",
      "Работы в зимний период",
    ]);
    expect(summary.standardLine).toBeNull();
  });

  it("без закона типовое допуска убрано, а условия договора не трогаются", () => {
    const summary = summarizeDeepAnalysis(input({ documentAnalyses: [analysis(noise)] }));
    expect(summary.findings.map((f) => f.title)).not.toContain("НДС 22%");
    expect(summary.findings.map((f) => f.title)).toContain("Казначейское сопровождение аванса");
    expect(summary.standardLine).toBeNull();
  });

  it("строка «без отклонений» собирается и из разборов документов, когда сводка типовое не включила", () => {
    const consolidated = {
      ...analysis([winter], "an-c"),
      document_id: null,
      analysis: {
        kind: "consolidated",
        summary: "Сводка",
        findings: [{ ...winter, sources: ["Проект контракта"] }],
        conflicts: [],
        questions: [],
        facts: {},
      },
    } as unknown as DocumentAnalysisRow;
    const summary = summarizeDeepAnalysis(
      input({ law: "FZ_44", documentAnalyses: [analysis([treasury, unilateral]), consolidated] }),
    );

    expect(summary.findings.map((f) => f.title)).toEqual(["Работы в зимний период"]);
    expect(summary.standardLine).toMatch(/казначейское сопровождение/);
    expect(summary.standardLine).toMatch(/односторонний отказ/);
  });

  it("вердикт: типовое по 44-ФЗ его не ухудшает, а нарушение закона об оплате — ухудшает", () => {
    const typical = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      findings: [rnp, foreignAgent, treasury, vat],
      law: "FZ_44",
    });
    expect(typical.verdict).toBe("RECOMMENDED");
    expect(typical.worsened).toBe(false);

    // Без закона казначейство «high» по-прежнему считается рисками договора.
    const unknownLaw = applyDocumentFindings({ currentVerdict: "RECOMMENDED", findings: [treasury] });
    expect(unknownLaw.verdict).toBe("MANUAL_REVIEW");

    const violation = applyDocumentFindings({
      currentVerdict: "RECOMMENDED",
      findings: [payment30],
      law: "FZ_44",
    });
    expect(violation.verdict).toBe("MANUAL_REVIEW");
    expect(violation.reason).toMatch(/Срок оплаты/);
  });
});
