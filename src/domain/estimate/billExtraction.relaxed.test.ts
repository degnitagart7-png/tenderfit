import { describe, expect, it } from "vitest";

import {
  countRejections,
  emptyExtractionStats,
  extractBillItems,
  quoteFoundIn,
  type BillExtractionRow,
} from "@/domain/estimate/billExtraction";
import { confirmQuantity, foldWithMap, isHeaderUnitLabel } from "@/domain/estimate/billQuoteMatch";

/**
 * Живые документы отличаются от цитат модели не выдумками, а записью: пробелы и
 * табуляция, тире, кавычки CSV, формат числа, перенос строки в PDF, перевод кг в т,
 * подпись колонки вместо единицы. Эти тесты фиксируют, что такая запись принимается,
 * а число, которого в строке нет, по-прежнему отклоняется.
 */

function run(rows: readonly BillExtractionRow[], sourceText: string) {
  const stats = emptyExtractionStats();
  const result = extractBillItems({ rows, sourceText, documentName: "Ведомость.pdf", idPrefix: "d1c1", stats });
  return { ...result, stats };
}

describe("нормализация цитаты и текста", () => {
  it("CSV: серии запятых, кавычки ячеек и формат числа не мешают найти цитату", () => {
    const csv = '"1",,,"Устройство основания под фундаменты",,"м3",,"1 234,50"';
    expect(quoteFoundIn("Устройство основания под фундаменты, м3, 1234.5", csv)).toBe(true);
    expect(quoteFoundIn("Устройство основания под фундаменты | м3 | 1 234,5", csv)).toBe(true);
  });

  it("неразрывный пробел, табуляция, перенос строки и вид тире сводятся к одному", () => {
    const text = "Монтаж колонн\t–\tодноэтажных\r\nзданий—т\t12,50";
    expect(quoteFoundIn("монтаж колонн - одноэтажных зданий-т 12.5", text)).toBe(true);
  });

  it("число в любой записи даёт один и тот же свёрнутый вид", () => {
    const forms = ["1 234,5", "1234.5", "1234,50", "1 234,5"].map((value) => foldWithMap(`кг ${value}`).folded);
    expect(new Set(forms).size).toBe(1);
  });

  it("цитата из другого документа отклоняется", () => {
    const { items, rejected } = run(
      [
        {
          workName: "Монтаж металлоконструкций",
          quantity: "42",
          unit: "т",
          evidenceQuote: "Монтаж металлоконструкций ангара | т | 42",
        },
      ],
      "1;Разработка грунта экскаваторами;м3;1 240,5",
    );
    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("QUOTE_NOT_FOUND");
    expect(rejected[0]?.message).toContain("без учёта регистра");
  });
});

describe("строка с табуляцией", () => {
  const source = "Наименование\tЕд. изм.\tКол-во\n1\tРазработка грунта вручную в траншеях\tм3\t12,5\n2\tЗасыпка траншей\tм3\t40";

  it("цитата с пробелами вместо табуляции подтверждается строкой", () => {
    const { items, rejected } = run(
      [
        {
          workName: "Разработка грунта вручную в траншеях",
          quantity: "12,5",
          unit: "м3",
          evidenceQuote: "Разработка грунта вручную в траншеях м3 12,5",
        },
      ],
      source,
    );
    expect(rejected).toEqual([]);
    expect(items[0]?.quantity).toBe(12.5);
  });
});

describe("строка PDF, разорванная переносами", () => {
  const source = [
    "Раздел 1. Отделочные работы",
    "1 Устройство покрытия пола из керамической",
    "плитки на клеевом составе",
    "м2",
    "85,4",
    "2 Окраска стен водоэмульсионными составами",
    "м2",
    "310",
  ].join("\n");

  it("короткий фрагмент объёма принимается, когда число стоит в строке с наименованием", () => {
    const { items, rejected, stats } = run(
      [
        {
          workName: "Устройство покрытия пола из керамической плитки",
          quantity: "85,4",
          unit: "м2",
          evidenceQuote: "Устройство покрытия пола из керамической плитки на клеевом составе",
          quantityQuote: "м2 85,4",
        },
      ],
      source,
    );
    expect(rejected).toEqual([]);
    expect(items[0]?.quantity).toBe(85.4);
    expect(stats.rowAnchored).toBe(1);
  });

  it("то же число, но у другой работы, не принимается", () => {
    const { items, rejected } = run(
      [
        {
          workName: "Окраска стен водоэмульсионными составами",
          quantity: "85,4",
          unit: "м2",
          evidenceQuote: "Окраска стен водоэмульсионными составами",
          quantityQuote: "м2 85,4",
        },
      ],
      source,
    );
    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("QUANTITY_QUOTE_TOO_SHORT");
    expect(rejected[0]?.message).toContain("в одной строке с наименованием");
  });
});

describe("короткий фрагмент объёма — «2», «12,5»", () => {
  const source = ["1;Гайки М12 оцинкованные;шт;5", "2;Болты М12 высокопрочные;шт;2", "3;Шайбы М12;шт;12,5"].join("\n");

  it("одно число в ячейке принимается по строке", () => {
    const { items, rejected } = run(
      [
        {
          workName: "Болты М12 высокопрочные",
          quantity: "2",
          unit: "шт",
          evidenceQuote: "Болты М12 высокопрочные",
          quantityQuote: "2",
        },
      ],
      source,
    );
    expect(rejected).toEqual([]);
    expect(items[0]?.quantity).toBe(2);
  });

  it("число, которого нет в строке наименования, отклоняется", () => {
    const { items, rejected } = run(
      [
        {
          workName: "Болты М12 высокопрочные",
          quantity: "5",
          unit: "шт",
          evidenceQuote: "Болты М12 высокопрочные",
          quantityQuote: "5",
        },
      ],
      source,
    );
    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("QUANTITY_QUOTE_TOO_SHORT");
  });

  it("число, которого нет нигде в документе, отклоняется", () => {
    const { items, rejected } = run(
      [
        {
          workName: "Болты М12 высокопрочные",
          quantity: "999",
          unit: "шт",
          evidenceQuote: "Болты М12 высокопрочные",
          quantityQuote: "999",
        },
      ],
      source,
    );
    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("QUANTITY_QUOTE_TOO_SHORT");
  });

  it("номер позиции за объём не принимается", () => {
    const { items, rejected } = run(
      [
        {
          workName: "Болты М12 высокопрочные",
          quantity: "2",
          unit: "шт",
          evidenceQuote: "Болты М12 высокопрочные",
          quantityQuote: "2",
        },
      ],
      "2;Болты М12 высокопрочные;шт;по проекту",
    );
    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("QUANTITY_QUOTE_TOO_SHORT");
  });
});

describe("подпись колонки вместо единицы", () => {
  const source = "№;Наименование;Ед. изм.;Кол-во\n1;Болты М12 высокопрочные;кг;2,2\n2;Гайки М12;шт;40";

  it.each(["ед. изм.", "единица измерения", "ед.", "Ед.изм."])("«%s» распознаётся как подпись", (label) => {
    expect(isHeaderUnitLabel(label)).toBe(true);
  });

  it("единица берётся из строки рядом с объёмом", () => {
    const { items, rejected, stats } = run(
      [
        {
          workName: "Болты М12 высокопрочные",
          quantity: "2,2",
          unit: "ед. изм.",
          evidenceQuote: "Болты М12 высокопрочные;кг;2,2",
        },
      ],
      source,
    );
    expect(rejected).toEqual([]);
    expect(items[0]?.quantityUnit).toBe("кг");
    expect(stats.unitRecovered).toBe(1);
  });

  it("не нашлось единицы в строке — отказ UNKNOWN_UNIT с описанием проверки", () => {
    const { items, rejected } = run(
      [
        {
          workName: "Благоустройство территории вокруг здания",
          quantity: "12,5",
          unit: "единица измерения",
          evidenceQuote: "Благоустройство территории вокруг здания 12,5",
        },
      ],
      "1 Благоустройство территории вокруг здания 12,5",
    );
    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("UNKNOWN_UNIT");
    expect(rejected[0]?.message).toContain("подпись колонки");
    expect(rejected[0]?.message).toContain("проверена строка");
  });
});

describe("объём в другой единице: кг и т", () => {
  const source = "3;Болты М12 высокопрочные;кг;2,2\n4;Гайки М12;кг;3,4";

  it("2,2 кг принимается как 0,0022 т", () => {
    const { items, rejected, stats } = run(
      [
        {
          workName: "Болты М12 высокопрочные",
          quantity: "0,0022",
          unit: "т",
          evidenceQuote: "Болты М12 высокопрочные;кг;2,2",
        },
      ],
      source,
    );
    expect(rejected).toEqual([]);
    expect(items[0]?.quantity).toBeCloseTo(0.0022, 10);
    expect(items[0]?.quantityUnit).toBe("т");
    expect(stats.unitFactor).toBe(1);
  });

  it("порядок ошибся — 0,022 т при 2,2 кг — отклоняется и называет проверенное", () => {
    const { items, rejected } = run(
      [
        {
          workName: "Болты М12 высокопрочные",
          quantity: "0,022",
          unit: "т",
          evidenceQuote: "Болты М12 высокопрочные;кг;2,2",
        },
      ],
      source,
    );
    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("QUANTITY_NOT_IN_QUOTE");
    expect(rejected[0]?.message).toContain("с пересчётом единиц");
  });

  it("«100 м2» в цитате и 250 м2 у модели совпадают", () => {
    const evidence = confirmQuantity({
      quantity: 250,
      unit: { unit: "м2", multiplier: 1 },
      quote: "Устройство стяжки 100 м2 2,5",
      row: null,
    });
    expect(evidence?.proof).toBe("UNIT_FACTOR");
  });

  it("единица цитаты не из той величины пересчёт не даёт", () => {
    const evidence = confirmQuantity({
      quantity: 0.0022,
      unit: { unit: "т", multiplier: 1 },
      quote: "Болты М12 шт 2,2",
      row: null,
    });
    expect(evidence).toBeNull();
  });
});

describe("арифметика строки", () => {
  const source = "5;Монтаж перегородок из гипсокартона;шт;225*3\n6;Монтаж подвесных потолков;шт;40";

  it("формула «225*3» подтверждает 675", () => {
    const { items, rejected, stats } = run(
      [
        {
          workName: "Монтаж перегородок из гипсокартона",
          quantity: "675",
          unit: "шт",
          evidenceQuote: "Монтаж перегородок из гипсокартона;шт;225*3",
        },
      ],
      source,
    );
    expect(rejected).toEqual([]);
    expect(items[0]?.quantity).toBe(675);
    expect(stats.arithmetic).toBe(1);
  });

  it("число, не получающееся из чисел строки, отклоняется", () => {
    const { items, rejected } = run(
      [
        {
          workName: "Монтаж перегородок из гипсокартона",
          quantity: "700",
          unit: "шт",
          evidenceQuote: "Монтаж перегородок из гипсокартона;шт;225*3",
        },
      ],
      source,
    );
    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("QUANTITY_NOT_IN_QUOTE");
  });
});

describe("счётчики отказов", () => {
  it("считает по причинам", () => {
    expect(
      countRejections([{ reason: "UNKNOWN_UNIT" }, { reason: "UNKNOWN_UNIT" }, { reason: "QUOTE_NOT_FOUND" }]),
    ).toEqual({ UNKNOWN_UNIT: 2, QUOTE_NOT_FOUND: 1 });
  });
});
