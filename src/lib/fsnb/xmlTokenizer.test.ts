import { describe, expect, it } from "vitest";

import {
  XmlTokenizer,
  decodeXmlEntities,
  parseXmlAttributes,
  type XmlToken,
} from "@/lib/fsnb/xmlTokenizer";

/**
 * Токенайзер выгрузок ФГИС ЦС.
 *
 * Фрагменты в тестах — настоящие строки из `data/fsnb/raw/xml/`, а не
 * придуманный XML. Оба файла начинаются с BOM и декларации, корневой `<base>`
 * несёт `xmlns:xsi` и `xmlns:xsd`, а у `<Section>` атрибут `Name` стоит раньше
 * `Type` и `Code`. Порядок атрибутов в выгрузке не фиксирован, поэтому читать
 * их по позиции нельзя — только по имени.
 */

/** Настоящая первая строка «ГЭСН.xml» после BOM. */
const DECLARATION = '<?xml version="1.0" encoding="utf-8"?>';

/** Настоящий корневой элемент «ГЭСН.xml», байт в байт. */
const BASE_OPEN =
  '<base xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'xmlns:xsd="http://www.w3.org/2001/XMLSchema" PriceLevel="01.01.2022" ' +
  'CreationDate="14.08.2026" CreationTime="14:04" ProgramName="ИАС ЦС" ' +
  'BaseName="ГЭСН от 14.08.2026 14:02:53" BaseType="ГЭСН">';

/** Настоящий само закрывающийся элемент из блока `<Decrees>`. */
const DECREE =
  '<Decree Name="ГОСУДАРСТВЕННЫЕ ЭЛЕМЕНТНЫЕ СМЕТНЫЕ НОРМЫ ГЭСН-2022 доп. № 19" />';

/** Настоящая строка сборника: `Name` раньше `Type` и `Code`. */
const SECTION_01 = '<Section Name="Земляные работы" Type="Сборник" Code="01">';

/** Настоящая строка ресурса нормы ГЭСН 44-04-180-01. */
const DREDGER_RESOURCE =
  '<Resource Code="91.20.12-101" ' +
  'EndName="Землесосы папильонажные рефулерные самоходные с фрезерным разрыхлителем, ' +
  'мощность привода фрезы 800 кВт" Quantity="1.38000" />';

/** Прогоняет строку через токенайзер кусками заданного размера. */
function tokenize(input: string, chunkSize = input.length): XmlToken[] {
  const tokenizer = new XmlTokenizer();
  const tokens: XmlToken[] = [];
  for (let start = 0; start < input.length; start += chunkSize) {
    tokens.push(...tokenizer.push(input.slice(start, start + chunkSize)));
  }
  tokens.push(...tokenizer.flush());
  return tokens;
}

describe("decodeXmlEntities", () => {
  it("раскрывает именованные сущности XML", () => {
    expect(decodeXmlEntities("&lt;15&gt; &amp; &quot;м3&quot; &apos;П&apos;")).toBe(
      '<15> & "м3" \'П\'',
    );
  });

  it("раскрывает числовые сущности в десятичной и шестнадцатеричной форме", () => {
    expect(decodeXmlEntities("&#1041;&#x411;&#X411;")).toBe("БББ");
  });

  it("незнакомую сущность оставляет как есть: видимый артефакт лучше потерянного текста", () => {
    expect(decodeXmlEntities("цена&nbsp;маш.-ч")).toBe("цена&nbsp;маш.-ч");
  });

  it("числовой код вне диапазона Unicode оставляет как есть", () => {
    expect(decodeXmlEntities("&#x110000;")).toBe("&#x110000;");
  });

  it("строку без амперсанда возвращает без изменений", () => {
    expect(decodeXmlEntities("Земляные работы")).toBe("Земляные работы");
  });
});

describe("parseXmlAttributes", () => {
  it("читает значения в двойных и одинарных кавычках", () => {
    expect(parseXmlAttributes(` Code="01" EndName='1'`)).toEqual({
      Code: "01",
      EndName: "1",
    });
  });

  it("допускает пробелы вокруг знака равенства", () => {
    expect(parseXmlAttributes(`Quantity = "1.38000"`)).toEqual({ Quantity: "1.38000" });
  });

  it("пропускает атрибут без значения и сохраняет остальные", () => {
    expect(parseXmlAttributes(` Code="44" MeasureUnit EndName="1"`)).toEqual({
      Code: "44",
      EndName: "1",
    });
  });

  it("раскрывает сущности в значениях", () => {
    expect(parseXmlAttributes(` Name="грунт &lt; 15 м3"`)).toEqual({ Name: "грунт < 15 м3" });
  });

  it("не зависит от порядка: в выгрузке Name стоит раньше Type и Code", () => {
    const attrs = parseXmlAttributes(SECTION_01.slice("<Section".length, -1));

    expect(attrs["Name"]).toBe("Земляные работы");
    expect(attrs["Type"]).toBe("Сборник");
    expect(attrs["Code"]).toBe("01");
  });

  it("пространства имён попадают в атрибуты и не ломают разбор", () => {
    const attrs = parseXmlAttributes(BASE_OPEN.slice("<base".length, -1));

    expect(attrs["xmlns:xsi"]).toBe("http://www.w3.org/2001/XMLSchema-instance");
    expect(attrs["PriceLevel"]).toBe("01.01.2022");
    expect(attrs["ProgramName"]).toBe("ИАС ЦС");
    expect(attrs["BaseType"]).toBe("ГЭСН");
  });

  it("знак «>» внутри значения не заканчивает атрибут", () => {
    expect(parseXmlAttributes(` Name="трубы > 100 мм" Code="01"`)).toEqual({
      Name: "трубы > 100 мм",
      Code: "01",
    });
  });
});

describe("XmlTokenizer", () => {
  it("разбирает декларацию, корень и вложенную секцию", () => {
    const tokens = tokenize(
      `${DECLARATION}\n${BASE_OPEN}\n  ${SECTION_01}\n  </Section>\n</base>`,
    );

    expect(tokens).toEqual([
      { kind: "open", tag: "base", attrs: expect.objectContaining({ BaseType: "ГЭСН" }) },
      {
        kind: "open",
        tag: "Section",
        attrs: { Name: "Земляные работы", Type: "Сборник", Code: "01" },
      },
      { kind: "close", tag: "Section" },
      { kind: "close", tag: "base" },
    ]);
  });

  it("само закрывающийся элемент даёт selfClose, а не пару open и close", () => {
    const tokens = tokenize(DECREE);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.kind).toBe("selfClose");
    expect(tokens[0]?.kind === "selfClose" ? tokens[0].tag : null).toBe("Decree");
    expect(tokens[0]?.kind === "selfClose" ? tokens[0].attrs["Name"] : null).toBe(
      "ГОСУДАРСТВЕННЫЕ ЭЛЕМЕНТНЫЕ СМЕТНЫЕ НОРМЫ ГЭСН-2022 доп. № 19",
    );
  });

  it("читает длинное наименование ресурса без потери хвоста", () => {
    const [token] = tokenize(DREDGER_RESOURCE);

    expect(token?.kind).toBe("selfClose");
    if (token?.kind !== "selfClose") throw new Error("ожидался selfClose");
    expect(token.attrs["Code"]).toBe("91.20.12-101");
    expect(token.attrs["Quantity"]).toBe("1.38000");
    expect(token.attrs["EndName"]).toBe(
      "Землесосы папильонажные рефулерные самоходные с фрезерным разрыхлителем, " +
        "мощность привода фрезы 800 кВт",
    );
  });

  it("комментарий не даёт токенов", () => {
    expect(tokenize(`<!-- доп. № 19 -->${SECTION_01}`)).toEqual([
      {
        kind: "open",
        tag: "Section",
        attrs: { Name: "Земляные работы", Type: "Сборник", Code: "01" },
      },
    ]);
  });

  it("CDATA отдаёт текст как есть, без раскрытия сущностей", () => {
    expect(tokenize("<Item><![CDATA[цена &amp; срок]]></Item>")).toEqual([
      { kind: "open", tag: "Item", attrs: {} },
      { kind: "text", text: "цена &amp; срок" },
      { kind: "close", tag: "Item" },
    ]);
  });

  it("текст между тегами приходит отдельным токеном и обрезается по краям", () => {
    expect(tokenize("<ApprovingActNumber>  527/пр  </ApprovingActNumber>")).toEqual([
      { kind: "open", tag: "ApprovingActNumber", attrs: {} },
      { kind: "text", text: "527/пр" },
      { kind: "close", tag: "ApprovingActNumber" },
    ]);
  });

  it("пробельный текст между элементами не даёт токена", () => {
    expect(tokenize(`${SECTION_01}\n  \n</Section>`)).toEqual([
      {
        kind: "open",
        tag: "Section",
        attrs: { Name: "Земляные работы", Type: "Сборник", Code: "01" },
      },
      { kind: "close", tag: "Section" },
    ]);
  });

  it("BOM в начале файла не становится текстом", () => {
    const tokens = tokenize(`\uFEFF${DECLARATION}\n${BASE_OPEN}</base>`);

    expect(tokens).toEqual([
      { kind: "open", tag: "base", attrs: expect.objectContaining({ BaseType: "ГЭСН" }) },
      { kind: "close", tag: "base" },
    ]);
  });

  it("граница куска внутри атрибута не рвёт элемент", () => {
    // 7 символов режут «ГЭСН-2022» и «№ 19» посередине.
    expect(tokenize(`${BASE_OPEN}${DECREE}</base>`, 7)).toEqual(tokenize(`${BASE_OPEN}${DECREE}</base>`));
  });

  it("граница куска после каждого символа даёт тот же результат", () => {
    const input = `${DECLARATION}\n${BASE_OPEN}\n${SECTION_01}\n${DREDGER_RESOURCE}\n</Section>\n</base>`;

    expect(tokenize(input, 1)).toEqual(tokenize(input));
  });

  it("сущность, разрезанная между кусками текста, раскрывается", () => {
    const tokenizer = new XmlTokenizer();

    expect(tokenizer.push("Сметная цена &am")).toEqual([]);
    expect(tokenizer.push("p; 5")).toEqual([]);
    expect(tokenizer.flush()).toEqual([{ kind: "text", text: "Сметная цена & 5" }]);
  });

  it("flush отдаёт хвостовой текст", () => {
    const tokenizer = new XmlTokenizer();

    expect(tokenizer.push("<Item>")).toEqual([{ kind: "open", tag: "Item", attrs: {} }]);
    expect(tokenizer.push("Разработка грунта.")).toEqual([]);
    expect(tokenizer.flush()).toEqual([{ kind: "text", text: "Разработка грунта." }]);
  });

  it("оборванный тег на flush бросает ошибку вместо половины нормы", () => {
    const tokenizer = new XmlTokenizer();
    tokenizer.push('<Work Code="44-04-180-01" EndName="800 кВт');

    expect(() => tokenizer.flush()).toThrow(/Обрыв XML-потока/);
  });

  it("pending показывает, сколько символов осталось неразобранными", () => {
    const tokenizer = new XmlTokenizer();
    tokenizer.push(`${SECTION_01}<Work Code="01`);

    expect(tokenizer.pending).toBe('<Work Code="01'.length);
  });

  it("незакрытая CDATA ждёт продолжения, а не падает", () => {
    const tokenizer = new XmlTokenizer();

    expect(tokenizer.push("<!")).toEqual([]);
    expect(tokenizer.push("[CDATA[цена")).toEqual([]);
    expect(tokenizer.push("]]>")).toEqual([{ kind: "text", text: "цена" }]);
  });

  it("незакрытый комментарий ждёт продолжения и не даёт токенов", () => {
    const tokenizer = new XmlTokenizer();

    expect(tokenizer.push("<!-")).toEqual([]);
    expect(tokenizer.push("- доп. № 19 -->")).toEqual([]);
    expect(tokenizer.push(SECTION_01)).toEqual([
      {
        kind: "open",
        tag: "Section",
        attrs: { Name: "Земляные работы", Type: "Сборник", Code: "01" },
      },
    ]);
  });
});
