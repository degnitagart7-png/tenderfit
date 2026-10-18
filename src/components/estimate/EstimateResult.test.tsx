import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { EstimateResult } from "@/components/estimate/EstimateResult";
import {
  buildEstimate,
  type EstimatePriceBook,
} from "@/domain/estimate/calculate";
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
  BILL_GRADING,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeBillItem,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

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
    resolveNorm: makeResolver([NORM_MANUAL_GRADING, NORM_DRAGLINE_15]),
    sources: [],
    generatedAt: "2026-09-28T00:00:00.000Z",
    disclaimer: "Информационно-аналитическая справка",
  });
}

const DOCUMENT = build([
  makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE]),
]);

/**
 * Документ с позицией, под которую в ФСНБ-2022 нормы нет: она выбывает из
 * расчёта целиком. Именно такой случай экран обязан называть — итог без этой
 * позиции занижен на её вес, и по одной сумме этого не видно.
 */
const DOCUMENT_WITH_DROP = build([
  makeBillSection("Земляные работы", [
    BILL_GRADING,
    BILL_DRAGLINE,
    makeBillItem({
      id: "item-sheet-piling",
      workName: "Устройство шпунтового ограждения котлована",
      normCode: "99-99-999-99",
    }),
  ]),
]);

function data(over: Partial<Parameters<typeof EstimateResult>[0]["data"]> = {}) {
  return {
    document: DOCUMENT,
    rejected: [],
    documentsWithoutBill: [],
    billItems: 2,
    ...over,
  };
}

describe("EstimateResult", () => {
  it("показывает стоимость СМР и итог с НДС", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.getByText("Стоимость СМР")).toBeInTheDocument();
    expect(screen.getByText(/с НДС/)).toBeInTheDocument();
  });

  it("выносит долю допущений на видное место", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.getByText(/Допущений/)).toBeInTheDocument();
  });

  it("предлагает три выгрузки: Excel, смета и ведомость", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.getByRole("button", { name: /Скачать Excel/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Смета CSV/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Ведомость CSV/ })).toBeEnabled();
  });

  it("называет источник объёмов: смета заказчика вместо ведомости", () => {
    render(
      <EstimateResult
        data={data({
          volumeSource: {
            level: "CUSTOMER_ESTIMATE",
            documents: ["7. смета снос Мелихова 4.pdf"],
            note: "Ведомости объёмов в документации нет — объёмы взяты из сметы заказчика «7. смета снос Мелихова 4.pdf»",
          },
        })}
        regNumber="0134600012126000001"
      />,
    );

    const block = screen.getByTestId("volume-source");
    expect(block).toHaveTextContent("Объёмы взяты из: сметы заказчика «7. смета снос Мелихова 4.pdf»");
    expect(block).toHaveTextContent(
      "Ведомости объёмов в документации нет — объёмы взяты из сметы заказчика «7. смета снос Мелихова 4.pdf»",
    );
  });

  it("при ведомости пояснение не повторяет строку источника", () => {
    render(
      <EstimateResult
        data={data({
          volumeSource: {
            level: "BILL",
            documents: ["ВОР.xlsx"],
            note: "Объёмы взяты из ведомости объёмов работ «ВОР.xlsx»",
          },
        })}
        regNumber="32616404800"
      />,
    );

    const block = screen.getByTestId("volume-source");
    expect(block).toHaveTextContent("Объёмы взяты из: ведомости объёмов работ «ВОР.xlsx»");
    expect(block.querySelectorAll("p")).toHaveLength(1);
  });

  it("у расчёта без источника (до приоритета источников) строки нет", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.queryByTestId("volume-source")).toBeNull();
  });

  it("расхождения объёмов выводятся в блоке сравнения со сметой заказчика", () => {
    render(
      <EstimateResult
        data={data({
          volumeFindings: [
            {
              workName: "Разборка зданий",
              billQuantity: 600,
              billUnit: "м3",
              customerQuantity: 581.63,
              customerUnit: "м3",
              diffPercent: 3.2,
              customerDocument: "ЛСР.pdf",
              message: "В ведомости 600 м3, в смете заказчика 581,63 м3 — «Разборка зданий», расхождение 3,2 %",
            },
          ],
        })}
        regNumber="32616404800"
        customerEstimates={[]}
      />,
    );

    const block = screen.getByTestId("volume-findings");
    expect(block).toHaveTextContent("В ведомости 600 м3, в смете заказчика 581,63 м3");
    expect(block).toHaveTextContent("На сумму расчёта не влияет");
  });

  it("итоги: отдельная строка «в т.ч. по ценам заказчика: X ₽ (N позиций)»", () => {
    const withCustomer = {
      ...DOCUMENT,
      totals: { ...DOCUMENT.totals, customerPriced: 803_943.09, customerPricedCount: 5 },
    } as EstimateDocument;
    render(<EstimateResult data={data({ document: withCustomer })} regNumber="0134600012126000001" />);

    const line = screen.getByTestId("customer-priced");
    expect(line.textContent?.replace(/\s/g, " ")).toMatch(/в т\.ч\. по ценам заказчика: 803\s943,09 ₽ \(5 позиций\)/);
    expect(line).toHaveTextContent("не проверено нашими ценами");
  });

  it("позиций по ценам заказчика нет — строки в итогах нет", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.queryByTestId("customer-priced")).toBeNull();
  });

  it("в списке позиций строка по цене заказчика помечена", () => {
    const line = DOCUMENT.sections[0]!.lines[0]!;
    const document = {
      ...DOCUMENT,
      sections: [
        {
          ...DOCUMENT.sections[0]!,
          lines: [
            {
              ...line,
              normBaseType: "Цена заказчика",
              normCode: "—",
              normName: "Размещение (захоронение) мусора",
              priceSource: "CUSTOMER_PRICE" as const,
            },
          ],
        },
      ],
    } as EstimateDocument;
    render(<EstimateResult data={data({ document })} regNumber="0134600012126000001" />);

    expect(screen.getByText(/Размещение \(захоронение\) мусора · .* · по цене заказчика — не проверено нашими ценами/)).toBeInTheDocument();
  });

  it("называет причины новых отказов понятными словами", () => {
    render(
      <EstimateResult
        data={data({
          rejected: [
            {
              reason: "NOT_WORK",
              message: "«Бульдозер»: строка из таблицы «Ведомость потребности машин» — это не работа",
              row: { workName: "Бульдозер", quantity: "1", unit: "шт", evidenceQuote: "Бульдозер 1 шт." },
            },
            {
              reason: "WHOLE_WORK",
              message: "«Снос»: объём задан всей работой (1 усл. ед.) — нужна разбивка по позициям",
              row: { workName: "Снос", quantity: "1", unit: "усл. ед.", evidenceQuote: "Снос 1 усл. ед." },
            },
          ],
        })}
        regNumber="32616404800"
      />,
    );

    expect(screen.getByText(/таблица не из работ/)).toBeInTheDocument();
    expect(screen.getByText(/объём задан всей работой \(1 усл\. ед\.\): 1/)).toBeInTheDocument();
  });

  it("называет документы, в которых ведомости не нашлось", () => {
    render(
      <EstimateResult
        data={data({ documentsWithoutBill: ["Проект договора.docx"] })}
        regNumber="32616404800"
      />,
    );

    expect(
      screen.getByText(/Проект договора\.docx/),
    ).toBeInTheDocument();
  });

  it("показывает, сколько строк не вошло в ведомость и почему", () => {
    render(
      <EstimateResult
        data={data({
          rejected: [
            {
              reason: "MONEY_NOT_WORK",
              message: "«Нарушение ППБ»: «руб.» — это сумма, а не объём работ",
              row: {
                workName: "Нарушение ППБ",
                quantity: "50000",
                unit: "руб.",
                evidenceQuote: "Нарушение ППБ | руб. | 50000",
              },
            },
          ],
        })}
        regNumber="32616404800"
      />,
    );

    expect(screen.getByText("Не вошло в ведомость: 1")).toBeInTheDocument();
    expect(screen.getByText(/сумма, а не работа/)).toBeInTheDocument();
  });

  it("на разборе без отказов список не показывает вовсе", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.queryByText(/Не вошло в ведомость/)).not.toBeInTheDocument();
  });

  /**
   * Число позиций без самих позиций — не проверка: сметчик не может найти в
   * справочнике строку, которой не видит. Код нормы печатается вместе с книгой,
   * потому что один код в четырёх книгах означает четыре разные работы.
   */
  it("показывает позиции сметы с кодом нормы и книгой", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.getByText("Позиции сметы: 2")).toBeInTheDocument();
    expect(screen.getByText("Земляные работы")).toBeInTheDocument();
    expect(screen.getByText(/ГЭСН 01-01-111-01/)).toBeInTheDocument();
    expect(screen.getByText(/ГЭСН 01-01-001-01/)).toBeInTheDocument();
  });

  it("называет позицию, которая не вошла в расчёт, и причину", () => {
    render(
      <EstimateResult
        data={data({ document: DOCUMENT_WITH_DROP, billItems: 3 })}
        regNumber="32616404800"
      />,
    );

    expect(screen.getByText(/Позиций без расчёта: 1/)).toBeInTheDocument();
    expect(
      screen.getByText(/Устройство шпунтового ограждения котлована/),
    ).toBeInTheDocument();
    expect(screen.getByText(/норма в ФСНБ-2022 не найдена/)).toBeInTheDocument();
  });

  it("доля допущений раскрыта: видно, на чём именно держится расчёт", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.getByText(/Из чего сложилась доля/)).toBeInTheDocument();
    expect(screen.getByText(/Цены ресурсов взяты из базы/)).toBeInTheDocument();
  });

  it("когда все позиции посчитаны, блока о пробелах нет", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.queryByText(/Позиций без расчёта/)).not.toBeInTheDocument();
  });
});

describe("EstimateResult: сравнение со сметой заказчика", () => {
  it("без customerEstimates блока сравнения нет", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.queryByText("Сравнение со сметой заказчика")).not.toBeInTheDocument();
  });

  it("пустой массив — короткая строка «сравнивать не с чем»", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" customerEstimates={[]} />);

    expect(screen.getByText("Сравнение со сметой заказчика")).toBeInTheDocument();
    expect(screen.getByText(/Смета заказчика в документации не найдена/)).toBeInTheDocument();
  });

  it("со сметой заказчика блок показывает источник", () => {
    render(
      <EstimateResult
        data={data()}
        regNumber="32616404800"
        customerEstimates={[
          {
            documentName: "ЛСР.xlsx",
            estimateName: null,
            sections: [{ number: "1", title: "Земляные работы", amount: 1_000, quote: "" }],
            sectionsTotal: 1_000,
            statedTotal: 1_000,
            totalIncludesVat: false,
            checked: true,
            priceLevel: { zone: null, quarter: null, year: null },
            method: "RESOURCE_2022",
          },
        ]}
      />,
    );

    expect(screen.getByText(/ЛСР\.xlsx: итог/)).toBeInTheDocument();
  });
});

describe("EstimateResult: ценовая зона и основание выбора", () => {
  const withChoice = (choice: EstimateDocument["priceZoneChoice"]) => ({ ...DOCUMENT, priceZoneChoice: choice }) as EstimateDocument;

  it("зона и период названы под стоимостью; без основания — просто зона", () => {
    render(<EstimateResult data={data()} regNumber="32616404800" />);

    expect(screen.getByTestId("price-level").textContent).toBe(`Цены: ${DOCUMENT.priceZone}, ${DOCUMENT.period}`);
  });

  it.each([
    [{ basis: "MUNICIPALITY", matched: "Кабанский р-н" }, "по муниципалитету: Кабанский р-н"],
    [{ basis: "CAPITAL", matched: "Улан-Удэ" }, "по столице субъекта"],
    [{ basis: "USER", matched: null }, "выбрана вручную"],
    [{ basis: "SINGLE_ZONE", matched: null }, "в субъекте одна зона"],
  ] as const)("основание %j → «%s»", (choice, caption) => {
    render(<EstimateResult data={data({ document: withChoice(choice) })} regNumber="32616404800" />);

    expect(screen.getByTestId("price-level").textContent).toBe(`Цены: ${DOCUMENT.priceZone}, ${DOCUMENT.period} — ${caption}`);
  });
});
