import { describe, expect, it } from "vitest";

import {
  buildEstimate,
  type EstimatePriceBook,
} from "@/domain/estimate/calculate";
import { CSV_BOM } from "@/domain/estimate/export";
import { toLocalEstimateFormCsv, unfilled } from "@/domain/estimate/exportForm";
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

    expect(find(csv, "Наименование редакции сметных нормативов")[2]).toBe(
      DOCUMENT.baseEdition,
    );
    expect(find(csv, "Наименование субъекта Российской Федерации")[2]).toBe(
      DOCUMENT.region,
    );
    expect(
      find(csv, "Наименование зоны субъекта Российской Федерации")[2],
    ).toBe(DOCUMENT.priceZone);
  });

  it("без сплит-формы честно пишет, что индексы не применялись", () => {
    expect(
      find(form(DOCUMENT), "Реквизиты письма Минстроя России об индексах")[2],
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

    expect(find(csv, "Реквизиты письма Минстроя России об индексах")[2]).toBe(
      "Письмо Минстроя России от 24.08.2026 № 52419-ИФ/09",
    );
    expect(
      find(
        csv,
        "Реквизиты нормативного правового акта об утверждении оплаты труда",
      )[2],
    ).toBe("Приказ Минстроя Амурской области от 08.04.2026 № 78-ОД");
  });

  it("печатает номер сметы, стройку, объект и основание", () => {
    const csv = form(DOCUMENT);

    expect(csv).toContain("ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) N 02-01-01");
    expect(find(csv, "Наименование стройки")[2]).toBe(
      "Сети водоснабжения пос. Прогресс",
    );
    expect(find(csv, "Основание")[2]).toBe(
      "Ведомость объёмов работ, раздел 5 документации",
    );
  });

  it("считает сметную стоимость шапки в тысячах рублей", () => {
    const value = find(form(DOCUMENT), "Сметная стоимость, тыс. руб.")[2];

    expect(value).toBe(
      (DOCUMENT.totals.workCost / 1000).toFixed(2).replace(".", ","),
    );
  });

  it("выносит в шапку средства на оплату труда и нормативные затраты труда", () => {
    const csv = form(DOCUMENT);

    expect(find(csv, "Средства на оплату труда рабочих")).toBeDefined();
    expect(find(csv, "Средства на оплату труда машинистов")).toBeDefined();
    expect(
      find(csv, "Нормативные затраты труда рабочих, чел.-ч"),
    ).toBeDefined();
    expect(
      find(csv, "Нормативные затраты труда машинистов, чел.-ч"),
    ).toBeDefined();
  });

  it("относит работу по книге ГЭСН к строительным, а не монтажным", () => {
    const csv = form(DOCUMENT);
    const build = find(csv, "в том числе строительных работ")[2];
    const assembly = find(csv, "в том числе монтажных работ")[2];

    expect(build).not.toBe("0,00");
    expect(assembly).toBe("0,00");
  });

  it("нумерует позиции подряд и ставит в обоснование книгу с кодом", () => {
    const csv = form(DOCUMENT);
    const first = find(csv, NORM_MANUAL_GRADING.code);

    expect(first[0]).toBe("1");
    expect(first[1]).toBe(
      `${NORM_MANUAL_GRADING.baseType} ${NORM_MANUAL_GRADING.code}`,
    );
  });

  it("раскрывает позицию ресурсными строками: ОТ (ЗТ) и МАТ", () => {
    const csv = form(DOCUMENT);

    expect(csv).toContain("ОТ (ЗТ)");
    expect(csv).toContain("ЭМ");
    expect(csv).toContain("МАТ");
  });

  it("печатает НР и СП отдельными строками с указателем приказа", () => {
    const csv = form(DOCUMENT);
    const overhead = find(csv, ";НР;");
    const profit = find(csv, ";СП;");

    expect(overhead[1]).toMatch(/^Пр\/812-|резерв документа/);
    expect(profit[1]).toMatch(/^Пр\/774-|резерв документа/);
    expect(overhead[3]).toBe("%");
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

  it("даёт по разделу обе строки приказа: прямые затраты и итог", () => {
    const csv = form(DOCUMENT);

    expect(csv).toContain("Итого прямые затраты по разделу");
    expect(csv).toContain("Итого по разделу Раздел 1. Земляные работы");
    expect(csv).toContain("Итого по разделу Раздел 2. Водоотведение");
  });

  it("сводит итоги сметы строками приказа", () => {
    const csv = form(DOCUMENT);

    for (const label of [
      "Итого прямые затраты",
      "Итого ФОТ",
      "Итого накладные расходы",
      "Итого сметная прибыль",
      "Итого оборудование",
      "Итого прочие затраты",
      "Всего прямые затраты",
      "Всего накладные расходы",
      "Всего сметная прибыль",
    ]) {
      expect(csv, label).toContain(label);
    }
  });

  it("выносит зимнее удорожание и НДС за пределы формы, а не в её итоги", () => {
    const csv = form(DOCUMENT);
    const at = rows(csv).findIndex((row) =>
      row.includes("Справочно, за пределами формы локальной сметы"),
    );
    const vatAt = rows(csv).findIndex((row) => row.includes("НДС"));

    expect(at).toBeGreaterThan(0);
    expect(vatAt).toBeGreaterThan(at);
  });

  it("заканчивается оговоркой документа", () => {
    const last = rows(form(DOCUMENT)).at(-1) ?? "";

    expect(cells(last)[0]).toBe(DOCUMENT.disclaimer);
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
