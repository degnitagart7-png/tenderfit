import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RegionPicker } from "@/components/ui/RegionPicker";

afterEach(cleanup);

function Harness() {
  const [values, setValues] = useState<string[]>([]);
  return (
    <>
      <RegionPicker values={values} onChange={setValues} />
      <button type="button">Показать мои закупки</button>
    </>
  );
}

const input = () => screen.getByRole("combobox");
// Список регионов открыт, пока в DOM есть listbox.
const listOpen = () => screen.queryByRole("listbox") !== null;

describe("RegionPicker — когда закрывается список", () => {
  it("выбор из найденного по набранному слову закрывает список: он не перекрывает кнопку под полем", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "Бурят" } });
    expect(listOpen()).toBe(true);

    fireEvent.mouseDown(screen.getByRole("option", { name: "Республика Бурятия" }));

    expect(listOpen()).toBe(false);
    expect(screen.getByText("Республика Бурятия", { selector: "span, div, p" })).toBeTruthy();
  });

  it("Enter в поиске выбирает первое совпадение и тоже закрывает список", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "Бурят" } });

    fireEvent.keyDown(input(), { key: "Enter" });

    expect(listOpen()).toBe(false);
  });

  it("из полного списка (запрос пуст) регионы выбираются подряд, список остаётся открытым", () => {
    render(<Harness />);
    fireEvent.focus(input());
    expect(listOpen()).toBe(true);

    fireEvent.mouseDown(screen.getByRole("option", { name: "Республика Бурятия" }));
    expect(listOpen()).toBe(true);
    fireEvent.mouseDown(screen.getByRole("option", { name: "Республика Алтай" }));

    expect(listOpen()).toBe(true);
  });

  it("после закрытия клик по полю открывает список снова", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "Бурят" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(listOpen()).toBe(false);

    fireEvent.click(input());

    expect(listOpen()).toBe(true);
  });
});
