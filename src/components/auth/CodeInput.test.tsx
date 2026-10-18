import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeInput } from "@/components/auth/CodeInput";

/**
 * Поле кода по ячейкам: вставка заполняет все, ввод идёт вправо, Backspace — влево,
 * нецифры отбрасываются, автозаполнение целым кодом разбирается как вставка.
 */

afterEach(cleanup);

function Harness({ onValue }: { onValue?: (v: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <CodeInput
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

const cell = (n: number) => screen.getByLabelText(`Цифра ${String(n)} из 6`) as HTMLInputElement;
const values = () => [1, 2, 3, 4, 5, 6].map((n) => cell(n).value);

describe("CodeInput", () => {
  it("шесть ячеек с autocomplete=one-time-code и цифровой клавиатурой", () => {
    render(<Harness />);

    expect(screen.getByRole("group", { name: "Код из письма" })).toBeTruthy();
    for (let n = 1; n <= 6; n += 1) {
      expect(cell(n).getAttribute("autocomplete")).toBe("one-time-code");
      expect(cell(n).getAttribute("inputmode")).toBe("numeric");
    }
  });

  it("ввод цифры переводит фокус на следующую ячейку", () => {
    render(<Harness />);

    fireEvent.change(cell(1), { target: { value: "4" } });

    expect(values()).toEqual(["4", "", "", "", "", ""]);
    expect(document.activeElement).toBe(cell(2));
  });

  it("вставка шести цифр заполняет все ячейки, даже если курсор в середине", () => {
    const seen = vi.fn();
    render(<Harness onValue={seen} />);

    fireEvent.paste(cell(4), { clipboardData: { getData: () => "123 456" } });

    expect(values()).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(seen).toHaveBeenLastCalledWith("123456");
    expect(document.activeElement).toBe(cell(6));
  });

  it("вставка короткого значения идёт с текущей ячейки", () => {
    render(<Harness />);

    fireEvent.paste(cell(3), { clipboardData: { getData: () => "98" } });

    expect(values()).toEqual(["", "", "9", "8", "", ""]);
  });

  it("автозаполнение из СМС кладёт код целиком в одну ячейку — он раскладывается по всем", () => {
    render(<Harness />);

    fireEvent.change(cell(1), { target: { value: "654321" } });

    expect(values()).toEqual(["6", "5", "4", "3", "2", "1"]);
  });

  it("нецифры отбрасываются", () => {
    render(<Harness />);

    fireEvent.change(cell(1), { target: { value: "а" } });
    fireEvent.paste(cell(1), { clipboardData: { getData: () => "ab-12-cd" } });

    expect(values()).toEqual(["1", "2", "", "", "", ""]);
  });

  it("Backspace в пустой ячейке стирает предыдущую и идёт назад", () => {
    render(<Harness />);
    fireEvent.paste(cell(1), { clipboardData: { getData: () => "123" } });
    expect(document.activeElement).toBe(cell(4));

    fireEvent.keyDown(cell(4), { key: "Backspace" });

    expect(values()).toEqual(["1", "2", "", "", "", ""]);
    expect(document.activeElement).toBe(cell(3));
  });

  it("стирание цифры в середине не сдвигает остальные", () => {
    render(<Harness />);
    fireEvent.paste(cell(1), { clipboardData: { getData: () => "123456" } });

    fireEvent.change(cell(3), { target: { value: "" } });

    expect(values()).toEqual(["1", "2", "", "4", "5", "6"]);
  });

  it("набор цифры поверх стоящей заменяет её", () => {
    render(<Harness />);
    fireEvent.paste(cell(1), { clipboardData: { getData: () => "123456" } });

    fireEvent.change(cell(2), { target: { value: "27" } });

    expect(cell(2).value).toBe("7");
  });

  it("стрелки ходят по ячейкам", () => {
    render(<Harness />);
    cell(3).focus();

    fireEvent.keyDown(cell(3), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell(2));
    fireEvent.keyDown(cell(2), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell(3));
  });

  it("ошибочное состояние помечается aria-invalid", () => {
    render(<CodeInput value="" onChange={() => undefined} invalid />);

    expect(cell(1).getAttribute("aria-invalid")).toBe("true");
  });
});
