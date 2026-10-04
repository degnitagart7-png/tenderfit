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
