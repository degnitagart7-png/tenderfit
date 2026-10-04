// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollIntoSection, useActiveSection } from "./useActiveSection";

const INNER_HEIGHT = 813;

/**
 * getBoundingClientRect и scrollIntoView в jsdom не работают как в браузере,
 * поэтому каждому разделу подставляем свою позицию и заглушку прокрутки.
 */
function mountSections(tops: Record<string, number>) {
  document.body.innerHTML = "";
  return Object.entries(tops).map(([id, top]) => {
    const section = document.createElement("section");
    section.id = id;
    section.dataset.section = id;
    section.getBoundingClientRect = () => ({ top }) as DOMRect;
    section.scrollIntoView = vi.fn();
    document.body.appendChild(section);
    return section;
  });
}

function setTops(tops: Record<string, number>) {
  for (const [id, top] of Object.entries(tops)) {
    const el = document.getElementById(id);
    if (el) el.getBoundingClientRect = () => ({ top }) as DOMRect;
  }
}

/** Позиция скролла; end=true означает «страница докручена до низа». */
function setScroll(scrollY: number, scrollHeight: number, end = false) {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: INNER_HEIGHT,
  });
  Object.defineProperty(window, "scrollY", { configurable: true, value: scrollY });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: end ? scrollY + INNER_HEIGHT : scrollHeight,
  });
}

beforeEach(() => {
  // Середина страницы: правило «линии отступа», не «конец документа».
  setScroll(1000, 10_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("useActiveSection", () => {
  it("без разделов возвращает пустой id", () => {
    const { result } = renderHook(() => useActiveSection([]));
    expect(result.current.activeId).toBe("");
  });

  it("активен раздел, заголовок которого прошёл линию отступа", () => {
    const ids = ["overview", "compliance", "evidence"];
    mountSections({ overview: 0, compliance: 0, evidence: 0 });
    const { result } = renderHook(() => useActiveSection(ids));

    setTops({ overview: -200, compliance: 40, evidence: 400 });
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(result.current.activeId).toBe("compliance");

    setTops({ overview: -200, compliance: -40, evidence: 60 });
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(result.current.activeId).toBe("evidence");
  });

  it("короткий раздел не уступает подсветку следующему", () => {
    const ids = ["risks", "manual-review"];
    mountSections({ risks: 0, "manual-review": 0 });
    const { result } = renderHook(() => useActiveSection(ids));

    // risks у линии 80px, manual-review ещё ниже — активен risks.
    setTops({ risks: 70, "manual-review": 273 });
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(result.current.activeId).toBe("risks");
  });

  it("у конца страницы берётся раздел, дошедший до середины экрана", () => {
    const ids = ["manual-review", "documents", "history"];
    mountSections({ "manual-review": 0, documents: 0, history: 0 });
    const { result } = renderHook(() => useActiveSection(ids));
    setScroll(4853, 5666, true);

    // История не может подняться к линии 80px: активен documents.
    setTops({ "manual-review": -427, documents: 329, history: 704 });
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(result.current.activeId).toBe("documents");
  });

  it("клик закрепляет раздел и не сбрасывается программной прокруткой", () => {
    const ids = ["overview", "risks", "history"];
    const sections = mountSections({ overview: 0, risks: 0, history: 0 });
    const { result } = renderHook(() => useActiveSection(ids));

    act(() => result.current.selectSection("history"));
    expect(result.current.activeId).toBe("history");
    expect(sections[2]!.scrollIntoView).toHaveBeenCalled();

    setTops({ overview: -900, risks: -500, history: -120 });
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(result.current.activeId).toBe("history");
  });

  it("после прокрутки пользователем scroll-spy снова решает", () => {
    const ids = ["overview", "risks", "history"];
    mountSections({ overview: 0, risks: 0, history: 0 });
    const { result } = renderHook(() => useActiveSection(ids));

    act(() => result.current.selectSection("history"));
    setTops({ overview: -900, risks: 20, history: 400 });
    act(() => window.dispatchEvent(new WheelEvent("wheel")));
    expect(result.current.activeId).toBe("risks");
  });

  it("прокрутка ползунком после завершения анимации тоже снимает закрепление", () => {
    vi.useFakeTimers();
    try {
      const ids = ["overview", "risks", "history"];
      mountSections({ overview: 0, risks: 0, history: 0 });
      const { result } = renderHook(() => useActiveSection(ids));

      act(() => result.current.selectSection("history"));
      setTops({ overview: -900, risks: 20, history: 400 });

      // Кадры программной прокрутки закрепление не снимают.
      act(() => window.dispatchEvent(new Event("scroll")));
      expect(result.current.activeId).toBe("history");

      // Анимация завершилась → следующая прокрутка считается пользовательской.
      act(() => {
        vi.advanceTimersByTime(200);
        window.dispatchEvent(new Event("scroll"));
      });
      expect(result.current.activeId).toBe("risks");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scrollIntoSection", () => {
  it("прокручивает раздел к началу вьюпорта", () => {
    const sections = mountSections({ overview: 0 });
    scrollIntoSection("overview");
    expect(sections[0]!.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: "start" }),
    );
  });

  it("не падает на несуществующем разделе", () => {
    expect(() => scrollIntoSection("nope")).not.toThrow();
  });
});
