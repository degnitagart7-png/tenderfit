import { describe, expect, it, vi, type Mock } from "vitest";
import type { ParsedAttachment } from "@/services/attachmentParser";
import { eis44DocumentsTabUrl } from "@/services/eisAttachments";
import type { FetchedFile, ParseAttachment } from "@/services/tenderAttachmentsFetcher";
import {
  ensureTenderDocuments,
  occupiedChars,
  type DocumentRecord,
  type PreparedDocument,
  type TenderDocumentSource,
  type TenderDocumentSyncDeps,
} from "@/services/tenderDocumentSync";
import { eisPrintFormUrl } from "@/services/tenderDocumentsFetcher";
import type { ParsedStatus } from "@/types/database";

/**
 * Одна закупка целиком: извещение плюс вложения.
 *
 * Сети и парсеров здесь нет — они приходят портами, поэтому проверяется порядок
 * обхода, общий бюджет знаков и идемпотентность. Разметка вкладки документов
 * скопирована с настоящей страницы 44-ФЗ (подробнее в eisAttachments.test.ts);
 * идентификаторы файлов в ЕИС шестнадцатеричные, это учитывает шаблон поиска.
 */

const REG_NUMBER = "0573100026626000009";
const NOTICE_FILENAME = `print-form-${REG_NUMBER}.html`;
const TAB_URL = eis44DocumentsTabUrl(REG_NUMBER, "ELECTRONIC_AUCTION");

const TARGET: TenderDocumentSource = {
  regNumber: REG_NUMBER,
  law: "FZ_44",
  dataSource: "EIS",
  placingWay: "ELECTRONIC_AUCTION",
};

/** Текст длиннее порога полезности, чтобы страница не считалась пустой. */
const NOTICE_TEXT = "Извещение о проведении электронного аукциона. ".repeat(20).trim();
const NOTICE_HTML = `<html><body><p>${NOTICE_TEXT}</p></body></html>`;
/** Столько знаков даст htmlToText: последний пробел строки он обрезает. */
const NOTICE_CHARS = NOTICE_TEXT.length;

/** Строка вкладки документов 44-ФЗ: имя файла в атрибуте `title` якоря. */
function fileRow(name: string, uid: string): string {
  return `
<div class="attachment row ">
  <div class="col clipText">
    <span class="section__value">
      <a href="https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=${uid}"
         title="${name}">${name.replace(/\.[a-z0-9]+$/i, "")}</a>
    </span>
  </div>
</div>`;
}

type TabFile = readonly [name: string, uid: string];

function documentsTab(files: readonly TabFile[]): string {
  return `<html><body>${files.map(([name, uid]) => fileRow(name, uid)).join("")}</body></html>`;
}

/** Три вложения разных приоритетов: прочее, техзадание, проект контракта. */
const THREE_ATTACHMENTS: readonly TabFile[] = [
  ["Разъяснение положений документации.pdf", "AA01"],
  ["Описание объекта закупки.docx", "AA02"],
  ["Проект контракта.docx", "AA03"],
];

type FetchHtmlMock = Mock<[url: string], Promise<string>>;
type FetchFileMock = Mock<[url: string], Promise<FetchedFile>>;
type ParseMock = Mock<
  [bytes: Uint8Array, filename: string, contentType: string | null, budgetChars: number],
  Promise<ParsedAttachment>
>;

interface Harness {
  saved: PreparedDocument[];
  stored: DocumentRecord[];
  lookups: string[];
  deps: TenderDocumentSyncDeps & {
    lookup: { findByRegNumber: Mock<[string], Promise<TenderDocumentSource | null>> };
    store: {
      list: Mock<[string], Promise<DocumentRecord[]>>;
      save: Mock<[string, PreparedDocument], Promise<void>>;
    };
    fetchHtml: FetchHtmlMock;
    fetchFile: FetchFileMock;
    parse: ParseMock;
  };
}

interface HarnessOptions {
  target?: TenderDocumentSource | null;
  stored?: DocumentRecord[];
  noticeHtml?: string;
  files?: readonly TabFile[];
  /** Ошибка при загрузке любой страницы: и извещения, и вкладки документов. */
  fetchError?: Error;
  /** Ошибка при загрузке вкладки документов; извещение при этом отдаётся. */
  tabError?: Error;
  saveError?: Error;
  fileBytes?: number;
  /** Сколько знаков текста даёт парсер; по умолчанию 100 в пределах бюджета. */
  parsedChars?: number;
  parsed?: (filename: string) => ParsedAttachment;
  tooLarge?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const state = {
    saved: [] as PreparedDocument[],
    stored: options.stored ? [...options.stored] : [],
    lookups: [] as string[],
    deps: undefined as unknown as Harness["deps"],
  };

  const pages: Record<string, string> = {
    [eisPrintFormUrl(REG_NUMBER)]: options.noticeHtml ?? NOTICE_HTML,
    [TAB_URL]: documentsTab(options.files ?? THREE_ATTACHMENTS),
  };

  const fetchHtml = vi.fn(async (url: string): Promise<string> => {
    if (options.fetchError) throw options.fetchError;
    if (options.tabError && url === TAB_URL) throw options.tabError;
    return pages[url] ?? "";
  }) as unknown as FetchHtmlMock;

  const fetchFile = vi.fn(async (_url: string): Promise<FetchedFile> => ({
    bytes: new Uint8Array(options.fileBytes ?? 4096),
    contentType: "application/download",
    tooLarge: options.tooLarge,
  })) as unknown as FetchFileMock;

  const parse = vi.fn(
    async (
      _bytes: Uint8Array,
      filename: string,
      _contentType: string | null,
      budgetChars: number,
    ): Promise<ParsedAttachment> => {
      if (options.parsed) return options.parsed(filename);
      const chars = Math.min(options.parsedChars ?? 100, budgetChars);
      return { text: "ы".repeat(chars), status: "parsed", reason: null, truncated: false };
    },
  ) as unknown as ParseMock;

  const deps = {
    lookup: {
      findByRegNumber: vi.fn(async (regNumber: string) => {
        state.lookups.push(regNumber);
        return options.target === undefined ? TARGET : options.target;
      }),
    },
    store: {
      list: vi.fn(async (_regNumber: string) => state.stored),
      save: vi.fn(async (_regNumber: string, document: PreparedDocument) => {
        if (options.saveError) throw options.saveError;
        state.saved.push(document);
        const status: ParsedStatus = document.skipped === null ? "parsed" : "failed";
        state.stored = [
          ...state.stored,
          {
            filename: document.filename,
            parsedStatus: status,
            chars: document.chars,
            fileSize: document.fileSize,
          },
        ];
      }),
    },
    fetchHtml,
    fetchFile,
    parse,
  };

  state.deps = deps as Harness["deps"];
  return state as Harness;
}

/** Имена, которые ушли в запись, по порядку обхода. */
function savedNames(state: Harness): string[] {
  return state.saved.map((document) => document.filename);
}

/** Бюджеты знаков, с которыми синхронизация вызывала парсер. */
function parseBudgets(state: Harness): number[] {
  return state.deps.parse.mock.calls.map((call) => call[3]);
}

/** Адреса, которые синхронизация запрашивала как страницы. */
function requestedPages(state: Harness): string[] {
  return state.deps.fetchHtml.mock.calls.map((call) => call[0]);
}

function record(filename: string, extra: Partial<DocumentRecord> = {}): DocumentRecord {
  return { filename, parsedStatus: "parsed", chars: null, fileSize: null, ...extra };
}

/** Вложение, которое парсер не смог прочитать. */
const EMPTY_SCAN = {
  text: "",
  status: "empty" as const,
  reason: "В файле нет текстового слоя.",
  truncated: false,
};

describe("ensureTenderDocuments: извещение", () => {
  it("ищет закупку в БД по реестровому номеру и сохраняет текст извещения", async () => {
    const state = harness({ files: [] });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(state.lookups).toEqual([REG_NUMBER]);
    expect(requestedPages(state)).toContain(eisPrintFormUrl(REG_NUMBER));
    expect(outcome.status).toBe("saved");

    const notice = state.saved[0];
    expect(notice?.filename).toBe(NOTICE_FILENAME);
    // Хэш содержимого считается здесь, а не в репозитории: это доменная логика кэша.
    expect(notice?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(notice?.chars).toBe(NOTICE_CHARS);
    expect(notice?.skipped).toBeNull();
    // Извещение — не файл, его объёма в байтах источник не отдаёт.
    expect(notice?.fileSize).toBeNull();
  });

  it("не ходит в сеть за извещением повторно, если текст уже лежит в БД", async () => {
    const state = harness({ stored: [record(NOTICE_FILENAME, { chars: NOTICE_CHARS })] });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(outcome.status).toBe("saved");
    expect(requestedPages(state)).toEqual([TAB_URL]);
    expect(savedNames(state)).not.toContain(NOTICE_FILENAME);
  });

  it("документ со статусом failed не считается готовым: пробуем снова", async () => {
    const state = harness({
      files: [],
      stored: [{ ...record(NOTICE_FILENAME), parsedStatus: "failed" }],
    });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(outcome.status).toBe("saved");
    expect(savedNames(state)).toEqual([NOTICE_FILENAME]);
  });

  it("страница извещения без полезного текста не мешает вложениям", async () => {
    const state = harness({
      noticeHtml: "<html><body>Страница не найдена</body></html>",
      files: [["Проект контракта.docx", "AA03"]],
    });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(outcome.status).toBe("saved");
    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    expect(outcome.filenames).toEqual(["Проект контракта.docx"]);
    expect(outcome.note).toMatch(/Недостаточно текста/);
  });

  it("сетевая ошибка возвращается причиной и не бросается наружу", async () => {
    const state = harness({ fetchError: new Error("fetch failed (ETIMEDOUT)") });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("ожидался статус unavailable");
    expect(outcome.reason).toContain("ETIMEDOUT");
    expect(state.saved).toHaveLength(0);
  });

  it("ошибка репозитория при сохранении не бросается наружу", async () => {
    const state = harness({ saveError: new Error("violates check constraint") });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("ожидался статус failed");
    expect(outcome.reason).toContain("check constraint");
  });

  it("закупки нет в tenders — это not_found, а не ошибка", async () => {
    const state = harness({ target: null });

    const outcome = await ensureTenderDocuments("99999999999", state.deps);

    expect(outcome.status).toBe("not_found");
    expect(state.deps.fetchHtml).not.toHaveBeenCalled();
  });
});

describe("ensureTenderDocuments: вложения", () => {
  it("читает вкладку документов и сохраняет вложения вместе с извещением", async () => {
    const state = harness();

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(requestedPages(state)).toEqual([eisPrintFormUrl(REG_NUMBER), TAB_URL]);
    expect(outcome.status).toBe("saved");
    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    // Порядок задаёт приоритет, а не строка на странице: контракт первым.
    expect(outcome.filenames).toEqual([
      NOTICE_FILENAME,
      "Проект контракта.docx",
      "Описание объекта закупки.docx",
      "Разъяснение положений документации.pdf",
    ]);
    expect(outcome.characters).toBe(NOTICE_CHARS + 300);
    expect(outcome.skipped).toBe(0);
    expect(outcome.note).toBeNull();
  });

  it("пропущенное вложение пишется той же строкой, с причиной и без хэша", async () => {
    const state = harness({
      files: [["Скан без слоя.pdf", "AA04"]],
      parsed: () => EMPTY_SCAN,
    });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    const skippedDocument = state.saved.find((item) => item.filename === "Скан без слоя.pdf");
    expect(skippedDocument?.skipped).toEqual({
      code: "empty_text",
      reason: "В файле нет текстового слоя.",
    });
    expect(skippedDocument?.contentHash).toBeNull();
    expect(skippedDocument?.chars).toBe(0);
    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    expect(outcome.skipped).toBe(1);
  });

  it("том многотомного архива не скачивается вовсе", async () => {
    const state = harness({ files: [["ПСД том 1.part1.rar", "AA06"]] });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    const skippedDocument = state.saved.find((item) => item.filename === "ПСД том 1.part1.rar");
    expect(skippedDocument?.skipped?.code).toBe("unsupported_format");
    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    expect(outcome.skipped).toBe(1);
  });

  it("недоступная вкладка документов не отменяет сохранённое извещение", async () => {
    const state = harness({ tabError: new Error("404 Not Found") });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(outcome.status).toBe("saved");
    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    expect(outcome.filenames).toEqual([NOTICE_FILENAME]);
    expect(outcome.note).toContain("вкладку документов");
  });

  it("для Сбербанк-АСТ честно возвращает причину и ничего не пишет", async () => {
    const state = harness({
      target: {
        regNumber: "SBR028-2609080053",
        law: "COMMERCIAL",
        dataSource: "SBER_AST",
        placingWay: null,
      },
    });

    const outcome = await ensureTenderDocuments("SBR028-2609080053", state.deps);

    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("ожидался статус unavailable");
    expect(outcome.reason).toMatch(/Сбербанк-АСТ/);
    expect(state.deps.fetchHtml).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(0);
  });

  it("закупку Контур.Закупок обслуживает ЕИС: номер извещения у них один", async () => {
    const state = harness({ target: { ...TARGET, dataSource: "KONTUR" } });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(outcome.status).toBe("saved");
    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    // Обход тот же, что для строки ЕИС: агрегатор отдаёт номер извещения ЕИС,
    // а файлы в его карточке — ссылки на filestore zakupki.gov.ru.
    expect(requestedPages(state)).toEqual([eisPrintFormUrl(REG_NUMBER), TAB_URL]);
    expect(savedNames(state)).toEqual([
      NOTICE_FILENAME,
      "Проект контракта.docx",
      "Описание объекта закупки.docx",
      "Разъяснение положений документации.pdf",
    ]);
    expect(state.saved.every((document) => document.sourceType === "eis_api")).toBe(true);
  });

  it("по коммерческой закупке Контур.Закупок называет обе причины", async () => {
    const state = harness({
      target: {
        regNumber: "K-2609080053",
        law: "COMMERCIAL",
        dataSource: "KONTUR",
        placingWay: null,
      },
    });

    const outcome = await ensureTenderDocuments("K-2609080053", state.deps);

    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("ожидался статус unavailable");
    // Партнёру важно понять и то, что ЕИС закупку не опубликовала, и то, что
    // файлы перечисляет карточка источника, которую загружает отдельный прогон.
    expect(outcome.reason).toMatch(/ЕИС не отдала документацию/);
    expect(outcome.reason).toMatch(/карточка Контур\.Закупок/);
    expect(outcome.reason).toMatch(/платный прогон с российского адреса/);
    expect(state.deps.fetchHtml).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(0);
  });
});

describe("ensureTenderDocuments: общий бюджет знаков", () => {
  it("извещение съедает часть бюджета, остаток уходит вложениям", async () => {
    const state = harness();

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps, {
      budgetChars: NOTICE_CHARS + 150,
    });

    // Первому вложению остаётся 150 знаков, второму 50, третье уже не влезает.
    expect(parseBudgets(state)).toEqual([150, 50]);
    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    expect(outcome.skipped).toBe(1);
    expect(outcome.characters).toBe(NOTICE_CHARS + 150);

    const overBudget = state.saved.find(
      (item) => item.filename === "Разъяснение положений документации.pdf",
    );
    expect(overBudget?.skipped?.code).toBe("over_char_budget");
    expect(overBudget?.skipped?.reason).toMatch(/бюджет/);
  });

  it("занятый бюджет считается по raw_json.chars сохранённых строк", async () => {
    const state = harness({
      stored: [
        record(NOTICE_FILENAME, { chars: NOTICE_CHARS }),
        record("Проект контракта.docx", { chars: 400 }),
      ],
      files: [
        ["Проект контракта.docx", "AA03"],
        ["Описание объекта закупки.docx", "AA02"],
      ],
    });

    await ensureTenderDocuments(REG_NUMBER, state.deps, { budgetChars: 2000 });

    // 2000 − 919 знаков извещения − 400 знаков уже сохранённого контракта.
    expect(parseBudgets(state)).toEqual([2000 - NOTICE_CHARS - 400]);
  });

  it("строка прежней версии без chars оценивается как file_size пополам", async () => {
    const state = harness({
      stored: [record(NOTICE_FILENAME, { chars: null, fileSize: 1800 })],
      files: [["Описание объекта закупки.docx", "AA02"]],
    });

    await ensureTenderDocuments(REG_NUMBER, state.deps, { budgetChars: 1000 });

    expect(parseBudgets(state)).toEqual([100]);
  });

  it("нулевой бюджет оставляет извещение и пропускает все вложения", async () => {
    const state = harness();

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps, { budgetChars: 0 });

    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    expect(outcome.filenames).toHaveLength(4);
    expect(outcome.skipped).toBe(3);
    expect(outcome.characters).toBe(NOTICE_CHARS);
  });

  it("обрезанное вложение считается отдельно от пропущенного", async () => {
    const state = harness({
      files: [["ДОЗ.zip", "AA07"]],
      parsed: () => ({
        text: "д".repeat(500),
        status: "parsed",
        reason: null,
        truncated: true,
        archive: { parsed: 2, total: 15 },
      }),
    });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    const archive = state.saved.find((item) => item.filename === "ДОЗ.zip");
    // Счётчик входов доходит до хранилища: без него карточка скажет «обрезано»,
    // но не скажет, что из 15 вложений архива прочитаны два.
    expect(archive?.truncated).toBe(true);
    expect(archive?.archive).toEqual({ parsed: 2, total: 15 });
    expect(state.saved.find((item) => item.filename === NOTICE_FILENAME)?.truncated).toBe(false);

    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    expect(outcome.truncated).toBe(1);
    expect(outcome.skipped).toBe(0);
    // Обрезка не меняет число знаков: в бюджет идёт ровно прочитанное.
    expect(outcome.characters).toBe(NOTICE_CHARS + 500);
  });
});

describe("ensureTenderDocuments: идемпотентность", () => {
  it("не качает файлы, чьи имена уже лежат в базе", async () => {
    const state = harness({
      stored: [
        record(NOTICE_FILENAME, { chars: NOTICE_CHARS }),
        record("Проект контракта.docx", { chars: 400 }),
      ],
      files: [
        ["Проект контракта.docx", "AA03"],
        ["Описание объекта закупки.docx", "AA02"],
      ],
    });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(state.deps.fetchFile).toHaveBeenCalledTimes(1);
    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    expect(outcome.filenames).toEqual(["Описание объекта закупки.docx"]);
  });

  it("когда весь план уже в базе — already и ни одного скачивания", async () => {
    const state = harness({
      stored: [
        record(NOTICE_FILENAME, { chars: NOTICE_CHARS }),
        record("Проект контракта.docx", { chars: 400 }),
        record("Описание объекта закупки.docx", { chars: 300 }),
        {
          ...record("Разъяснение положений документации.pdf"),
          parsedStatus: "failed",
          chars: 0,
        },
      ],
    });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(outcome.status).toBe("already");
    if (outcome.status !== "already") throw new Error("ожидался статус already");
    // В отчёт попадают только строки с текстом: пропуск уже показан в карточке.
    expect(outcome.filenames).toHaveLength(3);
    // Вкладка читается всегда: только она знает, не добавил ли заказчик файлов.
    expect(requestedPages(state)).toEqual([TAB_URL]);
    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(0);
  });

  it("пропущенное вложение считается обработанным и не перекачивается", async () => {
    const state = harness({
      stored: [
        record(NOTICE_FILENAME, { chars: NOTICE_CHARS }),
        {
          ...record("Разъяснение положений документации.pdf"),
          parsedStatus: "failed",
          chars: 0,
        },
        record("Описание объекта закупки.docx", { chars: 300 }),
        record("Проект контракта.docx", { chars: 400 }),
      ],
    });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(outcome.status).toBe("already");
    expect(state.deps.fetchFile).not.toHaveBeenCalled();
  });

  it("с --force перечитывает и извещение, и каждое вложение", async () => {
    const state = harness({
      stored: [
        record(NOTICE_FILENAME, { chars: NOTICE_CHARS }),
        record("Проект контракта.docx", { chars: 400 }),
      ],
      files: [["Проект контракта.docx", "AA03"]],
    });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps, { force: true });

    expect(outcome.status).toBe("saved");
    expect(requestedPages(state)).toEqual([eisPrintFormUrl(REG_NUMBER), TAB_URL]);
    expect(state.deps.fetchFile).toHaveBeenCalledTimes(1);
    expect(savedNames(state)).toEqual([NOTICE_FILENAME, "Проект контракта.docx"]);
    // Занятый бюджет обнулён: иначе извещение платило бы само за себя.
    expect(parseBudgets(state)).toEqual([1_000_000 - NOTICE_CHARS]);
  });

  it("новые файлы заказчика догружаются в уже разобранную закупку", async () => {
    const state = harness({
      stored: [
        record(NOTICE_FILENAME, { chars: NOTICE_CHARS }),
        record("Проект контракта.docx", { chars: 400 }),
        record("Описание объекта закупки.docx", { chars: 300 }),
        record("Разъяснение положений документации.pdf", { chars: 200 }),
      ],
      files: [...THREE_ATTACHMENTS, ["Изменение № 1.pdf", "AA05"]],
    });

    const outcome = await ensureTenderDocuments(REG_NUMBER, state.deps);

    expect(outcome.status).toBe("saved");
    if (outcome.status !== "saved") throw new Error("ожидался статус saved");
    expect(outcome.filenames).toEqual(["Изменение № 1.pdf"]);
    expect(state.deps.fetchFile).toHaveBeenCalledTimes(1);
  });
});

describe("occupiedChars", () => {
  it("берёт chars, когда он заполнен", () => {
    expect(occupiedChars(record("a.docx", { chars: 4211, fileSize: 9000 }))).toBe(4211);
  });

  it("для строки прежней версии делит file_size на два и округляет вверх", () => {
    expect(occupiedChars(record("a.html", { chars: null, fileSize: 481_201 }))).toBe(240_601);
  });

  it("пропущенный файл не съедает бюджет настоящим размером", () => {
    expect(
      occupiedChars({
        filename: "ПСД.rar",
        parsedStatus: "failed",
        chars: 0,
        fileSize: 300_000_000,
      }),
    ).toBe(0);
  });

  it("без данных считает ноль", () => {
    expect(occupiedChars(record("a.html"))).toBe(0);
  });

  it("отрицательный chars не уменьшает бюджет", () => {
    expect(occupiedChars(record("a.docx", { chars: -10 }))).toBe(0);
  });
});

describe("сигнатура порта разбора", () => {
  it("принимает байты, имя, MIME и остаток бюджета", async () => {
    const port: ParseAttachment = async (bytes, filename, contentType, budgetChars) => {
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(filename).toBe("Проект контракта.docx");
      expect(contentType).toBe("application/download");
      expect(budgetChars).toBe(1000);
      return { text: "текст", status: "parsed", reason: null, truncated: false };
    };

    await port(new Uint8Array(8), "Проект контракта.docx", "application/download", 1000);
  });
});
