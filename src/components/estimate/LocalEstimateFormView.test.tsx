import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { LocalEstimateFormView } from "@/components/estimate/LocalEstimateFormView";
import { buildEstimate } from "@/domain/estimate/calculate";
import type { EstimateDocument } from "@/domain/estimate/types";
import { buildWageScale } from "@/domain/estimate/wageScale";
import {
  AMUR_WAGE_ANCHORS,
  AMUR_ZONE,
  BILL_DRAGLINE,
  BILL_GRADING,
  NORM_DRAGLINE_15,
  NORM_MANUAL_GRADING,
  makeBillSection,
  makeParameters,
  makePriceBook,
  makeResolver,
} from "@/test/estimateFixtures";

const DOCUMENT: EstimateDocument = buildEstimate({
  title: "Реконструкция запорных колодцев",
  sections: [makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE])],
  priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE)),
  parameters: makeParameters(),
  resolveNorm: makeResolver([NORM_MANUAL_GRADING, NORM_DRAGLINE_15]),
  sources: [],
  generatedAt: "2026-09-28T00:00:00.000Z",
  disclaimer: "Информационно-аналитическая справка",
});

const INPUT = {
  document: DOCUMENT,
  number: "02-01-01",
  constructionName: "Сети водоснабжения",
  objectName: "Запорные колодцы",
  basis: "Ведомость объёмов работ",
};

describe("LocalEstimateFormView", () => {
  it("рисует заголовок ЛСР, шапку таблицы с объединениями и строку «Всего по позиции»", () => {
    render(<LocalEstimateFormView input={INPUT} />);

    expect(screen.getByText("ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ (СМЕТА) № 02-01-01")).toBeTruthy();
    expect(screen.getByText("Приложение № 3")).toBeTruthy();
    expect(screen.getAllByText("Всего по позиции").length).toBe(2);

    const table = screen.getByTestId("lsr-form");
    const quantity = within(table).getByText("Количество");
    expect(quantity.getAttribute("colspan")).toBe("3");
    expect(within(table).getByText("Сметная стоимость, руб.").getAttribute("colspan")).toBe("5");
    expect(within(table).getByText("№ п/п").getAttribute("rowspan")).toBe("2");
  });

  it("позиция выделена, ресурсы — мелким серым, итог — суммой с пробелом в разрядах, число выровнено вправо", () => {
    const { container } = render(<LocalEstimateFormView input={INPUT} />);

    const position = container.querySelector('tr[data-kind="position"] td:nth-child(3)');
    expect(position?.className).toContain("font-semibold");
    expect(container.querySelector('tr[data-kind="resource"] td')?.className).toContain("text-muted-foreground");

    const total = container.querySelector('tr[data-kind="summaryTotal"]:last-of-type td:last-child, tr[data-kind="summaryTotal"] td:last-child');
    expect(total?.className).toContain("text-right");
    const first = container.querySelector('tr[data-kind="positionTotal"]');
    expect(first?.querySelector("td:last-child")?.textContent).toMatch(/^\d{1,3}([ ]\d{3})*,\d{2}$/);
  });

  it("показывает те же строки, что файл: итоги по смете, подписи и примечания под таблицей", () => {
    render(<LocalEstimateFormView input={INPUT} />);

    expect(screen.getByText("Итоги по смете:")).toBeTruthy();
    expect(screen.getByText("ВСЕГО по смете")).toBeTruthy();
    expect(screen.getByText(/^Составил ___/)).toBeTruthy();
    expect(screen.getByText(/^Проверил ___/)).toBeTruthy();
    expect(within(screen.getByTestId("lsr-form-notes")).getByText("Не заполнено в форме")).toBeTruthy();
    expect(within(screen.getByTestId("lsr-form-notes")).getByText(DOCUMENT.disclaimer)).toBeTruthy();
  });

  it("в свёрнутом блоке таблицу не строит, пока блок не раскрыт", () => {
    const { container } = render(
      <details>
        <summary>Смета по форме</summary>
        <LocalEstimateFormView input={INPUT} />
      </details>,
    );
    const details = container.querySelector("details") as HTMLDetailsElement;

    expect(screen.queryByTestId("lsr-form")).toBeNull();

    details.open = true;
    fireEvent(details, new Event("toggle"));

    expect(screen.getByTestId("lsr-form")).toBeTruthy();
  });
});
