import { describe, expect, it, vi, type Mock } from "vitest";
import JSZip from "jszip";

import {
  MAX_OCR_MS_PER_PARSE,
  parseArchiveVolumes,
  parseAttachment,
  SCHEME_REASON,
} from "@/services/attachmentParser";
import type { OcrEngine, OcrResult } from "@/services/ocr";

/**
 * Сканы, картинки и тома-нарезки в разборе вложений.
 *
 * Распознавание подменяется движком-заглушкой: настоящий Tesseract в тестах не
 * запускается (в vitest он выключен переменной TENDERFIT_OCR=off).
 */

/**
 * pdfjs в этих тестах подменён: он не нужен проверяемой логике (текстовый слой
 * пуст или нет, сколько страниц), а на Node ниже 22 сам не запускается
 * (Promise.withResolvers, process.getBuiltinModule). Настоящее чтение pdf
 * проверяется в attachmentParser.test.ts.
 */
const pdfState = vi.hoisted(() => ({ pages: [""] as string[] }));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: pdfState.pages.length,
      getPage: async (number: number) => ({
        getTextContent: async () => ({
          items: [{ str: pdfState.pages[number - 1] ?? "" }],
        }),
      }),
    }),
  }),
}));

/** Байты pdf: подпись нужна определителю формата, остальное читает подмена pdfjs. */
function makeBlankPdf(): Uint8Array {
  pdfState.pages = [""];
  return new TextEncoder().encode("%PDF-1.4 scan");
}

/** Сигнатура PNG: остальное распознаванию подставляет заглушка. */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);

const REAL_PAGE =
  "Поставка товара осуществляется силами поставщика согласно условиям контракта. ".repeat(
    6,
  );
const SCRAP = "А1 ø25 12 450 ГОСТ 3 б/н ↓ 45° 1:50 2.5 ± 10 Н В Д К";

function okResult(
  pages: (string | null)[],
  totalPages = pages.length,
): OcrResult {
  return {
    status: "ok",
    pages,
    recognized: pages.filter((page) => page !== null).length,
    totalPages,
    limitedBy: null,
  };
}

function engine(result: OcrResult | (() => OcrResult)): {
  engine: OcrEngine;
  pdf: Mock<[Uint8Array, number], Promise<OcrResult>>;
  image: Mock<[Uint8Array, string], Promise<OcrResult>>;
} {
  const next = (): OcrResult =>
    typeof result === "function" ? result() : result;
  const pdf = vi.fn<[Uint8Array, number], Promise<OcrResult>>(async () =>
    next(),
  );
  const image = vi.fn<[Uint8Array, string], Promise<OcrResult>>(async () =>
    next(),
  );
  return {
    engine: {
      available: async () => true,
      recognizePdf: pdf,
      recognizeImage: image,
    },
    pdf,
    image,
  };
}

describe("parseAttachment — скан pdf", () => {
  it("распознанное склеивается постранично, первая строка — пометка", async () => {
    const { engine: ocr } = engine(
      okResult([REAL_PAGE, REAL_PAGE.replace("Поставка", "Оплата")], 2),
    );

    const result = await parseAttachment(
      makeBlankPdf(),
      "Скан.pdf",
      null,
      100_000,
      { ocr },
    );

    expect(result.status).toBe("parsed");
    const lines = result.text.split("\n");
    expect(lines[0]).toBe("[Текст распознан со скана: 2 стр. из 2]");
    expect(result.text).toContain("Поставка товара");
    expect(result.text).toContain("Оплата товара");
    expect(result.ocr).toEqual({ pages: 2, totalPages: 2 });
    expect(result.truncated).toBe(false);
  });

  it("распознаны не все страницы — результат помечен как частичный", async () => {
    const { engine: ocr } = engine(okResult([REAL_PAGE, REAL_PAGE], 57));

    const result = await parseAttachment(
      makeBlankPdf(),
      "Скан.pdf",
      null,
      100_000,
      { ocr },
    );

    expect(result.status).toBe("parsed");
    expect(result.text.split("\n")[0]).toBe(
      "[Текст распознан со скана: 2 стр. из 57]",
    );
    expect(result.truncated).toBe(true);
  });

  it("чертёж или схема: обрывков 80 и более процентов — «текста почти нет»", async () => {
    const { engine: ocr } = engine(
      okResult([SCRAP, SCRAP, SCRAP, SCRAP, REAL_PAGE]),
    );

    const result = await parseAttachment(
      makeBlankPdf(),
      "Приложение № 4 Схема.pdf",
      null,
      100_000,
      { ocr },
    );

    expect(result.status).toBe("empty");
    expect(result.reason).toBe(SCHEME_REASON);
    expect(result.reason).toBe("Схема или чертёж: текста почти нет.");
    expect(result.text).toBe("");
    // Мусор не уходит в анализ, но факт распознавания записан.
    expect(result.ocr).toEqual({ pages: 5, totalPages: 5 });
  });

  it("нет движка (ocr: null) — прежняя причина с пометкой про сервер, без ошибки", async () => {
    const result = await parseAttachment(
      makeBlankPdf(),
      "Скан.pdf",
      null,
      100_000,
      { ocr: null },
    );

    expect(result.status).toBe("empty");
    expect(result.reason).toContain(
      "Текстового слоя нет: файл отсканирован или пуст.",
    );
    expect(result.reason).toContain("Распознавание на этом сервере недоступно");
    expect(result.ocr).toBeUndefined();
  });

  it("движок есть, но программ нет — то же самое", async () => {
    const ocr: OcrEngine = {
      available: async () => false,
      recognizePdf: vi.fn(),
      recognizeImage: vi.fn(),
    };

    const result = await parseAttachment(
      makeBlankPdf(),
      "Скан.pdf",
      null,
      100_000,
      { ocr },
    );

    expect(result.status).toBe("empty");
    expect(result.reason).toContain("Распознавание на этом сервере недоступно");
    expect(ocr.recognizePdf).not.toHaveBeenCalled();
  });

  it("без явного движка на машине без Tesseract всё остаётся как раньше", async () => {
    // В vitest общий движок выключен (TENDERFIT_OCR=off): поведение «как сейчас».
    const result = await parseAttachment(
      makeBlankPdf(),
      "Скан.pdf",
      null,
      100_000,
    );

    expect(result.status).toBe("empty");
    expect(result.reason).toContain("отсканирован");
  });

  it("сбой распознавания — статус failed с причиной", async () => {
    const { engine: ocr } = engine({
      status: "failed",
      reason: "Распознавание не удалось: xref",
    });

    const result = await parseAttachment(
      makeBlankPdf(),
      "Скан.pdf",
      null,
      100_000,
      { ocr },
    );

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("xref");
  });

  it("исключение из движка не вылетает наружу", async () => {
    const ocr: OcrEngine = {
      available: async () => true,
      recognizePdf: async () => {
        throw new Error("spawn EAGAIN");
      },
      recognizeImage: vi.fn(),
    };

    const result = await parseAttachment(
      makeBlankPdf(),
      "Скан.pdf",
      null,
      100_000,
      { ocr },
    );

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("EAGAIN");
  });

  it("текстовый слой есть — распознавание не запускается", async () => {
    const { engine: ocr, pdf } = engine(okResult([REAL_PAGE]));
    const bytes = makeBlankPdf();
    pdfState.pages = ["Srok postavki 30 dney s daty zaklyucheniya kontrakta"];

    const result = await parseAttachment(bytes, "Текст.pdf", null, 100_000, {
      ocr,
    });

    expect(pdf).not.toHaveBeenCalled();
    expect(result.status).toBe("parsed");
    expect(result.ocr).toBeUndefined();
  });

  it("заголовок распознавания учитывается в бюджете знаков", async () => {
    const { engine: ocr } = engine(okResult([REAL_PAGE], 1));

    const result = await parseAttachment(
      makeBlankPdf(),
      "Скан.pdf",
      null,
      120,
      { ocr },
    );

    expect(result.status).toBe("parsed");
    expect(result.text.length).toBeLessThanOrEqual(120);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("[Текст распознан со скана")).toBe(true);
  });
});

describe("parseAttachment — знаки, которые Postgres не принимает", () => {
  it("нулевой символ в распознанном тексте вычищается", async () => {
    const { engine: ocr } = engine(
      okResult([REAL_PAGE.replace("Поставка", "Пост\u0000авка\u0001")], 1),
    );

    const result = await parseAttachment(
      makeBlankPdf(),
      "Скан.pdf",
      null,
      100_000,
      { ocr },
    );

    expect(result.status).toBe("parsed");
    expect(result.text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(result.text).toContain("Поставка товара");
  });

  it("нулевой символ в обычном тексте и в архиве вычищается", async () => {
    const plain = await parseAttachment(
      new TextEncoder().encode(
        "Срок\u0000 поставки — 30 календарных дней с даты заключения.",
      ),
      "Срок.txt",
      null,
      100_000,
    );
    expect(plain.text).not.toContain("\u0000");
    expect(plain.text).toContain("Срок поставки");

    const zip = new JSZip();
    zip.file(
      "Внутри.txt",
      "Условия\u0000 оплаты: аванс 30 процентов от цены контракта.",
    );
    const archive = await parseAttachment(
      await zip.generateAsync({ type: "uint8array" }),
      "Архив.zip",
      null,
      100_000,
    );
    expect(archive.text).not.toContain("\u0000");
  });
});

describe("parseAttachment — картинки", () => {
  it("png читается распознаванием", async () => {
    const { engine: ocr, image } = engine(okResult([REAL_PAGE], 1));

    const result = await parseAttachment(
      PNG_BYTES,
      "схема_из_2_гис.png",
      null,
      100_000,
      { ocr },
    );

    expect(image).toHaveBeenCalledWith(PNG_BYTES, "png");
    expect(result.status).toBe("parsed");
    expect(result.text.split("\n")[0]).toBe(
      "[Текст распознан со скана: 1 стр. из 1]",
    );
    expect(result.ocr).toEqual({ pages: 1, totalPages: 1 });
  });

  it("png со схемой — «текста почти нет», а не мусор", async () => {
    const { engine: ocr } = engine(okResult([SCRAP], 1));

    const result = await parseAttachment(
      PNG_BYTES,
      "схема_из_2_гис.png",
      null,
      100_000,
      { ocr },
    );

    expect(result.status).toBe("empty");
    expect(result.reason).toBe(SCHEME_REASON);
  });

  it("картинка без распознавания: прежняя причина плюс пометка, статус не unsupported", async () => {
    const result = await parseAttachment(
      PNG_BYTES,
      "схема.png",
      null,
      100_000,
      { ocr: null },
    );

    expect(result.status).toBe("empty");
    expect(result.reason).toContain("Формат png не разбирается");
    expect(result.reason).toContain("Распознавание на этом сервере недоступно");
  });

  it("png под именем .pdf узнаётся по содержимому", async () => {
    const { engine: ocr, image } = engine(okResult([REAL_PAGE], 1));

    const result = await parseAttachment(
      PNG_BYTES,
      "Схема.pdf",
      null,
      100_000,
      { ocr },
    );

    expect(image).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("parsed");
  });

  it("jpg, jpeg, tif и tiff — картинки", async () => {
    for (const name of ["a.jpg", "a.JPEG", "a.tif", "a.tiff"]) {
      const { engine: ocr, image } = engine(okResult([REAL_PAGE], 1));
      await parseAttachment(new Uint8Array([1, 2, 3]), name, null, 100_000, {
        ocr,
      });
      expect(image).toHaveBeenCalledTimes(1);
    }
  });
});

describe("parseAttachment — сканы в архиве", () => {
  async function zipWithScans(count: number): Promise<Uint8Array> {
    const zip = new JSZip();
    for (let i = 1; i <= count; i += 1)
      zip.file(`Скан ${i}.pdf`, makeBlankPdf());
    zip.file(
      "Описание.txt",
      "Описание предмета закупки: поставка товара по контракту.",
    );
    return zip.generateAsync({ type: "uint8array" });
  }

  it("счётчик распознавания суммируется по входам архива", async () => {
    const { engine: ocr } = engine(
      okResult([REAL_PAGE, REAL_PAGE, REAL_PAGE], 4),
    );

    const result = await parseAttachment(
      await zipWithScans(2),
      "Документация.zip",
      null,
      1_000_000,
      { ocr },
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain(
      "=== Скан 1.pdf ===\n[Текст распознан со скана: 3 стр. из 4]",
    );
    expect(result.ocr).toEqual({ pages: 6, totalPages: 8 });
    expect(result.archive).toEqual({ parsed: 3, total: 3 });
  });

  it("на один разбор тратится не больше положенного времени распознавания", async () => {
    let now = 0;
    const { engine: ocr, pdf } = engine(() => {
      // Каждое распознавание «длится» 50 минут.
      now += 50 * 60_000;
      return okResult([REAL_PAGE]);
    });

    const result = await parseAttachment(
      await zipWithScans(5),
      "Документация.zip",
      null,
      1_000_000,
      {
        ocr,
        now: () => now,
      },
    );

    // 50 мин < 120 мин: второй скан берётся; 100 мин < 120: третий тоже; 150 мин ≥ 120: остальные пропущены.
    expect(MAX_OCR_MS_PER_PARSE).toBe(2 * 60 * 60_000);
    expect(pdf).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("parsed");
  });
});

describe("parseArchiveVolumes — тома-нарезки .zip.NNN и .rar.NNN", () => {
  async function makeZip(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file(
      "Проект контракта.txt",
      "Проект контракта: срок поставки 30 календарных дней.",
    );
    zip.file(
      "Спецификация.txt",
      "Спецификация: радиаторы биметаллические, 120 штук.",
    );
    return zip.generateAsync({ type: "uint8array" });
  }

  function slice(
    bytes: Uint8Array,
    count: number,
    stem: string,
  ): { name: string; bytes: Uint8Array }[] {
    const size = Math.ceil(bytes.length / count);
    return Array.from({ length: count }, (_, i) => ({
      name: `${stem}.${String(i + 1).padStart(3, "0")}`,
      bytes: bytes.subarray(i * size, (i + 1) * size),
    }));
  }

  it("склеивает тома по порядку и читает как обычный zip", async () => {
    const parts = slice(await makeZip(), 3, "СД_2-этап.zip");

    const result = await parseArchiveVolumes(parts, 100_000);

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("=== Проект контракта.txt ===");
    expect(result.text).toContain("=== Спецификация.txt ===");
    expect(result.archive).toEqual({ parsed: 2, total: 2 });
  });

  it("порядок в списке не важен: тома сортируются по номеру", async () => {
    const parts = slice(await makeZip(), 3, "СД.zip").reverse();

    const result = await parseArchiveVolumes(parts, 100_000);

    expect(result.status).toBe("parsed");
  });

  it("семь томов, как у «СД_2-этап…zip.001…007»", async () => {
    const parts = slice(await makeZip(), 7, "СД_2-этап_26.08.2026.zip");

    const result = await parseArchiveVolumes(parts, 100_000);

    expect(result.status).toBe("parsed");
    expect(result.archive?.total).toBe(2);
  });

  it("не хватает тома посередине — отказ с названием тома, без попытки распаковки", async () => {
    const parts = slice(await makeZip(), 3, "ПД.zip");

    const result = await parseArchiveVolumes([parts[0]!, parts[2]!], 100_000);

    expect(result.status).toBe("unsupported");
    expect(result.reason).toContain("не хватает тома 002");
    expect(result.reason).toContain("ПД.zip");
  });

  it("нет первого тома — тоже названо", async () => {
    const parts = slice(await makeZip(), 3, "ПД.zip");

    const result = await parseArchiveVolumes([parts[1]!, parts[2]!], 100_000);

    expect(result.status).toBe("unsupported");
    expect(result.reason).toContain("не хватает тома 001");
  });

  it("не хватает последнего тома — архив не собирается, причина понятна", async () => {
    const parts = slice(await makeZip(), 3, "ПД.zip");

    const result = await parseArchiveVolumes([parts[0]!, parts[1]!], 100_000);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("не собрался в архив");
    expect(result.reason).toContain("последнего тома");
  });

  it("содержимое важнее имени: склеенный zip под именем .rar.001 читается как zip", async () => {
    const parts = slice(await makeZip(), 2, "Документация.rar");

    const result = await parseArchiveVolumes(parts, 100_000);

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Спецификация");
  });

  it(".rar.001: части склеиваются и уходят читателю rar", async () => {
    // Заголовок RAR5, разрезанный на два тома: настоящего rar собрать нечем, но
    // по ответу видно, что склейка состоялась и файл дошёл до распаковщика.
    const rar5 = Uint8Array.from([
      0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00,
    ]);
    const result = await parseArchiveVolumes(
      [
        {
          name: "Закупочная_документация_изм.rar.001",
          bytes: rar5.subarray(0, 4),
        },
        {
          name: "Закупочная_документация_изм.rar.002",
          bytes: rar5.subarray(4),
        },
      ],
      100_000,
    );

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Закупочная_документация_изм.rar");
  });

  it("бюджет знаков соблюдается", async () => {
    const parts = slice(await makeZip(), 2, "СД.zip");

    const result = await parseArchiveVolumes(parts, 60);

    expect(result.status).toBe("parsed");
    expect(result.text.length).toBeLessThanOrEqual(60);
    expect(result.truncated).toBe(true);
  });
});
