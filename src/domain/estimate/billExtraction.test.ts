import { describe, expect, it } from "vitest";

import {
  deriveUnitDivisor,
  extractBillItems,
  isMoneyUnit,
  parseQuantity,
  parseUnit,
  quantityVisibleIn,
  quoteFoundIn,
  quoteIndexIn,
  resourceCodeFromJustification,
  type BillExtractionRow,
} from "@/domain/estimate/billExtraction";

/**
 * Текст ведомости написан так, как его отдаёт разбор docx: строка таблицы
 * склеена в одну, пробелы расставлены неровно. На ровном тексте проверять
 * бессмысленно — ломается разбор именно на такой склейке.
 */
const SOURCE = [
  "ВЕДОМОСТЬ ОБЪЕМОВ РАБОТ",
  "1 Разработка грунта в отвал экскаваторами | м3 | 1 240,5",
  "2 Устройство основания под фундаменты песчаного | м3 | 120",
  "3 Кладка стен из кирпича | м3 | 84,75",
  "4 Установка оконных блоков | м2 | 96",
  "Примечание: объемы уточняются по факту выполнения.",
].join("\n");

function row(over: Partial<BillExtractionRow> = {}): BillExtractionRow {
  return {
    workName: "Разработка грунта в отвал экскаваторами",
    quantity: "1 240,5",
    unit: "м3",
    evidenceQuote: "Разработка грунта в отвал экскаваторами | м3 | 1 240,5",
    ...over,
  };
}

function extract(rows: readonly BillExtractionRow[]) {
  return extractBillItems({
    rows,
    sourceText: SOURCE,
    documentName: "Ведомость объемов работ.docx",
    idPrefix: "doc1",
  });
}

describe("parseQuantity", () => {
  it.each([
    ["1 240,5", 1240.5],
    ["1240.5", 1240.5],
    ["120", 120],
    ["0,25", 0.25],
  ])("читает объём «%s»", (raw, expected) => {
    expect(parseQuantity(raw)).toBe(expected);
  });

  it("не принимает ноль, отрицательное и мусор", () => {
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("-5")).toBeNull();
    expect(parseQuantity("по проекту")).toBeNull();
    expect(parseQuantity(Number.NaN)).toBeNull();
  });
});

describe("parseUnit", () => {
  it.each([
    ["м3", "м3", 1],
    ["куб.м", "м3", 1],
    ["м³", "м3", 1],
    ["кв.м", "м2", 1],
    ["пог.м", "м", 1],
    ["шт.", "шт", 1],
    ["тонн", "т", 1],
  ])("приводит «%s» к «%s»", (raw, unit, multiplier) => {
    expect(parseUnit(raw)).toEqual({ unit, multiplier });
  });

  it("отделяет множитель от единицы", () => {
    expect(parseUnit("100 м3")).toEqual({ unit: "м3", multiplier: 100 });
    expect(parseUnit("1000 шт")).toEqual({ unit: "шт", multiplier: 1000 });
  });

  it("незнакомую единицу не угадывает", () => {
    expect(parseUnit("тыс.")).toBeNull();
    expect(parseUnit("усл.ед.")).toBeNull();
    expect(parseUnit("")).toBeNull();
  });
});

describe("isMoneyUnit", () => {
  it.each(["рублей", "руб.", "₽", "тыс. руб.", "%", "процентов"])(
    "узнаёт денежную единицу «%s»",
    (raw) => {
      expect(isMoneyUnit(raw)).toBe(true);
    },
  );

  it("единицы работ денежными не считает", () => {
    expect(isMoneyUnit("м3")).toBe(false);
    expect(isMoneyUnit("шт")).toBe(false);
  });
});

describe("deriveUnitDivisor", () => {
  it("«м3» в ведомости против «100 м3» в норме даёт сто", () => {
    expect(deriveUnitDivisor("м3", "100 м3")).toBe(100);
  });

  it("совпадающие единицы дают единицу", () => {
    expect(deriveUnitDivisor("м2", "м2")).toBe(1);
  });

  it("разные базовые единицы не переводит", () => {
    expect(deriveUnitDivisor("м2", "т")).toBeNull();
  });
});

describe("quoteFoundIn", () => {
  it("находит цитату, несмотря на разные пробелы", () => {
    expect(quoteFoundIn("Кладка  стен   из кирпича | м3 | 84,75", SOURCE)).toBe(
      true,
    );
  });

  it("не считает «ё» и «е» разными буквами", () => {
    expect(quoteFoundIn("ВЕДОМОСТЬ ОБЪЁМОВ РАБОТ", SOURCE)).toBe(true);
  });

  it("выдуманной цитаты в тексте не находит", () => {
    expect(quoteFoundIn("Монтаж металлоконструкций | т | 42", SOURCE)).toBe(
      false,
    );
  });

  it("слишком короткий обрывок за цитату не принимает", () => {
    expect(quoteFoundIn("м3", SOURCE)).toBe(false);
  });
});

describe("quoteIndexIn", () => {
  it("возвращает место цитаты в тексте", () => {
    expect(quoteIndexIn("Кладка стен из кирпича", SOURCE)).toBeGreaterThan(0);
  });

  it("на отсутствующей цитате возвращает минус один", () => {
    expect(quoteIndexIn("Монтаж металлоконструкций", SOURCE)).toBe(-1);
  });
});

describe("quantityVisibleIn", () => {
  it("видит число с пробелом в разрядах и запятой", () => {
    expect(quantityVisibleIn(1240.5, "экскаваторами | м3 | 1 240,5")).toBe(
      true,
    );
  });

  it("видит целое число", () => {
    expect(quantityVisibleIn(120, "песчаного | м3 | 120")).toBe(true);
  });

  it("не принимает число, спрятанное внутри другого", () => {
    expect(quantityVisibleIn(12, "позиция 7124 по смете")).toBe(false);
  });

  it("чужого числа в цитате не видит", () => {
    expect(quantityVisibleIn(500, "песчаного | м3 | 120")).toBe(false);
  });
});

describe("extractBillItems", () => {
  it("собирает позицию из подтверждённой строки", () => {
    const { items, rejected } = extract([row()]);

    expect(rejected).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "doc1-1",
      workName: "Разработка грунта в отвал экскаваторами",
      quantity: 1240.5,
      quantityUnit: "м3",
      unitDivisor: 1,
      normCode: null,
      sourceDocument: "Ведомость объемов работ.docx",
    });
  });

  it("умножает объём на множитель единицы", () => {
    const { items } = extract([
      row({
        workName: "Устройство основания под фундаменты песчаного",
        quantity: "120",
        unit: "м3",
        evidenceQuote:
          "Устройство основания под фундаменты песчаного | м3 | 120",
      }),
    ]);

    expect(items[0]?.quantity).toBe(120);
  });

  it("отбрасывает строку, которой нет в документе", () => {
    const { items, rejected } = extract([
      row({
        workName: "Монтаж металлоконструкций",
        quantity: "42",
        unit: "т",
        evidenceQuote: "Монтаж металлоконструкций | т | 42",
      }),
    ]);

    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("QUOTE_NOT_FOUND");
  });

  it("отбрасывает объём, которого нет в собственной цитате модели", () => {
    const { items, rejected } = extract([row({ quantity: "5000" })]);

    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("QUANTITY_NOT_IN_QUOTE");
    expect(rejected[0]?.message).toContain("не встречается в цитате");
  });

  it("отбрасывает объём «по проекту»", () => {
    const { rejected } = extract([row({ quantity: "по проекту" })]);

    expect(rejected[0]?.reason).toBe("BAD_QUANTITY");
  });

  it("отбрасывает незнакомую единицу, а не подставляет похожую", () => {
    const { rejected } = extract([
      row({
        unit: "усл.ед.",
        evidenceQuote: "Кладка стен из кирпича | м3 | 84,75",
        workName: "Кладка стен из кирпича",
        quantity: "84,75",
      }),
    ]);

    expect(rejected[0]?.reason).toBe("UNKNOWN_UNIT");
  });

  it("штраф в рублях отсекает с причиной «это сумма»", () => {
    const { items, rejected } = extract([
      row({
        workName: "Нарушение ППБ без возникновения пожара",
        quantity: "50000",
        unit: "рублей",
        evidenceQuote:
          "Нарушение ППБ без возникновения пожара | рублей | 50000",
      }),
    ]);

    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("MONEY_NOT_WORK");
    expect(rejected[0]?.message).toContain("сумма, а не объём работ");
  });

  it("принимает две отдельные привязки, когда таблица расплющена", () => {
    const flattened = [
      "Наименование работ Единица Количество",
      "Разработка грунта в отвал экскаваторами Обоснование потребности заказчика",
      "по проектной документации шифр 12-34 м3 1 240,5",
    ].join(" ");

    const { items, rejected } = extractBillItems({
      rows: [
        {
          workName: "Разработка грунта в отвал экскаваторами",
          quantity: "1 240,5",
          unit: "м3",
          evidenceQuote: "Разработка грунта в отвал экскаваторами Обоснование",
          quantityQuote: "шифр 12-34 м3 1 240,5",
        },
      ],
      sourceText: flattened,
      documentName: "ТЗ.pdf",
      idPrefix: "doc1",
    });

    expect(rejected).toEqual([]);
    expect(items[0]?.quantity).toBe(1240.5);
    expect(items[0]?.sourceQuote).toContain("…");
  });

  it("не берёт объём из другого места документа", () => {
    const far = [
      "Разработка грунта в отвал экскаваторами м3 120",
      "…".repeat(1200),
      "Устройство основания под фундаменты песчаного м3 84,75",
    ].join(" ");

    const { items, rejected } = extractBillItems({
      rows: [
        {
          workName: "Разработка грунта в отвал экскаваторами",
          quantity: "84,75",
          unit: "м3",
          evidenceQuote: "Разработка грунта в отвал экскаваторами м3 120",
          quantityQuote:
            "Устройство основания под фундаменты песчаного м3 84,75",
        },
      ],
      sourceText: far,
      documentName: "ТЗ.pdf",
      idPrefix: "doc1",
    });

    expect(items).toEqual([]);
    expect(rejected[0]?.reason).toBe("ANCHORS_TOO_FAR");
  });

  it("выдуманный фрагмент с объёмом отсекает отдельной причиной", () => {
    const { rejected } = extract([
      row({ quantityQuote: "итого по разделу 9 999 м3" }),
    ]);

    expect(rejected[0]?.reason).toBe("QUANTITY_QUOTE_NOT_FOUND");
  });

  it("отбрасывает строку без наименования", () => {
    const { rejected } = extract([row({ workName: "   " })]);

    expect(rejected[0]?.reason).toBe("EMPTY_NAME");
  });

  it("повтор той же работы с тем же объёмом не удваивает ведомость", () => {
    const { items, rejected } = extract([row(), row()]);

    expect(items).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("DUPLICATE");
  });

  it("нумерует позиции подряд и по префиксу документа", () => {
    const { items } = extract([
      row(),
      row({
        workName: "Кладка стен из кирпича",
        quantity: "84,75",
        unit: "м3",
        evidenceQuote: "Кладка стен из кирпича | м3 | 84,75",
      }),
    ]);

    expect(items.map((item) => item.id)).toEqual(["doc1-1", "doc1-2"]);
  });

  it("на пустом списке строк отдаёт пустую ведомость", () => {
    expect(extract([])).toEqual({ items: [], rejected: [] });
  });
});

/**
 * Обоснование строки отличает материал от работы.
 *
 * Живой прогон на смете 02-01-02-КМ1 показал, чего стоит это различие. Пять
 * строк — металлоконструкции из стали С255 и профнастил Н75-750-0,9 — несли
 * обоснование ФСБЦ, то есть код ресурса, а не расценки. Подбор увёл их в
 * нормы работ 09-04-001-01 и 20-01-001-15 и начислил там труд и машины,
 * которых в исходной смете нет: 1 000,72 чел.-ч против 601,21 у сметчика,
 * а материалы вместо 7 232 736,85 ₽ дали 98 139,39 ₽.
 *
 * Различить их можно по форме кода, и на префикс опираться не нужно: у
 * ресурса ФСНБ код записан точками — «07.2.07.12-0068», у расценки дефисами —
 * «09-03-002-01». Две формы не пересекаются.
 */
describe("resourceCodeFromJustification", () => {
  it("обоснование ФСБЦ: это ресурс, а не расценка", () => {
    expect(resourceCodeFromJustification("ФСБЦ-07.2.07.12-0068")).toBe("07.2.07.12-0068");
  });

  it("машина из справочника цен — тоже ресурс", () => {
    expect(resourceCodeFromJustification("ФСБЦ-91.05.01-017")).toBe("91.05.01-017");
  });

  it("код без префикса опознаётся по форме", () => {
    expect(resourceCodeFromJustification("07.2.07.12-0068")).toBe("07.2.07.12-0068");
  });

  it("прежнее имя справочника ФССЦ понимается так же", () => {
    expect(resourceCodeFromJustification("ФССЦ-01.7.03.01-0001")).toBe("01.7.03.01-0001");
  });

  it("обоснование ГЭСН — это расценка, ресурса здесь нет", () => {
    expect(resourceCodeFromJustification("ГЭСН09-03-002-01")).toBeNull();
  });

  it("книга ГЭСНм не путается с ресурсом", () => {
    expect(resourceCodeFromJustification("ГЭСНм09-04-006-01")).toBeNull();
  });

  it("обоснование словами кода не содержит", () => {
    expect(resourceCodeFromJustification("Прайс-лист поставщика")).toBeNull();
  });

  it("пустое обоснование ничего не значит", () => {
    expect(resourceCodeFromJustification(undefined)).toBeNull();
    expect(resourceCodeFromJustification("  ")).toBeNull();
  });
});

describe("вид позиции: работа или ресурс", () => {
  it("строка с обоснованием ФСБЦ несёт код ресурса", () => {
    const result = extract([row({ justification: "ФСБЦ-07.2.07.12-0068" })]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resourceCode).toBe("07.2.07.12-0068");
  });

  it("строка с обоснованием ГЭСН остаётся работой", () => {
    const result = extract([row({ justification: "ГЭСН09-03-002-01" })]);

    expect(result.items[0]?.resourceCode).toBeNull();
  });

  it("без обоснования позиция остаётся работой: подбор решит сам", () => {
    const result = extract([row()]);

    expect(result.items[0]?.resourceCode).toBeNull();
  });
});

/**
 * Слишком короткая цитата и выдуманная цитата — разные вещи.
 *
 * Порог длины стоит не зря: «т;12,5» встречается в таблице столько раз,
 * сколько в ней строк с этим объёмом, и доказательством строки не является.
 * Но объявлять такой фрагмент отсутствующим в документе — неправда, и она
 * дорого обходится: на живом прогоне две строки из трёх выбыли с сообщением
 * «фрагмента с объёмом нет в тексте документа», хотя фрагмент там был. Искать
 * при таком сообщении идут в разбор файла, а чинить надо промпт.
 */
describe("длина цитаты", () => {
  const SHORT_SOURCE = "1;ГЭСН09-03-002-01;Монтаж колонн;т;12,5";

  it("короткий фрагмент объёма отклоняется своей причиной", () => {
    const result = extractBillItems({
      rows: [
        {
          workName: "Монтаж колонн",
          quantity: "12,5",
          unit: "т",
          // Число намеренно вне цитаты: иначе сработает послабление и
          // строка пройдёт по объёму, видному в самой цитате.
          evidenceQuote: "1;ГЭСН09-03-002-01;Монтаж колонн",
          quantityQuote: "т;12,5",
        },
      ],
      sourceText: SHORT_SOURCE,
      documentName: "t.csv",
      idPrefix: "x",
    });

    expect(result.rejected[0]?.reason).toBe("QUANTITY_QUOTE_TOO_SHORT");
  });

  it("сообщение не утверждает, будто фрагмента нет в документе", () => {
    const result = extractBillItems({
      rows: [
        {
          workName: "Монтаж колонн",
          quantity: "12,5",
          unit: "т",
          // Число намеренно вне цитаты: иначе сработает послабление и
          // строка пройдёт по объёму, видному в самой цитате.
          evidenceQuote: "1;ГЭСН09-03-002-01;Монтаж колонн",
          quantityQuote: "т;12,5",
        },
      ],
      sourceText: SHORT_SOURCE,
      documentName: "t.csv",
      idPrefix: "x",
    });

    expect(result.rejected[0]?.message).not.toContain("нет в тексте");
    expect(result.rejected[0]?.message).toContain("короче");
  });

  it("выдуманный фрагмент достаточной длины по-прежнему «нет в тексте»", () => {
    const result = extractBillItems({
      rows: [
        {
          workName: "Монтаж колонн",
          quantity: "12,5",
          unit: "т",
          evidenceQuote: "1;ГЭСН09-03-002-01;Монтаж колонн;т;12,5",
          quantityQuote: "объём составляет 12,5 тонны",
        },
      ],
      sourceText: SHORT_SOURCE,
      documentName: "t.csv",
      idPrefix: "x",
    });

    expect(result.rejected[0]?.reason).toBe("QUANTITY_QUOTE_NOT_FOUND");
  });

  it("короткая цитата наименования тоже названа своим именем", () => {
    const result = extractBillItems({
      rows: [
        {
          workName: "Монтаж",
          quantity: "12,5",
          unit: "т",
          evidenceQuote: "Монтаж",
          quantityQuote: "1;ГЭСН09-03-002-01;Монтаж колонн;т;12,5",
        },
      ],
      sourceText: SHORT_SOURCE,
      documentName: "t.csv",
      idPrefix: "x",
    });

    expect(result.rejected[0]?.reason).toBe("QUOTE_TOO_SHORT");
  });
});

/**
 * Короткий фрагмент объёма не отменяет строку, если объём виден в самой цитате.
 *
 * Смысл отдельного `quantity_quote` — доказать, что число принадлежит этой
 * строке, а не соседней. Когда цитата наименования длинна, подтверждена
 * поиском по документу и число стоит внутри неё, это уже доказано: короткий
 * довесок ничего не добавляет.
 *
 * Так устроены выгрузки ГРАНД-Сметы: строка «Монтаж колонн …;т;12,5» несёт
 * наименование и объём вместе, и минимальный фрагмент с числом там физически
 * короток — «т;12,5». Отвергать такие строки значит терять ведомость целиком
 * на самом обычном формате.
 */
describe("объём внутри цитаты наименования", () => {
  const SOURCE =
    "1;ГЭСН09-03-002-01;Монтаж колонн одноэтажных зданий массой до 1,0 т;т;12,5\n" +
    "2;ГЭСН09-04-006-01;Монтаж связей и распорок;т;3,75";

  it("короткий фрагмент объёма прощается, когда число видно в цитате", () => {
    const result = extractBillItems({
      rows: [
        {
          workName: "Монтаж колонн одноэтажных зданий массой до 1,0 т",
          quantity: "12,5",
          unit: "т",
          evidenceQuote: "Монтаж колонн одноэтажных зданий массой до 1,0 т;т;12,5",
          quantityQuote: "т;12,5",
        },
      ],
      sourceText: SOURCE,
      documentName: "t.csv",
      idPrefix: "x",
    });

    expect(result.rejected).toEqual([]);
    expect(result.items[0]?.quantity).toBe(12.5);
  });

  it("если числа в цитате нет, короткий фрагмент по-прежнему отклоняет строку", () => {
    const result = extractBillItems({
      rows: [
        {
          workName: "Монтаж связей и распорок",
          quantity: "3,75",
          unit: "т",
          evidenceQuote: "2;ГЭСН09-04-006-01;Монтаж связей и распорок",
          quantityQuote: "т;3,75",
        },
      ],
      sourceText: SOURCE,
      documentName: "t.csv",
      idPrefix: "x",
    });

    expect(result.rejected[0]?.reason).toBe("QUANTITY_QUOTE_TOO_SHORT");
  });

  it("чужой объём в цитату не пролезает", () => {
    const result = extractBillItems({
      rows: [
        {
          workName: "Монтаж колонн одноэтажных зданий массой до 1,0 т",
          quantity: "3,75",
          unit: "т",
          evidenceQuote: "Монтаж колонн одноэтажных зданий массой до 1,0 т;т;12,5",
          quantityQuote: "т;3,75",
        },
      ],
      sourceText: SOURCE,
      documentName: "t.csv",
      idPrefix: "x",
    });

    expect(result.rejected[0]?.reason).toBe("QUANTITY_QUOTE_TOO_SHORT");
  });
});
