import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LawSwitcher } from "@/components/tenders/LawSwitcher";
import type { LawCounts } from "@/domain/filtering";
import type { TenderLaw } from "@/domain/enums";

const COUNTS: LawCounts = { ALL: 20, FZ_44: 12, FZ_223: 8, PP_RF_615: 0, COMMERCIAL: 0 };
const LAWS: TenderLaw[] = ["FZ_44", "FZ_223"];

function setup(selected: TenderLaw[] = [], laws: TenderLaw[] = LAWS) {
  const onChange = vi.fn();
  render(<LawSwitcher selected={selected} counts={COUNTS} laws={laws} onChange={onChange} />);
  return onChange;
}

/** Кнопка сегмента — по видимой подписи закона, без счётчика. */
function segment(label: string): HTMLElement {
  const found = screen
    .getAllByRole("button")
    .filter((b) => b.textContent?.startsWith(label));
  if (found.length !== 1) {
    throw new Error(`Ожидался один сегмент «${label}», найдено ${found.length}`);
  }
  return found[0]!;
}

describe("LawSwitcher", () => {
  it("без выбора показывает активным «Все»", () => {
    setup();

    expect(segment("Все").getAttribute("aria-pressed")).toBe("true");
    expect(segment("44-ФЗ").getAttribute("aria-pressed")).toBe("false");
    expect(segment("223-ФЗ").getAttribute("aria-pressed")).toBe("false");
  });

  it("клик по закону выбирает только его", () => {
    const onChange = setup();

    fireEvent.click(segment("44-ФЗ"));

    expect(onChange).toHaveBeenCalledWith(["FZ_44"]);
  });

  it("клик по уже выбранному закону снимает выбор", () => {
    const onChange = setup(["FZ_44"]);

    fireEvent.click(segment("44-ФЗ"));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("второй закон добавляется, а порядок остаётся каноническим", () => {
    // Профиль поиска может задавать два закона; сохранённый набор фильтров
    // сравнивается побайтово, поэтому порядок кликов не должен влиять на результат.
    const onChange = setup(["FZ_223"]);

    fireEvent.click(segment("44-ФЗ"));

    expect(onChange).toHaveBeenCalledWith(["FZ_44", "FZ_223"]);
  });

  it("«Все» сбрасывает выбранные законы", () => {
    const onChange = setup(["FZ_44", "FZ_223"]);

    fireEvent.click(segment("Все"));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("рядом с каждым законом виден счётчик", () => {
    setup();

    expect(segment("Все").textContent).toContain("20");
    expect(segment("44-ФЗ").textContent).toContain("12");
    expect(segment("223-ФЗ").textContent).toContain("8");
  });

  it("закон без закупок в данных не показывается", () => {
    setup();

    expect(screen.queryByText(/ПП РФ 615/)).toBeNull();
    expect(screen.queryByText(/Коммерческие/)).toBeNull();
  });

  it("выбранный закон показывается, даже если закупок по нему нет", () => {
    // Профиль поиска сохранил COMMERCIAL до подключения площадок: скрывать
    // активный фильтр значило бы показывать «Все» при действующем ограничении.
    const onChange = setup(["COMMERCIAL"], [...LAWS, "COMMERCIAL"]);

    expect(segment("Все").getAttribute("aria-pressed")).toBe("false");
    expect(segment("Коммерческие").getAttribute("aria-pressed")).toBe("true");
    expect(segment("Коммерческие").textContent).toContain("0");

    fireEvent.click(segment("Коммерческие"));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
