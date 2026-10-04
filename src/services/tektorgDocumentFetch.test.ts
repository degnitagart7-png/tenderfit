import { describe, expect, it, vi, type Mock } from "vitest";
import type { ParsedAttachment } from "@/services/attachmentParser";
import type { FetchedFile } from "@/services/tenderAttachmentsFetcher";
import type { DocumentRecord, PreparedDocument } from "@/services/tenderDocumentSync";
import {
  fetchTektorgPlatformDocuments,
  tektorgWithdrawnReason,
  type TektorgDocumentDeps,
  type TektorgDocumentOutcome,
  type TektorgPlatformDocument,
} from "@/services/tektorgDocumentFetch";

/**
 * Документация закупки с электронной площадки ТЭК-Торг.
 *
 * Сети и площадки здесь нет — список документов, загрузка байтов и разбор
 * приходят портами, поэтому проверяется порядок обхода, бюджет знаков,
 * идемпотентность и главное: что именно попадает в базу.
 *
 * Имена файлов взяты из живого SOAP-экспорта процедуры ЗП6082206 от
 * 01.10.2026: площадка печатает их транслитом с подчёркиваниями вместо
 * пробелов, и расширение при этом сохраняется — на нём держится проверка
 * формата до скачивания.
 *
 * Отдельный случай, которого ЕИС не даёт вовсе: документ, снятый с публикации
 * (`<removed>` вместо `<file>`). Адреса у него нет, скачать нельзя, но и
 * потерять нельзя — партнёр обязан видеть, что заказчик отозвал файл.
 */

const REG_NUMBER = "TEKTORG-ЗП610102";
const EXTERNAL_ID = "ЗП610102";
const NOTICE_URL = "https://api.tektorg.ru/open-api/documents/procedure/20236402";
const CONTRACT_URL = "https://api.tektorg.ru/open-api/documents/procedure/20236403";

/** Документ с адресом байт — так экспорт отдаёт опубликованный файл. */
function listed(filename: string, url: string): TektorgPlatformDocument {
  return { filename, url, removed: false };
}

/** Документ, снятый с публикации: адреса нет, факт отзыва есть. */
function withdrawn(filename: string): TektorgPlatformDocument {
  return { filename, url: null, removed: true };
}

/** Сколько знаков текста даёт парсер на один файл. */
const PARSED_CHARS = 120;

type FetchFileMock = Mock<[url: string], Promise<FetchedFile>>;
type FetchHtmlMock = Mock<[url: string], Promise<string>>;
type ParseMock = Mock<
  [bytes: Uint8Array, filename: string, contentType: string | null, budgetChars: number],
  Promise<ParsedAttachment>
>;
type ReadDocumentsMock = Mock<[string], Promise<readonly TektorgPlatformDocument[]>>;

interface Harness {
  saved: PreparedDocument[];
  deps: TektorgDocumentDeps & {
    reader: { readDocuments: ReadDocumentsMock };
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
  documents?: readonly TektorgPlatformDocument[];
  stored?: DocumentRecord[];
  readerError?: Error;
  saveError?: Error;
  /** Бросить ошибку записи на N-м вызове save (нумерация с единицы). */
  saveErrorOnCall?: number;
  parsedChars?: number;
  parsed?: (filename: string) => ParsedAttachment;
  fileBytes?: number;
  tooLarge?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const state = {
    saved: [] as PreparedDocument[],
    deps: undefined as unknown as Harness["deps"],
  };

  let saves = 0;
  const fetchHtml = vi.fn(async (_url: string): Promise<string> => "") as unknown as FetchHtmlMock;

  const fetchFile = vi.fn(async (_url: string): Promise<FetchedFile> => ({
    bytes: new Uint8Array(options.fileBytes ?? 2048),
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
      const chars = Math.min(options.parsedChars ?? PARSED_CHARS, budgetChars);
      return { text: "ы".repeat(chars), status: "parsed", reason: null, truncated: false };
    },
  ) as unknown as ParseMock;

  const deps = {
    reader: {
      readDocuments: vi.fn(async (_tenderId: string) => {
        if (options.readerError) throw options.readerError;
        return options.documents ?? [listed("Извещение_инструмент_2_лота.docx", NOTICE_URL)];
      }),
    },
    store: {
      list: vi.fn(async (_regNumber: string) => options.stored ?? []),
      save: vi.fn(async (_regNumber: string, document: PreparedDocument) => {
        saves += 1;
        if (options.saveError) throw options.saveError;
        if (options.saveErrorOnCall === saves) throw new Error("превышен лимит строк");
        state.saved.push(document);
      }),
    },
    fetchHtml,
    fetchFile,
    parse,
  };

  state.deps = deps as unknown as Harness["deps"];
  return state as Harness;
}

/** Сохранённый документ по имени; падает, если такого нет. */
function saved(state: Harness, filename: string): PreparedDocument {
  const document = state.saved.find((item) => item.filename === filename);
  if (!document) throw new Error(`в базе нет ${filename}: ${state.saved.map((d) => d.filename)}`);
  return document;
}

/** Бюджеты знаков, с которыми обход площадки вызывал парсер. */
function parseBudgets(state: Harness): number[] {
  return state.deps.parse.mock.calls.map((call) => call[3]);
}

async function run(
  state: Harness,
  options: { force?: boolean; budgetChars?: number } = {},
): Promise<TektorgDocumentOutcome> {
  return fetchTektorgPlatformDocuments(REG_NUMBER, EXTERNAL_ID, state.deps, options);
}

function record(filename: string, chars: number): DocumentRecord {
  return { filename, parsedStatus: chars > 0 ? "parsed" : "failed", chars, fileSize: null };
}

describe("площадка как источник документов", () => {
  it("скачивает байты по адресу из экспорта и не читает страницы ЕИС", async () => {
    const state = harness({
      documents: [listed("Извещение_инструмент_2_лота.docx", NOTICE_URL)],
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("saved");
    expect(outcome).toMatchObject({
      regNumber: REG_NUMBER,
      filenames: ["Извещение_инструмент_2_лота.docx"],
      characters: PARSED_CHARS,
      skipped: 0,
      withdrawn: 0,
    });
    expect(state.deps.reader.readDocuments).toHaveBeenCalledWith(EXTERNAL_ID);
    expect(state.deps.fetchFile).toHaveBeenCalledWith(NOTICE_URL);
    // Печатную форму и вкладку документов ЕИС этот обход не читает: номер
    // площадки в реестре не публикуется, искать его там бесполезно.
    expect(state.deps.fetchHtml).not.toHaveBeenCalled();

    const document = saved(state, "Извещение_инструмент_2_лота.docx");
    expect(document).toMatchObject({
      title: "Извещение_инструмент_2_лота.docx",
      documentType: "attachment",
      sourceType: "tektorg_api",
      fileUrl: NOTICE_URL,
      mimeType: "application/download",
      chars: PARSED_CHARS,
      fileSize: 2048,
      truncated: false,
      skipped: null,
    });
    expect(document.text).toHaveLength(PARSED_CHARS);
    expect(document.contentHash).not.toBeNull();
  });

  it("определяет тип документа по имени: проект договора разбирается первым", async () => {
    const state = harness({
      documents: [listed("Проект_договора_на_ТО.docx", CONTRACT_URL)],
    });

    await run(state);

    expect(saved(state, "Проект_договора_на_ТО.docx").documentType).toBe("contract");
  });

  it("сохраняет порядок экспорта и считает пропуски рядом с текстом", async () => {
    const state = harness({
      documents: [
        withdrawn("Снятый_с_публикации_документ.docx"),
        listed("Извещение_инструмент_2_лота.docx", NOTICE_URL),
      ],
    });

    const outcome = await run(state);

    expect(outcome).toMatchObject({
      status: "saved",
      filenames: ["Снятый_с_публикации_документ.docx", "Извещение_инструмент_2_лота.docx"],
      characters: PARSED_CHARS,
      skipped: 1,
      withdrawn: 1,
    });
  });

  it("передаёт парсеру остаток бюджета знаков закупки", async () => {
    const state = harness({
      documents: [listed("Извещение_инструмент_2_лота.docx", NOTICE_URL)],
      stored: [record("print-form.html", 200)],
    });

    await run(state, { budgetChars: 500 });

    expect(parseBudgets(state)).toEqual([300]);
  });
});

describe("документ, снятый с публикации", () => {
  it("записывается строкой с причиной, а не теряется молча", async () => {
    const state = harness({
      documents: [withdrawn("Снятый_с_публикации_документ.docx")],
    });

    const outcome = await run(state);

    // Скачать его нельзя: вместо адреса площадка присылает `<removed>`, и любой
    // запрос по нему вернул бы страницу ошибки, которую парсер принял бы за текст.
    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    expect(state.deps.parse).not.toHaveBeenCalled();

    const document = saved(state, "Снятый_с_публикации_документ.docx");
    expect(document).toMatchObject({
      title: "Снятый_с_публикации_документ.docx",
      sourceType: "tektorg_api",
      fileUrl: null,
      text: "",
      chars: 0,
      fileSize: null,
      contentHash: null,
      skipped: { code: "download_failed" },
    });
    expect(document.skipped?.reason).toMatch(/снят с публикации/);
    expect(document.skipped?.reason).toMatch(/Снятый_с_публикации_документ.docx/);

    // Текст не получен ни из одного файла — это не «документация загружена».
    expect(outcome.status).toBe("no_text");
    if (outcome.status !== "no_text") throw new Error("ожидался no_text");
    expect(outcome.filenames).toEqual(["Снятый_с_публикации_документ.docx"]);
    expect(outcome.reason).toMatch(/снят с публикации/);
  });

  it("причина отзыва называет площадку, а не сеть", () => {
    expect(tektorgWithdrawnReason("Снятый_с_публикации_документ.docx")).toMatch(/ТЭК-Торг/);
    expect(tektorgWithdrawnReason("Снятый_с_публикации_документ.docx")).toMatch(/снят с публикации/);
  });
});

describe("формат и бюджет проверяются до скачивания", () => {
  it("том rar не скачивается вовсе — формат не читается", async () => {
    const state = harness({
      documents: [listed("Лот_1.part01.rar", NOTICE_URL)],
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("no_text");
    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    expect(saved(state, "Лот_1.part01.rar").skipped?.code).toBe("unsupported_format");
    if (outcome.status !== "no_text") throw new Error("ожидался no_text");
    expect(outcome.reason).toMatch(/том многотомного архива/);
  });

  it("файл подписи отмечается до скачивания: читать его нечем", async () => {
    const state = harness({
      documents: [listed("Извещение_инструмент_2_лота.docx.sig", NOTICE_URL)],
    });

    await run(state);

    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    expect(saved(state, "Извещение_инструмент_2_лота.docx.sig").skipped?.code).toBe(
      "unsupported_format",
    );
  });

  it("бюджет знаков исчерпан — файл не скачивается, но причина записана", async () => {
    const state = harness({
      documents: [listed("Извещение_инструмент_2_лота.docx", NOTICE_URL)],
      stored: [record("print-form.html", 1000)],
    });

    await run(state, { budgetChars: 1000 });

    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    expect(state.deps.parse).not.toHaveBeenCalled();
    const document = saved(state, "Извещение_инструмент_2_лота.docx");
    expect(document.skipped?.code).toBe("over_char_budget");
    expect(document.skipped?.reason).toMatch(/Не влез в бюджет/);
  });

  it("файл сверх предела объёма отмечается, а не роняет обход", async () => {
    const state = harness({
      documents: [listed("Извещение_инструмент_2_лота.docx", NOTICE_URL)],
      tooLarge: true,
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("no_text");
    expect(saved(state, "Извещение_инструмент_2_лота.docx").skipped?.code).toBe("file_too_large");
  });

  it("скан без текстового слоя объясняется словами парсера", async () => {
    const state = harness({
      documents: [listed("Скан_договора.pdf", CONTRACT_URL)],
      parsed: () => ({
        text: "",
        status: "empty",
        reason: "В PDF нет текстового слоя.",
        truncated: false,
      }),
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("no_text");
    if (outcome.status !== "no_text") throw new Error("ожидался no_text");
    expect(outcome.reason).toBe("В PDF нет текстового слоя.");
    expect(saved(state, "Скан_договора.pdf").skipped?.code).toBe("empty_text");
  });
});

describe("повторный прогон", () => {
  it("имя уже в базе — документ не скачивается второй раз", async () => {
    const state = harness({
      documents: [listed("Извещение_инструмент_2_лота.docx", NOTICE_URL)],
      stored: [record("Извещение_инструмент_2_лота.docx", PARSED_CHARS)],
    });

    const outcome = await run(state);

    expect(outcome).toMatchObject({
      status: "already",
      filenames: ["Извещение_инструмент_2_лота.docx"],
    });
    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(0);
  });

  it("force перечитывает то, что уже лежит, и не считает занятый бюджет", async () => {
    const state = harness({
      documents: [listed("Извещение_инструмент_2_лота.docx", NOTICE_URL)],
      stored: [record("Извещение_инструмент_2_лота.docx", PARSED_CHARS)],
    });

    const outcome = await run(state, { force: true, budgetChars: 500 });

    expect(outcome.status).toBe("saved");
    expect(state.deps.fetchFile).toHaveBeenCalledTimes(1);
    expect(parseBudgets(state)).toEqual([500]);
  });

  it("имена в базе, но текста нет ни в одном — это не «уже загружено»", async () => {
    const state = harness({
      documents: [listed("Извещение_инструмент_2_лота.docx", NOTICE_URL)],
      stored: [record("Извещение_инструмент_2_лота.docx", 0)],
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("empty");
    if (outcome.status !== "empty") throw new Error("ожидался empty");
    expect(outcome.reason).toMatch(/текста нет ни в одном/i);
  });

  it("одинаковые имена не перезаписывают чужую строку", async () => {
    const state = harness({
      documents: [
        listed("ТЗ_ТО_и_ремонт_ТС_(Лада_Ларгус).docx", NOTICE_URL),
        listed("ТЗ_ТО_и_ремонт_ТС_(Лада_Ларгус).docx", CONTRACT_URL),
      ],
    });

    const outcome = await run(state);

    // Номер ставится перед расширением: «…docx (2)» не определилось бы как docx,
    // и оба файла ушли бы в пропуск вместо разбора.
    expect(outcome).toMatchObject({
      status: "saved",
      filenames: [
        "ТЗ_ТО_и_ремонт_ТС_(Лада_Ларгус) (1).docx",
        "ТЗ_ТО_и_ремонт_ТС_(Лада_Ларгус) (2).docx",
      ],
      characters: PARSED_CHARS * 2,
    });
    expect(saved(state, "ТЗ_ТО_и_ремонт_ТС_(Лада_Ларгус) (2).docx").fileUrl).toBe(CONTRACT_URL);
    expect(state.deps.parse.mock.calls.map((call) => call[1])).toEqual([
      "ТЗ_ТО_и_ремонт_ТС_(Лада_Ларгус) (1).docx",
      "ТЗ_ТО_и_ремонт_ТС_(Лада_Ларгус) (2).docx",
    ]);
  });
});

describe("пустой экспорт и сбои", () => {
  it("площадка не перечислила документов — причина названа, запросов к файлам нет", async () => {
    const state = harness({ documents: [] });

    const outcome = await run(state);

    expect(outcome.status).toBe("empty");
    if (outcome.status !== "empty") throw new Error("ожидался empty");
    expect(outcome.reason).toMatch(/не перечислил ни одного документа/);
    expect(outcome.reason).toMatch(/ЗП610102/);
    expect(state.deps.store.list).not.toHaveBeenCalled();
    expect(state.deps.fetchFile).not.toHaveBeenCalled();
  });

  it("экспорт не прочитался — сбой назван сбоем, а не пустой документацией", async () => {
    const state = harness({ readerError: new Error("SOAP Fault: Некорректный период") });

    const outcome = await run(state);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("ожидался failed");
    expect(outcome.reason).toMatch(/Экспорт ТЭК-Торга не прочитался/);
    expect(outcome.reason).toMatch(/SOAP Fault: Некорректный период/);
    expect(state.deps.store.list).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(0);
  });

  it("ошибка записи останавливает обход, сохранённое до неё остаётся", async () => {
    const state = harness({
      documents: [
        listed("Извещение_инструмент_2_лота.docx", NOTICE_URL),
        listed("Проект_договора_на_ТО.docx", CONTRACT_URL),
      ],
      saveErrorOnCall: 2,
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("ожидался failed");
    expect(outcome.reason).toMatch(/Не удалось сохранить Проект_договора_на_ТО.docx/);
    expect(outcome.reason).toMatch(/превышен лимит строк/);
    expect(state.saved.map((document) => document.filename)).toEqual([
      "Извещение_инструмент_2_лота.docx",
    ]);
  });
});
