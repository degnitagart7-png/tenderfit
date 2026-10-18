import { describe, expect, it, vi, type Mock } from "vitest";
import type { ParsedAttachment } from "@/services/attachmentParser";
import type { DocumentsTabTarget } from "./eisAttachments";
import {
  fetchTenderAttachments,
  MAX_FILE_BYTES,
  MAX_FILE_BYTES_IN_MEMORY,
  MAX_TOTAL_CHARS_PER_TENDER,
  MAX_VOLUME_SET_BYTES,
  MAX_VOLUME_SET_BYTES_IN_MEMORY,
  NO_ARCHIVE_CLI_FRAGMENT,
  resolveMaxCharsPerTender,
  SPOOL_ABOVE_BYTES,
  type AttachmentDiskDeps,
  type AttachmentFetchDeps,
  type FetchedFile,
  type FetchFileOptions,
} from "./tenderAttachmentsFetcher";

/**
 * Обход вкладки документов ЕИС.
 *
 * Порты подменяются заглушками: тест не должен ходить в ЕИС, которая к тому же
 * не пускает зарубежные IP. Разметка якоря — та же, что в eisAttachments.test.ts.
 */

interface PageFile {
  uid: string;
  name: string;
}

/** Вкладка документов 44-ФЗ: имя файла в `title` якоря. */
function docsPage(files: readonly PageFile[]): string {
  return files
    .map(
      ({ uid, name }) => `
<div class="attachment row">
  <a href="https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=${uid}"
     title="${name}">${name.replace(/\.[a-z0-9]+$/i, "")}</a>
</div>`,
    )
    .join("\n");
}

/** Карточка 223-ФЗ: источник noticeGuid для вкладки документов. */
const CARD_223 = `<a href="/epz/order/notice/notice223/documents.html?purchaseNoticeNumber=32616394259&noticeGuid=8e3c465e-0fbb-496c-9d39-674df7c1710d">Документы</a>`;

const TARGET_44: DocumentsTabTarget = {
  law: "FZ_44",
  regNumber: "0138300000426000770",
  placingWay: "ELECTRONIC_AUCTION",
};

const TAB_44 =
  "https://zakupki.gov.ru/epz/order/notice/ea20/view/documents.html?regNumber=0138300000426000770";

function ok(text: string, truncated = false): ParsedAttachment {
  return { text, status: "parsed", reason: null, truncated };
}

interface HarnessOptions {
  /** HTML по адресам: карточка 223-ФЗ и вкладка документов. */
  pages?: Record<string, string>;
  /** Байты по uid файла. Отсутствие uid — это сбой загрузки, как в ЕИС. */
  files?: Record<string, FetchedFile>;
  /** Чем парсер отвечает на конкретное имя файла. */
  parsed?: Record<string, ParsedAttachment>;
}

type FetchHtmlMock = Mock<[url: string], Promise<string>>;
type FetchFileMock = Mock<[url: string], Promise<FetchedFile>>;
type ParseMock = Mock<
  [
    bytes: Uint8Array,
    filename: string,
    contentType: string | null,
    budgetChars: number,
  ],
  Promise<ParsedAttachment>
>;

interface Harness {
  deps: AttachmentFetchDeps;
  fetchHtml: FetchHtmlMock;
  fetchFile: FetchFileMock;
  parse: ParseMock;
}

function harness(options: HarnessOptions = {}): Harness {
  const pages = options.pages ?? {};
  const files = options.files ?? {};
  const parsed = options.parsed ?? {};

  const fetchHtml: FetchHtmlMock = vi.fn(
    async (url: string): Promise<string> => {
      const page = pages[url];
      if (page === undefined) throw new Error(`HTTP 404 для ${url}`);
      return page;
    },
  );

  const fetchFile: FetchFileMock = vi.fn(
    async (url: string): Promise<FetchedFile> => {
      const uid = /[?&]uid=([0-9A-Fa-f]+)/i.exec(url)?.[1] ?? "";
      const file = files[uid];
      if (!file) throw new Error(`нет файла ${uid}`);
      return file;
    },
  );

  const parse: ParseMock = vi.fn(
    async (
      _bytes: Uint8Array,
      filename: string,
      _contentType: string | null,
      _budgetChars: number,
    ): Promise<ParsedAttachment> =>
      parsed[filename] ?? ok(`Текст документа ${filename}.`),
  );

  return { deps: { fetchHtml, fetchFile, parse }, fetchHtml, fetchFile, parse };
}

/** Байты файла; содержимое не важно, его читает подставной парсер. */
function bytes(
  size = 8,
  contentType: string | null = "application/download",
): FetchedFile {
  return { bytes: new Uint8Array(size), contentType };
}

/** uid файлов, к которым обход действительно обратился. */
function requestedUids(
  fetchFile: Harness["fetchFile"],
): (string | undefined)[] {
  return fetchFile.mock.calls.map(
    (call) => /[?&]uid=([0-9A-Fa-f]+)/i.exec(String(call[0]))?.[1],
  );
}

describe("fetchTenderAttachments: обход вкладки 44-ФЗ", () => {
  it("читает вкладку и возвращает файлы в порядке приоритета, а не страницы", async () => {
    const page = docsPage([
      { uid: "AA01", name: "Справка о составе участников.pdf" },
      { uid: "AA02", name: "Проект_контракта_ИКЗ_119.docx" },
      { uid: "AA03", name: "Описание_объекта_закупки.docx" },
    ]);
    const { deps } = harness({
      pages: { [TAB_44]: page },
      files: { AA01: bytes(), AA02: bytes(), AA03: bytes() },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(result.reason).toBeNull();
    expect(result.documentsTabUrl).toBe(TAB_44);
    expect(result.attachments.map((item) => item.filename)).toEqual([
      "Проект_контракта_ИКЗ_119.docx",
      "Описание_объекта_закупки.docx",
      "Справка о составе участников.pdf",
    ]);
    expect(result.attachments.map((item) => item.documentType)).toEqual([
      "contract",
      "attachment",
      "attachment",
    ]);
  });

  it("строка документа хранит имя со страницы, объём и ссылку на ЕИС", async () => {
    const page = docsPage([
      { uid: "AA02", name: "Проект_контракта_ИКЗ_119.docx" },
    ]);
    const { deps } = harness({
      pages: { [TAB_44]: page },
      files: { AA02: bytes(1234) },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });
    const row = result.attachments[0];

    expect(row).toMatchObject({
      filename: "Проект_контракта_ИКЗ_119.docx",
      title: "Проект_контракта_ИКЗ_119.docx",
      documentType: "contract",
      sourceType: "eis_api",
      mimeType: "application/download",
      fileSize: 1234,
      truncated: false,
      skipped: null,
    });
    expect(row?.fileUrl).toContain("uid=AA02");
    expect(row?.text).toBe("Текст документа Проект_контракта_ИКЗ_119.docx.");
    expect(row?.chars).toBe(row?.text.length);
    expect(result.chars).toBe(row?.chars);
  });

  it("ошибка загрузки вкладки — причина, а не исключение", async () => {
    const { deps } = harness({ pages: {} });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(result.attachments).toEqual([]);
    expect(result.reason).toContain("HTTP 404");
    expect(result.documentsTabUrl).toBe(TAB_44);
  });

  it("на пустой вкладке нет ни вложений, ни причины", async () => {
    const { deps } = harness({
      pages: { [TAB_44]: "<div>Документов нет</div>" },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(result).toMatchObject({ attachments: [], chars: 0, reason: null });
  });

  it("для коммерческих торгов вкладки ЕИС нет", async () => {
    const { deps, fetchHtml } = harness();

    const result = await fetchTenderAttachments(
      { law: "COMMERCIAL", regNumber: "1", placingWay: null },
      deps,
      { budgetChars: 100_000 },
    );

    expect(result.reason).toContain("не публикует вкладку документов");
    expect(fetchHtml).not.toHaveBeenCalled();
  });
});

describe("fetchTenderAttachments: вкладка 223-ФЗ", () => {
  const cardUrl =
    "https://zakupki.gov.ru/epz/order/notice/notice223/common-info.html?regNumber=32616394259";
  const tabUrl =
    "https://zakupki.gov.ru/epz/order/notice/notice223/documents.html?purchaseNoticeNumber=32616394259&noticeGuid=8e3c465e-0fbb-496c-9d39-674df7c1710d";
  const target: DocumentsTabTarget = {
    law: "FZ_223",
    regNumber: "32616394259",
    placingWay: null,
  };

  it("сначала читает карточку ради noticeGuid, затем вкладку", async () => {
    const { deps, fetchHtml } = harness({
      pages: {
        [cardUrl]: CARD_223,
        [tabUrl]: `<a href="https://zakupki.gov.ru/223/filestore/public/1.0/download/fz223/file.html?uid=DE0A"
          data-tooltip='<span class="custom-tooltiptext">Извещение.docx</span>'>Извещение</a>`,
      },
      files: { DE0A: bytes() },
    });

    const result = await fetchTenderAttachments(target, deps, {
      budgetChars: 100_000,
    });

    expect(fetchHtml.mock.calls.map((call) => call[0])).toEqual([
      cardUrl,
      tabUrl,
    ]);
    expect(result.documentsTabUrl).toBe(tabUrl);
    expect(result.attachments.map((item) => item.filename)).toEqual([
      "Извещение.docx",
    ]);
  });

  it("без noticeGuid в карточке вложения не получить, и это видно по причине", async () => {
    const { deps } = harness({
      pages: { [cardUrl]: "<div>Карточка без GUID</div>" },
    });

    const result = await fetchTenderAttachments(target, deps, {
      budgetChars: 100_000,
    });

    expect(result.reason).toContain("нет noticeGuid");
    expect(result.attachments).toEqual([]);
    expect(result.documentsTabUrl).toBeNull();
  });

  it("с готовым noticeGuid карточка не читается", async () => {
    const { deps, fetchHtml } = harness({
      pages: { [tabUrl]: "<div>Документов нет</div>" },
    });

    await fetchTenderAttachments(
      { ...target, noticeGuid: "8e3c465e-0fbb-496c-9d39-674df7c1710d" },
      deps,
      { budgetChars: 100_000 },
    );

    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(fetchHtml).toHaveBeenCalledWith(tabUrl);
  });
});

describe("fetchTenderAttachments: бюджет знаков", () => {
  const page = docsPage([
    { uid: "AA02", name: "Проект_контракта.docx" },
    { uid: "AA03", name: "Описание_объекта_закупки.docx" },
    { uid: "AA01", name: "Обоснование НМЦК.pdf" },
  ]);
  const files = { AA02: bytes(), AA03: bytes(), AA01: bytes() };
  const parsed = {
    "Проект_контракта.docx": ok("к".repeat(900)),
    "Описание_объекта_закупки.docx": ok("о".repeat(100)),
  };

  it("файл сверх бюджета не скачивается и получает причину", async () => {
    const { deps, fetchFile } = harness({
      pages: { [TAB_44]: page },
      files,
      parsed,
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 1000,
    });

    expect(requestedUids(fetchFile)).toEqual(["AA02", "AA03"]);
    expect(result.chars).toBe(1000);
    expect(result.attachments[2]?.skipped?.code).toBe("over_char_budget");
    // Разделитель разрядов в ru-RU — неразрывный пробел, поэтому не литерал.
    expect(result.attachments[2]?.skipped?.reason).toMatch(/1[\s\u00A0]000/);
    expect(result.attachments[2]?.text).toBe("");
    expect(result.attachments[2]?.chars).toBe(0);
  });

  it("парсеру передаётся остаток бюджета, а не весь лимит", async () => {
    const { deps, parse } = harness({
      pages: { [TAB_44]: page },
      files,
      parsed,
    });

    await fetchTenderAttachments(TARGET_44, deps, { budgetChars: 1000 });

    expect(parse.mock.calls.map((call) => call[3])).toEqual([1000, 100]);
  });

  it("обрезанный по бюджету файл помечается truncated", async () => {
    const { deps } = harness({
      pages: {
        [TAB_44]: docsPage([{ uid: "AA02", name: "Проект_контракта.docx" }]),
      },
      files: { AA02: bytes() },
      parsed: { "Проект_контракта.docx": ok("к".repeat(500), true) },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 500,
    });

    expect(result.attachments[0]).toMatchObject({
      truncated: true,
      chars: 500,
      skipped: null,
    });
  });

  it("счётчик прочитанных входов архива доходит до строки документа", async () => {
    // Закупка 32616393585: архив документации о закупке из 15 вложений отдал
    // модели два — на остальные не хватило остатка бюджета знаков.
    const { deps } = harness({
      pages: { [TAB_44]: docsPage([{ uid: "AA02", name: "ДОЗ.zip" }]) },
      files: { AA02: bytes() },
      parsed: {
        "ДОЗ.zip": {
          text: "д".repeat(500),
          status: "parsed",
          reason: null,
          truncated: true,
          archive: { parsed: 2, total: 15 },
        },
      },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 500,
    });

    expect(result.attachments[0]?.archive).toEqual({ parsed: 2, total: 15 });
  });

  it("у обычного файла архивного счётчика нет", async () => {
    const { deps } = harness({
      pages: {
        [TAB_44]: docsPage([{ uid: "AA02", name: "Проект_контракта.docx" }]),
      },
      files: { AA02: bytes() },
      parsed: { "Проект_контракта.docx": ok("к".repeat(500), true) },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 500,
    });

    expect(result.attachments[0]?.archive).toBeNull();
  });

  it("нулевой бюджет — все читаемые файлы пропущены, запросов к ЕИС нет", async () => {
    const { deps, fetchFile } = harness({ pages: { [TAB_44]: page }, files });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 0,
    });

    expect(fetchFile).not.toHaveBeenCalled();
    expect(result.attachments).toHaveLength(3);
    expect(
      result.attachments.every(
        (item) => item.skipped?.code === "over_char_budget",
      ),
    ).toBe(true);
    expect(result.chars).toBe(0);
  });
});

describe("fetchTenderAttachments: пропуски", () => {
  it("том многотомного архива не скачивается, одиночный 7z скачивается", async () => {
    // Одиночные rar и 7z проект читает, поэтому их надо качать. Том комплекта
    // читать нечем без остальных частей — его отсекаем до загрузки.
    const { deps, fetchFile } = harness({
      pages: {
        [TAB_44]: docsPage([
          { uid: "AA01", name: "Йошкар Ола ПСД.part01.rar" },
          { uid: "AA02", name: "Документация о закупке.7z" },
        ]),
      },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(result.attachments[0]?.skipped?.code).toBe("unsupported_format");
    expect(result.attachments[0]?.skipped?.reason).toContain(
      "том многотомного архива",
    );
  });

  it("неподдерживаемый формат важнее исчерпанного бюджета: причина честнее", async () => {
    // Формат, который проект не читает ничем: rar и 7z сюда больше не годятся.
    const { deps } = harness({
      pages: { [TAB_44]: docsPage([{ uid: "AA01", name: "Планировка.dwg" }]) },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 0,
    });

    expect(result.attachments[0]?.skipped?.code).toBe("unsupported_format");
  });

  it("архив на 28 МБ читается: предел поднят до 50 МБ", async () => {
    // Закупка 32616373657, «Закупочная документация.zip» на 28,1 МБ — самый
    // ценный файл, внутри проект контракта и описание объекта закупки. При
    // прежнем пределе 20 МБ он не читался вовсе, поэтому граница зафиксирована
    // отдельным тестом: молчаливое возвращение к 20 МБ стоило бы партнёру
    // ровно тех документов, ради которых разбор запускают.
    const { deps, parse } = harness({
      pages: {
        [TAB_44]: docsPage([
          { uid: "AA02", name: "Закупочная_документация.zip" },
        ]),
      },
      files: { AA02: bytes(28_100_000) },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(result.attachments[0]?.skipped).toBeNull();
    expect(result.attachments[0]?.fileSize).toBe(28_100_000);
  });

  it("файл больше предела не читается, заявленный объём попадает в причину", async () => {
    const { deps, parse } = harness({
      pages: {
        [TAB_44]: docsPage([
          { uid: "AA02", name: "Закупочная_документация.zip" },
        ]),
      },
      files: {
        AA02: {
          bytes: new Uint8Array(0),
          contentType: null,
          contentLength: 62_000_000,
          tooLarge: true,
        },
      },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });
    const row = result.attachments[0];

    expect(parse).not.toHaveBeenCalled();
    expect(row?.skipped?.code).toBe("file_too_large");
    expect(row?.skipped?.reason).toContain("62.0 МБ");
    // Предел в причине напечатан из константы: партнёр должен видеть действующее
    // число, а не то, которое было в коде на момент написания теста.
    expect(row?.skipped?.reason).toContain(`${MAX_FILE_BYTES_IN_MEMORY / 1_000_000} МБ`);
    expect(row?.fileSize).toBe(62_000_000);
    expect(row?.mimeType).toBe("application/octet-stream");
  });

  it("порт, прочитавший слишком большой файл целиком, всё равно не отдаёт его парсеру", async () => {
    const { deps, parse } = harness({
      pages: {
        [TAB_44]: docsPage([{ uid: "AA02", name: "Проект_контракта.zip" }]),
      },
      files: { AA02: bytes(MAX_FILE_BYTES_IN_MEMORY + 1) },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(parse).not.toHaveBeenCalled();
    expect(result.attachments[0]?.skipped?.code).toBe("file_too_large");
    expect(result.attachments[0]?.skipped?.reason).toContain("больше предела");
  });

  it("ЕИС не отдала файл — причина записана, обход продолжается", async () => {
    const { deps, fetchFile } = harness({
      pages: {
        [TAB_44]: docsPage([
          { uid: "AA02", name: "Проект_контракта.docx" },
          { uid: "AA03", name: "Описание_объекта_закупки.docx" },
        ]),
      },
      files: { AA03: bytes() },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(fetchFile).toHaveBeenCalledTimes(2);
    expect(result.attachments[0]?.skipped?.code).toBe("download_failed");
    expect(result.attachments[0]?.skipped?.reason).toContain("нет файла AA02");
    expect(result.attachments[1]?.skipped).toBeNull();
    expect(result.chars).toBeGreaterThan(0);
  });

  it("скан без текстового слоя — empty_text", async () => {
    const { deps } = harness({
      pages: {
        [TAB_44]: docsPage([{ uid: "AA01", name: "Обоснование НМЦК.pdf" }]),
      },
      files: { AA01: bytes() },
      parsed: {
        "Обоснование НМЦК.pdf": {
          text: "",
          status: "empty",
          reason: "Текстового слоя нет: файл отсканирован или пуст.",
          truncated: false,
        },
      },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(result.attachments[0]?.skipped?.code).toBe("empty_text");
    expect(result.attachments[0]?.chars).toBe(0);
  });

  it("битый файл — parse_failed с сообщением парсера", async () => {
    const { deps } = harness({
      pages: { [TAB_44]: docsPage([{ uid: "AA01", name: "Смета.xlsx" }]) },
      files: { AA01: bytes() },
      parsed: {
        "Смета.xlsx": {
          text: "",
          status: "failed",
          reason: "Corrupted zip",
          truncated: false,
        },
      },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(result.attachments[0]?.skipped).toEqual({
      code: "parse_failed",
      reason: "Corrupted zip",
    });
  });

  it("парсер без причины — подставляется общая", async () => {
    const { deps } = harness({
      pages: { [TAB_44]: docsPage([{ uid: "AA01", name: "Смета.xlsx" }]) },
      files: { AA01: bytes() },
      parsed: {
        "Смета.xlsx": {
          text: "",
          status: "failed",
          reason: null,
          truncated: false,
        },
      },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(result.attachments[0]?.skipped?.reason).toBe(
      "Файл не удалось разобрать.",
    );
  });

  it("вложенный архив, который парсер не открыл, — unsupported_format", async () => {
    const { deps } = harness({
      pages: {
        [TAB_44]: docsPage([{ uid: "AA02", name: "Проект_контракта.zip" }]),
      },
      files: { AA02: bytes() },
      parsed: {
        "Проект_контракта.zip": {
          text: "",
          status: "unsupported",
          reason: "Вложенный архив не распаковывается.",
          truncated: false,
        },
      },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(result.attachments[0]?.skipped).toEqual({
      code: "unsupported_format",
      reason: "Вложенный архив не распаковывается.",
    });
  });
});

describe("fetchTenderAttachments: повторный прогон", () => {
  const page = docsPage([
    { uid: "AA02", name: "Проект_контракта.docx" },
    { uid: "AA03", name: "Описание_объекта_закупки.docx" },
  ]);

  it("файл, который уже в базе, не скачивается и в результат не попадает", async () => {
    const { deps, fetchFile } = harness({
      pages: { [TAB_44]: page },
      files: { AA02: bytes(), AA03: bytes() },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
      knownFilenames: new Set(["Проект_контракта.docx"]),
    });

    expect(requestedUids(fetchFile)).toEqual(["AA03"]);
    expect(result.attachments.map((item) => item.filename)).toEqual([
      "Описание_объекта_закупки.docx",
    ]);
  });

  it("одинаковые имена различаются суффиксом из uid, заголовок остаётся со страницы", async () => {
    const { deps } = harness({
      pages: {
        [TAB_44]: docsPage([
          { uid: "3F0C7108", name: "Разъяснение_32616242641.pdf" },
          { uid: "11AB6DDB", name: "Разъяснение_32616242641.pdf" },
        ]),
      },
      files: { "3F0C7108": bytes(), "11AB6DDB": bytes() },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(result.attachments.map((item) => item.filename)).toEqual([
      "Разъяснение_32616242641 (3F0C7108).pdf",
      "Разъяснение_32616242641 (11AB6DDB).pdf",
    ]);
    expect(result.attachments.map((item) => item.title)).toEqual([
      "Разъяснение_32616242641.pdf",
      "Разъяснение_32616242641.pdf",
    ]);
  });
});

/** Подставной разбор комплекта: типы те же, что у настоящего. */
type ParseVolumesMock = Mock<
  Parameters<NonNullable<AttachmentFetchDeps["parseVolumes"]>>,
  ReturnType<NonNullable<AttachmentFetchDeps["parseVolumes"]>>
>;

/**
 * Комплекты томов.
 *
 * Живой случай — закупка 32616411271: «085-0015958 ул.Ротерта.part1.rar» и
 * второй том. Один том не распаковывается, поэтому единицей работы становится
 * комплект: качаются все части и уходят распаковщику вместе.
 */
describe("fetchTenderAttachments: комплекты томов", () => {
  const volumesPage = () =>
    docsPage([
      { uid: "AA01", name: "ул.Ротерта.part1.rar" },
      { uid: "AA02", name: "ул.Ротерта.part2.rar" },
    ]);

  it("скачивает все тома и отдаёт распаковщику вместе", async () => {
    const parseVolumes: ParseVolumesMock = vi.fn(async (_volumes, _budget) =>
      ok("Текст проектной документации."),
    );
    const { deps, fetchFile } = harness({
      pages: { [TAB_44]: volumesPage() },
      files: { AA01: bytes(), AA02: bytes() },
    });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...deps, parseVolumes },
      { budgetChars: 100_000 },
    );

    expect(requestedUids(fetchFile)).toEqual(["AA01", "AA02"]);
    expect(parseVolumes).toHaveBeenCalledTimes(1);
    expect(parseVolumes.mock.calls[0]?.[0].map((part) => part.name)).toEqual([
      "ул.Ротерта.part1.rar",
      "ул.Ротерта.part2.rar",
    ]);
    expect(result.attachments[0]?.text).toContain(
      "Текст проектной документации",
    );
  });

  it("остальные тома получают запись, а не пропадают из вкладки", async () => {
    const parseVolumes: ParseVolumesMock = vi.fn(async (_volumes, _budget) =>
      ok("Текст проектной документации."),
    );
    const { deps } = harness({
      pages: { [TAB_44]: volumesPage() },
      files: { AA01: bytes(), AA02: bytes() },
    });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...deps, parseVolumes },
      { budgetChars: 100_000 },
    );

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[1]?.skipped?.code).toBe("volume_of_set");
    expect(result.attachments[1]?.skipped?.reason).toContain(
      "ул.Ротерта.part1.rar",
    );
  });

  it("недостающий том отменяет весь комплект и называет его", async () => {
    const parseVolumes: ParseVolumesMock = vi.fn(async (_volumes, _budget) =>
      ok("не должно вызваться"),
    );
    const { deps } = harness({
      pages: { [TAB_44]: volumesPage() },
      files: { AA01: bytes() },
    });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...deps, parseVolumes },
      { budgetChars: 100_000 },
    );

    expect(parseVolumes).not.toHaveBeenCalled();
    expect(
      result.attachments.every(
        (row) => row.skipped?.code === "download_failed",
      ),
    ).toBe(true);
    expect(result.attachments[0]?.skipped?.reason).toContain(
      "ул.Ротерта.part2.rar",
    );
  });

  it("без чтения комплектов тома помечаются, а не скачиваются", async () => {
    const { deps, fetchFile } = harness({
      pages: { [TAB_44]: volumesPage() },
      files: { AA01: bytes(), AA02: bytes() },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(fetchFile).not.toHaveBeenCalled();
    expect(
      result.attachments.every(
        (row) => row.skipped?.code === "unsupported_format",
      ),
    ).toBe(true);
  });
});

/**
 * Тома-нарезки «.zip.001…007» и «.rar.001…003»: заказчик выкладывает так
 * побайтово разрезанный файл (живые закупки: «СД_2-этап_26.08.2026.zip.001…007»,
 * «Закупочная_документация_изм.rar.001/.002/.003»).
 */
describe("fetchTenderAttachments: тома-нарезки", () => {
  const splitPage = () =>
    docsPage([
      { uid: "BB03", name: "СД_2-этап.zip.003" },
      { uid: "BB01", name: "СД_2-этап.zip.001" },
      { uid: "BB02", name: "СД_2-этап.zip.002" },
    ]);

  it("тома качаются все, по порядку номеров, и уходят комплектом", async () => {
    const parseVolumes: ParseVolumesMock = vi.fn(async (_volumes, _budget) =>
      ok("Текст проектной документации."),
    );
    const { deps, fetchFile } = harness({
      pages: { [TAB_44]: splitPage() },
      files: { BB01: bytes(), BB02: bytes(), BB03: bytes() },
    });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...deps, parseVolumes },
      { budgetChars: 100_000 },
    );

    expect(requestedUids(fetchFile)).toEqual(["BB01", "BB02", "BB03"]);
    expect(parseVolumes.mock.calls[0]?.[0].map((part) => part.name)).toEqual([
      "СД_2-этап.zip.001",
      "СД_2-этап.zip.002",
      "СД_2-этап.zip.003",
    ]);
    // Текст — у первого тома, остальные помечены.
    expect(result.attachments[0]?.filename).toBe("СД_2-этап.zip.001");
    expect(result.attachments[0]?.text).toContain(
      "Текст проектной документации",
    );
    expect(result.attachments.slice(1).map((row) => row.skipped?.code)).toEqual(
      ["volume_of_set", "volume_of_set"],
    );
    expect(result.attachments[1]?.skipped?.reason).toBe(
      "Том комплекта: прочитан вместе с «СД_2-этап.zip.001».",
    );
  });

  it("недостающий том видно по именам: ничего не скачивается, причина называет том", async () => {
    const parseVolumes: ParseVolumesMock = vi.fn(async (_volumes, _budget) =>
      ok("не должно вызваться"),
    );
    const { deps, fetchFile } = harness({
      pages: {
        [TAB_44]: docsPage([
          { uid: "BB01", name: "Закупочная_документация_изм.rar.001" },
          { uid: "BB03", name: "Закупочная_документация_изм.rar.003" },
        ]),
      },
      files: { BB01: bytes(), BB03: bytes() },
    });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...deps, parseVolumes },
      { budgetChars: 100_000 },
    );

    expect(fetchFile).not.toHaveBeenCalled();
    expect(parseVolumes).not.toHaveBeenCalled();
    expect(result.attachments).toHaveLength(2);
    for (const row of result.attachments) {
      expect(row.skipped?.code).toBe("unsupported_format");
      expect(row.skipped?.reason).toContain("не хватает тома 002");
    }
  });

  it("предел комплекта 300 МБ действует и для нарезки", async () => {
    const parseVolumes: ParseVolumesMock = vi.fn(async (_volumes, _budget) =>
      ok("x"),
    );
    const { deps } = harness({
      pages: {
        [TAB_44]: docsPage([
          { uid: "BB01", name: "ПД.zip.001" },
          { uid: "BB02", name: "ПД.zip.002" },
        ]),
      },
      files: {
        BB01: { bytes: new Uint8Array(0), contentType: null, tooLarge: true },
        BB02: bytes(),
      },
    });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...deps, parseVolumes },
      { budgetChars: 100_000 },
    );

    expect(parseVolumes).not.toHaveBeenCalled();
    expect(
      result.attachments.every((row) => row.skipped?.code === "file_too_large"),
    ).toBe(true);
  });
});

describe("fetchTenderAttachments: распознанный текст", () => {
  it("признак распознавания доходит до строки документа", async () => {
    const { deps } = harness({
      pages: {
        [TAB_44]: docsPage([{ uid: "CC01", name: "Скан договора.pdf" }]),
      },
      files: { CC01: bytes() },
      parsed: {
        "Скан договора.pdf": {
          ...ok("[Текст распознан со скана: 2 стр. из 3]\nТекст договора."),
          ocr: { pages: 2, totalPages: 3 },
        },
      },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(result.attachments[0]?.ocr).toEqual({ pages: 2, totalPages: 3 });
  });

  it("у обычного документа признака распознавания нет", async () => {
    const { deps } = harness({
      pages: {
        [TAB_44]: docsPage([{ uid: "CC02", name: "Проект_контракта.docx" }]),
      },
      files: { CC02: bytes() },
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: 100_000,
    });

    expect(result.attachments[0]?.ocr).toBeNull();
  });

  it("картинка скачивается и разбирается, а не пропускается по формату", async () => {
    const { deps, fetchFile, parse } = harness({
      pages: {
        [TAB_44]: docsPage([{ uid: "CC03", name: "схема_из_2_гис.png" }]),
      },
      files: { CC03: bytes() },
    });

    await fetchTenderAttachments(TARGET_44, deps, { budgetChars: 100_000 });

    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("odt и rtf тоже скачиваются: формат теперь читается", async () => {
    const { deps, fetchFile } = harness({
      pages: {
        [TAB_44]: docsPage([
          { uid: "CC04", name: "Ведомость объемов работ.odt" },
          { uid: "CC05", name: "Информационная карта.rtf" },
        ]),
      },
      files: { CC04: bytes(), CC05: bytes() },
    });

    await fetchTenderAttachments(TARGET_44, deps, { budgetChars: 100_000 });

    expect(requestedUids(fetchFile)).toEqual(["CC04", "CC05"]);
  });
});

/**
 * Предел файла (50 МБ) не должен применяться к тому комплекта.
 *
 * Прогон scripts/reparse-unreadable.ts на сервере дал 28 раз «Комплект томов
 * объёмом 0.0 МБ больше предела 300 МБ»: порт загрузки обрывал любой том больше
 * 50 МБ как «слишком большой файл» и отдавал ноль байт, а комплект принимал это
 * за превышение своего предела.
 */
describe("fetchTenderAttachments: предел тома и предел комплекта", () => {
  const page = () =>
    docsPage([
      { uid: "DD01", name: "Внуково.part1.rar" },
      { uid: "DD02", name: "Внуково.part2.rar" },
    ]);

  /** Порт, который ведёт себя как настоящий fetchFile: рвёт файл больше своего предела. */
  function limitedPort(
    declared: Record<string, number>,
    actual: Record<string, Uint8Array>,
  ) {
    const requested: (number | undefined)[] = [];
    const fetchFile = vi.fn(
      async (
        url: string,
        options?: { maxBytes?: number },
      ): Promise<FetchedFile> => {
        const uid = /[?&]uid=([0-9A-Fa-f]+)/i.exec(url)?.[1] ?? "";
        requested.push(options?.maxBytes);
        const limit = options?.maxBytes ?? MAX_FILE_BYTES_IN_MEMORY;
        const size = declared[uid] ?? actual[uid]?.byteLength ?? 0;
        if (size > limit) {
          return {
            bytes: new Uint8Array(0),
            contentType: null,
            contentLength: size,
            tooLarge: true,
          };
        }
        return { bytes: actual[uid] ?? new Uint8Array(8), contentType: null };
      },
    );
    return { fetchFile, requested };
  }

  it("том больше 50 МБ читается: порту передан предел комплекта, а не файла", async () => {
    const { fetchFile, requested } = limitedPort(
      { DD01: 80_000_000, DD02: 80_000_000 },
      {},
    );
    const parseVolumes: ParseVolumesMock = vi.fn(async (_volumes, _budget) =>
      ok("Текст проектной документации."),
    );
    const base = harness({ pages: { [TAB_44]: page() } });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...base.deps, fetchFile, parseVolumes },
      { budgetChars: 100_000 },
    );

    expect(requested[0]).toBe(MAX_VOLUME_SET_BYTES_IN_MEMORY);
    expect(parseVolumes).toHaveBeenCalledTimes(1);
    expect(result.attachments[0]?.skipped).toBeNull();
    expect(result.attachments[0]?.text).toContain(
      "Текст проектной документации",
    );
    expect(JSON.stringify(result.attachments)).not.toContain("0.0 МБ");
  });

  it("каждому следующему тому достаётся остаток предела комплекта", async () => {
    const { fetchFile, requested } = limitedPort(
      {},
      {
        DD01: new Uint8Array(1_000),
        DD02: new Uint8Array(2_000),
      },
    );
    const parseVolumes: ParseVolumesMock = vi.fn(async (_volumes, _budget) =>
      ok("Текст."),
    );
    const base = harness({ pages: { [TAB_44]: page() } });

    await fetchTenderAttachments(
      TARGET_44,
      { ...base.deps, fetchFile, parseVolumes },
      { budgetChars: 100_000 },
    );

    expect(requested).toEqual([
      MAX_VOLUME_SET_BYTES_IN_MEMORY,
      MAX_VOLUME_SET_BYTES_IN_MEMORY - 1_000,
    ]);
  });

  it("настоящее превышение по факту загрузки срабатывает и называет объём", async () => {
    const { fetchFile } = limitedPort(
      {},
      {
        DD01: new Uint8Array(160_000_000),
        DD02: new Uint8Array(160_000_000),
      },
    );
    const parseVolumes: ParseVolumesMock = vi.fn(async (_volumes, _budget) =>
      ok("не должно вызваться"),
    );
    const base = harness({ pages: { [TAB_44]: page() } });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...base.deps, fetchFile, parseVolumes },
      { budgetChars: 100_000 },
    );

    // Второй том не влез в остаток предела (140 МБ): порт оборвал его и назвал объём.
    expect(parseVolumes).not.toHaveBeenCalled();
    expect(
      result.attachments.every((row) => row.skipped?.code === "file_too_large"),
    ).toBe(true);
    expect(result.attachments[0]?.skipped?.reason).toContain("320.0 МБ");
    expect(result.attachments[0]?.skipped?.reason).toContain(
      "больше предела 300 МБ",
    );
  });

  it("порт без объёма: в причине нет «0.0 МБ»", async () => {
    const base = harness({
      pages: { [TAB_44]: page() },
      files: {
        DD01: { bytes: new Uint8Array(0), contentType: null, tooLarge: true },
        DD02: { bytes: new Uint8Array(8), contentType: null },
      },
    });
    const parseVolumes: ParseVolumesMock = vi.fn(async (_volumes, _budget) =>
      ok("x"),
    );

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...base.deps, parseVolumes },
      { budgetChars: 100_000 },
    );

    const reason = result.attachments[0]?.skipped?.reason ?? "";
    expect(reason).toContain("больше предела");
    expect(reason).not.toContain("0.0 МБ");
  });

  it("без дискового пути одиночный файл по-прежнему ограничен 50 МБ", async () => {
    const { fetchFile, requested } = limitedPort({ DD05: 60_000_000 }, {});
    const base = harness({
      pages: { [TAB_44]: docsPage([{ uid: "DD05", name: "Большой.docx" }]) },
    });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...base.deps, fetchFile },
      { budgetChars: 100_000 },
    );

    expect(requested).toEqual([undefined]);
    expect(result.attachments[0]?.skipped?.code).toBe("file_too_large");
  });
});


/*
  Бюджета знаков больше нет (2026-10-08): в базе 65 файлов были помечены
  «Не влез в бюджет …», хотя читать их ничто не мешало, кроме миллиона знаков
  на закупку.
*/
describe("бюджет знаков на закупку", () => {
  it("по умолчанию предела нет", () => {
    expect(MAX_TOTAL_CHARS_PER_TENDER).toBe(Number.POSITIVE_INFINITY);
    expect(resolveMaxCharsPerTender({})).toBe(Number.POSITIVE_INFINITY);
    expect(resolveMaxCharsPerTender({ TENDERFIT_MAX_CHARS_PER_TENDER: "" })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(resolveMaxCharsPerTender({ TENDERFIT_MAX_CHARS_PER_TENDER: "0" })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(resolveMaxCharsPerTender({ TENDERFIT_MAX_CHARS_PER_TENDER: "мусор" })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("на случай аварии предел включается переменной окружения", () => {
    expect(resolveMaxCharsPerTender({ TENDERFIT_MAX_CHARS_PER_TENDER: "500000" })).toBe(500_000);
    expect(resolveMaxCharsPerTender({ TENDERFIT_MAX_CHARS_PER_TENDER: "1 000 000" })).toBe(
      1_000_000,
    );
  });

  it("без предела читаются все файлы закупки, ни один не отброшен бюджетом", async () => {
    const names = Array.from({ length: 12 }, (_, i) => ({
      uid: `E${String(i).padStart(2, "0")}`,
      name: `Раздел ${i + 1}.docx`,
    }));
    const files: Record<string, FetchedFile> = {};
    for (const { uid } of names) files[uid] = bytes();
    const { deps } = harness({
      pages: { [TAB_44]: docsPage(names) },
      files,
      // Каждый файл отдаёт по миллиону знаков: двенадцать миллионов в сумме.
      parsed: Object.fromEntries(
        names.map(({ name }) => [name, ok("я".repeat(1_000_000))]),
      ),
    });

    const result = await fetchTenderAttachments(TARGET_44, deps, {
      budgetChars: Number.POSITIVE_INFINITY,
    });

    expect(result.attachments).toHaveLength(12);
    expect(result.attachments.every((row) => row.skipped === null)).toBe(true);
    expect(result.chars).toBe(12_000_000);
  });
});

describe("дисковый путь: файлы и комплекты на диске", () => {
  const MB = 1_000_000;

  /** Дисковые порты на заглушках: что вызвано и убран ли каталог. */
  function diskPorts(available = true) {
    const events: string[] = [];
    const parseFile = vi.fn(async (path: string) => {
      events.push(`parseFile ${path}`);
      return ok("Текст из большого файла на диске.");
    });
    const parseVolumeFiles = vi.fn(
      async (_volumes: readonly { name: string; path: string }[]) => {
        events.push("parseVolumeFiles");
        return ok("Текст из комплекта на диске.");
      },
    );
    const disk: AttachmentDiskDeps = {
      available: async () => available,
      makeDir: async () => {
        events.push("makeDir");
        return {
          dir: "/tmp/spool-1",
          dispose: async () => {
            events.push("dispose");
          },
        };
      },
      parseFile,
      parseVolumeFiles,
    };
    return { disk, events, parseFile, parseVolumeFiles };
  }

  const bigPage = () => docsPage([{ uid: "FF01", name: "Закупочная документация.zip" }]);

  it("без дискового пути порту передаётся только адрес: прежнее поведение", async () => {
    const { deps, fetchFile } = harness({
      pages: { [TAB_44]: bigPage() },
      files: { FF01: bytes() },
    });

    await fetchTenderAttachments(TARGET_44, deps, { budgetChars: 100_000 });

    expect(fetchFile.mock.calls[0]).toHaveLength(1);
  });

  it("с программами файл до 300 МБ читается: порту предложен диск, парсит дисковый порт", async () => {
    const { disk, events, parseFile } = diskPorts();
    const base = harness({ pages: { [TAB_44]: bigPage() } });
    const seen: (FetchFileOptions | undefined)[] = [];
    const fetchFile = vi.fn(
      async (_url: string, options?: FetchFileOptions): Promise<FetchedFile> => {
        seen.push(options);
        return {
          bytes: new Uint8Array(0),
          contentType: "application/download",
          path: "/tmp/spool-1/file",
          size: 250 * MB,
        };
      },
    );

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...base.deps, fetchFile, disk },
      { budgetChars: 100_000 },
    );

    expect(seen[0]?.maxBytes).toBe(MAX_FILE_BYTES);
    expect(seen[0]?.spool).toMatchObject({ dir: "/tmp/spool-1", above: SPOOL_ABOVE_BYTES });
    expect(parseFile).toHaveBeenCalledWith(
      "/tmp/spool-1/file",
      "Закупочная документация.zip",
      "application/download",
      100_000,
    );
    expect(base.parse).not.toHaveBeenCalled();
    expect(result.attachments[0]?.skipped).toBeNull();
    expect(result.attachments[0]?.fileSize).toBe(250 * MB);
    // Каталог убран в конце, после разбора.
    expect(events.at(-1)).toBe("dispose");
  });

  it("файл больше 300 МБ не читается, предел в причине — 300, приписки про программы нет", async () => {
    const { disk } = diskPorts();
    const base = harness({
      pages: { [TAB_44]: bigPage() },
      files: {
        FF01: { bytes: new Uint8Array(0), contentType: null, contentLength: 400 * MB, tooLarge: true },
      },
    });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...base.deps, disk },
      { budgetChars: 100_000 },
    );

    const row = result.attachments[0];
    expect(row?.skipped?.code).toBe("file_too_large");
    expect(row?.skipped?.reason).toContain("больше предела 300 МБ и не читается");
    expect(row?.skipped?.reason).not.toContain(NO_ARCHIVE_CLI_FRAGMENT);
  });

  it("порты есть, а программ на машине нет: прежний предел 50 МБ и внятная причина", async () => {
    const { disk, events } = diskPorts(false);
    const base = harness({
      pages: { [TAB_44]: bigPage() },
      files: {
        FF01: { bytes: new Uint8Array(0), contentType: null, contentLength: 80 * MB, tooLarge: true },
      },
    });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...base.deps, disk },
      { budgetChars: 100_000 },
    );

    const row = result.attachments[0];
    expect(row?.skipped?.code).toBe("file_too_large");
    expect(row?.skipped?.reason).toContain("больше предела 50 МБ и не читается");
    expect(row?.skipped?.reason).toContain(NO_ARCHIVE_CLI_FRAGMENT);
    // Временный каталог без программ не создаётся вовсе.
    expect(events).not.toContain("makeDir");
  });

  it("каталог убирается и тогда, когда скачивание упало", async () => {
    const { disk, events } = diskPorts();
    const base = harness({ pages: { [TAB_44]: bigPage() } });

    const result = await fetchTenderAttachments(
      TARGET_44,
      { ...base.deps, disk },
      { budgetChars: 100_000 },
    );

    expect(result.attachments[0]?.skipped?.code).toBe("download_failed");
    expect(events).toEqual(["makeDir", "dispose"]);
  });

  describe("комплект томов", () => {
    const setPage = () =>
      docsPage([
        { uid: "CD01", name: "Проект.part1.rar" },
        { uid: "CD02", name: "Проект.part2.rar" },
      ]);

    function spoolingPort(sizes: Record<string, number>) {
      const calls: { uid: string; options?: FetchFileOptions }[] = [];
      const fetchFile = vi.fn(
        async (url: string, options?: FetchFileOptions): Promise<FetchedFile> => {
          const uid = /[?&]uid=([0-9A-Fa-f]+)/i.exec(url)?.[1] ?? "";
          calls.push({ uid, ...(options ? { options } : {}) });
          const size = sizes[uid] ?? 0;
          if (options?.maxBytes !== undefined && size > options.maxBytes) {
            return {
              bytes: new Uint8Array(0),
              contentType: null,
              contentLength: size,
              tooLarge: true,
            };
          }
          return {
            bytes: new Uint8Array(0),
            contentType: null,
            path: `${options?.spool?.dir}/${options?.spool?.name}`,
            size,
          };
        },
      );
      return { fetchFile, calls };
    }

    it("тома пишутся на диск под своими номерами, комплект читает дисковый порт", async () => {
      const { disk, parseVolumeFiles, events } = diskPorts();
      const { fetchFile, calls } = spoolingPort({ CD01: 200 * MB, CD02: 108 * MB });
      const base = harness({ pages: { [TAB_44]: setPage() } });

      const result = await fetchTenderAttachments(
        TARGET_44,
        { ...base.deps, fetchFile, disk },
        { budgetChars: 100_000 },
      );

      // Комплект на 308 МБ раньше не читался: предел был 300 МБ.
      expect(parseVolumeFiles).toHaveBeenCalledTimes(1);
      expect(parseVolumeFiles.mock.calls[0]?.[0]).toEqual([
        { name: "Проект.part1.rar", path: "/tmp/spool-1/volumes.part1.rar" },
        { name: "Проект.part2.rar", path: "/tmp/spool-1/volumes.part2.rar" },
      ]);
      // Тома идут на диск всегда (above: 0), с остатком предела комплекта.
      expect(calls[0]?.options?.spool?.above).toBe(0);
      expect(calls[0]?.options?.maxBytes).toBe(MAX_VOLUME_SET_BYTES);
      expect(calls[1]?.options?.maxBytes).toBe(MAX_VOLUME_SET_BYTES - 200 * MB);
      expect(result.attachments[0]?.skipped).toBeNull();
      expect(result.attachments[0]?.text).toContain("Текст из комплекта на диске");
      expect(result.attachments[1]?.skipped?.code).toBe("volume_of_set");
      expect(events.at(-1)).toBe("dispose");
    });

    it("комплект больше 2 ГБ не читается, предел в причине — 2000 МБ", async () => {
      const { disk, parseVolumeFiles } = diskPorts();
      const { fetchFile } = spoolingPort({ CD01: 1_500 * MB, CD02: 600 * MB });
      const base = harness({ pages: { [TAB_44]: setPage() } });

      const result = await fetchTenderAttachments(
        TARGET_44,
        { ...base.deps, fetchFile, disk },
        { budgetChars: 100_000 },
      );

      expect(parseVolumeFiles).not.toHaveBeenCalled();
      expect(result.attachments.every((row) => row.skipped?.code === "file_too_large")).toBe(true);
      expect(result.attachments[0]?.skipped?.reason).toContain("больше предела 2000 МБ и не читается");
    });

    it("каталог с томами убирается и тогда, когда распаковка упала", async () => {
      const { disk, parseVolumeFiles, events } = diskPorts();
      parseVolumeFiles.mockRejectedValueOnce(new Error("7-Zip не распаковал архив"));
      const { fetchFile } = spoolingPort({ CD01: 10 * MB, CD02: 10 * MB });
      const base = harness({ pages: { [TAB_44]: setPage() } });

      const result = await fetchTenderAttachments(
        TARGET_44,
        { ...base.deps, fetchFile, disk },
        { budgetChars: 100_000 },
      );

      expect(result.attachments.every((row) => row.skipped?.code === "parse_failed")).toBe(true);
      expect(events.at(-1)).toBe("dispose");
    });

    it("без программ комплект собирается в памяти с прежним пределом 300 МБ", async () => {
      const { disk } = diskPorts(false);
      const base = harness({
        pages: { [TAB_44]: setPage() },
        files: {
          CD01: { bytes: new Uint8Array(0), contentType: null, contentLength: 400 * MB, tooLarge: true },
          CD02: bytes(),
        },
      });
      const parseVolumes = vi.fn(async () => ok("не должно вызваться"));

      const result = await fetchTenderAttachments(
        TARGET_44,
        { ...base.deps, parseVolumes, disk },
        { budgetChars: 100_000 },
      );

      expect(parseVolumes).not.toHaveBeenCalled();
      expect(result.attachments[0]?.skipped?.reason).toContain("больше предела 300 МБ и не читается");
      expect(result.attachments[0]?.skipped?.reason).toContain(NO_ARCHIVE_CLI_FRAGMENT);
    });
  });
});
