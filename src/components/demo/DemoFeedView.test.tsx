import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DemoFeedView } from "@/components/demo/DemoFeedView";

/*
  Демо-лента для гостя: закупки с вердиктами видны без входа, а клик по
  закупке не уводит на форму входа, а предлагает зарегистрироваться на месте.
*/
describe("DemoFeedView", () => {
  it("показывает ленту с оценками без запросов к серверу", () => {
    render(<DemoFeedView />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("лента закупок");
    expect(screen.getAllByRole("link", { name: /./ }).length).toBeGreaterThan(5);
    expect(screen.getByRole("group", { name: "Оценка" })).toBeTruthy();
  });

  it("клик по закупке открывает предложение зарегистрироваться, а не карточку", () => {
    render(<DemoFeedView />);
    const first = document.querySelector("tbody a") as HTMLAnchorElement;

    fireEvent.click(first);

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("после регистрации");
    expect(screen.getByRole("link", { name: /Попробовать 7 дней бесплатно/ }).getAttribute("href")).toBe("/login?mode=register");

    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("фильтр по оценке оставляет только выбранный вердикт", () => {
    render(<DemoFeedView />);
    const before = document.querySelectorAll("tbody tr").length;

    fireEvent.click(screen.getByRole("button", { name: /^Не подходит/ }));

    expect(document.querySelectorAll("tbody tr").length).toBeLessThan(before);
  });
});
