import { describe, expect, it, vi, type Mock } from "vitest";
import type { ParsedAttachment } from "@/services/attachmentParser";
import {
  fetchKonturCardDocuments,
  konturBlurredLinkReason,
  type KonturCardDocument,
  type KonturDocumentDeps,
  type KonturDocumentOutcome,
} from "@/services/konturDocumentFetch";
import type { FetchedFile } from "@/services/tenderAttachmentsFetcher";
import type { DocumentRecord, PreparedDocument } from "@/services/tenderDocumentSync";

/**
 * Документация закупки из карточки Контур.Закупок.
 *
 * Сети и Контур.Закупок здесь нет — карточка, загрузка байтов и разбор приходят
 * портами, поэтому проверяется порядок обхода, бюджет знаков, идемпотентность и
 * главное: что именно попадает в базу.
 *
 * Фикстуры повторяют живой ответ группы `purchase` от 23.09.2026 по закупке
 * 0336300038526000037: на тестовом тарифе `Docs[].FileName` приходит целиком,
 * а `Docs[].Url` закрашен символом U+2591. Имя файла при этом терять нельзя —
 * партнёр по нему видит, чего именно не хватает, поэтому строка с причиной
 * пропуска лучше, чем пустой список документов.
 */

const REG_NUMBER = "0336300038526000037";
const EXTERNAL_ID = `RQ${REG_NUMBER}`;
const CONTRACT_URL = `https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=AA01`;
const SPEC_URL = `https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=AA02`;

/** Документ с рабочей ссылкой — так карточку отдаёт боевой тариф. */
function linked(fileName: string, url: string): KonturCardDocument {
  return { fileName, url, urlBlurred: false };
}

/** Документ с закрашенной ссылкой — так карточку отдаёт тестовый тариф. */
function blurred(fileName: string): KonturCardDocument {
  return { fileName, url: null, urlBlurred: true };
}

/** Сколько знаков текста даёт парсер на один файл. */
const PARSED_CHARS = 120;

type FetchFileMock = Mock<[url: string], Promise<FetchedFile>>;
type FetchHtmlMock = Mock<[url: string], Promise<string>>;
type ParseMock = Mock<
  [bytes: Uint8Array, filename: string, contentType: string | null, budgetChars: number],
  Promise<ParsedAttachment>
>;

interface Harness {
  saved: PreparedDocument[];
  deps: KonturDocumentDeps & {
    card: { readDocuments: Mock<[string], Promise<KonturCardDocument[]>> };
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
  documents?: KonturCardDocument[];
  stored?: DocumentRecord[];
  cardError?: Error;
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
    card: {
      readDocuments: vi.fn(async (_externalId: string) => {
        if (options.cardError) throw options.cardError;
        return options.documents ?? [linked("Проект контракта.docx", CONTRACT_URL)];
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

/** Бюджеты знаков, с которыми карточный обход вызывал парсер. */
function parseBudgets(state: Harness): number[] {
  return state.deps.parse.mock.calls.map((call) => call[3]);
}

async function run(
  state: Harness,
  options: { force?: boolean; budgetChars?: number } = {},
): Promise<KonturDocumentOutcome> {
  return fetchKonturCardDocuments(REG_NUMBER, EXTERNAL_ID, state.deps, options);
}

function record(filename: string, chars: number): DocumentRecord {
  return { filename, parsedStatus: chars > 0 ? "parsed" : "failed", chars, fileSize: null };
}

describe("карточка Контур.Закупок как источник документов", () => {
  it("скачивает файл, у которого карточка отдала ссылку", async () => {
    const state = harness({
      documents: [linked("Проект контракта.docx", CONTRACT_URL)],
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("saved");
    expect(outcome).toMatchObject({
      regNumber: REG_NUMBER,
      filenames: ["Проект контракта.docx"],
      characters: PARSED_CHARS,
      skipped: 0,
    });
    expect(state.deps.card.readDocuments).toHaveBeenCalledWith(EXTERNAL_ID);
    expect(state.deps.fetchFile).toHaveBeenCalledWith(CONTRACT_URL);
    // Страницы ЕИС этот обход не читает: всё нужное пришло из карточки.
    expect(state.deps.fetchHtml).not.toHaveBeenCalled();

    const document = saved(state, "Проект контракта.docx");
    expect(document).toMatchObject({
      title: "Проект контракта.docx",
      documentType: "contract",
      sourceType: "kontur_api",
      fileUrl: CONTRACT_URL,
      mimeType: "application/download",
      chars: PARSED_CHARS,
      fileSize: 2048,
      truncated: false,
      skipped: null,
    });
    expect(document.text).toHaveLength(PARSED_CHARS);
    expect(document.contentHash).not.toBeNull();
  });

  it("сохраняет порядок карточки и считает пропуски рядом с текстом", async () => {
    const state = harness({
      documents: [blurred("МТЗ .docx"), linked("Проект контракта.docx", CONTRACT_URL)],
    });

    const outcome = await run(state);

    expect(outcome).toMatchObject({
      status: "saved",
      filenames: ["МТЗ .docx", "Проект контракта.docx"],
      characters: PARSED_CHARS,
      skipped: 1,
    });
  });

  it("передаёт парсеру остаток бюджета знаков закупки", async () => {
    const state = harness({
      documents: [linked("Проект контракта.docx", CONTRACT_URL)],
      stored: [record("print-form.html", 200)],
    });

    await run(state, { budgetChars: 500 });

    expect(parseBudgets(state)).toEqual([300]);
  });
});

describe("имя без ссылки", () => {
  it("закрашенный тарифом адрес не теряется: строка с причиной вместо пустоты", async () => {
    const state = harness({ documents: [blurred("МТЗ .docx")] });

    const outcome = await run(state);

    expect(outcome.status).toBe("names_only");
    expect(outcome).toMatchObject({ regNumber: REG_NUMBER, filenames: ["МТЗ .docx"] });
    if (outcome.status !== "names_only") throw new Error("ожидался names_only");
    expect(outcome.reason).toMatch(/адрес документа закрыт тарифом/);
    // Причина обязана объяснять, что это значит сейчас, когда ключ боевой:
    // иначе партнёр решит, что файлы не скачиваются вовсе.
    expect(outcome.reason).toMatch(/понижение тарифа/);

    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    const document = saved(state, "МТЗ .docx");
    expect(document).toMatchObject({
      title: "МТЗ .docx",
      sourceType: "kontur_api",
      fileUrl: null,
      text: "",
      chars: 0,
      fileSize: null,
      contentHash: null,
      skipped: { code: "download_failed" },
    });
    expect(document.skipped?.reason).toMatch(/адрес документа закрыт тарифом/);
  });

  it("причину отличает от пустого поля: закрашено — значит файл есть, но адрес закрыт", () => {
    expect(konturBlurredLinkReason(blurred("МТЗ .docx"))).toMatch(/адрес документа закрыт тарифом/);
    expect(
      konturBlurredLinkReason({ fileName: "МТЗ .docx", url: null, urlBlurred: false }),
    ).toMatch(/перечислили файл без адреса/);
  });

  it("том rar не скачивается вовсе — формат не читается", async () => {
    const state = harness({
      documents: [linked("Йошкар Ола ПСД.part01.rar", CONTRACT_URL)],
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("names_only");
    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    const document = saved(state, "Йошкар Ола ПСД.part01.rar");
    expect(document.skipped?.code).toBe("unsupported_format");
    if (outcome.status !== "names_only") throw new Error("ожидался names_only");
    expect(outcome.reason).toMatch(/том многотомного архива/);
  });

  it("бюджет знаков исчерпан — файл не скачивается, но причина записана", async () => {
    const state = harness({
      documents: [linked("Проект контракта.docx", CONTRACT_URL)],
      stored: [record("print-form.html", 1000)],
    });

    await run(state, { budgetChars: 1000 });

    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    expect(state.deps.parse).not.toHaveBeenCalled();
    const document = saved(state, "Проект контракта.docx");
    expect(document.skipped?.code).toBe("over_char_budget");
    expect(document.skipped?.reason).toMatch(/Не влез в бюджет/);
  });

  it("файл сверх предела объёма отмечается, а не роняет обход", async () => {
    const state = harness({
      documents: [linked("Проект контракта.docx", CONTRACT_URL)],
      tooLarge: true,
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("names_only");
    expect(saved(state, "Проект контракта.docx").skipped?.code).toBe("file_too_large");
  });

  it("скан без текстового слоя объясняется словами парсера", async () => {
    const state = harness({
      documents: [linked("Скан договора.pdf", CONTRACT_URL)],
      parsed: () => ({ text: "", status: "empty", reason: "В PDF нет текстового слоя.", truncated: false }),
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("names_only");
    if (outcome.status !== "names_only") throw new Error("ожидался names_only");
    expect(outcome.reason).toBe("В PDF нет текстового слоя.");
    expect(saved(state, "Скан договора.pdf").skipped?.code).toBe("empty_text");
  });
});

describe("повторный прогон", () => {
  it("имя уже в базе — документ не скачивается второй раз", async () => {
    const state = harness({
      documents: [linked("Проект контракта.docx", CONTRACT_URL)],
      stored: [record("Проект контракта.docx", PARSED_CHARS)],
    });

    const outcome = await run(state);

    expect(outcome).toMatchObject({ status: "already", filenames: ["Проект контракта.docx"] });
    expect(state.deps.fetchFile).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(0);
  });

  it("force перечитывает то, что уже лежит, и не считает занятый бюджет", async () => {
    const state = harness({
      documents: [linked("Проект контракта.docx", CONTRACT_URL)],
      stored: [record("Проект контракта.docx", PARSED_CHARS)],
    });

    const outcome = await run(state, { force: true, budgetChars: 500 });

    expect(outcome.status).toBe("saved");
    expect(state.deps.fetchFile).toHaveBeenCalledTimes(1);
    expect(parseBudgets(state)).toEqual([500]);
  });

  it("имена в базе, но текста нет ни в одном — это не «уже загружено»", async () => {
    const state = harness({
      documents: [linked("Проект контракта.docx", CONTRACT_URL)],
      stored: [record("Проект контракта.docx", 0)],
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("empty");
    if (outcome.status !== "empty") throw new Error("ожидался empty");
    expect(outcome.reason).toMatch(/текста нет ни в одном/i);
  });

  it("одинаковые имена не перезаписывают чужую строку", async () => {
    const state = harness({
      documents: [
        linked("Описание объекта закупки.docx", CONTRACT_URL),
        linked("Описание объекта закупки.docx", SPEC_URL),
      ],
    });

    const outcome = await run(state);

    // Номер ставится перед расширением: «…docx (2)» не определилось бы как docx,
    // и оба файла ушли бы в пропуск вместо разбора.
    expect(outcome).toMatchObject({
      status: "saved",
      filenames: ["Описание объекта закупки (1).docx", "Описание объекта закупки (2).docx"],
      characters: PARSED_CHARS * 2,
    });
    expect(saved(state, "Описание объекта закупки (2).docx").fileUrl).toBe(SPEC_URL);
    expect(state.deps.parse.mock.calls.map((call) => call[1])).toEqual([
      "Описание объекта закупки (1).docx",
      "Описание объекта закупки (2).docx",
    ]);
  });
});

describe("пустая карточка и сбои", () => {
  it("в карточке нет документов — причина названа, запросов к файлам нет", async () => {
    const state = harness({ documents: [] });

    const outcome = await run(state);

    expect(outcome.status).toBe("empty");
    if (outcome.status !== "empty") throw new Error("ожидался empty");
    expect(outcome.reason).toMatch(/нет ни одного документа/);
    expect(state.deps.store.list).not.toHaveBeenCalled();
    expect(state.deps.fetchFile).not.toHaveBeenCalled();
  });

  it("карточка не прочиталась — сбой назван сбоем, а не пустой документацией", async () => {
    const state = harness({ cardError: new Error("402 Payment Required") });

    const outcome = await run(state);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("ожидался failed");
    expect(outcome.reason).toMatch(/Карточка Контур.Закупок не прочиталась/);
    expect(outcome.reason).toMatch(/402 Payment Required/);
    expect(state.deps.store.list).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(0);
  });

  it("ошибка записи останавливает обход, сохранённое до неё остаётся", async () => {
    const state = harness({
      documents: [
        linked("Проект контракта.docx", CONTRACT_URL),
        linked("Описание объекта закупки.docx", SPEC_URL),
      ],
      saveErrorOnCall: 2,
    });

    const outcome = await run(state);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("ожидался failed");
    expect(outcome.reason).toMatch(/Не удалось сохранить Описание объекта закупки.docx/);
    expect(outcome.reason).toMatch(/превышен лимит строк/);
    expect(state.saved.map((document) => document.filename)).toEqual(["Проект контракта.docx"]);
  });
});
