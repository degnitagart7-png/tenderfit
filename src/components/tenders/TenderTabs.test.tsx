import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  LEGACY_ANCHORS,
  TENDER_TABS,
  TenderTabs,
  resolveTabFromLocation,
  searchForTab,
} from "@/components/tenders/TenderTabs";

describe("resolveTabFromLocation", () => {
  it("без параметров — «Главное»", () => {
    expect(resolveTabFromLocation("", "")).toEqual({ tab: "main", anchor: null, block: null });
  });

  it("?tab= выбирает вкладку, неизвестное значение игнорируется", () => {
    expect(resolveTabFromLocation("?tab=docs", "").tab).toBe("docs");
    expect(resolveTabFromLocation("?tab=nope", "").tab).toBe("main");
  });

  it("старый якорь ведёт на вкладку и запоминает цель прокрутки", () => {
    expect(resolveTabFromLocation("", "#deep-analysis")).toEqual({
      tab: "analysis",
      anchor: "deep-analysis",
      block: null,
    });
    expect(resolveTabFromLocation("", "#economics").block).toBe("all-terms");
  });

  it("каждый прежний раздел карточки куда-то приведён", () => {
    for (const id of [
      "overview", "compliance", "requirements", "operations", "evidence",
      "deep-analysis", "economics", "risks", "manual-review", "documents", "history",
    ]) {
      expect(LEGACY_ANCHORS[id]).toBeDefined();
    }
  });
});

describe("searchForTab", () => {
  it("главная вкладка убирает параметр, остальные его пишут", () => {
    expect(searchForTab("?tab=risks", "main")).toBe("");
    expect(searchForTab("", "risks")).toBe("?tab=risks");
    expect(searchForTab("?a=1", "docs")).toBe("?a=1&tab=docs");
  });
});

describe("TenderTabs", () => {
  it("показывает вкладки, отмечает активную и сообщает о выборе", () => {
    const onSelect = vi.fn();
    render(<TenderTabs active="main" onSelect={onSelect} counts={{ risks: 3 }} />);

    expect(screen.getAllByRole("tab")).toHaveLength(TENDER_TABS.length);
    expect(screen.getByRole("tab", { name: "Главное" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: /Риски договора/ }));
    expect(onSelect).toHaveBeenCalledWith("risks");
    expect(screen.getByRole("tab", { name: /Риски договора/ }).textContent).toContain("3");
  });
});
