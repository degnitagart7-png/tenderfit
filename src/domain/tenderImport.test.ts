import { describe, expect, it } from "vitest";
import type { ImportedTender } from "@/domain/entities";
import {
  importedToTender,
  parseCsvLine,
  parseImportedDate,
  parseImportedNumber,
  parseImportedPlacingWay,
  parseTendersCsv,
} from "@/domain/tenderImport";

const HEADER = "Реестровый номер;Закон;Предмет;Заказчик;Регион;НМЦК;ОКПД2;Окончание подачи;Срок поставки";

function csvRow(cells: string[]): string {
  return `${HEADER}\n${cells.join(";")}`;
}

describe("parseCsvLine", () => {
  it("простые поля по разделителю", () => {
    expect(parseCsvLine("a;b;c", ";")).toEqual(["a", "b", "c"]);
  });

  it("разделитель внутри кавычек не режет поле", () => {
    expect(parseCsvLine('a;"b;c";d', ";")).toEqual(["a", "b;c", "d"]);
  });

  it("двойные кавычки экранируются", () => {
    expect(parseCsvLine('"сказал ""да"""', ";")).toEqual(['сказал "да"']);
  });

  it("пробелы по краям срезаются", () => {
    expect(parseCsvLine(" a , b ", ",")).toEqual(["a", "b"]);
  });
});

describe("parseImportedNumber", () => {
  it("пробелы и запятая-десятичная", () => {
    expect(parseImportedNumber("1 200 000,50")).toBeCloseTo(1200000.5, 2);
    expect(parseImportedNumber("1 500")).toBe(1500);
  });
  it("точка как разделитель тоже работает", () => {
    expect(parseImportedNumber("1200000.5")).toBeCloseTo(1200000.5, 2);
  });
  it("пустое/нечисло — null", () => {
    expect(parseImportedNumber("")).toBeNull();
    expect(parseImportedNumber("н/д")).toBeNull();
  });
});

describe("parseImportedDate", () => {
  it("дд.мм.гггг → ISO", () => {
    expect(parseImportedDate("31.12.2026")).toBe("2026-12-31T10:00:00.000Z");
  });
  it("дд.мм.гг → ISO", () => {
    expect(parseImportedDate("05.06.26")).toBe("2026-06-05T10:00:00.000Z");
  });
  it("ISO проходит", () => {
    expect(parseImportedDate("2026-06-01T12:00:00.000Z")).toBe("2026-06-01T12:00:00.000Z");
  });
  it("мусор — null", () => {
    expect(parseImportedDate("когда-нибудь")).toBeNull();
    expect(parseImportedDate("")).toBeNull();
  });
});

describe("parseTendersCsv", () => {
  it("корректная строка с русскими заголовками и ; ", () => {
    const { rows, errors } = parseTendersCsv(
      csvRow(["0115200000126000001", "44-ФЗ", "Поставка компьютеров", "ГБУ Центр", "Москва", "1 250 000,00", "26.20.11", "31.12.2026", "30"]),
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.regNumber).toBe("0115200000126000001");
    expect(r.law).toBe("FZ_44");
    expect(r.price).toBe(1250000);
    expect(r.deliveryTermDays).toBe(30);
    expect(r.source).toBe("CSV");
    expect(r.id).toBe("imp-0115200000126000001");
  });

  it("разделитель-запятая определяется", () => {
    const header = HEADER.replace(/;/g, ",");
    const row = "123,223-ФЗ,Ноутбуки,АО Ромашка,СПб,500000,26.20,15.01.2027,10";
    const { rows, errors } = parseTendersCsv(`${header}\n${row}`);
    expect(errors).toEqual([]);
    expect(rows[0]?.law).toBe("FZ_223");
  });

  it("строка без обязательных колонок отклоняется с ошибкой", () => {
    const { rows, errors } = parseTendersCsv(csvRow(["", "44-ФЗ", "", "Заказчик", "Москва", "100", "", "31.12.2026", ""]));
    expect(rows).toHaveLength(0);
    expect(errors[0]?.line).toBe(2);
  });

  it("неразобранная цена — ошибка строки", () => {
    const { rows, errors } = parseTendersCsv(csvRow(["1", "44-ФЗ", "Товар", "Заказ", "Мск", "н/д", "", "31.12.2026", ""]));
    expect(rows).toHaveLength(0);
    expect(errors[0]?.message).toContain("НМЦК");
  });

  it("CSV только из заголовка — ошибка", () => {
    const { rows, errors } = parseTendersCsv(HEADER);
    expect(rows).toHaveLength(0);
    expect(errors.length).toBe(1);
  });

  it("пустые необязательные поля дают домены по умолчанию", () => {
    const { rows } = parseTendersCsv(csvRow(["77", "44-ФЗ", "Услуга", "", "", "100000", "", "01.02.2027", ""]));
    const r = rows[0]!;
    expect(r.customerName).toBe("Заказчик не указан");
    expect(r.region).toBe("Не указан");
    expect(r.okpd2Codes).toEqual([]);
    expect(r.deliveryTermDays).toBeNull();
  });
});

describe("importedToTender", () => {
  const imp: ImportedTender = {
    id: "imp-1",
    regNumber: "1",
    law: "FZ_44",
    placingWay: "ELECTRONIC_AUCTION",
    subject: "Поставка",
    customerName: "ГБУ",
    customerInn: null,
    region: "Москва",
    price: 100000,
    okpd2Codes: ["26.20"],
    submissionEnd: "2026-12-31T10:00:00.000Z",
    deliveryTermDays: 30,
    documentsText: "Текст документации…",
    importedAt: "2026-05-15T12:00:00.000Z",
    source: "CSV",
  };

  it("переносит основные поля и ставит dataSource IMPORT", () => {
    const t = importedToTender(imp);
    expect(t.dataSource).toBe("IMPORT");
    expect(t.financial.price).toBe(100000);
    expect(t.deadlines.submissionEnd).toBe(imp.submissionEnd);
    expect(t.eisUrl).toContain("regNumber=1");
  });

  it("текст документации становится документом OTHER", () => {
    const t = importedToTender(imp);
    expect(t.documents).toHaveLength(1);
    expect(t.documents[0]?.type).toBe("OTHER");
    expect(t.documents[0]?.text).toBe("Текст документации…");
    expect(importedToTender({ ...imp, documentsText: "" }).documents).toHaveLength(0);
  });

  it("placingWay переносится из импорта и влияет на ссылку ЕИС", () => {
    const contest: ImportedTender = { ...imp, placingWay: "OPEN_CONTEST", regNumber: "0873200009826004473" };
    const t = importedToTender(contest);
    expect(t.placingWay).toBe("OPEN_CONTEST");
    expect(t.eisUrl).toContain("/notice/ok20/");
    expect(t.eisUrl).not.toContain("/notice/ea20/");
  });
});

describe("parseImportedPlacingWay", () => {
  it("электронный аукцион", () => {
    expect(parseImportedPlacingWay("Электронный аукцион")).toBe("ELECTRONIC_AUCTION");
  });
  it("открытый конкурс", () => {
    expect(parseImportedPlacingWay("Открытый конкурс")).toBe("OPEN_CONTEST");
  });
  it("запрос котировок", () => {
    expect(parseImportedPlacingWay("Запрос котировок")).toBe("REQUEST_FOR_QUOTATION");
  });
  it("запрос предложений", () => {
    expect(parseImportedPlacingWay("Запрос предложений")).toBe("REQUEST_FOR_PROPOSALS");
  });
  it("единственный поставщик", () => {
    expect(parseImportedPlacingWay("Закупка у единственного поставщика")).toBe("SOLE_SUPPLIER");
  });
  it("пустая строка → OTHER", () => {
    expect(parseImportedPlacingWay("")).toBe("OTHER");
  });
  it("нераспознанный текст → OTHER", () => {
    expect(parseImportedPlacingWay("Какой-то странный способ")).toBe("OTHER");
  });
});

describe("parseTendersCsv — placingWay", () => {
  const HEADER_WITH_PW = "Реестровый номер;Закон;Предмет;Заказчик;Регион;НМЦК;Способ определения;Окончание подачи";

  it("парсит способ определения из CSV", () => {
    const csv = `${HEADER_WITH_PW}\n0115200000126000001;44-ФЗ;Поставка;ГБУ;Москва;100000;Электронный аукцион;31.12.2026`;
    const { rows } = parseTendersCsv(csv);
    expect(rows[0]!.placingWay).toBe("ELECTRONIC_AUCTION");
  });

  it("конкурс в CSV → OPEN_CONTEST", () => {
    const csv = `${HEADER_WITH_PW}\n0873200009826004473;44-ФЗ;Услуга;АО;СПб;500000;Открытый конкурс;15.01.2027`;
    const { rows } = parseTendersCsv(csv);
    expect(rows[0]!.placingWay).toBe("OPEN_CONTEST");
  });

  it("отсутствующая колонка → OTHER", () => {
    const csv = `Реестровый номер;Закон;Предмет;Заказчик;Регион;НМЦК;Окончание подачи\n1;44-ФЗ;Товар;Заказ;Мск;100000;31.12.2026`;
    const { rows } = parseTendersCsv(csv);
    expect(rows[0]!.placingWay).toBe("OTHER");
  });
});
