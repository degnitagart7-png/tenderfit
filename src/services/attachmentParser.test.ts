import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
  detectFileType,
  fileExtension,
  parseArchiveVolumes,
  parseAttachment,
  sniffFileType,
} from "./attachmentParser";

/**
 * Проверки разбора вложений ЕИС.
 *
 * Фикстуры собраны здесь же, а не скачаны с zakupki.gov.ru: тест не должен
 * зависеть от сети и от того, что конкретная закупка ещё не снята. Форматы
 * подобраны по реальному составу вложений — в проверенном архиве проекта
 * контракта из 29 файлов было 17 .doc, 7 .xls, 3 .docx и 2 .pdf.
 */

/** Минимальный docx: это zip с word/document.xml, чем и пользуемся. */
async function makeDocx(paragraphs: string[]): Promise<Uint8Array> {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Настоящая таблица xlsx, собранная тем же пакетом, которым её потом читают.
 *
 * Собирать её руками через JSZip нельзя: читатель xlsx требует корректных
 * sharedStrings и связей книги, а фикстура обязана проверять чтение, а не
 * собственную сборку.
 */
async function makeXlsx(rows: string[][]): Promise<Uint8Array> {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet(rows),
    "Обоснование",
  );
  const buffer = XLSX.write(book, {
    type: "array",
    bookType: "xlsx",
  }) as ArrayBuffer;
  return new Uint8Array(buffer);
}

/** Заголовок архива RAR5: именно такие тома приходят из ЕИС. */
const RAR5_BYTES = Uint8Array.from([
  0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00,
]);

/** Заголовок 7z. */
const SEVEN_ZIP_BYTES = Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

/** Осмысленный по длине текст: короткий парсер справедливо считает пустым. */
const LONG_TEXT =
  "Требования к сроку поставки: 30 календарных дней с даты заключения контракта.";

/**
 * Одностраничный PDF с настоящим текстовым слоем, собранный руками.
 *
 * Нужен именно свой, а не скачанный из ЕИС: тест проверяет, что pdfjs вообще
 * работает в Node. Обычная сборка pdfjs-dist здесь падает, и без такой фикстуры
 * поломка всплыла бы только на проде.
 */
function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;

  return utf8(pdf);
}

describe("detectFileType", () => {
  it("распознаёт форматы вложений по расширению", () => {
    expect(detectFileType(null, "Проект_контракта.docx")).toBe("docx");
    expect(detectFileType(null, "Приложение № 10.doc")).toBe("doc");
    expect(detectFileType(null, "Обоснование НМЦК.PDF")).toBe("pdf");
    expect(detectFileType(null, "НМЦК 17.09.xlsx")).toBe("xlsx");
    expect(detectFileType(null, "радиаторы 2.xls")).toBe("xlsx");
    expect(detectFileType(null, "Документация о закупке.zip")).toBe("zip");
    expect(detectFileType(null, "спецификация.csv")).toBe("csv");
  });

  it("не путает старый .doc с .docx: мамонт бинарный формат не читает", () => {
    expect(detectFileType(null, "Требования к заявке (РД+СМР).doc")).toBe(
      "doc",
    );
  });

  it("rar и 7z — известные форматы: проект их читает", () => {
    expect(detectFileType(null, "Документация о закупке.7z")).toBe("7z");
    expect(detectFileType(null, "ПД.rar")).toBe("rar");
  });

  it("ЕИС отдаёт application/download — решает расширение, а не MIME", () => {
    expect(detectFileType("application/download", "Извещение.docx")).toBe(
      "docx",
    );
    expect(detectFileType("application/octet-stream", "Протокол.pdf")).toBe(
      "pdf",
    );
  });

  it("настоящий MIME важнее отсутствия расширения", () => {
    expect(detectFileType("application/pdf")).toBe("pdf");
    expect(detectFileType("text/csv")).toBe("csv");
  });

  it("расширение берётся из имени с путём внутри архива", () => {
    expect(
      fileExtension("Приложения №1-28 к ГК/Приложение № 1 к ГК.docx"),
    ).toBe("docx");
    expect(fileExtension("без расширения")).toBe("");
  });
});

describe("parseAttachment", () => {
  it("читает docx", async () => {
    const bytes = await makeDocx(["Проект контракта", LONG_TEXT]);
    const result = await parseAttachment(
      bytes,
      "Проект_контракта.docx",
      null,
      100_000,
    );
    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Проект контракта");
    expect(result.text).toContain(LONG_TEXT);
  });

  it("читает csv как текст", async () => {
    const result = await parseAttachment(
      utf8(LONG_TEXT),
      "спецификация.csv",
      null,
      100_000,
    );
    expect(result.status).toBe("parsed");
    expect(result.text).toBe(LONG_TEXT);
  });

  it("вычищает разметку из html", async () => {
    const html = `<div>${LONG_TEXT}</div>`;
    const result = await parseAttachment(
      utf8(html),
      "card.html",
      "text/html",
      100_000,
    );
    expect(result.status).toBe("parsed");
    expect(result.text).not.toContain("<div>");
    expect(result.text).toContain(LONG_TEXT);
  });

  it("на обрезанном rar возвращает причину, а не исключение", async () => {
    // Подпись есть, а архива за ней нет: так выглядит оборванная загрузка.
    const result = await parseAttachment(
      RAR5_BYTES,
      "Документация о закупке.rar",
      null,
      100_000,
    );
    expect(result.status).toBe("failed");
    expect(result.reason).not.toBeNull();
    expect(result.text).toBe("");
  });

  it("читает pdf в Node: здесь обязана работать legacy-сборка pdfjs", async () => {
    const result = await parseAttachment(
      makePdf("Srok postavki 30 dney s daty zaklyucheniya kontrakta"),
      "Обоснование НМЦК.pdf",
      "application/download",
      100_000,
    );
    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Srok postavki 30 dney");
  });

  it("pdf без текстового слоя — это скан, и причина должна быть внятной", async () => {
    const result = await parseAttachment(
      makePdf(""),
      "Скан подписанного.pdf",
      null,
      100_000,
    );
    expect(result.status).toBe("empty");
    expect(result.reason).toContain("отсканирован");
  });

  it("разбор pdf не печатает в журнал синхронизации", async () => {
    // Оператор видит ночной прогон только по logs/sync-eis.log. На живой
    // закупке 32616393585 один архив проектной документации напечатал 94 строки
    // «standardFontDataUrl» и «TT: undefined function» — текст при этом извлёкся
    // целиком, 821 973 знака без единого символа замены. Стандартные шрифты
    // pdfjs подгружает для отрисовки, извлечению они не нужны.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await parseAttachment(
        makePdf("Srok postavki 30 dney s daty zaklyucheniya kontrakta"),
        "Проект.pdf",
        null,
        100_000,
      );

      expect(result.status).toBe("parsed");
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("обрезает текст по бюджету и помечает обрезку", async () => {
    const result = await parseAttachment(
      utf8(LONG_TEXT),
      "спецификация.csv",
      null,
      50,
    );
    expect(result.status).toBe("parsed");
    expect(result.text).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it("при нулевом бюджете разбор не начинается", async () => {
    const result = await parseAttachment(
      utf8(LONG_TEXT),
      "спецификация.csv",
      null,
      0,
    );
    expect(result.status).toBe("empty");
    expect(result.reason).toContain("Бюджет");
  });

  it("битый файл даёт статус failed с сообщением парсера", async () => {
    const result = await parseAttachment(
      utf8("это не zip"),
      "Проект ГК.zip",
      null,
      100_000,
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBeTruthy();
  });
});

describe("parseAttachment — архив", () => {
  async function makeZip(entries: Record<string, string>): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(entries))
      zip.file(name, content);
    return zip.generateAsync({ type: "uint8array" });
  }

  it("обходит входы архива и собирает их текст", async () => {
    const bytes = await makeZip({
      "Приложение 1.txt": LONG_TEXT,
      "Приложение 2.csv":
        "Срок поставки,30 дней\nПорядок оплаты,по факту поставки",
    });
    const result = await parseAttachment(bytes, "Проект ГК.zip", null, 100_000);
    expect(result.status).toBe("parsed");
    expect(result.text).toContain("=== Приложение 1.txt ===");
    expect(result.text).toContain("=== Приложение 2.csv ===");
    expect(result.archive).toEqual({ parsed: 2, total: 2 });
  });

  it("читает docx внутри архива", async () => {
    const docx = await makeDocx(["График выполнения СМР", LONG_TEXT]);
    const zip = new JSZip();
    zip.file("Приложение № 1 к ГК.docx", docx);
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const result = await parseAttachment(bytes, "Проект ГК.zip", null, 100_000);
    expect(result.status).toBe("parsed");
    expect(result.text).toContain("График выполнения СМР");
  });

  it("неразбираемые входы архива не роняют остальные", async () => {
    const zip = new JSZip();
    zip.file("читается.txt", LONG_TEXT);
    zip.file("не читается.rar", "Rar!\u001a\u0007");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const result = await parseAttachment(
      bytes,
      "Документация.zip",
      null,
      100_000,
    );
    expect(result.status).toBe("parsed");
    expect(result.text).toContain(LONG_TEXT);
    expect(result.archive).toEqual({
      parsed: 1,
      total: 2,
      skipped: [{ name: "не читается.rar", reason: expect.any(String) }],
    });
  });

  it("архив, в котором нечего читать, получает причину", async () => {
    const bytes = await makeZip({ "чертёж.dwg": "AC1015" });
    const result = await parseAttachment(
      bytes,
      "Проектная документация.zip",
      null,
      100_000,
    );
    expect(result.status).toBe("empty");
    expect(result.reason).toContain("ни один не удалось прочитать");
  });

  it("кончившийся бюджет обрывает обход архива, и это видно по счётчику", async () => {
    // Закупка 32616393585: архив документации о закупке из 15 вложений отдал
    // два, а сумма знаков сошлась ровно в миллион. Без счётчика карточка не
    // сказала бы, что именно не дошло до модели.
    const bytes = await makeZip({
      "a.txt": "а".repeat(100),
      "b.txt": "б".repeat(100),
      "c.txt": "в".repeat(100),
    });

    const result = await parseAttachment(bytes, "ДОЗ.zip", null, 150);

    expect(result.status).toBe("parsed");
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(150);
    expect(result.archive).toEqual({
      parsed: 2,
      total: 3,
      skipped: [
        { name: "c.txt", reason: "не читался: бюджет знаков на архив исчерпан" },
      ],
    });
  });

  describe("отчёт о пропущенных входах", () => {
    it("называет файл и причину; каталоги не считаются ни входами, ни пропусками", async () => {
      const zip = new JSZip();
      zip.folder("Раздел 1");
      zip.file("Раздел 1/ТЗ.txt", LONG_TEXT);
      zip.file("Раздел 1/Смета.gsfx", "<gsfx/>");
      zip.file("Чертёж.dwg", "AC1015");
      const bytes = await zip.generateAsync({ type: "uint8array" });

      const result = await parseAttachment(bytes, "Документация.zip", null, 100_000, {
        archiveCli: null,
      });

      expect(result.archive?.parsed).toBe(1);
      expect(result.archive?.total).toBe(3);
      const names = result.archive?.skipped?.map((entry) => entry.name).sort();
      expect(names).toEqual(["Раздел 1/Смета.gsfx", "Чертёж.dwg"]);
      for (const entry of result.archive?.skipped ?? []) {
        expect(entry.reason.length).toBeGreaterThan(0);
        expect(entry.reason.length).toBeLessThanOrEqual(160);
      }
    });

    it("архив, прочитанный целиком, не получает поля skipped", async () => {
      const bytes = await makeZip({ "a.txt": LONG_TEXT });
      const result = await parseAttachment(bytes, "A.zip", null, 100_000, {
        archiveCli: null,
      });
      expect(result.archive).toEqual({ parsed: 1, total: 1 });
      expect(result.archive).not.toHaveProperty("skipped");
    });

    it("пустой архив тоже отдаёт список: так видно, что в нём лежало", async () => {
      const bytes = await makeZip({ "чертёж.dwg": "AC1015", "узел.dxf": "0\nSECTION" });
      const result = await parseAttachment(bytes, "Чертежи.zip", null, 100_000, {
        archiveCli: null,
      });
      expect(result.status).toBe("empty");
      expect(result.archive?.skipped?.map((entry) => entry.name).sort()).toEqual([
        "узел.dxf",
        "чертёж.dwg",
      ]);
    });

    it("вложенный архив даёт имена с путём внешнего", async () => {
      const inner = new JSZip();
      inner.file("Смета.txt", LONG_TEXT);
      inner.file("Смета.gsfx", "<gsfx/>");
      const innerBytes = await inner.generateAsync({ type: "uint8array" });
      const outer = new JSZip();
      outer.file("Раздел.zip", innerBytes);
      const bytes = await outer.generateAsync({ type: "uint8array" });

      const result = await parseAttachment(bytes, "ПД.zip", null, 100_000, {
        archiveCli: null,
      });

      expect(result.status).toBe("parsed");
      expect(result.archive?.skipped?.map((entry) => entry.name)).toEqual([
        "Раздел.zip/Смета.gsfx",
      ]);
    });

    it("вложенный архив, из которого ничего не вышло, раскрывается по входам", async () => {
      const inner = new JSZip();
      inner.file("Узел.dwg", "AC1015");
      const innerBytes = await inner.generateAsync({ type: "uint8array" });
      const outer = new JSZip();
      outer.file("Раздел.zip", innerBytes);
      outer.file("ТЗ.txt", LONG_TEXT);
      const bytes = await outer.generateAsync({ type: "uint8array" });

      const result = await parseAttachment(bytes, "ПД.zip", null, 100_000, {
        archiveCli: null,
      });

      expect(result.archive).toMatchObject({ parsed: 1, total: 2 });
      expect(result.archive?.skipped?.map((entry) => entry.name)).toEqual([
        "Раздел.zip/Узел.dwg",
      ]);
    });

    it("входы сверх лимита числа входов помечены как не читавшиеся", async () => {
      const zip = new JSZip();
      for (let i = 0; i < 205; i += 1)
        zip.file(`f${String(i).padStart(3, "0")}.txt`, `${LONG_TEXT} ${i}`);
      const bytes = await zip.generateAsync({ type: "uint8array" });

      const result = await parseAttachment(bytes, "Много.zip", null, 10_000_000, {
        archiveCli: null,
      });

      expect(result.archive?.total).toBe(205);
      expect(result.archive?.parsed).toBe(200);
      expect(result.archive?.skipped).toHaveLength(5);
      expect(result.archive?.skipped?.[0]?.reason).toContain("больше 200 файлов");
      expect(result.truncated).toBe(true);
    });

    it("список режется до 200 записей, а счётчики остаются полными", async () => {
      const zip = new JSZip();
      for (let i = 0; i < 199; i += 1) zip.file(`x${String(i).padStart(3, "0")}.dwg`, "AC1015");
      zip.file("a.txt", LONG_TEXT);
      // Ещё 150 непрочитанных (сверх лимита входов не доходим: 200 + 150 > 200).
      for (let i = 0; i < 150; i += 1) zip.file(`z${String(i).padStart(3, "0")}.dwg`, "AC1015");
      const bytes = await zip.generateAsync({ type: "uint8array" });

      const result = await parseAttachment(bytes, "Чертежи.zip", null, 100_000, {
        archiveCli: null,
      });

      expect(result.archive?.total).toBe(350);
      expect(result.archive?.parsed).toBe(1);
      expect(result.archive?.skipped).toHaveLength(200);
    });

    it("длинное имя режется слева: расширение остаётся", async () => {
      const longName = `${"папка/".repeat(60)}Смета.gsfx`;
      const zip = new JSZip();
      zip.file(longName, "<gsfx/>");
      zip.file("ТЗ.txt", LONG_TEXT);
      const bytes = await zip.generateAsync({ type: "uint8array" });

      const result = await parseAttachment(bytes, "Д.zip", null, 100_000, {
        archiveCli: null,
      });

      const [entry] = result.archive?.skipped ?? [];
      expect(entry?.name.length).toBe(200);
      expect(entry?.name.startsWith("…")).toBe(true);
      expect(entry?.name.endsWith("Смета.gsfx")).toBe(true);
    });
  });
});

describe("sniffFileType", () => {
  it("узнаёт форматы по первым байтам", () => {
    expect(sniffFileType(utf8("%PDF-1.7\n"))).toBe("pdf");
    expect(
      sniffFileType(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])),
    ).toBe("zip");
    expect(sniffFileType(RAR5_BYTES)).toBe("rar");
    expect(sniffFileType(SEVEN_ZIP_BYTES)).toBe("7z");
    expect(sniffFileType(utf8("{\\rtf1\\ansi\\deff0"))).toBe("rtf");
  });

  it("старый rar и пустой zip тоже видны по заголовку", () => {
    expect(
      sniffFileType(
        Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]),
      ),
    ).toBe("rar");
    expect(sniffFileType(Uint8Array.from([0x50, 0x4b, 0x05, 0x06]))).toBe(
      "zip",
    );
  });

  it("возвращает null, когда по содержимому формат не определить", () => {
    expect(sniffFileType(utf8(LONG_TEXT))).toBeNull();
    expect(sniffFileType(utf8("<html></html>"))).toBeNull();
    expect(sniffFileType(new Uint8Array(0))).toBeNull();
  });
});

describe("parseAttachment — имя файла не соответствует содержимому", () => {
  it("docx, названный pdf, читается как docx", async () => {
    // Живые закупки 0320100032126000114 и 0320100032126000115: четыре файла
    // «Электронный документ, полученный из внешней системы (…).pdf» оказались
    // docx — заголовок PK, внутри word/document.xml. pdfjs отвечал на них
    // «Invalid PDF structure», и документы пропадали из разбора.
    const bytes = await makeDocx(["Платежные реквизиты", LONG_TEXT]);
    const result = await parseAttachment(
      bytes,
      "Электронный документ, полученный из внешней системы (F8C7DB6D).pdf",
      "application/download",
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain(LONG_TEXT);
    expect(result.reason).toBeNull();
  });

  it("xlsx, названный pdf, читается как таблица", async () => {
    const bytes = await makeXlsx([
      ["Наименование", "Цена"],
      ["Шина 385/65R22,5", "38500"],
    ]);
    const result = await parseAttachment(
      bytes,
      "Расчёт НМЦК.pdf",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Шина 385/65R22,5");
  });

  it("настоящий pdf, названный docx, всё равно читается", async () => {
    const result = await parseAttachment(
      makePdf("Srok postavki 30 dney s daty zaklyucheniya kontrakta"),
      "Проект контракта.docx",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Srok postavki 30 dney");
  });

  it("обычный архив, названный pdf, обходится по входам", async () => {
    const zip = new JSZip();
    zip.file("Приложение 1.txt", LONG_TEXT);
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const result = await parseAttachment(
      bytes,
      "Документация о закупке.pdf",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("=== Приложение 1.txt ===");
    expect(result.archive).toEqual({ parsed: 1, total: 1 });
  });

  it("rar под именем zip уходит к распаковщику rar, а не к zip", async () => {
    // Содержимое важнее имени: файл назван .zip, но внутри rar.
    const result = await parseAttachment(
      RAR5_BYTES,
      "Закупочная документация.zip",
      null,
      100_000,
    );

    expect(result.status).toBe("failed");
    expect(result.text).toBe("");
  });

  it("7z под именем zip уходит к распаковщику 7z", async () => {
    const result = await parseAttachment(
      SEVEN_ZIP_BYTES,
      "Закупочная документация.zip",
      null,
      100_000,
    );

    // Байты обрезаны до подписи, распаковать нечего — но сообщение приходит
    // от 7-Zip, то есть файл ушёл правильному читателю.
    expect(result.status).not.toBe("parsed");
    expect(result.reason).toContain("7-Zip");
  });

  it("rtf под именем docx читается как rtf", async () => {
    // Закупка 0338200008726000051: «Информационная карта.rtf» на 247 КБ. Раньше
    // отказ был «Формат rtf не разбирается», теперь у проекта есть свой
    // конвертер. Имя здесь врёт, но содержимое проверяется в любом случае.
    const english = "Delivery term: 30 calendar days from the contract date.";
    const bytes = utf8(`{\\rtf1\\ansi\\deff0 {\\pard ${english}\\par}}`);
    const result = await parseAttachment(
      bytes,
      "Информационная карта.docx",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain(english);
  });
});

/**
 * Сквозная проверка на настоящем архиве.
 *
 * Архив собирается тем же 7z-wasm — другого способа получить живой .7z в тестах
 * нет, а проверять распаковку на заглушке бессмысленно. Для .rar такого способа
 * не существует: свободного упаковщика RAR нет, и лицензия UnRAR запрещает его
 * делать, поэтому чтение живого rar остаётся на ручную проверку.
 */
describe("parseAttachment — настоящие архивы", () => {
  async function make7z(files: Record<string, string>): Promise<Uint8Array> {
    const factory = (await import("7z-wasm")).default;
    const sevenZip = await factory({ print: () => {}, printErr: () => {} });
    sevenZip.FS.mkdir("/in");
    for (const [name, content] of Object.entries(files)) {
      sevenZip.FS.writeFile(`/in/${name}`, content);
    }
    sevenZip.FS.chdir("/in");
    sevenZip.callMain(["a", "/doc.7z", "."]);
    return sevenZip.FS.readFile("/doc.7z");
  }

  it("разбирает 7z в текст всех входов", async () => {
    const archive = await make7z({
      "contract.txt":
        "Razdel 5. Neustoyka sostavlyaet 0,5 protsenta ot tseny kontrakta za kazhdyy den prosrochki.",
      "task.txt":
        "Postavka kompyuternoy tekhniki, srok 30 dney s daty zaklyucheniya kontrakta.",
    });

    const result = await parseAttachment(
      archive,
      "Документация о закупке.7z",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Neustoyka");
    expect(result.text).toContain("Postavka kompyuternoy tekhniki");
    expect(result.archive).toEqual({ parsed: 2, total: 2 });
  });

  it("в тексте видно, из какого файла архива он взят", async () => {
    const archive = await make7z({
      "contract.txt": LONG_TEXT,
    });

    const result = await parseAttachment(archive, "ДОЗ.7z", null, 100_000);

    expect(result.text).toContain("=== contract.txt ===");
  });
});

describe("parseArchiveVolumes — комплект томов в текст", () => {
  it("читает многотомный 7z как один архив", async () => {
    const factory = (await import("7z-wasm")).default;
    const sevenZip = await factory({ print: () => {}, printErr: () => {} });
    sevenZip.FS.mkdir("/in");
    sevenZip.FS.writeFile(
      "/in/psd.txt",
      "Neustoyka 0,5 protsenta za kazhdyy den prosrochki. ".repeat(2_000),
    );
    sevenZip.FS.chdir("/in");
    sevenZip.callMain(["a", "-v40k", "-mx=0", "/psd.7z", "psd.txt"]);

    const volumes = sevenZip.FS.readdir("/")
      .filter((name) => name.startsWith("psd.7z."))
      .sort()
      .map((name) => ({
        name,
        bytes: sevenZip.FS.readFile(`/${name}`, { encoding: "binary" }),
      }));

    expect(volumes.length).toBeGreaterThan(1);

    const result = await parseArchiveVolumes(volumes, 100_000);

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Neustoyka");
    expect(result.archive).toEqual({ parsed: 1, total: 1 });
  });

  it("на пустом комплекте отдаёт причину, а не падает", async () => {
    const result = await parseArchiveVolumes([], 100_000);

    expect(result.status).toBe("unsupported");
    expect(result.text).toBe("");
  });
});

/**
 * Глубина вложенности архивов.
 *
 * Проектную документацию в ЕИС пакуют слоями: zip вкладки документов, внутри
 * архив раздела, внутри него — том с чертежами и пояснительной запиской. Пока
 * проект читал только zip, третий уровень встречался редко; с поддержкой rar и
 * 7z он стал обычным делом, поэтому предел поднят до трёх уровней.
 */
describe("parseAttachment — вложенные архивы", () => {
  async function zipOf(
    entries: Record<string, Uint8Array | string>,
  ): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(entries))
      zip.file(name, content);
    return await zip.generateAsync({ type: "uint8array" });
  }

  it("читает документ на третьем уровне вложенности", async () => {
    const inner = await zipOf({ "Проект контракта.txt": LONG_TEXT });
    const middle = await zipOf({ "Раздел 3.zip": inner });
    const outer = await zipOf({ "Документация.zip": middle });

    const result = await parseAttachment(
      outer,
      "Вкладка документов.zip",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain(LONG_TEXT.slice(0, 40));
  });

  it("раскрывает 7z внутри zip: ради этого предел и поднят", async () => {
    const factory = (await import("7z-wasm")).default;
    const sevenZip = await factory({ print: () => {}, printErr: () => {} });
    sevenZip.FS.mkdir("/in");
    sevenZip.FS.writeFile("/in/Проект контракта.txt", LONG_TEXT);
    sevenZip.FS.chdir("/in");
    sevenZip.callMain(["a", "/razdel.7z", "."]);
    const inner7z = sevenZip.FS.readFile("/razdel.7z", { encoding: "binary" });

    const outer = await zipOf({ "Раздел 3.7z": inner7z });

    const result = await parseAttachment(
      outer,
      "Вкладка документов.zip",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain(LONG_TEXT.slice(0, 40));
  });

  it("на четвёртом уровне отказывается и говорит почему", async () => {
    const level4 = await zipOf({ "Пояснительная записка.txt": LONG_TEXT });
    const level3 = await zipOf({ "Том 1.zip": level4 });
    const level2 = await zipOf({ "Раздел 3.zip": level3 });
    const level1 = await zipOf({ "Документация.zip": level2 });

    const result = await parseAttachment(
      level1,
      "Вкладка документов.zip",
      null,
      100_000,
    );

    // Сам архив прочитан, но до самого глубокого документа обход не дошёл.
    expect(result.text).not.toContain(LONG_TEXT.slice(0, 40));
  });
});
