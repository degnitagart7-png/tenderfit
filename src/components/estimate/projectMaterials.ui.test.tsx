import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RowEditor } from "@/components/estimate/BillRowEditor";
import type { BillRowInfo } from "@/domain/estimate/billReview";
import type { BillOfWorkItem } from "@/domain/estimate/types";
import type { BillEditor } from "@/hooks/useBillEdits";
import { BILL_GRADING } from "@/test/estimateFixtures";

afterEach(cleanup);

/* Материалы «по проекту» в редакторе строки: количество предложено, цену называет человек; правка «материал». */

const ITEM: BillOfWorkItem = { ...BILL_GRADING };
const INFO: BillRowInfo = {
  itemId: ITEM.id,
  basis: "CODE",
  coverage: 1,
  strictCoverage: 1,
  review: false,
  alternatives: [],
  projectMaterials: [
    { code: "10.3.01.01", name: "Доски подоконные ПВХ", unit: "м", suggestedQuantity: 12, suggestion: "ASSUMED", supplied: false },
    { code: "24.3.03.05", name: "Муфта", unit: "шт", suggestedQuantity: null, suggestion: null, supplied: false },
  ],
};

function open() {
  const editor = { edits: [], effective: { document: { method: "RESOURCE_INDEX" } }, record: vi.fn(), clear: vi.fn() } as unknown as BillEditor;
  render(<RowEditor editor={editor} item={ITEM} anchorItem={ITEM} info={INFO} isOwnRow={false} onClose={() => undefined} />);
  return { editor, box: screen.getByTestId("project-materials") };
}

describe("редактор строки: материалы по проекту", () => {
  it("предложенное количество подставлено и помечено «предложено, проверьте»; без предложения — «укажите количество»", () => {
    const { box } = open();

    expect(within(box).getByLabelText("Количество: Доски подоконные ПВХ")).toHaveValue("12");
    expect(within(box).getByTestId("project-material-10.3.01.01")).toHaveTextContent("предложено, проверьте");
    expect(within(box).getByLabelText("Количество: Муфта")).toHaveValue("");
    expect(within(box).getByTestId("project-material-24.3.03.05")).toHaveTextContent("укажите количество");
  });

  it("цена названа — пишется правка material; без цены правка не пишется и прежняя снимается", () => {
    const { editor, box } = open();

    fireEvent.change(within(box).getByLabelText("Цена: Доски подоконные ПВХ"), { target: { value: "1 250,5" } });
    fireEvent.click(screen.getByRole("button", { name: "Применить правку" }));

    const materials = vi.mocked(editor.record).mock.calls.map(([edit]) => edit).filter((edit) => edit.kind === "material");
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({ code: "10.3.01.01", quantity: 12, unitPrice: 1250.5, unit: "м" });
    expect(vi.mocked(editor.clear)).toHaveBeenCalledWith(ITEM.id, "material", "24.3.03.05");
  });

  it("цена без количества — ошибка, правка не записана", () => {
    const { editor, box } = open();

    fireEvent.change(within(box).getByLabelText("Цена: Муфта"), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Применить правку" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Муфта");
    expect(vi.mocked(editor.record).mock.calls.some(([edit]) => edit.kind === "material")).toBe(false);
  });

  it("у позиции без материалов по проекту блока нет", () => {
    const editor = { edits: [], effective: { document: { method: "RESOURCE_INDEX" } }, record: vi.fn(), clear: vi.fn() } as unknown as BillEditor;
    render(<RowEditor editor={editor} item={ITEM} anchorItem={ITEM} isOwnRow={false} onClose={() => undefined} />);

    expect(screen.queryByTestId("project-materials")).toBeNull();
  });
});
