import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { EstimateResult } from "@/components/estimate/EstimateResult";
import { WorkConditionsBlock } from "@/components/estimate/WorkConditionsBlock";
import { buildEstimate } from "@/domain/estimate/calculate";
import { hasEstimateOptions, NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";
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

/*
  Интерфейс нормативов: блок «Условия работ» (по умолчанию всё выключено, подсказки не ставят
  галочки сами) и результат расчёта (приказ и пункт у каждого начисления, причины ненаписанного).
*/

let current: EstimateOptions = NO_ESTIMATE_OPTIONS;

function Harness({ text = "", subject = "Капитальный ремонт многоквартирного дома" }: { text?: string; subject?: string }) {
  const [options, setOptions] = useState<EstimateOptions>(NO_ESTIMATE_OPTIONS);
  current = options;
  return (
    <WorkConditionsBlock
      options={options}
      onChange={setOptions}
      text={text}
      subject={subject}
      tender={{ region: "Иркутская область", deliveryAddress: "Иркутский район, д. Сосновый бор", customerName: "" }}
    />
  );
}

describe("блок «Условия работ»", () => {
  it("по умолчанию всё выключено: вид работ не указан, галочек нет, выбора нет", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Вид работ")).toHaveValue("");
    // Условия не отмечены; единственные галочки — переключатели «строки сверх ведомости», включённые по умолчанию (в настройки не попадают).
    const boxes = screen.queryAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toBeChecked();
    expect(hasEstimateOptions(current)).toBe(false);
  });

  it("подсказка по названию закупки не выбирает вид работ сама; кнопка «Выбрать» — выбирает", () => {
    render(<Harness />);
    expect(screen.getByTestId("phase-hint")).toHaveTextContent("капитальный ремонт");
    expect(current.phase).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));
    expect(current.phase).toBe("CAPITAL_REPAIR");
  });

  it("капремонт: 6 частых условий видны, остальные — под «Ещё»; ни одно не отмечено", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Вид работ"), { target: { value: "CAPITAL_REPAIR" } });
    const frequent = screen.getByTestId("frequent-conditions");
    const boxes = within(frequent).getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThanOrEqual(4);
    expect(boxes.length).toBeLessThanOrEqual(6);
    for (const box of boxes) expect(box).not.toBeChecked();
    expect(within(frequent).getByText(/без расселения/u)).toBeInTheDocument();
    expect(screen.getByText("Ещё")).toBeInTheDocument();
  });

  it("подсказка «В ТЗ сказано: «…» — отметить?» стоит рядом с условием, галочка сама не ставится", () => {
    render(<Harness text="Работы ведутся в жилых помещениях без выселения жильцов в стесненных условиях." />);
    fireEvent.change(screen.getByLabelText("Вид работ"), { target: { value: "CAPITAL_REPAIR" } });
    const hint = screen.getByTestId("hint-T5-8");
    expect(hint).toHaveTextContent("В ТЗ сказано");
    expect(hint).toHaveTextContent("без выселения");
    expect(screen.getByLabelText(/без расселения/u)).not.toBeChecked();
    fireEvent.click(within(hint).getByRole("button", { name: "Отметить" }));
    expect(current.conditionIds).toEqual(["T5-8"]);
    expect(screen.getByLabelText(/без расселения/u)).toBeChecked();
    expect(screen.queryByTestId("hint-T5-8")).toBeNull();
  });

  it("подпункты одного пункта взаимоисключают друг друга: «1.2» снимает «1.1»", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Вид работ"), { target: { value: "CAPITAL_REPAIR" } });
    const first = screen.getByLabelText(/загромождающих предметов нет/u);
    const second = screen.getByLabelText(/есть оборудование, мебель, предметы/u);
    fireEvent.click(first);
    expect(current.conditionIds).toEqual(["T5-1.1"]);
    fireEvent.click(second);
    expect(current.conditionIds).toEqual(["T5-1.2"]);
  });

  it("смена вида работ сбрасывает условия: таблицы приложения 10 у видов разные", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Вид работ"), { target: { value: "CAPITAL_REPAIR" } });
    fireEvent.click(screen.getByLabelText(/без расселения/u));
    expect(current.conditionIds).toEqual(["T5-8"]);
    fireEvent.change(screen.getByLabelText("Вид работ"), { target: { value: "RECONSTRUCTION" } });
    expect(current.conditionIds).toEqual([]);
  });

  it("снос: условий приложения 10 нет — блок говорит об этом; зимнее — по виду объекта и датам", () => {
    render(<Harness subject="Снос (демонтаж) объекта капитального строительства" text="Срок выполнения работ: с 01.09.2026 по 30.11.2026." />);
    fireEvent.change(screen.getByLabelText("Вид работ"), { target: { value: "DEMOLITION" } });
    expect(screen.queryByTestId("frequent-conditions")).toBeNull();
    expect(screen.getByText(/условий производства работ нет/u)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Объект или конструкции"), { target: { value: "DEM_DISMANTLE" } });
    expect(current.workKind).toBe("DEM_DISMANTLE");
    // Сроки подсказаны, но не применены без нажатия.
    const hint = screen.getByTestId("period-hint");
    expect(hint).toHaveTextContent("2026-09-01");
    expect(current.workPeriod).toBeNull();
    fireEvent.click(within(hint).getByRole("button", { name: "Применить" }));
    expect(current.workPeriod).toEqual({ start: "2026-09-01", end: "2026-11-30" });
  });

  it("«Сбросить всё» возвращает значения по умолчанию", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Вид работ"), { target: { value: "CAPITAL_REPAIR" } });
    fireEvent.click(screen.getByRole("button", { name: "Сбросить всё" }));
    expect(hasEstimateOptions(current)).toBe(false);
  });
});

const base = makePriceBook(buildWageScale(AMUR_WAGE_ANCHORS, AMUR_ZONE));

function documentWith(parameters = makeParameters(), normatives?: Parameters<typeof buildEstimate>[0]["appliedNormatives"]) {
  return buildEstimate({
    title: "Ремонт",
    sections: [makeBillSection("Земляные работы", [BILL_GRADING, BILL_DRAGLINE])],
    priceBook: base,
    parameters,
    resolveNorm: makeResolver([NORM_MANUAL_GRADING, NORM_DRAGLINE_15]),
    sources: [],
    generatedAt: "2026-10-08T00:00:00.000Z",
    disclaimer: "Информационно-аналитическая справка",
    ...(normatives === undefined ? {} : { appliedNormatives: normatives }),
  });
}

describe("результат: нормативы сверх норм", () => {
  it("без нормативов блока нет — экран как прежде", () => {
    render(<EstimateResult data={{ document: documentWith(), rejected: [], documentsWithoutBill: [], billItems: 2 }} regNumber="1" />);
    expect(screen.queryByTestId("normatives-block")).toBeNull();
  });

  it("условия работ и зимнее: приказ и пункт у каждого, фраза «Применены коэффициенты условий работ …», причины неначисленного", () => {
    const document = documentWith(
      makeParameters({ workConditions: { phase: "CAPITAL_REPAIR", conditionIds: ["T5-8"], newConstructionNorms: false } }),
      [
        {
          code: "WINTER",
          title: "Зимнее удорожание",
          text: "НДЗ",
          value: "—",
          source: "Приказ Минстроя России от 25.05.2021 N 325/пр",
          applied: false,
          reason: "зимнее удорожание не начислено: не известен период работ",
          missingData: true,
        },
      ],
    );
    render(<EstimateResult data={{ document, rejected: [], documentsWithoutBill: [], billItems: 2 }} regNumber="1" />);
    const block = screen.getByTestId("normatives-block");
    expect(within(block).getByTestId("work-conditions-sentence")).toHaveTextContent(
      "Применены коэффициенты условий работ: в жилых помещениях без расселения — К 1,50 (приложение 10 к 421/пр, таблица 5, п. 8)",
    );
    expect(block).toHaveTextContent("не начислено — зимнее удорожание не начислено: не известен период работ");
    // «Надёжность расчёта»: неприменённый из-за неизвестных данных норматив — со строкой причины.
    expect(screen.getByTestId("unapplied-normative")).toHaveTextContent("Не начислено из-за неизвестных данных");
  });
});
