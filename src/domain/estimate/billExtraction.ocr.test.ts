import { describe, expect, it } from "vitest";

import {
  extractBillItems,
  parseQuantityPair,
  quantityVisibleIn,
  quoteFoundIn,
  resourceCodeFromJustification,
  type BillExtractionRow,
} from "@/domain/estimate/billExtraction";
import { documentHeadings, headingInfoAt } from "@/domain/estimate/volumeSource";
import {
  PROJECT_001_TABLES,
  PROJECT_ROWS,
  SMETA_001_OCR,
  SMETA_NAME,
  SMETA_ROWS,
  TZ_001_TEXT,
  TZ_ROWS,
} from "@/test/volumeSourceFixtures";

/**
 * Единицы, шифры, дубли и «не работы» на тексте, распознанном со скана.
 * Фикстуры — живая смета закупки 0134600012126000001 и таблицы её проекта.
 */

function extractSmeta(rows: readonly BillExtractionRow[] = SMETA_ROWS) {
  return extractBillItems({
    rows,
    sourceText: SMETA_001_OCR,
    documentName: SMETA_NAME,
    idPrefix: "d1c1",
    documentLevel: "CUSTOMER_ESTIMATE",
  });
}

function extractProject(rows: readonly BillExtractionRow[] = PROJECT_ROWS, level: "SPEC" | "BILL" = "SPEC") {
  const headings = documentHeadings(PROJECT_001_TABLES);
  return extractBillItems({
    rows,
    sourceText: PROJECT_001_TABLES,
    documentName: "Проект.pdf",
    idPrefix: "d2c1",
    documentLevel: level,
    headingInfoOf: (offset) => headingInfoAt(headings, offset),
  });
}

const byName = <T extends { workName: string }>(items: readonly T[], part: string): T | undefined =>
  items.find((item) => item.workName.includes(part));

describe("смета заказчика после OCR: единицы", () => {
  const { items } = extractSmeta();

  it("«100 m3» — 100 м3 с латинской «m»: объём 5,8163 × 100", () => {
    const demolition = byName(items, "Разборка зданий");
    expect(demolition?.quantity).toBeCloseTo(581.63, 6);
    expect(demolition?.quantityUnit).toBe("м3");
  });

  it("«1000 м2» — множитель единицы: 0,3477 × 1000", () => {
    const grading = byName(items, "Планировка");
    expect(grading?.quantity).toBeCloseTo(347.7, 6);
    expect(grading?.quantityUnit).toBe("м2");
  });

  it("«мз» — кубометры", () => {
    const gravel = items.find((item) => item.resourceCode === "02.2.04.03-0013");
    expect(gravel?.quantityUnit).toBe("м3");
  });

  it("«1тгруза» и «1т груза» — тонны", () => {
    const loading = byName(items, "Погрузка в автотранспортное средство: гравий");
    const carrying = byName(items, "Перевозка грузов | класса автомобилями-самосвалами грузоподъемностью до 15 т");
    const garbage = byName(items, "мусор строительный");
    expect(loading).toMatchObject({ quantity: 55.52, quantityUnit: "т" });
    expect(garbage).toMatchObject({ quantity: 505.94, quantityUnit: "т" });
    expect(carrying).toMatchObject({ quantity: 505.94, quantityUnit: "т" });
  });

  it("строки сметы доходят с уровнем сметы заказчика", () => {
    expect(items.every((item) => item.sourceLevel === "CUSTOMER_ESTIMATE")).toBe(true);
  });
});

describe("смета заказчика после OCR: шифры", () => {
  const { items } = extractSmeta();

  it("«F9CH46-06-909-03» прочитан как ГЭСН 46-06-909-03 — цифры исправит база", () => {
    const demolition = byName(items, "Разборка зданий");
    expect(demolition?.normCodeHint).toMatchObject({ baseType: "ГЭСН", code: "46-06-909-03" });
    expect(demolition?.normCode).toBeNull();
  });

  it("«F3CH01-02-027-02» — ГЭСН 01-02-027-02", () => {
    expect(byName(items, "Планировка")?.normCodeHint).toMatchObject({ baseType: "ГЭСН", code: "01-02-027-02" });
  });

  it("материал по ФСБЦ остаётся материалом, а его перевозка (хвост «_02-15») — нет", () => {
    expect(resourceCodeFromJustification("ФСБЦ-02.2.04.03-0013")).toBe("02.2.04.03-0013");
    expect(resourceCodeFromJustification("ФСБЦ-02.2.04.03-0013_02-15")).toBeNull();
    const transport = byName(items, "Перевозка Грузов");
    expect(transport?.resourceCode).toBeNull();
  });
});

describe("смета заказчика после OCR: дубль позиции 4", () => {
  const { items, rejected } = extractSmeta();

  it("остаётся одна строка с объёмом 34,7: он сходится с суммой 34,7 × 1 740,33 ≈ 60 389", () => {
    const gravel = items.filter((item) => item.resourceCode === "02.2.04.03-0013");
    expect(gravel).toHaveLength(1);
    expect(gravel[0]?.quantity).toBe(34.7);
    expect(gravel[0]?.positionNumber).toBe("4");
  });

  it("вторая строка уходит в отказ с причиной и обоими объёмами", () => {
    const duplicate = rejected.find((entry) => entry.reason === "DUPLICATE_POSITION");
    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toContain("дубль позиции 4");
    expect(duplicate?.message).toContain("34,7 и 347");
    expect(duplicate?.message).toContain("сходится с суммой");
  });

  it("позиция 4.1 — другая позиция, а не дубль позиции 4", () => {
    expect(byName(items, "Перевозка Грузов")?.positionNumber).toBe("4.1");
  });

  it("оба варианта сходятся или не сходятся — остаётся первая, и об этом сказано", () => {
    const text = [
      "Раздел 1. Работы",
      "7 ГЭСН01-02-027-02 Планировка площадей механизированная 1000 м2 12,5 1 12,5",
      "7 ГЭСН01-02-027-02 Планировка площадей механизированная 1000 м2 125 1 125",
    ].join("\n");
    const result = extractBillItems({
      rows: [
        {
          workName: "Планировка площадей механизированная",
          quantity: "12,5",
          unit: "1000 м2",
          evidenceQuote: "7 ГЭСН01-02-027-02 Планировка площадей механизированная 1000 м2 12,5",
          justification: "ГЭСН01-02-027-02",
        },
        {
          workName: "Планировка площадей механизированная",
          quantity: "125",
          unit: "1000 м2",
          evidenceQuote: "7 ГЭСН01-02-027-02 Планировка площадей механизированная 1000 м2 125",
          justification: "ГЭСН01-02-027-02",
        },
      ],
      sourceText: text,
      documentName: "Смета.pdf",
      idPrefix: "d1c1",
      sectionOf: () => null,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.quantity).toBe(12_500);
    expect(result.rejected[0]?.reason).toBe("DUPLICATE_POSITION");
    expect(result.rejected[0]?.message).toContain("по сумме в строке не определить");
    expect(result.rejected[0]?.message).toContain("оставлена первая");
  });

  it("верна вторая строка: остаётся она, а не первая", () => {
    const text = [
      "4 ФСБЦ-02.2.04.03-0013 Смесь песчано-гравийная м3 347 1 740,33 60 389,45",
      "4 ФСБЦ-02.2.04.03-0013 Смесь песчано-гравийная м3 34,7 1 740,33 60 389,45",
    ].join("\n");
    const result = extractBillItems({
      rows: [
        {
          workName: "Смесь песчано-гравийная",
          quantity: "347",
          unit: "м3",
          evidenceQuote: "4 ФСБЦ-02.2.04.03-0013 Смесь песчано-гравийная м3 347",
          justification: "ФСБЦ-02.2.04.03-0013",
        },
        {
          workName: "Смесь песчано-гравийная",
          quantity: "34,7",
          unit: "м3",
          evidenceQuote: "4 ФСБЦ-02.2.04.03-0013 Смесь песчано-гравийная м3 34,7",
          justification: "ФСБЦ-02.2.04.03-0013",
        },
      ],
      sourceText: text,
      documentName: "Смета.pdf",
      idPrefix: "d1c1",
      sectionOf: () => null,
    });

    expect(result.items.map((item) => item.quantity)).toEqual([34.7]);
    expect(result.rejected[0]?.message).toContain("сходится с суммой");
  });

  it("одинаковый номер и шифр далеко друг от друга — две разные позиции (два листа сметы)", () => {
    const filler = "строка-заполнитель ".repeat(150);
    const text = [
      "7 ГЭСН01-02-027-02 Планировка площадей механизированная 1000 м2 12,5",
      filler,
      "7 ГЭСН01-02-027-02 Планировка площадей механизированная 1000 м2 8,5",
    ].join("\n");
    const row = (quantity: string): BillExtractionRow => ({
      workName: "Планировка площадей механизированная",
      quantity,
      unit: "1000 м2",
      evidenceQuote: `7 ГЭСН01-02-027-02 Планировка площадей механизированная 1000 м2 ${quantity}`,
      justification: "ГЭСН01-02-027-02",
    });
    const result = extractBillItems({
      rows: [row("12,5"), row("8,5")],
      sourceText: text,
      documentName: "Смета.pdf",
      idPrefix: "d1c1",
      sectionOf: () => null,
    });

    expect(result.items).toHaveLength(2);
  });
});

describe("«Условная единица 1»: вся работа целиком", () => {
  it("отклоняется с понятной причиной", () => {
    const result = extractBillItems({
      rows: TZ_ROWS,
      sourceText: TZ_001_TEXT,
      documentName: "ТЗ.docx",
      idPrefix: "d1c1",
    });

    expect(result.items).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("WHOLE_WORK");
    expect(result.rejected[0]?.message).toContain(
      "объём задан всей работой (1 усл. ед.) — нужна разбивка по позициям",
    );
  });

  it.each([["усл. ед."], ["усл.ед."], ["объект"], ["Условная единица"]])("единица «%s» при объёме 1", (unit) => {
    const result = extractBillItems({
      rows: [
        {
          workName: "Снос объекта",
          quantity: "1",
          unit,
          evidenceQuote: "Снос объекта капитального строительства | 1",
        },
      ],
      sourceText: "Снос объекта капитального строительства | 1",
      documentName: "ТЗ.docx",
      idPrefix: "d1c1",
    });

    expect(result.rejected[0]?.reason).toBe("WHOLE_WORK");
  });
});

describe("парные объёмы", () => {
  it("«103,65/82,92» при «м3/т» раскладывается в два варианта", () => {
    const { items } = extractProject([PROJECT_ROWS[0] as BillExtractionRow], "SPEC");

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ quantity: 103.65, quantityUnit: "м3" });
    expect(items[0]?.volumeVariants).toEqual([
      { quantity: 103.65, unit: "м3" },
      { quantity: 82.92, unit: "т" },
    ]);
  });

  it("«м/т» — потерянная тройка: м3 и т", () => {
    const { items } = extractProject([PROJECT_ROWS[2] as BillExtractionRow], "SPEC");

    expect(items[0]?.volumeVariants).toEqual([
      { quantity: 123.88, unit: "м3" },
      { quantity: 99.1, unit: "т" },
    ]);
  });

  it("три значения «м2/м3/т» — три варианта", () => {
    const { items } = extractProject([PROJECT_ROWS[6] as BillExtractionRow], "SPEC");

    expect(items[0]?.volumeVariants).toEqual([
      { quantity: 308.5, unit: "м2" },
      { quantity: 16.66, unit: "м3" },
      { quantity: 556, unit: "т" },
    ]);
  });

  it("«347,7 / 34,7» при «м2/м3» (подсыпка)", () => {
    const { items } = extractProject([PROJECT_ROWS[10] as BillExtractionRow], "SPEC");

    expect(items[0]?.volumeVariants).toEqual([
      { quantity: 347.7, unit: "м2" },
      { quantity: 34.7, unit: "м3" },
    ]);
  });

  it("число пары, которого нет в цитате, отвергает всю строку", () => {
    const { items, rejected } = extractProject(
      [{ ...(PROJECT_ROWS[0] as BillExtractionRow), quantity: "103,65/99,99" }],
      "SPEC",
    );

    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("QUANTITY_NOT_IN_QUOTE");
  });

  it("чисел больше или меньше, чем единиц — не пара", () => {
    const { rejected } = extractProject(
      [{ ...(PROJECT_ROWS[0] as BillExtractionRow), unit: "м3/т/шт" }],
      "SPEC",
    );

    // Единица «м3/т/шт» при двух числах не пара: объём остаётся не числом.
    expect(rejected[0]?.reason).toBe("BAD_QUANTITY");
  });

  it("parseQuantityPair", () => {
    expect(parseQuantityPair("103,65/82,92")).toEqual([103.65, 82.92]);
    expect(parseQuantityPair("123,88 / 99,1")).toEqual([123.88, 99.1]);
    expect(parseQuantityPair("1 240,5")).toBeNull();
    expect(parseQuantityPair("12/по проекту")).toBeNull();
  });
});

describe("таблицы, которые не работы (NOT_WORK)", () => {
  it("машины и СИЗ отклоняются по заголовку таблицы — при любом уровне документа", () => {
    for (const level of ["SPEC", "BILL"] as const) {
      const { items, rejected } = extractProject(PROJECT_ROWS.slice(11), level);

      expect(items).toEqual([]);
      expect(rejected.every((entry) => entry.reason === "NOT_WORK")).toBe(true);
      expect(rejected).toHaveLength(PROJECT_ROWS.length - 11);
    }
  });

  it("причина называет таблицу", () => {
    const { rejected } = extractProject([PROJECT_ROWS[11] as BillExtractionRow]);

    expect(rejected[0]?.message).toContain("Ведомость потребности машин, механизмов и приспособлений");
    expect(rejected[0]?.message).toContain("это не работа");
  });

  it("строка с объёмом «1-2» и единицей «комп.» — NOT_WORK, а не BAD_QUANTITY и UNKNOWN_UNIT", () => {
    const { rejected } = extractProject([PROJECT_ROWS[12] as BillExtractionRow, PROJECT_ROWS[14] as BillExtractionRow]);

    expect(rejected.map((entry) => entry.reason)).toEqual(["NOT_WORK", "NOT_WORK"]);
  });

  it("поле «раздел» не заполнено — решает заголовок рядом с цитатой", () => {
    const rows = PROJECT_ROWS.slice(11, 16).map((row) => ({ ...row, section: undefined }));
    const { items, rejected } = extractProject(rows);

    expect(items).toEqual([]);
    expect(rejected.every((entry) => entry.reason === "NOT_WORK")).toBe(true);
  });

  it("таблица работ рядом с таблицей машин не задета", () => {
    const { items } = extractProject(PROJECT_ROWS.slice(0, 11));

    expect(items.length).toBeGreaterThanOrEqual(7);
    expect(items.every((item) => item.sourceLevel === "SPEC")).toBe(true);
  });

  it("далёкий заголовок не-работы не перебивает другой раздел, названный моделью", () => {
    const filler = "Текст пункта документа. ".repeat(400);
    const text = ["Таблица 4 - Ведомость потребности машин", "1 | Бульдозер - 1 шт.", filler, "2 Кладка стен из кирпича м3 12,5"].join(
      "\n",
    );
    const headings = documentHeadings(text);
    const result = extractBillItems({
      rows: [
        {
          workName: "Кладка стен из кирпича",
          quantity: "12,5",
          unit: "м3",
          evidenceQuote: "2 Кладка стен из кирпича м3 12,5",
          section: "Раздел 3. Каменные работы",
        },
      ],
      sourceText: text,
      documentName: "ТЗ.docx",
      idPrefix: "d1c1",
      headingInfoOf: (offset) => headingInfoAt(headings, offset),
    });

    expect(result.rejected).toEqual([]);
    expect(result.items).toHaveLength(1);
  });
});

describe("уровень строки внутри документа", () => {
  it("ведомость внутри ТЗ: строки под её заголовком — уровень ведомости", () => {
    const text = ["Техническое задание", "Ведомость объёмов работ", "1 Кладка стен из кирпича м3 12,5"].join("\n");
    const headings = documentHeadings(text);
    const result = extractBillItems({
      rows: [
        {
          workName: "Кладка стен из кирпича",
          quantity: "12,5",
          unit: "м3",
          evidenceQuote: "1 Кладка стен из кирпича м3 12,5",
        },
      ],
      sourceText: text,
      documentName: "ТЗ.docx",
      idPrefix: "d1c1",
      documentLevel: "SPEC",
      headingInfoOf: (offset) => headingInfoAt(headings, offset),
    });

    expect(result.items[0]?.sourceLevel).toBe("BILL");
  });

  it("без заголовка строка наследует уровень документа", () => {
    const result = extractBillItems({
      rows: [
        {
          workName: "Кладка стен из кирпича",
          quantity: "12,5",
          unit: "м3",
          evidenceQuote: "1 Кладка стен из кирпича м3 12,5",
        },
      ],
      sourceText: "1 Кладка стен из кирпича м3 12,5",
      documentName: "ТЗ.docx",
      idPrefix: "d1c1",
      documentLevel: "CUSTOMER_ESTIMATE",
    });

    expect(result.items[0]?.sourceLevel).toBe("CUSTOMER_ESTIMATE");
  });
});

describe("сверка цитаты после OCR", () => {
  it("латинские двойники в тексте и кириллица в цитате модели — одна и та же цитата", () => {
    const text = "Разборка стен 100 m3 5,8163 1 5,8163";

    expect(quoteFoundIn("Разборка стен 100 м3 5,8163", text)).toBe(true);
    expect(quoteFoundIn("Разборка стен 100 m3 5,8163", text)).toBe(true);
  });

  it("«мз» в тексте и «м3» в цитате модели", () => {
    const text = "Смесь песчано-гравийная обогащенная мз 347";

    expect(quoteFoundIn("Смесь песчано-гравийная обогащенная м3 347", text)).toBe(true);
    expect(quoteFoundIn("Смесь песчано-гравийная обогащенная мз 347", text)).toBe(true);
  });

  it("«з» внутри слов тройкой не становится", () => {
    expect(quoteFoundIn("Заказчик поставляет материалы", "Заказчик поставляет материалы")).toBe(true);
    expect(quoteFoundIn("Заказчик поставляет материалы", "3акаччик поставляет материалы")).toBe(false);
  });

  it("выдумка по-прежнему не находится", () => {
    expect(quoteFoundIn("Разборка стен 100 м3 7,7777", "Разборка стен 100 m3 5,8163")).toBe(false);
  });

  it("объём после «м3» с трёхзначной целой частью виден: «м3 347,7»", () => {
    expect(quantityVisibleIn(347.7, "м2/м3 347,7 / 34,7")).toBe(true);
    expect(quantityVisibleIn(347, "Смесь м3 347")).toBe(true);
  });

  it("а разряды по-прежнему склеиваются: «1 240,5»", () => {
    expect(quantityVisibleIn(1240.5, "Разработка грунта м3 1 240,5")).toBe(true);
  });

  it("объём с OCR-единицей виден в цитате «100 m3 5,8163»", () => {
    expect(quantityVisibleIn(5.8163, "100 m3 5,8163")).toBe(true);
  });
});

describe("служебный ресурс 999-99xx: справочная строка, а не работа", () => {
  const smetaRow = SMETA_ROWS[1] as BillExtractionRow;

  it("«Строительный мусор т 505,94» (999-9900) отклоняется как NOT_WORK", () => {
    const { items, rejected } = extractSmeta([smetaRow]);

    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("NOT_WORK");
    expect(rejected[0]?.message).toContain("справочная строка сметы");
    expect(rejected[0]?.message).toContain("999-9900");
  });

  it("то же, если модель не вернула обоснование: код стоит в цитате", () => {
    const { rejected } = extractSmeta([{ ...smetaRow, justification: undefined }]);

    expect(rejected[0]?.reason).toBe("NOT_WORK");
  });
});

describe("цена заказчика в строках сметы", () => {
  function priced(names: readonly string[]) {
    const result = extractBillItems({
      rows: SMETA_ROWS,
      sourceText: SMETA_001_OCR,
      documentName: SMETA_NAME,
      idPrefix: "d1c1",
      documentLevel: "CUSTOMER_ESTIMATE",
      pricesCurrent: true,
    });
    return names.map((part) => result.items.find((item) => item.workName.includes(part))?.customerPrice);
  }

  it("поставка и услуги: сумма по строке, сверенная с «объём × цена»", () => {
    const [placement, loading, transport] = priced(["Размещение", "гравий (выгрузка", "Перевозка Грузов"]);

    expect(placement).toMatchObject({ total: 420775.12, origin: "LINE" });
    expect(placement?.unitPrice).toBeCloseTo(831.67, 2);
    expect(loading).toMatchObject({ total: 5254.41, origin: "LINE" });
    expect(transport).toMatchObject({ total: 16378.96, origin: "LINE" });
  });

  it("работа: последнее число «Всего по позиции» — сумма в текущем уровне", () => {
    const [demolition, grading] = priced(["Разборка зданий", "Планировка"]);

    expect(demolition).toMatchObject({ total: 309564.33, origin: "POSITION_TOTAL", unit: "м3" });
    expect(demolition?.unitPrice).toBeCloseTo(309564.33 / 581.63, 6);
    expect(grading).toMatchObject({ total: 1331.21, origin: "POSITION_TOTAL" });
  });

  it("у дубля OCR цена берётся из общих чисел группы: 34,7 × 1 740,33 = 60 389,45", () => {
    const [gravel] = priced(["гравийная обогащенная"]);

    expect(gravel).toMatchObject({ total: 60389.45, origin: "LINE" });
  });

  it("без признака «текущий уровень цен» цена не читается", () => {
    const result = extractBillItems({
      rows: SMETA_ROWS,
      sourceText: SMETA_001_OCR,
      documentName: SMETA_NAME,
      idPrefix: "d1c1",
      documentLevel: "CUSTOMER_ESTIMATE",
    });

    expect(result.items.every((item) => item.customerPrice == null)).toBe(true);
  });
});
