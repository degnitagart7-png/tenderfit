import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Подставляем реестр с тремя тестовыми статьями: страница не должна зависеть от настоящих текстов.
vi.mock("@/content/poleznoe", async () => {
  const { createRegistry } = await import("@/content/poleznoe/registry");
  const { makeFixtureSet } = await import("@/test/poleznoeFixture");
  const fixtures = makeFixtureSet();
  return { ARTICLES: fixtures, ...createRegistry(fixtures) };
});

import ArticlePage, { dynamicParams, generateMetadata, generateStaticParams } from "@/app/poleznoe/[slug]/page";
import { SITE_URL } from "@/lib/site";

afterEach(cleanup);

/** Все JSON-LD страницы, разобранные как JSON. */
function jsonLd(container: HTMLElement): Record<string, unknown>[] {
  return [...container.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
    JSON.parse(s.textContent ?? "") as Record<string, unknown>,
  );
}

describe("страница статьи", () => {
  const renderPage = (slug = "glavnaya-statya") => render(ArticlePage({ params: { slug } }));

  it("рисует h1, вступление, дату и время чтения", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Тестовая статья glavnaya-statya");
    expect(screen.getByText(/Обновлено/).textContent).toContain("12 октября 2026");
    expect(screen.getByText(/мин чтения/).textContent).toMatch(/~\d+ мин чтения/);
  });

  it("хлебные крошки: Главная → Полезное → название", () => {
    renderPage();
    const crumbs = screen.getByRole("navigation", { name: "Хлебные крошки" });
    const items = within(crumbs).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["Главная", "Полезное", "Тестовая статья glavnaya-statya"]);
    expect(within(crumbs).getByRole("link", { name: "Полезное" }).getAttribute("href")).toBe("/poleznoe");
  });

  it("оглавление собрано из h2 и ведёт на якоря", () => {
    const { container } = renderPage();
    const toc = screen.getByRole("navigation", { name: "Содержание" });
    const links = within(toc).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#pervyi-razdel",
      "#vtoroi-razdel",
      "#tretii-razdel",
      "#chetvertyi-razdel",
    ]);
    for (const a of links) expect(container.querySelector(a.getAttribute("href") ?? "")).not.toBeNull();
  });

  it("вопросы и ответы видны на странице, источники и связанные статьи на месте", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Вопросы и ответы" })).toBeTruthy();
    expect(screen.getByText("Первый вопрос?")).toBeTruthy();
    expect(screen.getByText("Первый ответ.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Нормативные акты и источники" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Федеральный закон № 44-ФЗ" }).getAttribute("rel")).toBe("noopener");
    expect(screen.getByText("Постановление без ссылки")).toBeTruthy();
    const related = screen.getByRole("heading", { name: "Читайте также" }).closest("section") as HTMLElement;
    const hrefs = within(related).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/poleznoe/vtoraya-statya", "/poleznoe/tretya-statya"]);
  });

  it("в конце страницы призыв попробовать", () => {
    renderPage();
    expect(screen.getAllByRole("link", { name: "Попробовать бесплатно" }).length).toBeGreaterThanOrEqual(2);
  });

  it("JSON-LD: Article, FAQPage и BreadcrumbList — валидный JSON с данными статьи", () => {
    const { container } = renderPage();
    const blocks = jsonLd(container);
    const byType = Object.fromEntries(blocks.map((b) => [String(b["@type"]), b]));
    expect(Object.keys(byType).sort()).toEqual(["Article", "BreadcrumbList", "FAQPage"]);

    const article = byType["Article"] as Record<string, any>;
    expect(article.datePublished).toBe("2026-10-01");
    expect(article.dateModified).toBe("2026-10-12");
    expect(article.inLanguage).toBe("ru-RU");
    expect(article.publisher.name).toBe("ТендерФит");
    expect(article.mainEntityOfPage["@id"]).toBe(`${SITE_URL}/poleznoe/glavnaya-statya`);

    const faq = byType["FAQPage"] as Record<string, any>;
    expect(faq.mainEntity).toHaveLength(3);
    // В разметке ответ без символов строчной разметки: ссылка [демо](/demo) стала словом «демо».
    expect(faq.mainEntity[1].acceptedAnswer.text).toBe("Второй ответ со ссылкой на демо.");

    const crumbs = byType["BreadcrumbList"] as Record<string, any>;
    expect(crumbs.itemListElement.map((i: any) => i.position)).toEqual([1, 2, 3]);
    expect(crumbs.itemListElement[1].item).toBe(`${SITE_URL}/poleznoe`);
  });

  it("неизвестный адрес — notFound", () => {
    expect(() => ArticlePage({ params: { slug: "net-takoi" } })).toThrowError(
      expect.objectContaining({ digest: expect.stringContaining("NEXT_NOT_FOUND") }),
    );
  });
});

describe("статические параметры и метаданные", () => {
  it("адреса известны на сборке, чужие — 404", () => {
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams()).toEqual([
      { slug: "glavnaya-statya" },
      { slug: "vtoraya-statya" },
      { slug: "tretya-statya" },
    ]);
  });

  it("generateMetadata: title без двойной приписки, canonical, openGraph article", () => {
    const meta = generateMetadata({ params: { slug: "glavnaya-statya" } });
    expect(meta.title).toEqual({ absolute: "Тестовая статья glavnaya-statya — ТендерФит" });
    expect(meta.alternates?.canonical).toBe(`${SITE_URL}/poleznoe/glavnaya-statya`);
    expect(meta.openGraph).toMatchObject({
      type: "article",
      locale: "ru_RU",
      siteName: "ТендерФит",
      publishedTime: "2026-10-01",
      modifiedTime: "2026-10-12",
    });
    expect(meta.keywords).toContain("госзакупки");
  });

  it("для неизвестного адреса метаданных нет", () => {
    expect(generateMetadata({ params: { slug: "net-takoi" } })).toEqual({});
  });
});
