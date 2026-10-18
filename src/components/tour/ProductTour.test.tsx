import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PRODUCT_TOUR_STEPS, ProductTour } from "@/components/tour/ProductTour";

/** Тур: шаги листаются, цель ищется по data-tour, без цели — карточка по центру. */

afterEach(cleanup);

describe("ProductTour", () => {
  it("шесть шагов: «Далее», «Назад», на последнем «Готово» закрывает с finished=true", () => {
    const onClose = vi.fn();
    render(<ProductTour onClose={onClose} />);

    expect(screen.getByText(`1 из ${PRODUCT_TOUR_STEPS.length}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Назад" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(screen.getByText(`2 из ${PRODUCT_TOUR_STEPS.length}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText(`1 из ${PRODUCT_TOUR_STEPS.length}`)).toBeTruthy();

    for (let i = 1; i < PRODUCT_TOUR_STEPS.length; i += 1) fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("«Пропустить» и Esc закрывают с finished=false; стрелки листают", () => {
    const onClose = vi.fn();
    render(<ProductTour onClose={onClose} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText(`2 из ${PRODUCT_TOUR_STEPS.length}`)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("цели нет на странице — карточка по центру; цель есть — привязка к ней", () => {
    const steps = [
      { target: "absent", title: "А", text: "нет цели" },
      { target: "present", title: "Б", text: "есть цель" },
    ];
    const target = document.createElement("div");
    target.setAttribute("data-tour", "present");
    target.getBoundingClientRect = () => ({ top: 10, left: 10, width: 100, height: 40, bottom: 50, right: 110, x: 10, y: 10, toJSON: () => ({}) });
    document.body.appendChild(target);

    render(<ProductTour steps={steps} onClose={vi.fn()} />);
    expect(screen.getByTestId("tour-card").getAttribute("data-target")).toBe("absent");
    expect(screen.getByRole("dialog").getAttribute("style")).toMatch(/translate\(-50%, -50%\)/);

    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(screen.getByRole("dialog").getAttribute("style")).not.toMatch(/translate\(-50%/);
    target.remove();
  });
});
