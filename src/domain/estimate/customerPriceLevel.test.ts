import { describe, expect, it } from "vitest";

import {
  extractDeclaredPriceLevel,
  headOfEstimate,
  priceLevelDifferences,
  quarterInHeader,
  sameZone,
  summarizeDeclaredLevels,
} from "@/domain/estimate/customerPriceLevel";
import { CONTRACT_TEXT, DOCUMENTS_1118, LSR_08_TEXT } from "@/test/t1118Fixtures";

/**
 * Уровень цен из шапки сметы заказчика. Читается только шапка и только форма сметы: договор с фразой
 * «выполняются в IV квартале 2026» или санитарная «1 зона» об уровне цен ничего не говорят.
 */

const doc = (name: string, text: string) => ({ name, text });

/** Шапка ЛСР как её печатает xlsx → CSV (Гранд-Смета). */
function csvHeader(zone: string, quarterCell: string, subject = "03. Республика Бурятия"): string {
  return [
    ",,,,,,,,,,,,,,,Приложение № 3",
    `Наименование субъекта Российской Федерации ,,,,,,${subject},,,`,
    `Наименование зоны субъекта Российской Федерации ,,,,,,${zone},,,`,
    "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-02-08,,,,,,,,,,,,,,,",
    `Составлен(а) в текущем уровне цен ,,${quarterCell},,,,,,,,,,,,,`,
    "№ п/п,Обоснование,Наименование работ и затрат,,,,,Единица измерения,Количество",
    "1,2,3,,,,,4,5",
    "1,ФЕР01-01-001-01,Работа 1 зона цен на 1 квартал 2020 года,100 м3,5",
  ].join("\n");
}

describe("extractDeclaredPriceLevel: шапка ЛСР из xlsx", () => {
  it("реальная ЛСР закупки 1118: субъект, зона 5 и III квартал 2026", () => {
    const level = extractDeclaredPriceLevel([doc("ЛСР.xlsx", LSR_08_TEXT)]);

    expect(level).toEqual({
      subject: "Республика Бурятия",
      zoneName: "Республика Бурятия (5 зона)",
      zoneNumber: 5,
      quarter: 3,
      year: 2026,
      estimates: 1,
      disagreements: [],
    });
  });

  it("все сметы согласны — один уровень без расхождений", () => {
    const level = extractDeclaredPriceLevel(DOCUMENTS_1118);

    expect(level).toMatchObject({ zoneName: "Республика Бурятия (5 зона)", zoneNumber: 5, quarter: 3, year: 2026, disagreements: [] });
    expect(level?.estimates).toBeGreaterThanOrEqual(3);
  });

  it("зона без номера: «Камчатский край»", () => {
    const text = csvHeader("Камчатский край", "II квартал 2026 года", "41. Камчатский край");

    expect(extractDeclaredPriceLevel([doc("a.xlsx", text)])).toMatchObject({
      subject: "Камчатский край",
      zoneName: "Камчатский край",
      zoneNumber: null,
      quarter: 2,
      year: 2026,
    });
  });

  it("уровень цен датой: «01.07.2026» — третий квартал 2026", () => {
    const level = extractDeclaredPriceLevel([doc("a.xlsx", csvHeader("Республика Бурятия (5 зона)", "01.07.2026"))]);

    expect(level).toMatchObject({ quarter: 3, year: 2026 });
  });

  it("«II кв. 2026 г.» и «IV квартал 2025»", () => {
    expect(extractDeclaredPriceLevel([doc("a", csvHeader("Республика Бурятия (5 зона)", "II кв. 2026 г."))])).toMatchObject({ quarter: 2, year: 2026 });
    expect(extractDeclaredPriceLevel([doc("a", csvHeader("Республика Бурятия (5 зона)", "IV квартал 2025"))])).toMatchObject({ quarter: 4, year: 2025 });
  });

  it("позиции и обоснования ниже шапки уровень не задают", () => {
    const level = extractDeclaredPriceLevel([doc("a", csvHeader("Республика Бурятия (5 зона)", "III квартал 2026 года"))]);

    expect(level).toMatchObject({ zoneNumber: 5, quarter: 3, year: 2026 });
  });
});

describe("extractDeclaredPriceLevel: распознанный скан", () => {
  const OCR = [
    "[Текст распознан со скана: 3 стр. из 3]",
    "Приложение № 3",
    "Наименование субъекта Российской Федерации 38. Иркутская область",
    "Наименование зоны субъекта Российской Федерации Иркутская область (1 зона)",
    "ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-01",
    '"Снос объекта капитального строительства"',
    "Составлен ресурсно-индексным __ методом",
    "Составлен(а) в текущем уровне цен lil квартал 2026 года",
    "Сметная стоимость 1433,78 тыс.руб.",
  ].join("\n");

  it("«lil квартал 2026» читается как III квартал", () => {
    expect(extractDeclaredPriceLevel([doc("скан.pdf", OCR)])).toMatchObject({
      subject: "Иркутская область",
      zoneName: "Иркутская область (1 зона)",
      zoneNumber: 1,
      quarter: 3,
      year: 2026,
    });
  });

  it.each([
    ["lil квартал 2026", 3, 2026],
    ["Ill квартал 2026 года", 3, 2026],
    ["lV квартал 2025", 4, 2025],
    ["II квартал 2026", 2, 2026],
    ["1 кв. 2026 г.", 1, 2026],
    ["на 01.01.2026", 1, 2026],
    ["на 01.10.2025", 4, 2025],
  ])("%s", (text, quarter, year) => {
    expect(quarterInHeader(text)).toEqual({ quarter, year });
  });

  it("мусор вместо квартала и неверный год не принимаются", () => {
    expect(quarterInHeader("5 квартал 2026")).toBeNull();
    expect(quarterInHeader("3 квартал 1000")).toBeNull();
    expect(quarterInHeader("тексты 15.13.2026")).toBeNull();
  });
});

describe("extractDeclaredPriceLevel: только сметы заказчика", () => {
  it("договор: «работы выполняются в IV квартале 2026», «1 зона» — уровня цен нет", () => {
    const contract = "Работы выполняются в IV квартале 2026 года. Санитарная защитная 1 зона, цены на 3 квартал 2025.";

    expect(extractDeclaredPriceLevel([doc("Договор.docx", contract)])).toBeNull();
    expect(extractDeclaredPriceLevel([doc("Договор.docx", CONTRACT_TEXT)])).toBeNull();
  });

  it("«Приложение: локальный сметный расчёт» в обосновании НМЦК — не шапка сметы", () => {
    const text = "Приложение: локальный сметный расчет\nСоставлен в текущем уровне цен III квартал 2026";

    expect(extractDeclaredPriceLevel([doc("НМЦК.docx", text)])).toBeNull();
  });

  it("договор вместе с ЛСР: берётся только ЛСР", () => {
    const level = extractDeclaredPriceLevel([
      doc("Договор.docx", "Работы выполняются в IV квартале 2026 года"),
      doc("ЛСР.xlsx", csvHeader("Республика Бурятия (5 зона)", "II квартал 2026 года")),
    ]);

    expect(level).toMatchObject({ zoneNumber: 5, quarter: 2, year: 2026 });
  });

  it("несколько смет в одном документе читаются отдельно", () => {
    const text = `${csvHeader("Республика Бурятия (5 зона)", "III квартал 2026 года")}\nВСЕГО по смете,,,1\n${csvHeader("Республика Бурятия (5 зона)", "III квартал 2026 года")}`;

    expect(extractDeclaredPriceLevel([doc("a", text)])?.estimates).toBe(2);
  });
});

describe("summarizeDeclaredLevels: сметы расходятся", () => {
  const level = (zone: string, quarter: number, name = "a") => ({
    documentName: name,
    subject: "Республика Бурятия",
    zoneName: zone,
    zoneNumber: Number.parseInt(/\((\d)/.exec(zone)?.[1] ?? "0", 10),
    quarter,
    year: 2026,
  });

  it("большинство побеждает, расхождение названо", () => {
    const summary = summarizeDeclaredLevels([
      level("Республика Бурятия (5 зона)", 3),
      level("Республика Бурятия (5 зона)", 3),
      level("Республика Бурятия (1 зона)", 2),
    ]);

    expect(summary).toMatchObject({ zoneName: "Республика Бурятия (5 зона)", zoneNumber: 5, quarter: 3, year: 2026, estimates: 3 });
    expect(summary?.disagreements).toHaveLength(2);
    expect(summary?.disagreements[0]).toContain("разных ценовых зонах");
    expect(summary?.disagreements[0]).toContain("«Республика Бурятия (5 зона)» — 2");
    expect(summary?.disagreements[1]).toContain("II квартал 2026 г.");
  });

  it("поровну — зона не определена: выбирать по жребию нельзя", () => {
    const summary = summarizeDeclaredLevels([level("Республика Бурятия (5 зона)", 3), level("Республика Бурятия (1 зона)", 3)]);

    expect(summary).toMatchObject({ zoneName: null, zoneNumber: null, quarter: 3 });
    expect(summary?.disagreements[0]).toContain("зона заказчика не определена");
  });

  it("пустой список — null", () => {
    expect(summarizeDeclaredLevels([])).toBeNull();
  });
});

/** Строка шапки так, как её выгружает xlsx → CSV: подпись, значение и сотни пустых ячеек справа. */
function wideLine(label: string, value = "", commas = 300): string {
  return `${label} ,${",".repeat(6)}${value}${",".repeat(commas)}`;
}

/** Шапка ЛСР из xlsx шириной в сотни колонок: между зоной и уровнем цен — строки наименований и оснований. */
function wideCsvHeader(zone: string, quarterCell: string): string {
  return [
    wideLine("Наименование субъекта Российской Федерации", "38. Иркутская область"),
    wideLine("Наименование зоны субъекта Российской Федерации", zone),
    wideLine("Наименование редакции сметных нормативов", "ГЭСН-2022 в редакции Приказа Минстроя России от 12.08.2026"),
    wideLine("Наименование программного продукта", "ГРАНД-Смета, версия 2026.2"),
    wideLine("ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-01-01"),
    wideLine("(наименование работ и затрат, наименование объекта)"),
    wideLine("Основание"),
    wideLine("(проектная и (или) иная техническая документация)"),
    wideLine("Составлен ресурсно-индексным методом"),
    wideLine("Сметная стоимость строительных работ", "1 234 567,00 руб."),
    wideLine("Средства на оплату труда рабочих", "123 456,00 руб."),
    wideLine("Нормативные затраты труда рабочих", "1 234,00 чел.-ч"),
    wideLine("Составлен(а) в текущем уровне цен", quarterCell),
    `№ п/п,Обоснование,Наименование работ и затрат${",".repeat(300)}`,
    `1,2,3${",".repeat(300)}`,
    `1,ГЭСН08-07-001-02,Работа с упоминанием 1 зона и I квартал 2020 года${",".repeat(300)}`,
  ].join("\n");
}

describe("шапка ЛСР из xlsx с сотнями запятых в строке", () => {
  const text = wideCsvHeader("Иркутская область (3 зона)", "I квартал 2026 года");

  it("текст действительно «широкий»: до уровня цен больше 4000 знаков, как на проде", () => {
    expect(text.indexOf("Составлен(а)")).toBeGreaterThan(4000);
  });

  it("зона и квартал «I квартал 2026 года» находятся, хотя строка уровня цен дальше 4000 знаков от начала шапки", () => {
    expect(extractDeclaredPriceLevel([doc("ЛСР.xlsx", text)])).toMatchObject({
      subject: "Иркутская область",
      zoneName: "Иркутская область (3 зона)",
      zoneNumber: 3,
      quarter: 1,
      year: 2026,
    });
  });

  it.each([
    ["II квартал 2026 года", 2, 2026],
    ["III квартал 2025 года", 3, 2025],
    ["IV квартал 2025 года", 4, 2025],
  ])("квартал «%s»", (cell, quarter, year) => {
    expect(extractDeclaredPriceLevel([doc("a", wideCsvHeader("Иркутская область (3 зона)", cell))])).toMatchObject({ quarter, year });
  });

  it("окно не уходит в таблицу: упоминания зоны и квартала в позициях уровень не задают", () => {
    const withoutLabel = wideCsvHeader("Иркутская область (3 зона)", "").replace(/Составлен\(а\)[^\n]*\n/u, "");
    expect(extractDeclaredPriceLevel([doc("a", withoutLabel)])).toMatchObject({ quarter: null, year: null, zoneNumber: 3 });
  });

  it("без таблицы «№ п/п» окно ограничено числом строк: далёкие строки сметы шапкой не считаются", () => {
    const filler = Array.from({ length: 80 }, (_, index) => wideLine(`Строка ${String(index)}`)).join("\n");
    const far = `${wideLine("Наименование субъекта Российской Федерации", "38. Иркутская область")}\n${filler}\n${wideLine("Составлен(а) в текущем уровне цен", "I квартал 2026 года")}`;

    expect(extractDeclaredPriceLevel([doc("a", far)])).toMatchObject({ subject: "Иркутская область", quarter: null });
  });

  it("headOfEstimate: уровень цен из широкой шапки попадает в голову сметы", () => {
    const head = headOfEstimate(text);

    expect(head).toContain("Составлен(а) в текущем уровне цен");
    expect(head).not.toContain("ГЭСН08-07-001-02");
  });

  it("PRICE_LEVEL_DIFFERS: наш квартал III 2026 против I квартала 2026 заказчика — расхождение называется", () => {
    const level = extractDeclaredPriceLevel([doc("a", text)]);
    const messages = priceLevelDifferences(level, { priceZone: "Иркутская область (3 зона)", period: "III квартал 2026" });

    expect(messages.join(" ")).toContain("I квартала 2026");
  });
});

describe("headOfEstimate", () => {
  it("обрезает по таблице «№ п/п»", () => {
    expect(headOfEstimate("Республика (2 зона), 3 квартал 2026\n№ п/п Позиция 1 зона")).toBe("Республика (2 зона), 3 квартал 2026\n");
  });
});

describe("sameZone", () => {
  const five = { zoneName: "Республика Бурятия (5 зона)", subject: "Республика Бурятия", zoneNumber: 5 };

  it("название совпало или тот же субъект и номер", () => {
    expect(sameZone(five, "Республика Бурятия (5 зона)")).toBe(true);
    expect(sameZone({ zoneName: null, subject: "Респ. Бурятия", zoneNumber: 5 }, "Республика Бурятия (5 зона)")).toBe(true);
  });

  it("другая зона или другой субъект", () => {
    expect(sameZone(five, "Республика Бурятия (1 зона)")).toBe(false);
    expect(sameZone(five, "Иркутская область (5 зона)")).toBe(false);
  });

  it("у одной стороны номера нет — совпадение субъекта", () => {
    expect(sameZone({ zoneName: "Камчатский край", subject: "Камчатский край", zoneNumber: null }, "Камчатский край (1 зона)")).toBe(true);
  });
});

describe("priceLevelDifferences", () => {
  const OURS = { priceZone: "Республика Бурятия (5 зона)", period: "3 квартал 2026 г." };
  const declared = (over: Partial<NonNullable<ReturnType<typeof summarizeDeclaredLevels>>> = {}) => ({
    subject: "Республика Бурятия",
    zoneName: "Республика Бурятия (5 зона)",
    zoneNumber: 5,
    quarter: 3,
    year: 2026,
    estimates: 1,
    disagreements: [],
    ...over,
  });

  it("совпали — пусто; заказчик молчит — пусто", () => {
    expect(priceLevelDifferences(declared(), OURS)).toEqual([]);
    expect(priceLevelDifferences(null, OURS)).toEqual([]);
    expect(priceLevelDifferences(declared({ subject: null, zoneName: null, zoneNumber: null, quarter: null, year: null }), OURS)).toEqual([]);
  });

  it("квартал другой — слова про индексацию между кварталами", () => {
    const messages = priceLevelDifferences(declared({ quarter: 2 }), OURS);

    expect(messages).toEqual([
      "Смета заказчика составлена в уровне цен II квартала 2026 г., наш расчёт — в уровне 3 квартала 2026 г.: " +
        "цены ресурсов различаются на индексацию между кварталами, построчное сравнение цен неточно.",
    ]);
  });

  it("зона другая — называет обе", () => {
    const messages = priceLevelDifferences(declared({ zoneName: "Республика Бурятия (1 зона)", zoneNumber: 1 }), OURS);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("«Республика Бурятия (1 зона)»");
    expect(messages[0]).toContain("«Республика Бурятия (5 зона)»");
    expect(messages[0]).toContain("построчное сравнение цен не равнозначно");
  });

  it("расхождение между самими сметами заказчика добавляется в сообщения", () => {
    const messages = priceLevelDifferences(declared({ disagreements: ["Сметы заказчика названы в разных ценовых зонах: …"] }), OURS);

    expect(messages).toEqual(["Сметы заказчика названы в разных ценовых зонах: …"]);
  });
});

describe("extractDeclaredPriceLevel: смета по ТСН-2001 без строк субъекта и зоны", () => {
  it("форма № 4б ТСН-2001 Москвы — объект в городе Москве", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync("src/domain/estimate/__fixtures__/smetaru/tsn-2001-moscow.txt", "utf8");
    const level = extractDeclaredPriceLevel([{ name: "ТСН", text }]);
    expect(level?.zoneName).toBe("город Москва");
    expect(level?.subject).toBe("город Москва");
  });

  it("смета ТСН в середине текста архива тоже находится", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync("src/domain/estimate/__fixtures__/smetaru/tsn-2001-moscow.txt", "utf8");
    const archive = `${"Договор подряда. ".repeat(3000)}\n${text}`;
    expect(extractDeclaredPriceLevel([{ name: "Архив.rar", text: archive }])?.zoneName).toBe("город Москва");
  });

  it("слово «ТСН» в договоре без формы сметы зону не назначает", () => {
    expect(extractDeclaredPriceLevel([{ name: "Договор", text: "Стоимость определена по ТСН-2001 с индексами." }])).toBeNull();
  });
});
