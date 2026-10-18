import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/content/poleznoe", async () => {
  const { createRegistry } = await import("@/content/poleznoe/registry");
  const { makeFixtureSet } = await import("@/test/poleznoeFixture");
  const fixtures = makeFixtureSet();
  return { ARTICLES: fixtures, ...createRegistry(fixtures) };
});

import PoleznoeIndexPage, { metadata } from "@/app/poleznoe/page";
import { SITE_URL } from "@/lib/site";

afterEach(cleanup);

describe("индекс раздела «Полезное»", () => {
  it("статьи сгруппированы по рубрикам в порядке рубрик", () => {
    render(<PoleznoeIndexPage />);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Поиск и выбор закупок", "Документация и риски", "Смета и цена"]);
    const docs = screen.getByRole("heading", { name: "Документация и риски" }).closest("section") as HTMLElement;
    expect(within(docs).getByRole("link").getAttribute("href")).toBe("/poleznoe/glavnaya-statya");
  });

  it("title, canonical и описание заданы; JSON-LD — CollectionPage со списком", () => {
    expect(metadata.alternates?.canonical).toBe(`${SITE_URL}/poleznoe`);
    expect(String(metadata.description).length).toBeGreaterThan(100);
    const { container } = render(<PoleznoeIndexPage />);
    const blocks = [...container.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
      JSON.parse(s.textContent ?? ""),
    );
    const collection = blocks.find((b) => b["@type"] === "CollectionPage");
    expect(collection.mainEntity["@type"]).toBe("ItemList");
    expect(collection.mainEntity.itemListElement).toHaveLength(3);
    expect(blocks.some((b) => b["@type"] === "BreadcrumbList")).toBe(true);
  });
});
