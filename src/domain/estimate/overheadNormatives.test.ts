import { describe, expect, it } from "vitest";

import {
  buildOverheadRateMap,
  normativeRef,
  parseNormativeGrid,
  withoutTableHeader,
  type NormativeGridRow,
} from "@/domain/estimate/overheadNormatives";

/**
 * Строки в тестах взяты из настоящей сетки приказов, как её отдаёт разбор PDF:
 * четыре ячейки — номер, вид работ, нормативы, сборники. Придуманные строки
 * здесь бесполезны: ломается разбор именно на том, как приказ напечатан.
 */
function row(
  number: string,
  workType: string,
  percents: string,
  books = "",
): NormativeGridRow {
  return [number, workType, percents, books];
}

/**
 * Шапка таблицы повторяется на каждой странице приложения и снимается
 * `withoutTableHeader` до разбора — здесь она нужна ровно для того, чтобы
 * проверить, что снимается.
 */
const HEADER: readonly NormativeGridRow[] = [
  row("", "", "18", ""),
  row("№ п/п", "Виды работ", "", ""),
  row("", "", "Нормативы накладных", "Наименование"),
  row("", "", "Террито", "накладных расходов"),
  row("", "", "МПРКС РКС", ""),
  row("", "", "рия", ""),
  row("1", "2", "3 4 5", "6"),
];

/** Разбор страницы целиком: так её подаёт скрипт сборки справочника. */
function parsePage(
  rows: readonly NormativeGridRow[],
  kind: "OVERHEAD" | "PROFIT",
) {
  return parseNormativeGrid(withoutTableHeader(rows), kind);
}

describe("normativeRef", () => {
  it("складывает указатель так, как он записан в данных ФСНБ", () => {
    expect(normativeRef("OVERHEAD", "1.1")).toBe("Пр/812-001.1");
    expect(normativeRef("PROFIT", "1.1")).toBe("Пр/774-001.1");
  });

  it("пункт без подпунктов получает нулевой подпункт", () => {
    expect(normativeRef("OVERHEAD", "2")).toBe("Пр/812-002.0");
    expect(normativeRef("OVERHEAD", "108")).toBe("Пр/812-108.0");
  });

  it("на не-номере падает, а не выдумывает указатель", () => {
    expect(() => normativeRef("OVERHEAD", "ты")).toThrow(/номер пункта/);
  });
});

describe("parseNormativeGrid", () => {
  it("читает пункт, у которого номер и нормативы в одной строке", () => {
    const [item] = parsePage(
      [
        ...HEADER,
        row("I", "Строительные работы", ""),
        row("1.1", "механизированным способом", "92 93 97"),
      ],
      "OVERHEAD",
    );

    expect(item).toEqual({
      ref: "Пр/812-001.1",
      item: "1.1",
      section: "Строительные работы",
      workType: "механизированным способом",
      territory: 92,
      mprks: 93,
      rks: 97,
    });
  });

  it("не принимает строку нумерации колонок за пункт с нормативами 3, 4 и 5", () => {
    expect(parsePage(HEADER, "OVERHEAD")).toEqual([]);
  });

  it("собирает название, разорванное выше и ниже номера", () => {
    const [item] = parsePage(
      [
        ...HEADER,
        row("", "с применением средств", ""),
        row("1.3", "", "94 95 99"),
        row("", "гидромеханизации", ""),
      ],
      "OVERHEAD",
    );

    expect(item?.workType).toBe("с применением средств гидромеханизации");
  });

  it("подставляет к подпункту название родительского пункта", () => {
    const items = parsePage(
      [
        ...HEADER,
        row("", "Земляные работы,", ""),
        row("1", "", ""),
        row("", "выполняемые:", ""),
        row("1.1", "механизированным способом", "92 93 97"),
      ],
      "OVERHEAD",
    );

    expect(items[0]?.workType).toBe(
      "Земляные работы, выполняемые: механизированным способом",
    );
  });

  it("берёт нормативы, напечатанные выше строки с номером", () => {
    const items = parsePage(
      [
        ...HEADER,
        row("", "", "89 90 93", "1. Капитальный ремонт лифтов"),
        row("104", "Капитальный ремонт оборудования лифтов", ""),
      ],
      "OVERHEAD",
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.ref).toBe("Пр/812-104.0");
    expect(items[0]?.territory).toBe(89);
  });

  it("два норматива у одного номера раскладывает в подпункты по порядку", () => {
    const items = parsePage(
      [
        ...HEADER,
        row("", "", "89 90 93", "за исключением отделов 5 и 6"),
        row("104", "Капитальный ремонт оборудования лифтов", ""),
        row("", "", "74 75 78", "отделы 5 и 6"),
      ],
      "OVERHEAD",
    );

    expect(items.map((entry) => [entry.ref, entry.territory])).toEqual([
      ["Пр/812-104.1", 89],
      ["Пр/812-104.2", 74],
    ]);
  });

  it("не цепляет нормативы к пункту через полстраницы", () => {
    const items = parsePage(
      [
        ...HEADER,
        row("100", "Наружные инженерные сети:", ""),
        row("", "", ""),
        row("", "", ""),
        row("", "", ""),
        row("", "", ""),
        row("", "", ""),
        row("", "", ""),
        row("", "", "89 90 93"),
      ],
      "OVERHEAD",
    );

    expect(items).toEqual([]);
  });

  it("восстанавливает номер пункта 72, испорченный в текстовом слое приказа", () => {
    const items = parsePage(
      [
        ...HEADER,
        row(
          "ты",
          "Оборудование зернохранилищ и предприятий по переработке зерна",
          "89 90 93",
          "30. Оборудование зернохранилищ (ГЭСНм 81-03-30-….)",
        ),
      ],
      "OVERHEAD",
    );

    expect(items[0]?.ref).toBe("Пр/812-072.0");
    expect(items[0]?.item).toBe("72");
  });

  it("у сметной прибыли одно значение, зон нет", () => {
    const [item] = parsePage(
      [
        row("1", "2", "3", "4"),
        row("I", "Строительные работы", ""),
        row("1.1", "механизированным способом", "46"),
      ],
      "PROFIT",
    );

    expect(item).toMatchObject({
      ref: "Пр/774-001.1",
      territory: 46,
      mprks: null,
      rks: null,
    });
  });

  it("держит раздел до следующего заголовка", () => {
    const items = parsePage(
      [
        ...HEADER,
        row("I", "Строительные работы", ""),
        row("1.1", "механизированным способом", "92 93 97"),
        row("IV", "Ремонтно-строительные работы", ""),
        row("101", "Электромонтажные работы", "91 92 96"),
      ],
      "OVERHEAD",
    );

    expect(items.map((entry) => entry.section)).toEqual([
      "Строительные работы",
      "Ремонтно-строительные работы",
    ]);
  });
});

describe("buildOverheadRateMap", () => {
  const normatives = parsePage(
    [
      ...HEADER,
      row("I", "Строительные работы", ""),
      row("1.1", "механизированным способом", "92 93 97"),
      row("5.1", "свайные работы", "117 118 123"),
    ],
    "OVERHEAD",
  );

  it("по умолчанию берёт норматив обычной территории", () => {
    const map = buildOverheadRateMap(normatives, "OVERHEAD");

    expect(map.get("Пр/812-001.1")?.percent).toBe(92);
    expect(map.get("Пр/812-005.1")?.percent).toBe(117);
  });

  it("для районов Крайнего Севера берёт свою колонку", () => {
    const map = buildOverheadRateMap(normatives, "OVERHEAD", "RKS");

    expect(map.get("Пр/812-001.1")?.percent).toBe(97);
  });

  it("для приравненных местностей — среднюю колонку", () => {
    const map = buildOverheadRateMap(normatives, "OVERHEAD", "MPRKS");

    expect(map.get("Пр/812-001.1")?.percent).toBe(93);
  });

  it("когда норматива зоны нет, остаётся значение территории, а не ноль", () => {
    const profit = parsePage(
      [row("1", "2", "3", "4"), row("1.1", "механизированным способом", "46")],
      "PROFIT",
    );

    const map = buildOverheadRateMap(profit, "PROFIT", "RKS");

    expect(map.get("Пр/774-001.1")?.percent).toBe(46);
  });

  it("в источнике указывает приказ и пункт — это печатается в смете", () => {
    const map = buildOverheadRateMap(normatives, "OVERHEAD");

    expect(map.get("Пр/812-005.1")?.source).toBe(
      "Приказ Минстроя России от 21.12.2020 № 812/пр, приложение, пункт 5.1",
    );
  });
});

describe("withoutTableHeader", () => {
  it("срезает всё до строки нумерации колонок", () => {
    const rows = withoutTableHeader([
      ...HEADER,
      row("1.1", "механизированным способом", "92 93 97"),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]).toBe("1.1");
  });

  it("номер страницы не становится нормативом пункта", () => {
    expect(
      parsePage([...HEADER, row("1", "Земляные работы", "")], "OVERHEAD"),
    ).toEqual([]);
  });

  it("подпись колонки не приклеивается к названию вида работ", () => {
    const [item] = parsePage(
      [...HEADER, row("1.1", "механизированным способом", "92 93 97")],
      "OVERHEAD",
    );

    expect(item?.workType).toBe("механизированным способом");
  });

  it("страницу без нумерации колонок отдаёт как есть", () => {
    const rows = withoutTableHeader([
      row("101", "Электромонтажные работы", "91 92 96"),
    ]);

    expect(rows).toHaveLength(1);
  });
});
