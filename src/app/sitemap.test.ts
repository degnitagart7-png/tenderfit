import { describe, expect, it, vi } from "vitest";

vi.mock("@/content/poleznoe", async () => {
  // Фабрика поднимается выше импортов, поэтому всё нужное берётся динамически.
  const { createRegistry } = await import("@/content/poleznoe/registry");
  const { makeFixtureSet } = await import("@/test/poleznoeFixture");
  const fixtures = makeFixtureSet();
  return { ARTICLES: fixtures, ...createRegistry(fixtures) };
});

import sitemap from "@/app/sitemap";
import { SITE_URL } from "@/lib/site";

describe("sitemap", () => {
  const entries = sitemap();
  const byUrl = (path: string) => entries.find((e) => e.url === `${SITE_URL}${path}`);

  it("содержит индекс раздела «Полезное» с датой самой свежей статьи", () => {
    const index = byUrl("/poleznoe");
    expect(index).toBeDefined();
    expect(index?.lastModified).toEqual(new Date("2026-10-12"));
  });

  it("содержит каждую статью: lastModified = updated, приоритет 0.7", () => {
    expect(byUrl("/poleznoe/vtoraya-statya")).toMatchObject({ lastModified: new Date("2026-10-05"), priority: 0.7 });
    expect(byUrl("/poleznoe/glavnaya-statya")).toMatchObject({ lastModified: new Date("2026-10-12"), priority: 0.7 });
  });

  it("публичные страницы на месте, кабинета нет", () => {
    expect(byUrl("/")).toBeDefined();
    expect(byUrl("/demo")).toBeDefined();
    expect(byUrl("/legal/offer")).toBeDefined();
    expect(entries.some((e) => /\/(tenders|dashboard|api)/.test(e.url))).toBe(false);
  });
});
