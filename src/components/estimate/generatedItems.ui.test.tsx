import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorkConditionsBlock } from "@/components/estimate/WorkConditionsBlock";
import { hasEstimateOptions, NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";

afterEach(cleanup);

/* Переключатели строк сверх ведомости в «Условиях работ»: включены по умолчанию, снятое уходит в настройки, сброс условий их не трогает. */

let current: EstimateOptions = NO_ESTIMATE_OPTIONS;

function Harness() {
  const [options, setOptions] = useState<EstimateOptions>(NO_ESTIMATE_OPTIONS);
  current = options;
  return <WorkConditionsBlock options={options} onChange={setOptions} text="" subject="Ремонт фасада" customerCoefficients={null} />;
}

describe("блок «Условия работ»: строки сверх ведомости", () => {
  it("оба переключателя включены по умолчанию; снятие и возврат уходят в настройки", () => {
    render(<Harness />);
    const debris = screen.getByLabelText("Добавлять вывоз строительного мусора");
    const implied = screen.getByLabelText("Добавлять работы по технологии (леса, ограждения)");
    expect(debris).toBeChecked();
    expect(implied).toBeChecked();
    expect(hasEstimateOptions(current)).toBe(false);

    fireEvent.click(debris);
    expect(debris).not.toBeChecked();
    expect(current.generateDebris).toBe(false);
    expect(current.generateImplied).toBeUndefined();
    expect(hasEstimateOptions(current)).toBe(true);

    fireEvent.click(implied);
    expect(current.generateImplied).toBe(false);

    fireEvent.click(debris);
    fireEvent.click(implied);
    expect(current.generateDebris).toBeUndefined();
    expect(current.generateImplied).toBeUndefined();
    expect(hasEstimateOptions(current)).toBe(false);
  });

  it("пояснения называют, что добавляется и как помечено; смет по ЛСР заказчика настройки не касаются", () => {
    render(<Harness />);
    const block = screen.getByTestId("generated-items-options");
    expect(block).toHaveTextContent("999-9900");
    expect(block).toHaveTextContent("добавлено расчётом (мусор)");
    expect(block).toHaveTextContent("добавлено ИИ");
    expect(block).toHaveTextContent("Для смет по ЛСР заказчика обе настройки не действуют");
  });
});
