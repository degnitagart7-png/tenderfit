import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  codeOfJustification,
  extractIndexStatements,
  familyOfCode,
  headerTail,
  normalizeSplitYear,
  parseCoefficients,
  parseCustomerBim,
  parseRuNumber,
  type BimPosition,
  type CustomerBim,
} from "@/domain/estimate/customerBim";
import { parseCustomerLsr } from "@/domain/estimate/customerLsr";
import { REAL_A_WITH_TOTALS } from "@/domain/estimate/customerLsr.fixtures";

/*
  Разбор смет заказчика на БИМ проверяется на вырезках из двух реальных смет базы закупок (src/domain/estimate/__fixtures__/bim):
  - grid-nnk-*.txt — «Сметы в ПК Excel» (ПК Гранд-Смета, «Полный локальный сметный расчёт»), расценки ФЕР/ФЕРм/ФССЦ и корпоративные КОЕР в
    базисных ценах 2001 года; в ячейках шифра стоит «\r» перед «Приказ …», поэтому файлы читаются как есть, без перекодировки;
  - stream-tyumen.txt — «СД 2-этап»: PDF Гранд-Сметы (форма приложения 2 к 421/пр, «базисно-индексным методом», Тюменская область,
    III квартал 2025): пояснительная записка и две локальные сметы, колонки таблицы в тексте разложены вперемешку.
*/

const DIR = resolve("src/domain/estimate/__fixtures__/bim");
const read = (name: string): string => readFileSync(resolve(DIR, name), "utf8");

const parse = (name: string): readonly CustomerBim[] => parseCustomerBim([{ name, text: read(name) }]).estimates;
const pos = (estimate: CustomerBim, number: string): BimPosition => estimate.positions.find((position) => position.number === number) as BimPosition;

describe("шифры и коэффициенты", () => {
  it("шифр из обоснования: приказ слипается с шифром или отделён пробелом, слэшем и «\\r»", () => {
    expect(codeOfJustification("ФЕРм12-12-001-13\rПриказ Минстроя России от 26.12.2019 №876/пр")).toBe("ФЕРм12-12-001-13");
    expect(codeOfJustification("ФССЦ-23.3.03.02-0062 / Приказ Минстроя России от 26.12.2019 №876/пр")).toBe("ФССЦ-23.3.03.02-0062");
    expect(codeOfJustification("КОЕРр 08-01-001-08")).toBe("КОЕРр08-01-001-08");
    expect(codeOfJustification("ФЕР 26-01-049-02")).toBe("ФЕР26-01-049-02");
    expect(codeOfJustification("ТЦ_62.1.02.14_59_59028558 78_09.07.2025_01")).toBe("ТЦ_62.1.02.14_59_59028558 78_09.07.2025_01");
  });

  it("семейство: ФЕР с книгой, ТЕР, ТСН, материал и перевозка ФССЦ, цена заказчика, корпоративные расценки", () => {
    expect(familyOfCode("ФЕРм12-12-001-13")).toEqual({ family: "FER", book: "ФЕРм", rateCode: "12-12-001-13" });
    expect(familyOfCode("ФЕР26-01-049-02")).toEqual({ family: "FER", book: "ФЕР", rateCode: "26-01-049-02" });
    expect(familyOfCode("ФЕРр56-01-009-01")).toMatchObject({ book: "ФЕРр" });
    expect(familyOfCode("ТЕР01-01-001-01")).toEqual({ family: "TER", book: null, rateCode: "01-01-001-01" });
    expect(familyOfCode("ТЕРм08-01-001-01").family).toBe("TER");
    expect(familyOfCode("ТСН-2001.16").family).toBe("TSN");
    expect(familyOfCode("ФССЦ-18.1.02.01-0085")).toEqual({ family: "MATERIAL", book: null, rateCode: "18.1.02.01-0085" });
    expect(familyOfCode("ФССЦпг-01-01-01-045")).toEqual({ family: "TRANSPORT", book: null, rateCode: "01-01-01-045" });
    expect(familyOfCode("ТЦ_21.1.00.00_50_77027180").family).toBe("CUSTOMER_PRICE");
    expect(familyOfCode("По запросу").family).toBe("CUSTOMER_PRICE");
    expect(familyOfCode("КОЕРр08-01-001-08").family).toBe("OTHER");
    expect(familyOfCode("КССЦ-23.1.03.03-0000.0.00031").family).toBe("OTHER");
  });

  it("поправочные коэффициенты: перемножаются, «ПЗ» — ко всем элементам, «МАТ=0» обнуляет материалы; поправка без чисел — hasUnparsed", () => {
    const k = parseCoefficients(["Демонтаж трубопроводов ОЗП=0,6; ЭМ=0,6 к расх.; ЗПМ=0,6; МАТ=0 к расх.; ТЗ=0,6", "на уменьш. толщ. стенки ОЗП=0,96; ТЗ=0,96"]);
    expect(k.wage).toBeCloseTo(0.576, 6);
    expect(k.machines).toBe(0.6);
    expect(k.machinistWage).toBe(0.6);
    expect(k.materials).toBe(0);
    expect(k.hasUnparsed).toBe(false);
    const all = parseCoefficients(["Опускание ПЗ=0,9 (ОЗП=0,9; ЭМ=0,9 к расх.; ЗПМ=0,9; МАТ=0,9 к расх.)"]);
    expect([all.wage, all.machines, all.machinistWage, all.materials]).toEqual([0.9, 0.9, 0.9, 0.9]);
    const onlyAll = parseCoefficients(["Поправка ПЗ=0,8"]);
    expect([onlyAll.wage, onlyAll.machines, onlyAll.materials]).toEqual([0.8, 0.8, 0.8]);
    expect(parseCoefficients(["При работе на высоте применять коэффициент К = 1 + 0,04"]).hasUnparsed).toBe(true);
    expect(parseCoefficients(["Учтено К = 1 + 0,04"]).hasUnparsed).toBe(true);
    expect(parseCoefficients(["113,00 = 146,06 - 3,48 x 9,50"]).hasUnparsed).toBe(false);
    expect(parseCoefficients([]).wage).toBe(1);
  });

  it("числа с пробелами-тысячами и запятой; год, разорванный пробелом PDF", () => {
    expect(parseRuNumber("8 109,08")).toBe(8109.08);
    expect(parseRuNumber("0,945")).toBe(0.945);
    expect(parseRuNumber("1 578 541,25")).toBe(1578541.25);
    expect(parseRuNumber("шт")).toBeNull();
    expect(normalizeSplitYear("на 3 квартал 202 5 года")).toBe("на 3 квартал 2025 года");
    expect(normalizeSplitYear("от 29.0 8 .202 5 года")).toBe("от 29.08.2025 года");
  });

  it("хвост заголовка позиции: единица может кончаться цифрой и содержать число — границу даёт арифметика «объём × коэффициент = объём»", () => {
    expect(headerTail("шт 2 1 2 421/пр")).toMatchObject({ unit: "шт", quantity: 2, coefficient: 1, quantityTotal: 2 });
    expect(headerTail("100 м3 0,3 1 0,3 421/пр")).toMatchObject({ unit: "100 м3", quantity: 0.3 });
    expect(headerTail("1000 м3 30,16722 1 30,16722")).toMatchObject({ unit: "1000 м3", quantity: 30.16722 });
    expect(headerTail("1 т груза 0,19 1 0,19 17,95")).toMatchObject({ unit: "1 т груза", quantity: 0.19 });
    expect(headerTail("100 м 4,4 1 4,4")).toMatchObject({ unit: "100 м", quantity: 4.4 });
    expect(headerTail("м 2 1,35 2,7")).toMatchObject({ quantity: 2, coefficient: 1.35, quantityTotal: 2.7 });
    // арифметика не сходится — это не хвост заголовка
    expect(headerTail("шт 2 1 3")).toBeNull();
    expect(headerTail("в соответствии с пунктом 5 методики")).toBeNull();
  });
});

describe("таблица Гранд-Сметы (Excel), смета в базисных ценах 2001 года", () => {
  const estimates = parse("grid-nnk-dop.txt");
  const estimate = estimates[0] as CustomerBim;

  it("одна смета, формат таблицы, уровень цен базисный, шапка прочитана", () => {
    expect(estimates).toHaveLength(1);
    expect(estimate).toMatchObject({
      format: "GRID",
      number: "ЛС-8-641-Р-017.020.000-ТХ-01",
      priceLevel: "BASE",
      constructionName: 'АО "ННК", цех №17, отд.1702',
      workName: "Технологические трубопроводы., Сброс на факел с СППК",
      quarter: null,
      declaredBaseIndex: false,
      overheadNorms: null,
    });
    expect(estimate.positions.map((position) => position.number)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("расценка ФЕРм: шифр без приказа, единица, объём, цена за единицу по элементам и стоимость", () => {
    const first = pos(estimate, "1");
    expect(first).toMatchObject({ code: "ФЕРм12-12-001-13", family: "FER", book: "ФЕРм", rateCode: "12-12-001-13", unit: "шт", quantity: 1, section: "Монтажные работы" });
    expect(first.unitPrice).toEqual({ total: 232.3, wage: 68.3, machines: 154.55, machinistWage: 18.35, materials: 9.45 });
    expect(first.baseTotal).toEqual({ total: 232, wage: 68, machines: 155, machinistWage: 18, materials: 9 });
  });

  it("НР и СП: процент, база «от ФОТ» и сумма", () => {
    const first = pos(estimate, "1");
    expect(first.overhead).toEqual({ ref: null, percent: 90, basePercent: null, base: 112, amount: 101 });
    expect(first.profit).toEqual({ ref: null, percent: 46, basePercent: null, base: 112, amount: 52 });
    expect(pos(estimate, "8").overhead).toMatchObject({ percent: 89, base: 68, amount: 61 });
    expect(first.positionBaseTotal).toBe(385);
  });

  it("поставка ФССЦ: цена и стоимость в одной строке, НР и СП нет; корпоративные КОЕР — отдельное семейство", () => {
    const supply = pos(estimate, "2");
    expect(supply).toMatchObject({ code: "ФССЦ-18.1.02.01-0085", family: "MATERIAL", rateCode: "18.1.02.01-0085", unit: "шт", quantity: 1, overhead: null, profit: null });
    expect(supply.unitPrice.total).toBe(3472.3);
    expect(supply.baseTotal.total).toBe(3472);
    expect(pos(estimate, "3").unitPrice.total).toBe(3162.28);
    expect(pos(estimate, "4")).toMatchObject({ code: "КОЕРр08-01-001-08", family: "OTHER", rateCode: null });
  });

  it("итоги: прямые затраты в базисных ценах, с коэффициентами к итогам, НР, СП, всего по смете", () => {
    expect(estimate.directBase).toEqual({ total: 1857, wage: 815, machines: 528, machinistWage: 41, materials: null });
    expect(estimate.directWithTotalCoefficients).toMatchObject({ total: 1747, wage: 1061 });
    expect([estimate.overheadTotal, estimate.profitTotal, estimate.total]).toEqual([998, 507, 3252]);
  });

  it("индексов в смете нет: позиции без индексов, в тексте индексов не названо", () => {
    expect(estimate.positions.every((position) => position.indices === null && position.currentTotal === null)).toBe(true);
    expect(estimate.indexStatements).toEqual([]);
  });

  it("лист с формулами пересчёта цены: ФЕР26-01-049-02 и КОЕР — формула сохранена, поправка «ОЗП=1,1» разобрана", () => {
    const sheet = parse("grid-nnk-ti.txt")[0] as CustomerBim;
    expect(sheet.positions).toHaveLength(24);
    const covering = pos(sheet, "3");
    expect(covering).toMatchObject({ code: "ФЕР26-01-049-02", family: "FER", unit: "100 м2" });
    expect(covering.priceFormula).toBe("2 379,20 = 2 999,08 - 0,0017 x 33 180,00 - 0,01156 x 7 590,00 - 0,00047 x 11 200,00 - 0,04277 x 11 000,00");
    expect(covering.unitPrice).toMatchObject({ total: 2524.16, wage: 1594.52, machines: 929.64, machinistWage: 12.53 });
    expect(covering.coefficients.wage).toBe(1.1);
    expect(pos(sheet, "1").priceFormula).toBe("113,00 = 146,06 - 3,48 x 9,50");
    expect(pos(sheet, "16")).toMatchObject({ code: "ФЕР15-04-030-05", family: "FER" });
  });

  it("не форма 421/пр: смета БИМ не принимается за ресурсную, а ресурсная — за БИМ", () => {
    // Таблица БИМ в разборе формы 421/пр — «не распознана» (нет граф «индекс», «в текущем уровне цен»).
    const lsr = parseCustomerLsr([{ name: "grid-nnk-dop.txt", text: read("grid-nnk-dop.txt") }]);
    expect(lsr.estimates).toHaveLength(0);
    expect(lsr.notRecognized.length).toBeGreaterThan(0);
    // Ресурсная смета по ГЭСН форме 421/пр БИМ не является.
    expect(parseCustomerBim([{ name: "lsr.csv", text: REAL_A_WITH_TOTALS }]).estimates).toEqual([]);
  });
});

describe("ресурсно-индексная ЛСР формы 421/пр не принимается за БИМ", () => {
  const RIM = readFileSync(resolve("src/domain/estimate/__fixtures__/t1118/lsr-02-02-08.txt"), "utf8");
  // Гранд-Смета подчас печатает и у ресурсной сметы графы «Осн.З/п», «Эк.Маш»: одной шапки таблицы для БИМ мало.
  const WITH_BASE_HEADER = RIM.replace("\n1,2,3,", "\n,,,,,,,,Осн.З/п,Эк.Маш,З/пМех,,Осн.З/п,Эк.Маш,З/пМех,,\n1,2,3,");

  it("шапка «Составлен ресурсно-индексным методом», шифры ГЭСН/ФСБЦ: БИМ-смет нет, а ресурсная ЛСР читается", () => {
    expect(parseCustomerBim([{ name: "lsr-02-02-08.csv", text: RIM }]).estimates).toEqual([]);
    expect(parseCustomerLsr([{ name: "lsr-02-02-08.csv", text: RIM }]).estimates).toHaveLength(1);
  });

  it("графы «Осн.З/п» в шапке ресурсной сметы не делают её БИМ: решают метод в шапке и шифры", () => {
    expect(WITH_BASE_HEADER).not.toBe(RIM);
    expect(parseCustomerBim([{ name: "lsr.csv", text: WITH_BASE_HEADER }]).estimates).toEqual([]);
    // Слов о методе нет, остались шифры ГЭСН — ресурсный метод.
    const noWords = WITH_BASE_HEADER.replace("ресурсно-индексным,методом", "");
    expect(noWords).not.toBe(WITH_BASE_HEADER);
    expect(parseCustomerBim([{ name: "lsr.csv", text: noWords }]).estimates).toEqual([]);
  });

  it("явное «базисно-индексным» в шапке БИМ-сметы по-прежнему принимается; расценки ФЕР без слов — тоже", () => {
    expect(parse("grid-nnk-dop.txt").length).toBeGreaterThan(0);
    expect(parse("grid-nnk-ti.txt").length).toBeGreaterThan(0);
    expect(parse("stream-tyumen.txt").length).toBe(2);
  });
});

describe("поток текста PDF Гранд-Сметы (СД 2-этап, БИМ, Тюменская область, III кв. 2025)", () => {
  const estimates = parse("stream-tyumen.txt");
  const first = estimates[0] as CustomerBim;
  const second = estimates[1] as CustomerBim;

  it("две локальные сметы: номер, название работ и стройки, субъект, метод и нормативы НР/СП названы в смете", () => {
    expect(estimates.map((estimate) => estimate.number)).toEqual(["02-01-04", "02-02-04"]);
    expect(first).toMatchObject({
      format: "STREAM",
      priceLevel: "CURRENT",
      subjectText: "Тюменская область",
      workName: "Автоматизация комплексная-1",
      declaredBaseIndex: true,
      overheadNorms: "812_774",
    });
    expect(first.constructionName).toContain("Реконструкция ПС 110/10кВ Молчаново");
  });

  it("шапка: стоимость в текущих и базисных ценах, СМР отдельно от оборудования", () => {
    expect([first.total, first.totalBase, first.smrTotal, first.smrTotalBase, first.equipmentTotal]).toEqual([3844750, 512650, 362950, 8770, 3481800]);
    expect([second.total, second.smrTotal, second.equipmentTotal]).toEqual([105490, 105490, 0]);
  });

  it("квартал цен и ссылки на письма — из пояснительной записки соседнего файла", () => {
    expect(first.quarter).toEqual({ quarter: 3, year: 2025 });
    expect(first.quarterSource).toBe("TEXT");
    const letters = first.indexStatements.filter((statement) => statement.kind === "LETTER");
    expect(letters.map((statement) => [statement.letterNumber, statement.letterDate])).toEqual(
      expect.arrayContaining([
        ["51464-ИФ/09", "2025-08-29"],
        ["45276-ИФ/09", "2025-08-01"],
        ["41280-ИФ/09", "2025-07-16"],
      ]),
    );
    const elements = first.indexStatements.filter((statement) => statement.kind === "ELEMENT");
    expect(elements.map((statement) => [statement.element, statement.value])).toEqual(
      expect.arrayContaining([
        ["MATERIALS", 20.69],
        ["MACHINES", 20.69],
        ["MATERIALS", 18],
      ]),
    );
  });

  it("расценка ФЕРм10-04-067-10: цена, коэффициент, итого в базисных, индекс и итого в текущих по четырём группам затрат", () => {
    const p = pos(first, "1");
    expect(p).toMatchObject({ code: "ФЕРм10-04-067-10", family: "FER", book: "ФЕРм", rateCode: "10-04-067-10", unit: "шт", quantity: 2 });
    expect(p.unitPrice).toMatchObject({ wage: 711.88, machines: 3.6, machinistWage: 0.4, materials: 181.59 });
    expect(p.coefficients).toMatchObject({ wage: 1.35, machines: 1.35, machinistWage: 1.35, materials: 1 });
    expect(p.baseTotal).toMatchObject({ wage: 1922.08, machines: 9.72, machinistWage: 1.08, materials: 363.18 });
    expect(p.indices).toEqual({ labour: 58.09, machines: 14.94, machinistLabour: 58.09, materials: 9.39 });
    expect(p.currentTotal).toMatchObject({ wage: 111653.63, machines: 145.22, machinistWage: 62.74, materials: 3410.26 });
    // сходится арифметика: цена × коэффициент × объём = итого, итого × индекс = в текущих
    expect(p.unitPrice.wage! * 1.35 * 2).toBeCloseTo(p.baseTotal.wage!, 1);
    expect(p.baseTotal.wage! * 58.09).toBeCloseTo(p.currentTotal!.wage!, 0);
  });

  it("НР и СП: указатели приказов, проценты и суммы; «Всего по позиции» в базисных и текущих ценах", () => {
    const p = pos(first, "1");
    expect(p.overhead).toEqual({ ref: "Пр/812-051.2-1", percent: 95, basePercent: 95, base: null, amount: 1827 });
    expect(p.profit).toMatchObject({ ref: "Пр/774-051.2", percent: 53, amount: 1019.27 });
    expect([p.positionBaseTotal, p.positionCurrentTotal]).toEqual([5141.25, 280549.34]);
    // итог позиции в текущих = ОЗП + ЭМ + М (ОТм входит в ЭМ) + (НР + СП) × индекс оплаты труда
    const current = 111653.63 + 145.22 + 3410.26 + (1827 + 1019.27) * 58.09;
    expect(p.positionCurrentTotal!).toBeCloseTo(current, 0);
  });

  it("позиции перевозки и поставки с индексом статьи; цены заказчика («ТЦ_») числа не дают — это названо пробелом, а не нулём", () => {
    const material = pos(first, "6.1");
    expect(material).toMatchObject({ code: "ФССЦ-21.1.06.09-0152", family: "MATERIAL", unit: "1000 м", quantity: 0.16 });
    expect(material.unitPrice.total).toBe(6920.41);
    expect(material.baseTotal.total).toBe(1107.27);
    expect(material.indices?.materials).toBe(9.39);
    expect(material.positionCurrentTotal).toBe(10397.27);
    const customerPrice = pos(first, "6.2");
    expect(customerPrice.family).toBe("CUSTOMER_PRICE");
    expect(customerPrice.positionCurrentTotal).toBeNull();
    expect(customerPrice.gaps.length).toBeGreaterThan(0);
  });

  it("позиция без работ рабочих: индекс оплаты труда берётся у «в т. ч. ОТм», а группа без графы коэффициента читается", () => {
    const p = pos(second, "1");
    expect(p).toMatchObject({ code: "ФЕРм08-02-158-04", quantity: 14 });
    expect(p.indices).toMatchObject({ labour: 58.09, machines: null, materials: 9.39 });
    expect(p.positionCurrentTotal).toBe(6131.2);
  });

  it("числа не перепутаны между соседними позициями: у каждой позиции своя цепочка групп (позиции с одинаковой расценкой и разным объёмом)", () => {
    const p6 = pos(first, "6");
    const p2 = pos(second, "2");
    expect(p6.code).toBe(p2.code);
    expect(p6.quantity).toBe(2.744);
    expect(p2.quantity).toBe(2.1568627);
    expect(p6.baseTotal.wage).toBe(323.13);
    expect(p2.baseTotal.wage).toBe(253.99);
  });

  it("извлечение индексов из текста: письмо, квартал, значения по элементам, индекс на итог", () => {
    const statements = extractIndexStatements(
      "Письмо Минстроя России от 29.0 8 .202 5 года № 51 464 - ИФ/09, прил.6 (Автомобили бортовые) МАТ – 20,69; ЭММ – 20,69; индекс на 3 квартал 202 5 года; К=13,75; коэффициент ОЗП=1,2",
    );
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "LETTER", letterNumber: "51464-ИФ/09", letterDate: "2025-08-29" }),
        expect.objectContaining({ kind: "QUARTER", quarter: { quarter: 3, year: 2025 } }),
        expect.objectContaining({ kind: "ELEMENT", element: "MATERIALS", value: 20.69 }),
        expect.objectContaining({ kind: "ELEMENT", element: "MACHINES", value: 20.69 }),
        expect.objectContaining({ kind: "TOTAL", value: 13.75 }),
      ]),
    );
    // «ОЗП=1,2» — поправочный коэффициент строки сметы, а не индекс пересчёта
    expect(statements.some((statement) => statement.kind === "ELEMENT" && statement.value === 1.2)).toBe(false);
  });
});
