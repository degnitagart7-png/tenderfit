import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeSectionTitle,
  parseCustomerEstimates,
  sectionAt,
  sectionHeadings,
} from "@/domain/estimate/customerEstimate";

/*
  Образцы строк из prod (tender_documents): xlsx превращён в CSV через
  XLSX.utils.sheet_to_csv, каждый лист предваряется «=== имя ===». Длинные хвосты
  запятых в образцах сокращены «…» — как они и лежат в файле образцов.
*/

const SAMPLE_A = `=== 701-702 - ЛСР по Методике 2020  ===
Составлен(а) в текущем уровне цен ,,01.04.2026,,,,…,01.04.2026,,,…
,,,,,,,,на единицу измерения,коэффициенты,всего с учетом коэффициентов,на единицу измерения в базисном уровне цен,индекс,на единицу измерения в текущем уровне цен,коэффициенты,всего в текущем уровне цен,,,…
Раздел 1. Демонтажные работы,,,,,,…,Раздел 1. Демонтажные работы,,,,…
,,  Итого по разделу 1 Демонтажные работы,,,,,,,,,,,,,"204,011.54",,,,…,  Итого по разделу 1 Демонтажные работы,,,,…
Раздел 2. Ремонтные работы,,,,…,Раздел 2. Ремонтные работы,,,…
,,  Итого по разделу 2 Ремонтные работы,,,,,,,,,,,,,"1,245,903.10",,,…,  Итого по разделу 2 Ремонтные работы,,,…
Раздел 3. СКС,,,…,Раздел 3. СКС,,,…
,,  Итого по разделу 3 СКС,,,,,,,,,,,,,"220,964.92",,,…,  Итого по разделу 3 СКС,,,…
Раздел 4. Электромонтажные работы,,,…
,,  Итого по разделу 4 Электромонтажные работы,,,,,,,,,,,,,"396,373.35",,,…
Раздел 5. ПНР,,,…
,,  Итого по разделу 5 ПНР,,,,,,,,,,,,,"20,887.54",,,…
Раздел 6. Погрузка и вывоз мусора,,,…
,,  Итого по разделу 6 Погрузка и вывоз мусора,,,,,,,,,,,,,"2,029.24",,,…
,,ВСЕГО по смете,,,,,,,,,,,,,"2,550,007.02",,,…,ВСЕГО по смете,,,…`;

const SAMPLE_B = `=== Сметы в ПК Excel ремонт СППК +ШУФ на ННК (2)/8-641-ТХ по КОЕР доп.-С - Полный локальный сметный расчёт.xlsx ===
=== 8-641-ТХ по КОЕР доп.-С - Полны ===
Раздел 1. Монтажные работы,,,…,Раздел 1. Монтажные работы,,,,,,
  ВСЕГО по смете,,,,,,,,,,,"3,252.00",,,,,96.19,,3.96,,,…,  ВСЕГО по смете
=== Сметы в ПК Excel ремонт СППК +ШУФ на ННК (2)/8-641-ТХ по КОЕР изм.1-С - Полный локальный сметный расчёт.xlsx ===
=== 8-641-ТХ по КОЕР изм.1-С - Полн ===
"Раздел 1. Демонтажные работы на высоте +6,5м",,,…,"Раздел 1. Демонтажные работы на высоте +6,5м",,,
"Итого по разделу 1 Демонтажные работы на высоте +6,5м",,,,,,,,,,,"6,169.00",,,,,140.25,,40.39,,,…,"Итого по разделу 1 Демонтажные работы на высоте +6,5м",,,
Раздел 2. Монтажные работы,,,…
Итого по разделу 2 Монтажные работы,,,,,,,,,,,"67,491.00",,,,,1799.55,,152.38,,,…,Итого по разделу 2 Монтажные работы,,,
Раздел 3. Оборудование,,,…
Раздел 4. АКЗ,,,…
Итого по разделу 4 АКЗ,,,,,,,,,,,"5,439.00",,,,,112.55,,27.15,,,…,Итого по разделу 4 АКЗ,,,
Раздел 5. Изготовление гибов,,,…
Итого по разделу 5 Изготовление гибов,,,,,,,,,,,248.00,,,,,1.35,,,,…,Итого по разделу 5 Изготовление гибов,,,
Раздел 6. Погрузо-разгрузочные работы,,,…
Итого по разделу 6 Погрузо-разгрузочные работы,,,,,,,,,,,20.00,,,,…
Раздел 7. Перевозка,,,…
Итого по разделу 7 Перевозка,,,,,,,,,,,8.00,,,,…
"          Итого по разделу 1 Демонтажные работы на высоте +6,5м",,,,,,,,,,,"6,169.00",,,,,140.25,,40.39,,,…
          Итого по разделу 2 Монтажные работы,,,,,,,,,,,"67,491.00",,,,,1799.55,,152.38,,,…
          Итого по разделу 4 АКЗ,,,,,,,,,,,"5,439.00",,,,,112.55,,27.15,,,…
          Итого по разделу 5 Изготовление гибов,,,,,,,,,,,248.00,,,,,1.35,,,…
          Итого по разделу 6 Погрузо-разгрузочные работы,,,,,,,,,,,20.00,,,…
          Итого по разделу 7 Перевозка,,,,,,,,,,,8.00,,,…
  ВСЕГО по смете,,,,,,,,,,,"79,375.00",,,,,2053.7,,219.92,,,…,  ВСЕГО по смете
=== Сметы в ПК Excel ремонт СППК +ШУФ на ННК (2)/ЛС-545-26-1КР-С - Полный локальный сметный расчёт.xlsx ===
=== ЛС-545-26-1КР-С - Полный локал ===
Раздел 1. Новый раздел,,,…
Итого по разделу 1 Новый раздел,,,,,,,,,,,"49,017.00",,,,,1270.1,,126.2,,,…
Раздел 2. Изготовление м/к,,,…
Итого по разделу 2 Изготовление м/к,,,,,,,,,,,"20,878.00",,,,,718.98,,26.36,,,…
Раздел 3. Автомобильные перевозки,,,…
Итого по разделу 3 Автомобильные перевозки,,,,,,,,,,,13.00,,,…
  ВСЕГО по смете,,,,,,,,,,,"69,908.00",,,,,1989.08,,152.56,,,…`;

const SAMPLE_C = `=== геодезия- ===
Составлена в уровне цен III кв. 2026 г. ,,,,,,,,,,,,,
,Итого по разделу I,,,,,,,,,"1,870,569.01",,,
,Итого по разделу II,,,,,,,,,0.00,,,
,Итого по разделу III,,,,,,,,,"68,358.26",,,
,Итого по разделу IV,,,,,,,,,"14,395.82",,,
5,Итого по смете:,,,,,,,,,"1,953,323.09",,,
7,Всего по смете:,,,,,,,,,"2,480,720.32",,,
Всего по смете (руб.):,,,,,"2,480,720.32",,,,,,,,
=== обследование моста ===
11,Итого по смете:,,,,,,,"401,102.41",,
12,Всего по смете:,,,,,,,"401,102.41",,`;

const SAMPLE_D = `Раздел 1. Земляные работы и фундаменты;;;;;;;;;;;
;;Итого по разделу Раздел 1. Земляные работы и фундаменты;;;;;;;;;677387,10
;;Всего по смете;;;;;;;;;9343187,21
;;Всего с НДС;;;;;;;;;11211824,65`;

const doc = (name: string, text: string) => ({ name, text });

describe("normalizeSectionTitle", () => {
  it("снимает регистр, ё, префикс «Раздел N.», нумерацию, кавычки и пунктуацию", () => {
    expect(normalizeSectionTitle("Раздел 1. Демонтажные работы")).toBe("демонтажные работы");
    expect(normalizeSectionTitle("РАЗДЕЛ II: «Ремонтные  работы»")).toBe("ремонтные работы");
    expect(normalizeSectionTitle("3. Отделка, ёлки")).toBe("отделка елки");
    expect(normalizeSectionTitle("Демонтажные работы на высоте +6,5м")).toBe("демонтажные работы на высоте 6 5м");
  });

  it("«Раздел I» без названия не сворачивается в пустую строку", () => {
    expect(normalizeSectionTitle("Раздел I")).toBe("раздел i");
  });
});

describe("sectionHeadings / sectionAt", () => {
  it("находит заголовки, в том числе в кавычках первой ячейки, и не считает «Итого по разделу» заголовком", () => {
    const headings = sectionHeadings(SAMPLE_B);

    expect(headings.map((h) => [h.number, h.title])).toEqual([
      ["1", "Монтажные работы"],
      ["1", "Демонтажные работы на высоте +6,5м"],
      ["2", "Монтажные работы"],
      ["3", "Оборудование"],
      ["4", "АКЗ"],
      ["5", "Изготовление гибов"],
      ["6", "Погрузо-разгрузочные работы"],
      ["7", "Перевозка"],
      ["1", "Новый раздел"],
      ["2", "Изготовление м/к"],
      ["3", "Автомобильные перевозки"],
    ]);
  });

  it("estimateName — ближайший предыдущий заголовок «=== … ===», иначе null", () => {
    const headings = sectionHeadings(`Раздел 1. До листа\n${SAMPLE_A}`);
    expect(headings[0]?.estimateName).toBeNull();
    expect(headings[1]?.estimateName).toBe("701-702 - ЛСР по Методике 2020");
    const b = sectionHeadings(SAMPLE_B);
    expect(b[1]?.estimateName).toBe("8-641-ТХ по КОЕР изм.1-С - Полн");
  });

  it("римские номера и заголовок без названия", () => {
    const headings = sectionHeadings("Раздел II\nРаздел IV. Электроснабжение\nРаздел 3 настоящей документации устанавливает порядок");
    expect(headings.map((h) => [h.number, h.title])).toEqual([
      ["II", "Раздел II"],
      ["IV", "Электроснабжение"],
    ]);
  });

  it("заголовок плоского текста (PDF)", () => {
    const headings = sectionHeadings("Локальный сметный расчет\nРаздел 2. Монтаж оборудования\nтекст");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.title).toBe("Монтаж оборудования");
  });

  it("sectionAt: последний заголовок с offset не больше данного", () => {
    const text = "Раздел 1. Первый\nстрока а\nРаздел 2. Второй\nстрока б\n";
    const headings = sectionHeadings(text);

    expect(sectionAt(headings, text.indexOf("строка а"))?.title).toBe("Первый");
    expect(sectionAt(headings, text.indexOf("строка б"))?.title).toBe("Второй");
    expect(sectionAt(headings, 0)?.title).toBe("Первый");
    expect(sectionAt(headings, headings[1]!.offset)?.title).toBe("Второй");
  });

  it("sectionAt: до первого заголовка — null", () => {
    const text = "Шапка документа\nРаздел 1. Первый\nстрока\n";
    expect(sectionAt(sectionHeadings(text), 3)).toBeNull();
    expect(sectionAt([], 10)).toBeNull();
  });

  it("sectionAt: после строки «ВСЕГО по смете» позиция уже вне сметы", () => {
    const text = "Раздел 1. Первый\nстрока внутри\nВСЕГО по смете;;;;;100,00\nпосле итога\n";
    const headings = sectionHeadings(text);

    expect(sectionAt(headings, text.indexOf("строка внутри"))?.title).toBe("Первый");
    expect(sectionAt(headings, text.indexOf("после итога"))).toBeNull();
  });

  it("sectionAt: «Итого по разделу» не выводит позицию из раздела", () => {
    const text = "Раздел 1. Первый\nИтого по разделу 1 Первый;;;;;100,00\nещё строка\n";
    expect(sectionAt(sectionHeadings(text), text.indexOf("ещё строка"))?.title).toBe("Первый");
  });

  it("sectionAt: новый лист обрывает действие заголовка предыдущего", () => {
    const text = "=== лист 1 ===\nРаздел 1. Первый\n=== лист 2 ===\nстрока листа 2\nРаздел 1. Другой\nстрока\n";
    const headings = sectionHeadings(text);

    expect(sectionAt(headings, text.indexOf("строка листа 2"))).toBeNull();
    expect(sectionAt(headings, text.lastIndexOf("строка"))?.title).toBe("Другой");
  });
});

describe("parseCustomerEstimates: образец A (Методика 2020, итог с НДС)", () => {
  const [estimate, ...rest] = parseCustomerEstimates([doc("Локальный сметный расчет.xlsx", SAMPLE_A)]);

  it("шесть разделов, суммы из колонки «всего в текущем уровне цен»", () => {
    expect(rest).toHaveLength(0);
    expect(estimate!.sections.map((s) => [s.number, s.title, s.amount])).toEqual([
      ["1", "Демонтажные работы", 204_011.54],
      ["2", "Ремонтные работы", 1_245_903.1],
      ["3", "СКС", 220_964.92],
      ["4", "Электромонтажные работы", 396_373.35],
      ["5", "ПНР", 20_887.54],
      ["6", "Погрузка и вывоз мусора", 2_029.24],
    ]);
    expect(estimate!.sectionsTotal).toBe(2_090_169.69);
  });

  it("«ВСЕГО по смете» = сумма разделов × 1,22: итог с НДС, сверка сошлась", () => {
    expect(estimate!.statedTotal).toBe(2_550_007.02);
    expect(estimate!.totalIncludesVat).toBe(true);
    expect(estimate!.checked).toBe(true);
  });

  it("название листа, метод и уровень цен", () => {
    expect(estimate!.estimateName).toBe("701-702 - ЛСР по Методике 2020");
    expect(estimate!.documentName).toBe("Локальный сметный расчет.xlsx");
    expect(estimate!.method).toBe("RESOURCE_2022");
    expect(estimate!.priceLevel).toEqual({ zone: null, quarter: null, year: null });
  });

  it("цитата — строка итога без повтора метки в хвосте", () => {
    expect(estimate!.sections[0]!.quote).toBe("Итого по разделу 1 Демонтажные работы; 204,011.54");
  });
});

describe("parseCustomerEstimates: образец B (архив из трёх смет)", () => {
  const estimates = parseCustomerEstimates([doc("Сметы_в_ПК_Excel.zip", SAMPLE_B)]);

  it("три сметы", () => {
    expect(estimates).toHaveLength(3);
    expect(estimates.map((e) => e.statedTotal)).toEqual([3_252, 79_375, 69_908]);
  });

  it("смета без собственных итогов разделов возвращается без разделов, с итогом", () => {
    expect(estimates[0]!.sections).toEqual([]);
    expect(estimates[0]!.sectionsTotal).toBe(0);
    expect(estimates[0]!.checked).toBe(false);
  });

  it("сводка в конце сметы не задваивает разделы; раздел 3 без итога пропущен", () => {
    const second = estimates[1]!;
    expect(second.sections.map((s) => [s.number, s.title, s.amount])).toEqual([
      ["1", "Демонтажные работы на высоте +6,5м", 6_169],
      ["2", "Монтажные работы", 67_491],
      ["4", "АКЗ", 5_439],
      ["5", "Изготовление гибов", 248],
      ["6", "Погрузо-разгрузочные работы", 20],
      ["7", "Перевозка", 8],
    ]);
    expect(second.sectionsTotal).toBe(79_375);
  });

  it("выбрана первая колонка: трудозатраты тоже «сходятся», но идут позже", () => {
    const second = estimates[1]!;
    expect(second.checked).toBe(true);
    expect(second.statedTotal).toBe(79_375);
    expect(second.totalIncludesVat).toBe(false);
    // 140,25 + 1799,55 + 112,55 + 1,35 = 2053,7 — вторая колонка сошлась бы тоже.
    expect(second.sections[0]!.amount).toBe(6_169);
  });

  it("третья смета: сумма разделов 69 908 сходится с итогом", () => {
    const third = estimates[2]!;
    expect(third.sections.map((s) => s.amount)).toEqual([49_017, 20_878, 13]);
    expect(third.checked).toBe(true);
  });

  it("название листа привязано к смете", () => {
    expect(estimates[1]!.estimateName).toBe("8-641-ТХ по КОЕР изм.1-С - Полн");
    expect(estimates[2]!.estimateName).toBe("ЛС-545-26-1КР-С - Полный локал");
  });
});

describe("parseCustomerEstimates: образец C (римские номера, «Итого»/«Всего» по смете)", () => {
  const estimates = parseCustomerEstimates([doc("Обоснование НМЦК.xlsx", SAMPLE_C)]);

  it("римские номера без названий — «Раздел I»", () => {
    const first = estimates[0]!;
    expect(first.sections.map((s) => [s.number, s.title, s.amount])).toEqual([
      ["I", "Раздел I", 1_870_569.01],
      ["II", "Раздел II", 0],
      ["III", "Раздел III", 68_358.26],
      ["IV", "Раздел IV", 14_395.82],
    ]);
  });

  it("«Итого по смете» сходится с разделами, «Всего по смете» — лишь кандидат", () => {
    const first = estimates[0]!;
    expect(first.sectionsTotal).toBe(1_953_323.09);
    expect(first.statedTotal).toBe(1_953_323.09);
    expect(first.totalIncludesVat).toBe(false);
    expect(first.checked).toBe(true);
  });

  it("второй лист — отдельная смета без разделов, не кандидат первой", () => {
    expect(estimates).toHaveLength(2);
    expect(estimates[1]!.estimateName).toBe("обследование моста");
    expect(estimates[1]!.sections).toEqual([]);
    expect(estimates[1]!.statedTotal).toBe(401_102.41);
  });

  it("уровень цен читается из шапки листа", () => {
    expect(estimates[0]!.priceLevel).toEqual({ zone: null, quarter: 3, year: 2026 });
  });

  it("название раздела берётся из заголовка с тем же номером, если он есть", () => {
    const text = `Раздел I. Геодезические работы
,Итого по разделу I,,,,"100.00"
Раздел II. Камеральные работы
,Итого по разделу II,,,,"50.00"
,Итого по смете:,,,,"150.00"`;
    const [estimate] = parseCustomerEstimates([doc("c.xlsx", text)]);
    expect(estimate!.sections.map((s) => s.title)).toEqual(["Геодезические работы", "Камеральные работы"]);
    expect(estimate!.checked).toBe(true);
  });
});

describe("parseCustomerEstimates: образец D (наш экспорт, «;» и запятая — десятичная)", () => {
  const [estimate] = parseCustomerEstimates([doc("lsr.csv", SAMPLE_D)]);

  it("«Итого по разделу Раздел 1. Название»: номер и название разобраны, число с запятой", () => {
    expect(estimate!.sections).toHaveLength(1);
    expect(estimate!.sections[0]).toMatchObject({
      number: "1",
      title: "Земляные работы и фундаменты",
      amount: 677_387.1,
    });
  });

  it("«Всего по смете» — итог; «Всего с НДС» — кандидат; сверки с одним разделом нет", () => {
    expect(estimate!.statedTotal).toBe(9_343_187.21);
    expect(estimate!.checked).toBe(false);
    expect(estimate!.totalIncludesVat).toBeNull();
  });

  it("весь наш экспорт сходится: разделы = итог, «Всего с НДС» не ломает сверку", () => {
    const path = join(process.cwd(), "docs/samples/estimate-601801-drsks-lsr.csv");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return; // образца нет в сборке — проверка пропускается
    }
    const [full] = parseCustomerEstimates([doc("lsr.csv", text)]);

    expect(full!.sections).toHaveLength(4);
    expect(full!.sectionsTotal).toBe(9_343_187.21);
    expect(full!.statedTotal).toBe(9_343_187.21);
    expect(full!.totalIncludesVat).toBe(false);
    expect(full!.checked).toBe(true);
    expect(full!.method).toBe("RESOURCE_2022");
    expect(full!.priceLevel.zone).toBe(1);
  });
});

describe("parseCustomerEstimates: плоский текст (PDF), best effort", () => {
  it("деньги с пробелами тысяч и запятой, номер раздела не принимается за сумму", () => {
    const text = `Локальный сметный расчет
Раздел 1. Монтаж
Итого по разделу 1 Монтаж 1 747 822,05 12,5
Раздел 2. Пусконаладка
Итого по разделу 2 Пусконаладка 502 177,95
Итого по смете: 2 250 000,00`;
    const [estimate] = parseCustomerEstimates([doc("лср.pdf", text)]);

    expect(estimate!.sections.map((s) => [s.number, s.title, s.amount])).toEqual([
      ["1", "Монтаж", 1_747_822.05],
      ["2", "Пусконаладка", 502_177.95],
    ]);
    expect(estimate!.statedTotal).toBe(2_250_000);
    expect(estimate!.checked).toBe(true);
  });

  it("целые числа без копеек в плоском тексте не считаются деньгами", () => {
    const text = "Итого по разделу 3 Монтаж 12 слов 2,5\nИтого по смете: 100";
    expect(parseCustomerEstimates([doc("лср.pdf", text)])).toEqual([]);
  });

  it("запятые в обычной фразе не превращают строку в таблицу", () => {
    const text = "Итого по разделу 1 Монтаж, наладка, пуск, сдача, приёмка 1 234,56\nИтого по смете: 1 234,56";
    const [estimate] = parseCustomerEstimates([doc("лср.pdf", text)]);
    expect(estimate!.sections[0]!.amount).toBe(1234.56);
    expect(estimate!.sections[0]!.title).toBe("Монтаж, наладка, пуск, сдача, приёмка");
  });
});

describe("parseCustomerEstimates: сверка, НДС, метод, дубли", () => {
  it("итог с НДС 20 % тоже принимается", () => {
    const text = `Раздел 1. А,,,,,,
Итого по разделу 1 А,,,,,"1,000.00"
Раздел 2. Б,,,,,,
Итого по разделу 2 Б,,,,,"500.00"
Всего по смете,,,,,"1,800.00"`;
    const [estimate] = parseCustomerEstimates([doc("x.xlsx", text)]);
    expect(estimate!.checked).toBe(true);
    expect(estimate!.totalIncludesVat).toBe(true);
  });

  it("допуск сверки: рубль или 0,1 % итога", () => {
    const make = (total: string) =>
      parseCustomerEstimates([
        doc("x.xlsx", `Итого по разделу 1 А,,,,,"1,000,000.00"\nИтого по смете,,,,,"${total}"`),
      ])[0]!;
    expect(make("1,000,900.00").checked).toBe(true);
    expect(make("1,001,200.00").checked).toBe(false);
  });

  it("несошедшаяся сверка: checked=false, берётся первая колонка и первый итог", () => {
    const text = `Раздел 1. А,,,,,,
Итого по разделу 1 А,,,,,"1,000.00",5.00
Раздел 2. Б,,,,,,
Итого по разделу 2 Б,,,,,"500.00",7.00
Итого по смете,,,,,"9,999.00"`;
    const [estimate] = parseCustomerEstimates([doc("x.xlsx", text)]);

    expect(estimate!.checked).toBe(false);
    expect(estimate!.totalIncludesVat).toBeNull();
    expect(estimate!.statedTotal).toBe(9_999);
    expect(estimate!.sections.map((s) => s.amount)).toEqual([1000, 500]);
    expect(estimate!.sectionsTotal).toBe(1500);
  });

  it("смета без итога, но с итогами разделов, возвращается без итога и без сверки", () => {
    const [estimate] = parseCustomerEstimates([
      doc("x.xlsx", "Раздел 1. А\nИтого по разделу 1 А,,,,,\"1,000.00\""),
    ]);

    expect(estimate!.sections.map((s) => s.amount)).toEqual([1000]);
    expect(estimate!.statedTotal).toBeNull();
    expect(estimate!.totalIncludesVat).toBeNull();
    expect(estimate!.checked).toBe(false);
  });

  it("заголовки без итогов разделов и без итога сметы — это не смета", () => {
    expect(parseCustomerEstimates([doc("x.xlsx", "Раздел 1. А,,,,,,\nРаздел 2. Б,,,,,,")])).toEqual([]);
  });

  it("одна смета дважды — PDF и xlsx — считается одной; первая остаётся", () => {
    const pdf = `Раздел 1. Монтаж
Итого по разделу 1 Монтаж 1 000,00
Раздел 2. Наладка
Итого по разделу 2 Наладка 500,00
Итого по смете: 1 500,00`;
    const xlsx = `Раздел 1. Монтаж,,,,,,
Итого по разделу 1 Монтаж,,,,,"1,000.00"
Раздел 2. Наладка,,,,,,
Итого по разделу 2 Наладка,,,,,"500.00"
Итого по смете,,,,,"1,500.00"`;
    const estimates = parseCustomerEstimates([doc("смета.pdf", pdf), doc("смета.xlsx", xlsx)]);

    expect(estimates).toHaveLength(1);
    expect(estimates[0]!.documentName).toBe("смета.pdf");
  });

  it("две сметы с одинаковыми суммами внутри одного документа остаются двумя", () => {
    const sheet = (name: string) => `=== ${name} ===
Итого по разделу 1 Монтаж,,,,,"1,000.00"
Итого по смете,,,,,"1,000.00"`;
    expect(parseCustomerEstimates([doc("архив", `${sheet("а")}\n${sheet("б")}`)])).toHaveLength(2);
  });

  it("базисные цены 2001 г.", () => {
    const text = `Составлена в базисных ценах 2001 г.
Итого по разделу 1 Монтаж,,,,,"1,000.00"
Итого по смете,,,,,"1,000.00"`;
    expect(parseCustomerEstimates([doc("x.xlsx", text)])[0]!.method).toBe("BASE_2001");

    const ter = `ТЕР01-01-001-01 Разработка грунта\nИтого по разделу 1 Монтаж,,,,,"1,000.00"\nИтого по смете,,,,,"1,000.00"`;
    expect(parseCustomerEstimates([doc("x.xlsx", ter)])[0]!.method).toBe("BASE_2001");

    const fer = `ФЕР15-04-001-01 Окраска\nИтого по разделу 1 Монтаж,,,,,"1,000.00"\nИтого по смете,,,,,"1,000.00"`;
    expect(parseCustomerEstimates([doc("x.xlsx", fer)])[0]!.method).toBe("BASE_2001");
  });

  it("2001 вдали от слов «базисных ценах» базисным уровнем не считается", () => {
    const text = `Договор от 15.03.2001 заключён. ${"Текст. ".repeat(30)} базисных
Итого по разделу 1 Монтаж,,,,,"1,000.00"
Итого по смете,,,,,"1,000.00"`;
    expect(parseCustomerEstimates([doc("x.xlsx", text)])[0]!.method).toBe("UNKNOWN");
  });

  it("методы ресурсно-индексного расчёта и уровень цен «N зона, K кв. YYYY»", () => {
    for (const marker of ["ФСНБ-2022", "по состоянию на 01.01.2022", "по Методике 2020", "приказ 421/пр", "в текущем уровне цен"]) {
      const text = `${marker}; Республика Бурятия (2 зона), 3 квартал 2026\nИтого по разделу 1 Монтаж,,,,,"1,000.00"\nИтого по смете,,,,,"1,000.00"`;
      const [estimate] = parseCustomerEstimates([doc("x.xlsx", text)]);
      expect(estimate!.method).toBe("RESOURCE_2022");
      expect(estimate!.priceLevel).toEqual({ zone: 2, quarter: 3, year: 2026 });
    }
  });

  it("шапка из xlsx с сотнями запятых в строке: уровень цен дальше 4000 знаков от начала всё равно читается", () => {
    const wide = (label: string, value = ""): string => `${label} ,${",".repeat(6)}${value}${",".repeat(300)}`;
    const head = [
      wide("ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-01-01"),
      wide("(наименование работ и затрат, наименование объекта)"),
      wide("Основание"),
      wide("(проектная и (или) иная техническая документация)"),
      wide("Составлен ресурсно-индексным методом"),
      wide("Сметная стоимость строительных работ", "1 000,00 руб."),
      wide("Средства на оплату труда рабочих", "100,00 руб."),
      wide("Нормативные затраты труда рабочих", "10,00 чел.-ч"),
      ...Array.from({ length: 6 }, (_, index) => wide(`Дополнительная строка шапки ${String(index + 1)}`)),
      wide("Составлен(а) в текущем уровне цен", "I квартал 2026 года"),
    ].join("\n");
    const text = `${head}\n№ п/п,Обоснование,Наименование\nИтого по разделу 1 Монтаж,,,,,"1,000.00"\nИтого по смете,,,,,"1,000.00"`;
    expect(text.indexOf("Составлен(а)")).toBeGreaterThan(4000);

    const [estimate] = parseCustomerEstimates([doc("x.xlsx", text)]);
    expect(estimate!.priceLevel).toMatchObject({ quarter: 1, year: 2026 });
  });

  it("уровень цен и метод читаются из своей сметы, а не из соседней", () => {
    const text = `Составлена в ценах 1 квартал 2025, ФСНБ-2022
Итого по разделу 1 Монтаж,,,,,"1,000.00"
Итого по смете,,,,,"1,000.00"
Составлена в базисных ценах 2001 г., 2 квартал 2026
Итого по разделу 1 Монтаж,,,,,"700.00"
Итого по смете,,,,,"700.00"`;
    const estimates = parseCustomerEstimates([doc("x.xlsx", text)]);

    expect(estimates[0]!.method).toBe("RESOURCE_2022");
    expect(estimates[0]!.priceLevel.quarter).toBe(1);
    expect(estimates[1]!.method).toBe("BASE_2001");
    expect(estimates[1]!.priceLevel.quarter).toBe(2);
  });

  it("пустые тексты и документы без смет дают пустой список", () => {
    expect(parseCustomerEstimates([])).toEqual([]);
    expect(parseCustomerEstimates([doc("a", ""), doc("b", "Просто текст про раздел и всего лишь итого")])).toEqual([]);
  });
});

describe("parseCustomerEstimates: числа в ячейках", () => {
  const sum = (cell: string, delimiter: "," | ";") => {
    const row = delimiter === ";" ? `Итого по разделу 1 А;;;;;${cell}` : `Итого по разделу 1 А,,,,,${cell}`;
    const total = delimiter === ";" ? "Итого по смете;;;;;1" : "Итого по смете,,,,,1";
    return parseCustomerEstimates([doc("x", `${row}\n${total}`)])[0]?.sections[0]?.amount;
  };

  it.each([
    ['"204,011.54"', ",", 204_011.54],
    ['"1,245,903.10"', ",", 1_245_903.1],
    ["248.00", ",", 248],
    ["0.00", ",", 0],
    ["677387,10", ";", 677_387.1],
    ['"1 234 567,89"', ",", 1_234_567.89],
    ["1 234 567,89", ";", 1_234_567.89],
  ] as const)("%s (разделитель «%s») = %s", (cell, delimiter, expected) => {
    expect(sum(cell, delimiter)).toBe(expected);
  });
});

describe("производительность на больших текстах", () => {
  it("мегабайт строк без маркеров разбирается быстро", () => {
    const text = "Позиция: бетонирование фундамента, 12,5 м3, цена 4 500,00 руб.\n".repeat(16_000);
    const started = Date.now();
    expect(parseCustomerEstimates([doc("big", text)])).toEqual([]);
    expect(sectionHeadings(text)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("много разделов и одна длинная строка разбираются за линейное время", () => {
    const sections = Array.from(
      { length: 5000 },
      (_, i) => `Раздел ${String(i + 1)}. Название ${String(i)}\nИтого по разделу ${String(i + 1)} Название ${String(i)},,,,,"1.00"`,
    ).join("\n");
    const text = `${sections}\nИтого по смете,,,,,"5,000.00"\n${"раздел итого всего ".repeat(50_000)}`;
    const started = Date.now();
    const [estimate] = parseCustomerEstimates([doc("big", text)]);
    expect(estimate!.sections).toHaveLength(5000);
    expect(estimate!.checked).toBe(true);
    expect(sectionHeadings(text)).toHaveLength(5000);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

/*
  Форматы других сметных программ. Строки взяты из prod; длинные хвосты пустых
  ячеек в оригинале сокращены, здесь они записаны запятыми.
*/

const TSN_TEXT = `Составлен(а) по ТСН-2001 с учетом Дополнения №: 82,,,,,,
Раздел: Опора  PSKT90,,,,,,,
Подраздел: Устройство цоколей,,,,,,,
Итого по подразделу: Устройство цоколей,,,,,"1,168,537.29",,"3,154,661.32",,,,
   Итого по ТСН-2001.16,,,,,0,0,,,,
Итого по разделу: Опора  PSKT90,,,,,"1,168,537.29",,"3,154,661.32",,,,
Раздел: Прокладка кабеля,,,,,,,
Итого по разделу: Прокладка кабеля,,,,,"500.00",,"1,500.00",,,,
Всего по смете,,,,,"1,169,037.29",,"3,156,161.32",,,`;

describe("формат ТСН-2001 (Гранд-Смета, Москва)", () => {
  it("название раздела без ведущего «:» и с одним пробелом", () => {
    const [estimate] = parseCustomerEstimates([doc("ТСН.xlsx", TSN_TEXT)]);

    expect(estimate!.sections.map((s) => [s.number, s.title, s.amount])).toEqual([
      [null, "Опора PSKT90", 1_168_537.29],
      [null, "Прокладка кабеля", 500],
    ]);
    expect(normalizeSectionTitle("Опора  PSKT90")).toBe("опора pskt90");
  });

  it("«Подраздел» и «Итого по подразделу» не заголовок и не итог раздела; «Итого по ТСН-2001.16» не итог сметы", () => {
    const [estimate, ...rest] = parseCustomerEstimates([doc("ТСН.xlsx", TSN_TEXT)]);

    expect(rest).toEqual([]);
    expect(estimate!.sections).toHaveLength(2);
    // Итог сметы — «Всего по смете», а не «Итого по ТСН-2001.16» с нулями.
    expect(estimate!.statedTotal).toBe(1_169_037.29);
    expect(estimate!.checked).toBe(true);
    expect(estimate!.sectionsTotal).toBe(1_169_037.29);
  });

  it("«Раздел: Название» без номера — заголовок: sectionHeadings и sectionAt", () => {
    const headings = sectionHeadings(TSN_TEXT);

    expect(headings.map((h) => [h.number, h.title])).toEqual([
      [null, "Опора PSKT90"],
      [null, "Прокладка кабеля"],
    ]);
    expect(sectionAt(headings, TSN_TEXT.indexOf("Подраздел"))?.title).toBe("Опора PSKT90");
    expect(sectionAt(headings, TSN_TEXT.indexOf("Итого по разделу: Прокладка"))?.title).toBe("Прокладка кабеля");
  });

  it("метод — базисные цены: «ТСН-2001», «ТСН 2001», «ТСН-2011» раньше «в текущем уровне цен»", () => {
    const method = (header: string) =>
      parseCustomerEstimates([
        doc("x.xlsx", `${header}\nв текущем уровне цен\nИтого по разделу 1 А,,,,,"1,000.00"\nИтого по смете,,,,,"1,000.00"`),
      ])[0]!.method;

    expect(method("Составлен(а) по ТСН-2001 с учетом Дополнения №: 82")).toBe("BASE_2001");
    expect(method("Коэффициенты к ТСН-2001 МГЭ Дополнение 82")).toBe("BASE_2001");
    expect(method("Расчёт по ТСН 2001")).toBe("BASE_2001");
    expect(method("Расчёт по ТСН-2011")).toBe("BASE_2001");
    expect(method("Расчёт по ТСН-2003")).toBe("RESOURCE_2022");
    expect(method("ФСНБ-2022")).toBe("RESOURCE_2022");
  });
});

describe("итог раздела без номера и без названия (Гранд-Смета)", () => {
  const TEXT = `Раздел: Строительные работы,,,,,,,
,,Итого прямые затраты по разделу,,,,,"19,349.61",,,
,,Итого оборудование,,,,,0.00,,,
,,Итого по разделу,,,,,"38,423.49",,,
Раздел: Монтажные работы,,,,,,,
,,Итого прямые затраты по разделу,,,,,"5,000.00",,,
,,Итого по разделу,,,,,"10,000.00",,,
Раздел: Пусконаладка,,,,,,,
,,Итого по разделу,,,,,"1,000.00",,,
,,Всего по смете,,,,,"49,423.49",,,`;

  it("название — ближайший выше заголовок, ещё не закрытый другим итогом", () => {
    const [estimate] = parseCustomerEstimates([doc("ГС.xlsx", TEXT)]);

    expect(estimate!.sections.map((s) => [s.title, s.amount])).toEqual([
      ["Строительные работы", 38_423.49],
      ["Монтажные работы", 10_000],
      ["Пусконаладка", 1_000],
    ]);
    expect(estimate!.checked).toBe(true);
  });

  it("«Итого прямые затраты по разделу» и «Итого оборудование» — не итоги раздела", () => {
    const [estimate] = parseCustomerEstimates([doc("ГС.xlsx", TEXT)]);
    expect(estimate!.sections.map((s) => s.amount)).not.toContain(19_349.61);
    expect(estimate!.sections.map((s) => s.title)).not.toContain("Без названия");
  });

  it("если у итога есть номер и такой заголовок есть — сначала совпадение по номеру", () => {
    const text = `Раздел 2. Вторые работы,,,,,
Раздел 1. Первые работы,,,,,
Итого по разделу 1,,,,,"100.00"
Итого по разделу 2,,,,,"50.00"
Итого по смете,,,,,"150.00"`;
    const [estimate] = parseCustomerEstimates([doc("x.xlsx", text)]);

    expect(estimate!.sections.map((s) => s.title)).toEqual(["Первые работы", "Вторые работы"]);
  });

  it("заголовка нет вовсе — «Раздел N» или «Без названия»", () => {
    const [estimate] = parseCustomerEstimates([
      doc("x.xlsx", `,Итого по разделу 3,,,"10.00"\n,Итого по разделу,,,"5.00"\n,Итого по смете:,,,"15.00"`),
    ]);
    expect(estimate!.sections.map((s) => s.title)).toEqual(["Раздел 3", "Без названия"]);
  });
});

describe("формат РИМ: «Всего по разделу N»", () => {
  const RIM = `Раздел 1. Строительные работы,,,,,,Раздел 1. Строительные работы,,,,,
,,Итоги по разделу 1 Строительные работы :,,,,,,Итоги по разделу 1 Строительные работы :,,,,
,,     Всего прямые затраты (справочно),,,,,"813,913.69",,,,     Всего прямые затраты (справочно),,
,,     Всего накладные расходы (справочно),,,,,"486,481.67",,,
,,Всего по разделу 1 Строительные работы,,,,,"1,528,843.64",,,,Всего по разделу 1 Строительные работы,,
,,ВСЕГО по смете,,,,,"1,865,189.24",,,,ВСЕГО по смете,,`;

  it("«Всего по разделу» — итог раздела; справочные «Всего прямые затраты» и «Итоги по разделу :» — нет", () => {
    const [estimate] = parseCustomerEstimates([doc("РИМ.xlsx", RIM)]);

    expect(estimate!.sections.map((s) => [s.number, s.title, s.amount])).toEqual([
      ["1", "Строительные работы", 1_528_843.64],
    ]);
  });

  it("сверяется с ВСЕГО по смете (итог с НДС 22 %)", () => {
    const [estimate] = parseCustomerEstimates([doc("РИМ.xlsx", RIM)]);

    expect(estimate!.checked).toBe(true);
    expect(estimate!.statedTotal).toBe(1_865_189.24);
    expect(estimate!.totalIncludesVat).toBe(true);
  });

  it("и «Итого по разделу N», и «Всего по разделу N» с одним номером — берётся «Всего»", () => {
    const text = `Раздел 1. Работы,,,,,
,,Итого по разделу 1 Работы,,,,"1,000.00"
,,Всего по разделу 1 Работы,,,,"1,500.00"
,,Всего по смете,,,,"1,500.00"`;
    const [estimate] = parseCustomerEstimates([doc("x.xlsx", text)]);

    expect(estimate!.sections.map((s) => s.amount)).toEqual([1500]);
    expect(estimate!.checked).toBe(true);
  });
});

describe("смета без строки итога (текст обрезан)", () => {
  const TRUNCATED = `Раздел 1. Учебный корпус,,,,,
,,,,,"Итого по разделу 1. Учебный корпус № 1 по адресу: г.Москва, Стремянный переулок, д.28 стр.1",,,,,2622701.80,
,,,,,"Итого по разделу 2. Учебный корпус № 2 по адресу: г.Москва, Стремянный переулок, д.28 стр.2 ",,,,,2608382.22,
,,,,,"Итого по разделу 3. Учебный корпус № 3 по адресу: г.Москва, Стремянный переулок, д.36 ",,,,,28219051.28,`;

  it("возвращается: суммы из явных итогов разделов, итога и сверки нет", () => {
    const estimates = parseCustomerEstimates([doc("Смета.xlsx", TRUNCATED)]);

    expect(estimates).toHaveLength(1);
    const [estimate] = estimates;
    expect(estimate!.sections.map((s) => [s.number, s.amount])).toEqual([
      ["1", 2_622_701.8],
      ["2", 2_608_382.22],
      ["3", 28_219_051.28],
    ]);
    expect(estimate!.sections[0]!.title).toBe("Учебный корпус № 1 по адресу: г.Москва, Стремянный переулок, д.28 стр.1");
    expect(estimate!.sections[2]!.title).toBe("Учебный корпус № 3 по адресу: г.Москва, Стремянный переулок, д.36");
    expect(estimate!.statedTotal).toBeNull();
    expect(estimate!.totalIncludesVat).toBeNull();
    expect(estimate!.checked).toBe(false);
    expect(estimate!.sectionsTotal).toBe(33_450_135.3);
  });

  it("при смене листа незакрытая смета тоже возвращается, закрытая следующая — отдельно", () => {
    const text = `=== лист 1 ===\n${TRUNCATED}\n=== лист 2 ===\nИтого по разделу 1 А,,,,,"10.00"\nИтого по смете,,,,,"10.00"`;
    const estimates = parseCustomerEstimates([doc("Смета.xlsx", text)]);

    expect(estimates.map((e) => [e.estimateName, e.checked, e.statedTotal])).toEqual([
      ["лист 1", false, null],
      ["лист 2", true, 10],
    ]);
  });
});

describe("строки индексов не разделы", () => {
  it.each([
    ["Итого по разделу в базовых ценах"],
    ["Итого по разделу в базисных ценах"],
    ["Итого по разделу в текущих ценах"],
    ["Итого по разделу 1 в базовых ценах"],
    ["Итого по разделу: в текущих ценах"],
  ])("«%s» игнорируется: смета без разделов и без сверки", (label) => {
    const text = `${label},,,,,"1,000.00"
Итого по разделу в текущих ценах,,,,,"1,000.00"
Итого по смете,,,,,"1,000.00"`;
    const [estimate] = parseCustomerEstimates([doc("Изыскания.xlsx", text)]);

    expect(estimate!.sections).toEqual([]);
    expect(estimate!.checked).toBe(false);
    expect(estimate!.statedTotal).toBe(1000);
  });

  it("настоящие разделы рядом с индексами остаются", () => {
    const text = `Итого по разделу 1 Изыскания,,,,,"1,000.00"
Итого по разделу в базовых ценах,,,,,"800.00"
Итого по смете,,,,,"1,000.00"`;
    const [estimate] = parseCustomerEstimates([doc("x.xlsx", text)]);

    expect(estimate!.sections.map((s) => s.title)).toEqual(["Изыскания"]);
    expect(estimate!.checked).toBe(true);
  });
});

describe("мусор плоского текста (PDF) не раздел", () => {
  it.each([
    ["- | Справочно затраты труда рабочих затраты труда машинистов Все… | 133223.77"],
    ["- | Справочно Всего накладные расходы Всего сметная прибыль Всег… | 33142.26"],
  ])("«Итого по разделу %s»", (tail) => {
    const text = `Раздел 1. Монтаж
Итого по разделу 1 Монтаж 1 000,00
Итого по разделу ${tail}
Итого по смете: 1 000,00`;
    const [estimate] = parseCustomerEstimates([doc("лср.pdf", text)]);

    expect(estimate!.sections.map((s) => s.title)).toEqual(["Монтаж"]);
    expect(estimate!.checked).toBe(true);
  });

  it("то же в CSV: «справочно», «накладные расходы», «сметная прибыль», «итого», «всего»", () => {
    for (const title of [
      "Справочно затраты труда рабочих",
      "Накладные расходы",
      "Сметная прибыль",
      "Итого по смете",
      "Всего",
    ]) {
      const text = `Итого по разделу 1 Монтаж,,,,,"1,000.00"\nИтого по разделу 2 ${title},,,,,"500.00"\nИтого по смете,,,,,"1,000.00"`;
      const [estimate] = parseCustomerEstimates([doc("x.xlsx", text)]);
      expect(estimate!.sections.map((s) => s.title)).toEqual(["Монтаж"]);
    }
  });

  it("слово внутри обычного названия («Всегородской») раздел не отбрасывает", () => {
    const text = `Итого по разделу 1 Всегородская сеть,,,,,"1,000.00"\nИтого по смете,,,,,"1,000.00"`;
    expect(parseCustomerEstimates([doc("x.xlsx", text)])[0]!.sections).toHaveLength(1);
  });
});

describe("пустые сметы не возвращаются", () => {
  it("без разделов, итог 0 — шум", () => {
    expect(parseCustomerEstimates([doc("x.xlsx", `Итого по смете,,,,,0.00`)])).toEqual([]);
    expect(parseCustomerEstimates([doc("x.xlsx", `=== Т.с. ===\nИтого по смете,,,,,0.00\n=== обслед ===\nВсего по смете,,,,,0.00`)])).toEqual([]);
  });

  it("единственный «Раздел 3» с нулём и нулевой итог — шум", () => {
    const text = `Раздел 3. Прочее,,,,,\nИтого по разделу 3 Прочее,,,,,0.00\nИтого по смете,,,,,0.00`;
    expect(parseCustomerEstimates([doc("смета № 1 К.xlsx", text)])).toEqual([]);
  });

  it("незакрытая смета с нулевой суммой разделов — шум", () => {
    expect(parseCustomerEstimates([doc("x.xlsx", `Итого по разделу 1 А,,,,,0.00`)])).toEqual([]);
  });

  it("без разделов, но с ненулевым итогом — остаётся", () => {
    const [estimate] = parseCustomerEstimates([doc("x.xlsx", `Итого по смете,,,,,"401,102.41"`)]);
    expect(estimate!.sections).toEqual([]);
    expect(estimate!.statedTotal).toBe(401_102.41);
  });

  it("нулевая сумма разделов при ненулевом итоге остаётся: итог есть, сверки нет", () => {
    const [estimate] = parseCustomerEstimates([doc("x.xlsx", `Итого по разделу 1 А,,,,,0.00\nИтого по смете,,,,,"10.00"`)]);
    expect(estimate!.checked).toBe(false);
    expect(estimate!.statedTotal).toBe(10);
  });
});

describe("закрытие заголовков без перебора", () => {
  it("20 000 разделов в одной смете разбираются быстро и с верными названиями", () => {
    const count = 20_000;
    const rows: string[] = [];
    for (let i = 1; i <= count; i += 1) {
      rows.push(`Раздел: Название ${String(i)},,,,,`, `,,Итого по разделу,,,,"1.00"`);
    }
    const started = Date.now();
    const [estimate] = parseCustomerEstimates([doc("big", `${rows.join("\n")}\nИтого по смете,,,,"${String(count)}.00"`)]);

    expect(estimate!.sections).toHaveLength(count);
    expect(estimate!.sections[0]!.title).toBe("Название 1");
    expect(estimate!.sections[count - 1]!.title).toBe(`Название ${String(count)}`);
    expect(estimate!.checked).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("закрытый заголовок не достаётся второй раз: итог без названия берёт следующий незакрытый", () => {
    const text = `Раздел: А,,,,,
Раздел: Б,,,,,
,,Итого по разделу,,,,"1.00"
,,Итого по разделу,,,,"2.00"
,,Итого по смете,,,,"3.00"`;
    const [estimate] = parseCustomerEstimates([doc("x.xlsx", text)]);
    // Ближайший выше незакрытый — Б, затем А.
    expect(estimate!.sections.map((s) => [s.title, s.amount])).toEqual([["Б", 1], ["А", 2]]);
  });
});
