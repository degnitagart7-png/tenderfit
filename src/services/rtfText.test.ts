import { describe, expect, it } from "vitest";

import { parseAttachment } from "@/services/attachmentParser";
import { rtfToText } from "@/services/rtfText";

/**
 * RTF. Строки собираются в тесте: кириллица кодируется в cp1251 так же, как её
 * пишет Word (`\'hh`), потому что именно на этой кодировке ломается наивный
 * разбор.
 */

/** Кириллица → управляющие последовательности `\'hh` кодовой страницы 1251. */
function escapeCp1251(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      let byte: number | null = null;
      if (code >= 0x410 && code <= 0x44f) byte = code - 0x410 + 0xc0;
      else if (char === "Ё") byte = 0xa8;
      else if (char === "ё") byte = 0xb8;
      else if (char === "№") byte = 0xb9;
      if (byte === null) return char;
      return `\\'${byte.toString(16).padStart(2, "0")}`;
    })
    .join("");
}

/** Те же знаки «сырыми» байтами cp1251 — так пишут некоторые генераторы. */
function rawCp1251(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x410 && code <= 0x44f) bytes.push(code - 0x410 + 0xc0);
    else if (char === "Ё") bytes.push(0xa8);
    else if (char === "ё") bytes.push(0xb8);
    else bytes.push(code);
  }
  return Uint8Array.from(bytes);
}

const bytesOf = (rtf: string): Uint8Array => new TextEncoder().encode(rtf);

const HEADER =
  "{\\rtf1\\ansi\\ansicpg1251\\deff0" +
  "{\\fonttbl{\\f0\\fnil\\fcharset204 Times New Roman;}}" +
  "{\\colortbl;\\red0\\green0\\blue0;}";

describe("rtfToText", () => {
  it("декодирует кириллицу из \\'hh по ansicpg1251", () => {
    const rtf = `${HEADER}\\pard ${escapeCp1251("Информационная карта закупки")}\\par}`;
    expect(rtfToText(bytesOf(rtf))).toBe("Информационная карта закупки");
  });

  it("читает «сырые» байты cp1251 между управляющими словами", () => {
    const head = bytesOf(`${HEADER}\\pard `);
    const body = rawCp1251("Срок поставки — 30 дней");
    const tail = bytesOf("\\par}");
    const all = new Uint8Array(head.length + body.length + tail.length);
    all.set(head, 0);
    all.set(body, head.length);
    all.set(tail, head.length + body.length);

    // Длинное тире в cp1251 — 0x97, а не юникод: проверяем именно байты.
    const text = rtfToText(all);
    expect(text.startsWith("Срок поставки")).toBe(true);
    expect(text.endsWith("30 дней")).toBe(true);
  });

  it("берёт кодовую страницу из набора знаков шрифта, когда ansicpg — 1252", () => {
    const rtf =
      "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fcharset204 Arial;}}" +
      `\\pard\\f0 ${escapeCp1251("Привет")}\\par}`;
    expect(rtfToText(bytesOf(rtf))).toBe("Привет");
  });

  it("\\uN: знак юникода, знаки замены пропускаются по \\ucN", () => {
    // По умолчанию \uc1: после ၕ пропускается один знак «?».
    expect(
      rtfToText(
        bytesOf(
          "{\\rtf1\\ansi \\u1055?\\u1088?\\u1080?\\u1074?\\u1077?\\u1090?}",
        ),
      ),
    ).toBe("Привет");
    // \uc0 — знаков замены нет, пропускать нечего.
    expect(
      rtfToText(bytesOf("{\\rtf1\\ansi\\uc0 \\u1055\\u1088\\u1080  abc}")),
    ).toBe("При abc");
    // \uc2 — пропускаются два знака, в том числе \'hh.
    expect(rtfToText(bytesOf("{\\rtf1\\ansi\\uc2 \\u1055\\'3f\\'3fX}"))).toBe(
      "ПX",
    );
  });

  it("отрицательный \\u — знак выше U+7FFF", () => {
    // U+2014 (—) = 8212; U+FF21 = 65313 → 65313 - 65536 = -223.
    expect(rtfToText(bytesOf("{\\rtf1\\ansi \\u8212? \\u-223?}"))).toBe("— Ａ");
  });

  it("таблица: \\cell — табуляция, \\row — перевод строки", () => {
    const row = (cells: string[]) =>
      "\\trowd\\trgaph108\\cellx2000\\cellx6000\\cellx7000\\cellx8000" +
      cells
        .map((cell) => `\\pard\\intbl ${escapeCp1251(cell)}\\cell`)
        .join("") +
      "\\row";
    const rtf =
      HEADER +
      row(["№", "Наименование", "Ед.", "Кол-во"]) +
      row(["1", "Штукатурка фасада", "м2", "125,5"]) +
      `\\pard ${escapeCp1251("Итого")}\\par}`;

    expect(rtfToText(bytesOf(rtf))).toBe(
      "№\tНаименование\tЕд.\tКол-во\n1\tШтукатурка фасада\tм2\t125,5\nИтого",
    );
  });

  it("абзацы внутри ячейки не рвут строку таблицы", () => {
    const rtf =
      HEADER +
      "\\trowd\\cellx3000\\cellx6000" +
      `\\pard\\intbl ${escapeCp1251("Первая")}\\par ${escapeCp1251("вторая")}\\par\\cell` +
      `\\pard\\intbl 2\\cell\\row`;

    expect(rtfToText(bytesOf(rtf))).toBe("Первая вторая\t2");
  });

  it("пропускает таблицы шрифтов и цветов, стили, info, рисунки, объекты и колонтитулы", () => {
    const rtf =
      "{\\rtf1\\ansi\\deff0" +
      "{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red255\\green0\\blue0;}" +
      "{\\stylesheet{\\s0 Normal;}}" +
      "{\\info{\\title Secret title}{\\author Author}}" +
      "{\\*\\generator Msftedit 5.41;}" +
      "{\\header\\pard Header text\\par}" +
      "{\\footer\\pard Footer text\\par}" +
      "\\pard Visible text" +
      "{\\pict\\wmetafile8\\picw100 0102030405060708}" +
      "{\\*\\shppict{\\pict\\pngblip 89504e47}}" +
      "{\\object\\objemb{\\*\\objclass Excel}{\\objdata 0102}} more\\par}";

    const text = rtfToText(bytesOf(rtf));
    expect(text).toBe("Visible text more");
  });

  it("поле: показывается результат, инструкция — нет", () => {
    const rtf =
      '{\\rtf1\\ansi {\\field{\\*\\fldinst HYPERLINK "http://example.com"}{\\fldrslt Link text}} end}';
    expect(rtfToText(bytesOf(rtf))).toBe("Link text end");
  });

  it("\\par, \\line, \\tab, \\~, \\-, \\_ и экранированные скобки", () => {
    const rtf =
      "{\\rtf1\\ansi Line one\\par Line\\line two\\tab after\\~space " +
      "hy\\-phen non\\_break \\{braces\\} and \\\\ slash}";
    expect(rtfToText(bytesOf(rtf))).toBe(
      "Line one\nLine\ntwo\tafter space hyphen non-break {braces} and \\ slash",
    );
  });

  it("типографские знаки: тире, кавычки, пробелы", () => {
    const rtf =
      "{\\rtf1\\ansi \\ldblquote Word\\rdblquote \\emdash \\endash \\bullet x}";
    expect(rtfToText(bytesOf(rtf))).toBe("“Word”—–•x");
  });

  it("\\binN пропускает двоичные данные, в которых есть скобки", () => {
    const rtf = "{\\rtf1\\ansi before {\\pict\\bin5 {}\\\\x} after}";
    expect(rtfToText(bytesOf(rtf))).toBe("before  after");
  });

  it("не падает на глубокой вложенности и работает линейно", () => {
    const depth = 200_000;
    const rtf =
      "{\\rtf1\\ansi before " +
      "{".repeat(depth) +
      "hidden" +
      "}".repeat(depth) +
      " after}";
    const started = Date.now();
    const text = rtfToText(bytesOf(rtf));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(text.startsWith("before")).toBe(true);
    expect(text.endsWith("after")).toBe(true);
    expect(text).not.toContain("hidden");
  });

  it("большой документ читается за разумное время", () => {
    const paragraph = `\\pard ${escapeCp1251("Требования к поставке товара по контракту")}\\par\n`;
    const rtf = HEADER + paragraph.repeat(30_000) + "}";
    const started = Date.now();
    const text = rtfToText(bytesOf(rtf));
    expect(text.split("\n")).toHaveLength(30_000);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("не RTF и пустой вход дают пустую строку", () => {
    expect(rtfToText(new Uint8Array(0))).toBe("");
    expect(rtfToText(bytesOf("просто текст"))).toBe("");
  });

  it("длинная цепочка букв не считается управляющим словом и не роняет разбор", () => {
    const rtf = "{\\rtf1\\ansi \\" + "a".repeat(100_000) + " end}";
    expect(() => rtfToText(bytesOf(rtf))).not.toThrow();
  });
});

describe("parseAttachment — RTF", () => {
  const body = `${HEADER}\\pard ${escapeCp1251("Информационная карта электронного аукциона на поставку")}\\par}`;

  it("читает файл .rtf", async () => {
    const result = await parseAttachment(
      bytesOf(body),
      "Информационная карта.rtf",
      "application/download",
      100_000,
    );
    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Информационная карта электронного аукциона");
  });

  it("rtf под именем .pdf определяется по содержимому (раньше: Invalid PDF structure)", async () => {
    const result = await parseAttachment(
      bytesOf(body),
      "Письмо заказчика.pdf",
      null,
      100_000,
    );
    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Информационная карта");
  });

  it("rtf под именем .docx читается как rtf", async () => {
    const result = await parseAttachment(
      bytesOf(body),
      "Информационная карта.docx",
      null,
      100_000,
    );
    expect(result.status).toBe("parsed");
  });

  it("rtf внутри архива читается", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("Карта.rtf", bytesOf(body));
    const result = await parseAttachment(
      await zip.generateAsync({ type: "uint8array" }),
      "Документы.zip",
      null,
      100_000,
    );
    expect(result.status).toBe("parsed");
    expect(result.text).toContain("=== Карта.rtf ===");
  });
});
