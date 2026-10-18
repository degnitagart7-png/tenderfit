import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { defaultFilters, type TenderFilters } from "@/domain/filtering";
import { searchControlLabels } from "@/lib/labels";
import { TenderFiltersPanel } from "@/components/tenders/TenderFiltersPanel";

afterEach(cleanup);

function mount(patch: Partial<TenderFilters> = {}, onChange = vi.fn()) {
  return render(
    <TenderFiltersPanel
      filters={{ ...defaultFilters, ...patch }}
      onChange={onChange}
      sources={[]}
      searchProfiles={[]}
      onApplyProfile={() => {}}
    />,
  );
}

const toggle = () => screen.getByRole("button", { name: "Расширенный поиск" });

describe("TenderFiltersPanel — расширенный поиск", () => {
  it("свёрнут по умолчанию: полей поиска и подсказки по синтаксису нет", () => {
    mount();

    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText(searchControlLabels.query)).toBeNull();
    expect(screen.queryByLabelText(searchControlLabels.exclude)).toBeNull();
    expect(screen.queryByText(searchControlLabels.exact)).toBeNull();
    expect(screen.queryByText(searchControlLabels.syntaxHint)).toBeNull();
  });

  it("раскрывается по клику и сворачивается обратно", () => {
    mount();

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText(searchControlLabels.query)).toBeTruthy();
    expect(screen.getByText(searchControlLabels.syntaxHint)).toBeTruthy();

    fireEvent.click(toggle());
    expect(screen.queryByLabelText(searchControlLabels.query)).toBeNull();
  });

  it.each<[string, Partial<TenderFilters>]>([
    ["запрос", { search: "ноутбук" }],
    ["исключения", { excludeKeywords: ["б/у"] }],
    ["точное совпадение", { exactMatch: true }],
    ["области поиска", { scopes: ["subject"] }],
  ])("открыт сразу, если в фильтрах есть %s", (_name, patch) => {
    mount(patch);

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText(searchControlLabels.query)).toBeTruthy();
  });

  it("открывается, когда запрос приходит позже монтирования (например, из адреса)", () => {
    const { rerender } = mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    rerender(
      <TenderFiltersPanel
        filters={{ ...defaultFilters, search: "ноутбук" }}
        onChange={() => {}}
        sources={[]}
        searchProfiles={[]}
        onApplyProfile={() => {}}
      />,
    );

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("ввод в поле вызывает onChange с запросом и первой страницей", () => {
    const onChange = vi.fn();
    mount({}, onChange);
    fireEvent.click(toggle());

    fireEvent.change(screen.getByLabelText(searchControlLabels.query), { target: { value: "вентиль" } });

    expect(onChange).toHaveBeenCalledWith({ search: "вентиль", page: 1 });
  });

  it("«Фильтры» и «Расширенный поиск» — соседние кнопки одной строки", () => {
    mount();

    expect(screen.getByRole("button", { name: /^Фильтры/ }).parentElement).toBe(toggle().parentElement);
  });
});
