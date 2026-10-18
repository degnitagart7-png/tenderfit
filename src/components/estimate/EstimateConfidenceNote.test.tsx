import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { EstimateConfidenceNote } from "@/components/estimate/EstimateConfidenceNote";
import { EstimateResult } from "@/components/estimate/EstimateResult";
import { computeEstimateConfidence } from "@/domain/estimate/estimateConfidence";
import { buildEstimate } from "@/domain/estimate/calculate";
import type { VolumeSource } from "@/domain/estimate/types";
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

const DOCUMENT = buildEstimate({
  title: "Реконструкция запорных колодцев",
  sections: [makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE])],
  priceBook: makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE)),
  parameters: makeParameters(),
  resolveNorm: makeResolver([NORM_MANUAL_GRADING, NORM_DRAGLINE_15]),
  sources: [],
  generatedAt: "2026-09-28T00:00:00.000Z",
  disclaimer: "Информационно-аналитическая справка",
});

const FORM_421: VolumeSource = {
  level: "CUSTOMER_ESTIMATE",
  documents: ["ЛСР 02-01.pdf"],
  note: "Объёмы и шифры — из сметы заказчика (форма 421/пр)",
};
const BILL: VolumeSource = { level: "BILL", documents: ["ВОР.xlsx"], note: "Объёмы взяты из ведомости объёмов работ «ВОР.xlsx»" };

function result(volumeSource: VolumeSource | null) {
  return { document: DOCUMENT, rejected: [], documentsWithoutBill: [], billItems: 2, volumeSource };
}

describe("EstimateConfidenceNote", () => {
  it("уровень «по смете заказчика»: метка и пояснение", () => {
    render(<EstimateConfidenceNote confidence={computeEstimateConfidence({ document: DOCUMENT, volumeSource: FORM_421 })} />);

    const note = screen.getByTestId("estimate-confidence");
    expect(note).toHaveAttribute("data-level", "customer");
    expect(note).toHaveTextContent("Расчёт по смете заказчика");
    expect(note).toHaveTextContent("Обычно расхождение с суммой заказчика — до 5 %.");
    expect(screen.queryByTestId("estimate-confidence-range")).not.toBeInTheDocument();
  });

  it("уровень «примерная оценка»: метка, диапазон и пояснение видны сразу", () => {
    render(<EstimateConfidenceNote confidence={computeEstimateConfidence({ document: DOCUMENT, volumeSource: BILL })} />);

    const note = screen.getByTestId("estimate-confidence");
    expect(note).toHaveAttribute("data-level", "approximate");
    expect(note).toHaveTextContent("Примерная оценка");
    expect(screen.getByTestId("estimate-confidence-range")).toHaveTextContent(/^≈ .+ \(от .+ до .+\)$/);
    expect(screen.getByTestId("estimate-confidence-text")).toHaveTextContent("Точность обычно ±30 %");
    expect(screen.getByTestId("estimate-confidence-text")).toHaveTextContent("ведомость объёмов работ");
  });

  it("без суммы ничего не рисует", () => {
    const { container } = render(
      <EstimateConfidenceNote confidence={computeEstimateConfidence({ document: null, volumeSource: BILL })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("EstimateResult: подпись точности рядом с суммой", () => {
  it("смета заказчика формы 421/пр", () => {
    render(<EstimateResult data={result(FORM_421)} regNumber="0134600012126000001" />);
    expect(screen.getByTestId("estimate-confidence")).toHaveTextContent("Расчёт по смете заказчика");
  });

  it("ведомость — примерная оценка", () => {
    render(<EstimateResult data={result(BILL)} regNumber="0134600012126000001" />);
    expect(screen.getByTestId("estimate-confidence")).toHaveTextContent("Примерная оценка");
  });

  it("ЛСР, прочитанная кодом, делает расчёт «по смете заказчика» и без пояснения в источнике", () => {
    const aiNote: VolumeSource = {
      level: "CUSTOMER_ESTIMATE",
      documents: ["смета.pdf"],
      note: "Ведомости объёмов в документации нет — объёмы взяты из сметы заказчика «смета.pdf»",
    };
    render(
      <EstimateResult
        data={result(aiNote)}
        regNumber="0134600012126000001"
        customerLsrs={[
          {
            key: "k",
            number: "02-01",
            title: null,
            sectionTitle: "",
            documentName: "смета.pdf",
            documents: ["смета.pdf"],
            totalWithVat: null,
            totalExVat: null,
            sharedNumber: false,
            positions: 3,
            subPositions: 0,
          },
        ]}
      />,
    );
    expect(screen.getByTestId("estimate-confidence")).toHaveTextContent("Расчёт по смете заказчика");
  });
});
