import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import {
  parseArchiveVolumes,
  parseAttachment,
  type ParsedAttachment,
} from "@/services/attachmentParser";
import {
  classifyReparseReason,
  parseReparseArgs,
  reparseUnreadable,
  MAX_CONSECUTIVE_SAVE_FAILURES,
  REPARSE_REASON_FRAGMENTS,
  type ReparseDeps,
  type ReparseDoc,
} from "@/services/documentReparse";
import type { FetchedFile } from "@/services/tenderAttachmentsFetcher";
import type { PreparedDocument } from "@/services/tenderDocumentSync";

/**
 * Скрипт повторного разбора: отбор строк по причинам, бюджет, тома, сканы,
 * dry-run. Сеть, база и распознавание — заглушки; настоящий SQL и ЕИС не нужны.
 */

const TENDER = "0134300025826000377";

function doc(
  overrides: Partial<ReparseDoc> & { filename: string },
): ReparseDoc {
  return {
    tenderId: TENDER,
    title: null,
    documentType: "attachment",
    sourceType: "eis_api",
    fileUrl: `https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=${encodeURIComponent(overrides.filename)}`,
    mimeType: "application/download",
    parsedStatus: "failed",
    reason: null,
    skipCode: "unsupported_format",
    chars: 0,
    fileSize: 1000,
    ...overrides,
  };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Setup {
  rows?: ReparseDoc[];
  files?: Record<string, Uint8Array>;
  parse?: ReparseDeps["parse"];
  ocr?: boolean;
  /** Имена файлов, чья запись падает; true — падает всё. */
  saveFails?: boolean | readonly string[];
  /** Заявленный объём файла: порт рвёт его, если он больше своего предела. */
  declared?: Record<string, number>;
  /** Чем падает запись; по умолчанию Error. */
  saveError?: unknown;
}

function setup(options: Setup = {}) {
  const rows = options.rows ?? [];
  const saved: { regNumber: string; document: PreparedDocument }[] = [];
  const fetched: string[] = [];
  const limits: (number | undefined)[] = [];
  const log: string[] = [];
  const listUnreadable = vi.fn(
    async (opts: { reasonLike: readonly string[]; tenderId?: string }) =>
      // Как настоящий порт: только непрочитанные.
      rows.filter(
        (row) =>
          row.parsedStatus !== "parsed" &&
          (!opts.tenderId || row.tenderId === opts.tenderId),
      ),
  );

  // Как настоящий порт: parsed-строки со ссылкой; частичность проверяет код.
  const listPartialArchives = vi.fn(async (opts: { tenderId?: string }) =>
    rows.filter(
      (row) =>
        row.parsedStatus === "parsed" &&
        (!opts.tenderId || row.tenderId === opts.tenderId),
    ),
  );

  const parse: ReparseDeps["parse"] =
    options.parse ??
    (async (bytes, filename, contentType, budget) =>
      parseAttachment(bytes, filename, contentType, budget, { ocr: null }));

  const deps: ReparseDeps = {
    store: {
      listUnreadable,
      listPartialArchives,
      listTender: async (tenderId) =>
        rows.filter((row) => row.tenderId === tenderId),
      save: async (regNumber, document) => {
        const fails =
          options.saveFails === true ||
          (Array.isArray(options.saveFails) &&
            options.saveFails.includes(document.filename));
        if (fails) throw options.saveError ?? new Error("connection reset");
        saved.push({ regNumber, document });
      },
    },
    fetchFile: async (url, fetchOptions): Promise<FetchedFile> => {
      const name = decodeURIComponent(/uid=([^&]+)/.exec(url)?.[1] ?? "");
      fetched.push(name);
      limits.push(fetchOptions?.maxBytes);
      const bytes = options.files?.[name];
      if (!bytes) throw new Error(`нет файла ${name}`);
      // Как настоящий порт: файл больше предела не отдаётся, остаётся его объём.
      const size = options.declared?.[name] ?? bytes.byteLength;
      if (size > (fetchOptions?.maxBytes ?? 50_000_000)) {
        return {
          bytes: new Uint8Array(0),
          contentType: "application/download",
          contentLength: size,
          tooLarge: true,
        };
      }
      return { bytes, contentType: "application/download" };
    },
    parse,
    parseVolumes: (volumes, budget) =>
      parseArchiveVolumes(volumes, budget, { ocr: null }),
    ocrAvailable: async () => options.ocr ?? false,
    log: (line) => log.push(line),
  };
  return { deps, saved, fetched, limits, log, listUnreadable, listPartialArchives };
}

const FORMAT_REASON = (ext: string) =>
  `Формат ${ext} не разбирается: нужен отдельный распаковщик или распознавание.`;

describe("classifyReparseReason", () => {
  it("форматы, поддержанные теперь", () => {
    for (const ext of [
      "rar",
      "7z",
      "odt",
      "ods",
      "odp",
      "rtf",
      "001",
      "002",
      "png",
      "jpg",
      "jpeg",
      "tif",
      "tiff",
    ]) {
      expect(classifyReparseReason(FORMAT_REASON(ext))).toBe("format");
    }
  });

  it("rtf под чужим именем (отказ по содержимому)", () => {
    expect(
      classifyReparseReason(
        "Формат rtf не разбирается: нужен отдельный распаковщик или распознавание. Файл назван «.pdf», но внутри rtf.",
      ),
    ).toBe("format");
  });

  it("ложное «0.0 МБ больше предела» прежней загрузки томов перечитывается", () => {
    expect(
      classifyReparseReason("Комплект томов объёмом 0.0 МБ больше предела 300 МБ и не читается."),
    ).toBe("format");
    // Предел комплекта поднят до 2 ГБ: отказ при прежних 300 МБ больше не правда.
    expect(
      classifyReparseReason("Комплект томов объёмом 320.0 МБ больше предела 300 МБ и не читается."),
    ).toBe("limit");
  });

  it("«Не влез в бюджет» перечитывается: бюджет знаков снят", () => {
    expect(
      classifyReparseReason(
        "Не влез в бюджет 1 000 000 знаков на закупку. Сначала читаются проект контракта и описание объекта закупки — этот файл оказался дальше по списку.",
      ),
    ).toBe("budget");
    expect(REPARSE_REASON_FRAGMENTS).toContain("Не влез в бюджет");
  });

  it("«больше предела … и не читается» — и для файла, и для комплекта", () => {
    expect(REPARSE_REASON_FRAGMENTS).toContain("больше предела");
    expect(
      classifyReparseReason("Файл объёмом 80.0 МБ больше предела 50 МБ и не читается."),
    ).toBe("limit");
    expect(classifyReparseReason("Файл больше предела 50 МБ и не читается.")).toBe("limit");
    expect(
      classifyReparseReason("Комплект томов объёмом 308.0 МБ больше предела 300 МБ и не читается."),
    ).toBe("limit");
  });

  it("отказ при действующем пределе не перечитывается: новый код дал бы тот же", () => {
    expect(
      classifyReparseReason("Файл объёмом 350.0 МБ больше предела 300 МБ и не читается."),
    ).toBeNull();
    expect(
      classifyReparseReason("Комплект томов объёмом 2100.0 МБ больше предела 2000 МБ и не читается."),
    ).toBeNull();
  });

  it("текстового слоя нет — скан", () => {
    expect(
      classifyReparseReason("Текстового слоя нет: файл отсканирован или пуст."),
    ).toBe("scan");
    expect(
      classifyReparseReason(
        "Текстового слоя нет: файл отсканирован или пуст. Распознавание на этом сервере недоступно.",
      ),
    ).toBe("scan");
  });

  it("отсутствовавшая библиотека и Invalid PDF structure", () => {
    expect(
      classifyReparseReason(
        "Cannot find package '7z-wasm' imported from /srv/app/archiveReaders.js",
      ),
    ).toBe("module");
    expect(classifyReparseReason("Invalid PDF structure.")).toBe(
      "pdf_structure",
    );
  });

  it("картинка без распознавания — тоже скан: перечитывается, когда оно появилось", () => {
    expect(
      classifyReparseReason(
        `${FORMAT_REASON("png")} Распознавание на этом сервере недоступно.`,
      ),
    ).toBe("scan");
    expect(
      classifyReparseReason("Распознавание на этом сервере недоступно."),
    ).toBe("scan");
  });

  it("то, что новый код не изменит, не перечитывается", () => {
    expect(classifyReparseReason(FORMAT_REASON("dwg"))).toBeNull();
    expect(
      classifyReparseReason("Схема или чертёж: текста почти нет."),
    ).toBeNull();
    expect(
      classifyReparseReason("Архив под паролем: содержимое прочитать нечем."),
    ).toBeNull();
    expect(
      classifyReparseReason("Том комплекта: прочитан вместе с «a.zip.001»."),
    ).toBeNull();
    expect(classifyReparseReason(null)).toBeNull();
    expect(classifyReparseReason("")).toBeNull();
  });

  it("подстроки для базы покрывают все группы причин", () => {
    for (const reason of [
      FORMAT_REASON("rar"),
      "Текстового слоя нет: файл отсканирован или пуст.",
      "Cannot find package 'x'",
      "Invalid PDF structure.",
      "Не влез в бюджет 1 000 000 знаков на закупку.",
      "Файл объёмом 80.0 МБ больше предела 50 МБ и не читается.",
      "Комплект томов объёмом 308.0 МБ больше предела 300 МБ и не читается.",
    ]) {
      expect(
        REPARSE_REASON_FRAGMENTS.some((fragment) => reason.includes(fragment)),
      ).toBe(true);
    }
  });
});

describe("reparseUnreadable — отбор строк", () => {
  const rows = [
    doc({ filename: "Документация.rar", reason: FORMAT_REASON("rar") }),
    doc({ filename: "Ведомость.odt", reason: FORMAT_REASON("odt") }),
    doc({
      filename: "Скан.pdf",
      reason: "Текстового слоя нет: файл отсканирован или пуст.",
      skipCode: "empty_text",
    }),
    doc({
      filename: "Большой.docx",
      reason: "Не влез в бюджет 1 000 000 знаков на закупку.",
      skipCode: "over_char_budget",
    }),
    doc({ filename: "Чертёж.dwg", reason: FORMAT_REASON("dwg") }),
    doc({
      filename: "Прочитанный.docx",
      parsedStatus: "parsed",
      reason: null,
      skipCode: null,
    }),
    doc({
      filename: "Без ссылки.rar",
      reason: FORMAT_REASON("rar"),
      fileUrl: null,
    }),
    doc({
      tenderId: "0000000000000000001",
      filename: "Чужая.7z",
      reason: FORMAT_REASON("7z"),
    }),
  ];

  it("выбирает только непрочитанные со ссылкой и причиной из списка", async () => {
    const { deps } = setup({ rows });

    const report = await reparseUnreadable(deps, { dryRun: true });

    // «Не влез в бюджет» теперь кандидат: бюджет снят.
    expect(report.candidates).toBe(5);
    expect(report.tenders).toBe(2);
    expect(report.byCategory).toEqual({
      archive_partial: 0,
      format: 3,
      scan: 1,
      module: 0,
      pdf_structure: 0,
      budget: 1,
      limit: 0,
    });
  });

  it("--tender сужает выборку одной закупкой и передаётся в базу", async () => {
    const { deps, listUnreadable } = setup({ rows });

    const report = await reparseUnreadable(deps, {
      dryRun: true,
      tenderId: TENDER,
    });

    expect(listUnreadable).toHaveBeenCalledWith(
      expect.objectContaining({ tenderId: TENDER }),
    );
    expect(report.candidates).toBe(4);
    expect(report.tenders).toBe(1);
  });

  it("--limit ограничивает число закупок", async () => {
    const { deps } = setup({ rows });

    const report = await reparseUnreadable(deps, { dryRun: true, limit: 1 });

    expect(report.tenders).toBe(1);
    expect(report.candidates).toBe(4);
  });
});

describe("reparseUnreadable — dry-run", () => {
  it("ничего не скачивает и не пишет, только перечисляет и считает", async () => {
    const { deps, saved, fetched, log } = setup({
      rows: [
        doc({ filename: "Документация.rar", reason: FORMAT_REASON("rar") }),
        doc({
          filename: "Скан.pdf",
          reason: "Текстового слоя нет: файл отсканирован или пуст.",
        }),
      ],
      files: { "Документация.rar": utf8("x") },
      ocr: true,
    });

    const report = await reparseUnreadable(deps, { dryRun: true });

    expect(fetched).toEqual([]);
    expect(saved).toEqual([]);
    expect(report.candidates).toBe(2);
    expect(report.processed).toBe(0);
    expect(log.join("\n")).toContain("[dry-run]");
    expect(log.join("\n")).toContain("Документация.rar");
  });

  it("сообщает, есть ли на машине распознавание", async () => {
    const { deps, log } = setup({
      rows: [
        doc({
          filename: "Скан.pdf",
          reason: "Текстового слоя нет: файл отсканирован или пуст.",
        }),
      ],
      ocr: false,
    });

    await reparseUnreadable(deps, { dryRun: true });

    expect(log.join("\n")).toContain("распознавания на этой машине нет");
  });
});

describe("reparseUnreadable — перечитывание", () => {
  const ODT_NAME = "Приложение № 3 Ведомость объемов работ.odt";

  async function makeOdt(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("mimetype", "application/vnd.oasis.opendocument.text");
    zip.file(
      "content.xml",
      '<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="b"><office:body><office:text>' +
        "<text:p>Ведомость объёмов работ по ремонту фасада здания</text:p>" +
        "<table:table><table:table-row><table:table-cell><text:p>1</text:p></table:table-cell>" +
        "<table:table-cell><text:p>Штукатурка</text:p></table:table-cell></table:table-row></table:table>" +
        "</office:text></office:body></office:document-content>",
    );
    zip.file("META-INF/manifest.xml", "<manifest/>");
    return zip.generateAsync({ type: "uint8array" });
  }

  it("скачивает odt по ссылке, читает новым кодом и пишет парсед-строку", async () => {
    const { deps, saved, fetched } = setup({
      rows: [doc({ filename: ODT_NAME, reason: FORMAT_REASON("odt") })],
      files: { [ODT_NAME]: await makeOdt() },
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(fetched).toEqual([ODT_NAME]);
    expect(saved).toHaveLength(1);
    const { regNumber, document } = saved[0]!;
    expect(regNumber).toBe(TENDER);
    expect(document.filename).toBe(ODT_NAME);
    expect(document.skipped).toBeNull();
    expect(document.text).toContain("1\tШтукатурка");
    expect(document.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.recovered).toBe(1);
    expect(report.stillUnreadable).toBe(0);
  });

  it("файл, который по-прежнему не читается, получает свежую причину", async () => {
    const { deps, saved } = setup({
      rows: [doc({ filename: "Битый.odt", reason: FORMAT_REASON("odt") })],
      files: { "Битый.odt": utf8("это не документ") },
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(saved[0]?.document.skipped?.code).toBe("parse_failed");
    expect(report.stillUnreadable).toBe(1);
    expect(report.recovered).toBe(0);
  });

  it("сбой скачивания записывается как download_failed", async () => {
    const { deps, saved } = setup({
      rows: [doc({ filename: "Пропал.rar", reason: FORMAT_REASON("rar") })],
      files: {},
    });

    await reparseUnreadable(deps, { dryRun: false });

    expect(saved[0]?.document.skipped?.code).toBe("download_failed");
  });

  it("проект контракта читается раньше остальных", async () => {
    const { deps, fetched } = setup({
      rows: [
        doc({ filename: "Справка.rar", reason: FORMAT_REASON("rar") }),
        doc({ filename: ODT_NAME, reason: FORMAT_REASON("odt") }),
        doc({ filename: "Проект контракта.rtf", reason: FORMAT_REASON("rtf") }),
      ],
      files: {
        "Справка.rar": utf8("x"),
        [ODT_NAME]: await makeOdt(),
        "Проект контракта.rtf": utf8("{\\rtf1 x}"),
      },
    });

    await reparseUnreadable(deps, { dryRun: false });

    expect(fetched).toEqual(["Проект контракта.rtf", ODT_NAME, "Справка.rar"]);
  });

  it("сбой записи одного документа не останавливает прогон: причина в журнале, счёт в отчёте", async () => {
    const { deps, saved, log } = setup({
      rows: [
        doc({ filename: "А.odt", reason: FORMAT_REASON("odt") }),
        doc({
          tenderId: "0000000000000000002",
          filename: "Б.odt",
          reason: FORMAT_REASON("odt"),
        }),
      ],
      files: { "А.odt": utf8("x"), "Б.odt": utf8("x") },
      saveFails: ["А.odt"],
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(saved.map((item) => item.document.filename)).toEqual(["Б.odt"]);
    expect(report.saveFailures).toBe(1);
    expect(report.aborted).toBeNull();
    expect(report.processed).toBe(2);
    expect(log.join("\n")).toContain("не удалось сохранить А.odt");
  });

  it("ошибка Supabase печатается читаемо, а не «[object Object]»", async () => {
    const { deps, log } = setup({
      rows: [
        doc({ filename: "д. Внуково.part1.rar", reason: FORMAT_REASON("rar") }),
      ],
      files: { "д. Внуково.part1.rar": utf8("x") },
      saveFails: true,
      saveError: {
        message: "unsupported Unicode escape sequence",
        code: "22P05",
        details: "\\u0000 cannot be converted to text.",
        hint: null,
      },
    });

    await reparseUnreadable(deps, { dryRun: false });

    const text = log.join("\n");
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("unsupported Unicode escape sequence");
    expect(text).toContain("22P05");
    expect(text).toContain("д. Внуково.part1.rar");
  });

  it("много сбоев записи подряд — база недоступна, прогон останавливается", async () => {
    const rows = Array.from(
      { length: MAX_CONSECUTIVE_SAVE_FAILURES + 5 },
      (_, i) => doc({ filename: `Ф${i}.odt`, reason: FORMAT_REASON("odt") }),
    );
    const files = Object.fromEntries(
      rows.map((row) => [row.filename, utf8("x")]),
    );
    const { deps } = setup({ rows, files, saveFails: true });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(report.saveFailures).toBe(MAX_CONSECUTIVE_SAVE_FAILURES);
    expect(report.aborted).toContain("сбоев записи подряд");
  });

  it("успешная запись обнуляет счёт подряд идущих сбоев", async () => {
    const rows = Array.from(
      { length: MAX_CONSECUTIVE_SAVE_FAILURES * 2 },
      (_, i) => doc({ filename: `Ф${i}.odt`, reason: FORMAT_REASON("odt") }),
    );
    const files = Object.fromEntries(
      rows.map((row) => [row.filename, utf8("x")]),
    );
    // Падает каждый второй: подряд — никогда больше одного.
    const failing = rows
      .filter((_, i) => i % 2 === 0)
      .map((row) => row.filename);
    const { deps } = setup({ rows, files, saveFails: failing });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(report.aborted).toBeNull();
    expect(report.saveFailures).toBe(failing.length);
  });

  it("не записанный документ прочитанным не считается", async () => {
    const { deps } = setup({
      rows: [doc({ filename: "А.odt", reason: FORMAT_REASON("odt") })],
      files: { "А.odt": utf8("{\\rtf1 x}") },
      saveFails: true,
      parse: async () => ({
        text: "т".repeat(60),
        status: "parsed",
        reason: null,
        truncated: false,
      }),
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(report.recovered).toBe(0);
  });
});

describe("reparseUnreadable — бюджет знаков закупки", () => {
  const capture = () => {
    const budgets: number[] = [];
    const parse: ReparseDeps["parse"] = async (
      _bytes,
      _name,
      _type,
      budget,
    ): Promise<ParsedAttachment> => {
      budgets.push(budget);
      return {
        text: "т".repeat(60),
        status: "parsed",
        reason: null,
        truncated: false,
      };
    };
    return { budgets, parse };
  };

  it("уже прочитанное занимает бюджет: перечитанному достаётся остаток", async () => {
    const { budgets, parse } = capture();
    const { deps } = setup({
      rows: [
        doc({
          filename: "Проект.docx",
          parsedStatus: "parsed",
          reason: null,
          skipCode: null,
          chars: 700,
        }),
        doc({
          filename: "Ранее.docx",
          parsedStatus: "parsed",
          reason: null,
          skipCode: null,
          chars: null,
          fileSize: 400,
        }),
        doc({ filename: "Ведомость.odt", reason: FORMAT_REASON("odt") }),
      ],
      files: { "Ведомость.odt": utf8("x") },
      parse,
    });

    await reparseUnreadable(deps, { dryRun: false, budgetChars: 1000 });

    // 700 из chars и 200 (= 400 / 2) из file_size старой строки: осталось 100.
    expect(budgets).toEqual([100]);
  });

  it("добавленный текст уменьшает остаток для следующих файлов закупки", async () => {
    const { budgets, parse } = capture();
    const { deps } = setup({
      rows: [
        doc({ filename: "А.odt", reason: FORMAT_REASON("odt") }),
        doc({ filename: "Б.odt", reason: FORMAT_REASON("odt") }),
      ],
      files: { "А.odt": utf8("x"), "Б.odt": utf8("x") },
      parse,
    });

    await reparseUnreadable(deps, { dryRun: false, budgetChars: 100 });

    expect(budgets).toEqual([100, 40]);
  });

  it("бюджет исчерпан — файл не скачивается, причина меняется на «бюджет»", async () => {
    const { budgets, parse } = capture();
    const { deps, saved, fetched } = setup({
      rows: [
        doc({
          filename: "Проект.docx",
          parsedStatus: "parsed",
          reason: null,
          skipCode: null,
          chars: 1000,
        }),
        doc({ filename: "Ведомость.odt", reason: FORMAT_REASON("odt") }),
      ],
      files: { "Ведомость.odt": utf8("x") },
      parse,
    });

    const report = await reparseUnreadable(deps, {
      dryRun: false,
      budgetChars: 1000,
    });

    expect(fetched).toEqual([]);
    expect(budgets).toEqual([]);
    expect(saved[0]?.document.skipped?.code).toBe("over_char_budget");
    expect(report.overBudget).toBe(1);
  });

  it("по умолчанию бюджета знаков нет", async () => {
    const { budgets, parse } = capture();
    const { deps } = setup({
      rows: [doc({ filename: "Ведомость.odt", reason: FORMAT_REASON("odt") })],
      files: { "Ведомость.odt": utf8("x") },
      parse,
    });

    await reparseUnreadable(deps, { dryRun: false });

    expect(budgets).toEqual([Number.POSITIVE_INFINITY]);
  });

  it("строка «Не влез в бюджет» перечитывается и получает текст", async () => {
    const { budgets, parse } = capture();
    const { deps, saved } = setup({
      rows: [
        doc({
          filename: "Ведомость.docx",
          reason: "Не влез в бюджет 1 000 000 знаков на закупку. Сначала читаются проект контракта.",
          skipCode: "over_char_budget",
        }),
      ],
      files: { "Ведомость.docx": utf8("x") },
      parse,
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(report.byCategory.budget).toBe(1);
    expect(report.recovered).toBe(1);
    expect(budgets).toHaveLength(1);
    expect(saved[0]?.document.skipped).toBeNull();
  });

  it("строка «больше предела 50 МБ» перечитывается: предел теперь 300 МБ", async () => {
    const { parse } = capture();
    const { deps, saved } = setup({
      rows: [
        doc({
          filename: "Проект.pdf",
          reason: "Файл объёмом 80.0 МБ больше предела 50 МБ и не читается.",
          skipCode: "file_too_large",
        }),
      ],
      files: { "Проект.pdf": utf8("x") },
      parse,
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(report.byCategory.limit).toBe(1);
    expect(report.recovered).toBe(1);
    expect(saved[0]?.document.skipped).toBeNull();
  });
});

describe("reparseUnreadable — сканы", () => {
  const rows = [
    doc({
      filename: "Скан.pdf",
      reason: "Текстового слоя нет: файл отсканирован или пуст.",
      skipCode: "empty_text",
    }),
    doc({
      filename: "схема.png",
      reason: `${FORMAT_REASON("png")} Распознавание на этом сервере недоступно.`,
      skipCode: "empty_text",
    }),
    doc({ filename: "Ведомость.odt", reason: FORMAT_REASON("odt") }),
  ];

  it("без распознавания на машине сканы и картинки не трогаются, остальное читается", async () => {
    const { deps, fetched, saved } = setup({
      rows,
      files: {
        "Скан.pdf": utf8("%PDF"),
        "схема.png": utf8("x"),
        "Ведомость.odt": utf8("x"),
      },
      ocr: false,
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(fetched).toEqual(["Ведомость.odt"]);
    expect(saved.map((item) => item.document.filename)).toEqual([
      "Ведомость.odt",
    ]);
    expect(report.skippedNoOcr).toBe(2);
  });

  it("с распознаванием сканы скачиваются", async () => {
    const { deps, fetched } = setup({
      rows,
      files: {
        "Скан.pdf": utf8("%PDF"),
        "схема.png": utf8("x"),
        "Ведомость.odt": utf8("x"),
      },
      ocr: true,
      parse: async () => ({
        text: "",
        status: "empty",
        reason: "Схема или чертёж: текста почти нет.",
        truncated: false,
      }),
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(fetched.sort()).toEqual(
      ["Ведомость.odt", "Скан.pdf", "схема.png"].sort(),
    );
    expect(report.skippedNoOcr).toBe(0);
  });

  it("признак распознавания доходит до записи", async () => {
    const parse: ReparseDeps["parse"] = async () => ({
      text: "[Текст распознан со скана: 2 стр. из 2]\n" + "т".repeat(60),
      status: "parsed",
      reason: null,
      truncated: false,
      ocr: { pages: 2, totalPages: 2 },
    });
    const { deps, saved } = setup({
      rows: [rows[0]!],
      files: { "Скан.pdf": utf8("%PDF") },
      ocr: true,
      parse,
    });

    await reparseUnreadable(deps, { dryRun: false });

    expect(saved[0]?.document.ocr).toEqual({ pages: 2, totalPages: 2 });
  });
});

describe("reparseUnreadable — тома", () => {
  async function zipParts(
    count: number,
    stem: string,
  ): Promise<Record<string, Uint8Array>> {
    const zip = new JSZip();
    zip.file(
      "Проект контракта.txt",
      "Проект контракта: срок поставки 30 календарных дней.",
    );
    zip.file(
      "Спецификация.txt",
      "Спецификация: радиаторы биметаллические, 120 штук.",
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const size = Math.ceil(bytes.length / count);
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < count; i += 1) {
      files[`${stem}.${String(i + 1).padStart(3, "0")}`] = bytes.subarray(
        i * size,
        (i + 1) * size,
      );
    }
    return files;
  }

  const volumeRows = (names: string[]): ReparseDoc[] =>
    names.map((filename, index) =>
      doc({
        filename,
        reason:
          index === 0
            ? FORMAT_REASON("001")
            : "Том комплекта: прочитан вместе с «a».",
        skipCode: index === 0 ? "unsupported_format" : "volume_of_set",
      }),
    );

  it("тома склеиваются комплектом: текст у первого, остальные помечены", async () => {
    const files = await zipParts(3, "СД_2-этап.zip");
    const names = Object.keys(files);
    const { deps, saved, fetched } = setup({ rows: volumeRows(names), files });

    const report = await reparseUnreadable(deps, { dryRun: false });

    // Кандидат один (первый том), но скачаны и прочитаны все три: «не кандидаты»
    // входят в комплект.
    expect(fetched.sort()).toEqual([...names].sort());
    expect(saved).toHaveLength(3);
    expect(saved[0]?.document.filename).toBe(names[0]);
    expect(saved[0]?.document.skipped).toBeNull();
    expect(saved[0]?.document.text).toContain("=== Проект контракта.txt ===");
    expect(saved.slice(1).map((item) => item.document.skipped?.code)).toEqual([
      "volume_of_set",
      "volume_of_set",
    ]);
    expect(report.recovered).toBe(1);
  });

  it("размер в базе 0 или null не мешает: комплект скачивается и читается", async () => {
    const files = await zipParts(3, "СД.zip");
    const names = Object.keys(files);
    const rows = volumeRows(names).map((row, i) => ({
      ...row,
      fileSize: i === 0 ? null : 0,
    }));
    const { deps, saved } = setup({ rows, files });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(report.recovered).toBe(1);
    expect(saved[0]?.document.skipped).toBeNull();
    expect(JSON.stringify(saved)).not.toContain("больше предела");
  });

  it("том крупнее 50 МБ не считается «слишком большим файлом»: порт получает предел комплекта", async () => {
    const files = await zipParts(2, "Внуково.zip");
    const names = Object.keys(files);
    const declared = { [names[0]!]: 90_000_000, [names[1]!]: 90_000_000 };
    const { deps, saved, limits } = setup({
      rows: volumeRows(names),
      files,
      declared,
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(limits[0]).toBe(300_000_000);
    expect(saved[0]?.document.skipped).toBeNull();
    expect(report.recovered).toBe(1);
  });

  it("настоящее превышение предела комплекта отказывает с названным объёмом", async () => {
    const files = await zipParts(3, "Внуково.zip");
    const names = Object.keys(files);
    // Третий том один не помещается в предел комплекта: порт его рвёт и называет объём.
    const declared = { [names[2]!]: 310_000_000 };
    const { deps, saved } = setup({ rows: volumeRows(names), files, declared });

    await reparseUnreadable(deps, { dryRun: false });

    expect(saved).toHaveLength(3);
    expect(saved.every((item) => item.document.skipped?.code === "file_too_large")).toBe(true);
    const reason = saved[0]?.document.skipped?.reason ?? "";
    expect(reason).toContain("больше предела 300 МБ");
    expect(reason).toContain("310.0 МБ");
  });

  it("не хватает тома по именам — ничего не скачивается, причина называет том", async () => {
    const files = await zipParts(3, "ПД.zip");
    const names = Object.keys(files);
    const { deps, saved, fetched } = setup({
      rows: volumeRows([names[0]!, names[2]!]),
      files,
    });

    await reparseUnreadable(deps, { dryRun: false });

    expect(fetched).toEqual([]);
    expect(saved).toHaveLength(2);
    expect(saved[0]?.document.skipped?.reason).toContain("не хватает тома 002");
  });

  it("комплект, где том уже прочитан, пропускается", async () => {
    const files = await zipParts(2, "ПД.zip");
    const names = Object.keys(files);
    const rows = volumeRows(names);
    rows[1] = {
      ...rows[1]!,
      parsedStatus: "parsed",
      reason: null,
      skipCode: null,
    };
    const { deps, saved, fetched } = setup({ rows, files });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(fetched).toEqual([]);
    expect(saved).toEqual([]);
    expect(report.skippedSets).toBe(1);
  });

  it("тома не мешают одиночным файлам той же закупки", async () => {
    const files = await zipParts(2, "ПД.zip");
    const names = Object.keys(files);
    const { deps, saved } = setup({
      rows: [
        ...volumeRows(names),
        doc({ filename: "Письмо.rtf", reason: FORMAT_REASON("rtf") }),
      ],
      files: {
        ...files,
        "Письмо.rtf": utf8(
          "{\\rtf1\\ansi Letter text of the customer to the contractor}",
        ),
      },
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(report.processed).toBe(2);
    expect(saved.map((item) => item.document.filename).sort()).toEqual(
      [...names, "Письмо.rtf"].sort(),
    );
  });
});

describe("reparseUnreadable — архивы, прочитанные частично", () => {
  const ARCHIVE = "Документация о закупке.zip";

  /** Архив из трёх читаемых файлов и одного нечитаемого. */
  async function makeArchive(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("ТЗ.txt", "Техническое задание: срок поставки 30 календарных дней.");
    zip.file("Смета.txt", "Локальная смета: штукатурка стен, 120 квадратных метров.");
    zip.file("График.txt", "График выполнения работ: начало 01.03, окончание 30.04.");
    zip.file("Узел.dwg", "AC1015");
    return zip.generateAsync({ type: "uint8array" });
  }

  const partialRow = (overrides: Partial<ReparseDoc> = {}): ReparseDoc =>
    doc({
      filename: ARCHIVE,
      parsedStatus: "parsed",
      reason: null,
      skipCode: null,
      chars: 40,
      archive: { parsed: 1, total: 4, listed: false },
      ...overrides,
    });

  it("отбирает parsed-архив с parsed < total без списка пропусков", async () => {
    const { deps, listUnreadable, listPartialArchives } = setup({
      rows: [
        partialRow(),
        // Прочитан целиком.
        partialRow({ filename: "Целиком.zip", archive: { parsed: 3, total: 3, listed: false } }),
        // Уже перечитан нынешним разбором: честно непрочитанные входы названы.
        partialRow({ filename: "Перечитан.zip", archive: { parsed: 1, total: 4, listed: true } }),
        // Не архив.
        partialRow({ filename: "Обычный.docx", archive: null }),
        // Нет ссылки.
        partialRow({ filename: "Без ссылки.zip", fileUrl: null }),
      ],
    });

    const report = await reparseUnreadable(deps, { dryRun: true });

    expect(listUnreadable).toHaveBeenCalledTimes(1);
    expect(listPartialArchives).toHaveBeenCalledTimes(1);
    expect(report.candidates).toBe(1);
    expect(report.byCategory.archive_partial).toBe(1);
  });

  it("dry-run печатает старое «прочитано из»", async () => {
    const { deps, log, fetched } = setup({ rows: [partialRow()] });

    await reparseUnreadable(deps, { dryRun: true });

    expect(fetched).toEqual([]);
    expect(log.join("\n")).toContain("[archive_partial]");
    expect(log.join("\n")).toContain("прочитано 1 из 4 файлов архива");
  });

  it("--only archive_partial не запрашивает нечитаемые, а --only format — архивы", async () => {
    const a = setup({ rows: [partialRow()] });
    await reparseUnreadable(a.deps, { dryRun: true, only: "archive_partial" });
    expect(a.listUnreadable).not.toHaveBeenCalled();
    expect(a.listPartialArchives).toHaveBeenCalled();

    const b = setup({
      rows: [partialRow(), doc({ filename: "Письмо.rtf", reason: FORMAT_REASON("rtf") })],
    });
    const report = await reparseUnreadable(b.deps, { dryRun: true, only: "format" });
    expect(b.listPartialArchives).not.toHaveBeenCalled();
    expect(report.candidates).toBe(1);
    expect(report.byCategory.archive_partial).toBe(0);
  });

  it("заменяет строку, когда прочитано больше входов, и список пропусков уходит в запись", async () => {
    const { deps, saved, fetched, log } = setup({
      rows: [partialRow()],
      files: { [ARCHIVE]: await makeArchive() },
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(fetched).toEqual([ARCHIVE]);
    expect(saved).toHaveLength(1);
    const { document } = saved[0]!;
    expect(document.filename).toBe(ARCHIVE);
    expect(document.skipped).toBeNull();
    expect(document.archive).toMatchObject({ parsed: 3, total: 4 });
    expect(document.archive?.skipped?.map((entry) => entry.name)).toEqual(["Узел.dwg"]);
    expect(report.improved).toBe(1);
    expect(report.notImproved).toBe(0);
    expect(report.recovered).toBe(0);
    expect(log.join("\n")).toContain("входов было 1 из 4, стало 3 из 4");
  });

  it("не заменяет, когда новый результат не лучше прежнего", async () => {
    // Старая строка уже читает 3 из 4 и содержит больше текста, чем даст файл.
    const { deps, saved, log } = setup({
      rows: [partialRow({ chars: 1_000_000, archive: { parsed: 3, total: 4, listed: false } })],
      files: { [ARCHIVE]: await makeArchive() },
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(saved).toEqual([]);
    expect(report.improved).toBe(0);
    expect(report.notImproved).toBe(1);
    expect(log.join("\n")).toContain("не лучше прежнего");
  });

  it("не лучше прежнего — текст не тронут, но список непрочитанных записывается", async () => {
    const { deps, saved, log } = setup({
      rows: [partialRow({ chars: 1_000_000, archive: { parsed: 3, total: 4, listed: false } })],
      files: { [ARCHIVE]: await makeArchive() },
    });
    const marked: { tenderId: string; filename: string; names: string[] }[] = [];
    deps.store.markArchive = async (tenderId, filename, archive) => {
      marked.push({ tenderId, filename, names: (archive.skipped ?? []).map((entry) => entry.name) });
    };

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(saved).toEqual([]);
    expect(report.notImproved).toBe(1);
    expect(marked).toEqual([{ tenderId: partialRow().tenderId, filename: ARCHIVE, names: ["Узел.dwg"] }]);
    expect(log.join("\n")).toContain("записан список непрочитанных (1)");
  });

  it("сбой скачивания не стирает прежний текст", async () => {
    // Файла нет в заглушке порта: чтение даёт строку пропуска download_failed.
    const { deps, saved, log } = setup({ rows: [partialRow()], files: {} });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(saved).toEqual([]);
    expect(report.notImproved).toBe(1);
    expect(log.join("\n")).toContain("не лучше прежнего");
  });

  it("прежний текст строки не занимает бюджет сам у себя", async () => {
    // Бюджет 400 знаков, строка занимает 300: остаток для замены — 400, а не 100.
    const { deps, saved } = setup({
      rows: [partialRow({ chars: 300 })],
      files: { [ARCHIVE]: await makeArchive() },
    });

    const report = await reparseUnreadable(deps, { dryRun: false, budgetChars: 400 });

    expect(report.improved).toBe(1);
    expect(saved[0]?.document.archive?.parsed).toBe(3);
  });

  it("многотомный комплект перечитывается целиком, хотя первый том уже parsed", async () => {
    const zip = new JSZip();
    zip.file("Проект контракта.txt", "Проект контракта: срок поставки 30 календарных дней.");
    zip.file("Спецификация.txt", "Спецификация: радиаторы биметаллические, 120 штук.");
    zip.file("Смета.txt", "Локальная смета: штукатурка стен, 120 квадратных метров.");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const half = Math.ceil(bytes.length / 2);
    const files: Record<string, Uint8Array> = {
      "СД.zip.001": bytes.subarray(0, half),
      "СД.zip.002": bytes.subarray(half),
    };
    const { deps, saved, fetched } = setup({
      rows: [
        partialRow({
          filename: "СД.zip.001",
          chars: 50,
          archive: { parsed: 1, total: 3, listed: false },
        }),
        doc({
          filename: "СД.zip.002",
          reason: "Том комплекта: прочитан вместе с «СД.zip.001».",
          skipCode: "volume_of_set",
        }),
      ],
      files,
    });

    const report = await reparseUnreadable(deps, { dryRun: false });

    expect(fetched.sort()).toEqual(["СД.zip.001", "СД.zip.002"]);
    expect(saved).toHaveLength(2);
    expect(saved[0]?.document.archive).toMatchObject({ parsed: 3, total: 3 });
    expect(saved[1]?.document.skipped?.code).toBe("volume_of_set");
    expect(report.improved).toBe(1);
    expect(report.skippedSets).toBe(0);
  });
});

describe("parseReparseArgs", () => {
  it("разбирает флаги", () => {
    expect(
      parseReparseArgs([
        "--dry-run",
        "--limit",
        "5",
        "--tender",
        "0134300025826000377",
      ]),
    ).toEqual({
      dryRun: true,
      help: false,
      limit: 5,
      tenderId: "0134300025826000377",
    });
    expect(parseReparseArgs([])).toEqual({ dryRun: false, help: false });
    expect(parseReparseArgs(["--only", "archive_partial"]).only).toBe(
      "archive_partial",
    );
    expect(parseReparseArgs(["--help"]).help).toBe(true);
  });

  it("отвергает лишнее и неполное", () => {
    expect(() => parseReparseArgs(["--limit"])).toThrow();
    expect(() => parseReparseArgs(["--limit", "0"])).toThrow();
    expect(() => parseReparseArgs(["--tender"])).toThrow();
    expect(() => parseReparseArgs(["--force"])).toThrow(/Неизвестный/);
    expect(() => parseReparseArgs(["--only"])).toThrow(/--only/);
    expect(() => parseReparseArgs(["--only", "всё"])).toThrow(/--only/);
  });
});
