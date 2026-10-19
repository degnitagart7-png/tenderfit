import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    from: mockFrom,
  }),
}));

interface ChainCall {
  table: string;
  method: string;
  args: unknown[];
}

const calls: ChainCall[] = [];
const EMPTY: { data: unknown; error: unknown } = { data: null, error: null };
/** Очередь ответов: запросов в методе может быть несколько (поиск + вставка). */
let responses: Array<{ data: unknown; error: unknown }> = [EMPTY];

const CHAIN_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "order",
  "limit",
  "range",
  "not",
  "or",
] as const;

/** Последний ответ остаётся для всех последующих запросов. */
function currentResponse(): { data: unknown; error: unknown } {
  if (responses.length > 1) return responses.shift() ?? EMPTY;
  return responses[0] ?? EMPTY;
}

/**
 * Цепочка вызовов PostgREST: любой метод возвращает её же и запоминает аргументы,
 * а await даёт текущий ответ. Заглушка не ломается, когда в запрос добавляется
 * ещё одно условие, и позволяет проверить, какие колонки действительно выбраны.
 */
function chainFor(table: string) {
  const node: Record<string, unknown> = {
    then: (resolve: (value: unknown) => void) => resolve(currentResponse()),
    single: async () => currentResponse(),
    maybeSingle: async () => currentResponse(),
  };
  for (const method of CHAIN_METHODS) {
    node[method] = (...args: unknown[]) => {
      calls.push({ table, method, args });
      return node;
    };
  }
  return node;
}

mockFrom.mockImplementation((table: string) => chainFor(table));

/** Успешный ответ. */
function mockData(data: unknown) {
  responses = [{ data, error: null }];
}

/** Ответ с ошибкой (например, PGRST116 — «строк не найдено»). */
function mockError(error: { code: string; message: string }) {
  responses = [{ data: null, error }];
}

/** Несколько ответов подряд — по одному на каждый запрос метода. */
function mockSequence(...items: Array<{ data: unknown; error: unknown }>) {
  responses = items;
}

/** Аргументы первого вызова указанного метода. */
function argsOf(method: string): unknown[] {
  return calls.find((call) => call.method === method)?.args ?? [];
}

/** Аргументы последнего вызова указанного метода. */
function lastArgsOf(method: string): unknown[] {
  return calls.findLast((call) => call.method === method)?.args ?? [];
}

const NOT_FOUND = { code: "PGRST116", message: "The result contains 0 rows" };

describe("documentRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    responses = [EMPTY];
    mockFrom.mockImplementation((table: string) => chainFor(table));
  });

  it("inserts a document and returns it", async () => {
    const doc = {
      id: "doc-1",
      tender_id: "0123456789",
      source_type: "eis_api",
      filename: "notice.pdf",
      document_type: "notice",
      file_url: "https://example.com/doc.pdf",
      download_status: "pending",
      parsed_status: "pending",
      created_at: "2026-09-21T00:00:00Z",
      updated_at: "2026-09-21T00:00:00Z",
    };

    mockData(doc);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.create({
      tender_id: "0123456789",
      source_type: "eis_api",
      filename: "notice.pdf",
      document_type: "notice",
      file_url: "https://example.com/doc.pdf",
    });

    expect(result).toEqual(doc);
    expect(mockFrom).toHaveBeenCalledWith("tender_documents");
  });

  it("finds documents by tender_id", async () => {
    const docs = [
      { id: "doc-1", tender_id: "0123456789", filename: "a.pdf" },
      { id: "doc-2", tender_id: "0123456789", filename: "b.pdf" },
    ];

    // Сначала список без текстов, затем каждый документ отдельным запросом (тексты бывают по 7 млн знаков).
    mockSequence(
      { data: docs.map((d) => ({ id: d.id })), error: null },
      { data: [docs[0]], error: null },
      { data: [docs[1]], error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.findByTenderId("0123456789");

    expect(result).toEqual(docs);
    expect(argsOf("select")).toEqual(["id"]);
  });

  it("finds a document by content_hash (cache lookup)", async () => {
    const doc = {
      id: "doc-1",
      content_hash: "abc123",
      parsed_text: "cached text",
    };

    mockData(doc);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.findByContentHash("abc123");

    expect(result).toEqual(doc);
  });

  it("updates parsed text and status", async () => {
    const doc = {
      id: "doc-1",
      parsed_text: "extracted text",
      parsed_status: "parsed",
      content_hash: "hash123",
    };

    mockData(doc);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.updateParsed("doc-1", {
      parsed_text: "extracted text",
      parsed_status: "parsed",
      content_hash: "hash123",
    });

    expect(result).toEqual(doc);
  });

  it("updateParsed без обрезки не трогает raw_json", async () => {
    mockData({ id: "doc-1", parsed_status: "parsed" });

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.updateParsed("doc-1", {
      parsed_text: "текст целиком",
      parsed_status: "parsed",
      content_hash: "hash123",
    });

    const updated = argsOf("update")[0] as Record<string, unknown>;
    expect(Object.keys(updated)).not.toContain("raw_json");
    // Без признака обрезки лишний запрос к базе не нужен.
    expect(calls.filter((call) => call.method === "select")).toHaveLength(1);
  });

  it("updateParsed дописывает обрезку, сохраняя прежние поля raw_json", async () => {
    // PostgREST заменяет JSONB целиком: title и chars, записанные при создании
    // строки, потерялись бы, и карточка осталась без заголовка документа.
    mockSequence(
      {
        data: { raw_json: { title: "Проект контракта", chars: 146_531 } },
        error: null,
      },
      { data: { id: "doc-1", parsed_status: "parsed" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.updateParsed("doc-1", {
      parsed_text: "ы".repeat(146_531),
      parsed_status: "parsed",
      content_hash: "hash123",
      truncated: true,
      archive: { parsed: 2, total: 15 },
    });

    // Чтение берёт только служебную колонку: parsed_text весит сотни килобайт.
    expect(String(argsOf("select")[0])).toBe("raw_json");
    const updated = argsOf("update")[0] as Record<string, unknown>;
    expect(updated["raw_json"]).toEqual({
      title: "Проект контракта",
      chars: 146_531,
      truncated: true,
      archive: { parsed: 2, total: 15 },
    });
  });

  /**
   * Закупка 32616404461: zip на 7,1 МБ уложился в бюджет знаков, обрезки нет —
   * и состав архива не записывался вовсе. Архив из сорока сканов выглядел бы
   * после этого прочитанным целиком.
   */
  it("updateParsed пишет состав архива и без обрезки", async () => {
    mockSequence(
      {
        data: { raw_json: { title: "Документация ОЗО", chars: 662_910 } },
        error: null,
      },
      { data: { id: "doc-1", parsed_status: "parsed" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.updateParsed("doc-1", {
      parsed_text: "текст",
      parsed_status: "parsed",
      content_hash: "hash123",
      archive: { parsed: 12, total: 40 },
    });

    const updated = argsOf("update")[0] as Record<string, unknown>;
    expect(updated["raw_json"]).toEqual({
      title: "Документация ОЗО",
      chars: 662_910,
      archive: { parsed: 12, total: 40 },
    });
  });

  it("updateParsed пишет обрезку и в пустой raw_json", async () => {
    mockSequence(
      { data: { raw_json: null }, error: null },
      { data: { id: "doc-1", parsed_status: "parsed" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.updateParsed("doc-1", {
      parsed_text: "ы".repeat(1_000_000),
      parsed_status: "parsed",
      content_hash: "hash123",
      truncated: true,
    });

    const updated = argsOf("update")[0] as Record<string, unknown>;
    // archive отсутствует, когда файл не архив: «прочитано 0 из 0» хуже, чем ничего.
    expect(updated["raw_json"]).toEqual({ truncated: true });
  });

  it("отдаёт список документов без текста", async () => {
    // Строка такой и приходит из БД: все колонки из META_COLUMNS на месте.
    const row = {
      id: "doc-1",
      filename: "print-form-1.html",
      document_type: "notice",
      source_type: "eis_api",
      file_url:
        "https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=1",
      parsed_status: "parsed",
      download_status: "downloaded",
      content_hash: "a".repeat(64),
      file_size: 238777,
      error_message: null,
      created_at: "2026-09-21T10:00:00Z",
      updated_at: "2026-09-21T10:00:05Z",
      raw_json: { title: "Извещение о закупке (печатная форма)" },
    };
    const withoutRaw = { ...row, id: "doc-2", raw_json: null };
    mockData([row, withoutRaw]);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.listMetaByTenderId("1");

    expect(result).toEqual([row, withoutRaw]);
    expect(result[1]?.raw_json).toBeNull();
    // parsed_text весит сотни килобайт — в выборке служебных полей его быть не должно.
    expect(String(argsOf("select")[0])).not.toContain("parsed_text");
    expect(String(argsOf("select")[0])).toContain("parsed_status");
  });

  it("saveParsed вставляет новую строку, если документа ещё нет", async () => {
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-new", parsed_status: "parsed" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveParsed({
      tender_id: "0573100026626000009",
      filename: "print-form-0573100026626000009.html",
      title: "Извещение о закупке (печатная форма)",
      document_type: "notice",
      source_type: "eis_api",
      file_url:
        "https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=1",
      mime_type: "text/html",
      parsed_text: "Текст извещения",
      content_hash: "a".repeat(64),
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    expect(inserted["parsed_status"]).toBe("parsed");
    expect(inserted["download_status"]).toBe("downloaded");
    expect(inserted["parsed_text"]).toBe("Текст извещения");
    expect(inserted["content_hash"]).toBe("a".repeat(64));
    expect(inserted["file_size"]).toBe(
      Buffer.byteLength("Текст извещения", "utf8"),
    );
    expect(inserted["raw_json"]).toEqual({
      title: "Извещение о закупке (печатная форма)",
    });
    expect(calls.some((call) => call.method === "update")).toBe(false);
  });

  it("saveParsed обновляет существующую строку с тем же именем файла", async () => {
    mockData({ id: "doc-42" });

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveParsed({
      tender_id: "0573100026626000009",
      filename: "print-form-0573100026626000009.html",
      document_type: "notice",
      source_type: "eis_api",
      parsed_text: "Обновлённый текст",
      content_hash: "b".repeat(64),
    });

    const updated = argsOf("update")[0] as Record<string, unknown>;
    expect(updated["parsed_text"]).toBe("Обновлённый текст");
    expect(updated["raw_json"]).toBeNull();
    // Обновление идёт по найденному id — дубль строки не появляется.
    expect(lastArgsOf("eq")).toEqual(["id", "doc-42"]);
    expect(calls.some((call) => call.method === "insert")).toBe(false);
  });

  it("saveParsed пробрасывает ошибку, отличную от «строк не найдено»", async () => {
    mockError({ code: "23514", message: "violates check constraint" });

    const { documentRepository } = await import("./documentRepository");
    await expect(
      documentRepository.saveParsed({
        tender_id: "1",
        filename: "a.html",
        document_type: "notice",
        source_type: "eis_api",
        parsed_text: "текст",
        content_hash: "c".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("saveParsed пишет объём файла и занятые знаки в бюджете закупки", async () => {
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-new" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveParsed({
      tender_id: "0573100026626000009",
      filename: "Проект контракта.docx",
      title: "Проект контракта",
      document_type: "contract",
      source_type: "eis_api",
      file_url:
        "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=AA03",
      mime_type: "application/download",
      parsed_text: "ы".repeat(146_531),
      content_hash: "d".repeat(64),
      // Настоящий объём файла больше длины текста: docx несёт разметку.
      file_size: 380_359,
      chars: 146_531,
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    expect(inserted["file_size"]).toBe(380_359);
    expect(inserted["raw_json"]).toEqual({
      title: "Проект контракта",
      chars: 146_531,
    });
  });

  it("saveParsed пишет признак обрезки и счётчик архива", async () => {
    // Закупка 32616393585: на архив документации о закупке остатка бюджета не
    // хватило, из 15 вложений прочитаны 2, а сумма знаков сошлась в миллион.
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-new" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveParsed({
      tender_id: "32616393585",
      filename: "ДОЗ.zip",
      title: "Документация о закупке",
      document_type: "attachment",
      source_type: "eis_api",
      parsed_text: "ы".repeat(173_598),
      content_hash: "e".repeat(64),
      file_size: 18_350_080,
      chars: 173_598,
      truncated: true,
      archive: { parsed: 2, total: 15 },
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    expect(inserted["raw_json"]).toEqual({
      title: "Документация о закупке",
      chars: 173_598,
      truncated: true,
      archive: { parsed: 2, total: 15 },
    });
  });

  it("saveParsed пишет пропущенные входы архива и чистит их имена для jsonb", async () => {
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-new" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveParsed({
      tender_id: "0338100003326000032",
      filename: "Документация.zip",
      document_type: "attachment",
      source_type: "eis_api",
      parsed_text: "ы".repeat(1000),
      content_hash: "a".repeat(64),
      archive: {
        parsed: 1,
        total: 3,
        skipped: [
          { name: "Смета\u0000.gsfx", reason: "формат gsfx не разбирается" },
          { name: "Чертёж.dwg", reason: "формат dwg не разбирается" },
        ],
      },
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    expect(inserted["raw_json"]).toEqual({
      archive: {
        parsed: 1,
        total: 3,
        skipped: [
          { name: "Смета.gsfx", reason: "формат gsfx не разбирается" },
          { name: "Чертёж.dwg", reason: "формат dwg не разбирается" },
        ],
      },
    });
  });

  it("saveParsed не пишет пустой список пропусков архива", async () => {
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-new" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveParsed({
      tender_id: "0338100003326000032",
      filename: "Документация.zip",
      document_type: "attachment",
      source_type: "eis_api",
      parsed_text: "ы".repeat(1000),
      content_hash: "a".repeat(64),
      archive: { parsed: 3, total: 3, skipped: [] },
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    expect(inserted["raw_json"]).toEqual({ archive: { parsed: 3, total: 3 } });
  });

  it("saveParsed не пишет признак обрезки, когда текст дошёл целиком", async () => {
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-new" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveParsed({
      tender_id: "0338100003326000032",
      filename: "ПРОЕКТ КОНТРАКТ.docx",
      title: "Проект контракта",
      document_type: "contract",
      source_type: "eis_api",
      parsed_text: "ы".repeat(40_092),
      content_hash: "f".repeat(64),
      chars: 40_092,
      truncated: false,
      archive: null,
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    // false в базе не отличить от отсутствия поля, а лишний ключ только путает.
    expect(inserted["raw_json"]).toEqual({
      title: "Проект контракта",
      chars: 40_092,
    });
  });

  it("saveSkipped пишет причину пропуска вместо текста", async () => {
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-skip" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveSkipped({
      tender_id: "0373100096726000028",
      filename: "Йошкар Ола ПСД.part01.rar",
      title: "Йошкар Ола ПСД.part01.rar",
      document_type: "attachment",
      source_type: "eis_api",
      file_url:
        "https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=AA07",
      file_size: 314_572_800,
      skipped: {
        code: "unsupported_format",
        reason: "Формат rar не разбирается: нужен отдельный распаковщик.",
      },
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    expect(inserted["parsed_text"]).toBeNull();
    expect(inserted["content_hash"]).toBeNull();
    expect(inserted["parsed_status"]).toBe("failed");
    expect(inserted["download_status"]).toBe("failed");
    expect(inserted["file_size"]).toBe(314_572_800);
    expect(inserted["error_message"]).toBe(
      "Формат rar не разбирается: нужен отдельный распаковщик.",
    );
    expect(inserted["raw_json"]).toEqual({
      title: "Йошкар Ола ПСД.part01.rar",
      // Ноль обязателен: по нему повторный прогон понимает, что бюджет свободен.
      chars: 0,
      skipped: {
        code: "unsupported_format",
        reason: "Формат rar не разбирается: нужен отдельный распаковщик.",
      },
    });
    // Ссылка на ЕИС сохраняется — по ней файл можно забрать вручную.
    expect(inserted["file_url"]).toContain("filestore");
  });

  it("saveSkipped обновляет строку, если пропуск уже записан", async () => {
    mockData({ id: "doc-skip" });

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveSkipped({
      tender_id: "0373100096726000028",
      filename: "Йошкар Ола ПСД.part01.rar",
      document_type: "attachment",
      source_type: "eis_api",
      skipped: { code: "over_char_budget", reason: "Не влез в бюджет." },
    });

    expect(calls.some((call) => call.method === "insert")).toBe(false);
    expect(lastArgsOf("eq")).toEqual(["id", "doc-skip"]);
    const updated = argsOf("update")[0] as Record<string, unknown>;
    expect(updated["raw_json"]).toEqual({
      chars: 0,
      skipped: { code: "over_char_budget", reason: "Не влез в бюджет." },
    });
  });

  it("listMetaByTenderId отдаёт признак пропуска из raw_json", async () => {
    mockData([
      {
        id: "doc-1",
        filename: "Проект контракта.docx",
        document_type: "contract",
        source_type: "eis_api",
        file_url: "https://zakupki.gov.ru/44fz/filestore/x",
        parsed_status: "parsed",
        download_status: "downloaded",
        content_hash: "a".repeat(64),
        file_size: 380_359,
        error_message: null,
        created_at: "2026-09-22T10:00:00Z",
        updated_at: "2026-09-22T10:00:05Z",
        raw_json: { title: "Проект контракта", chars: 146_531 },
      },
      {
        id: "doc-2",
        filename: "Скан.pdf",
        document_type: "attachment",
        source_type: "eis_api",
        file_url: "https://zakupki.gov.ru/44fz/filestore/y",
        parsed_status: "failed",
        download_status: "failed",
        content_hash: null,
        file_size: 1_048_576,
        error_message: "В файле нет текстового слоя.",
        created_at: "2026-09-22T10:00:01Z",
        updated_at: "2026-09-22T10:00:06Z",
        raw_json: {
          chars: 0,
          skipped: {
            code: "empty_text",
            reason: "В файле нет текстового слоя.",
          },
        },
      },
    ]);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.listMetaByTenderId("1");

    expect(result[0]?.raw_json?.chars).toBe(146_531);
    expect(result[1]?.raw_json?.skipped?.code).toBe("empty_text");
  });
  it("saveParsed пишет признак распознавания в raw_json", async () => {
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-ocr" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveParsed({
      tender_id: "0134300025826000377",
      filename: "Скан.pdf",
      document_type: "attachment",
      source_type: "eis_api",
      parsed_text: "[Текст распознан со скана: 3 стр. из 3]\nТекст",
      content_hash: "b".repeat(64),
      chars: 47,
      ocr: { pages: 3, totalPages: 3 },
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    expect(inserted["raw_json"]).toEqual({
      chars: 47,
      ocr: { pages: 3, totalPages: 3 },
    });
  });

  it("saveParsed без распознавания не добавляет поле ocr", async () => {
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-plain" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveParsed({
      tender_id: "0134300025826000377",
      filename: "Проект.docx",
      document_type: "contract",
      source_type: "eis_api",
      parsed_text: "Текст проекта контракта",
      content_hash: "c".repeat(64),
      chars: 23,
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    expect(inserted["raw_json"]).toEqual({ chars: 23 });
  });

  it("updateParsed дописывает ocr в raw_json, не теряя остальное", async () => {
    mockSequence(
      { data: { raw_json: { title: "Скан", chars: 0 } }, error: null },
      { data: { id: "doc-1" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.updateParsed("doc-1", {
      parsed_text: "Текст",
      parsed_status: "parsed",
      ocr: { pages: 2, totalPages: 4 },
    });

    const patch = argsOf("update")[0] as Record<string, unknown>;
    expect(patch["raw_json"]).toEqual({
      title: "Скан",
      chars: 0,
      ocr: { pages: 2, totalPages: 4 },
    });
  });

  it("listUnreadable берёт непрочитанные со ссылкой и отбирает по причине", async () => {
    const row = (id: string, tender: string, name: string, reason: string) => ({
      tender_id: tender,
      id,
      filename: name,
      document_type: "attachment",
      source_type: "eis_api",
      file_url: `https://zakupki.gov.ru/44fz/filestore/${id}`,
      parsed_status: "failed",
      download_status: "failed",
      content_hash: null,
      file_size: 10,
      error_message: reason,
      created_at: "2026-09-27T10:00:00Z",
      updated_at: "2026-09-27T10:00:00Z",
      raw_json: null,
    });
    mockData([
      row("1", "A", "Документация.rar", "Формат rar не разбирается: нужен отдельный распаковщик."),
      row("2", "B", "Скан.pdf", "Текстового слоя нет: файл отсканирован или пуст."),
    ]);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.listUnreadable({
      reasonLike: ["не разбирается", "Текстового слоя нет"],
    });

    expect(result.map((item) => [item.tender_id, item.filename])).toEqual([
      ["A", "Документация.rar"],
      ["B", "Скан.pdf"],
    ]);
    expect(argsOf("neq")).toEqual(["parsed_status", "parsed"]);
    expect(argsOf("not")).toEqual(["file_url", "is", null]);
    expect(argsOf("or")[0]).toBe(
      "error_message.ilike.*не разбирается*,error_message.ilike.*Текстового слоя нет*",
    );
    // Тексты документов не читаются.
    expect(String(argsOf("select")[0])).not.toContain("parsed_text");
  });

  it("listUnreadable с номером закупки сужает выборку", async () => {
    mockData([]);

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.listUnreadable({
      reasonLike: ["не разбирается"],
      tenderId: "0134300025826000377",
    });

    expect(argsOf("eq")).toEqual(["tender_id", "0134300025826000377"]);
  });
  it("listParsedArchives берёт прочитанные архивы по имени, без parsed_text", async () => {
    mockData([
      {
        tender_id: "A",
        id: "1",
        filename: "Документация.zip",
        document_type: "attachment",
        source_type: "eis_api",
        file_url: "https://zakupki.gov.ru/44fz/filestore/1",
        parsed_status: "parsed",
        download_status: "downloaded",
        content_hash: "h",
        file_size: 10,
        error_message: null,
        created_at: "2026-09-27T10:00:00Z",
        updated_at: "2026-09-27T10:00:00Z",
        raw_json: { chars: 40, archive: { parsed: 5, total: 59 } },
      },
    ]);

    const { documentRepository } = await import("./documentRepository");
    const result = await documentRepository.listParsedArchives({
      tenderId: "A",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.raw_json?.archive).toEqual({ parsed: 5, total: 59 });
    expect(argsOf("eq")).toEqual(["parsed_status", "parsed"]);
    expect(argsOf("not")).toEqual(["file_url", "is", null]);
    expect(String(argsOf("or")[0])).toBe(
      "filename.ilike.*.zip,filename.ilike.*.rar,filename.ilike.*.7z,filename.ilike.*.001,filename.ilike.*.part*.rar",
    );
    // Тексты документов не читаются: на больших текстах прод упирался в таймаут.
    expect(String(argsOf("select")[0])).not.toContain("parsed_text");
  });

  it("saveParsed вычищает нулевой символ и одиночные суррогаты: Postgres их не принимает", async () => {
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-nul" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveParsed({
      tender_id: "32616403300",
      filename: "д. Внуково.part1.rar",
      title: "д. Вну\u0000ково",
      document_type: "attachment",
      source_type: "eis_api",
      parsed_text: "Текст\u0000 после распознавания\u0001 \uD800 конец",
      content_hash: "d".repeat(64),
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    expect(inserted["parsed_text"]).toBe("Текст после распознавания  конец");
    expect(inserted["raw_json"]).toEqual({ title: "д. Внуково" });
    // Имя файла — ключ строки, его не меняем.
    expect(inserted["filename"]).toBe("д. Внуково.part1.rar");
    expect(JSON.stringify(inserted)).not.toContain("\\u0000");
  });

  it("saveSkipped вычищает причину с нулевым символом", async () => {
    mockSequence(
      { data: null, error: NOT_FOUND },
      { data: { id: "doc-skip-nul" }, error: null },
    );

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.saveSkipped({
      tender_id: "1",
      filename: "a.rar",
      document_type: "attachment",
      source_type: "eis_api",
      skipped: { code: "parse_failed", reason: "7-Zip: Ошибка\u0000 данных" },
    });

    const inserted = argsOf("insert")[0] as Record<string, unknown>;
    expect(inserted["error_message"]).toBe("7-Zip: Ошибка данных");
    expect(
      (inserted["raw_json"] as { skipped: { reason: string } }).skipped.reason,
    ).toBe("7-Zip: Ошибка данных");
  });

  it("updateParsed вычищает текст и причину", async () => {
    mockData({ id: "doc-1" });

    const { documentRepository } = await import("./documentRepository");
    await documentRepository.updateParsed("doc-1", {
      parsed_text: "Текст\u0000 документа",
      parsed_status: "parsed",
      error_message: "причина\u0000",
    });

    const patch = argsOf("update")[0] as Record<string, unknown>;
    expect(patch["parsed_text"]).toBe("Текст документа");
    expect(patch["error_message"]).toBe("причина");
  });
});
