import { describe, expect, it, vi, type Mock } from "vitest";
import type { ParsedAttachment } from "@/services/attachmentParser";
import type { DocumentsTabTarget } from "./eisAttachments";
import {
  fetchTenderAttachments,
  MAX_FILE_BYTES,
  type AttachmentFetchDeps,
  type FetchedFile,
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
      { uid: "AA01", name: "Обоснование НМЦК.PDF" },
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
      "Обоснование НМЦК.PDF",
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
    expect(row?.skipped?.reason).toContain(`${MAX_FILE_BYTES / 1_000_000} МБ`);
    expect(row?.fileSize).toBe(62_000_000);
    expect(row?.mimeType).toBe("application/octet-stream");
  });

  it("порт, прочитавший слишком большой файл целиком, всё равно не отдаёт его парсеру", async () => {
    const { deps, parse } = harness({
      pages: {
        [TAB_44]: docsPage([{ uid: "AA02", name: "Проект_контракта.zip" }]),
      },
      files: { AA02: bytes(MAX_FILE_BYTES + 1) },
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
