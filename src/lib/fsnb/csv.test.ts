import { describe, expect, it } from "vitest";

import { parseCsvRecords, splitCsvHeader } from "@/lib/fsnb/csv";

/**
 * Разбор CSV выгрузок ФГИС ЦС.
 *
 * Главный сюжет — запись Архангельской области из `price-zones.csv`. Её
 * наименование зоны заключено в кавычки и содержит перевод строки, поэтому
 * наивный `split("\n")` рвёт строку пополам: первая половина уходит в индекс с
 * обрезанным наименованием и пустым центром, вторая теряется. Обе половины ниже
 * взяты из файла дословно.
 */

const ARKHANGELSK_FIRST_LINE = '29;Архангельская область;"Архангельская область районы';
const ARKHANGELSK_SECOND_LINE = ' островов Северного Ледовитого океана и его морей";г. Архангельск;;;';

describe("parseCsvRecords", () => {
  it("разбирает простые записи с разделителем «;»", () => {
    expect(parseCsvRecords("a;b;c\n1;2;3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("перевод строки в конце файла не даёт пустой записи", () => {
    expect(parseCsvRecords("a;b\n1;2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsvRecords("a;b\n1;2\r\n")).toHaveLength(2);
  });

  it("CRLF читается как один перевод строки", () => {
    expect(parseCsvRecords("a;b\r\n1;2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("разделитель внутри кавычек остаётся частью поля", () => {
    expect(parseCsvRecords('"Амурская область; 1 зона";г. Благовещенск')).toEqual([
      ["Амурская область; 1 зона", "г. Благовещенск"],
    ]);
  });

  it("перевод строки внутри кавычек не рвёт запись", () => {
    const records = parseCsvRecords(
      `${ARKHANGELSK_FIRST_LINE}\r\n${ARKHANGELSK_SECOND_LINE}\r\n`,
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toHaveLength(7);
    expect(records[0]?.[0]).toBe("29");
    expect(records[0]?.[1]).toBe("Архангельская область");
    expect(records[0]?.[2]).toBe(
      "Архангельская область районы\r\n островов Северного Ледовитого океана и его морей",
    );
    expect(records[0]?.[3]).toBe("г. Архангельск");
  });

  it("значение в кавычках возвращается без них, а перенос сохраняется дословно", () => {
    // Модуль не приводит текст к одной строке: для другого поля перенос может
    // быть частью данных. Схлопывает пробелы потребитель.
    const [record] = parseCsvRecords('"первая\nвторая";x');

    expect(record?.[0]).toBe("первая\nвторая");
    expect(record?.[0]?.replace(/\s+/g, " ").trim()).toBe("первая вторая");
  });

  it("две кавычки подряд дают одну кавычку в значении", () => {
    expect(parseCsvRecords('"Разработка грунта ""драглайн""";т')).toEqual([
      ['Разработка грунта "драглайн"', "т"],
    ]);
  });

  it("BOM не попадает в первое поле", () => {
    expect(parseCsvRecords("\uFEFFa;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("запись из одних разделителей пропускается", () => {
    expect(parseCsvRecords("a;b\n;;\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("хвост без перевода строки не теряется", () => {
    expect(parseCsvRecords("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("незакрытая кавычка не роняет разбор: хвост уходит в последнее поле", () => {
    // Обрывается выгрузка, а не парсер: лучше видимая кривая строка, чем
    // потерянный файл целиком.
    const records = parseCsvRecords('a;"b;c');

    expect(records).toEqual([["a", "b;c"]]);
  });

  it("разделитель можно задать", () => {
    expect(parseCsvRecords("a,b\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("splitCsvHeader", () => {
  it("отделяет заголовок от строк данных", () => {
    const result = splitCsvHeader(parseCsvRecords("код;имя\n1;А\n2;Б"));

    expect(result?.header).toEqual(["код", "имя"]);
    expect(result?.rows).toHaveLength(2);
  });

  it("файл без строк данных даёт null, а не пустой результат", () => {
    expect(splitCsvHeader(parseCsvRecords("код;имя"))).toBeNull();
    expect(splitCsvHeader([])).toBeNull();
  });

  it("заголовок price-zones.csv состоит из семи полей", () => {
    const header = "Код субъекта РФ;Субъект РФ;Ценовая зона;Центр ценовой зоны;Наименование муниципальных образований;;";
    const result = splitCsvHeader(parseCsvRecords(`${header}\n28;Амурская область;Амурская область (1 зона);г. Благовещенск;;;`));

    expect(result?.header).toHaveLength(7);
    expect(result?.header?.[0]).toBe("Код субъекта РФ");
    expect(result?.header?.[2]).toBe("Ценовая зона");
    expect(result?.rows[0]?.[2]).toBe("Амурская область (1 зона)");
  });
});
