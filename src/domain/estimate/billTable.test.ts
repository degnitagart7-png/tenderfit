import { describe, expect, it } from "vitest";

import { parseBillTables, parseTableNumber, readBillTables } from "@/domain/estimate/billTable";
import { deriveUnitDivisor } from "@/domain/estimate/units";

/** ВОР из закупки 0134300025826000377: odt, переведённый в текст, колонки через табуляцию. */
const VOR_ODT = [
  "Ведомость объемов работ",
  "№ п/п\tНаименование\tЕд. изм.\tКол-во\tПримечание",
  "ул. Возрождения, д. 46",
  "1\tДемонтаж оконных откосов\tмп/шт\t68,7/46\t*В целях доступа к профлисту. b = 300 мм",
  "2\tДемонтаж профлиста\tм2\t199,1",
  "3\tРез профлиста\tмп\t59,3\tУШМ. *В целях исключения разбора остекленных балконов",
  "4\tДемонтаж утеплителя\tм2\t56,5",
  "5\tМонтаж каркаса из оцинкованного профиля\tмп\t310,2",
  "6\tМонтаж ветрозащитной мембраны\tм2\t199,1",
  "7\tМонтаж подсистемы из кронштейнов\tшт\t420",
  "8\tМонтаж утеплителя\tм2\t56,5\tλА = 0,038 Вт/(м·°K), p = 100 кг/м3, 1 слой — h = 150 мм, 2 слой — h = 50 мм.",
  "9\tМонтаж профлиста\tм2\t199,1",
  "10\tМонтаж оконных откосов\tмп\t68,7",
  "11\tМонтаж отливов\tмп\t46,0",
  "12\tМонтаж доборных элементов\tмп\t88,4",
  "13\tМонтаж угловых элементов\tмп\t24,8",
  "14\tМонтаж стыковочной планки профлиста\tмп\t118,6\t*Для стыков листов",
  "Утилизация мусора",
  "1\tУтилизация строительного мусора\tм3/т\t11,3/1,13\t*Утеплитель. Вывоз на полигон ТБО, 51км",
  "",
  "Заказчик ______________",
].join("\n");

describe("parseBillTables: ВОР из odt (колонки через табуляцию)", () => {
  const result = parseBillTables(VOR_ODT);
  const rows = result.tables[0]?.rows ?? [];

  it("читает все 15 строк одной доверенной таблицей", () => {
    expect(result.tables).toHaveLength(1);
    expect(rows).toHaveLength(15);
    expect(result.tables[0]?.skipped).toHaveLength(0);
  });

  it("приводит единицы к виду ФСНБ: м2, м (мп), шт, т", () => {
    const units = new Set(rows.map((row) => row.unit));
    expect([...units].sort()).toEqual(["м", "м2", "т", "шт"].sort());
  });

  it("парную единицу «мп/шт» читает первой величиной, вторую оставляет рядом", () => {
    const row = rows[0];
    expect(row?.name).toBe("Демонтаж оконных откосов");
    expect(row?.unit).toBe("м");
    expect(row?.quantity).toBeCloseTo(68.7, 6);
    expect(row?.variants).toEqual([
      { quantity: 68.7, unit: "м" },
      { quantity: 46, unit: "шт" },
    ]);
    expect(row?.remark).toContain("46 шт");
    expect(row?.remark).toContain("В целях доступа к профлисту");
  });

  it("у мусора из «м3/т» берёт тонны, а кубометры оставляет вариантом", () => {
    const row = rows[14];
    expect(row?.name).toBe("Утилизация строительного мусора");
    expect(row?.unit).toBe("т");
    expect(row?.quantity).toBeCloseTo(1.13, 6);
    expect(row?.variants).toEqual([
      { quantity: 1.13, unit: "т" },
      { quantity: 11.3, unit: "м3" },
    ]);
    expect(row?.remark).toContain("Вывоз на полигон ТБО, 51км");
  });

  it("строки-разделы без номера становятся разделом позиций", () => {
    expect(rows[0]?.section).toBe("ул. Возрождения, д. 46");
    expect(rows[13]?.section).toBe("ул. Возрождения, д. 46");
    expect(rows[14]?.section).toBe("Утилизация мусора");
  });

  it("цитата — строка документа дословно, номер позиции читается", () => {
    expect(rows[1]?.quote).toBe("2\tДемонтаж профлиста\tм2\t199,1");
    expect(VOR_ODT).toContain(rows[1]?.quote ?? "");
    expect(rows[1]?.positionNumber).toBe("2");
    expect(rows[14]?.positionNumber).toBe("1");
  });

  it("подписи «ЗАКАЗЧИК» обрывают таблицу", () => {
    const withTail = `${VOR_ODT}\n15\tЛишняя строка после подписи\tм2\t5`;
    expect(parseBillTables(withTail).tables[0]?.rows).toHaveLength(15);
  });
});

describe("parseBillTables: лист xlsx в виде csv", () => {
  const CSV = [
    "=== Смета ===",
    "Ведомость объёмов работ по объекту,,,,,,",
    "№ п/п,Наименование работ,Ед. изм.,Кол-во,,,",
    "Раздел 1. Отопление,,,,,,",
    "1,Демонтаж радиаторов отопления,шт,12,,,",
    '2,"Прокладка труб, d=25 мм",м,"1 234,5",,,',
    "3,Окраска труб,м2,48.75,,,",
    "4,Испытание системы,компл,по проекту,,,",
    "Раздел 2. Электрика,,,,,,",
    '5,"Прокладка кабеля\nпо стене",м,300,,,',
    "Итого,,,,,,",
    "=== Другой лист ===",
    "6,Не из этой таблицы,м2,1,,,",
  ].join("\n");
  const result = parseBillTables(CSV);
  const table = result.tables[0];

  it("читает числа «1 234,5», «48.75» и запятые внутри имени в кавычках", () => {
    expect(table?.rows.map((row) => [row.name, row.unit, row.quantity])).toEqual([
      ["Демонтаж радиаторов отопления", "шт", 12],
      ["Прокладка труб, d=25 мм", "м", 1234.5],
      ["Окраска труб", "м2", 48.75],
      ["Прокладка кабеля по стене", "м", 300],
    ]);
  });

  it("строка «по проекту» пропущена с причиной, а не молча", () => {
    expect(table?.skipped).toHaveLength(1);
    expect(table?.skipped[0]?.reason).toBe("BAD_QUANTITY");
    expect(table?.skipped[0]?.message).toContain("по проекту");
  });

  it("разделы читаются из строк с одной ячейкой, «Итого» и метка листа обрывают таблицу", () => {
    expect(table?.rows.map((row) => row.section)).toEqual([
      "Раздел 1. Отопление",
      "Раздел 1. Отопление",
      "Раздел 1. Отопление",
      "Раздел 2. Электрика",
    ]);
    expect(table?.rows.some((row) => row.name === "Не из этой таблицы")).toBe(false);
  });
});

describe("parseBillTables: таблица docx с колонкой «Формула»", () => {
  const DOCX = [
    "Приложение 2. Ведомость объёмов работ",
    "№ п/п\tНаименование работ\tЕд. изм.\tФормула/Расчёт\tКол-во (Объём)\tПримечание",
    "1\tУстройство стяжки\tм2\t225*3\t675\tМ150",
    "1.1\tГрунтовка стяжки\tм2\t(380+190)/1000\t0,57\t",
    "2\tПокраска стен\tм2\t\t1 200\t",
    "3\tМонтаж дверных блоков\tшт\t\t14\tв комплекте с фурнитурой",
  ].join("\n");
  const rows = parseBillTables(DOCX).tables[0]?.rows ?? [];

  it("объём берёт из колонки количества, а не из формулы", () => {
    expect(rows.map((row) => row.quantity)).toEqual([675, 0.57, 1200, 14]);
  });

  it("формула остаётся рядом с объёмом в примечании, подномер сохраняется", () => {
    expect(rows[0]?.remark).toContain("225*3");
    expect(rows[0]?.remark).toContain("М150");
    expect(rows[1]?.positionNumber).toBe("1.1");
  });
});

describe("parseBillTables: текст pdf с колонками через пробелы", () => {
  it("колонки из нескольких пробелов", () => {
    const text = [
      "ВЕДОМОСТЬ ОБЪЁМОВ РАБОТ",
      "№ п/п  Наименование работ  Ед. изм.  Кол-во  Примечание",
      "1  Демонтаж кирпичных перегородок  м3  14,2",
      "2  Разборка покрытий полов  м2  120",
      "3  Устройство перегородок из ГКЛ  м2  86,4  в два слоя",
    ].join("\n");
    const rows = parseBillTables(text).tables[0]?.rows ?? [];
    expect(rows.map((row) => [row.name, row.unit, row.quantity])).toEqual([
      ["Демонтаж кирпичных перегородок", "м3", 14.2],
      ["Разборка покрытий полов", "м2", 120],
      ["Устройство перегородок из ГКЛ", "м2", 86.4],
    ]);
    expect(rows[2]?.remark).toBe("в два слоя");
  });

  it("колонки через одиночные пробелы читаются по хвосту строки «единица — число»", () => {
    const text = [
      "№ п/п Наименование работ Ед. изм. Кол-во",
      "1 Демонтаж кирпичных перегородок м3 14,2",
      "2 Разборка покрытий полов м2 120",
      "3 Устройство перегородок из ГКЛ кв. м 86,4",
      "Заказчик",
    ].join("\n");
    const rows = parseBillTables(text).tables[0]?.rows ?? [];
    expect(rows.map((row) => [row.name, row.unit, row.quantity])).toEqual([
      ["Демонтаж кирпичных перегородок", "м3", 14.2],
      ["Разборка покрытий полов", "м2", 120],
      ["Устройство перегородок из ГКЛ", "м2", 86.4],
    ]);
  });

  it("шапка на двух строках", () => {
    const text = [
      "№ п/п\tНаименование работ\tЕд.\tКол-во",
      "\t\tизм.\t",
      "1\tЗамена светильников\tшт\t24",
      "2\tПрокладка кабеля\tм\t310",
      "3\tМонтаж розеток\tшт\t18",
    ].join("\n");
    const result = parseBillTables(text);
    expect(result.tables[0]?.rows).toHaveLength(3);
  });

  it("повторённая на новой странице шапка не рвёт таблицу", () => {
    const header = "№ п/п\tНаименование работ\tЕд. изм.\tКол-во";
    const text = [
      header,
      "1\tЗамена светильников\tшт\t24",
      "2\tПрокладка кабеля\tм\t310",
      header,
      "3\tМонтаж розеток\tшт\t18",
    ].join("\n");
    const result = parseBillTables(text);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.rows).toHaveLength(3);
  });
});

describe("parseBillTables: чему не доверяем", () => {
  it("текст технического задания без таблицы — пусто", () => {
    const text = [
      "Техническое задание на выполнение работ по капитальному ремонту кровли.",
      "Подрядчик обязан выполнить демонтаж существующего покрытия, устройство пароизоляции,",
      "монтаж утеплителя и кровельного покрытия. Наименование работ, единица измерения и количество",
      "определяются ведомостью. Объём работ уточняется по факту.",
    ].join("\n");
    expect(parseBillTables(text).tables).toHaveLength(0);
  });

  it("меньше трёх строк — не ведомость", () => {
    const text = ["№ п/п\tНаименование работ\tЕд. изм.\tКол-во", "1\tЗамена светильников\tшт\t24", "2\tПрокладка кабеля\tм\t310"].join("\n");
    const result = parseBillTables(text);
    expect(result.tables).toHaveLength(0);
    expect(result.untrusted).toBe(1);
  });

  it("таблица потребности в машинах — не работы", () => {
    const text = [
      "№ п/п\tНаименование машин и механизмов\tЕд. изм.\tКол-во",
      "1\tЭкскаватор\tшт\t2",
      "2\tАвтокран\tшт\t1",
      "3\tКомпрессор\tшт\t1",
    ].join("\n");
    expect(parseBillTables(text).tables).toHaveLength(0);
  });

  it("две колонки количества без «всего» — шапка неоднозначна", () => {
    const text = [
      "№\tНаименование\tЕд. изм.\tКол-во на единицу\tКол-во на этаж",
      "1\tЗамена светильников\tшт\t2\t24",
      "2\tПрокладка кабеля\tм\t5\t310",
      "3\tМонтаж розеток\tшт\t1\t18",
    ].join("\n");
    expect(parseBillTables(text).tables).toHaveLength(0);
  });

  it("строки с нераспознанной единицей и суммой в рублях пропущены с причиной", () => {
    const text = [
      "№ п/п\tНаименование работ\tЕд. изм.\tКол-во",
      "1\tЗамена светильников\tшт\t24",
      "2\tПрокладка кабеля\tм\t310",
      "3\tМонтаж розеток\tшт\t18",
      "4\tШтраф за просрочку\tруб\t5000",
      "5\tРабота неведомой единицей\tфурибакс\t5",
      "6\tРабота без объёма\tм2\t",
    ].join("\n");
    const table = parseBillTables(text).tables[0];
    expect(table?.rows).toHaveLength(3);
    expect(table?.skipped.map((row) => row.reason)).toEqual(["MONEY_NOT_WORK", "UNKNOWN_UNIT", "BAD_QUANTITY"]);
  });
});

describe("parseTableNumber", () => {
  it("читает форматы чисел из документов", () => {
    expect(parseTableNumber("68,7")).toBe(68.7);
    expect(parseTableNumber("1 234,5")).toBe(1234.5);
    expect(parseTableNumber("1 234,5")).toBe(1234.5);
    expect(parseTableNumber("1234.5")).toBe(1234.5);
    expect(parseTableNumber("1.234,5")).toBe(1234.5);
    expect(parseTableNumber("1,234,567.5")).toBe(1234567.5);
    expect(parseTableNumber("12*")).toBe(12);
  });

  it("не число — null", () => {
    expect(parseTableNumber("по проекту")).toBeNull();
    expect(parseTableNumber("225*3")).toBeNull();
    expect(parseTableNumber("68 7")).toBeNull();
    expect(parseTableNumber("")).toBeNull();
  });
});

describe("readBillTables", () => {
  const base = { documentName: "ВОР.odt", idPrefix: "d1" };

  it("строит позиции с цитатой, документом, разделом, уровнем и примечанием", () => {
    const reading = readBillTables({ ...base, text: VOR_ODT, documentLevel: "BILL" });
    expect(reading?.items).toHaveLength(15);
    const first = reading?.items[0];
    expect(first).toMatchObject({
      workName: "Демонтаж оконных откосов",
      quantity: 68.7,
      quantityUnit: "м",
      unitDivisor: 1,
      normCode: null,
      sourceDocument: "ВОР.odt",
      billSection: "ул. Возрождения, д. 46",
      sourceLevel: "BILL",
      positionNumber: "1",
    });
    expect(first?.sourceQuote).toBe(
      "1\tДемонтаж оконных откосов\tмп/шт\t68,7/46\t*В целях доступа к профлисту. b = 300 мм",
    );
    expect(first?.remark).toContain("46 шт");
    expect(new Set(reading?.items.map((item) => item.id)).size).toBe(15);
  });

  it("таблица в документе-ТЗ получает уровень ТЗ, а не ведомости", () => {
    const reading = readBillTables({ ...base, text: VOR_ODT.replace("Ведомость объемов работ", "Таблица"), documentLevel: "SPEC" });
    expect(reading?.items[0]?.sourceLevel).toBe("SPEC");
  });

  it("таблицы смет кодом не читаются: их разбирают ЛСР и модель", () => {
    const text = VOR_ODT.replace("Ведомость объемов работ\n", "");
    expect(readBillTables({ ...base, text, documentLevel: "CUSTOMER_ESTIMATE" })).toBeNull();
    expect(readBillTables({ ...base, text, documentLevel: "CONTRACT_ESTIMATE" })).toBeNull();
  });

  it("без доверенной таблицы возвращает null", () => {
    expect(readBillTables({ ...base, text: "Просто текст ТЗ.", documentLevel: "SPEC" })).toBeNull();
  });

  it("обоснование из колонки даёт код ресурса и шифр расценки", () => {
    const text = [
      "Ведомость объёмов работ",
      "№ п/п\tОбоснование\tНаименование работ\tЕд. изм.\tКол-во",
      "1\tГЭСН09-03-002-01\tМонтаж металлоконструкций\tт\t5,2",
      "2\tФСБЦ-07.2.07.12-0068\tСталь С255\tт\t5,3",
      "3\tГЭСН15-04-006-01\tОкраска металлоконструкций\tм2\t64",
    ].join("\n");
    const items = readBillTables({ ...base, text, documentLevel: "BILL" })?.items ?? [];
    expect(items).toHaveLength(3);
    expect(items[0]?.normCodeHint?.code).toBe("09-03-002-01");
    expect(items[1]?.resourceCode).toBe("07.2.07.12-0068");
  });
});

describe("parseBillTables: число Excel в CSV", () => {
  it("«1,234» в строке CSV — тысяча двести тридцать четыре, «68,7» в табличном тексте — дробь", () => {
    const csv = [
      "№ п/п,Наименование,Ед. изм.,Кол-во,,,",
      "1,Демонтаж профлиста,м2,\"1,234\",,,",
      "2,Монтаж утеплителя,м2,56.5,,,",
      "3,Устройство кровли,м2,\"2,500\",,,",
    ].join("\n");
    const rows = parseBillTables(csv).tables.flatMap((table) => table.rows);
    expect(rows.map((row) => row.quantity)).toEqual([1234, 56.5, 2500]);
    const tab = ["№ п/п\tНаименование\tЕд. изм.\tКол-во", "1\tДемонтаж профлиста\tм2\t68,7", "2\tМонтаж\tм2\t1,234", "3\tРез\tмп\t59,3"].join("\n");
    expect(parseBillTables(tab).tables.flatMap((table) => table.rows).map((row) => row.quantity)).toEqual([68.7, 1.234, 59.3]);
  });
});

describe("parseBillTables: единица с множителем («100 м2») сохраняется", () => {
  /** Закупка 0302100011026000027: ведомость по ФСНБ, единица напечатана с множителем. */
  const rowsOf = (text: string) => parseBillTables(text).tables.flatMap((table) => table.rows);

  it("колонки через табуляцию: «100 м2» и 0,899 дают 89,9 м2 — напечатанное число на множитель, а не 0,899 м2", () => {
    const text = [
      "Ведомость объёмов работ",
      "№ п/п\tНаименование\tЕд. изм.\tКол-во",
      "1\tОклейка стен моющимися обоями\t100 м2\t0,899",
      "2\tОкраска стен водоэмульсионными составами\t100 м2\t0,4792",
      "3\tУстройство подвесных потолков\t100 м2\t0,28",
      "4\tУстройство оснований полов из фанеры\t100 м2\t0,583",
    ].join("\n");
    const rows = rowsOf(text);
    expect(rows.map((row) => row.unit)).toEqual(["м2", "м2", "м2", "м2"]);
    expect(rows.map((row) => row.quantity)).toEqual([89.9, 47.92, 28, 58.3].map((value) => expect.closeTo(value, 6)));
    // Под норму «100 м2» объём делится на сто и возвращается к напечатанному числу.
    expect(rows.map((row) => row.quantity / (deriveUnitDivisor(row.unit, "100 м2") as number))).toEqual([0.899, 0.4792, 0.28, 0.583].map((value) => expect.closeTo(value, 6)));
  });

  it("построчный текст PDF: «… 100 м2 0,899» в конце строки читается так же", () => {
    const text = [
      "Наименование Ед. изм. Кол-во",
      "1 Оклейка стен моющимися обоями: на … 100 м2 0,899",
      "2 Окраска … 100 м2 0,4792",
      "3 Устройство подвесных потолков … 100 м2 0,28",
      "4 Устройство оснований полов из фанеры … 100 м2 0,583",
    ].join("\n");
    const rows = rowsOf(text);
    expect(rows.map((row) => row.unit)).toEqual(["м2", "м2", "м2", "м2"]);
    expect(rows.map((row) => row.quantity)).toEqual([89.9, 47.92, 28, 58.3].map((value) => expect.closeTo(value, 6)));
  });

  it("негативный: «100 м2» в наименовании, а единица колонки — «м2»: множитель не применяется", () => {
    const text = [
      "№ п/п\tНаименование\tЕд. изм.\tКол-во",
      "1\tОкраска стен, расход на 100 м2 поверхности\tм2\t25",
      "2\tУстройство потолков\tм2\t12",
      "3\tУстройство полов\tм2\t30",
    ].join("\n");
    expect(rowsOf(text).map((row) => row.quantity)).toEqual([25, 12, 30]);
  });
});
