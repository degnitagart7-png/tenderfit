import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RowEditor } from "@/components/estimate/BillRowEditor";
import { WorkConditionsBlock } from "@/components/estimate/WorkConditionsBlock";
import { hasEstimateOptions, NO_ESTIMATE_OPTIONS, type EstimateOptions } from "@/domain/estimate/estimateOptions";
import type { BillOfWorkItem, CustomerConditions } from "@/domain/estimate/types";
import type { BillEditor } from "@/hooks/useBillEdits";
import { BILL_GRADING } from "@/test/estimateFixtures";

afterEach(cleanup);

/* Переключатель «Применять коэффициенты заказчика» в «Условиях работ» и галочка «коэффициент заказчика» в редакторе строки. */

let current: EstimateOptions = NO_ESTIMATE_OPTIONS;

function Harness({ customer }: { customer: { positions: number; confirmed: number; rejected: number } | null }) {
  const [options, setOptions] = useState<EstimateOptions>(NO_ESTIMATE_OPTIONS);
  current = options;
  return (
    <WorkConditionsBlock options={options} onChange={setOptions} text="" subject="Ремонт" customerCoefficients={customer} />
  );
}

describe("блок «Условия работ»: коэффициенты заказчика", () => {
  it("есть коэффициенты в ЛСР — переключатель включён по умолчанию; снятие уходит в настройки", () => {
    render(<Harness customer={{ positions: 7, confirmed: 6, rejected: 1 }} />);

    const toggle = screen.getByLabelText("Применять коэффициенты заказчика");
    expect(toggle).toBeChecked();
    expect(screen.getByTestId("apply-customer-coefficients")).toHaveTextContent("подтверждены приложением 10 к 421/пр, п. 58, 812/пр п. 25 или 774/пр п. 16 у 6");
    expect(screen.getByTestId("apply-customer-coefficients")).toHaveTextContent("не подтверждены у 1");
    expect(hasEstimateOptions(current)).toBe(false);

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(current.applyCustomerCoefficients).toBe(false);
    expect(hasEstimateOptions(current)).toBe(true);

    fireEvent.click(toggle);
    expect(current.applyCustomerCoefficients).toBeUndefined();
  });

  it("коэффициентов у заказчика нет — переключателя нет", () => {
    render(<Harness customer={{ positions: 0, confirmed: 0, rejected: 0 }} />);
    expect(screen.queryByTestId("apply-customer-coefficients")).toBeNull();
    cleanup();
    render(<Harness customer={null} />);
    expect(screen.queryByTestId("apply-customer-coefficients")).toBeNull();
  });
});

describe("редактор строки: «Коэффициент заказчика»", () => {
  const confirmed: CustomerConditions = {
    confirmed: { conditionIds: ["T3-1.1"], p58: false, phase: "RECONSTRUCTION" },
    rejected: [],
    label: "как у заказчика: приложение 10 к 421/пр, таблица 3, п. 1.1 (К = 1,2)",
    enabled: true,
    forceUnconfirmed: false,
  };
  const rejected: CustomerConditions = {
    confirmed: null,
    rejected: [{ text: "ОЗП=0,3; ТЗ=0,3", reason: "ссылка «648/пр» не относится к приложению 10", amount: -648, labour: 0.3, machines: null }],
    label: "",
    enabled: true,
    forceUnconfirmed: false,
  };

  function open(conditions: CustomerConditions) {
    const item: BillOfWorkItem = { ...BILL_GRADING, customerConditions: conditions };
    const editor = {
      edits: [],
      effective: { document: { method: "RESOURCE_INDEX" } },
      record: vi.fn(),
      clear: vi.fn(),
    } as unknown as BillEditor;
    render(<RowEditor editor={editor} item={item} anchorItem={item} isOwnRow={false} onClose={() => undefined} />);
    return { editor, box: screen.getByTestId("customer-coefficients") };
  }

  it("подтверждённый коэффициент: галочка стоит и называет условие; без изменений правка не пишется", () => {
    const { editor, box } = open(confirmed);

    expect(within(box).getByLabelText("Коэффициент заказчика")).toBeChecked();
    expect(box).toHaveTextContent("таблица 3, п. 1.1 (К = 1,2)");
    fireEvent.click(screen.getByRole("button", { name: "Применить правку" }));

    expect(vi.mocked(editor.clear)).toHaveBeenCalledWith(BILL_GRADING.id, "coefficients");
    expect(vi.mocked(editor.record).mock.calls.some(([edit]) => edit.kind === "coefficients")).toBe(false);
  });

  it("снять по позиции: записывается правка coefficients с apply = false", () => {
    const { editor, box } = open(confirmed);

    fireEvent.click(within(box).getByLabelText("Коэффициент заказчика"));
    fireEvent.click(screen.getByRole("button", { name: "Применить правку" }));

    const edit = vi.mocked(editor.record).mock.calls.map(([item]) => item).find((item) => item.kind === "coefficients");
    expect(edit).toMatchObject({ kind: "coefficients", apply: false });
  });

  it("неподтверждённый: галочка снята, причина названа; включить — apply = true, допущение", () => {
    const { editor, box } = open(rejected);

    expect(within(box).getByLabelText("Коэффициент заказчика")).not.toBeChecked();
    expect(box).toHaveTextContent("Приложением 10 не подтверждён");
    expect(box).toHaveTextContent("ОЗП=0,3; ТЗ=0,3");
    fireEvent.click(within(box).getByLabelText("Коэффициент заказчика"));
    fireEvent.click(screen.getByRole("button", { name: "Применить правку" }));

    const edit = vi.mocked(editor.record).mock.calls.map(([item]) => item).find((item) => item.kind === "coefficients");
    expect(edit).toMatchObject({ kind: "coefficients", apply: true });
  });

  it("у позиции без коэффициентов заказчика блока нет", () => {
    const editor = { edits: [], effective: { document: { method: "RESOURCE_INDEX" } }, record: vi.fn(), clear: vi.fn() } as unknown as BillEditor;
    render(<RowEditor editor={editor} item={BILL_GRADING} anchorItem={BILL_GRADING} isOwnRow={false} onClose={() => undefined} />);

    expect(screen.queryByTestId("customer-coefficients")).toBeNull();
  });
});
