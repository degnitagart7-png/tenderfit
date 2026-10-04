import { describe, expect, it } from "vitest";
import { defaultFilters, type TenderFilters } from "@/domain/filtering";
import { filtersToSearchParams } from "@/domain/filterUrl";
import { activeFilterChips } from "@/lib/filterChips";

describe("activeFilterChips", () => {
  it("без ограничений чипов нет", () => {
    expect(activeFilterChips(defaultFilters)).toEqual([]);
  });

  it("скрытые множественные значения профиля поиска становятся чипами", () => {
    const chips = activeFilterChips({
      ...defaultFilters,
      searchKeywords: ["принтер", "МФУ"],
      regions: ["Санкт-Петербург"],
      customerInns: ["7812345678"],
    });
    const labels = chips.map((c) => c.label);
    expect(labels.some((l) => l.includes("принтер, МФУ"))).toBe(true);
    expect(labels.some((l) => l.includes("Санкт-Петербург"))).toBe(true);
    expect(labels.some((l) => l.includes("7812345678"))).toBe(true);
  });

  it("снятие чипа источника убирает только его", () => {
    const filters: TenderFilters = {
      ...defaultFilters,
      sources: ["EIS", "SBER_AST"],
    };
    const chips = activeFilterChips(filters);
    const sber = chips.find((c) => c.id === "source-SBER_AST");
    expect(sber).toBeDefined();
    expect({ ...filters, ...sber!.reset }.sources).toEqual(["EIS"]);
  });

  it("снятие чипа возвращает поле к значению по умолчанию", () => {
    const filters: TenderFilters = {
      ...defaultFilters,
      minPrice: 30000,
      closingSoonOnly: true,
    };
    for (const chip of activeFilterChips(filters)) {
      const next = { ...filters, ...chip.reset };
      expect(activeFilterChips(next).length).toBe(
        activeFilterChips(filters).length - 1,
      );
    }
  });

  it("параметры поиска становятся чипами", () => {
    const chips = activeFilterChips({
      ...defaultFilters,
      excludeKeywords: ["аренда", "б/у"],
      exactMatch: true,
      scopes: ["subject", "documents"],
    });
    const labels = chips.map((c) => c.label);
    expect(labels.some((l) => l.includes("аренда, б/у"))).toBe(true);
    expect(labels).toContain("Точное совпадение");
    expect(labels.some((l) => l.includes("Название") && l.includes("Документация"))).toBe(true);
  });

  it("выключенный переключатель цены виден как чип, включённый — нет", () => {
    // Прятать закупки молча нельзя: если пользователь выключил закупки без НМЦ,
    // это обязано быть написано над таблицей.
    expect(
      activeFilterChips({ ...defaultFilters, includeNoPrice: false }).map((c) => c.id),
    ).toContain("includeNoPrice");
    expect(
      activeFilterChips({ ...defaultFilters, includeForeignCurrency: false }).map(
        (c) => c.id,
      ),
    ).toContain("includeForeignCurrency");
    expect(activeFilterChips(defaultFilters)).toEqual([]);
  });

  it("снятие чипа цены возвращает закупки в выдачу", () => {
    const filters: TenderFilters = {
      ...defaultFilters,
      includeNoPrice: false,
      includeForeignCurrency: false,
    };
    const chips = activeFilterChips(filters);
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      const next = { ...filters, ...chip.reset };
      expect(activeFilterChips(next)).toHaveLength(1);
    }
  });

  it("выбранный пользователем порядок виден чипом и снимается им", () => {
    // Клик по заголовку колонки перебивает порядок по умолчанию, а обратного
    // клика в таблице нет: без чипа вернуться к «свежесть + фит» нечем.
    const filters: TenderFilters = { ...defaultFilters, sortField: "price", sortDir: "asc" };
    const chip = activeFilterChips(filters).find((c) => c.id === "sortField");

    expect(chip?.label).toContain("Порядок");
    expect(chip?.label).toContain("цене");
    expect({ ...filters, ...chip!.reset }).toMatchObject({
      sortField: defaultFilters.sortField,
      sortDir: defaultFilters.sortDir,
      page: 1,
    });
  });

  it("порядок по умолчанию чипом не показывается", () => {
    expect(activeFilterChips(defaultFilters)).toEqual([]);
    expect(
      activeFilterChips({ ...defaultFilters, sortField: "freshness" }).map((c) => c.id),
    ).not.toContain("sortField");
  });

  it("снятие чипа порядка убирает параметр sort из адреса", () => {
    const filters: TenderFilters = { ...defaultFilters, sortField: "fitScore" };
    expect(filtersToSearchParams(filters).get("sort")).toBe("fitScore");

    const chip = activeFilterChips(filters).find((c) => c.id === "sortField");
    const next = { ...filters, ...chip!.reset };

    expect(filtersToSearchParams(next).get("sort")).toBeNull();
  });

  it("явная свежесть в адресе принимается как порядок выдачи", () => {
    // Ссылка обязана воспроизводить порядок, даже когда он совпадает с
    // умолчанием: адрес, в котором порядок потерян, невозможно переслать.
    expect(
      filtersToSearchParams({ ...defaultFilters, sortField: "freshness", sortDir: "asc" }).get("dir"),
    ).toBe("asc");
  });
});

describe("чип партии прогона", () => {
  const STAMP = "2026-09-25T14:52:03.000Z";

  it("партия видна чипом и снимается до полной выдачи", () => {
    // Партия приходит ссылкой, а не панелью фильтров: без чипа пользователь
    // оказался бы заперт в списке из двадцати строк без видимой причины.
    const filters: TenderFilters = { ...defaultFilters, batchStamp: STAMP };
    const chips = activeFilterChips(filters);

    expect(chips).toHaveLength(1);
    expect(chips[0]!.label).toContain("Партия");
    expect({ ...filters, ...chips[0]!.reset }.batchStamp).toBeNull();
  });

  it("без партии чипа нет", () => {
    expect(activeFilterChips(defaultFilters)).toEqual([]);
  });
});
