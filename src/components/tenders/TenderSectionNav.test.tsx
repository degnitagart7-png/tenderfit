import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  TenderSectionNav,
  TenderSectionNavMobile,
  flattenNavGroups,
  type TenderNavGroup,
} from "@/components/tenders/TenderSectionNav";

const groups: TenderNavGroup[] = [
  { title: "Обзор", sections: [{ id: "overview", label: "Обзор" }] },
  {
    title: "Анализ",
    sections: [
      { id: "compliance", label: "Соответствие компании" },
      { id: "evidence", label: "Доказательства" },
    ],
  },
];

describe("flattenNavGroups", () => {
  it("собирает разделы групп в плоский список без потери порядка", () => {
    expect(flattenNavGroups(groups).map((s) => s.id)).toEqual([
      "overview",
      "compliance",
      "evidence",
    ]);
  });
});

describe("TenderSectionNav (десктопный сайдбар)", () => {
  it("показывает названия групп и все разделы", () => {
    render(
      <TenderSectionNav groups={groups} activeId="compliance" onNavigate={() => {}} />,
    );
    // «Обзор» — и название группы, и раздел: проверяем как список совпадений.
    expect(screen.getAllByText("Обзор").length).toBeGreaterThan(0);
    expect(screen.getByText("Анализ")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Соответствие компании" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Доказательства" })).toBeInTheDocument();
  });

  it("помечает активный раздел через aria-current", () => {
    render(
      <TenderSectionNav groups={groups} activeId="compliance" onNavigate={() => {}} />,
    );
    expect(
      screen.getByRole("button", { name: "Соответствие компании" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: "Доказательства" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("клик по разделу вызывает onNavigate с его id", () => {
    const onNavigate = vi.fn();
    render(<TenderSectionNav groups={groups} activeId="overview" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Доказательства" }));
    expect(onNavigate).toHaveBeenCalledWith("evidence");
  });

  it("навигация подписана для скринридеров", () => {
    render(
      <TenderSectionNav groups={groups} activeId="overview" onNavigate={() => {}} />,
    );
    expect(
      screen.getByRole("navigation", { name: "Разделы карточки закупки" }),
    ).toBeInTheDocument();
  });
});

describe("TenderSectionNavMobile (горизонтальный бар)", () => {
  it("подчёркивает активный раздел и оставляет остальные без подчёркивания", () => {
    render(
      <TenderSectionNavMobile
        sections={flattenNavGroups(groups)}
        activeId="evidence"
        onNavigate={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Доказательства" }).className,
    ).toContain("border-accent");
    expect(
      screen.getByRole("button", { name: "Обзор" }).className,
    ).toContain("border-transparent");
  });

  it("клик по разделу вызывает onNavigate с его id", () => {
    const onNavigate = vi.fn();
    render(
      <TenderSectionNavMobile
        sections={flattenNavGroups(groups)}
        activeId="overview"
        onNavigate={onNavigate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Соответствие компании" }));
    expect(onNavigate).toHaveBeenCalledWith("compliance");
  });
});
