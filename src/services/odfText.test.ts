import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";

import {
  decodeXmlEntities,
  odfContentToText,
  odfKindFromContent,
  odfKindFromMime,
} from "@/services/odfText";
import { parseAttachment } from "@/services/attachmentParser";

/**
 * OpenDocument: odt, ods, odp и плоский fodt.
 *
 * Фикстуры собираются в тесте, без бинарных файлов в репозитории. Разметка
 * повторяет то, что пишет LibreOffice: пространства имён, стили до тела,
 * автоматические стили, повтор колонок и строк до края листа.
 */

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';

const STYLES =
  '<office:font-face-decls><style:font-face style:name="Arial"/></office:font-face-decls>' +
  '<office:automatic-styles><style:style style:name="P1" style:family="paragraph"/></office:automatic-styles>';

function cell(text: string, attrs = ""): string {
  return `<table:table-cell ${attrs}><text:p>${text}</text:p></table:table-cell>`;
}

function row(cells: string[]): string {
  return `<table:table-row>${cells.map((value) => cell(value)).join("")}</table:table-row>`;
}

/** Ведомость объёмов работ: заголовок и таблица «№ / наименование / ед. / кол-во». */
const BILL_BODY =
  '<text:p text:style-name="P1">Ведомость объёмов работ</text:p>' +
  '<table:table table:name="Т1">' +
  '<table:table-column table:number-columns-repeated="4"/>' +
  row(["№", "Наименование работ", "Ед. изм.", "Кол-во"]) +
  row(["1", "Штукатурка фасада", "м2", "125,5"]) +
  row(["2", "Окраска &amp; грунтовка", "м2", "98"]) +
  // Хвост листа: миллион пустых строк по 1024 пустые ячейки — так их пишет LibreOffice.
  '<table:table-row table:number-rows-repeated="1048576">' +
  '<table:table-cell table:number-columns-repeated="1024"/></table:table-row>' +
  "</table:table>";

function contentXml(body: string, office = "office:text"): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}>` +
    `${STYLES}<office:body><${office}>${body}</${office}></office:body></office:document-content>`
  );
}

async function makeOdf(
  mime: string,
  content: string,
  options: { withMimetype?: boolean } = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  if (options.withMimetype !== false) {
    zip.file("mimetype", mime, { compression: "STORE" });
  }
  zip.file("content.xml", content);
  zip.file(
    "META-INF/manifest.xml",
    '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
  );
  zip.file(
    "styles.xml",
    `<office:document-styles ${NS}><office:master-styles><text:p>Колонтитул Лист 1</text:p></office:master-styles></office:document-styles>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

const ODT_MIME = "application/vnd.oasis.opendocument.text";

describe("odfContentToText", () => {
  it("абзацы и заголовки — отдельные строки", () => {
    const text = odfContentToText(
      contentXml(
        '<text:h text:outline-level="1">1. Общие требования</text:h>' +
          "<text:p>Срок выполнения работ — 90 дней.</text:p>" +
          "<text:p>Гарантия — 5 лет.</text:p>",
      ),
    );
    expect(text).toBe(
      "1. Общие требования\nСрок выполнения работ — 90 дней.\nГарантия — 5 лет.",
    );
  });

  it("ведомость объёмов читается таблицей: строки и ячейки через табуляцию", () => {
    const text = odfContentToText(contentXml(BILL_BODY));
    const lines = text.split("\n");

    expect(lines[0]).toBe("Ведомость объёмов работ");
    expect(lines[1]).toBe("№\tНаименование работ\tЕд. изм.\tКол-во");
    expect(lines[2]).toBe("1\tШтукатурка фасада\tм2\t125,5");
    expect(lines[3]).toBe("2\tОкраска & грунтовка\tм2\t98");
  });

  it("повтор пустых колонок и строк не раздувает текст", () => {
    const text = odfContentToText(contentXml(BILL_BODY));

    // Миллион пустых строк по 1024 ячейки не оставил следа.
    expect(text.split("\n")).toHaveLength(4);
    expect(text.length).toBeLessThan(200);
  });

  it("повтор пустых ячеек внутри строки ограничен", () => {
    const xml = contentXml(
      "<table:table><table:table-row>" +
        cell("A") +
        '<table:table-cell table:number-columns-repeated="5000"/>' +
        cell("B") +
        "</table:table-row></table:table>",
    );
    const line = odfContentToText(xml);

    expect(line.startsWith("A\t")).toBe(true);
    expect(line.endsWith("\tB")).toBe(true);
    expect(line.length).toBeLessThan(20);
  });

  it("непустая ячейка с повтором дублируется, но с пределом", () => {
    const xml = contentXml(
      '<table:table><table:table-row><table:table-cell table:number-columns-repeated="3"><text:p>—</text:p></table:table-cell></table:table-row></table:table>',
    );
    expect(odfContentToText(xml)).toBe("—\t—\t—");

    const huge = contentXml(
      '<table:table><table:table-row><table:table-cell table:number-columns-repeated="99999"><text:p>x</text:p></table:table-cell></table:table-row></table:table>',
    );
    expect(odfContentToText(huge).split("\t")).toHaveLength(10);
  });

  it("text:s с числом пробелов, табуляция и перенос строки", () => {
    const text = odfContentToText(
      contentXml(
        '<text:p>до<text:s text:c="3"/>после<text:tab/>таб<text:line-break/>новая</text:p>',
      ),
    );
    expect(text).toBe("до   после\tтаб\nновая");
  });

  it("text:s без c — один пробел", () => {
    expect(odfContentToText(contentXml("<text:p>а<text:s/>б</text:p>"))).toBe(
      "а б",
    );
  });

  it("пробелы в разметке схлопываются, как в ODF", () => {
    const text = odfContentToText(
      contentXml("<text:p>  строка\n      с   переносом  </text:p>"),
    );
    expect(text).toBe("строка с переносом");
  });

  it("декодирует сущности и числовые ссылки, кириллица цела", () => {
    const text = odfContentToText(
      contentXml(
        "<text:p>Цена &amp; НДС: 5 &lt; 7 &gt; 3, &quot;ООО&quot; &#1056;&#x41E;&#1057;&#1057;&#1048;&#1071;</text:p>",
      ),
    );
    expect(text).toBe('Цена & НДС: 5 < 7 > 3, "ООО" РОССИЯ');
  });

  it("пункты списка идут с новой строки", () => {
    const text = odfContentToText(
      contentXml(
        "<text:list><text:list-item><text:p>Первый пункт</text:p></text:list-item>" +
          "<text:list-item><text:p>Второй пункт</text:p>" +
          "<text:list><text:list-item><text:p>Вложенный</text:p></text:list-item></text:list>" +
          "</text:list-item></text:list>",
      ),
    );
    expect(text).toBe("Первый пункт\nВторой пункт\nВложенный");
  });

  it("стили, колонтитулы, примечания и удалённый текст пропускаются", () => {
    const xml =
      `<?xml version="1.0"?><office:document ${NS}>` +
      "<office:styles><text:p>СТИЛЬ</text:p></office:styles>" +
      "<office:master-styles><style:master-page><style:footer><text:p>Колонтитул Лист 1</text:p></style:footer></style:master-page></office:master-styles>" +
      "<office:body><office:text>" +
      "<text:tracked-changes><text:changed-region><text:deletion><text:p>Удалено</text:p></text:deletion></text:changed-region></text:tracked-changes>" +
      "<text:p>Видимый текст<office:annotation><text:p>Комментарий</text:p></office:annotation> дальше</text:p>" +
      "</office:text></office:body></office:document>";

    const text = odfContentToText(xml);
    expect(text).toBe("Видимый текст дальше");
    expect(text).not.toContain("Колонтитул");
    expect(text).not.toContain("СТИЛЬ");
    expect(text).not.toContain("Удалено");
  });

  it("объединённые ячейки не сдвигают колонки", () => {
    const xml = contentXml(
      "<table:table><table:table-row>" +
        '<table:table-cell table:number-columns-spanned="2"><text:p>Итого</text:p></table:table-cell>' +
        "<table:covered-table-cell/>" +
        cell("500") +
        "</table:table-row></table:table>",
    );
    expect(odfContentToText(xml)).toBe("Итого\t\t500");
  });

  it("абзацы в ячейке склеиваются пробелом и не ломают строку таблицы", () => {
    const xml = contentXml(
      "<table:table><table:table-row>" +
        "<table:table-cell><text:p>Первая</text:p><text:p>вторая</text:p></table:table-cell>" +
        cell("2") +
        "</table:table-row></table:table>",
    );
    expect(odfContentToText(xml)).toBe("Первая вторая\t2");
  });

  it("вложенная таблица схлопывается в ячейку внешней", () => {
    const xml = contentXml(
      "<table:table><table:table-row><table:table-cell>" +
        "<table:table><table:table-row>" +
        cell("а") +
        cell("б") +
        "</table:table-row></table:table>" +
        "</table:table-cell>" +
        cell("итог") +
        "</table:table-row></table:table>",
    );
    expect(odfContentToText(xml)).toBe("а б\tитог");
  });

  it("презентация: слайды разделены, текст из рамок", () => {
    const xml = contentXml(
      '<draw:page draw:name="s1"><draw:frame><draw:text-box><text:p>Заголовок слайда</text:p></draw:text-box></draw:frame>' +
        "<presentation:notes><text:p>Заметка докладчика</text:p></presentation:notes></draw:page>" +
        '<draw:page draw:name="s2"><draw:frame><draw:text-box><text:p>Второй слайд</text:p></draw:text-box></draw:frame></draw:page>',
      "office:presentation",
    );
    const text = odfContentToText(xml);
    expect(text).toBe(
      "=== Слайд 1 ===\nЗаголовок слайда\n=== Слайд 2 ===\nВторой слайд",
    );
  });

  it("не падает на оборванном и кривом XML", () => {
    expect(() =>
      odfContentToText("<office:text><text:p>Незакрытый <text:span>абзац"),
    ).not.toThrow();
    expect(odfContentToText("<text:p>Текст</text:q></text:p>")).toBe("Текст");
    expect(odfContentToText("")).toBe("");
  });

  it("атрибут с символом > внутри не обрывает тег", () => {
    const text = odfContentToText(
      contentXml('<text:p text:style-name="a>b">Текст</text:p>'),
    );
    expect(text).toBe("Текст");
  });

  it("работает за линейное время на большой таблице", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) =>
      row([String(i), "Позиция", "шт", "1"]),
    ).join("");
    const started = Date.now();
    const text = odfContentToText(
      contentXml(`<table:table>${rows}</table:table>`),
    );
    expect(text.split("\n")).toHaveLength(20_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("decodeXmlEntities", () => {
  it("оставляет неизвестные сущности как есть", () => {
    expect(decodeXmlEntities("&unknown; &amp;")).toBe("&unknown; &");
  });
});

describe("odfKindFromMime / odfKindFromContent", () => {
  it("тип по mimetype", () => {
    expect(odfKindFromMime(ODT_MIME)).toBe("text");
    expect(
      odfKindFromMime("application/vnd.oasis.opendocument.spreadsheet"),
    ).toBe("spreadsheet");
    expect(
      odfKindFromMime("application/vnd.oasis.opendocument.presentation\n"),
    ).toBe("presentation");
    expect(odfKindFromMime("application/zip")).toBeNull();
  });

  it("тип по content.xml, когда mimetype нет", () => {
    expect(odfKindFromContent("<office:body><office:spreadsheet>")).toBe(
      "spreadsheet",
    );
    expect(odfKindFromContent("<office:body><office:text>")).toBe("text");
    expect(odfKindFromContent("<root/>")).toBeNull();
  });
});

describe("parseAttachment — OpenDocument", () => {
  it("читает ведомость объёмов в odt", async () => {
    const bytes = await makeOdf(ODT_MIME, contentXml(BILL_BODY));
    const result = await parseAttachment(
      bytes,
      "Приложение № 3 к МК и №1 к ТЗ Ведомость объемов работ.odt",
      "application/download",
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("1\tШтукатурка фасада\tм2\t125,5");
    expect(result.text).not.toContain("Колонтитул");
  });

  it("odt, названный .doc, определяется по содержимому", async () => {
    const bytes = await makeOdf(ODT_MIME, contentXml(BILL_BODY));
    const result = await parseAttachment(bytes, "Ведомость.doc", null, 100_000);

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Штукатурка фасада");
  });

  it("odt, названный .zip, — это документ, а не архив", async () => {
    const bytes = await makeOdf(ODT_MIME, contentXml(BILL_BODY));
    const result = await parseAttachment(
      bytes,
      "Документация.zip",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    // Архив назвал бы входы «=== content.xml ===»: здесь документ читается целиком.
    expect(result.text).not.toContain("=== content.xml ===");
    expect(result.archive).toBeUndefined();
    expect(result.text).toContain("Наименование работ");
  });

  it("odt, названный .pdf, определяется по содержимому", async () => {
    const bytes = await makeOdf(ODT_MIME, contentXml(BILL_BODY));
    const result = await parseAttachment(bytes, "Ведомость.pdf", null, 100_000);

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Штукатурка фасада");
  });

  it("без entry mimetype документ узнаётся по content.xml и manifest.xml", async () => {
    const bytes = await makeOdf(ODT_MIME, contentXml(BILL_BODY), {
      withMimetype: false,
    });
    const result = await parseAttachment(bytes, "Ведомость.zip", null, 100_000);

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Штукатурка фасада");
  });

  it("odt внутри архива читается как документ", async () => {
    const odt = await makeOdf(ODT_MIME, contentXml(BILL_BODY));
    const zip = new JSZip();
    zip.file("Ведомость объемов работ.odt", odt);
    const result = await parseAttachment(
      await zip.generateAsync({ type: "uint8array" }),
      "Документация.zip",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("=== Ведомость объемов работ.odt ===");
    expect(result.text).toContain("Штукатурка фасада");
    expect(result.archive).toEqual({ parsed: 1, total: 1 });
  });

  it("читает odp", async () => {
    const bytes = await makeOdf(
      "application/vnd.oasis.opendocument.presentation",
      contentXml(
        "<draw:page><draw:frame><draw:text-box><text:p>Презентация о предмете закупки и сроках поставки</text:p></draw:text-box></draw:frame></draw:page>",
        "office:presentation",
      ),
    );
    const result = await parseAttachment(
      bytes,
      "Презентация.odp",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Презентация о предмете закупки");
  });

  it("читает ods через общий читатель таблиц", async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["№", "Наименование", "Ед.", "Кол-во"],
        [1, "Штукатурка фасада", "м2", 125.5],
        [2, "Окраска фасада акриловой краской", "м2", 98],
      ]),
      "Ведомость",
    );
    const bytes = new Uint8Array(
      XLSX.write(book, { type: "array", bookType: "ods" }) as ArrayBuffer,
    );

    const result = await parseAttachment(
      bytes,
      "Ведомость объемов.ods",
      "application/download",
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("=== Ведомость ===");
    expect(result.text).toContain("Штукатурка фасада");
    expect(result.text).toContain("125.5");
  });

  it("ods, названный .xls, определяется по содержимому", async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["Позиция", "Цена"],
        ["Радиатор отопления биметаллический", 4200],
      ]),
      "Лист1",
    );
    const bytes = new Uint8Array(
      XLSX.write(book, { type: "array", bookType: "ods" }) as ArrayBuffer,
    );
    const result = await parseAttachment(bytes, "Расчёт.xls", null, 100_000);

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("Радиатор отопления");
  });

  it("плоский fodt читается без контейнера, колонтитулы пропущены", async () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><office:document ${NS} office:mimetype="${ODT_MIME}">` +
      "<office:master-styles><style:master-page><style:footer><text:p>Колонтитул</text:p></style:footer></style:master-page></office:master-styles>" +
      `<office:body><office:text>${BILL_BODY}</office:text></office:body></office:document>`;

    const result = await parseAttachment(
      new TextEncoder().encode(xml),
      "Ведомость.fodt",
      null,
      100_000,
    );

    expect(result.status).toBe("parsed");
    expect(result.text).toContain("1\tШтукатурка фасада\tм2\t125,5");
    expect(result.text).not.toContain("Колонтитул");
  });

  it("odt без текста — «пусто», а не ошибка", async () => {
    const bytes = await makeOdf(
      ODT_MIME,
      contentXml("<text:p>Коротко</text:p>"),
    );
    const result = await parseAttachment(bytes, "Пустой.odt", null, 100_000);

    expect(result.status).toBe("empty");
  });

  it("битый odt даёт причину сбоя, а не исключение", async () => {
    const result = await parseAttachment(
      new TextEncoder().encode("это не документ"),
      "Битый.odt",
      null,
      100_000,
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBeTruthy();
  });
});
