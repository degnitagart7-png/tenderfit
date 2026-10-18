import { describe, expect, it } from "vitest";

import {
  buildEstimate,
  type EstimatePriceBook,
} from "@/domain/estimate/calculate";
import { CSV_BOM } from "@/domain/estimate/export";
import {
  buildLocalEstimateForm,
  lineElements,
  priceLevelLabel,
  toLocalEstimateFormCsv,
  unfilled,
  type FormRow,
} from "@/domain/estimate/exportForm";
import type {
  BillOfWorkSection,
  EstimateDocument,
  EstimateParameters,
} from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_DRAGLINE,
  BILL_DRAINAGE,
  BILL_GRADING,
  NORM_DRAGLINE_15,
  NORM_DRAINAGE_100,
  NORM_MANUAL_GRADING,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

/**
 * Форма из приказа проверяется по двум свойствам: состав колонок и состав
 * строк. И то и другое задано Приложением 3 к Методике 421/пр, поэтому тесты
 * сверяются с формулировками приказа дословно — «на единицу измерения в
 * базисном уровне цен», «Всего по позиции», — а не с тем, как их удобнее было
 * бы назвать.
 */

const NORMS = [NORM_MANUAL_GRADING, NORM_DRAGLINE_15, NORM_DRAINAGE_100];

function build(
  sections: readonly BillOfWorkSection[],
  patch: {
    priceBook?: Partial<EstimatePriceBook>;
    parameters?: Partial<EstimateParameters>;
  } = {},
): EstimateDocument {
  return buildEstimate({
    title: "Реконструкция запорных колодцев",
    sections,
    priceBook: makePriceBook(
      buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE),
      patch.priceBook,
    ),
    parameters: makeParameters(patch.parameters),
    resolveNorm: makeResolver(NORMS),
    sources: [],
    generatedAt: "2026-09-27T00:00:00.000Z",
    disclaimer: "Информационно-аналитическая справка, не является сметой",
  });
}

function form(document: EstimateDocument): string {
  return toLocalEstimateFormCsv({
    document,
    number: "02-01-01",
    constructionName: "Сети водоснабжения пос. Прогресс",
    objectName: "Запорные колодцы",
    basis: "Ведомость объёмов работ, раздел 5 документации",
  });
}

function rows(csv: string): string[] {
  return csv.replace(CSV_BOM, "").trimEnd().split("\r\n");
}

function cells(row: string): string[] {
  return row.split(";");
}

function find(csv: string, text: string): string[] {
  const row = rows(csv).find((line) => line.includes(text));
  expect(row, `в форме нет строки «${text}»`).toBeDefined();
  return cells(row ?? "");
}

const INPUT = {
  number: "02-01-01",
  constructionName: "Сети водоснабжения пос. Прогресс",
  objectName: "Запорные колодцы",
  basis: "Ведомость объёмов работ, раздел 5 документации",
};

/** Типизированные строки формы документа. */
function typed(document: EstimateDocument): FormRow[] {
  return buildLocalEstimateForm({ ...INPUT, document });
}

const kinds = (list: readonly FormRow[], kind: FormRow["kind"]): FormRow[] => list.filter((row) => row.kind === kind);
const num = (text: string | undefined): number => Number((text ?? "").replace(/\s/g, "").replace(",", "."));

/*
  В документе три позиции нарочно: у грейдера и драглайна нет материалов, и
  строка «МАТ» на них не появилась бы вовсе — форму надо проверять на позиции,
  у которой есть все виды ресурсов.
*/
const DOCUMENT = build([
  makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE]),
  makeBillSection("Водоотведение", [BILL_DRAINAGE]),
]);

describe("toLocalEstimateFormCsv", () => {
  it("начинает файл с BOM: форму открывают в русском Excel", () => {
    expect(form(DOCUMENT).startsWith(CSV_BOM)).toBe(true);
  });

  it("держит двенадцать колонок в каждой строке", () => {
    const widths = new Set(
      rows(form(DOCUMENT)).map((row) => cells(row).length),
    );

    expect([...widths]).toEqual([12]);
  });

  it("нумерует колонки так, как это сделано в приказе", () => {
    const numbering = rows(form(DOCUMENT)).find(
      (row) => cells(row)[0] === "1" && cells(row)[11] === "12",
    );

    expect(numbering).toBeDefined();
    expect(cells(numbering ?? "")).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
    ]);
  });

  it("ставит подписи колонок стоимости дословно по приложению", () => {
    const header = rows(form(DOCUMENT)).find((row) =>
      row.includes("на единицу измерения в базисном уровне цен"),
    );

    expect(cells(header ?? "").slice(7, 12)).toEqual([
      "на единицу измерения в базисном уровне цен",
      "индекс",
      "на единицу измерения в текущем уровне цен",
      "коэффициенты",
      "всего в текущем уровне цен",
    ]);
  });

  it("печатает шапку с редакцией базы, субъектом и зоной", () => {
    const csv = form(DOCUMENT);

    // Подпись базы остаётся первой, за ней — приказы методик, как в ГРАНД-Смете.
    const edition = find(csv, "Наименование редакции сметных нормативов")[6];
    expect(edition?.startsWith(DOCUMENT.baseEdition)).toBe(true);
    expect(edition).toContain("№ 421/пр");
    expect(edition).toContain("№ 812/пр");
    expect(edition).toContain("№ 774/пр");
    expect(find(csv, "Наименование субъекта Российской Федерации")[6]).toBe(
      DOCUMENT.region,
    );
    expect(
      find(csv, "Наименование зоны субъекта Российской Федерации")[6],
    ).toBe(DOCUMENT.priceZone);
  });

  it("голая дата базы превращается в приказ об утверждении ФСНБ-2022", () => {
    const csv = form({ ...DOCUMENT, baseEdition: "01.01.2022" });

    expect(find(csv, "Наименование редакции сметных нормативов")[6]).toContain(
      "от 30.12.2021 № 1046/пр), редакция на 01.01.2022",
    );
  });

  it("без сплит-формы честно пишет, что индексы не применялись", () => {
    expect(
      find(form(DOCUMENT), "Реквизиты письма Минстроя России об индексах")[6],
    ).toContain("индексы не применялись");
  });

  it("со сплит-формой печатает настоящие реквизиты письма и акта об оплате труда", () => {
    const csv = toLocalEstimateFormCsv({
      document: DOCUMENT,
      number: "02-01-01",
      constructionName: "Сети водоснабжения пос. Прогресс",
      objectName: "Запорные колодцы",
      basis: "Ведомость объёмов работ",
      indexLetter: "Письмо Минстроя России от 24.08.2026 № 52419-ИФ/09",
      wageAct: "Приказ Минстроя Амурской области от 08.04.2026 № 78-ОД",
    });

    expect(find(csv, "Реквизиты письма Минстроя России об индексах")[6]).toBe(
      "Письмо Минстроя России от 24.08.2026 № 52419-ИФ/09",
    );
    expect(
      find(
        csv,
        "Реквизиты нормативного правового акта об утверждении оплаты труда",
      )[6],
    ).toBe("Приказ Минстроя Амурской области от 08.04.2026 № 78-ОД");
  });

  it("печатает номер сметы, стройку, объект и основание с пояснениями мелким шрифтом", () => {
    const csv = form(DOCUMENT);

    expect(csv).toContain("ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-01-01");
    const list = typed(DOCUMENT);
    expect(kinds(list, "name").map((row) => row.cells[0])).toEqual([
      "Сети водоснабжения пос. Прогресс",
      "Запорные колодцы",
    ]);
    expect(kinds(list, "caption").map((row) => row.cells.find((cell) => cell !== ""))).toEqual([
      "(наименование стройки)",
      "(наименование объекта капитального строительства)",
      "(наименование работ и затрат)",
      "(проектная и (или) иная техническая документация)",
    ]);
    expect(find(csv, "Основание")[3]).toBe(
      "Ведомость объёмов работ, раздел 5 документации",
    );
  });

  it("считает сметную стоимость шапки в тысячах рублей", () => {
    const row = typed(DOCUMENT).find((candidate) => candidate.kind === "costBlock" && candidate.cells[0] === "Сметная стоимость");

    expect(row?.cells[3]).toBe(
      (DOCUMENT.totals.workCost / 1000).toFixed(2).replace(".", ","),
    );
    expect(row?.cells[4]).toBe("тыс.руб.");
  });

  it("выносит в шапку средства на оплату труда и нормативные затраты труда — справа, в две колонки", () => {
    const right = kinds(typed(DOCUMENT), "costBlock").map((row) => [row.cells[5], row.cells[10]]);

    expect(right).toContainEqual(["Средства на оплату труда рабочих", "тыс.руб."]);
    expect(right).toContainEqual(["Средства на оплату труда машинистов", "тыс.руб."]);
    expect(right).toContainEqual(["Нормативные затраты труда рабочих", "чел.-ч."]);
    expect(right).toContainEqual(["Нормативные затраты труда машинистов", "чел.-ч."]);
  });

  it("относит работу по книге ГЭСН к строительным, а не монтажным", () => {
    const block = kinds(typed(DOCUMENT), "costBlock");
    const build = block.find((row) => row.cells[1] === "строительных работ")?.cells[3];
    const assembly = block.find((row) => row.cells[1] === "монтажных работ")?.cells[3];

    expect(build).not.toBe("0,00");
    expect(assembly).toBe("0,00");
  });

  it("нумерует позиции подряд и ставит в обоснование книгу с кодом без пробела, как ГРАНД", () => {
    const csv = form(DOCUMENT);
    const first = find(csv, NORM_MANUAL_GRADING.code);

    expect(first[0]).toBe("1");
    expect(first[1]).toBe(`${NORM_MANUAL_GRADING.baseType}${NORM_MANUAL_GRADING.code}`);
    // Колонки 5–7 позиции: объём, коэффициент «1», объём с коэффициентом.
    expect(first[4]).toBe(first[6]);
    expect(first[5]).toBe("1");
  });

  it("раскрывает позицию элементами затрат: ОТ(ЗТ), ЭМ, М — и ресурсами под ними", () => {
    const list = typed(DOCUMENT);
    const labels = kinds(list, "element").map((row) => row.cells[2]);

    expect(labels).toContain("ОТ(ЗТ)");
    expect(labels).toContain("ЭМ");
    expect(labels).toContain("М");
    expect(kinds(list, "resource").length).toBeGreaterThan(5);
  });

  it("порядок строк позиции как в ГРАНД: позиция, элементы, прямые затраты, ФОТ, НР, СП, итог", () => {
    const list = typed(DOCUMENT);
    const at = list.findIndex((row) => row.kind === "position");
    const rest = list.slice(at + 1);
    const end = rest.findIndex((row) => row.kind === "positionTotal");
    const order = rest
      .slice(0, end + 1)
      .map((row) => (row.kind === "subtotal" || row.kind === "accrual" ? row.cells[2] : row.kind))
      .filter((label, index, all) => label !== all[index - 1] || label === "resource");

    const compact = order.filter((label) => label !== "resource" && label !== "condition");
    expect(compact).toEqual(["element", "Итого прямые затраты", "ФОТ", "НР", "СП", "positionTotal"]);
  });

  it("печатает НР и СП отдельными строками с указателем приказа", () => {
    const csv = form(DOCUMENT);
    const overhead = find(csv, ";НР;");
    const profit = find(csv, ";СП;");

    expect(overhead[1]).toMatch(/^Пр\/812-|резерв документа/);
    expect(profit[1]).toMatch(/^Пр\/774-|резерв документа/);
    expect(overhead[3]).toBe("%");
    // Проценты — числами, а не «103 %»: единица стоит в колонке 4.
    expect(overhead[4]).toMatch(/^\d+(,\d+)?$/);
    expect(overhead[6]).toBe(overhead[4]);
  });

  it("закрывает позицию строкой «Всего по позиции»", () => {
    const line = DOCUMENT.sections[0]?.lines[0];
    const expected = (
      (line?.directCost ?? 0) +
      (line?.overheadCost ?? 0) +
      (line?.profitCost ?? 0)
    )
      .toFixed(2)
      .replace(".", ",");

    expect(find(form(DOCUMENT), "Всего по позиции")[11]).toBe(expected);
  });

  it("закрывает раздел одной строкой «Итого по разделу» с его стоимостью, как ГРАНД", () => {
    const csv = form(DOCUMENT);
    const first = find(csv, "Итого по разделу 1. Земляные работы");

    expect(csv).not.toContain("Итого прямые затраты по разделу");
    expect(csv).toContain("Итого по разделу 2. Водоотведение");
    expect(first[11]).toBe(DOCUMENT.sections[0]?.workCost.toFixed(2).replace(".", ","));
  });

  it("называет раздел «Раздел N. Название»", () => {
    expect(kinds(typed(DOCUMENT), "section").map((row) => row.cells[0])).toEqual([
      "Раздел 1. Земляные работы",
      "Раздел 2. Водоотведение",
    ]);
  });

  it("сводит итоги сметы блоком «Итоги по смете» как в ГРАНД", () => {
    const list = typed(DOCUMENT);
    const at = list.findIndex((row) => row.kind === "summaryHeading");
    const labels = list.slice(at).filter((row) => row.cells[2] !== undefined && row.cells[2] !== "").map((row) => (row.cells[2] ?? "").trim());

    expect(labels.slice(0, 7)).toEqual([
      "Итоги по смете:",
      "Всего прямые затраты (справочно)",
      "в том числе:",
      "Оплата труда рабочих",
      "Эксплуатация машин",
      "Оплата труда машинистов (Отм)",
      "Материалы",
    ]);
    for (const label of [
      "Строительные работы",
      "Всего",
      "Всего ФОТ (справочно)",
      "Всего накладные расходы (справочно)",
      "Всего сметная прибыль (справочно)",
      "ВСЕГО по смете",
      "справочно:",
      "Затраты труда рабочих",
      "Затраты труда машинистов",
    ]) {
      expect(labels, label).toContain(label);
    }
    // Вложенность видна по ведущим пробелам в подписи.
    expect(list.find((row) => (row.cells[2] ?? "").trim() === "Материалы")?.cells[2]).toMatch(/^ {15}Материалы$/);
  });

  it("не печатает монтажные работы, которых в смете нет", () => {
    const labels = typed(DOCUMENT).map((row) => (row.cells[2] ?? "").trim());

    expect(labels).not.toContain("Монтажные работы");
  });

  it("«Всего» — стоимость работ, «ВСЕГО по смете» — итог с НДС, как на экране", () => {
    const list = typed(DOCUMENT);
    const value = (label: string): string | undefined =>
      list.find((row) => (row.cells[2] ?? "").trim() === label)?.cells[11];

    expect(num(value("Всего"))).toBeCloseTo(DOCUMENT.totals.workCost, 2);
    expect(num(value(`НДС ${String(DOCUMENT.parameters.vatPercent)} %`))).toBeCloseTo(DOCUMENT.totals.vat, 2);
    expect(num(value("ВСЕГО по смете"))).toBeCloseTo(DOCUMENT.totals.total, 2);
  });

  it("лимитированные затраты и «Итого» печатаются, только когда они начислены", () => {
    const without = typed(DOCUMENT).map((row) => row.cells[2] ?? "");
    expect(without.some((label) => label.includes("Зимнее удорожание"))).toBe(false);
    expect(without.some((label) => label.trim() === "Итого")).toBe(false);

    const withWinter = build([makeBillSection("Земляные работы", [BILL_GRADING])], {
      parameters: {
        limited: { winterSurchargePercent: 6, temporaryStructuresPercent: 2, source: "тест" },
      },
    });
    const list = typed(withWinter);
    const labels = list.map((row) => row.cells[2] ?? "");
    const winter = list.find((row) => (row.cells[2] ?? "").includes("Зимнее удорожание"));

    expect(withWinter.totals.winterSurcharge).toBeGreaterThan(0);
    expect(winter?.cells[2]).toContain("лимитированные затраты главы 9 ССР, справочно");
    expect(num(winter?.cells[11])).toBeCloseTo(withWinter.totals.winterSurcharge, 2);
    expect(labels.some((label) => label.includes("Временные здания и сооружения"))).toBe(true);
    expect(num(list.find((row) => (row.cells[2] ?? "").trim() === "Итого")?.cells[11])).toBeCloseTo(withWinter.totals.beforeVat, 2);
    expect(num(list.find((row) => (row.cells[2] ?? "").trim() === "ВСЕГО по смете")?.cells[11])).toBeCloseTo(withWinter.totals.total, 2);
  });

  it("заканчивает форму подписями составителя и проверяющего, а примечания идут после них", () => {
    const list = typed(DOCUMENT);
    const signatures = kinds(list, "signature").map((row) => row.cells[0]);

    expect(signatures).toEqual([
      "Составил ______________________ [должность, подпись (инициалы, фамилия)]",
      "Проверил ______________________ [должность, подпись (инициалы, фамилия)]",
    ]);
    const lastSignature = list.map((row) => row.kind).lastIndexOf("signature");
    const firstNote = list.findIndex((row) => row.kind === "note");
    expect(firstNote).toBeGreaterThan(lastSignature);
    expect(list.slice(firstNote).every((row) => row.kind === "note")).toBe(true);
  });

  it("заканчивается оговоркой документа", () => {
    const last = rows(form(DOCUMENT)).at(-1) ?? "";

    expect(cells(last)[0]).toBe(DOCUMENT.disclaimer);
  });
});

describe("приложение к Методике по методу расчёта", () => {
  const appendix = (document: EstimateDocument): string[] =>
    kinds(typed(document), "appendix").map((row) => row.cells[6] ?? "");

  it("ресурсно-индексный метод — Приложение № 3 и приказ об утверждении формы", () => {
    expect(appendix(DOCUMENT)).toEqual([
      "Приложение № 3",
      "Утверждено приказом Минстроя РФ № 421/пр от 4 августа 2020 г.",
    ]);
    expect(kinds(typed(DOCUMENT), "field").find((row) => row.cells[0] === "Составлен")?.cells[3]).toBe("ресурсно-индексным методом");
  });

  it("базисно-индексный метод — Приложение № 2 и Форма № 2", () => {
    const bim = { ...DOCUMENT, method: "BASE_INDEX" as const };

    expect(appendix(bim).slice(0, 2)).toEqual(["Приложение № 2", "Форма № 2"]);
    expect(kinds(typed(bim), "field").find((row) => row.cells[0] === "Составлен")?.cells[3]).toBe("базисно-индексным методом");
  });
});

describe("priceLevelLabel", () => {
  it.each([
    ["3 квартал 2026 г.", "III квартал 2026 года"],
    ["1 квартал 2027 г.", "I квартал 2027 года"],
    ["4 квартал 2025 г.", "IV квартал 2025 года"],
    ["III кв. 2026 (индексы Минстроя)", "III квартал 2026 года"],
    ["II квартал 2026 г.", "II квартал 2026 года"],
  ])("«%s» → «%s»", (period, expected) => {
    expect(priceLevelLabel(period)).toBe(expected);
  });

  it("период, который не разобрался, печатается как есть", () => {
    expect(priceLevelLabel("июль 2026")).toBe("июль 2026");
    expect(priceLevelLabel("")).toBe("");
  });

  it("строка «Составлен(а) в текущем уровне цен» берёт римский квартал из периода документа", () => {
    const row = kinds(typed(DOCUMENT), "field").find((candidate) => candidate.cells[0] === "Составлен(а) в текущем уровне цен");

    expect(row?.cells[3]).toBe(priceLevelLabel(DOCUMENT.period));
  });
});

describe("элементы затрат позиции", () => {
  /** Позиции документа вместе с их строками в форме. */
  function positions(document: EstimateDocument) {
    const list = typed(document);
    return document.sections.flatMap((section) => section.lines).map((line) => {
      const at = list.findIndex((row) => row.kind === "position" && row.cells[3] === line.normUnit && row.cells[2] === line.normName);
      const end = list.findIndex((row, index) => index > at && row.kind === "positionTotal");
      return { line, rows: list.slice(at, end + 1) };
    });
  }

  it("ОТ + ЭМ + ОТм + М равна прямым затратам позиции, а «Итого прямые затраты» печатает эту же сумму", () => {
    for (const { line, rows: slice } of positions(DOCUMENT)) {
      const elements = kinds(slice, "element");
      const sum = elements.reduce((total, row) => total + num(row.cells[11]), 0);
      const direct = slice.find((row) => row.kind === "subtotal" && row.cells[2] === "Итого прямые затраты");

      expect(sum, line.normCode).toBeCloseTo(line.directCost, 1);
      expect(num(direct?.cells[11]), line.normCode).toBeCloseTo(line.directCost, 2);
      const parts = lineElements(line);
      expect(parts.labour + parts.machines + parts.machinist + parts.materials, line.normCode).toBeCloseTo(line.directCost, 1);
    }
  });

  it("сумма элемента равна сумме ресурсных строк под ним", () => {
    for (const { line, rows: slice } of positions(DOCUMENT)) {
      let element: FormRow | undefined;
      let resources = 0;
      const close = () => {
        if (element !== undefined && element.cells[2] !== "ОТм(ЗТм)") {
          expect(num(element.cells[11]), `${line.normCode} ${element.cells[2]}`).toBeCloseTo(resources, 1);
        }
      };
      for (const row of slice) {
        if (row.kind === "element") {
          close();
          element = row;
          resources = 0;
        } else if (row.kind === "resource") {
          resources += num(row.cells[11]);
        }
      }
      close();
    }
  });

  it("«ФОТ» позиции — фонд оплаты труда расчёта", () => {
    for (const { line, rows: slice } of positions(DOCUMENT)) {
      const fot = slice.find((row) => row.kind === "subtotal" && row.cells[2] === "ФОТ");
      expect(num(fot?.cells[11]), line.normCode).toBeCloseTo(line.wageFund, 2);
    }
  });

  it("«Всего по позиции»: колонка 12 — стоимость, колонка 10 — стоимость единицы измерения расценки", () => {
    for (const { line, rows: slice } of positions(DOCUMENT)) {
      const total = slice.at(-1);
      const cost = line.directCost + line.overheadCost + line.profitCost;

      expect(total?.cells[2], line.normCode).toBe("Всего по позиции");
      expect(num(total?.cells[11]), line.normCode).toBeCloseTo(cost, 2);
      expect(num(total?.cells[9]), line.normCode).toBeCloseTo(cost / line.quantity, 2);
    }
  });

  it("элемент без ресурсов в позиции не печатается", () => {
    const labels = positions(DOCUMENT).flatMap(({ line, rows: slice }) => {
      const hasMachines = line.resources.some((resource) => resource.kind === "MACHINE");
      return kinds(slice, "element").some((row) => row.cells[2] === "ЭМ") === hasMachines ? [] : [line.normCode];
    });

    expect(labels).toEqual([]);
  });

  it("часы труда — в колонку 7 строки ОТ(ЗТ), деньги — в колонку 12", () => {
    const { line, rows: slice } = positions(DOCUMENT)[0] ?? { line: undefined, rows: [] };
    const labour = kinds(slice, "element").find((row) => row.cells[2] === "ОТ(ЗТ)");

    expect(labour?.cells[3]).toBe("чел.-ч");
    expect(num(labour?.cells[6])).toBeCloseTo((line?.labourHours ?? 0) + (line?.specialistHours ?? 0), 3);
    expect(labour?.cells[1]).toBe("1");
  });
});

describe("unfilled", () => {
  it("называет незаполненные колонки коэффициентов и индексов", () => {
    const notes = unfilled(DOCUMENT).join(" ");

    expect(notes).toContain("Колонки 8 и 9");
    expect(notes).not.toContain(
      "индексы изменения сметной стоимости публикуются",
    );
    expect(notes).toContain("Колонки 6 и 11");
    expect(notes).toContain("Колонка 5");
  });

  it("сообщает, сколько ресурсов пошло в расчёт без текущей цены", () => {
    const withGap = build([makeBillSection("Водоотведение", [BILL_DRAINAGE])], {
      priceBook: { current: new Map() },
    });

    const notes = unfilled(withGap).join(" ");

    expect(notes).toMatch(/Ресурсов без текущей цены: \d+/);
  });

  it("сообщает о позициях с резервным нормативом НР или СП", () => {
    const withReserve = build(
      [makeBillSection("Земляные работы", [BILL_GRADING])],
      { priceBook: { overheadRates: new Map() } },
    );

    expect(unfilled(withReserve).join(" ")).toMatch(
      /резервным нормативом НР или СП: \d+/,
    );
  });

  it("на полном расчёте не выдумывает пропусков сверх постоянных трёх", () => {
    const notes = unfilled(DOCUMENT);

    expect(notes.length).toBeGreaterThanOrEqual(3);
  });
});
